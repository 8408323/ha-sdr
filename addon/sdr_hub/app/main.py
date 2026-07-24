from __future__ import annotations

import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from device_manager import DeviceManager, DongleBusyError, DongleNotFoundError
from models import DongleInfo, Receiver, ReceiverCreate, Sweep, SweepCreate
from scanner import SweepRow

_LOGGER = logging.getLogger("sdr_hub")
DATA_TOKEN_PATH = Path("/data/api_token")
security = HTTPBearer()


def resolve_api_token(configured: str) -> tuple[str, bool]:
    """Returns (token, freshly_generated). A configured token always wins over a stored one."""
    configured = (configured or "").strip()
    if configured:
        return configured, False
    if DATA_TOKEN_PATH.exists():
        return DATA_TOKEN_PATH.read_text().strip(), False
    token = secrets.token_hex(32)
    DATA_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_TOKEN_PATH.write_text(token)
    DATA_TOKEN_PATH.chmod(0o600)
    return token, True


class Broadcaster:
    """Fans out messages to every connected WebSocket client; drops clients that fail to send."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    def add(self, ws: WebSocket) -> None:
        self._clients.add(ws)

    def discard(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    def broadcast(self, message: dict) -> None:
        for ws in list(self._clients):
            asyncio.create_task(self._safe_send(ws, message))

    async def _safe_send(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001 - a broken client shouldn't affect others
            self._clients.discard(ws)


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
        broadcaster.broadcast({"type": "decoded_device", "receiver_id": receiver_id, "device": device})

    def on_status(kind: str, entity_id: str, status: str, message: str | None) -> None:
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


async def verify_token(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)) -> None:
    if credentials.credentials != request.app.state.api_token:
        raise HTTPException(status_code=401, detail="invalid token")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/devices", response_model=list[DongleInfo], dependencies=[Depends(verify_token)])
async def list_devices(request: Request) -> list[DongleInfo]:
    return [DongleInfo(**d) for d in request.app.state.manager.list_dongles()]


@app.get("/receivers", response_model=list[Receiver], dependencies=[Depends(verify_token)])
async def list_receivers(request: Request) -> list[Receiver]:
    return request.app.state.manager.list_receivers()


@app.post("/receivers", response_model=Receiver, status_code=201, dependencies=[Depends(verify_token)])
async def create_receiver(cfg: ReceiverCreate, request: Request) -> Receiver:
    try:
        return await request.app.state.manager.add_receiver(cfg)
    except DongleBusyError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except DongleNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err


@app.delete("/receivers/{receiver_id}", status_code=204, dependencies=[Depends(verify_token)])
async def delete_receiver(receiver_id: str, request: Request) -> None:
    await request.app.state.manager.remove_receiver(receiver_id)


@app.get("/sweeps", response_model=list[Sweep], dependencies=[Depends(verify_token)])
async def list_sweeps(request: Request) -> list[Sweep]:
    return request.app.state.manager.list_sweeps()


@app.post("/sweeps", response_model=Sweep, status_code=201, dependencies=[Depends(verify_token)])
async def create_sweep(cfg: SweepCreate, request: Request) -> Sweep:
    try:
        return await request.app.state.manager.add_sweep(cfg)
    except DongleBusyError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except DongleNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err


@app.delete("/sweeps/{sweep_id}", status_code=204, dependencies=[Depends(verify_token)])
async def delete_sweep(sweep_id: str, request: Request) -> None:
    await request.app.state.manager.remove_sweep(sweep_id)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Read-only push stream (sweep rows, decoded devices, status changes) — control is via REST."""
    if websocket.headers.get("authorization") != f"Bearer {websocket.app.state.api_token}":
        await websocket.close(code=1008)
        return
    await websocket.accept()
    broadcaster: Broadcaster = websocket.app.state.broadcaster
    broadcaster.add(websocket)
    _LOGGER.info("WS client connected")
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        broadcaster.discard(websocket)
        _LOGGER.info("WS client disconnected")
