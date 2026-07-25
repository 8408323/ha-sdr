from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager

from auth import resolve_api_token
from broadcaster import Broadcaster
from device_manager import DeviceManager
from fastapi import FastAPI
from models import EntityKind, EntityStatus
from routes import router
from scanner import SweepRow

_LOGGER = logging.getLogger("sdr_hub")


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
        # event_id/received_at are assigned here, once, on the server - deliberately NOT left to
        # each client. Every open panel tab holds its own independent WebSocket subscription and
        # receives this same broadcast separately, so a client-generated id would differ per tab
        # for one physical decode, and any cross-tab dedup/merge built on it would treat N tabs'
        # views of one event as N distinct events. A single server-assigned id (and a single
        # server timestamp, so ordering doesn't depend on per-tab arrival jitter either) is what
        # lets every tab independently converge on an identical decoded-device log.
        broadcaster.broadcast(
            {
                "type": "decoded_device",
                "event_id": uuid.uuid4().hex,
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
