from __future__ import annotations

import logging
import math
import threading
import warnings
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import SoapySDR
from constants import (
    DC_SPIKE_BLANK_BINS,
    DEFAULT_GAIN_DB,
    DEFAULT_SAMPLE_RATE_HZ,
    FFT_SIZE,
    MAX_CONSECUTIVE_READ_ERRORS,
    MAX_ROW_POINTS,
)
from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX

_LOGGER = logging.getLogger(__name__)


def _resolve_sample_rate(sdr, requested_hz: float) -> float:
    """Returns requested_hz unchanged if the device can actually produce it, else the closest
    rate it does support.

    Not every SoapySDR driver accepts the same sample rates - RTL-SDR happens to support a
    wide continuous range (confirmed: 900kHz-3.2MHz) that covers the panel's 2.4MHz default,
    but e.g. Airspy R2 hardware only supports a couple of fixed discrete rates (10MSPS, or an
    experimental 2.5MSPS) and would otherwise silently receive a request its own hardware
    can't produce, yielding no usable capture data with no clear error (caught by review).
    Checking listSampleRates()/getSampleRateRange() BEFORE calling setSampleRate(), rather
    than just calling it and hoping the driver clamps gracefully, avoids depending on
    per-driver behavior for an unsupported value.
    """
    ranges = sdr.getSampleRateRange(SOAPY_SDR_RX, 0)
    if any(r.minimum() <= requested_hz <= r.maximum() for r in ranges):
        return requested_hz
    candidates = list(sdr.listSampleRates(SOAPY_SDR_RX, 0))
    candidates += [v for r in ranges for v in (r.minimum(), r.maximum())]
    if not candidates:
        return requested_hz  # driver exposes no discoverable rates - let setSampleRate itself decide
    return min(candidates, key=lambda v: abs(v - requested_hz))


class SweepStopTimeoutError(Exception):
    """Raised when a sweep's capture thread does not exit within the stop timeout.

    The thread may still be blocked in a SoapySDR call (e.g. readStream) and could
    still hold the dongle open - callers must not release the dongle claim or treat
    the sweep as stopped when this is raised.
    """


@dataclass
class SweepConfig:
    dongle_serial: str
    start_hz: float
    stop_hz: float
    sample_rate: float = DEFAULT_SAMPLE_RATE_HZ
    gain: float = DEFAULT_GAIN_DB
    # The exact SoapySDR construction kwargs from discover_dongles() (driver, serial, and
    # anything else that driver needed to identify this device) - opening a device from just
    # {"driver": ..., "serial": ...} isn't enough for every SoapySDR driver (some need e.g. a
    # device_id or remote key alongside serial to reopen the *same* device, not just a device
    # with a matching serial), so the full original args are carried through and reused as-is
    # rather than reconstructed. Defaults to a plain rtlsdr dict only so any external caller
    # still constructing a SweepConfig without this field (there are none in this codebase,
    # but it's a public-ish dataclass) doesn't immediately break.
    soapy_args: dict[str, str] = field(default_factory=lambda: {"driver": "rtlsdr"})


@dataclass
class SweepRow:
    start_hz: float
    bin_hz: float
    power_db: list[float | None]  # None marks an unfilled gap (JSON null, not NaN)


def _serialize_row(row: np.ndarray, bin_hz: float) -> tuple[list[float | None], float]:
    """Converts a native-resolution row to JSON-safe output, downsampling if needed.

    A row wider than MAX_ROW_POINTS is reduced down block-by-block by taking the peak
    (nanmax, so a filled bin isn't dragged toward a neighboring gap) rather than delivered
    at native resolution — native resolution scales with requested range width and a
    full-range sweep is ~1.48M bins, which serializes into double-digit megabytes and
    silently exceeds the WebSocket frame limit. nanmax (not nanmean) is used because `row`
    at this point already holds dB values (20*log10(...)) — averaging dB directly is not
    the same as averaging the underlying power, and washes out narrow strong signals, which
    are exactly the peaks a waterfall exists to show. dB is a monotonic transform of power,
    so the max of dB values across a block is mathematically exactly the max of the
    underlying linear power — no linear round-trip is needed to preserve peaks correctly.
    Values are also rounded to 1 decimal place: Python's float repr of a numpy float32
    carries far more precision than a dB reading needs, and unrounded is ~3x the JSON
    bytes for no real information gain.
    """
    n = len(row)
    if n > MAX_ROW_POINTS:
        factor = math.ceil(n / MAX_ROW_POINTS)
        pad = (-n) % factor
        if pad:
            row = np.concatenate([row, np.full(pad, np.nan, dtype=row.dtype)])
        # nanmax raises a RuntimeWarning (via Python's warnings module) for a block that's
        # entirely NaN (e.g. every read in that block hit a tolerated timeout/error) - that's
        # expected here, not a real problem, but np.errstate does NOT suppress it: errstate only
        # controls floating-point *exception* state (invalid/divide/overflow), not warnings.warn
        # calls, so a naive np.errstate(all="ignore") guard here is a no-op against this specific
        # warning and would let wide sweeps with transient gaps spam the add-on log.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            row = np.nanmax(row.reshape(-1, factor), axis=1)
        bin_hz = bin_hz * factor
    power_db = [None if np.isnan(v) else round(float(v), 1) for v in row]
    return power_db, bin_hz


class SoapySweeper:
    """Steps a SoapySDR device across a frequency range, emitting one full-range power-spectrum row per pass.

    Runs on its own thread since the SoapySDR Python API is blocking; on_row/on_error are
    called from that thread — callers must hop back to their own event loop if needed.
    """

    def __init__(
        self,
        on_row: Callable[[SweepRow], None],
        on_error: Callable[[Exception], None] | None = None,
        on_late_stop: Callable[[], None] | None = None,
    ) -> None:
        self._on_row = on_row
        self._on_error = on_error
        # Called (from a background watcher thread, not the capture thread) if the capture
        # thread finally exits after a stop() call already timed out and raised - see stop().
        self._on_late_stop = on_late_stop
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._late_stop_watcher: threading.Thread | None = None

    def start(self, config: SweepConfig) -> None:
        if self._thread is not None:
            raise RuntimeError("sweeper already running")
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, args=(config,), daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Signals the capture thread to stop and waits for it to exit.

        Raises SweepStopTimeoutError if the thread is still alive after `timeout`
        seconds (e.g. blocked in a long readStream call). In that case the thread
        is left in place (not cleared) so the dongle is not considered free and a
        retry can join the same thread again.

        On timeout, also arranges for on_late_stop to fire once the thread *does* eventually
        exit on its own (confirmed live: it's very likely to, once its current blocking
        readStream call returns and it notices _stop_event) - without this, nothing would
        ever notice that later exit, permanently stranding this sweep's DeviceManager
        bookkeeping and dongle claim (until the whole add-on process restarts), even though
        the thread is actually gone and the dongle is actually free.
        """
        self._stop_event.set()
        thread = self._thread
        if thread is None:
            return
        thread.join(timeout=timeout)
        if thread.is_alive():
            if self._late_stop_watcher is None or not self._late_stop_watcher.is_alive():
                # Guarded so a retried stop() call (still failing, e.g. polled by the caller)
                # while a watcher from an earlier timeout is already waiting doesn't spawn a
                # second one racing the first for the same thread/callback.
                def _watch() -> None:
                    thread.join()  # blocking, no timeout - this thread has nothing else to do
                    self._thread = None
                    if self._on_late_stop is not None:
                        self._on_late_stop()

                self._late_stop_watcher = threading.Thread(target=_watch, daemon=True)
                self._late_stop_watcher.start()
            raise SweepStopTimeoutError(
                f"sweep thread did not exit within {timeout}s; dongle may still be claimed"
            )
        self._thread = None

    def _run(self, config: SweepConfig) -> None:
        try:
            sdr = SoapySDR.Device(config.soapy_args)
            sample_rate = _resolve_sample_rate(sdr, config.sample_rate)
            if sample_rate != config.sample_rate:
                _LOGGER.info(
                    "dongle %s: requested sample rate %.0f Hz not supported, using %.0f Hz instead",
                    config.dongle_serial,
                    config.sample_rate,
                    sample_rate,
                )
            sdr.setSampleRate(SOAPY_SDR_RX, 0, sample_rate)
            sdr.setGain(SOAPY_SDR_RX, 0, config.gain)
            rx = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            sdr.activateStream(rx)
        except Exception as err:  # noqa: BLE001 - surface any setup failure to the caller, not just expected ones
            _LOGGER.exception("sweep setup failed for dongle %s", config.dongle_serial)
            if self._on_error is not None:
                self._on_error(err)
            return

        bin_hz = sample_rate / FFT_SIZE
        n_bins_total = int((config.stop_hz - config.start_hz) / bin_hz)
        half_span = sample_rate / 2
        window = np.hanning(FFT_SIZE)
        buf = np.zeros(FFT_SIZE, np.complex64)
        consecutive_errors = 0
        try:
            while not self._stop_event.is_set():
                row = np.full(n_bins_total, np.nan, dtype=np.float32)
                # setFrequency tunes the *center* frequency, so the first capture must be
                # centered half a sample-rate above start_hz for its lower edge to land on
                # start_hz; each subsequent center steps by a full sample-rate so captures
                # tile the range edge-to-edge with no gap and no half-sample-rate blind spot
                # at the top of the range.
                center = config.start_hz + half_span
                while (center - half_span) < config.stop_hz and not self._stop_event.is_set():
                    sdr.setFrequency(SOAPY_SDR_RX, 0, center)
                    sr = sdr.readStream(rx, [buf], FFT_SIZE, timeoutUs=2_000_000)
                    if sr.ret > 0:
                        consecutive_errors = 0
                        # A partial read still needs to produce an FFT_SIZE-bin spectrum so
                        # bin_hz/offset math stays valid — zero-pad rather than computing a
                        # shorter (and differently-spaced) FFT from just the samples we got.
                        samples = buf[: sr.ret] * window[: sr.ret]
                        if sr.ret < FFT_SIZE:
                            padded = np.zeros(FFT_SIZE, np.complex64)
                            padded[: sr.ret] = samples
                            samples = padded
                        fft = np.fft.fftshift(np.fft.fft(samples))
                        power_db = 20 * np.log10(np.abs(fft) + 1e-9)
                        # Blank the DC/LO-leakage spike at this capture's exact center bin —
                        # a hardware artifact of the R820T's direct-conversion tuner, not a
                        # real signal (see DC_SPIKE_BLANK_BINS).
                        center_bin = FFT_SIZE // 2
                        power_db[center_bin - DC_SPIKE_BLANK_BINS : center_bin + DC_SPIKE_BLANK_BINS + 1] = np.nan
                        lower_edge = center - half_span
                        offset = int((lower_edge - config.start_hz) / bin_hz)
                        n = min(len(power_db), n_bins_total - offset)
                        if n > 0:
                            row[offset : offset + n] = power_db[:n]
                    elif sr.ret == 0:
                        _LOGGER.debug("readStream returned 0 (timeout) at %.3f MHz", center / 1e6)
                    else:
                        # A negative return is a genuine SoapySDR error code (timeout,
                        # overflow, stream error, ...). Confirmed empirically that a single
                        # OVERFLOW is a common, transient hiccup during a long sweep (USB/
                        # scheduling jitter, not a dead device) — treat one as a gap in this
                        # bin and move on. Only a *persistent* run of failures indicates the
                        # dongle is actually gone, at which point release the claim rather
                        # than silently spinning on it forever.
                        consecutive_errors += 1
                        _LOGGER.warning(
                            "readStream error %d at %.3f MHz (%d consecutive)",
                            sr.ret,
                            center / 1e6,
                            consecutive_errors,
                        )
                        if consecutive_errors >= MAX_CONSECUTIVE_READ_ERRORS:
                            raise RuntimeError(
                                f"readStream error {sr.ret} persisted for {consecutive_errors} "
                                f"consecutive reads at {center / 1e6:.3f} MHz"
                            )
                    center += sample_rate
                if not self._stop_event.is_set():
                    power_db, out_bin_hz = _serialize_row(row, bin_hz)
                    self._on_row(SweepRow(start_hz=config.start_hz, bin_hz=out_bin_hz, power_db=power_db))
        except Exception as err:  # noqa: BLE001 - surface any runtime failure (e.g. dongle unplugged mid-sweep) to the caller
            _LOGGER.exception("sweep failed for dongle %s", config.dongle_serial)
            if self._on_error is not None:
                self._on_error(err)
        finally:
            try:
                sdr.deactivateStream(rx)
                sdr.closeStream(rx)
            except Exception:  # noqa: BLE001 - device may already be gone (e.g. unplugged); nothing more to clean up
                _LOGGER.debug(
                    "stream cleanup failed for dongle %s (device likely disconnected)",
                    config.dongle_serial,
                    exc_info=True,
                )
