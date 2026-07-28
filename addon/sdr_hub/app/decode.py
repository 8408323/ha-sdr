from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Callable

from constants import DEFAULT_HOP_INTERVAL_S

_LOGGER = logging.getLogger(__name__)


@dataclass
class ReceiverConfig:
    dongle_serial: str
    frequencies_hz: list[float]
    protocols: list[int] = field(default_factory=list)
    hop_interval_s: int = DEFAULT_HOP_INTERVAL_S
    # None means "let rtl_433 choose", which is not the same as any particular value: its default
    # is automatic gain, and there is no number that reproduces that. Naming a gain is worth doing
    # when a sensor is weak enough that AGC keeps riding over it, and worth *not* doing otherwise.
    gain_db: float | None = None
    # Likewise: rtl_433 picks a rate appropriate to the decoders in use (250k for OOK, 1024k when
    # an FSK decoder is enabled). Overriding is occasionally useful - a wider rate catches signals
    # slightly off the nominal frequency - but a wrong value silently stops decoders working.
    sample_rate_hz: float | None = None
    # Adds `-M time:iso -M level`, so each decode carries a timestamp and signal level (and
    # rtl_433 then also reports the frequency it measured). Opt-in rather than always-on: these
    # rows flow to the integration, which turns numeric fields it does not recognise into Home
    # Assistant entities - so switching it on for receivers would have created rssi, snr and noise
    # entities for every already-decoded device on upgrade, spending an entity budget the user
    # never asked to spend. A discovery creates no entities, so it can have them for free.
    report_signal_level: bool = False


class Rtl433Decoder:
    """Runs rtl_433 as a subprocess against a specific dongle, emitting one decoded-device dict per JSON line.

    Multiple frequencies are passed as repeated -f flags; rtl_433 time-hops between them
    every hop_interval_s (not simultaneous — one dongle, one tuner). Signals sharing one
    frequency (e.g. many 433.92 MHz ISM devices) are already decoded concurrently by
    rtl_433 from a single capture, no extra work needed here.
    """

    def __init__(
        self,
        config: ReceiverConfig,
        on_device: Callable[[dict], None],
        on_exit: Callable[[int | None], None] | None = None,
    ) -> None:
        self._config = config
        self._on_device = on_device
        self._on_exit = on_exit
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._process is not None:
            raise RuntimeError("decoder already running")
        args = ["rtl_433", "-d", f":{self._config.dongle_serial}", "-F", "json"]
        for freq in self._config.frequencies_hz:
            args += ["-f", str(int(freq))]
        if len(self._config.frequencies_hz) > 1:
            args += ["-H", str(self._config.hop_interval_s)]
        for protocol in self._config.protocols:
            args += ["-R", str(protocol)]
        # Omitted entirely when unset, rather than passed as a default: rtl_433's own defaults are
        # automatic gain and a rate chosen from the enabled decoders, and no explicit value
        # reproduces either.
        if self._config.gain_db is not None:
            args += ["-g", str(self._config.gain_db)]
        if self._config.sample_rate_hz is not None:
            args += ["-s", str(int(self._config.sample_rate_hz))]
        # Timestamps and signal level on every decode. Level is what makes a marginal result
        # readable as marginal - a device heard once at the noise floor and one heard forty times
        # well above it look identical without it.
        if self._config.report_signal_level:
            args += ["-M", "time:iso", "-M", "level"]
        self._process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

    async def stop(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        if self._process is None:
            return
        try:
            self._process.terminate()
        except ProcessLookupError:
            # Already exited on its own - which is precisely when stop() is most likely to be
            # called, since the exit callback triggers the same teardown. Nothing to signal, but
            # the wait below still reaps it.
            pass
        try:
            await asyncio.wait_for(self._process.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                self._process.kill()
            except ProcessLookupError:
                pass
            # SIGKILL can't be blocked, but the OS still needs a moment to reap the
            # process - wait for it so the dongle is genuinely free before we return.
            await self._process.wait()
        self._process = None

    async def _read_loop(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        process = self._process
        async for line in process.stdout:
            try:
                device = json.loads(line)
            except json.JSONDecodeError:
                _LOGGER.debug("non-JSON rtl_433 line: %r", line)
                continue
            self._on_device(device)
        # Reaching here means stdout closed on its own (process exited) rather than via stop(),
        # which cancels this task before the loop can end naturally.
        if self._on_exit is not None:
            self._on_exit(process.returncode)
