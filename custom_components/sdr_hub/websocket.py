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
from .coordinator import sanitize_discovery_snapshot
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
    # session_id rides along with the state snapshot so the panel can detect a Home Assistant
    # restart (a new coordinator instance) as distinct from its own socket dropping - see
    # SdrHubCoordinator.session_id.
    connection.send_result(
        msg["id"],
        {**(coordinator.data or {"devices": [], "receivers": [], "sweeps": []}), "session_id": coordinator.session_id},
    )


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
        # See addon/sdr_hub/app/models.py's ReceiverCreate.dongle_driver - optional
        # disambiguator, only needed when dongle_serial alone matches more than one attached
        # device. The panel always sends the driver of whichever device it displayed.
        vol.Optional("dongle_driver"): vol.Any(str, None),
        # Purely cosmetic friendly name - see addon/sdr_hub/app/models.py's ReceiverCreate.label.
        vol.Optional("label"): vol.Any(str, None),
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


# Admin-gated like every other command that touches the dongle. A discovery claims the device for
# its whole duration, so a non-admin able to start one could block every sweep and receiver on it -
# the same exposure as being able to start a receiver, and gated the same way.
@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "sdr_hub/start_discovery",
        vol.Required("dongle_serial"): str,
        # See ws_add_receiver - same optional disambiguator, same reasoning.
        vol.Optional("dongle_driver"): vol.Any(str, None),
        vol.Required("frequencies_hz"): [vol.Coerce(float)],
        vol.Optional("protocols", default=[]): [int],
        vol.Optional("hop_interval_s", default=10): vol.All(int, vol.Range(min=0, min_included=False)),
        # Bounds duplicated from the add-on's DiscoveryCreate rather than left to it. The add-on
        # would reject an out-of-range value anyway, but only after the panel had been told the
        # request was accepted here - and a range error is exactly the kind a user should see
        # against the control they typed it into.
        vol.Optional("duration_s", default=90): vol.All(int, vol.Range(min=10, max=43200)),
        # Optional tuning overrides. vol.Any(..., None) rather than a default, because "absent"
        # has to survive the round trip: the add-on omits the rtl_433 flag entirely when it is
        # None, and no numeric default reproduces automatic gain or a decoder-chosen sample rate.
        vol.Optional("gain_db"): vol.Any(vol.All(vol.Coerce(float), vol.Range(min=0, max=50)), None),
        vol.Optional("sample_rate_hz"): vol.Any(
            vol.All(vol.Coerce(float), vol.Range(min=200000, max=3200000)), None
        ),
    }
)
@websocket_api.async_response
async def ws_start_discovery(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    # None-valued optional keys are dropped rather than forwarded. Sending "gain_db": null would
    # be rejected by the add-on's float field, and it means the same thing as not sending it - so
    # the panel can leave an advanced control blank without special-casing every field.
    config = {k: v for k, v in msg.items() if k not in ("id", "type") and v is not None}
    try:
        run = await coordinator.api.async_start_discovery(config)
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "start_discovery_failed", err.detail)
        return
    # A discovery does change the polled snapshot, even though it is not itself part of it: the
    # add-on's /devices response now reports this dongle's in_use_by as the discovery id. Without
    # this refresh every other panel keeps showing the device as free until the next 30 s poll,
    # and an action taken from that stale display gets an unexplained 409.
    await coordinator.async_refresh()  # not the debounced variant - see ws_add_receiver
    connection.send_result(msg["id"], run)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "sdr_hub/stop_discovery", vol.Required("discovery_id"): str}
)
@websocket_api.async_response
async def ws_stop_discovery(hass: HomeAssistant, connection, msg) -> None:
    """Ends a run early and returns what it heard - distinct from forget, which discards it."""
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        run = await coordinator.api.async_stop_discovery(msg["discovery_id"])
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "stop_discovery_failed", err.detail)
        return
    # Stopping frees the dongle, so the same ownership reasoning as starting applies in reverse.
    await coordinator.async_refresh()
    connection.send_result(msg["id"], sanitize_discovery_snapshot(run) if isinstance(run, dict) else run)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "sdr_hub/forget_discovery", vol.Required("discovery_id"): str}
)
@websocket_api.async_response
async def ws_forget_discovery(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        await coordinator.api.async_forget_discovery(msg["discovery_id"])
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "forget_discovery_failed", err.detail)
        return
    # Dismissing a run that is still going stops it, which frees the dongle - so this changes
    # device ownership exactly as start and stop do. Missing it left every panel showing the
    # device as claimed by a discovery that no longer exists, with nothing to correct it before
    # the next 30 s poll.
    await coordinator.async_refresh()
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/list_discoveries"})
@websocket_api.async_response
async def ws_list_discoveries(hass: HomeAssistant, connection, msg) -> None:
    """Read-only, so not admin-gated - it reports what was heard and changes nothing.

    Needed because discovery results are not part of the polled snapshot: a panel that opens
    after a run finished has no other way to learn it happened, and the result is exactly what a
    user comes back to look at.
    """
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        runs = await coordinator.api.async_get_discoveries()
    except SdrHubApiError as err:
        connection.send_error(msg["id"], "list_discoveries_failed", err.detail)
        return
    # Sanitized exactly as the streamed events are. These snapshots arrive by a different route
    # but carry the same sampled rtl_433 fields, and websocket_api rejects the *whole* result over
    # one unrepresentable number - so an unguarded list would make every retained run disappear
    # for a reopening panel, which is the failure the guard was added for in the first place.
    connection.send_result(
        msg["id"], [sanitize_discovery_snapshot(r) if isinstance(r, dict) else r for r in runs]
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "sdr_hub/add_sweep",
        vol.Required("dongle_serial"): str,
        # See ws_add_receiver's dongle_driver above - same optional disambiguator.
        vol.Optional("dongle_driver"): vol.Any(str, None),
        # See ws_add_receiver's label above - same purely-cosmetic friendly name.
        vol.Optional("label"): vol.Any(str, None),
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


# require_admin, like every other command that mutates add-on state. The panel's reset used to be
# local to one tab; now it clears an accumulator shared by every viewer and moves the HA sensor
# values automations consume, so a dashboard viewer must not be able to alter measurements for
# everyone. Widening what a command does without revisiting who may call it is how an authorization
# boundary silently moves.
@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "sdr_hub/reset_sweep_stats", vol.Required("sweep_id"): str})
@websocket_api.async_response
async def ws_reset_sweep_stats(hass: HomeAssistant, connection, msg) -> None:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "SDR Hub is not loaded")
        return
    try:
        await coordinator.api.async_reset_sweep_stats(msg["sweep_id"])
    except SdrHubApiError as err:
        # A 404 here means the add-on has no such route - the integration has been upgraded ahead
        # of it. That is the one failure the panel may answer by clearing locally, and it needs a
        # code of its own: the browser-facing command exists, so HA never reports "unknown command"
        # and the panel could not otherwise tell this apart from a refusal or a real error.
        code = "unsupported_by_addon" if err.status == 404 else "reset_sweep_stats_failed"
        connection.send_error(msg["id"], code, err.detail)
        return
    # No async_refresh: this changes no sweep the snapshot describes, only the accumulator behind
    # the statistics, and the next row carries the reset values on the stream anyway.
    connection.send_result(msg["id"])


def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_add_receiver)
    websocket_api.async_register_command(hass, ws_remove_receiver)
    websocket_api.async_register_command(hass, ws_add_sweep)
    websocket_api.async_register_command(hass, ws_remove_sweep)
    websocket_api.async_register_command(hass, ws_reset_sweep_stats)
    websocket_api.async_register_command(hass, ws_start_discovery)
    websocket_api.async_register_command(hass, ws_stop_discovery)
    websocket_api.async_register_command(hass, ws_forget_discovery)
    websocket_api.async_register_command(hass, ws_list_discoveries)
