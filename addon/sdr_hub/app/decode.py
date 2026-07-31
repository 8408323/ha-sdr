from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from constants import DEFAULT_HOP_INTERVAL_S, STDERR_TAIL_LINES

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
    # Decoders to switch off while leaving every other default enabled. Distinct from `protocols`,
    # which switches everything *else* off - the two answer opposite questions, and the difference
    # matters because the useful case here is silencing one noisy decoder without giving up the
    # rest. Measured over a live overnight survey, a handful of permissive decoders produced a
    # spurious result roughly every twenty minutes while the real devices came from decoders that
    # never misfired once.
    exclude_protocols: list[int] = field(default_factory=list)
    # Tuner frequency-offset correction in ppm. None leaves rtl_433's default of 0 rather than
    # passing 0 explicitly, so the flag is absent unless a calibration was actually supplied.
    ppm_error: int | None = None


# Lines rtl_433 writes that are never the reason it failed.
#
# The protocol-list entries matter most. On an invalid protocol number rtl_433 prints the one
# sentence that explains the failure and then dumps all ~250 supported protocols after it - so a
# bounded tail that kept everything ended up holding the last dozen protocol names and none of the
# diagnosis. Measured: the error read "[213] Fine Offset Electronics WS80 weather station ..."
# where it should have read "Protocol number specified (9) is invalid".
_STDERR_NOISE = re.compile(
    r"""^(?:
        \[\s*\d+\][ ]*\**    # "[213]  Fine Offset ..." protocol list entries
      | =\s*Supported[ ]device   # the list's own headings
      | =\s*Disabled[ ]by
      | \*\s*Disabled[ ]by
      | Trying[ ]conf[ ]file
      | rtl_433[ ]version
      | Use[ ]-h[ ]for[ ]usage
      | Registered[ ]\d+[ ]out[ ]of
      | Consider[ ]a[ ]more
    )""",
    re.VERBOSE,
)


def _is_stderr_noise(text: str) -> bool:
    return bool(_STDERR_NOISE.match(text))


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
        # Last few lines rtl_433 wrote to stderr, kept so a failure can say *why*.
        #
        # stderr used to be discarded, which made every misconfiguration look identical: an invalid
        # protocol number, an unsupported sample rate and a missing dongle all surfaced as "exited
        # with code 1". rtl_433 explains itself perfectly well - "Protocol number specified (9) is
        # invalid" - and that sentence is the entire difference between a user fixing their input
        # and having no idea what happened. Bounded, because rtl_433 also writes its whole
        # protocol list to stderr on that particular error.
        self._stderr_tail: deque[str] = deque(maxlen=STDERR_TAIL_LINES)
        self._stderr_task: asyncio.Task | None = None

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
        # Negative protocol numbers disable a decoder. Applied after the positive list because
        # rtl_433 reads them in order, though the two are mutually exclusive by validation: once
        # any positive -R is given, everything else is already off and an exclusion would be
        # meaningless rather than wrong.
        for protocol in self._config.exclude_protocols:
            args += ["-R", f"-{protocol}"]
        if self._config.ppm_error is not None:
            args += ["-p", str(self._config.ppm_error)]
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
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        # Drained continuously rather than read on exit: a pipe nobody reads fills and then blocks
        # the writer, so leaving it unread would hang rtl_433 mid-run rather than merely lose the
        # message - the reason it was DEVNULL in the first place.
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    @property
    def stderr_tail(self) -> str:
        """The last lines rtl_433 wrote to stderr, as one string. Empty if it said nothing."""
        return "\n".join(self._stderr_tail)

    async def stop(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            self._stderr_task = None
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

    async def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        async for line in process.stderr:
            text = line.decode(errors="replace").strip()
            if not text or _is_stderr_noise(text):
                continue
            self._stderr_tail.append(text)

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
