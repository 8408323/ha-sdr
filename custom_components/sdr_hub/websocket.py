"""WebSocket API bridging the frontend panel to the sdr_hub add-on, without exposing its token.

Read-only commands (get_state, subscribe) are open to any authenticated user so a non-admin
dashboard can still view the live waterfall/decoded devices; commands that change hardware
config (add/remove receiver or sweep) require admin.
"""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback

from .api import SdrHubApiError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _coordinator(hass: HomeAssistant):
    # async_entries() returns entries regardless of load state, and a disabled/unloaded
    # entry has no runtime_data — checking both avoids an AttributeError in place of the
    # clean "not_loaded" response every caller here already handles.
    entry = next(
        (e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED),
        None,
    )
    if entry is None or not hasattr(entry, "runtime_data"):
        return None
    return entry.runtime_data


@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/get_state"})
@websocket_api.async_response
async def ws_get_state(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    # The panel calls this to reload authoritative state after a "status" event (e.g. a
    # receiver/sweep died) — the coordinator's cache is only refreshed on its own 30s poll
    # interval otherwise. Uses async_refresh() (not the debounced async_request_refresh())
    # since a status event can arrive within another recent refresh's debounce cooldown
    # (e.g. right after a mutating command), where the debounced call would be coalesced
    # away and this would still serve pre-event stale data.
    # Suppress the update-listener's broadcast for this specific refresh: the caller already
    # gets the fresh data directly as this RPC's result below, so it doesn't also need a
    # redundant state_changed push - without suppressing it, that push would reach this same
    # caller, re-trigger its _loadState() -> another get_state -> another forced refresh, an
    # unbounded feedback loop (confirmed live). Genuine external changes (the coordinator's
    # own poll, or another client's async_request_refresh()) are unaffected and still broadcast.
    previously_failing = not coordinator.last_update_success
    coordinator.suppress_next_broadcast()
    await coordinator.async_refresh()
    if previously_failing and not coordinator.last_update_success:
        # A repeated (non-recovering) failure - the coordinator's own _async_refresh() skips
        # notifying update listeners entirely in this case, so the suppression just added above
        # will never be consumed by _on_data_updated. Undo it now or it leaks, silently
        # swallowing the next genuine state_changed broadcast once the add-on recovers.
        coordinator.cancel_pending_suppression()
    if not coordinator.last_update_success:
        # async_refresh() records a failure on the coordinator but does not raise, so without
        # this check a genuinely unreachable add-on would still return the previous (now stale)
        # cached snapshot as if it were a successful, authoritative get_state response - the
        # panel's failure path never runs and it keeps rendering stale devices/receivers/sweeps
        # as though nothing were wrong. Report the failure explicitly instead.
        connection.send_error(
            msg["id"], "refresh_failed", str(coordinator.last_exception or "SDR Hub add-on is unreachable")
        )
        return
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
        # decode.py passes this straight through to rtl_433's -H <seconds> hop interval - a
        # zero or negative value would be accepted here and only surface as rtl_433 misbehaving
        # after the dongle's already claimed, instead of a clear validation error up front.
        vol.Optional("hop_interval_s", default=10): vol.All(int, vol.Range(min=0, min_included=False)),
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
    # async_refresh() (not the debounced async_request_refresh()) - if a second panel
    # action lands during another recent mutation's debounce cooldown, async_request_refresh()
    # here would just queue a delayed refresh and return; this handler's own immediate
    # get_state-driven async_refresh() calls elsewhere would then cancel that queued refresh
    # and (via suppress_next_broadcast()) swallow its state_changed broadcast too, so other
    # open panels would never learn about this change until the next 30s poll.
    await coordinator.async_refresh()
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
    await coordinator.async_refresh()  # not the debounced async_request_refresh() - see ws_add_receiver above
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
    await coordinator.async_refresh()  # not the debounced async_request_refresh() - see ws_add_receiver above
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
    await coordinator.async_refresh()  # not the debounced async_request_refresh() - see ws_add_receiver above
    connection.send_result(msg["id"])


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_add_receiver)
    websocket_api.async_register_command(hass, ws_remove_receiver)
    websocket_api.async_register_command(hass, ws_add_sweep)
    websocket_api.async_register_command(hass, ws_remove_sweep)
