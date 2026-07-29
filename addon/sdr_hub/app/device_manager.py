from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Callable

from decode import ReceiverConfig, Rtl433Decoder
from devices import Dongle, discover_dongles
from constants import MAX_RETAINED_DISCOVERIES
from discovery import DiscoveryConfig, DiscoveryRun
from models import (
    DiscoveryCreate,
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


class DuplicateDongleSerialError(Exception):
    """Two or more attached dongles report the same serial (common with cheap RTL2832U
    clones that ship an identical/blank factory serial) — SoapySDR's own open-by-serial
    can't tell them apart either, so neither can this pool; refuse rather than silently
    picking one and misattributing ownership.
    """

    def __init__(self, serial: str) -> None:
        super().__init__(
            f"more than one attached dongle reports serial {serial!r} — can't disambiguate. "
            "Cheap RTL2832U clones often ship with an identical or blank factory serial; "
            "reprogram each dongle with a unique one via `rtl_eeprom -s <new_serial>` "
            "(one dongle attached at a time) and reattach."
        )


class UnsupportedReceiverDriverError(Exception):
    """rtl_433 talks to RTL-SDR hardware directly (via librtlsdr), not through SoapySDR - a
    receiver can't be started on a dongle whose SoapySDR driver isn't "rtlsdr" (e.g. a HackRF
    or Airspy discovered for wideband sweeps), even though sweeps work with any SoapySDR-
    supported device. Surfacing this clearly here avoids a confusing failure deep inside the
    rtl_433 subprocess once it can't find the device at all.
    """

    def __init__(self, serial: str, driver: str) -> None:
        super().__init__(
            f"dongle {serial} uses SoapySDR driver {driver!r}, not 'rtlsdr' - rtl_433 receivers "
            "only work with actual RTL-SDR hardware; use a wideband sweep for this device instead"
        )


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
        on_discovery: Callable[[dict], None] | None = None,
    ) -> None:
        self._loop = loop
        self._on_row = on_row
        self._on_device = on_device
        self._on_status = on_status
        # Snapshots from a running discovery. Kept separate from on_device precisely because the
        # difference is the whole point of the feature: on_device's payload becomes a Home
        # Assistant entity, and a discovery result must not.
        self._on_discovery = on_discovery
        # (driver, serial) -> receiver/sweep id. Keyed by the pair, not serial alone - two
        # devices from *different* SoapySDR drivers (or two devices that both omit a serial,
        # reporting "") can otherwise collide on the same key despite being genuinely distinct
        # hardware, which would make claiming one incorrectly appear to also claim the other.
        self._dongle_owner: dict[tuple[str, str], str] = {}
        self._decoders: dict[str, Rtl433Decoder] = {}
        self._receivers: dict[str, Receiver] = {}
        self._sweepers: dict[str, SoapySweeper] = {}
        self._sweeps: dict[str, Sweep] = {}
        # Finished runs are kept here, not dropped: the result is the entire product of a
        # discovery, and it arrives exactly when the run ends. Discarding it on completion would
        # leave a user who looked away for a minute with nothing at all to show for the listen.
        self._discoveries: dict[str, DiscoveryRun] = {}

    def list_dongles(self) -> list[dict]:
        return [
            {
                "serial": d.serial,
                "label": d.label,
                "driver": d.driver,
                "in_use_by": self._dongle_owner.get((d.driver, d.serial)),
            }
            for d in discover_dongles()
        ]

    def _claim(self, serial: str, owner_id: str, driver: str | None = None) -> Dongle:
        """Claims the attached device matching `serial` (and `driver`, if given).

        `driver` is normally omitted - a bare serial is unambiguous for the overwhelming
        majority of setups (one attached device per serial). It only needs to be supplied
        when multiple attached devices share that serial across *different* SoapySDR drivers
        (or all report a blank one), which `serial` alone can't disambiguate.
        """
        dongles = discover_dongles()
        matches = [d for d in dongles if d.serial == serial and (driver is None or d.driver == driver)]
        if not matches:
            raise DongleNotFoundError(serial)
        if len(matches) > 1:
            raise DuplicateDongleSerialError(serial)
        dongle = matches[0]
        key = (dongle.driver, dongle.serial)
        current_owner = self._dongle_owner.get(key)
        if current_owner is not None:
            raise DongleBusyError(serial, current_owner)
        self._dongle_owner[key] = owner_id
        return dongle

    def _release(self, driver: str, serial: str, owner_id: str) -> None:
        """Only clears the claim if `owner_id` still holds it.

        Without this check, releasing an already-stale (e.g. errored-and-since-replaced)
        entity could pop a *different*, currently-valid owner's claim on the same
        (driver, serial).
        """
        key = (driver, serial)
        if self._dongle_owner.get(key) == owner_id:
            self._dongle_owner.pop(key, None)

    # -- Receivers (rtl_433) ----------------------------------------------

    def list_receivers(self) -> list[Receiver]:
        return list(self._receivers.values())

    async def add_receiver(self, cfg: ReceiverCreate) -> Receiver:
        receiver_id = str(uuid.uuid4())
        dongle = self._claim(cfg.dongle_serial, receiver_id, cfg.dongle_driver)
        if dongle.driver != "rtlsdr":
            self._release(dongle.driver, cfg.dongle_serial, receiver_id)
            raise UnsupportedReceiverDriverError(cfg.dongle_serial, dongle.driver)
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
            self._release(dongle.driver, cfg.dongle_serial, receiver_id)
            raise
        self._decoders[receiver_id] = decoder
        # dongle.driver (the actually-resolved device), not cfg.dongle_driver (the caller's
        # optional hint, usually None) - remove_receiver/_on_receiver_exit need the real value
        # later to release the correct (driver, serial) claim, not whatever hint was or wasn't given.
        receiver = Receiver(id=receiver_id, **{**cfg.model_dump(), "dongle_driver": dongle.driver})
        self._receivers[receiver_id] = receiver
        return receiver

    # -- Discovery (listen-only rtl_433) ------------------------------------------------------

    def list_discoveries(self) -> list[dict]:
        return [run.snapshot() for run in self._discoveries.values()]

    def get_discovery(self, discovery_id: str) -> DiscoveryRun | None:
        return self._discoveries.get(discovery_id)

    async def start_discovery(self, cfg: DiscoveryCreate) -> DiscoveryRun:
        discovery_id = str(uuid.uuid4())
        dongle = self._claim(cfg.dongle_serial, discovery_id, cfg.dongle_driver)
        if dongle.driver != "rtlsdr":
            self._release(dongle.driver, cfg.dongle_serial, discovery_id)
            raise UnsupportedReceiverDriverError(cfg.dongle_serial, dongle.driver)
        # Resolved driver, not the caller's optional hint - the release below has to name the
        # same (driver, serial) pair the claim used, for the reason spelled out in add_receiver.
        driver = dongle.driver
        run = DiscoveryRun(
            discovery_id,
            DiscoveryConfig(
                dongle_serial=cfg.dongle_serial,
                frequencies_hz=cfg.frequencies_hz,
                duration_s=cfg.duration_s,
                protocols=cfg.protocols,
                hop_interval_s=cfg.hop_interval_s,
                gain_db=cfg.gain_db,
                sample_rate_hz=cfg.sample_rate_hz,
                exclude_protocols=cfg.exclude_protocols,
                ppm_error=cfg.ppm_error,
            ),
            on_update=self._on_discovery,
            on_finished=lambda: self._on_discovery_finished(discovery_id, driver, cfg.dongle_serial),
        )
        try:
            await run.start()
        except BaseException:
            # BaseException, not Exception: CancelledError does not inherit from Exception, and
            # cancellation here is entirely ordinary - the Home Assistant command that triggered
            # this can be cancelled while the subprocess is still being spawned. Escaping through
            # an Exception-only handler left the claim registered forever against a run that was
            # never inserted into _discoveries, so no stop, dismiss or shutdown path could ever
            # find it and the dongle was unusable until the add-on restarted.
            #
            # finish() before releasing, because start() may have got far enough to leave an
            # rtl_433 process behind - releasing a claim while the subprocess still holds the
            # device would hand it to the next claimant on top of a live tuner.
            await run.finish()
            self._release(driver, cfg.dongle_serial, discovery_id)
            raise
        self._retire_old_discoveries()
        self._discoveries[discovery_id] = run
        return run

    def _retire_old_discoveries(self) -> None:
        """Drops the oldest finished runs once too many are being retained.

        Results are deliberately kept after a run ends - that is the whole product of a discovery,
        and a panel opening later has no other way to see it - but "until someone dismisses it" is
        not a bound. Each retained run can hold up to DISCOVERY_MAX_DEVICES entries and is
        returned in full by /discoveries, so a user who runs discovery repeatedly without
        dismissing grows both the add-on's memory and every list response without limit.

        Only finished runs are candidates: an active one owns a subprocess and a dongle claim, and
        dropping it would leak both.
        """
        finished = [(run.started_at, did) for did, run in self._discoveries.items() if run.finished]
        excess = len(finished) - MAX_RETAINED_DISCOVERIES
        if excess <= 0:
            return
        for _, discovery_id in sorted(finished)[:excess]:
            _LOGGER.info("retiring discovery %s to stay within the retained-result limit", discovery_id)
            self._discoveries.pop(discovery_id, None)

    def _on_discovery_finished(self, discovery_id: str, driver: str, serial: str) -> None:
        """Frees the dongle the moment the run ends, however it ended.

        Wired to the run's own completion rather than to the caller stopping it, because the
        common case is nobody stopping it at all: a discovery ends by reaching its deadline, with
        no request in flight to hang the release off. Leaving the claim until someone deleted the
        record would block every sweep and receiver on that dongle for as long as the result sat
        there unread - which, since results are deliberately retained, could be indefinitely.
        """
        self._release(driver, serial, discovery_id)
        run = self._discoveries.get(discovery_id)
        if run is not None and self._on_discovery is not None:
            self._on_discovery(run.snapshot())
        # Also here, not only when the next scan starts. Retiring at start alone bounds the set
        # only at that moment: runs keep finishing in between, so a user who starts several and
        # never starts another would sit above the cap indefinitely. Retiring as each one ends
        # keeps it bounded at all times, and the run that just finished is now itself a candidate.
        self._retire_old_discoveries()

    async def stop_discovery(self, discovery_id: str) -> DiscoveryRun | None:
        """Ends a run early, keeping whatever it heard. None if there is no such run.

        Returns the run itself rather than a bool so the caller can snapshot the reference it
        already holds. Looking it up again after the await is unsafe: finishing a run yields, and
        a concurrent dismiss can pop the same id during that window - the second lookup then finds
        nothing and turns a successful stop into a 500.
        """
        run = self._discoveries.get(discovery_id)
        if run is None:
            return None
        await run.finish()
        return run

    async def forget_discovery(self, discovery_id: str) -> bool:
        """Ends the run if still going, then drops the result entirely."""
        run = self._discoveries.pop(discovery_id, None)
        if run is None:
            return False
        # finish() before dropping, not after: a still-running decoder holds both an rtl_433
        # subprocess and the dongle claim, and dropping the only reference to it first would
        # leave nothing able to stop either.
        await run.finish()
        return True

    async def remove_receiver(self, receiver_id: str) -> None:
        receiver = self._receivers.pop(receiver_id, None)
        if receiver is None:
            return
        decoder = self._decoders.pop(receiver_id, None)
        if decoder is not None:
            await decoder.stop()
        self._release(receiver.dongle_driver, receiver.dongle_serial, receiver_id)

    def _on_receiver_exit(self, receiver_id: str, returncode: int | None) -> None:
        receiver = self._receivers.get(receiver_id)
        if receiver is None:
            return
        _LOGGER.error("receiver %s (rtl_433) exited unexpectedly with code %s", receiver_id, returncode)
        receiver.status = EntityStatus.ERROR
        self._decoders.pop(receiver_id, None)
        self._release(receiver.dongle_driver, receiver.dongle_serial, receiver_id)
        self._on_status(EntityKind.RECEIVER, receiver_id, EntityStatus.ERROR, f"rtl_433 exited with code {returncode}")

    # -- Sweeps (SoapySDR wideband) -----------------------------------------

    def list_sweeps(self) -> list[Sweep]:
        return list(self._sweeps.values())

    async def add_sweep(self, cfg: SweepCreate) -> Sweep:
        sweep_id = str(uuid.uuid4())
        dongle = self._claim(cfg.dongle_serial, sweep_id, cfg.dongle_driver)
        sweeper = SoapySweeper(
            on_row=lambda row: self._loop.call_soon_threadsafe(self._on_row, sweep_id, row),
            on_error=lambda err: self._loop.call_soon_threadsafe(self._on_sweep_error, sweep_id, err),
            on_late_stop=lambda: self._loop.call_soon_threadsafe(self._on_sweep_late_stop, sweep_id),
        )
        try:
            sweeper.start(
                SweepConfig(
                    dongle_serial=cfg.dongle_serial,
                    start_hz=cfg.start_hz,
                    stop_hz=cfg.stop_hz,
                    sample_rate=cfg.sample_rate,
                    gain=cfg.gain,
                    soapy_args=dongle.args,
                )
            )
        except Exception:
            self._release(dongle.driver, cfg.dongle_serial, sweep_id)
            raise
        self._sweepers[sweep_id] = sweeper
        # dongle.driver (the actually-resolved device), not cfg.dongle_driver (the caller's
        # optional hint, usually None) - the various release call sites below need the real
        # value later, not whatever hint was or wasn't given at creation time.
        sweep = Sweep(id=sweep_id, **{**cfg.model_dump(), "dongle_driver": dongle.driver})
        self._sweeps[sweep_id] = sweep
        return sweep

    async def remove_sweep(self, sweep_id: str) -> None:
        """Stops and removes a sweep.

        If the sweeper's capture thread doesn't exit in time, SweepStopTimeoutError
        propagates to the caller and the sweep/dongle claim are left in place - the
        thread may still hold the device open, so it would be unsafe to let another
        receiver/sweep claim the same dongle. SoapySweeper.stop() itself arranges for
        _on_sweep_late_stop to eventually clean up once the thread actually exits, so this
        isn't a *permanent* zombie (confirmed live: without that, the dongle claim and the
        sweep's entry here were stuck until the add-on process restarted, and a later attempt
        to start a new sweep on that dongle just failed as "already in use" with no waterfall
        ever appearing - the frozen old sweep was still what any state reload showed).
        """
        sweep = self._sweeps.get(sweep_id)
        if sweep is None:
            return
        sweeper = self._sweepers.get(sweep_id)
        if sweeper is not None:
            sweeper.stop()  # raises SweepStopTimeoutError if the thread is still alive
            self._sweepers.pop(sweep_id, None)
        self._sweeps.pop(sweep_id, None)
        self._release(sweep.dongle_driver, sweep.dongle_serial, sweep_id)

    def _on_sweep_late_stop(self, sweep_id: str) -> None:
        """Cleans up a sweep whose stop() timed out earlier but whose thread has now exited.

        remove_sweep() already returned (raising SweepStopTimeoutError) without popping this
        sweep or releasing its dongle claim, since the thread might still have held the device
        open at that moment. This runs later, once SoapySweeper's background watcher confirms
        the thread is actually gone - release the claim and forget the sweep now. Guarded by
        the dict .pop(..., None)/get(...) defaults in case a *different* successful
        remove_sweep() call (e.g. a user retry, once the thread happened to exit just inside
        that retry's own timeout window) already did this cleanup first.
        """
        sweep = self._sweeps.pop(sweep_id, None)
        self._sweepers.pop(sweep_id, None)
        if sweep is None:
            return
        self._release(sweep.dongle_driver, sweep.dongle_serial, sweep_id)
        _LOGGER.info("sweep %s's capture thread exited after a delayed stop; dongle released", sweep_id)
        self._on_status(EntityKind.SWEEP, sweep_id, EntityStatus.STOPPED, "stopped after a delayed shutdown")

    def _on_sweep_error(self, sweep_id: str, err: Exception) -> None:
        sweep = self._sweeps.get(sweep_id)
        if sweep is None:
            return
        _LOGGER.error("sweep %s failed: %s", sweep_id, err)
        sweep.status = EntityStatus.ERROR
        self._sweepers.pop(sweep_id, None)
        self._release(sweep.dongle_driver, sweep.dongle_serial, sweep_id)
        self._on_status(EntityKind.SWEEP, sweep_id, EntityStatus.ERROR, str(err))

    async def shutdown(self) -> None:
        """Releases every claimed dongle. One kind failing must not strand the others.

        remove_sweep() raises SweepStopTimeoutError when a capture thread outlives its timeout,
        which used to abort the whole shutdown - so a single stuck sweep left every discovery's
        rtl_433 subprocess and deadline task running under the old manager, holding a dongle the
        replacement manager then could not claim. Each kind is now attempted independently, and
        the first error is re-raised afterwards so a genuinely stuck sweep is still reported.
        """
        first_error: Exception | None = None
        for entity_id, stop in [
            *((rid, self.remove_receiver) for rid in list(self._receivers)),
            *((sid, self.remove_sweep) for sid in list(self._sweeps)),
            *((did, self.forget_discovery) for did in list(self._discoveries)),
        ]:
            try:
                await stop(entity_id)
            except Exception as err:  # noqa: BLE001 - one stuck entity must not strand the rest
                _LOGGER.exception("shutdown: failed to stop %s", entity_id)
                if first_error is None:
                    first_error = err
        if first_error is not None:
            raise first_error
