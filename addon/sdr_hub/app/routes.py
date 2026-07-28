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
from models import DiscoveryCreate, DongleInfo, Receiver, ReceiverCreate, Sweep, SweepCreate
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


@router.get("/discoveries", dependencies=[Depends(verify_token)])
async def list_discoveries(request: Request) -> list[dict]:
    return request.app.state.manager.list_discoveries()


@router.post("/discoveries", status_code=201, dependencies=[Depends(verify_token)])
async def start_discovery(payload: DiscoveryCreate, request: Request) -> dict:
    """Starts a time-boxed listen. Creates no entity - see discovery.py for why that is the point."""
    try:
        run = await request.app.state.manager.start_discovery(payload)
    except DongleBusyError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except DongleNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except DuplicateDongleSerialError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except UnsupportedReceiverDriverError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return run.snapshot()


@router.post("/discoveries/{discovery_id}/stop", dependencies=[Depends(verify_token)])
async def stop_discovery(discovery_id: str, request: Request) -> dict:
    """Ends a run early but keeps its result - distinct from DELETE, which discards it.

    Two verbs because the two intentions genuinely differ: "I have seen enough, show me what you
    heard" is the common one, and collapsing it into DELETE would throw away the result at the
    exact moment the user asked to look at it.
    """
    manager = request.app.state.manager
    if not await manager.stop_discovery(discovery_id):
        raise HTTPException(status_code=404, detail=f"no discovery with id {discovery_id}")
    run = manager.get_discovery(discovery_id)
    return run.snapshot()


@router.delete("/discoveries/{discovery_id}", status_code=204, dependencies=[Depends(verify_token)])
async def forget_discovery(discovery_id: str, request: Request) -> None:
    """Stops the run if it is still going, then discards the result."""
    if not await request.app.state.manager.forget_discovery(discovery_id):
        raise HTTPException(status_code=404, detail=f"no discovery with id {discovery_id}")


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


@router.post("/sweeps/{sweep_id}/reset_stats", status_code=204, dependencies=[Depends(verify_token)])
async def reset_sweep_stats(sweep_id: str, request: Request) -> None:
    """Discards a sweep's accumulated statistics without disturbing the sweep itself.

    The peak hold, the running mean and the occupancy derived from them are one accumulator, so
    "reset peak hold" has to reach it. Resetting only the panel's local copy left the plot and the
    occupancy readout beside it disagreeing about the same band - and left the published entities,
    which an automation reads, still counting a carrier the user had explicitly forgotten.
    """
    if not request.app.state.reset_sweep_stats(sweep_id):
        # 404 rather than a silent 204. A sweep that has errored had its accumulator discarded
        # already and will emit no further rows, so there is no boundary for the panel to observe -
        # and the panel deliberately waits for that boundary before clearing. Reporting success for
        # a reset that cannot happen left the button doing nothing at all, with nothing to say so.
        # 409, not 404. A 404 from this route must mean one thing only - "this add-on has no such
        # endpoint" - so an integration talking to an older add-on can recognise the mixed-version
        # case without parsing error text. "The sweep has no live accumulator" is a conflict with
        # current state, which is what 409 says.
        raise HTTPException(status_code=409, detail=f"No live statistics for sweep {sweep_id}")


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
