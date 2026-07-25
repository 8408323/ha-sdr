from __future__ import annotations

import asyncio
import itertools
import logging
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

_LOGGER = logging.getLogger("sdr_hub")

# Highest event `seq` handed out, persisted so the counter can be seeded above it after a
# restart. Alongside /data/api_token (see auth.py) - the add-on's existing durable-state path.
SEQ_HIGH_WATER_PATH = Path("/data/event_seq")
# Persisting on literally every decode would mean a file write per received packet. Events are
# only ever compared against *other* events, so the sequence needs to be non-decreasing, not
# gap-free - checkpointing every Nth value and seeding from (checkpoint + N) after a restart
# keeps that guarantee while writing ~1/N as often. Gaps in the sequence are harmless.
SEQ_CHECKPOINT_INTERVAL = 100
_seq_high_water_written = 0


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
    # +SEQ_CHECKPOINT_INTERVAL covers values issued since the last checkpoint but before the
    # restart, which by construction can't exceed one interval.
    return max(now_ms, stored + SEQ_CHECKPOINT_INTERVAL)


def record_seq_high_water(seq: int) -> None:
    global _seq_high_water_written
    if seq - _seq_high_water_written < SEQ_CHECKPOINT_INTERVAL:
        return
    _seq_high_water_written = seq
    try:
        SEQ_HIGH_WATER_PATH.parent.mkdir(parents=True, exist_ok=True)
        SEQ_HIGH_WATER_PATH.write_text(str(seq))
    except OSError:
        # Read-only or full /data - ordering degrades to the previous clock-seeded behaviour
        # rather than taking the decoder thread down over a checkpoint write.
        pass


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
    # next() on an itertools.count is atomic under the GIL, which matters because on_device is
    # invoked from the decoder threads rather than the event loop.
    event_seq = itertools.count(resolve_seq_seed())

    def on_row(sweep_id: str, row: SweepRow) -> None:
        broadcaster.broadcast(
            {
                "type": "sweep_row",
                "sweep_id": sweep_id,
                "start_hz": row.start_hz,
                "bin_hz": row.bin_hz,
                "power_db": row.power_db,
            }
        )

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
        record_seq_high_water(seq)
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
        broadcaster.broadcast({"type": "status", "kind": kind, "id": entity_id, "status": status, "message": message})

    app.state.manager = DeviceManager(loop=loop, on_row=on_row, on_device=on_device, on_status=on_status)

    _LOGGER.info("sdr_hub add-on ready")
    yield
    await app.state.manager.shutdown()


app = FastAPI(
    title="SDR Hub",
    description="RTL-SDR hardware access for Home Assistant: wideband spectrum sweeps and configurable receivers.",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(router)
