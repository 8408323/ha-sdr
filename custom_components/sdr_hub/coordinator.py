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
