from __future__ import annotations

import asyncio
import itertools
import logging
import threading
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from auth import resolve_api_token
from broadcaster import Broadcaster
from device_manager import DeviceManager
from fastapi import FastAPI
from models import EntityKind, EntityStatus
from routes import router
from scanner import SweepRow
from sweep_stats import SweepStats

_LOGGER = logging.getLogger("sdr_hub")

# Highest event `seq` handed out, persisted so the counter can be seeded above it after a
# restart. Alongside /data/api_token (see auth.py) - the add-on's existing durable-state path.
SEQ_HIGH_WATER_PATH = Path("/data/event_seq")
# Persisting on literally every decode would mean a file write per received packet. Events are
# only ever compared against *other* events, so the sequence needs to be non-decreasing, not
# gap-free - checkpointing every Nth value and seeding from (checkpoint + N) after a restart
# keeps that guarantee while writing ~1/N as often. Gaps in the sequence are harmless.
SEQ_CHECKPOINT_INTERVAL = 100
# How far beyond the issued sequence each checkpoint reserves. Deliberately larger than the
# checkpoint interval so a renewal can be started while headroom remains and complete
# asynchronously, instead of the reservation only ever being renewed at the exact boundary where
# it is already exhausted.
SEQ_RESERVE_AHEAD = 2 * SEQ_CHECKPOINT_INTERVAL
# What is actually on disk is a *reservation*: every checkpoint stores `seq + INTERVAL`, i.e. a
# value strictly above anything that can be handed out before the next checkpoint. Storing the
# issued seq instead left a window where a value was broadcast but not yet durable - a kill
# between the two, with a backward-adjusted clock, reseeded at the same point and reissued
# sequence numbers clients already held. An equal-ordered recovery loses to the stored low in
# mergeBatteryLowState, so a stale low-battery warning could persist indefinitely.
_seq_high_water_written = 0
_seq_scheduled_high_water = 0
# Separate throttle for the synchronous exhausted-reservation guard. Without it, a /data that
# stays unwritable after the startup reservation is consumed leaves _seq_high_water_written
# permanently behind, so the guard fired on *every* decode and did blocking filesystem work on
# the event loop per packet - the same flooding the asynchronous path is throttled to avoid.
_seq_guard_last_attempt = 0
# Latches the degraded-durability warning so a broken /data logs once rather than once per
# retry interval for as long as the fault lasts.
_seq_reservation_warned = False
# Serializes the whole check-write-mark sequence. The guard alone was not enough: two executor
# jobs can both pass a bare comparison before either updates the mark, and the fsyncs inside the
# critical section yield for long enough to make that interleaving realistic - after which the
# lower job can land last and replace both the file and the mark with its lower value.
_seq_checkpoint_lock = threading.Lock()


def resolve_seq_seed() -> int:
    """Seeds the event counter above both the wall clock and anything already handed out."""
    now_ms = int(time.time() * 1000)
    stored = 0
    try:
        if SEQ_HIGH_WATER_PATH.exists():
            stored = int(SEQ_HIGH_WATER_PATH.read_text().strip() or 0)
    except (OSError, ValueError):
        # Unreadable/corrupt checkpoint - fall back to the clock alone. Worst case is the
        # pre-existing behaviour, not a crash on startup.
        stored = 0
    # `stored` is already a reservation above every issued value, so it is used directly rather
    # than with another interval added on top.
    seed = max(now_ms, stored)
    # Reserved *synchronously, before the first sequence is handed out* - startup is not on the
    # hot path, so the blocking write is fine here and is what closes the kill-before-checkpoint
    # window. Any later restart seeds at or above this, so a reissue is impossible even if the
    # process dies before its first runtime checkpoint completes.
    _write_seq_checkpoint(seed)
    return seed


def _write_seq_checkpoint(seq: int) -> None:
    """Durably records `seq`. Blocking - must not run on the event loop."""
    global _seq_high_water_written, _seq_scheduled_high_water
    with _seq_checkpoint_lock:
        # Re-checked *inside* the lock: executor jobs can complete out of order, and only holding
        # the check, the write and the mark update together prevents a lower job landing last.
        # Compared as reservations, since that is what is actually stored - comparing the raw seq
        # against a stored reservation would skip a genuinely needed write.
        if seq + SEQ_RESERVE_AHEAD <= _seq_high_water_written:
            return
        _write_seq_checkpoint_locked(seq)


def _write_seq_checkpoint_locked(seq: int) -> None:
    global _seq_high_water_written, _seq_scheduled_high_water, _seq_reservation_warned
    # Reserve ahead of the issued value - see SEQ_RESERVE_AHEAD's comment.
    reserved = seq + SEQ_RESERVE_AHEAD
    try:
        SEQ_HIGH_WATER_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Written to a temp file and atomically renamed rather than written in place. write_text
        # truncates first, so a crash or power loss mid-write can leave the checkpoint empty or
        # partial - which resolve_seq_seed treats as invalid and falls back to the wall clock,
        # silently forfeiting the durability guarantee this exists for at exactly the moment a
        # backward clock correction would need it. os.replace is atomic on POSIX, so an
        # interrupted write leaves the *previous* valid high-water mark intact.
        tmp = SEQ_HIGH_WATER_PATH.with_suffix(".tmp")
        # fsync the file before the rename and the directory after it. os.replace is atomic with
        # respect to *observers* - nobody sees a half-written file - but atomicity is not
        # durability: after a power loss the data blocks or the new directory entry may simply
        # never have reached disk, leaving the checkpoint missing or full of zeros. That degrades
        # to clock-seeding, which is exactly the case this checkpoint exists to survive.
        with open(tmp, "w") as fh:
            fh.write(str(reserved))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, SEQ_HIGH_WATER_PATH)
        dir_fd = os.open(str(SEQ_HIGH_WATER_PATH.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
        # Advanced only after the rename actually lands. Setting it up front meant a transient
        # failure silently suppressed the next SEQ_CHECKPOINT_INTERVAL retries even once /data
        # became writable again - so the last durable checkpoint could fall further behind than
        # one interval, and the `stored + INTERVAL` seed would then overlap sequence values
        # clients had already persisted.
        _seq_high_water_written = reserved
        _seq_reservation_warned = False
    except OSError:
        # Read-only or full /data - ordering degrades to the previous clock-seeded behaviour
        # rather than failing the decode over a checkpoint write. The retry baseline is advanced
        # to this attempt, NOT rolled back to the durable mark: rolling back made the very next
        # decode satisfy the interval test again (after a failure at written+100 the next seq is
        # already written+101), so a persistently failing /data had a high-rate receiver
        # submitting a fresh executor job per packet. Advancing it keeps retries to one per
        # interval, and the startup reservation above - not this write - is what guarantees no
        # sequence is ever reissued while the failure persists.
        _seq_scheduled_high_water = seq


def record_seq_high_water(loop: asyncio.AbstractEventLoop, seq: int) -> None:
    """Ensures `seq` is covered by a durable reservation before its caller broadcasts it.

    The write plus two fsyncs are normally pushed to a worker thread. on_device is called straight
    from Rtl433Decoder._read_loop, which is an asyncio task on the main loop - doing blocking file
    I/O there would stall everything else the loop is running, including the WebSocket writers and
    the HTTP API, for as long as /data takes to sync.
    """
    global _seq_scheduled_high_water, _seq_guard_last_attempt, _seq_reservation_warned
    # Hard invariant, checked first: never hand out a sequence the durable reservation does not
    # already *strictly* cover. Renewing asynchronously at the boundary was not enough - the
    # on-disk reservation is then merely equal to the value being issued, so a kill after the
    # broadcast but before the executor's fsync completes leaves that sequence observed by clients
    # yet uncovered, and a restart with a backward-adjusted clock reseeds at it and reissues it.
    # Blocking the loop here is the correct trade: it only happens if the early renewal below has
    # not landed in time, and stalling briefly is strictly better than reissuing a sequence.
    if seq >= _seq_high_water_written:
        # Throttled like the asynchronous path. When the reservation is genuinely exhausted and
        # /data is writable, the first attempt succeeds and the branch stops firing. When /data is
        # persistently unwritable the reservation cannot be renewed at all, so retrying per packet
        # buys nothing and starves the loop; this retries once per interval instead.
        #
        # The deliberate trade-off: rather than stop broadcasting (which would make the add-on
        # useless whenever /data fills), decoding continues with the ordering guarantee degraded
        # to the pre-reservation behaviour for as long as the disk is broken. That failure mode is
        # logged once so it is visible rather than silent.
        if seq - _seq_guard_last_attempt >= SEQ_CHECKPOINT_INTERVAL:
            _seq_guard_last_attempt = seq
            _write_seq_checkpoint(seq)
            if seq >= _seq_high_water_written and not _seq_reservation_warned:
                _seq_reservation_warned = True
                _LOGGER.warning(
                    "Event sequence reservation exhausted and /data is not writable - sequence "
                    "durability is degraded until the checkpoint at %s succeeds",
                    SEQ_HIGH_WATER_PATH,
                )
        _seq_scheduled_high_water = seq
        return
    # Renewed *early*, while a full interval of headroom remains, so in the normal case the write
    # completes well before the reservation is reached and the branch above never fires.
    if _seq_high_water_written - seq > SEQ_CHECKPOINT_INTERVAL:
        return
    # Tracked separately from _seq_high_water_written (which only advances on a *successful*
    # write) so a slow or failing disk can't queue an executor job per decode.
    if seq - _seq_scheduled_high_water < SEQ_CHECKPOINT_INTERVAL:
        return
    _seq_scheduled_high_water = seq
    loop.run_in_executor(None, _write_seq_checkpoint, seq)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_level = os.environ.get("LOG_LEVEL", "info").upper()
    logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    token, is_new = resolve_api_token(os.environ.get("API_TOKEN", ""))
    if is_new:
        _LOGGER.warning("Generated a new API token - configure it in the sdr_hub HACS integration: %s", token)
    else:
        _LOGGER.info("Using configured/stored API token")
    app.state.api_token = token

    loop = asyncio.get_running_loop()
    broadcaster = Broadcaster()
    app.state.broadcaster = broadcaster

    # Monotonic across restarts, not just within a run. Seeding purely from the wall clock was
    # not enough: if the clock is moved *backwards* and the add-on then restarts, the new seed
    # can land below values clients have already persisted, so every subsequent decode sorts
    # behind their existing log (and gets truncated as "old") while newer battery transitions
    # are rejected as lower-ordered - a recovery could stay hidden indefinitely. Seeding from
    # max(last issued, now) makes the sequence non-decreasing regardless of what the clock does.
    # on_device runs on the event loop (Rtl433Decoder._read_loop is an asyncio task), so the
    # counter is only ever advanced from a single thread - the durable checkpoint is what gets
    # pushed to an executor, since that is the part that would block the loop.
    event_seq = itertools.count(resolve_seq_seed())

    # One accumulator per sweep id. Dropped when the sweep is, so a restarted sweep starts a fresh
    # session rather than inheriting statistics gathered at a frequency range it no longer covers.
    sweep_stats: dict[str, SweepStats] = {}

    def on_row(sweep_id: str, row: SweepRow) -> None:
        # A capture thread can have queued this callback through call_soon_threadsafe before the
        # sweep was deleted, so it runs after delete_sweep has already forgotten the accumulator.
        # Recreating it here would resurrect state nothing will ever reach again - normal deletion
        # emits no later status event - leaking one set of per-bin arrays per delete, and would
        # broadcast a row for a sweep the panel has already removed, repopulating its history after
        # the deletion refresh. The manager is the authority on what still exists.
        manager = getattr(app.state, "manager", None)
        if manager is not None and not any(s.id == sweep_id for s in manager.list_sweeps()):
            return
        stats = sweep_stats.get(sweep_id)
        if stats is None:
            stats = sweep_stats[sweep_id] = SweepStats()
        stats.update(row.power_db)
        payload = {
            "type": "sweep_row",
            "sweep_id": sweep_id,
            "start_hz": row.start_hz,
            "bin_hz": row.bin_hz,
            "stop_hz": row.stop_hz,
            "power_db": row.power_db,
        }
        snapshot = stats.snapshot()
        # Omitted rather than sent as nulls when nothing measurable has arrived. A consumer can then
        # distinguish "no statistics yet" from "a statistic whose value is zero", which for a dB
        # figure is a real and very loud reading.
        if snapshot is not None:
            payload["stats"] = snapshot
        broadcaster.broadcast(payload)

    def forget_sweep_stats(sweep_id: str) -> None:
        sweep_stats.pop(sweep_id, None)

    def reset_sweep_stats(sweep_id: str) -> bool:
        """Clears the accumulator in place, so the next row starts a fresh session for this sweep.

        Dropped rather than reset-in-place would work equally well here - on_row recreates it - but
        an explicit reset keeps the intent legible and cannot race with a row arriving between the
        pop and the recreate.
        """
        stats = sweep_stats.get(sweep_id)
        if stats is None:
            return False
        stats.reset()
        return True

    def on_device(receiver_id: str, device: dict) -> None:
        # event_id/seq/received_at are assigned here, once, on the server - deliberately NOT left
        # to each client. Every open panel tab holds its own independent WebSocket subscription
        # and receives this same broadcast separately, so a client-generated id would differ per
        # tab for one physical decode, and any cross-tab dedup/merge built on it would treat N
        # tabs' views of one event as N distinct events. Server-assigned values are what let
        # every tab independently converge on an identical decoded-device log.
        #
        # `seq` (not received_at) is what the panel orders and merges on. A wall clock can move
        # *backwards* - an NTP correction or a manual change - which would make new events sort
        # behind already-persisted ones, so they'd be truncated away as "old" and a stale
        # low-battery entry could never be superseded by its own recovery. `seq` is strictly
        # increasing for the life of this process, so ordering can't invert. received_at is kept
        # alongside it for display/diagnostics only.
        seq = next(event_seq)
        record_seq_high_water(loop, seq)
        broadcaster.broadcast(
            {
                "type": "decoded_device",
                "event_id": uuid.uuid4().hex,
                "seq": seq,
                "received_at": time.time(),
                "receiver_id": receiver_id,
                "device": device,
            }
        )

    def on_status(kind: EntityKind, entity_id: str, status: EntityStatus, message: str | None) -> None:
        # A sweep that stopped or died is finished with its accumulator. Dropping it here covers
        # every ending, not just an explicit DELETE - an errored sweep never reaches that route, and
        # its statistics would otherwise be inherited by a later sweep reusing the id.
        if kind == EntityKind.SWEEP and status in (EntityStatus.STOPPED, EntityStatus.ERROR):
            forget_sweep_stats(entity_id)
        broadcaster.broadcast({"type": "status", "kind": kind, "id": entity_id, "status": status, "message": message})

    app.state.forget_sweep_stats = forget_sweep_stats
    app.state.reset_sweep_stats = reset_sweep_stats
    app.state.manager = DeviceManager(loop=loop, on_row=on_row, on_device=on_device, on_status=on_status)

    _LOGGER.info("sdr_hub add-on ready")
    yield
    await app.state.manager.shutdown()


app = FastAPI(
    title="SDR Hub",
    description="RTL-SDR hardware access for Home Assistant: wideband spectrum sweeps and configurable receivers.",
    # Kept in step with the `version:` field in addon/sdr_hub/config.yaml - they describe the same
    # release, and a mismatch means /openapi.json and /docs advertise a different API version than
    # the Supervisor shows for the installed add-on. Bump both together.
    version="0.2.0",
    lifespan=lifespan,
)
app.include_router(router)
