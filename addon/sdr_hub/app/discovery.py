"""A time-boxed listen that reports what is transmitting, without creating anything.

A receiver is a commitment: every device it decodes becomes a Home Assistant entity, with a
registry record, a history, and a name the user may have edited. That is the right behaviour once
you know what you want to keep, and the wrong one for the question that comes first - "what is
even out there?" - which every user has to answer before they can answer anything else, and which
currently can only be answered by adding everything and deleting what you did not want.

A discovery run answers that question and then forgets it. It claims the dongle exactly as a
receiver does and decodes with the same rtl_433 process, but its results are accumulated in
memory, expire on their own, and are broadcast under an event type the integration deliberately
does not turn into entities. Nothing here writes to a registry, so nothing here can destroy a
rename or leave an orphan behind.

Devices are keyed by (model, id, channel), the same identity `decoded_device_key` uses in the
integration and `deviceInstanceKey` uses in the panel. Discovery and the receiver you start
afterwards must agree on what counts as one device, or the thing you chose from a discovery list
would not be the thing that appeared.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import math

from constants import DEFAULT_HOP_INTERVAL_S, DISCOVERY_MAX_DEVICES
from decode import ReceiverConfig, Rtl433Decoder

_LOGGER = logging.getLogger(__name__)


def discovered_device_key(device: dict[str, Any]) -> str:
    """Identity of one physical sensor: model, id and channel.

    Deliberately duplicated from the integration's decoded_device_key rather than imported: the
    add-on and the integration are separately installable and share no Python package, so this is
    a copy on purpose. Both are load-bearing for the same reason - a family that shares a model
    and omits `id`, distinguished only by a dial, would otherwise merge into one entry - and they
    must be changed together.
    """
    model = device.get("model") or ""
    ident = device.get("id")
    channel = device.get("channel")
    return f"{model}|{'' if ident is None else ident}|{'' if channel is None else channel}"


# The range a JSON integer may occupy before the serializers downstream reject it. Matches the
# integration's own limits, deliberately: this is the same guard applied one layer earlier.
_MIN_SERIALIZABLE_INT = -(2**63)
_MAX_SERIALIZABLE_INT = 2**64 - 1


def _json_safe(value: Any) -> Any:
    """Returns the value, or None if it could not survive being serialized as JSON.

    Applied where rtl_433's output is *recorded* rather than where it is sent, so every consumer
    is protected by construction. The REST responses are encoded by FastAPI with strict JSON
    rules, which reject NaN and infinity outright - so an unguarded snapshot did not merely lose a
    field, it turned /discoveries into a 500 and left a reopening panel unable to retrieve any
    retained run at all. The integration sanitizes as well, since it must tolerate an older
    add-on, but the value should never have left here in the first place.
    """
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value if _MIN_SERIALIZABLE_INT <= value <= _MAX_SERIALIZABLE_INT else None
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


@dataclass
class DiscoveryConfig:
    dongle_serial: str
    frequencies_hz: list[float]
    duration_s: int
    protocols: list[int] = field(default_factory=list)
    hop_interval_s: int = DEFAULT_HOP_INTERVAL_S
    gain_db: float | None = None
    sample_rate_hz: float | None = None
    exclude_protocols: list[int] = field(default_factory=list)
    ppm_error: int | None = None


class DiscoveryRun:
    """One bounded listen. Single-use: once finished it holds its results and is not restarted."""

    def __init__(
        self,
        run_id: str,
        config: DiscoveryConfig,
        on_update: Callable[[dict], None] | None = None,
        on_finished: Callable[[], None] | None = None,
    ) -> None:
        self.id = run_id
        self.config = config
        self.started_at = time.time()
        self.finished = False
        # Set when the run ended for a reason the user needs to know about (rtl_433 failed to
        # start, or died mid-run). A run that simply reached its deadline having heard nothing is
        # not an error - a genuinely quiet band is a valid and informative answer.
        self.error: str | None = None
        self._devices: dict[str, dict[str, Any]] = {}
        self._truncated = False
        self._on_update = on_update
        self._on_finished = on_finished
        self._decoder: Rtl433Decoder | None = None
        self._deadline_task: asyncio.Task | None = None
        # `finished` means "the run is over" and is set as soon as teardown *begins*, because it
        # is what snapshots report and a caller asking mid-teardown should not be told the run is
        # still listening. Teardown completing is a different fact, and it is the one that matters
        # to anyone waiting to use the dongle - so it gets its own signal.
        # Bumped on every change to the run's observable state. Consumers see snapshots from two
        # independent paths - the response to their own request, and the broadcast stream - which
        # can arrive in either order, and "is finished" is too coarse to separate two *running*
        # snapshots: the response to a start can carry an empty device list that lands after a
        # decode has already been streamed, blanking a device the user just saw appear.
        self._revision = 0
        # Last frequency rtl_433 reported tuning to. Tracked because a hopping run's decode rows
        # do not carry one, so without it every device found across several frequencies is
        # reported at an unknown frequency - which is the one fact needed to act on the result.
        self._current_center_hz: float | None = None
        self._teardown_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._decoder = Rtl433Decoder(
            ReceiverConfig(
                dongle_serial=self.config.dongle_serial,
                frequencies_hz=self.config.frequencies_hz,
                protocols=self.config.protocols,
                hop_interval_s=self.config.hop_interval_s,
                gain_db=self.config.gain_db,
                sample_rate_hz=self.config.sample_rate_hz,
                # A survey is exactly where signal level earns its cost: it is what separates a
                # device heard once at the noise floor from one heard forty times well above it.
                exclude_protocols=self.config.exclude_protocols,
                ppm_error=self.config.ppm_error,
                report_signal_level=True,
            ),
            on_device=self._on_device,
            on_exit=self._on_decoder_exit,
        )
        await self._decoder.start()
        self._deadline_task = asyncio.create_task(self._await_deadline())

    async def _await_deadline(self) -> None:
        try:
            await asyncio.sleep(self.config.duration_s)
        except asyncio.CancelledError:
            # Stopped early by the caller, which owns finishing the run - returning rather than
            # falling through avoids two paths both marking it finished and both releasing the
            # dongle claim.
            raise
        await self.finish()

    def _on_device(self, device: dict[str, Any]) -> None:
        # rtl_433 writes more than decodes to its JSON stream: tuning changes arrive as bare
        # {"center_frequency": ...} lines, and there are protocol-level status rows too. Recording
        # them produced a phantom "None" device that was, in a live 5-minute run, the single
        # most-heard entry in the list - 29 sightings of the receiver telling us it had retuned.
        #
        # A real decode always names its model, so that is the test. The retune notice is not
        # discarded though: it is the only statement of which frequency the decodes that follow
        # were heard on, which rtl_433 otherwise omits from the rows themselves when hopping.
        if "center_frequency" in device and not device.get("model"):
            center = device.get("center_frequency")
            if isinstance(center, (int, float)) and not isinstance(center, bool) and math.isfinite(center):
                self._current_center_hz = float(center)
            return
        if not isinstance(device.get("model"), str) or not device["model"]:
            return
        key = discovered_device_key(device)
        existing = self._devices.get(key)
        now = time.time()
        if existing is None:
            if len(self._devices) >= DISCOVERY_MAX_DEVICES:
                # Recorded once rather than logged per decode: a band busy enough to hit this cap
                # is one where the overflow would otherwise repeat for the whole run.
                if not self._truncated:
                    self._truncated = True
                    _LOGGER.warning(
                        "discovery %s reached the %d-device cap; further new devices are ignored "
                        "for this run",
                        self.id,
                        DISCOVERY_MAX_DEVICES,
                    )
                return
            self._devices[key] = {
                "key": key,
                "model": device.get("model"),
                "id": _json_safe(device.get("id")),
                "channel": _json_safe(device.get("channel")),
                "first_seen": now,
                "last_seen": now,
                "count": 1,
                # rtl_433 reports the frequency it was tuned to when hopping, which is the single
                # most useful field for acting on a result: it is what you would configure a
                # receiver with. Absent on single-frequency runs, where it is already known.
                "frequency_hz": _frequency_hz(device, self.config.frequencies_hz, self._current_center_hz),
                # A sample of the actual readings, so the list can show "11.7 C, 48 %" rather
                # than only a model name - which is what makes a row identifiable as *your*
                # sensor rather than one of four identical models in the house.
                "sample": _sample_fields(device),
            }
        else:
            existing["last_seen"] = now
            existing["count"] += 1
            existing["sample"] = _sample_fields(device)
            freq = _frequency_hz(device, self.config.frequencies_hz, self._current_center_hz)
            if freq is not None:
                existing["frequency_hz"] = freq
        self._revision += 1
        if self._on_update is not None:
            self._on_update(self.snapshot())

    def _on_decoder_exit(self, returncode: int | None) -> None:
        """rtl_433 ended by itself - a failure, since a healthy run only ends at its deadline."""
        if self.finished:
            return
        # Include what rtl_433 said, which is usually the whole diagnosis: a mistyped protocol
        # number, an unsupported sample rate and an absent dongle all exit with code 1, and the
        # code alone leaves the user with nothing to act on.
        detail = self._decoder.stderr_tail if self._decoder is not None else ""
        self.error = f"rtl_433 exited unexpectedly with code {returncode}"
        if detail:
            self.error += f": {detail}"
        _LOGGER.warning("discovery %s: %s", self.id, self.error)
        # finish() is async and this is a plain callback from the reader task, so the completion
        # has to be scheduled rather than awaited. Without it a failed run would sit "running"
        # forever, holding the dongle claim against every later receiver or sweep.
        asyncio.create_task(self.finish())

    async def _teardown(self) -> None:
        """Stops the subprocess and releases the dongle. Runs as its own task - see finish()."""
        try:
            if self._decoder is not None:
                await self._decoder.stop()
                self._decoder = None
        finally:
            if self._on_finished is not None:
                self._on_finished()

    async def finish(self) -> None:
        """Ends the run and releases the dongle. Safe to call concurrently and repeatedly.

        A second caller waits for the first to finish rather than returning immediately. Returning
        on the flag alone meant a dismiss could answer - and its ownership refresh could run -
        while a slow-to-terminate rtl_433 still held the device, so a capture started right after
        got a 409 that nothing in the UI explained. It also let DeviceManager.shutdown() return
        with a decoder still shutting down behind it.
        """
        if self._teardown_task is not None:
            await asyncio.shield(self._teardown_task)
            return
        self.finished = True
        self._revision += 1
        # Not cancelled when finish() is running *inside* it, which is the normal ending: the
        # deadline fires, _await_deadline awaits finish(), and cancelling the task here would
        # cancel the coroutine currently executing. The CancelledError then lands at the very next
        # await - stopping the decoder - so the subprocess is left running, on_finished never
        # fires, and the dongle claim is never released. Measured: a run reported finished=True
        # while still holding the dongle, and every later sweep on it returned 409 forever.
        current = asyncio.current_task()
        deadline = self._deadline_task
        self._deadline_task = None
        if deadline is not None and deadline is not current and not deadline.done():
            deadline.cancel()
        # on_finished is what releases the dongle, so it has to run even when stopping the decoder
        # fails. The path that made this necessary: rtl_433 exits by itself, _on_decoder_exit
        # schedules finish(), and stop() then terminates a process that is already gone. Any
        # exception there used to skip the release entirely - and because `finished` was set at
        # the top, neither stopping nor dismissing the run could retry it, so the dongle stayed
        # claimed until the add-on restarted.
        # Teardown runs as its own task, awaited through a shield, so cancelling whoever called
        # finish() cannot abandon it half-done. Previously a cancellation while awaiting stop()
        # unwound straight through the release - handing the dongle to the next claimant while
        # rtl_433 might still be alive and holding it - and left the run marked complete, so no
        # later caller would retry. Isolating it means the process is always waited out, and the
        # SIGKILL fallback always reached, whatever happens to the requester.
        self._teardown_task = asyncio.create_task(self._teardown())
        await asyncio.shield(self._teardown_task)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "dongle_serial": self.config.dongle_serial,
            "frequencies_hz": list(self.config.frequencies_hz),
            "duration_s": self.config.duration_s,
            "hop_interval_s": self.config.hop_interval_s,
            "protocols": list(self.config.protocols),
            "exclude_protocols": list(self.config.exclude_protocols),
            "ppm_error": self.config.ppm_error,
            "gain_db": self.config.gain_db,
            "sample_rate_hz": self.config.sample_rate_hz,
            "started_at": self.started_at,
            # Monotonic within a run, so a consumer can order two snapshots that arrived by
            # different routes without needing a clock shared with this process.
            "revision": self._revision,
            "finished": self.finished,
            "truncated": self._truncated,
            "error": self.error,
            # Most-heard first: on a busy band the device transmitting every 30 seconds is
            # almost always the one being looked for, and a single stray decode from a
            # neighbour's sensor should not head the list.
            "devices": sorted(self._devices.values(), key=lambda d: (-d["count"], str(d["model"]))),
        }


def _frequency_hz(
    device: dict[str, Any], configured: list[float], current_center_hz: float | None = None
) -> float | None:
    """The frequency this decode was heard on, in Hz.

    Three sources, in descending order of directness: the row's own `freq` field when rtl_433
    includes one; otherwise the last frequency it announced retuning to, which is the only thing
    that distinguishes frequencies on a hopping run; otherwise the single configured frequency,
    which needs no reporting to be known. A result whose frequency is unknown is one the user
    cannot act on, so it is worth reaching for the indirect answers.
    """
    freq_mhz = device.get("freq")
    if isinstance(freq_mhz, (int, float)) and not isinstance(freq_mhz, bool):
        try:
            # The *converted* value is what gets stored, and finite MHz does not imply finite Hz -
            # 1e308 passes the input check and overflows to inf on the way out. int -> float can
            # also raise OverflowError outright for a large enough integer, which would otherwise
            # escape into the decoder's read loop and end it.
            hz = float(freq_mhz) * 1e6
        except (OverflowError, ValueError):
            hz = None
        if hz is not None and math.isfinite(hz):
            return hz
    if current_center_hz is not None:
        return current_center_hz
    if len(configured) == 1:
        return float(configured[0])
    return None


# Fields that describe the device rather than the decode. Excluded because they are either
# already carried as identity (model/id/channel), internal to rtl_433 (mic/protocol/raw fields),
# or not a reading (time/freq) - leaving exactly the measurements a user would recognise.
_SAMPLE_EXCLUDED = frozenset(
    {"model", "id", "channel", "time", "mic", "protocol", "freq", "rssi", "snr", "noise", "raw_message"}
)
# Cap on sampled fields per device. rtl_433 emits a handful for ordinary sensors, but some
# protocols carry long arrays of per-slot values; a discovery list is a summary, and one verbose
# decoder should not be able to make its row unreadable or bloat every broadcast of the snapshot.
_SAMPLE_MAX_FIELDS = 8


def _sample_fields(device: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in device.items():
        if key in _SAMPLE_EXCLUDED:
            continue
        # Only scalars: a nested structure cannot be rendered as "name: value" in a summary row,
        # and passing one through would put an arbitrary payload into every snapshot broadcast.
        if not isinstance(value, (str, int, float, bool)) and value is not None:
            continue
        safe = _json_safe(value)
        # Dropped rather than recorded as null: a reading that cannot be represented is not a
        # reading of None, and showing "temperature_C: null" in a summary row would assert
        # something the decode never said.
        if safe is None and value is not None:
            continue
        out[key] = safe
        if len(out) >= _SAMPLE_MAX_FIELDS:
            break
    return out
