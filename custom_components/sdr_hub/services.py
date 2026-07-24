"""Services proxying to the sdr_hub add-on — the public API surface other integrations/automations use."""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.service import async_register_admin_service

from .api import SdrHubApiError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SERVICE_ADD_RECEIVER = "add_receiver"
SERVICE_REMOVE_RECEIVER = "remove_receiver"
SERVICE_ADD_SWEEP = "add_sweep"
SERVICE_REMOVE_SWEEP = "remove_sweep"

_ADD_RECEIVER_SCHEMA = vol.Schema(
    {
        vol.Required("dongle_serial"): str,
        # See addon/sdr_hub/app/models.py's ReceiverCreate.dongle_driver - optional
        # disambiguator, only needed when dongle_serial alone matches more than one attached
        # device (different SoapySDR drivers, or both omitting a serial).
        vol.Optional("dongle_driver"): vol.Any(str, None),
        vol.Required("frequencies_hz"): [vol.Coerce(float)],
        vol.Optional("protocols", default=[]): [int],
        # Same rationale as websocket.py's identical field: decode.py passes this straight
        # through to rtl_433's -H <seconds> hop interval, so a non-positive value should fail
        # validation here rather than surface as rtl_433 misbehaving after the fact.
        vol.Optional("hop_interval_s", default=10): vol.All(int, vol.Range(min=0, min_included=False)),
    }
)
_REMOVE_RECEIVER_SCHEMA = vol.Schema({vol.Required("receiver_id"): str})
_ADD_SWEEP_SCHEMA = vol.Schema(
    {
        vol.Required("dongle_serial"): str,
        # See _ADD_RECEIVER_SCHEMA's dongle_driver above - same optional disambiguator.
        vol.Optional("dongle_driver"): vol.Any(str, None),
        vol.Required("start_hz"): vol.Coerce(float),
        vol.Required("stop_hz"): vol.Coerce(float),
        # min_included=False rejects 0 too, not just negatives - a zero sample rate divides by
        # zero deriving the FFT bin width in the scanner. This only gives a fast, clear error at
        # the HA service boundary; addon/sdr_hub/app/models.py's SweepCreate is the actual
        # source of truth enforcing this for every caller (panel WS commands included).
        vol.Optional("sample_rate", default=2.4e6): vol.All(vol.Coerce(float), vol.Range(min=0, min_included=False)),
        vol.Optional("gain", default=30.0): vol.Coerce(float),
    }
)
_REMOVE_SWEEP_SCHEMA = vol.Schema({vol.Required("sweep_id"): str})


def async_register(hass: HomeAssistant) -> None:
    """Registers the sdr_hub services (idempotent — hass-global, not per config entry)."""
    if hass.services.has_service(DOMAIN, SERVICE_ADD_RECEIVER):
        return

    def _current_coordinator():
        # async_entries() returns entries regardless of load state, and this integration
        # never unregisters these services on unload — a stale/unloaded entry has no
        # runtime_data, so both must be checked or a disabled/unloaded config entry turns
        # into an AttributeError instead of a clean user-facing message.
        entry = next(
            (e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED),
            None,
        )
        if entry is None or not hasattr(entry, "runtime_data"):
            raise HomeAssistantError("SDR Hub is not loaded")
        return entry.runtime_data

    # A service call is a mutation from outside the panel's own WebSocket commands (which
    # already refresh after a change) — an automation calling these otherwise leaves the
    # status sensor and any open panel showing pre-change state until the next 30s poll or
    # an unrelated status event. async_refresh() (not the debounced async_request_refresh())
    # so it isn't coalesced away by a recent unrelated refresh.

    async def _async_handle_add_receiver(call: ServiceCall) -> None:
        coordinator = _current_coordinator()
        try:
            await coordinator.api.async_add_receiver(dict(call.data))
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_refresh()

    async def _async_handle_remove_receiver(call: ServiceCall) -> None:
        coordinator = _current_coordinator()
        try:
            await coordinator.api.async_remove_receiver(call.data["receiver_id"])
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_refresh()

    async def _async_handle_add_sweep(call: ServiceCall) -> None:
        coordinator = _current_coordinator()
        try:
            await coordinator.api.async_add_sweep(dict(call.data))
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_refresh()

    async def _async_handle_remove_sweep(call: ServiceCall) -> None:
        coordinator = _current_coordinator()
        try:
            await coordinator.api.async_remove_sweep(call.data["sweep_id"])
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err
        await coordinator.async_refresh()

    # These mutate hardware config (start/stop a sweep or receiver) — same admin-only bar as
    # the equivalent sdr_hub/* WebSocket commands the panel uses; a plain async_register would
    # let any authenticated non-admin call them directly via call_service.
    async_register_admin_service(hass, DOMAIN, SERVICE_ADD_RECEIVER, _async_handle_add_receiver, schema=_ADD_RECEIVER_SCHEMA)
    async_register_admin_service(
        hass, DOMAIN, SERVICE_REMOVE_RECEIVER, _async_handle_remove_receiver, schema=_REMOVE_RECEIVER_SCHEMA
    )
    async_register_admin_service(hass, DOMAIN, SERVICE_ADD_SWEEP, _async_handle_add_sweep, schema=_ADD_SWEEP_SCHEMA)
    async_register_admin_service(
        hass, DOMAIN, SERVICE_REMOVE_SWEEP, _async_handle_remove_sweep, schema=_REMOVE_SWEEP_SCHEMA
    )
