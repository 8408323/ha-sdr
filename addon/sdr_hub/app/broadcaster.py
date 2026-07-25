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
        # Set for a client whenever broadcast() had to drop a message for it (queue full).
        # A dropped message could be anything, including a state transition a consumer treats
        # as authoritative until told otherwise (e.g. the frontend's low-battery tracking, which
        # only clears an alert on an explicit battery_ok:true event) - if that exact message is
        # the one dropped, the consumer would otherwise never find out and could show stale
        # state indefinitely. _writer_loop checks this before its next send and, if set,
        # notifies the client a gap happened so it can invalidate/resync anything it derived
        # purely from the event stream, instead of silently continuing as if nothing was lost.
        self._gap_pending: dict[WebSocket, bool] = {}

    def add(self, ws: WebSocket) -> None:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._queue_maxsize)
        self._queues[ws] = queue
        self._gap_pending[ws] = False
        self._writers[ws] = asyncio.create_task(self._writer_loop(ws, queue))

    def discard(self, ws: WebSocket) -> None:
        self._queues.pop(ws, None)
        self._gap_pending.pop(ws, None)
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
                else:
                    self._gap_pending[ws] = True
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Lost the race with another producer for the freed slot; drop it too.
                self._gap_pending[ws] = True

    async def _writer_loop(self, ws: WebSocket, queue: asyncio.Queue) -> None:
        try:
            while True:
                message = await queue.get()
                if self._gap_pending.get(ws):
                    # Send the gap notice ahead of the queued message it displaced, not through
                    # the (already full, that's how we got here) queue itself - a client that
                    # sees this before the next real message knows any event-derived state it's
                    # been building up may now be incomplete.
                    self._gap_pending[ws] = False
                    await ws.send_json({"type": "stream_gap"})
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
            self._gap_pending.pop(ws, None)
