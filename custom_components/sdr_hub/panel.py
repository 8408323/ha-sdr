"""SDR Hub dashboard: a custom Home Assistant sidebar panel served from frontend/panel.js."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PANEL_URL_PATH = "sdr-hub"
PANEL_STATIC_URL = "/sdr_hub_dashboard"
PANEL_MODULE_URL = f"{PANEL_STATIC_URL}/panel.js"
PANEL_TITLE = "SDR Hub"
PANEL_ICON = "mdi:radio-tower"

_STATIC_KEY = f"{DOMAIN}_panel_static"
_PANEL_KEY = f"{DOMAIN}_panel_registered"


async def async_register_panel(hass: HomeAssistant) -> None:
    """Serve the panel JS (once) and add the SDR Hub entry to the sidebar."""
    if not hass.data.get(_STATIC_KEY):
        frontend_dir = str(Path(__file__).parent / "frontend")
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, frontend_dir, cache_headers=False)]
        )
        hass.data[_STATIC_KEY] = True
    if hass.data.get(_PANEL_KEY):
        return
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="sdr-hub-panel",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=PANEL_MODULE_URL,
        require_admin=False,
    )
    hass.data[_PANEL_KEY] = True


def async_unregister_panel(hass: HomeAssistant) -> None:
    if not hass.data.get(_PANEL_KEY):
        return
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    hass.data[_PANEL_KEY] = False
