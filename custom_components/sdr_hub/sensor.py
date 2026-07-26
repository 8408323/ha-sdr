from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import SdrHubCoordinator

_LOGGER = logging.getLogger(__name__)

# Fields rtl_433 emits that describe the *message* rather than a reading. Excluded from entity
# creation because they identify the device or the decode, and would otherwise each become a
# meaningless numeric sensor - `id` in particular is a device identifier, not a measurement.
NON_MEASUREMENT_FIELDS = frozenset({"id", "channel", "model", "time", "mic", "protocol", "raw_message"})

# Known rtl_433 field names mapped to their Home Assistant semantics. Anything numeric that is not
# listed still becomes a sensor, just without a device class or unit - a decoder this integration
# has never seen should surface its readings rather than be silently dropped.
FIELD_SEMANTICS: dict[str, tuple[SensorDeviceClass | None, str | None]] = {
    "temperature_C": (SensorDeviceClass.TEMPERATURE, "°C"),
    "temperature_F": (SensorDeviceClass.TEMPERATURE, "°F"),
    "humidity": (SensorDeviceClass.HUMIDITY, "%"),
    "pressure_hPa": (SensorDeviceClass.PRESSURE, "hPa"),
    "pressure_kPa": (SensorDeviceClass.PRESSURE, "kPa"),
    "wind_avg_km_h": (SensorDeviceClass.WIND_SPEED, "km/h"),
    "wind_max_km_h": (SensorDeviceClass.WIND_SPEED, "km/h"),
    "wind_dir_deg": (None, "°"),
    "rain_mm": (SensorDeviceClass.PRECIPITATION, "mm"),
    "moisture": (SensorDeviceClass.MOISTURE, "%"),
    "rssi": (SensorDeviceClass.SIGNAL_STRENGTH, "dBm"),
    "snr": (None, "dB"),
    "noise": (None, "dB"),
}

# Hard ceiling on dynamically created entities. A busy 433 MHz band carries traffic from every
# neighbouring house, and rtl_433 will happily decode all of it - without a cap, leaving the panel
# running overnight could register thousands of entities that the user never asked for and cannot
# easily remove. Reaching it is logged once so the behaviour is visible rather than mysterious.
MAX_DECODED_ENTITIES = 200


def decoded_device_key(device: dict[str, Any]) -> str:
    """Identity of one physical sensor: model, id and channel.

    Mirrors the panel's deviceInstanceKey. Channel is included because some families share a model
    and omit `id` entirely, distinguished only by a dial - keying on model|id alone would merge two
    different sensors into one entity.
    """
    model = device.get("model") or ""
    ident = device.get("id")
    channel = device.get("channel")
    return f"{model}|{'' if ident is None else ident}|{'' if channel is None else channel}"


def decoded_device_name(device: dict[str, Any]) -> str:
    """Human-readable name for the HA device grouping this sensor's readings."""
    model = device.get("model") or "Unknown device"
    parts = [str(device["id"])] if device.get("id") is not None else []
    if device.get("channel") is not None:
        parts.append(f"ch {device['channel']}")
    return f"{model} {' '.join(parts)}".strip()


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: SdrHubCoordinator = entry.runtime_data
    async_add_entities([SdrHubStatusSensor(coordinator, entry)])

    # Decoded devices are discovered from the live stream rather than declared up front - the
    # add-on cannot know what is transmitting until something does. Entities are therefore created
    # on first sighting of each (device, field) pair and persist for the session; after a restart
    # they reappear when the device next reports, which is the normal discovery-integration
    # lifecycle.
    known: dict[tuple[str, str], SdrHubDecodedSensor] = {}
    capped = False

    @callback
    def handle_event(event: dict[str, Any]) -> None:
        nonlocal capped
        if event.get("type") != "decoded_device":
            return
        device = event.get("device") or {}
        if not isinstance(device, dict) or not device.get("model"):
            # Without a model there is nothing to name or group the entity by, and rtl_433 always
            # supplies one for a successful decode - so this is a malformed or partial message.
            return
        key = decoded_device_key(device)
        new_entities: list[SdrHubDecodedSensor] = []
        for field, value in device.items():
            if field in NON_MEASUREMENT_FIELDS or not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            existing = known.get((key, field))
            if existing is not None:
                existing.update_reading(float(value), device)
                continue
            if len(known) >= MAX_DECODED_ENTITIES:
                if not capped:
                    capped = True
                    _LOGGER.warning(
                        "Reached the %s decoded-device entity limit; further devices will appear in the "
                        "SDR Hub panel but will not be created as entities",
                        MAX_DECODED_ENTITIES,
                    )
                continue
            entity = SdrHubDecodedSensor(entry, device, field, float(value))
            known[(key, field)] = entity
            new_entities.append(entity)
        if new_entities:
            async_add_entities(new_entities)

    entry.async_on_unload(coordinator.async_add_event_listener(handle_event))


class SdrHubStatusSensor(CoordinatorEntity[SdrHubCoordinator], SensorEntity):
    """Diagnostic sensor reflecting reachability of the sdr_hub add-on and current activity."""

    _attr_has_entity_name = True
    _attr_name = "Status"
    _attr_icon = "mdi:radio-tower"

    def __init__(self, coordinator: SdrHubCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_status"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="SDR Hub",
            manufacturer="ha-sdr (unofficial)",
        )

    @property
    def native_value(self) -> str:
        return "connected" if self.coordinator.last_update_success else "unavailable"

    @property
    def extra_state_attributes(self) -> dict:
        data = self.coordinator.data or {}
        return {
            "dongle_count": len(data.get("devices", [])),
            "active_receivers": len(data.get("receivers", [])),
            "active_sweeps": len(data.get("sweeps", [])),
        }


class SdrHubDecodedSensor(SensorEntity):
    """One numeric reading from one decoded device.

    Deliberately not a CoordinatorEntity: these are driven by the add-on's live event stream, not
    by the coordinator's 30-second state poll, and a decode arrives whenever the sensor chooses to
    transmit. Coupling them to the poll would make every reading up to 30 seconds stale and would
    also republish unchanged values on every refresh.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, entry: ConfigEntry, device: dict[str, Any], field: str, value: float) -> None:
        self._field = field
        self._attr_native_value = value
        self._last_seen = datetime.now(timezone.utc)
        key = decoded_device_key(device)
        self._attr_unique_id = f"{entry.entry_id}_{key}_{field}"
        # Underscores read as word breaks in HA's UI, and rtl_433 field names are snake_case.
        self._attr_name = field.replace("_", " ")
        device_class, unit = FIELD_SEMANTICS.get(field, (None, None))
        self._attr_device_class = device_class
        self._attr_native_unit_of_measurement = unit
        # Each decoded sensor is its own HA device, linked to the SDR Hub hub entry via_device so
        # the relationship is visible in the UI and removing the integration removes them all.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}_{key}")},
            name=decoded_device_name(device),
            manufacturer="rtl_433 (decoded)",
            model=device.get("model"),
            via_device=(DOMAIN, entry.entry_id),
        )

    @callback
    def update_reading(self, value: float, device: dict[str, Any]) -> None:
        """Applies a newer reading from the live stream."""
        self._attr_native_value = value
        self._last_seen = datetime.now(timezone.utc)
        # Guarded: an entity that has been created but not yet added to hass has no way to write
        # state, and doing so raises rather than being ignored.
        if self.hass is not None:
            self.async_write_ha_state()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        # last_seen is the honest signal for a device that has gone quiet: these sensors report
        # only when they choose to, so a value with no timestamp gives no way to tell a current
        # reading from one several days old.
        return {"last_seen": self._last_seen.isoformat()}
