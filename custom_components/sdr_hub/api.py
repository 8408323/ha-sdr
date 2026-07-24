from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)


def _bracket_host(host: str) -> str:
    """Brackets a bare IPv6 literal so it's a valid URL authority component.

    An IPv6 address's own colons collide with the ":port" separator in scheme://host:port -
    RFC 3986 requires (and every URL parser expects) an IPv6 literal wrapped in [...] as the
    host component. A hostname or IPv4 address contains no colons, so this is a no-op for the
    overwhelmingly common case; a host the user already bracketed is left alone too.
    """
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


class SdrHubApiError(Exception):
    """Raised on a non-2xx response from the add-on."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"sdr_hub add-on returned {status}: {detail}")
        self.status = status
        self.detail = detail


class SdrHubApiClient:
    """Talks to the sdr_hub add-on's HTTP + WebSocket API."""

    def __init__(self, hass: HomeAssistant, host: str, port: int, api_token: str) -> None:
        self._session = async_get_clientsession(hass)
        host = _bracket_host(host)
        self._base_url = f"http://{host}:{port}"
        self._ws_url = f"ws://{host}:{port}/ws"
        self._headers = {"Authorization": f"Bearer {api_token}"}

    async def async_get_health(self) -> dict[str, Any]:
        return await self._request("GET", "/health", auth=False)

    async def async_get_devices(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/devices")

    async def async_get_receivers(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/receivers")

    async def async_add_receiver(self, config: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/receivers", json=config)

    async def async_remove_receiver(self, receiver_id: str) -> None:
        await self._request("DELETE", f"/receivers/{receiver_id}")

    async def async_get_sweeps(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/sweeps")

    async def async_add_sweep(self, config: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/sweeps", json=config)

    async def async_remove_sweep(self, sweep_id: str) -> None:
        await self._request("DELETE", f"/sweeps/{sweep_id}")

    async def _request(self, method: str, path: str, *, json: dict | None = None, auth: bool = True) -> Any:
        headers = self._headers if auth else None
        async with self._session.request(method, f"{self._base_url}{path}", json=json, headers=headers) as resp:
            if resp.status >= 400:
                detail = await resp.text()
                raise SdrHubApiError(resp.status, detail)
            if resp.status == 204:
                return None
            return await resp.json()

    def connect_ws(self):
        """Returns an async context manager yielding a ClientWebSocketResponse."""
        return self._session.ws_connect(self._ws_url, headers=self._headers)
