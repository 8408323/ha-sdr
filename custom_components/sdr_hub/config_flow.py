"""Config flow for the SDR Hub integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT

from .api import SdrHubApiClient, SdrHubApiError
from .const import CONF_API_TOKEN, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Required(CONF_API_TOKEN): str,
    }
)


class SdrHubConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle setup by asking for the sdr_hub add-on's host/port/token."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            api = SdrHubApiClient(
                self.hass, user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_API_TOKEN]
            )
            try:
                # /devices requires auth, unlike /health — this validates both reachability and the token.
                await api.async_get_devices()
            except SdrHubApiError as err:
                errors["base"] = "invalid_auth" if err.status == 401 else "cannot_connect"
            except Exception:  # noqa: BLE001 - any transport failure means "can't reach it"
                _LOGGER.debug("sdr_hub add-on unreachable", exc_info=True)
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="SDR Hub", data=user_input)
        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors)
