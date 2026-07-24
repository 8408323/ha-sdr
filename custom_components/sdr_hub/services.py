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
        vol.Required("frequencies_hz"): [vol.Coerce(float)],
        vol.Optional("protocols", default=[]): [int],
        vol.Optional("hop_interval_s", default=10): int,
    }
)
_REMOVE_RECEIVER_SCHEMA = vol.Schema({vol.Required("receiver_id"): str})
_ADD_SWEEP_SCHEMA = vol.Schema(
    {
        vol.Required("dongle_serial"): str,
        vol.Required("start_hz"): vol.Coerce(float),
        vol.Required("stop_hz"): vol.Coerce(float),
        vol.Optional("sample_rate", default=2.4e6): vol.Coerce(float),
        vol.Optional("gain", default=30.0): vol.Coerce(float),
    }
)
_REMOVE_SWEEP_SCHEMA = vol.Schema({vol.Required("sweep_id"): str})


def async_register(hass: HomeAssistant) -> None:
    """Registers the sdr_hub services (idempotent — hass-global, not per config entry)."""
    if hass.services.has_service(DOMAIN, SERVICE_ADD_RECEIVER):
        return

    def _current_api():
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
        return entry.runtime_data.api

    async def _async_handle_add_receiver(call: ServiceCall) -> None:
        try:
            await _current_api().async_add_receiver(dict(call.data))
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err

    async def _async_handle_remove_receiver(call: ServiceCall) -> None:
        try:
            await _current_api().async_remove_receiver(call.data["receiver_id"])
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err

    async def _async_handle_add_sweep(call: ServiceCall) -> None:
        try:
            await _current_api().async_add_sweep(dict(call.data))
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err

    async def _async_handle_remove_sweep(call: ServiceCall) -> None:
        try:
            await _current_api().async_remove_sweep(call.data["sweep_id"])
        except SdrHubApiError as err:
            raise HomeAssistantError(str(err)) from err

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
