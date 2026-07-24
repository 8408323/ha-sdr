from __future__ import annotations

import asyncio
import logging

from constants import WS_SEND_QUEUE_MAXSIZE
from fastapi import WebSocket

_LOGGER = logging.getLogger(__name__)


class Broadcaster:
    """Fans out messages to every connected WebSocket client.

    Each client gets its own bounded queue and a single dedicated writer task that
    drains it in order. This guarantees at most one send_json() in flight per
    connection at a time - aiohttp/Starlette's WebSocket does not support concurrent
    writes on the same connection, and during an active sweep multiple sweep_row
    messages per second could otherwise overlap for a slow client. broadcast() never
    blocks: if a client's queue is full, the oldest pending message is dropped so a
    slow consumer applies backpressure instead of growing memory unboundedly.
    """

    def __init__(self, queue_maxsize: int = WS_SEND_QUEUE_MAXSIZE) -> None:
        self._queue_maxsize = queue_maxsize
        self._queues: dict[WebSocket, asyncio.Queue] = {}
        self._writers: dict[WebSocket, asyncio.Task] = {}

    def add(self, ws: WebSocket) -> None:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._queue_maxsize)
        self._queues[ws] = queue
        self._writers[ws] = asyncio.create_task(self._writer_loop(ws, queue))

    def discard(self, ws: WebSocket) -> None:
        self._queues.pop(ws, None)
        writer = self._writers.pop(ws, None)
        if writer is not None:
            writer.cancel()

    def broadcast(self, message: dict) -> None:
        for ws, queue in list(self._queues.items()):
            if queue.full():
                try:
                    queue.get_nowait()  # drop oldest to bound memory under backpressure
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass  # lost the race with another producer for the freed slot; drop it too

    async def _writer_loop(self, ws: WebSocket, queue: asyncio.Queue) -> None:
        try:
            while True:
                message = await queue.get()
                await ws.send_json(message)
        except Exception:  # noqa: BLE001 - a broken client shouldn't affect others
            # Visible by default (not debug-only): a send failure here means this client
            # silently stops receiving all further data with no other signal anywhere -
            # e.g. an oversized message being rejected previously surfaced only as a
            # client stuck in a connect/disconnect loop with nothing to explain why.
            _LOGGER.warning("WS writer failed, dropping client", exc_info=True)
        finally:
            # Self-cleanup on send failure/cancellation; harmless if discard() already
            # removed these entries (e.g. it triggered this task's cancellation).
            self._queues.pop(ws, None)
            self._writers.pop(ws, None)
