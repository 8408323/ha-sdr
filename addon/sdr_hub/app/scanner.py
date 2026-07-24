from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Callable

import numpy as np
import SoapySDR
from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX

_LOGGER = logging.getLogger(__name__)

FFT_SIZE = 2048


@dataclass
class SweepConfig:
    dongle_serial: str
    start_hz: float
    stop_hz: float
    sample_rate: float = 2.4e6
    gain: float = 30.0


@dataclass
class SweepRow:
    start_hz: float
    bin_hz: float
    power_db: list[float]


class SoapySweeper:
    """Steps a SoapySDR device across a frequency range, emitting one full-range power-spectrum row per pass.

    Runs on its own thread since the SoapySDR Python API is blocking; on_row/on_error are
    called from that thread — callers must hop back to their own event loop if needed.
    """

    def __init__(
        self,
        on_row: Callable[[SweepRow], None],
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._on_row = on_row
        self._on_error = on_error
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, config: SweepConfig) -> None:
        if self._thread is not None:
            raise RuntimeError("sweeper already running")
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, args=(config,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def _run(self, config: SweepConfig) -> None:
        try:
            sdr = SoapySDR.Device({"driver": "rtlsdr", "serial": config.dongle_serial})
            sdr.setSampleRate(SOAPY_SDR_RX, 0, config.sample_rate)
            sdr.setGain(SOAPY_SDR_RX, 0, config.gain)
            rx = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            sdr.activateStream(rx)
        except Exception as err:  # noqa: BLE001 - surface any setup failure to the caller, not just expected ones
            _LOGGER.exception("sweep setup failed for dongle %s", config.dongle_serial)
            if self._on_error is not None:
                self._on_error(err)
            return

        bin_hz = config.sample_rate / FFT_SIZE
        n_bins_total = int((config.stop_hz - config.start_hz) / bin_hz)
        window = np.hanning(FFT_SIZE)
        buf = np.zeros(FFT_SIZE, np.complex64)
        try:
            while not self._stop_event.is_set():
                row = np.full(n_bins_total, np.nan, dtype=np.float32)
                freq = config.start_hz
                while freq < config.stop_hz and not self._stop_event.is_set():
                    sdr.setFrequency(SOAPY_SDR_RX, 0, freq)
                    sr = sdr.readStream(rx, [buf], FFT_SIZE, timeoutUs=2_000_000)
                    if sr.ret > 0:
                        fft = np.fft.fftshift(np.fft.fft(buf[: sr.ret] * window[: sr.ret]))
                        power_db = 20 * np.log10(np.abs(fft) + 1e-9)
                        offset = int((freq - config.start_hz) / bin_hz)
                        n = min(len(power_db), n_bins_total - offset)
                        if n > 0:
                            row[offset : offset + n] = power_db[:n]
                    else:
                        _LOGGER.debug("readStream returned %d at %.3f MHz", sr.ret, freq / 1e6)
                    freq += config.sample_rate
                if not self._stop_event.is_set():
                    self._on_row(SweepRow(start_hz=config.start_hz, bin_hz=bin_hz, power_db=row.tolist()))
        finally:
            sdr.deactivateStream(rx)
            sdr.closeStream(rx)
