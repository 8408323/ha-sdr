from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Callable

_LOGGER = logging.getLogger(__name__)


@dataclass
class ReceiverConfig:
    dongle_serial: str
    frequencies_hz: list[float]
    protocols: list[int] = field(default_factory=list)
    hop_interval_s: int = 10


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
        self._process.terminate()
        try:
            await asyncio.wait_for(self._process.wait(), timeout=5)
        except asyncio.TimeoutError:
            self._process.kill()
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
