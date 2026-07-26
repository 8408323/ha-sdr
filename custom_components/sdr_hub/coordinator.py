from __future__ import annotations

import asyncio
import logging
import math
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import SdrHubApiClient, SdrHubApiError

if TYPE_CHECKING:
    from . import SdrHubConfigEntry

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(seconds=30)
_RECONNECT_DELAY_S = 5


def _sanitize_event(event: Any) -> Any:
    """Drop decoded numbers that cannot survive being re-serialized to JSON by Home Assistant.

    A decoded payload is JSON produced by an external process from whatever was on the air, and
    "valid JSON on the wire" is a weaker guarantee than "HA can send this to a browser". An integer
    wider than 64 bits parses here without complaint and then fails in websocket_api's serializer -
    which discards the *whole* message, so one unusable field silently costs the panel every other
    field of that decode, and the panel cannot tell a dropped event from a quiet band.

    Sanitizing at the point events enter the coordinator, rather than in each listener, is what
    keeps the entity path and the panel path agreeing on which readings exist: the same value must
    not become a sensor and reach the panel, or be rejected by one and shown by the other.
    """
    if not isinstance(event, dict) or event.get("type") != "decoded_device":
        return event
    device = event.get("device")
    if not isinstance(device, dict):
        return event
    dropped = [
        field
        for field, value in device.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and not _is_serializable_number(value)
    ]
    if not dropped:
        return event
    _LOGGER.warning(
        "Dropped unrepresentable numeric field(s) %s from a %s decode",
        ", ".join(sorted(dropped)),
        device.get("model"),
    )
    return {**event, "device": {k: v for k, v in device.items() if k not in dropped}}


# The range Home Assistant's JSON serializer accepts for an integer. Outside it the value is
# rejected outright, whatever its magnitude as a float.
_MIN_SERIALIZABLE_INT = -(2**63)
_MAX_SERIALIZABLE_INT = 2**64 - 1


def _is_serializable_number(value: int | float) -> bool:
    """Whether the value survives being serialized, as the type it will actually be sent as.

    Integers are range-checked rather than tested for float finiteness, because those are different
    questions and only the first one is the one being asked: float(10**100) is 1e100, perfectly
    finite, so a finiteness test passes and the *original* oversized integer is kept and forwarded -
    and the serializer rejects it anyway. That failure is worse than no check at all, because the
    sensor path would meanwhile accept the rounded float, leaving the two paths disagreeing about a
    reading in exactly the way sanitizing here is meant to prevent.
    """
    if isinstance(value, int):
        return _MIN_SERIALIZABLE_INT <= value <= _MAX_SERIALIZABLE_INT
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


class SdrHubCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the add-on's snapshot state and relays its live WebSocket events to listeners."""

    def __init__(self, hass: HomeAssistant, api: SdrHubApiClient, config_entry: "SdrHubConfigEntry") -> None:
        super().__init__(
            hass, _LOGGER, config_entry=config_entry, name="sdr_hub", update_interval=UPDATE_INTERVAL
        )
        self.api = api
        # Identifies *this* coordinator instance. A full Home Assistant restart builds a new one,
        # so a panel that sees a different id across a reconnect knows the add-on event stream was
        # interrupted for every tab - not just its own socket. Without that distinction the panel
        # treated a global restart as a tab-local drop and adopted a peer's persisted battery map,
        # even though no peer could have stayed connected either, so a recovery transmitted during
        # the restart could leave a low-battery banner asserted indefinitely.
        self.session_id = uuid.uuid4().hex
        # Whether the add-on's event stream is currently up. Distinct from last_update_success,
        # which reflects the REST poll: the two fail independently, and a stream-only outage is the
        # one that matters most to push entities - the REST snapshot keeps succeeding while no rows
        # arrive at all, so anything relying on polling health alone would keep publishing readings
        # that stopped being measured.
        self.stream_connected = False
        # Incremented on each successful (re)connection of the add-on event stream. Consumers that
        # cache a value delivered over the stream can compare it and treat anything from an earlier
        # connection as stale, since a gap may have hidden any number of updates.
        self.stream_epoch = 0
        self._event_listeners: list[Callable[[dict[str, Any]], None]] = []
        self._stopping = False
        self._suppress_broadcast_count = 0
        # A refresh triggered by anything other than this panel's own action (a service call,
        # another open panel's WS command, or the periodic poll) otherwise has no way to reach
        # other subscribed panels - only the raw add-on WS events do. Piggyback on the
        # coordinator's own standard update-listener mechanism so every successful refresh,
        # regardless of what triggered it, notifies every sdr_hub/subscribe client too.
        self.async_add_listener(self._on_data_updated)

    @callback
    def suppress_next_broadcast(self) -> None:
        """Marks the next _on_data_updated firing as caller-initiated, so it isn't re-broadcast.

        ws_get_state forces a refresh so it can return fresh data to the one caller that asked -
        without this, that refresh's own update-listener firing would re-broadcast state_changed
        to every subscriber (including the caller), which would re-trigger _loadState() -> another
        get_state -> another forced refresh, an unbounded feedback loop (confirmed live).

        Uses a counter, not a plain boolean: two subscribed panels can react to the same
        state_changed event and both enter ws_get_state before either's async_refresh() call
        completes (async_refresh() calls aren't serialized against each other), so both call
        this and both later fire _on_data_updated. A shared boolean would be cleared by the
        first completion, leaving the second completion to broadcast unsuppressed and repeat
        the feedback loop - a counter lets each forced refresh consume exactly one suppression,
        however the calls interleave, since suppress_next_broadcast() is always called
        synchronously (no await between it and the matching async_refresh()) right before the
        refresh that will eventually consume it.
        """
        self._suppress_broadcast_count += 1

    @callback
    def cancel_pending_suppression(self) -> None:
        """Undoes one suppress_next_broadcast() call that its own refresh will never consume.

        DataUpdateCoordinator._async_refresh() skips calling update listeners entirely on a
        repeated (non-recovering) failure - it returns early via
        `if not self.last_update_success and not previous_update_success: return`, before it
        would otherwise call async_update_listeners(). A refresh that hits that path never
        fires _on_data_updated, so the suppression added for it would otherwise never be
        consumed - leaking a "surplus" suppression that silently swallows the *next* genuine
        state_changed broadcast once the add-on recovers. Callers that detect this exact
        condition (no success before or after their forced refresh) must call this immediately
        afterward to keep the count balanced.
        """
        if self._suppress_broadcast_count > 0:
            self._suppress_broadcast_count -= 1

    @callback
    def _on_data_updated(self) -> None:
        if self._suppress_broadcast_count > 0:
            self._suppress_broadcast_count -= 1
            return
        self._dispatch({"type": "state_changed"})

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
        first_connection = True
        while not self._stopping:
            try:
                async with self.api.connect_ws() as ws:
                    if not first_connection:
                        # Reconnecting after an outage, not connecting for the first time. Any
                        # events the add-on emitted during the gap (e.g. a low-battery device's
                        # recovery) were missed, so panel-side state derived purely from the
                        # event stream (see panel.js's _deviceBatteryOk) can no longer be trusted
                        # - tell subscribers to discard and rebuild it, rather than keep asserting
                        # what may now be stale. This fires on every reconnect, independently of
                        # (and in addition to) the panel's own disconnectedCallback-driven clear,
                        # since the panel element can stay attached to HA the whole time this
                        # add-on-facing WS drops and reconnects underneath it.
                        # See broadcaster.py's stream_gap for why this carries an id: it is a
                        # single-source signal fanned out to every tab, so a shared identity lets
                        # them converge on handling it exactly once.
                        self._dispatch({"type": "stream_reconnected", "gap_id": uuid.uuid4().hex})
                    first_connection = False
                    # The snapshot is refreshed *before* the stream is reported up. Opening the
                    # WebSocket succeeds the moment a restarted add-on is listening, while
                    # coordinator.data still describes the process that died - so marking the
                    # stream connected first re-enabled the statistic entities against sweeps that
                    # no longer exist, republishing their last readings as current for up to a
                    # polling interval. Availability should not return before the state behind it
                    # is true.
                    await self.async_refresh()
                    self._advance_stream_epoch()
                    self._set_stream_connected(True)
                    _LOGGER.debug("sdr_hub WS connected")
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            event = _sanitize_event(msg.json())
                            # A stream_gap means the add-on's per-client queue overflowed and
                            # discarded an unsent message - the socket never closed, so the
                            # reconnect path below never runs and nothing else marks what was
                            # already delivered as stale. It is the same loss of continuity as a
                            # reconnect and has to advance the same boundary, or a consumer that
                            # missed a reset or a terminal update keeps publishing what it last saw.
                            if isinstance(event, dict) and event.get("type") == "stream_gap":
                                self._advance_stream_epoch()
                            self._dispatch(event)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - reconnect on any transport failure, not just expected ones
                _LOGGER.warning("sdr_hub WS connection lost, reconnecting in %ss", _RECONNECT_DELAY_S)
            # Reached on a clean end of the async-for as well as on an exception, so a stream that
            # simply closes is reported as down rather than silently leaving the last value published.
            self._set_stream_connected(False)
            if not self._stopping:
                await asyncio.sleep(_RECONNECT_DELAY_S)

    @callback
    def _advance_stream_epoch(self) -> None:
        """Marks everything delivered so far as belonging to a closed epoch.

        Announced immediately rather than left for the next update: a push entity only re-evaluates
        availability when something writes its state, and a gap is precisely a period in which
        nothing did.
        """
        self.stream_epoch += 1
        self.async_update_listeners()

    @callback
    def _set_stream_connected(self, connected: bool) -> None:
        if self.stream_connected == connected:
            return
        self.stream_connected = connected
        # Entities that derive availability from this only re-evaluate it when something writes
        # their state, and a push entity's writes are exactly what stops during an outage - so the
        # change has to be announced rather than left to be noticed.
        self.async_update_listeners()

    def _dispatch(self, event: dict[str, Any]) -> None:
        for listener in list(self._event_listeners):
            # A listener fault is not a transport fault, but ws_loop cannot tell the difference:
            # its except-Exception is deliberately broad so any *connection* failure reconnects, and
            # an exception raised here arrives through the same path. Unisolated, one listener
            # raising on one event would drop the WebSocket, log it as "connection lost", and take
            # every other listener's stream down with it - a misdiagnosis that would recur for any
            # listener added later, so it is fixed at the dispatch boundary rather than per listener.
            try:
                listener(event)
            except Exception:  # noqa: BLE001 - one listener must not break the stream for the rest
                _LOGGER.exception("sdr_hub event listener failed handling a %s event", event.get("type"))
