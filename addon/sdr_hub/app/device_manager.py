from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Callable

from decode import ReceiverConfig, Rtl433Decoder
from devices import discover_dongles
from models import (
    EntityKind,
    EntityStatus,
    Receiver,
    ReceiverCreate,
    Sweep,
    SweepCreate,
)
from scanner import SoapySweeper, SweepConfig, SweepRow

_LOGGER = logging.getLogger(__name__)


class DongleBusyError(Exception):
    def __init__(self, serial: str, owner: str) -> None:
        super().__init__(f"dongle {serial} is already in use by {owner}")


class DongleNotFoundError(Exception):
    def __init__(self, serial: str) -> None:
        super().__init__(f"no dongle with serial {serial} attached")


class DeviceManager:
    """Pool over N attached dongles: each dongle services at most one receiver or sweep at a time.

    A dongle can only receive one frequency window at once, so exclusivity is enforced
    per-dongle, not globally — with two dongles attached, one receiver and one sweep (or
    two receivers) can run concurrently.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        on_row: Callable[[str, SweepRow], None],
        on_device: Callable[[str, dict], None],
        on_status: Callable[[EntityKind, str, EntityStatus, str | None], None],
    ) -> None:
        self._loop = loop
        self._on_row = on_row
        self._on_device = on_device
        self._on_status = on_status
        self._dongle_owner: dict[str, str] = {}  # serial -> receiver/sweep id
        self._decoders: dict[str, Rtl433Decoder] = {}
        self._receivers: dict[str, Receiver] = {}
        self._sweepers: dict[str, SoapySweeper] = {}
        self._sweeps: dict[str, Sweep] = {}

    def list_dongles(self) -> list[dict]:
        return [
            {"serial": d.serial, "label": d.label, "in_use_by": self._dongle_owner.get(d.serial)}
            for d in discover_dongles()
        ]

    def _claim(self, serial: str, owner_id: str) -> None:
        known_serials = {d.serial for d in discover_dongles()}
        if serial not in known_serials:
            raise DongleNotFoundError(serial)
        current_owner = self._dongle_owner.get(serial)
        if current_owner is not None:
            raise DongleBusyError(serial, current_owner)
        self._dongle_owner[serial] = owner_id

    def _release(self, serial: str) -> None:
        self._dongle_owner.pop(serial, None)

    # -- Receivers (rtl_433) ----------------------------------------------

    def list_receivers(self) -> list[Receiver]:
        return list(self._receivers.values())

    async def add_receiver(self, cfg: ReceiverCreate) -> Receiver:
        receiver_id = str(uuid.uuid4())
        self._claim(cfg.dongle_serial, receiver_id)
        decoder = Rtl433Decoder(
            config=ReceiverConfig(
                dongle_serial=cfg.dongle_serial,
                frequencies_hz=cfg.frequencies_hz,
                protocols=cfg.protocols,
                hop_interval_s=cfg.hop_interval_s,
            ),
            on_device=lambda device: self._on_device(receiver_id, device),
            on_exit=lambda code: self._loop.call_soon_threadsafe(self._on_receiver_exit, receiver_id, code),
        )
        try:
            await decoder.start()
        except Exception:
            self._release(cfg.dongle_serial)
            raise
        self._decoders[receiver_id] = decoder
        receiver = Receiver(id=receiver_id, **cfg.model_dump())
        self._receivers[receiver_id] = receiver
        return receiver

    async def remove_receiver(self, receiver_id: str) -> None:
        receiver = self._receivers.pop(receiver_id, None)
        if receiver is None:
            return
        decoder = self._decoders.pop(receiver_id, None)
        if decoder is not None:
            await decoder.stop()
        self._release(receiver.dongle_serial)

    def _on_receiver_exit(self, receiver_id: str, returncode: int | None) -> None:
        receiver = self._receivers.get(receiver_id)
        if receiver is None:
            return
        _LOGGER.error("receiver %s (rtl_433) exited unexpectedly with code %s", receiver_id, returncode)
        receiver.status = EntityStatus.ERROR
        self._decoders.pop(receiver_id, None)
        self._release(receiver.dongle_serial)
        self._on_status(EntityKind.RECEIVER, receiver_id, EntityStatus.ERROR, f"rtl_433 exited with code {returncode}")

    # -- Sweeps (SoapySDR wideband) -----------------------------------------

    def list_sweeps(self) -> list[Sweep]:
        return list(self._sweeps.values())

    async def add_sweep(self, cfg: SweepCreate) -> Sweep:
        sweep_id = str(uuid.uuid4())
        self._claim(cfg.dongle_serial, sweep_id)
        sweeper = SoapySweeper(
            on_row=lambda row: self._loop.call_soon_threadsafe(self._on_row, sweep_id, row),
            on_error=lambda err: self._loop.call_soon_threadsafe(self._on_sweep_error, sweep_id, err),
        )
        try:
            sweeper.start(
                SweepConfig(
                    dongle_serial=cfg.dongle_serial,
                    start_hz=cfg.start_hz,
                    stop_hz=cfg.stop_hz,
                    sample_rate=cfg.sample_rate,
                    gain=cfg.gain,
                )
            )
        except Exception:
            self._release(cfg.dongle_serial)
            raise
        self._sweepers[sweep_id] = sweeper
        sweep = Sweep(id=sweep_id, **cfg.model_dump())
        self._sweeps[sweep_id] = sweep
        return sweep

    async def remove_sweep(self, sweep_id: str) -> None:
        """Stops and removes a sweep.

        If the sweeper's capture thread doesn't exit in time, SweepStopTimeoutError
        propagates to the caller and the sweep/dongle claim are left in place - the
        thread may still hold the device open, so it would be unsafe to let another
        receiver/sweep claim the same dongle.
        """
        sweep = self._sweeps.get(sweep_id)
        if sweep is None:
            return
        sweeper = self._sweepers.get(sweep_id)
        if sweeper is not None:
            sweeper.stop()  # raises SweepStopTimeoutError if the thread is still alive
            self._sweepers.pop(sweep_id, None)
        self._sweeps.pop(sweep_id, None)
        self._release(sweep.dongle_serial)

    def _on_sweep_error(self, sweep_id: str, err: Exception) -> None:
        sweep = self._sweeps.get(sweep_id)
        if sweep is None:
            return
        _LOGGER.error("sweep %s failed: %s", sweep_id, err)
        sweep.status = EntityStatus.ERROR
        self._sweepers.pop(sweep_id, None)
        self._release(sweep.dongle_serial)
        self._on_status(EntityKind.SWEEP, sweep_id, EntityStatus.ERROR, str(err))

    async def shutdown(self) -> None:
        for receiver_id in list(self._receivers):
            await self.remove_receiver(receiver_id)
        for sweep_id in list(self._sweeps):
            await self.remove_sweep(sweep_id)
