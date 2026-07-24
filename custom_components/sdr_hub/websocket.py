"""WebSocket API bridging the frontend panel to the sdr_hub add-on, without exposing its token.

Read-only commands (get_state, subscribe) are open to any authenticated user so a non-admin
dashboard can still view the live waterfall/decoded devices; commands that change hardware
config (add/remove receiver or sweep) require admin.
"""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .api import SdrHubApiError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _coordinator(hass: HomeAssistant):
    entries = hass.config_entries.async_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/get_state"})
@websocket_api.async_response
async def ws_get_state(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    # The panel calls this to reload authoritative state after a "status" event (e.g. a
    # receiver/sweep died) — the coordinator's cache is only refreshed on its own 30s poll
    # interval otherwise, so without this the panel could show stale devices/receivers/sweeps
    # for up to 30s after a change.
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], coordinator.data or {"devices": [], "receivers": [], "sweeps": []})


@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/subscribe"})
@websocket_api.async_response
async def ws_subscribe(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return

    @callback
    def forward(event: dict) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], event))

    connection.subscriptions[msg["id"]] = coordinator.async_add_event_listener(forward)
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "sdr_hub/add_receiver",
        vol.Required("dongle_serial"): str,
        vol.Required("frequencies_hz"): [vol.Coerce(float)],
        vol.Optional("protocols", default=[]): [int],
        vol.Optional("hop_interval_s", default=10): int,
    }
)
@websocket_api.async_response
async def ws_add_receiver(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    config = {k: v for k, v in msg.items() if k not in ("id", "type")}
    try:
        receiver = await coordinator.api.async_add_receiver(config)
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "add_receiver_failed", err.detail)
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], receiver)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/remove_receiver", vol.Required("receiver_id"): str})
@websocket_api.async_response
async def ws_remove_receiver(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        await coordinator.api.async_remove_receiver(msg["receiver_id"])
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "remove_receiver_failed", err.detail)
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "sdr_hub/add_sweep",
        vol.Required("dongle_serial"): str,
        vol.Required("start_hz"): vol.Coerce(float),
        vol.Required("stop_hz"): vol.Coerce(float),
        vol.Optional("sample_rate", default=2.4e6): vol.Coerce(float),
        vol.Optional("gain", default=30.0): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_add_sweep(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    config = {k: v for k, v in msg.items() if k not in ("id", "type")}
    try:
        sweep = await coordinator.api.async_add_sweep(config)
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "add_sweep_failed", err.detail)
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], sweep)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/remove_sweep", vol.Required("sweep_id"): str})
@websocket_api.async_response
async def ws_remove_sweep(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        await coordinator.api.async_remove_sweep(msg["sweep_id"])
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "remove_sweep_failed", err.detail)
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"])


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_add_receiver)
    websocket_api.async_register_command(hass, ws_remove_receiver)
    websocket_api.async_register_command(hass, ws_add_sweep)
    websocket_api.async_register_command(hass, ws_remove_sweep)
