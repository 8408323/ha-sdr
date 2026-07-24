"""The SDR Hub integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant

from . import panel, services, websocket
from .api import SdrHubApiClient
from .const import CONF_API_TOKEN
from .coordinator import SdrHubCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]

type SdrHubConfigEntry = ConfigEntry[SdrHubCoordinator]

_WS_REGISTERED = "sdr_hub_ws_registered"


async def async_setup_entry(hass: HomeAssistant, entry: SdrHubConfigEntry) -> bool:
    api = SdrHubApiClient(hass, entry.data[CONF_HOST], entry.data[CONF_PORT], entry.data[CONF_API_TOKEN])
    # async_config_entry_first_refresh() below is only supported for a coordinator constructed
    # with its owning config entry - without this, current HA logs a deprecation warning and a
    # near-future HA version raises ConfigEntryError instead, failing setup before the panel,
    # services, or sensor can load.
    coordinator = SdrHubCoordinator(hass, api, entry)
    entry.runtime_data = coordinator

    await coordinator.async_config_entry_first_refresh()

    entry.async_create_background_task(hass, coordinator.ws_loop(), "sdr_hub-ws")
    entry.async_on_unload(coordinator.stop_ws)

    # The dashboard is optional (e.g. another panel already owns the url path) — never fail
    # setup over it, the sensor/services still work without it.
    try:
        await panel.async_register_panel(hass)
    except Exception:  # noqa: BLE001
        _LOGGER.warning("SDR Hub dashboard panel could not be registered; continuing without it", exc_info=True)
    entry.async_on_unload(lambda: panel.async_unregister_panel(hass))

    services.async_register(hass)
    if not hass.data.get(_WS_REGISTERED):
        websocket.async_register(hass)
        hass.data[_WS_REGISTERED] = True

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SdrHubConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
