from __future__ import annotations

import logging

from auth import verify_token
from broadcaster import Broadcaster
from device_manager import (
    DongleBusyError,
    DongleNotFoundError,
    DuplicateDongleSerialError,
    UnsupportedReceiverDriverError,
)
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from models import DongleInfo, Receiver, ReceiverCreate, Sweep, SweepCreate
from scanner import SweepStopTimeoutError

_LOGGER = logging.getLogger("sdr_hub")

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/devices", response_model=list[DongleInfo], dependencies=[Depends(verify_token)])
async def list_devices(request: Request) -> list[DongleInfo]:
    return [DongleInfo(**d) for d in request.app.state.manager.list_dongles()]


@router.get("/receivers", response_model=list[Receiver], dependencies=[Depends(verify_token)])
async def list_receivers(request: Request) -> list[Receiver]:
    return request.app.state.manager.list_receivers()


@router.post("/receivers", response_model=Receiver, status_code=201, dependencies=[Depends(verify_token)])
async def create_receiver(cfg: ReceiverCreate, request: Request) -> Receiver:
    try:
        return await request.app.state.manager.add_receiver(cfg)
    except DongleBusyError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except DongleNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except DuplicateDongleSerialError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except UnsupportedReceiverDriverError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.delete("/receivers/{receiver_id}", status_code=204, dependencies=[Depends(verify_token)])
async def delete_receiver(receiver_id: str, request: Request) -> None:
    await request.app.state.manager.remove_receiver(receiver_id)


@router.get("/sweeps", response_model=list[Sweep], dependencies=[Depends(verify_token)])
async def list_sweeps(request: Request) -> list[Sweep]:
    return request.app.state.manager.list_sweeps()


@router.post("/sweeps", response_model=Sweep, status_code=201, dependencies=[Depends(verify_token)])
async def create_sweep(cfg: SweepCreate, request: Request) -> Sweep:
    try:
        return await request.app.state.manager.add_sweep(cfg)
    except DongleBusyError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except DongleNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except DuplicateDongleSerialError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.delete("/sweeps/{sweep_id}", status_code=204, dependencies=[Depends(verify_token)])
async def delete_sweep(sweep_id: str, request: Request) -> None:
    try:
        await request.app.state.manager.remove_sweep(sweep_id)
        # Only after the removal actually succeeded - a SweepStopTimeoutError below leaves the sweep
        # and its dongle claim in place, so its statistics are still live and must not be discarded.
        request.app.state.forget_sweep_stats(sweep_id)
    except SweepStopTimeoutError as err:
        # The sweeper thread didn't exit in time and may still hold the dongle open;
        # the sweep/claim are deliberately left in place by DeviceManager, so surface
        # this as a conflict rather than silently pretending the stop succeeded.
        raise HTTPException(status_code=409, detail=str(err)) from err


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Read-only push stream (sweep rows, decoded devices, status changes) — control is via REST.

    Requires an `Authorization: Bearer <token>` header. The only intended direct client
    is the sdr_hub HACS integration's backend (an aiohttp ClientSession, which can send
    real headers) — never a browser. The browser-facing navbar panel instead talks to
    Home Assistant's own authenticated websocket_api, and the integration relays add-on
    events onto it (see the separate sdr_hub integration PR); this add-on-only endpoint
    doesn't need to accommodate header-less browser WebSocket connections.
    """
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
