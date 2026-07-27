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


@dataclass
class DiscoveryConfig:
    dongle_serial: str
    frequencies_hz: list[float]
    duration_s: int
    protocols: list[int] = field(default_factory=list)
    hop_interval_s: int = DEFAULT_HOP_INTERVAL_S


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

    async def start(self) -> None:
        self._decoder = Rtl433Decoder(
            ReceiverConfig(
                dongle_serial=self.config.dongle_serial,
                frequencies_hz=self.config.frequencies_hz,
                protocols=self.config.protocols,
                hop_interval_s=self.config.hop_interval_s,
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
                "id": device.get("id"),
                "channel": device.get("channel"),
                "first_seen": now,
                "last_seen": now,
                "count": 1,
                # rtl_433 reports the frequency it was tuned to when hopping, which is the single
                # most useful field for acting on a result: it is what you would configure a
                # receiver with. Absent on single-frequency runs, where it is already known.
                "frequency_hz": _frequency_hz(device, self.config.frequencies_hz),
                # A sample of the actual readings, so the list can show "11.7 C, 48 %" rather
                # than only a model name - which is what makes a row identifiable as *your*
                # sensor rather than one of four identical models in the house.
                "sample": _sample_fields(device),
            }
        else:
            existing["last_seen"] = now
            existing["count"] += 1
            existing["sample"] = _sample_fields(device)
            freq = _frequency_hz(device, self.config.frequencies_hz)
            if freq is not None:
                existing["frequency_hz"] = freq
        if self._on_update is not None:
            self._on_update(self.snapshot())

    def _on_decoder_exit(self, returncode: int | None) -> None:
        """rtl_433 ended by itself - a failure, since a healthy run only ends at its deadline."""
        if self.finished:
            return
        self.error = f"rtl_433 exited unexpectedly with code {returncode}"
        _LOGGER.warning("discovery %s: %s", self.id, self.error)
        # finish() is async and this is a plain callback from the reader task, so the completion
        # has to be scheduled rather than awaited. Without it a failed run would sit "running"
        # forever, holding the dongle claim against every later receiver or sweep.
        asyncio.create_task(self.finish())

    async def finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        if self._deadline_task is not None and not self._deadline_task.done():
            self._deadline_task.cancel()
        self._deadline_task = None
        if self._decoder is not None:
            await self._decoder.stop()
            self._decoder = None
        if self._on_finished is not None:
            self._on_finished()

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "dongle_serial": self.config.dongle_serial,
            "frequencies_hz": list(self.config.frequencies_hz),
            "duration_s": self.config.duration_s,
            "started_at": self.started_at,
            "finished": self.finished,
            "truncated": self._truncated,
            "error": self.error,
            # Most-heard first: on a busy band the device transmitting every 30 seconds is
            # almost always the one being looked for, and a single stray decode from a
            # neighbour's sensor should not head the list.
            "devices": sorted(self._devices.values(), key=lambda d: (-d["count"], str(d["model"]))),
        }


def _frequency_hz(device: dict[str, Any], configured: list[float]) -> float | None:
    """The frequency this decode was heard on, in Hz.

    rtl_433 reports `freq` in MHz and only while hopping. On a single-frequency run the answer is
    known without being told, so it is filled in rather than left null - a result whose frequency
    is unknown is one the user cannot act on, and "the only frequency we were listening to" is not
    a guess.
    """
    freq_mhz = device.get("freq")
    if isinstance(freq_mhz, (int, float)) and not isinstance(freq_mhz, bool):
        return float(freq_mhz) * 1e6
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
        out[key] = value
        if len(out) >= _SAMPLE_MAX_FIELDS:
            break
    return out
