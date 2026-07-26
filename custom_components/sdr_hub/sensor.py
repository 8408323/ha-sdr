from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import SdrHubCoordinator

_LOGGER = logging.getLogger(__name__)

# Fields rtl_433 emits that describe the *message* rather than a reading. Excluded from entity
# creation because they identify the device or the decode, and would otherwise each become a
# meaningless numeric sensor - `id` in particular is a device identifier, not a measurement.
#
# Treating every unlisted number as a measurement is the wrong default for a decoder that also
# reports how it decoded: `sequence_num` is a rolling transmission counter and `message_type` a
# packet discriminator, so charting either says nothing about the environment, and both consume
# entity-budget slots per physical device. Names are matched exactly, so a real reading that
# happens to contain one of these words (`wind_dir_deg`) is unaffected.
NON_MEASUREMENT_FIELDS = frozenset(
    {
        "id",
        "channel",
        "model",
        "time",
        "mic",
        "protocol",
        "raw_message",
        # Per-message metadata emitted by the decoder rather than the sensor.
        "message_type",
        "sequence_num",
        "subtype",
        "num_rows",
        "mod",
        "crc",
        "status",
        "flags",
        # Which frequency the receiver heard this on - a property of the tuner, not the device.
        "freq",
        "freq1",
        "freq2",
    }
)

# Flags rtl_433 emits as JSON 0/1 rather than true/false, so they arrive as int and an
# isinstance(value, bool) guard does not catch them. Excluded by name: a battery indicator charted
# as a unitless "measurement" oscillating between 0 and 1 is worse than absent, and every device
# with a battery has one, so they would also consume the entity budget. Exposing them properly
# needs a binary_sensor platform, which is deliberately out of scope here.
FLAG_FIELDS = frozenset({"battery_ok", "battery", "button", "tamper", "alarm", "learn", "test"})


def finite_reading(value: Any) -> float | None:
    """Return value as a finite float, or None if it cannot be one.

    A decoded payload is JSON produced by an external process from whatever happened to be on the
    air, so "syntactically valid number" and "usable sensor state" are not the same thing. A
    mismatched decoder can emit an integer too large for a float (float() raises OverflowError) or
    a literal like 1e400, which json parses to inf without complaint. Neither is caught by a type
    check, and the cost of letting one through is not a bad reading: handle_event runs synchronously
    inside SdrHubCoordinator._dispatch, whose caller treats *any* exception as a lost connection, so
    a single malformed field would drop the WebSocket and be logged as a transport failure.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) else None

# Known rtl_433 field names mapped to their Home Assistant semantics. Anything numeric that is not
# listed still becomes a sensor, just without a device class or unit - a decoder this integration
# has never seen should surface its readings rather than be silently dropped.
# State class is per-field rather than a blanket MEASUREMENT. Cumulative readings - a rain gauge's
# lifetime total, a utility meter, an event count - are TOTAL_INCREASING, and recording them as
# measurements makes HA store sampled min/max/mean instead of period deltas, so the long-term
# statistics are wrong in a way that is invisible until someone looks at a monthly graph.
# An unknown field gets no state class at all: no statistics is recoverable, wrong statistics is not.
FIELD_SEMANTICS: dict[str, tuple[SensorDeviceClass | None, str | None, SensorStateClass | None]] = {
    "temperature_C": (SensorDeviceClass.TEMPERATURE, "°C", SensorStateClass.MEASUREMENT),
    "temperature_F": (SensorDeviceClass.TEMPERATURE, "°F", SensorStateClass.MEASUREMENT),
    "humidity": (SensorDeviceClass.HUMIDITY, "%", SensorStateClass.MEASUREMENT),
    "pressure_hPa": (SensorDeviceClass.PRESSURE, "hPa", SensorStateClass.MEASUREMENT),
    "pressure_kPa": (SensorDeviceClass.PRESSURE, "kPa", SensorStateClass.MEASUREMENT),
    "wind_avg_km_h": (SensorDeviceClass.WIND_SPEED, "km/h", SensorStateClass.MEASUREMENT),
    "wind_max_km_h": (SensorDeviceClass.WIND_SPEED, "km/h", SensorStateClass.MEASUREMENT),
    # No state class: a compass bearing is circular, and MEASUREMENT tells HA to record arithmetic
    # min/max/mean long-term statistics. Averaging 359 and 1 arithmetically gives 180 - due south
    # for two readings that are both due north - so the recorded statistic would be not merely
    # imprecise but pointing the opposite way, and any automation reading it inherits that. A
    # correct mean here needs circular statistics (averaging the unit vectors), which is a
    # different computation than the one MEASUREMENT requests.
    "wind_dir_deg": (None, "°", None),
    "moisture": (SensorDeviceClass.MOISTURE, "%", SensorStateClass.MEASUREMENT),
    # dB, not dBm, and no SIGNAL_STRENGTH class - which implies calibrated absolute power.
    # rtl_433 reports these three from the same metadata block as receiver-relative levels, so
    # publishing rssi as dBm would state a physically different quantity and make any dBm-based
    # automation threshold quietly wrong.
    "rssi": (None, "dB", SensorStateClass.MEASUREMENT),
    "snr": (None, "dB", SensorStateClass.MEASUREMENT),
    "noise": (None, "dB", SensorStateClass.MEASUREMENT),
    # Cumulative: rtl_433's rain_mm is a lifetime total from the gauge, not a rate.
    "rain_mm": (SensorDeviceClass.PRECIPITATION, "mm", SensorStateClass.TOTAL_INCREASING),
    "rain_in": (SensorDeviceClass.PRECIPITATION, "in", SensorStateClass.TOTAL_INCREASING),
}

# Hard ceiling on dynamically created entities. A busy 433 MHz band carries traffic from every
# neighbouring house, and rtl_433 will happily decode all of it - without a cap, leaving the panel
# running overnight could register thousands of entities that the user never asked for and cannot
# easily remove. Reaching it is logged once so the behaviour is visible rather than mysterious.
MAX_DECODED_ENTITIES = 200

# Statuses after which a sweep produces no further rows. It stays listed so the user can see why it
# stopped and remove it deliberately, which means "still listed" is not the same as "still measuring"
# - and statistics from a sweep that has stopped measuring are stale by definition.
TERMINAL_SWEEP_STATUSES = frozenset({"error", "stopped"})

# Minimum interval between state writes for one statistic entity.
#
# A narrow sweep finishes a row per capture with no pacing, so at the default sample rate the
# add-on can emit rows tens of times a second - and every row would otherwise write all three
# entities. That is event-loop work and, because these are measurement states, a Recorder row each
# time: a database growing at hundreds of rows a second for as long as the sweep runs. Nothing
# consuming a noise floor or a band-occupancy percentage needs sub-second resolution, so the raw
# rows keep flowing to the panel at full rate while the entities settle to an automation cadence.
# Seconds, measured on a monotonic clock. Wall time can move backwards - NTP correcting a drifted
# host, a VM resuming from a snapshot, someone fixing the timezone - and a backwards jump makes the
# elapsed comparison negative, which reads as "not long enough" and freezes every statistic write
# for as long as the jump, while rows keep arriving.
MIN_STAT_WRITE_INTERVAL_S = 5.0

# Statistics the add-on computes per sweep, published so automations can act on band activity -
# "notify me when 868 MHz gets busy" is a question about the band, not about any decoded device,
# and nothing in the integration could answer it before. Not capped by MAX_DECODED_ENTITIES: that
# limit protects against unbounded growth from whatever happens to be on the air, while these are
# three per sweep and a sweep only exists because someone created it.
SWEEP_STAT_FIELDS: dict[str, tuple[str, str | None]] = {
    # dB, and no SIGNAL_STRENGTH device class, for the same reason as the decoded rssi/snr fields:
    # these are receiver-relative levels, not calibrated absolute power.
    "noise_floor_db": ("Noise floor", "dB"),
    "peak_db": ("Peak", "dB"),
    "occupancy_pct": ("Band occupancy", "%"),
}


def format_band(band: tuple[float, float] | None) -> str | None:
    if band is None:
        return None
    return f"{band[0] / 1e6:.3f}-{band[1] / 1e6:.3f} MHz"


def sweep_stat_key(sweep: dict[str, Any] | None) -> str | None:
    """Stable identity for one configured band on one dongle.

    Derived from the sweep's *configuration*, not from the rows it produces. Keying on the measured
    band meant the key was unknown until the first row arrived, which needed a sweep-id-to-key map -
    and that map is empty on every restart while the coordinator already lists the running sweeps,
    so the first reconciliation retired every active entity and device before any row could
    repopulate it. Recreating them afterwards is not harmless: registry removal discards entity
    customisations and mints a new device-registry id, breaking device-targeted automations. The
    configuration is known immediately and does not change, so nothing has to be remembered.

    Identity is (band, driver, serial) because that is how the add-on itself identifies hardware -
    DeviceManager claims a dongle by (driver, serial) and accepts dongle_driver precisely to
    disambiguate two devices sharing a serial. Keying on the serial alone would merge two such
    dongles' measurements of the same band into one set of entities publishing alternating values,
    and an empty serial - which several supported devices report - would collide immediately.

    Rounded to whole Hz so a float that re-serialises a fraction differently cannot mint a second
    identity for the same band.
    """
    if not isinstance(sweep, dict):
        return None
    start, stop = sweep.get("start_hz"), sweep.get("stop_hz")
    if not isinstance(start, (int, float)) or not isinstance(stop, (int, float)):
        return None
    driver = sweep.get("dongle_driver") or "unknown"
    serial = sweep.get("dongle_serial")
    # "" is a real serial for devices that omit one, and is distinct from a missing field - so it is
    # preserved rather than folded into the same placeholder as an absent value.
    serial = "noserial" if serial is None else serial
    return f"{round(start)}_{round(stop)}_{driver}_{serial}"


def sweep_configured_band(sweep: dict[str, Any] | None) -> tuple[float, float] | None:
    if not isinstance(sweep, dict):
        return None
    start, stop = sweep.get("start_hz"), sweep.get("stop_hz")
    if not isinstance(start, (int, float)) or not isinstance(stop, (int, float)):
        return None
    return float(start), float(stop)


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

    # What the cap protects is *registry growth*, not session activity - so it is evaluated
    # against the registry, and only for unique ids the registry has never seen.
    #
    # Counting registered entities and adding the session's own count double-counted every one of
    # them as it was recreated: after a restart `known` starts empty while the registry is already
    # full, so with 150 entries only the first 50 devices could reload and at the cap none could
    # load at all - the integration locked out of its own entities. Recreating an existing unique
    # id does not grow the registry, so it must not be charged against a limit on growth.
    registry = er.async_get(hass)
    # Unique ids this session has handed to async_add_entities. The registry is not updated
    # synchronously, so between scheduling an entity and it appearing there the registry undercounts
    # by exactly this set - and handle_event can run again in that window when several decodes are
    # already buffered. Counting the *union* rather than adding a per-payload tally is what makes
    # the projection correct across payloads as well as within one: a set cannot double-count an
    # id that is in both halves, which is the mistake an additive count made twice already.
    pending: set[str] = set()

    def _is_new_registration(unique_id: str) -> bool:
        return registry.async_get_entity_id("sensor", DOMAIN, unique_id) is None

    def _is_decoded_unique_id(unique_id: str) -> bool:
        """Whether a unique id belongs to the decoded-device population the cap governs.

        Excluding only the status sensor was correct while decoded sensors were the only other kind.
        Sweep statistics broke that assumption without changing the filter, so three entities per
        sweep were silently charged against a limit documented as not applying to them - and because
        registry entries outlive their sweep, 67 create/delete cycles would exhaust it with no
        decoded device ever having existed.
        """
        return unique_id != f"{entry.entry_id}_status" and not unique_id.startswith(f"{entry.entry_id}_sweep_")

    def _projected_decoded_count() -> int:
        registered = {
            e.unique_id
            for e in er.async_entries_for_config_entry(registry, entry.entry_id)
            if e.domain == "sensor" and _is_decoded_unique_id(e.unique_id)
        }
        return len(registered | {uid for uid in pending if _is_decoded_unique_id(uid)})

    # Keyed by the stable band+dongle identity, not the sweep id - see sweep_stat_key.
    sweep_stat_entities: dict[tuple[str, str], SdrHubSweepStatSensor] = {}

    @callback
    def live_stat_keys() -> set[str]:
        """Stable keys for every sweep that is still measuring.

        Computed straight from the coordinator snapshot, so it is correct on the very first
        reconciliation after a restart rather than only once rows have started arriving.
        """
        keys: set[str] = set()
        for sweep in (coordinator.data or {}).get("sweeps", []):
            if not isinstance(sweep, dict) or sweep.get("status") in TERMINAL_SWEEP_STATUSES:
                continue
            key = sweep_stat_key(sweep)
            if key:
                keys.add(key)
        return keys

    @callback
    def retire_sweep_stats(just_ended: set[str] | None = None) -> None:
        """Marks statistics unavailable when their band stops being measured.

        Nothing is removed from either registry any more. Two separate P1s came from deleting
        registry records on retirement: the device record, whose internal id automations target and
        which HA re-mints on recreation, and then the entity records, which carry the user's renamed
        entity id and every customisation applied to it. Both were destroyed by a routine sweep
        stop, and both broke automations silently while every identity the code controls stayed
        stable - which is the tell that deletion was the wrong mechanism, not that its details were
        wrong.

        What the retirement was ever for is that a stopped sweep must not keep publishing a reading
        as though it were current. Unavailable says exactly that, and says it without discarding
        anything the user owns. A band never measured again leaves three unavailable entities the
        user can delete deliberately, which is a cost they can see and undo.
        """
        nonlocal live_keys_cache
        live_keys_cache = live_stat_keys() - (just_ended or set())
        live_sweep_for_key.clear()
        for sweep in (coordinator.data or {}).get("sweeps", []):
            if not isinstance(sweep, dict) or sweep.get("status") in TERMINAL_SWEEP_STATUSES:
                continue
            key = sweep_stat_key(sweep)
            if key in live_keys_cache and isinstance(sweep.get("id"), str):
                live_sweep_for_key[key] = sweep["id"]
        for entity in sweep_stat_entities.values():
            entity.async_write_ha_state_if_added()

    # The set of keys currently being measured, recomputed on every reconciliation and read by each
    # entity's availability. Held here rather than recomputed per entity so one snapshot decides
    # them all consistently.
    live_keys_cache: set[str] = set()

    # Which sweep instance produced the value each key currently holds. Reusing a band creates a
    # *new* sweep with the same stable key, so the key going live again does not mean the reading
    # is current - it means a different sweep is about to start producing one. Until a row from
    # that sweep arrives the entity still holds the previous sweep's last measurement, and
    # publishing it as available republishes a stale reading exactly when the identity work makes
    # the entity easiest to reuse.
    value_source: dict[str, str] = {}
    # Bumped whenever the event stream reconnects. A WebSocket-only outage leaves the add-on and the
    # sweep running, so the snapshot afterwards finds the same sweep and value_source still names
    # it - and availability would return the moment the stream came back, republishing the
    # pre-outage peak and occupancy as current before a single post-gap row had arrived. The value
    # an entity holds belongs to the connection that delivered it, so a new connection makes it
    # stale until replaced.
    value_epoch: dict[str, int] = {}
    # Last stats generation seen per key, so a reset can bypass the write throttle exactly once.
    last_generation: dict[str, int] = {}

    @callback
    def is_measuring(key: str) -> bool:
        if key not in live_keys_cache:
            return False
        if value_epoch.get(key) != coordinator.stream_epoch:
            return False
        producing = live_sweep_for_key.get(key)
        return producing is not None and value_source.get(key) == producing

    # Which live sweep currently owns each key, recomputed alongside live_keys_cache.
    live_sweep_for_key: dict[str, str] = {}

    @callback
    def handle_sweep_stats(event: dict[str, Any]) -> None:
        sweep_id = event.get("sweep_id")
        stats = event.get("stats")
        # Absent rather than null when the sweep has produced nothing measurable yet, so there is
        # no entity asserting 0 dB - which for a noise floor is a real and very loud reading.
        if not isinstance(sweep_id, str) or not isinstance(stats, dict):
            return
        sweep = next(
            (s for s in (coordinator.data or {}).get("sweeps", []) if isinstance(s, dict) and s.get("id") == sweep_id),
            None,
        )
        key = sweep_stat_key(sweep)
        if key is None:
            return
        # The configured band, matching the key. Labelling a device with the measured range while
        # filing it under the configured one would show two different bands for one thing.
        band = sweep_configured_band(sweep)
        # Prefers the driver+serial the add-on identifies hardware by; falls back to whichever half
        # is present, since some supported devices report no serial at all.
        dongle_label = " ".join(
            part for part in (sweep.get("dongle_driver"), sweep.get("dongle_serial")) if part
        ) or None
        # Two kinds of discontinuity, and either must reach Home Assistant at once rather than
        # waiting out the throttle. A new generation means the add-on reset its accumulator - the
        # user asked for a clear and is looking at the figure. A change of *producing sweep* means
        # a replacement sweep took over this band: its first row is what makes the entity available
        # again, and a fresh accumulator reports generation 0 exactly as the old one did, so
        # comparing generations alone would leave the entity showing "unavailable" until a later
        # row happened to fall outside the interval.
        generation = stats.get("generation")
        replaced = value_source.get(key) != sweep_id or value_epoch.get(key) != coordinator.stream_epoch
        value_epoch[key] = coordinator.stream_epoch
        forced = replaced or (generation is not None and last_generation.get(key) != generation)
        value_source[key] = sweep_id
        if generation is not None:
            last_generation[key] = generation
        new_stat_entities: list[SdrHubSweepStatSensor] = []
        for field in SWEEP_STAT_FIELDS:
            value = finite_reading(stats.get(field))
            if value is None:
                continue
            existing = sweep_stat_entities.get((key, field))
            if existing is not None:
                existing.update_reading(value, band, force=forced)
                continue
            entity = SdrHubSweepStatSensor(entry, coordinator, key, field, value, band, is_measuring, dongle_label)
            sweep_stat_entities[(key, field)] = entity
            new_stat_entities.append(entity)
        if new_stat_entities:
            async_add_entities(new_stat_entities)

    @callback
    def handle_event(event: dict[str, Any]) -> None:
        nonlocal capped
        if event.get("type") == "sweep_row":
            handle_sweep_stats(event)
            return
        if event.get("type") == "stats_reset":
            # The accumulator behind these entities has been cleared, so what they hold is no longer
            # a measurement of anything. Dropping the value source makes them unavailable until the
            # next row, rather than publishing a pre-reset figure that a wide sweep might leave on
            # screen for most of a minute - or forever, if the sweep errors straight afterwards.
            reset_key = sweep_stat_key(
                next(
                    (
                        s
                        for s in (coordinator.data or {}).get("sweeps", [])
                        if isinstance(s, dict) and s.get("id") == event.get("sweep_id")
                    ),
                    None,
                )
            )
            if reset_key:
                value_source.pop(reset_key, None)
                for (key, _field), entity in sweep_stat_entities.items():
                    if key == reset_key:
                        entity.async_write_ha_state_if_added()
            return
        # Both paths a sweep can end by, because neither covers the other: a DELETE emits no status
        # event and is only visible as a state change, while an errored sweep never reaches the
        # DELETE route. Reconciling against the coordinator's live sweep list rather than acting on
        # the event's own id also cleans up anything missed while this listener was not attached.
        if event.get("type") in ("state_changed", "status"):
            # The snapshot is the base, but a raw status event arrives *without* it having been
            # updated: DeviceManager reports an unexpected failure straight to subscribers, so
            # coordinator.data still carries the sweep's pre-error status and reconciling from it
            # alone would keep all three entities publishing until a later poll. The event names
            # the sweep that just stopped, so it is used directly rather than waited for.
            ended: set[str] = set()
            if (
                event.get("type") == "status"
                and event.get("kind") == "sweep"
                and event.get("status") in TERMINAL_SWEEP_STATUSES
            ):
                sweeps = [s for s in (coordinator.data or {}).get("sweeps", []) if isinstance(s, dict)]
                ended_id = event.get("id")
                key = sweep_stat_key(next((s for s in sweeps if s.get("id") == ended_id), None))
                # Only if no *other* live sweep already owns this key. A status message can be
                # delayed in the add-on's queue while a replacement sweep for the same band is
                # created and its REST refresh reconciles the key as live - subtracting the key
                # unconditionally would then mark the replacement's already-current entities
                # unavailable, and nothing would restore them until an unrelated state refresh.
                # The event says a sweep ended, not that the band stopped being measured.
                taken_over = any(
                    s.get("id") != ended_id
                    and s.get("status") not in TERMINAL_SWEEP_STATUSES
                    and sweep_stat_key(s) == key
                    for s in sweeps
                )
                if key and not taken_over:
                    ended.add(key)
            retire_sweep_stats(ended)
            if event.get("type") == "status":
                return
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
            if field in NON_MEASUREMENT_FIELDS or field in FLAG_FIELDS:
                continue
            reading = finite_reading(value)
            if reading is None:
                continue
            existing = known.get((key, field))
            if existing is not None:
                existing.update_reading(reading, device)
                continue
            unique_id = f"{entry.entry_id}_{key}_{field}"
            if _is_new_registration(unique_id):
                # Claimed the moment it is accepted, not when async_add_entities runs after the
                # loop - otherwise every field of this payload, and every payload already buffered
                # behind it, reads the same count and each independently claims all remaining slots.
                if _projected_decoded_count() >= MAX_DECODED_ENTITIES:
                    if not capped:
                        capped = True
                        _LOGGER.warning(
                            "Reached the %s decoded-device entity limit; further devices will appear in the "
                            "SDR Hub panel but will not be created as entities",
                            MAX_DECODED_ENTITIES,
                        )
                    continue
                pending.add(unique_id)
            entity = SdrHubDecodedSensor(entry, device, field, reading)
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

    def __init__(self, entry: ConfigEntry, device: dict[str, Any], field: str, value: float) -> None:
        self._field = field
        self._attr_native_value = value
        self._last_seen = datetime.now(timezone.utc)
        key = decoded_device_key(device)
        self._attr_unique_id = f"{entry.entry_id}_{key}_{field}"
        # Underscores read as word breaks in HA's UI, and rtl_433 field names are snake_case.
        self._attr_name = field.replace("_", " ")
        device_class, unit, state_class = FIELD_SEMANTICS.get(field, (None, None, None))
        self._attr_device_class = device_class
        self._attr_native_unit_of_measurement = unit
        self._attr_state_class = state_class
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


class SdrHubSweepStatSensor(SensorEntity):
    """One statistic about one sweep's band, as measured by the add-on.

    Deliberately not a CoordinatorEntity, for the same reason as SdrHubDecodedSensor: the value
    arrives on the event stream when a row is emitted, not on the coordinator's polling interval,
    and binding it to that interval would make the reading lag the hardware by up to 30 seconds.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        entry: ConfigEntry,
        coordinator: SdrHubCoordinator,
        stat_key: str,
        field: str,
        value: float,
        band: tuple[float, float] | None,
        is_measuring: Callable[[str], bool],
        dongle: str | None,
    ) -> None:
        self._coordinator = coordinator
        self._stat_key = stat_key
        self._is_measuring = is_measuring
        self._last_written: float | None = None
        name, unit = SWEEP_STAT_FIELDS[field]
        self._attr_name = name
        self._attr_native_unit_of_measurement = unit
        self._attr_native_value = value
        self._attr_unique_id = f"{entry.entry_id}_sweep_{stat_key}_{field}"
        self._attr_icon = "mdi:chart-bell-curve-cumulative"
        self._band = band
        # Named by the band, falling back to the id only when the geometry is unavailable. The id is
        # a random UUID, so a name built from it answers none of the questions actually asked of
        # this device: with two sweeps running, "which of these identical occupancy sensors is
        # 868 MHz" is exactly what someone writing that automation needs, and the UUID prefix is
        # unguessable from HA's device list.
        band_label = format_band(band)
        # The dongle is part of the name, not only of the key. Two dongles sweeping the same band
        # concurrently is a supported configuration, and the key keeps their statistics correctly
        # separate - but a band-only name gave both devices identical labels, so the UI offered two
        # indistinguishable sets of "Noise floor", "Peak" and "Band occupancy" with nothing to
        # choose between them except an opaque entity-id suffix. An identity that is correct
        # internally and invisible in the interface does not help the person picking a sensor.
        self._dongle = dongle
        dongle_label = f" on {dongle}" if dongle else ""
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}_sweep_{stat_key}")},
            name=f"SDR Hub sweep {band_label}{dongle_label}" if band_label else f"SDR Hub sweep {stat_key}",
            manufacturer="ha-sdr (unofficial)",
            model="Spectrum sweep",
            via_device=(DOMAIN, entry.entry_id),
        )

    @callback
    def async_write_ha_state_if_added(self) -> None:
        """Re-evaluates availability, for entities that may not be added to hass yet."""
        if self.hass is not None:
            self.async_write_ha_state()

    @callback
    def update_reading(self, value: float, band: tuple[float, float] | None = None, *, force: bool = False) -> None:
        # The value is always recorded, so the entity holds the latest measurement whether or not
        # this particular row is written out - a throttle that also discarded data would turn a
        # write-rate problem into a measurement problem.
        self._attr_native_value = value
        if band is not None:
            self._band = band
        # Same guard as the decoded sensor: an entity constructed but not yet added to hass cannot
        # write state, and attempting it raises rather than being ignored.
        if self.hass is None:
            return
        now = time.monotonic()
        if not force and self._last_written is not None and now - self._last_written < MIN_STAT_WRITE_INTERVAL_S:
            return
        self._last_written = now
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        """Re-evaluates availability whenever the coordinator reports success or failure.

        The property below is only consulted when something writes state, and these entities write
        only on an incoming row - which is precisely what stops arriving when the add-on drops. So
        without this subscription the entity would stay "available" with a stale value forever,
        and the property would be correct but never observed. Not a CoordinatorEntity, because the
        *value* must still come from the event stream rather than the 30-second poll; only the
        availability follows the coordinator.
        """
        await super().async_added_to_hass()
        self.async_on_remove(self._coordinator.async_add_listener(self.async_write_ha_state))

    @property
    def available(self) -> bool:
        """Whether the add-on is still reachable.

        These are push entities, so nothing marks them stale on its own: if the add-on stops or the
        connection drops without a terminal sweep status - being killed, restarted, or losing the
        network - the last noise floor, peak and occupancy simply stay published. An automation
        acting on "the band is busy" would keep firing on a measurement that ended hours ago, and
        the entity gives it nothing to distinguish that from a quiet, steady band. Unavailable is
        the honest state, and it is what every other integration's consumers already know to check.
        """
        # Three conditions, because each can fail without the others. The REST poll can keep
        # succeeding while the event stream is down - the add-on still answers /sweeps while its
        # WebSocket is gone - and both can be healthy while the sweep that produced this reading has
        # stopped. The last is what replaced deleting the entity: it says "this is not being
        # measured" without destroying the user's renamed entity id along with it.
        return (
            self._coordinator.last_update_success
            and self._coordinator.stream_connected
            and self._is_measuring(self._stat_key)
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        # Machine-readable alongside the human-readable device name: a template picking the right
        # occupancy sensor needs numbers to compare, not a formatted label to parse.
        attrs: dict[str, Any] = {}
        if self._band is not None:
            attrs |= {"start_hz": self._band[0], "stop_hz": self._band[1], "band": format_band(self._band)}
        if self._dongle:
            attrs["dongle"] = self._dongle
        return attrs
