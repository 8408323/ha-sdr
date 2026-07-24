from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import SdrHubApiClient, SdrHubApiError

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(seconds=30)
_RECONNECT_DELAY_S = 5


class SdrHubCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the add-on's snapshot state and relays its live WebSocket events to listeners."""

    def __init__(self, hass: HomeAssistant, api: SdrHubApiClient) -> None:
        super().__init__(hass, _LOGGER, name="sdr_hub", update_interval=UPDATE_INTERVAL)
        self.api = api
        self._event_listeners: list[Callable[[dict[str, Any]], None]] = []
        self._stopping = False
        self._suppress_broadcast_count = 0
        # A refresh triggered by anything other than this panel's own action (a service call,
        # another open panel's WS command, or the periodic poll) otherwise has no way to reach
        # other subscribed panels - only the raw add-on WS events do. Piggyback on the
        # coordinator's own standard update-listener mechanism so every successful refresh,
        # regardless of what triggered it, notifies every sdr_hub/subscribe client too.
        self.async_add_listener(self._on_data_updated)

    @callback
    def suppress_next_broadcast(self) -> None:
        """Marks the next _on_data_updated firing as caller-initiated, so it isn't re-broadcast.

        ws_get_state forces a refresh so it can return fresh data to the one caller that asked -
        without this, that refresh's own update-listener firing would re-broadcast state_changed
        to every subscriber (including the caller), which would re-trigger _loadState() -> another
        get_state -> another forced refresh, an unbounded feedback loop (confirmed live).

        Uses a counter, not a plain boolean: two subscribed panels can react to the same
        state_changed event and both enter ws_get_state before either's async_refresh() call
        completes (async_refresh() calls aren't serialized against each other), so both call
        this and both later fire _on_data_updated. A shared boolean would be cleared by the
        first completion, leaving the second completion to broadcast unsuppressed and repeat
        the feedback loop - a counter lets each forced refresh consume exactly one suppression,
        however the calls interleave, since suppress_next_broadcast() is always called
        synchronously (no await between it and the matching async_refresh()) right before the
        refresh that will eventually consume it.
        """
        self._suppress_broadcast_count += 1

    @callback
    def _on_data_updated(self) -> None:
        if self._suppress_broadcast_count > 0:
            self._suppress_broadcast_count -= 1
            return
        self._dispatch({"type": "state_changed"})

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            devices = await self.api.async_get_devices()
            receivers = await self.api.async_get_receivers()
            sweeps = await self.api.async_get_sweeps()
        except SdrHubApiError as err:
            raise UpdateFailed(str(err)) from err
        return {"devices": devices, "receivers": receivers, "sweeps": sweeps}

    @callback
    def async_add_event_listener(self, listener: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        """Registers a callback invoked with every raw WebSocket message from the add-on."""
        self._event_listeners.append(listener)

        def remove() -> None:
            self._event_listeners.remove(listener)

        return remove

    def stop_ws(self) -> None:
        self._stopping = True

    async def ws_loop(self) -> None:
        """Long-running task (owned by the config entry) that keeps the add-on's WS stream forwarded."""
        self._stopping = False
        while not self._stopping:
            try:
                async with self.api.connect_ws() as ws:
                    _LOGGER.debug("sdr_hub WS connected")
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            self._dispatch(msg.json())
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - reconnect on any transport failure, not just expected ones
                _LOGGER.warning("sdr_hub WS connection lost, reconnecting in %ss", _RECONNECT_DELAY_S)
            if not self._stopping:
                await asyncio.sleep(_RECONNECT_DELAY_S)

    def _dispatch(self, event: dict[str, Any]) -> None:
        for listener in list(self._event_listeners):
            listener(event)
