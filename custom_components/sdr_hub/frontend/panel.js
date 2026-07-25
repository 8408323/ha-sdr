// SDR Hub dashboard — a custom Home Assistant sidebar panel (not a Lovelace view).
// Home Assistant sets `hass`, `narrow`, `route`, and `panel` properties on this element.
// Shows one live spectrum waterfall per active wideband sweep, a decoded-device feed from
// rtl_433 receivers, and forms to add/remove receivers and sweeps against the sdr_hub add-on.

const CARD = `
  background: var(--card-background-color, #fff);
  border-radius: 12px;
  box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1));
  padding: 16px;
  margin-bottom: 16px;
`;
const INPUT = `
  box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--divider-color, #e0e0e0);
  background: var(--secondary-background-color, #fafafa);
  color: var(--primary-text-color, #212121); font-size: .95rem;
`;
const BTN = `
  border: none; border-radius: 8px; padding: 8px 16px; font-size: .95rem; cursor: pointer;
  background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
`;
const BTN_DANGER = `${BTN} background: var(--error-color, #db4437);`;
const BTN_SECONDARY = `${BTN} background: var(--secondary-background-color, #e0e0e0); color: var(--primary-text-color, #212121);`;
const LABEL = "display:block;font-size:.8rem;color:var(--secondary-text-color,#727272);margin:0 0 4px";

// Entity/device names, decoded-device fields, and error messages are effectively
// attacker-controlled (a hostile 433MHz transmitter, a misbehaving add-on) — escape
// before interpolating into innerHTML.
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const fmtMHz = (hz) => (Number(hz) / 1e6).toFixed(3);

// "2m14s" / "48s" — used for the waterfall's relative-time axis ticks.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
};

// Local wall-clock (the browser's own timezone), not UTC - "absolute" is meant to match what a
// user's own clock already shows elsewhere (their OS, HA's own header clock), not to be a
// portable/unambiguous format.
const fmtAbsoluteTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Sequential (single-hue, light→dark) ramp — dataviz skill's blue sequential steps 100→700.
// Power near the noise floor recedes toward pale; strong signals go dark blue. Deliberately
// not a rainbow/jet colormap.
const SEQUENTIAL_RAMP = [
  [0 / 12, [205, 226, 251]],
  [1 / 12, [183, 211, 246]],
  [2 / 12, [158, 197, 244]],
  [3 / 12, [134, 182, 239]],
  [4 / 12, [109, 167, 236]],
  [5 / 12, [85, 152, 231]],
  [6 / 12, [57, 135, 229]],
  [7 / 12, [42, 120, 214]],
  [8 / 12, [37, 106, 191]],
  [9 / 12, [28, 92, 171]],
  [10 / 12, [24, 79, 149]],
  [11 / 12, [16, 66, 129]],
  [12 / 12, [13, 54, 107]],
];

function sequentialColor(t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 0; i < SEQUENTIAL_RAMP.length - 1; i++) {
    const [t0, c0] = SEQUENTIAL_RAMP[i];
    const [t1, c1] = SEQUENTIAL_RAMP[i + 1];
    if (t >= t0 && t <= t1) {
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
    }
  }
  return SEQUENTIAL_RAMP[SEQUENTIAL_RAMP.length - 1][1];
}

// Perceptually-uniform multi-hue ramp (viridis stops) - unlike the default single-hue blue
// ramp, changes in hue (not just lightness) help distinguish adjacent power levels, which some
// users find easier to read for busy/noisy spectra.
const VIRIDIS_RAMP = [
  [0, [68, 1, 84]],
  [0.13, [71, 44, 122]],
  [0.25, [59, 81, 139]],
  [0.38, [44, 113, 142]],
  [0.5, [33, 144, 141]],
  [0.63, [39, 173, 129]],
  [0.75, [92, 200, 99]],
  [0.88, [170, 220, 50]],
  [1, [253, 231, 37]],
];

function viridisColor(t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 0; i < VIRIDIS_RAMP.length - 1; i++) {
    const [t0, c0] = VIRIDIS_RAMP[i];
    const [t1, c1] = VIRIDIS_RAMP[i + 1];
    if (t >= t0 && t <= t1) {
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
    }
  }
  return VIRIDIS_RAMP[VIRIDIS_RAMP.length - 1][1];
}

function grayscaleColor(t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const v = Math.round(t * 255);
  return [v, v, v];
}

const COLORMAPS = {
  sequential: { label: "Blue (default)", fn: sequentialColor },
  viridis: { label: "Viridis", fn: viridisColor },
  grayscale: { label: "Grayscale", fn: grayscaleColor },
};

// Remembers the last values a user actually submitted in the add-sweep/add-receiver forms
// (start/stop/gain/frequencies/hop-interval/scroll-mode/dongle), so reopening the panel - or a
// page reload, which resets all in-memory JS state - doesn't reset a user's typical settings
// back to the hardcoded defaults every time. Scoped to localStorage (this browser only,
// survives reloads) rather than any server-side state, since these are pure UI conveniences,
// not something another client or an automation needs to see.
const SWEEP_FORM_PREFS_KEY = "sdr_hub_sweep_form_prefs";
const RECEIVER_FORM_PREFS_KEY = "sdr_hub_receiver_form_prefs";
const HELP_DISMISSED_KEY = "sdr_hub_help_dismissed";
const COLORMAP_KEY = "sdr_hub_colormap";
const DB_RANGE_KEY = "sdr_hub_db_range";
const FAVORITE_DEVICES_KEY = "sdr_hub_favorite_devices";
const DECODED_TIME_MODE_KEY = "sdr_hub_decoded_time_mode";
const DECODED_LOG_KEY = "sdr_hub_decoded_log";
const BATTERY_SOUND_ALERT_KEY = "sdr_hub_battery_sound_alert";
// Persists _deviceBatterySoundAlerted (the "already alerted for this low streak" set) on its
// own, deliberately independent of DECODED_LOG_KEY above - see saveBatterySoundAlerted()'s
// comment for why the 50-entry display log isn't a reliable source for this.
const BATTERY_SOUND_ALERTED_KEY = "sdr_hub_battery_sound_alerted";
// epoch-ms timestamp of the most recent "Clear log" click, or 0 if it's never been used.
// Deliberately a separate key from DECODED_LOG_KEY rather than folded into it - see
// _onStorageEvent's use of it for why a boundary *timestamp* (compared against each entry's own
// _receivedAt) is what actually lets a cross-tab clear coexist correctly with a same-instant
// decode, instead of the two tabs' writes racing to clobber each other outright.
const DECODED_LOG_CLEARED_AT_KEY = "sdr_hub_decoded_log_cleared_at";
// Every localStorage key this panel ever writes - used solely by _onResetPreferences() to wipe
// them all in one action, so that list and this one can't silently drift apart the way two
// independently-maintained copies could.
const ALL_PREF_KEYS = [
  SWEEP_FORM_PREFS_KEY,
  RECEIVER_FORM_PREFS_KEY,
  HELP_DISMISSED_KEY,
  COLORMAP_KEY,
  DB_RANGE_KEY,
  FAVORITE_DEVICES_KEY,
  DECODED_TIME_MODE_KEY,
  DECODED_LOG_KEY,
  BATTERY_SOUND_ALERT_KEY,
  BATTERY_SOUND_ALERTED_KEY,
  DECODED_LOG_CLEARED_AT_KEY,
];

function loadFormPrefs(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // JSON.parse happily succeeds on valid-but-useless values too - most importantly `null`
    // (e.g. from stale/manually-edited storage), which would otherwise flow straight into
    // _renderShell and blow up on `sweepPrefs.start_mhz`/`receiverPrefs.frequencies_mhz`.
    // Only a genuine object is usable as a prefs bag; anything else is as good as absent.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // corrupt/unavailable storage - fall back to hardcoded defaults, not a hard failure
  }
}

function saveFormPrefs(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // localStorage can throw (private browsing, quota exceeded) - losing this convenience isn't
    // worth failing the actual sweep/receiver submission over.
  }
}

function loadColormap() {
  try {
    const v = localStorage.getItem(COLORMAP_KEY);
    // Object.hasOwn (not just truthy COLORMAPS[v]) so a persisted value that happens to match an
    // inherited Object property name (e.g. "constructor", "toString") from manually-edited or
    // corrupted storage can't slip through and resolve to something without a usable `.fn`.
    return v && Object.hasOwn(COLORMAPS, v) ? v : "sequential";
  } catch {
    return "sequential";
  }
}

function saveColormap(v) {
  try {
    localStorage.setItem(COLORMAP_KEY, v);
  } catch {
    // Same unavailable-storage case as saveFormPrefs - losing this convenience isn't worth
    // failing the actual selection over.
  }
}

function loadDbRange() {
  try {
    const raw = localStorage.getItem(DB_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Guards the same corrupt/nonsensical-value cases as loadFormPrefs, plus a range that
    // wouldn't make sense to paint with (max <= min divides by <= 0 in _paintRow's t calc).
    if (parsed && Number.isFinite(parsed.min) && Number.isFinite(parsed.max) && parsed.max > parsed.min) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveDbRange(min, max) {
  try {
    localStorage.setItem(DB_RANGE_KEY, JSON.stringify({ min, max }));
  } catch {
    // See saveColormap above.
  }
}

// Identifies a decoded device by model+id (not the full JSON dump) so "favorite" survives
// across separate decode events from the same physical sensor, which is the whole point of
// pinning it - matches the same model/id fields _renderDecodedLog's filter already searches.
function deviceFavoriteKey(d) {
  return `${d.model || ""}|${d.id != null ? d.id : ""}`;
}

// Like deviceFavoriteKey, but also folds in `channel` - some device families (e.g. ones
// distinguished only by a channel dial/jumper) share the same model and omit `id` entirely, so
// deviceFavoriteKey's model|id alone would collide and let one sensor's healthy report overwrite
// another's still-low battery-state entry. Battery tracking needs the extra discriminator;
// deviceFavoriteKey itself is left as-is since it's pre-existing, shared with the favorites
// feature, and out of scope here.
function batteryStateKey(d) {
  return `${d.model || ""}|${d.id != null ? d.id : ""}|${d.channel != null ? d.channel : ""}`;
}

// Loads the persisted _deviceBatterySoundAlerted set (see its field comment) for a fresh
// SdrHubPanel instance - e.g. after a full page reload, which constructs a brand-new instance
// rather than reattaching the existing one, so in-memory-only state can't survive it. Restores
// *only* the sound-dedup set, never the live low-battery banner map (_deviceBatteryOk) - that
// map is intentionally left empty for a fresh instance/reconnect (mirroring what
// disconnectedCallback already does on a same-instance detach) because there's no way to know a
// persisted-as-low device hasn't actually recovered while this browser was closed/away; showing
// a banner built from that stale guess would risk it being wrong, possibly indefinitely if the
// device stops transmitting. A stale sound-dedup entry has no such visible downside - at worst
// it silently skips one alert for a device that happens to have (very recently) recovered and
// gone low again, which is a much smaller cost than restoring a live-looking but possibly-false
// banner. Deliberately its own key/array, not derived from the (capped at MAX_DECODED_LOG)
// decoded log - a device's low report can easily be the log's oldest surviving entry or already
// evicted from it entirely by 50 other devices' events, well before the low streak itself ends.
function loadBatterySoundAlerted() {
  try {
    const raw = localStorage.getItem(BATTERY_SOUND_ALERTED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveBatterySoundAlerted(set) {
  try {
    localStorage.setItem(BATTERY_SOUND_ALERTED_KEY, JSON.stringify([...set]));
  } catch {
    // Unavailable/quota-exceeded storage - losing this convenience isn't worth failing over.
  }
}

function loadFavoriteDevices() {
  try {
    const raw = localStorage.getItem(FAVORITE_DEVICES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavoriteDevices(set) {
  try {
    localStorage.setItem(FAVORITE_DEVICES_KEY, JSON.stringify([...set]));
  } catch {
    // See saveColormap above.
  }
}

function loadDecodedTimeMode() {
  try {
    return localStorage.getItem(DECODED_TIME_MODE_KEY) === "absolute" ? "absolute" : "relative";
  } catch {
    return "relative";
  }
}

function saveDecodedTimeMode(mode) {
  try {
    localStorage.setItem(DECODED_TIME_MODE_KEY, mode);
  } catch {
    // See saveColormap above.
  }
}

function loadDecodedLog() {
  try {
    const raw = localStorage.getItem(DECODED_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Only entries that still look like a real decoded_device event - a corrupted or
    // hand-edited value here would otherwise flow straight into _renderDecodedLog and blow up
    // on fields (device, _receivedAt) it assumes are always present.
    return parsed
      .filter((e) => e && typeof e === "object" && e.device && typeof e.device === "object" && Number.isFinite(e._receivedAt))
      .slice(0, MAX_DECODED_LOG);
  } catch {
    return [];
  }
}

function saveDecodedLog(log) {
  try {
    localStorage.setItem(DECODED_LOG_KEY, JSON.stringify(log.slice(0, MAX_DECODED_LOG)));
  } catch {
    // Unavailable/quota-exceeded storage - losing this convenience isn't worth failing over.
  }
}

function loadDecodedLogClearedAt() {
  try {
    const raw = localStorage.getItem(DECODED_LOG_CLEARED_AT_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function saveDecodedLogClearedAt(ts) {
  try {
    localStorage.setItem(DECODED_LOG_CLEARED_AT_KEY, String(ts));
  } catch {
    // See saveDecodedLog above.
  }
}

function loadBatterySoundEnabled() {
  try {
    return localStorage.getItem(BATTERY_SOUND_ALERT_KEY) === "true";
  } catch {
    return false;
  }
}

function saveBatterySoundEnabled(enabled) {
  try {
    localStorage.setItem(BATTERY_SOUND_ALERT_KEY, enabled ? "true" : "false");
  } catch {
    // See saveColormap above.
  }
}

function loadHelpDismissed() {
  try {
    // Some browsers/WebViews (notably with DOM storage disabled) throw a SecurityError just
    // from *touching* localStorage, not only on read of missing/corrupt data. This read runs
    // inside _renderShell() before `innerHTML` is assigned, so letting it throw would abort
    // the whole shell render and leave the panel blank. Default to showing the help card,
    // same as a first-time visitor, if storage isn't usable.
    return localStorage.getItem(HELP_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

// Quick-select shortcuts for common bands, so starting a typical sweep/receiver doesn't need
// looking up frequencies elsewhere first. Not exhaustive - just the bands a hobbyist RTL-SDR
// user is most likely to want immediately (broadcast/ISM bands rtl_433 and general SDR use
// commonly target), each independently verified against public band-plan references.
const SWEEP_PRESETS = [
  { label: "FM broadcast (88–108 MHz)", start_mhz: 88, stop_mhz: 108 },
  { label: "Airband VHF voice (118–137 MHz)", start_mhz: 118, stop_mhz: 137 },
  { label: "Marine VHF (156–163 MHz)", start_mhz: 156, stop_mhz: 163 },
  { label: "ISM 433 MHz (433.05–434.79 MHz)", start_mhz: 433.05, stop_mhz: 434.79 },
  { label: "ISM/SRD 868 MHz, EU (863–870 MHz)", start_mhz: 863, stop_mhz: 870 },
  { label: "ISM 915 MHz, US (902–928 MHz)", start_mhz: 902, stop_mhz: 928 },
  { label: "ADS-B (1089–1091 MHz)", start_mhz: 1089, stop_mhz: 1091 },
];
const RECEIVER_PRESETS = [
  { label: "ISM 433.92 MHz, EU", frequencies_mhz: "433.92" },
  { label: "ISM 868.3/868.95 MHz, EU", frequencies_mhz: "868.3,868.95" },
  { label: "ISM 915 MHz, US", frequencies_mhz: "915" },
  { label: "Car remotes 314.98/315 MHz, US", frequencies_mhz: "314.98,315" },
];

// rtl_433's own JSON already carries model/id/channel/time prominently, and mic/protocol/
// raw_message are internal decode-diagnostic fields, not something an end user reads - shown
// separately (model/id/channel/relative-time) or hidden entirely, not repeated in the field list.
const DECODED_HIDDEN_FIELDS = new Set(["time", "model", "id", "channel", "mic", "protocol", "raw_message"]);
// Per-field formatters for the handful of fields common enough across rtl_433 device types to
// be worth a nicer rendering than a bare "key: value" - not exhaustive, everything else falls
// back to the generic formatter below.
const DECODED_FIELD_FORMATTERS = {
  battery_ok: (v) => `Battery: ${v ? "OK" : "LOW"}`,
  temperature_C: (v) => `${v}°C`,
  temperature_F: (v) => `${v}°F`,
  humidity: (v) => `${v}% humidity`,
};

function fmtDecodedField(key, value) {
  const formatter = DECODED_FIELD_FORMATTERS[key];
  if (formatter) return formatter(value);
  return `${key.replace(/_/g, " ")}: ${value}`;
}

// True only when `field` is actually present on `obj` (own key, so a plain-object backup from
// JSON.parse) but holds something other than a finite number - e.g. a hand-edited sample_rate
// stored as a string, or null. An *absent* field is fine (the add-on applies its own default);
// a present-but-wrong-type one is a sign the entry doesn't mean what it looks like it means, so
// callers should reject the whole entry rather than silently dropping just this field and
// letting the default paper over the difference.
function invalidOptionalNumber(obj, field) {
  return Object.hasOwn(obj, field) && !Number.isFinite(obj[field]);
}

// Same reasoning as invalidOptionalNumber, for the one optional field that isn't a plain
// number: rtl_433's protocols filter (see addon/sdr_hub/app/models.py's `protocols: list[int]`)
// is a list of integer protocol ids, not just "an array" - a hand-edited `null` or a string
// would otherwise be silently dropped by the truthy-array check in _receiverImportPayload,
// falling through to add_receiver's default of decoding *all* protocols instead of the
// requested subset, while import still reports success.
function invalidOptionalProtocols(obj) {
  return Object.hasOwn(obj, "protocols") && !(Array.isArray(obj.protocols) && obj.protocols.every(Number.isInteger));
}

// Builds a copy-pasteable HA automation/script action snippet for a running sweep/receiver -
// bridges "ad-hoc thing I started from the panel" to "permanent thing an automation manages",
// without the user needing to look up the service's field names themselves.
function yamlQuoted(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlServiceCall(service, data) {
  const lines = [`service: ${service}`, "data:"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue; // e.g. an unset protocols filter - nothing worth exporting
      lines.push(`  ${key}: [${value.join(", ")}]`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`  ${key}: ${value}`);
    } else {
      lines.push(`  ${key}: ${yamlQuoted(value)}`);
    }
  }
  return lines.join("\n");
}

// Turns a single yamlServiceCall() block into one item of a YAML sequence (indenting every
// line after the first by 2 spaces so it nests correctly under the leading "- ") - used to
// combine several sweeps'/receivers' actions into one automation `action:` list, since a bare
// list of top-level "service:"/"data:" mappings back to back isn't valid YAML on its own.
function yamlAsListItem(yamlText) {
  return yamlText
    .split("\n")
    .map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`))
    .join("\n");
}

const WATERFALL_MIN_DB = -20;
const WATERFALL_MAX_DB = 60;
const WATERFALL_HEIGHT = 400;
// A row's strongest bin only counts as a "peak" worth marking if it clears the row's own
// median by this many dB - a fixed absolute dB floor would need per-device/gain calibration
// (noise floor varies a lot), but "stands out from this row's own noise" doesn't.
const PEAK_MIN_DELTA_DB = 6;
// "Keep full history (scrollable)" mode caps retained rows by a memory budget rather than a
// fixed row count - row width varies enormously by sweep range (a narrow sweep might be a
// few hundred points, a full 24-1764MHz sweep ~8192 after downsampling), and a fixed count
// either wastes the budget on narrow sweeps (retaining far less time than the memory could
// afford - confirmed live: a narrow ~60ms/row sweep hit a 1000-row cap at almost exactly one
// minute) or blows it on wide ones. 200MB retained history is generous for a browser tab
// while still bounding worst case.
const SCROLL_HISTORY_BUDGET_BYTES = 200 * 1024 * 1024;
const MIN_SCROLL_ROWS = 100; // floor even for a pathologically wide row, so it's never useless
// Browsers cap a single <canvas> dimension well below what the memory budget alone would allow
// for a narrow sweep (e.g. a ~500-bin sweep's budget-derived cap is ~50k rows) - exceeding it
// doesn't throw, it silently makes the canvas unusable (clears/fails to draw), which would look
// exactly like the "history gets lost" bug this budget was introduced to fix. 16384px is
// comfortably under the documented/tested limit in every major engine (Chromium, Firefox,
// Safari all support at least this on both axes), so cap by it in addition to the memory budget.
const MAX_CANVAS_HEIGHT_PX = 16384;
// A height-only cap still lets a *wide* sweep produce a canvas whose total pixel area is too
// big for mobile WebKit even though neither side alone hits MAX_CANVAS_HEIGHT_PX - e.g. an
// 8192-bin sweep's memory-budget cap alone allows ~3200 rows, an 8192x3200 (~26Mpx) canvas,
// which exceeds the ~16Mpx (4096x4096) area iOS Safari/HA Companion WebViews are documented to
// reliably support regardless of per-side limits. Bound the row cap by area too, not just height.
const MAX_CANVAS_AREA_PX = 4096 * 4096;
const scrollRowCapForWidth = (width) => {
  const memoryCap = Math.floor(SCROLL_HISTORY_BUDGET_BYTES / (width * 8));
  const areaCap = Math.floor(MAX_CANVAS_AREA_PX / Math.max(1, width));
  return Math.max(MIN_SCROLL_ROWS, Math.min(MAX_CANVAS_HEIGHT_PX, memoryCap, areaCap));
};
const MAX_DECODED_LOG = 50;
// Bounds _deviceBatteryOk (see its field comment) - only entries for currently-low devices are
// kept (a recovery deletes its entry outright), but a cap still guards against a misbehaving
// add-on or a receiver observing many changing/unique ids from filling the map without limit.
const MAX_TRACKED_LOW_BATTERY_DEVICES = 100;

class SdrHubPanel extends HTMLElement {
  constructor() {
    super();
    this._state = { devices: [], receivers: [], sweeps: [] };
    // sweep_id -> [SweepRow, ...] newest-first. Capped at WATERFALL_HEIGHT normally, or
    // scrollRowCapForWidth(width) while "keep full history" is checked for that sweep - either
    // way this is what hover reads from, and what a rerender replays into a freshly (re)created canvas.
    this._sweepRowHistory = {};
    this._scrollMode = {}; // sweep_id -> bool, "keep full history (scrollable)" toggle
    this._scrollDrawIndex = {}; // sweep_id -> next unused row slot in scroll-mode canvas
    this._viewportHeight = {}; // sweep_id -> user-dragged visible px height, else WATERFALL_HEIGHT
    // most-recent-first - restored from localStorage so a page reload doesn't lose recent
    // activity. Filtered against the persisted clear boundary as defense in depth against a
    // cross-tab clear-vs-decode race (see _onStorageEvent) having left pre-clear entries in a
    // composite write - a normal, race-free save never contains any post-clear.
    this._decodedLogClearedAt = loadDecodedLogClearedAt();
    this._decodedLog = loadDecodedLog().filter((e) => e._receivedAt > this._decodedLogClearedAt);
    // batteryStateKey(device) -> {ok:false, model, id} for currently-low devices only, tracked
    // independently of _decodedLog so a device that reported low battery and then went silent
    // (falling off the capped log once enough *other* devices decode) doesn't have its alert
    // silently cleared - it's only cleared by an actual battery_ok:true recovery event, never by
    // the log simply rolling past it. Recovered/healthy devices are deleted rather than stored
    // (see _handleEvent), and MAX_TRACKED_LOW_BATTERY_DEVICES bounds the rest, so this can't grow
    // without limit the way naively caching every seen device's state would. Deliberately starts
    // empty even on a freshly constructed instance (e.g. right after a full page reload) rather
    // than being seeded from persisted state the way _deviceBatterySoundAlerted below is - there
    // is no way to know whether a device that was last reported low has since recovered while
    // this browser was away/closed, and showing a banner built from that stale guess risks it
    // being wrong, possibly indefinitely if the device stops transmitting. This mirrors what
    // disconnectedCallback already does to this same map on an ordinary same-instance detach.
    this._deviceBatteryOk = new Map();
    // batteryStateKey(device) -> true for devices already alerted-on for their *current* low
    // streak. Deliberately separate from, and NOT cleared alongside, _deviceBatteryOk in
    // disconnectedCallback: that map is wiped on detach because there's no authoritative
    // snapshot to reconcile the *banner* against on reconnect, but wiping this one too would
    // mean the very next low report for a device that was already known-low (e.g. from ordinary
    // dashboard navigation away and back, or an HA reload) re-plays the sound even though the
    // device never actually recovered - see the wasAlreadyLow check in _handleEvent. Only an
    // actual battery_ok:true recovery event clears an entry here. Unlike _deviceBatteryOk above,
    // this IS seeded from persisted state (loadBatterySoundAlerted(), saved on every change - see
    // its own comment for why that's a separate key rather than derived from _decodedLog) even
    // on a freshly constructed instance - a stale dedup entry has no risky "looks live but might
    // be wrong" downside the way a restored banner would, so there's nothing to lose by trusting it.
    this._deviceBatterySoundAlerted = loadBatterySoundAlerted();
    this._decodedFilter = ""; // lowercased substring match against model/id, "" = show all
    this._sweepFilter = ""; // lowercased substring match against label/dongle/frequency, "" = show all
    this._receiverFilter = ""; // same as _sweepFilter, for the receivers list
    this._decodedTimeMode = loadDecodedTimeMode(); // "relative" ("-Xs" ago) or "absolute" (wall-clock)
    this._favoriteDevices = loadFavoriteDevices(); // Set of "model|id" - pinned to top of the decoded log
    // deviceFavoriteKey of the most recently arrived decoded_device event for a favorited
    // device, or null - consumed (cleared) the next time _renderDecodedLog() draws it, so a
    // favorite only flashes once per new decode rather than on every unrelated re-render.
    this._flashDeviceKey = null;
    this._connectionStatus = "connected"; // "connected" | "disconnected" - see _wireConnectionStatus
    this._connListenersWired = false;
    this._batterySoundEnabled = loadBatterySoundEnabled();
    this._audioCtx = null; // lazily created on first alert - see _playBatteryAlertSound
    // Whether a one-time gesture-unlock listener (see _wireAudioUnlock) is currently attached.
    // Needed on top of the sound-toggle's own change handler because the checkbox restoring as
    // *already checked* (a persisted preference) fires no "change" event at all - without this,
    // a fresh session that starts with the sound pref already enabled would never get a
    // gesture-initiated AudioContext, and the first low-battery alert (arriving from a
    // gesture-less WS event) would silently produce no sound on browsers/WebViews that require
    // gesture-initiated Web Audio. Reset to false in disconnectedCallback (which also closes
    // _audioCtx) so a detach/reattach re-arms it - the closed context needs a fresh gesture too.
    this._audioUnlockWired = false;
    // Whether the cross-tab storage listener (see _wireStorageSync - reconciles this tab's
    // in-memory state when another open SDR Hub tab either resets preferences or updates the
    // decoded log) is currently attached - same re-arm-on-reattach reasoning as _audioUnlockWired
    // above, since it's a page-wide `window` listener, not a per-element one.
    this._storageSyncWired = false;
    this._colormap = loadColormap();
    const dbRange = loadDbRange();
    this._dbMin = dbRange ? dbRange.min : WATERFALL_MIN_DB;
    this._dbMax = dbRange ? dbRange.max : WATERFALL_MAX_DB;
    this._unsub = null;
    this._subscribing = false;
    this._loadStateRequestId = 0; // guards against overlapping _loadState() calls resolving out of order
    this._renderedSweepIdsKey = null; // last-rendered sweep id set, to skip redundant canvas rebuilds
    this._renderedSweepStatusKey = null;
    this._decodedAgeInterval = null; // re-renders decoded-log relative ages even when decoding goes quiet
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._renderShell();
      this._loadState();
      this._subscribe();
      this._wireConnectionStatus();
      if (!this._decodedAgeInterval) {
        this._decodedAgeInterval = setInterval(() => this._renderDecodedLog(), 30000);
      }
    }
  }

  // hass.connection (home-assistant-js-websocket's Connection) is the underlying WS link to HA
  // itself - separate from, and a layer below, this panel's own sdr_hub/subscribe message
  // stream (which the library transparently re-subscribes on reconnect, so _unsub/_subscribing
  // alone never surface a drop to the user). "ready"/"disconnected" are that library's own
  // connection-lifecycle events - wiring them here is what lets the header badge reflect an
  // actual live-or-not state instead of just staying "connected" forever after the first render.
  // Called from the hass setter's `first` branch, and again from connectedCallback after a
  // detach where disconnectedCallback tore these down (mirrors _subscribe()'s own re-wiring) -
  // guarded by _connListenersWired in both places, since hass.connection is a page-wide
  // singleton the panel doesn't own and re-wiring while already wired would accumulate
  // duplicate listeners that never get removed.
  _wireConnectionStatus() {
    this._onConnReady = () => {
      this._connectionStatus = "connected";
      this._renderConnectionStatus();
    };
    this._onConnDisconnected = () => {
      this._connectionStatus = "disconnected";
      this._renderConnectionStatus();
    };
    this._hass.connection.addEventListener("ready", this._onConnReady);
    this._hass.connection.addEventListener("disconnected", this._onConnDisconnected);
    this._connListenersWired = true;
    this._connectionStatus = this._hass.connection.connected ? "connected" : "disconnected";
    this._renderConnectionStatus();
  }

  _renderConnectionStatus() {
    const el = this.querySelector("#sdr-hub-connection-status");
    if (!el) return;
    const connected = this._connectionStatus === "connected";
    el.textContent = connected ? "● Live" : "● Reconnecting…";
    el.style.color = connected ? "var(--success-color,#4caf50)" : "var(--warning-color,#ff9800)";
  }

  set panel(panel) {
    this._panel = panel;
  }

  // Covers the case _ensureAudioContextRunning() calls from the sound-toggle's own "change"
  // handler can't: a sound preference that was already enabled *before* this session (restored
  // from localStorage in the constructor) never fires that handler at all, so without this the
  // AudioContext would only ever get created/resumed from the alert path itself - a WS event
  // with no gesture attached, which some browsers/HA WebViews silently refuse to actually play
  // audio from. Listens once for the *first* click/tap or keypress anywhere in the panel (normal
  // use of nearly every control here - buttons, checkboxes, inputs - counts as a qualifying
  // gesture) and uses it to unlock audio if the sound pref happens to be enabled at that moment.
  // Re-armed (see _audioUnlockWired's field comment) after every detach/reattach, since
  // disconnectedCallback closes any previously-unlocked context.
  _wireAudioUnlock() {
    if (this._audioUnlockWired) return;
    this._audioUnlockWired = true;
    this._audioUnlockAbort = new AbortController();
    const unlock = () => {
      if (this._batterySoundEnabled) this._ensureAudioContextRunning();
      this._audioUnlockAbort.abort();
    };
    const opts = { signal: this._audioUnlockAbort.signal };
    this.addEventListener("pointerdown", unlock, opts);
    this.addEventListener("keydown", unlock, opts);
  }

  // Mirrors _wireAudioUnlock's re-arm-on-reattach handling for the `window`-level "storage"
  // event listener below - see _storageSyncWired's field comment for why this needs its own
  // guarded wire/unwire pair rather than being set up once forever.
  _wireStorageSync() {
    if (this._storageSyncWired) return;
    this._storageSyncWired = true;
    this._onStorageEvent = (ev) => {
      // "storage" only ever fires in *other* tabs/documents than the one that made the change
      // (per spec), never the tab that called setItem/removeItem/clear itself - so everything
      // below is specifically about reconciling this tab's in-memory state with a change some
      // *other* open SDR Hub tab just made.
      if (ev.storageArea !== localStorage) return;
      // ev.key === null means localStorage.clear() was used rather than an individual
      // removeItem() call; either way, a key this panel cares about being removed elsewhere means
      // this tab's in-memory state (_decodedLog, _favoriteDevices, etc.) is now stale - most
      // importantly, this tab's next decoded_device event would otherwise call saveDecodedLog()
      // with that stale in-memory log and silently resurrect the exact history the other tab's
      // reset just cleared. Reloading (matching _onResetPreferences()'s own approach) is the
      // simplest way to guarantee this tab picks up the reset instead of racing it.
      if (ev.newValue === null && (ev.key === null || ALL_PREF_KEYS.includes(ev.key))) {
        location.reload();
        return;
      }
      // Another tab's "Clear log" click, propagated via the boundary *timestamp* it wrote
      // (DECODED_LOG_CLEARED_AT_KEY) rather than by trying to adopt its literal `[]` write to
      // DECODED_LOG_KEY. An empty-array-write approach (tried in an earlier round) couldn't be
      // made race-safe: every open tab independently subscribes to and receives the same
      // decoded_device broadcast over its own WebSocket connection, so a regular new-entry write
      // in tab A racing a clear in tab B is a real, unavoidable case - either direction of "trust
      // whichever write arrives/looks newer" can end up discarding a legitimate decode or
      // resurrecting cleared history, because a bare array value carries no ordering information
      // relative to entries already sitting in another tab's in-memory log. A boundary timestamp
      // sidesteps that: instead of asking "which whole-array write wins", each tab independently
      // filters its own in-memory log down to entries strictly newer than the latest known clear,
      // using each entry's own _receivedAt - so a decode that's genuinely newer than the clear
      // always survives regardless of write ordering, and anything genuinely older never does.
      if (ev.key === DECODED_LOG_CLEARED_AT_KEY && ev.newValue) {
        const clearedAt = Number(ev.newValue);
        if (Number.isFinite(clearedAt) && clearedAt > this._decodedLogClearedAt) {
          this._decodedLogClearedAt = clearedAt;
          this._decodedLog = this._decodedLog.filter((e) => e._receivedAt > clearedAt);
          this._renderDecodedLog();
        }
      }
    };
    window.addEventListener("storage", this._onStorageEvent);
  }

  connectedCallback() {
    if (!this._hass) return;
    if (!this.querySelector("#sdr-hub-root")) this._renderShell();
    // hass's own "first assignment" branch only fires once ever, but HA can detach and
    // reattach this same element (e.g. navigating away and back) without recreating it —
    // disconnectedCallback already tore down the subscription, so without this a
    // reconnected panel would silently show static (stale) state with no live updates.
    // Guarded by _subscribing (not just _unsub) since connectedCallback can fire while the
    // very first _subscribe() call (from the hass setter) is still awaiting its result -
    // _unsub isn't assigned until that resolves, so checking only _unsub let both callers
    // race into a second, duplicate subscription (confirmed live: rows arrived at ~2x the
    // add-on's actual broadcast rate, evicting "keep full history" mode's capped buffer
    // twice as fast as it should).
    // Reload the persisted sound-dedup set on every connectedCallback, not just once in the
    // constructor, and deliberately *outside*/independent of the `!_subscribing` branch below -
    // disconnectedCallback tears down both the WS subscription and the storage listener on every
    // detach, including one where _subscribe() had a call still in flight (_subscribing already
    // true), which leaves that branch a no-op on this reattach even though the listeners were
    // still torn down for its whole duration. While detached this instance misses both a live
    // battery_ok:true recovery from the add-on AND another tab's own recovery-driven update to
    // BATTERY_SOUND_ALERTED_KEY. Retaining the stale in-memory Set across the reattach would keep
    // treating an already-recovered device as "already alerted", silently skipping the alert for
    // its next real low report even though the recovery was in fact observed (by another tab, or
    // would have been by this one had it stayed connected) and already persisted.
    this._deviceBatterySoundAlerted = loadBatterySoundAlerted();
    if (!this._unsub && !this._subscribing) {
      this._loadState();
      this._subscribe();
    }
    // _renderDecodedLog otherwise only reruns when a new decoded_device event arrives - if
    // decoding goes quiet, the last card's "-Ns" age would silently freeze (or read "-0s")
    // forever instead of counting up. A lightweight periodic re-render keeps it live without
    // needing a full _loadState() round-trip.
    if (!this._decodedAgeInterval) {
      this._decodedAgeInterval = setInterval(() => this._renderDecodedLog(), 30000);
    }
    // Mirrors the _unsub re-wiring above - disconnectedCallback tore these down too, so a
    // detach-then-reattach (same instance) needs them re-wired or the badge would stop tracking
    // future connection drops/recoveries after the first reattach.
    if (!this._connListenersWired) this._wireConnectionStatus();
    // Mirrors the _connListenersWired re-wiring above - both are guarded internally (a fresh
    // _renderShell() above may have already wired them for a from-scratch reattach), and both
    // need re-arming after a same-instance detach/reattach where the shell itself wasn't rebuilt.
    this._wireAudioUnlock();
    this._wireStorageSync();
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    if (this._decodedAgeInterval) {
      clearInterval(this._decodedAgeInterval);
      this._decodedAgeInterval = null;
    }
    // hass.connection outlives this element (it's HA-wide, not per-panel) - these listeners
    // must be removed on detach or a truly destroyed/GC'd panel instance would otherwise leave
    // its handlers permanently registered on that shared object.
    if (this._connListenersWired) {
      this._hass.connection.removeEventListener("ready", this._onConnReady);
      this._hass.connection.removeEventListener("disconnected", this._onConnDisconnected);
      this._connListenersWired = false;
    }
    if (this._audioCtx) {
      this._audioCtx.close();
      this._audioCtx = null;
    }
    // The closed context above needs a fresh user gesture to unlock again on reattach - tear
    // down and clear the guard so connectedCallback's _wireAudioUnlock() re-adds the listener
    // rather than seeing it as already wired and no-op'ing.
    if (this._audioUnlockAbort) {
      this._audioUnlockAbort.abort();
      this._audioUnlockAbort = null;
    }
    this._audioUnlockWired = false;
    // window.addEventListener("storage", ...) outlives this element the same way
    // hass.connection's listeners do - remove it on detach, and clear the guard so a reattach
    // re-wires it instead of leaving this instance silently unsynced with other tabs.
    if (this._storageSyncWired) {
      window.removeEventListener("storage", this._onStorageEvent);
      this._storageSyncWired = false;
    }
    // _deviceBatteryOk is populated purely from the decoded_device event stream - there's no
    // authoritative server-side battery snapshot in get_state to reconcile against on
    // reconnect. A device can recover while this subscription is torn down, and that missed
    // recovery would otherwise leave a stale low-battery entry (and banner) showing
    // indefinitely until, by chance, that exact device reports again. Clearing here means a
    // reconnect starts from a clean slate instead of asserting possibly-stale state.
    // _deviceBatterySoundAlerted is deliberately NOT cleared here - see its field comment. The
    // banner (above) is fine starting blank again since it'll repopulate from the very next low
    // report either way, but doing the same for the sound-dedup set would re-play the alert for
    // an already-known-low device on every ordinary detach/reattach even though it never
    // actually recovered.
    this._deviceBatteryOk.clear();
    this._renderBatteryAlerts();
  }

  async _callWS(message) {
    return this._hass.callWS(message);
  }

  async _subscribe() {
    if (this._unsub || this._subscribing) return; // already subscribed, or another call is in flight
    this._subscribing = true; // set synchronously, before the await below, to close that race
    try {
      const unsub = await this._hass.connection.subscribeMessage(
        (event) => this._handleEvent(event),
        { type: "sdr_hub/subscribe" },
      );
      if (!this.isConnected) {
        // The element detached while this subscribe was still in flight - disconnectedCallback
        // already ran and found _unsub still null (nothing to call yet), so nothing tore this
        // subscription down. Cancel it now instead of storing it, or it lives on in the
        // background (still accumulating "keep full history" rows) until the whole HA page
        // is reloaded.
        unsub();
        return;
      }
      this._unsub = unsub;
    } catch (err) {
      this._showError(`Could not subscribe to live updates: ${err.message || err}`);
    } finally {
      this._subscribing = false;
    }
  }

  async _loadState(forceRebuildSweeps = false) {
    // Two _loadState() calls can overlap (e.g. the initial load racing with the reload
    // triggered right after submitting one of the forms) and their WS responses can resolve
    // out of order. Only the response for the most recently *started* call is allowed to
    // apply - otherwise a stale response arriving last would overwrite newer state, making an
    // already-created/removed receiver or sweep flicker back until the next state event or the
    // 30s poll corrects it.
    const requestId = ++this._loadStateRequestId;
    let state;
    try {
      state = await this._callWS({ type: "sdr_hub/get_state" });
    } catch (err) {
      // The request-id guard below only runs on the success path - without checking it here
      // too, an older call that fails *after* a newer call already succeeded would still show
      // this error, even though the latest state is already rendered correctly.
      if (requestId !== this._loadStateRequestId) return; // superseded by a newer call
      this._showError(`Could not load SDR Hub state: ${err.message || err}`, { isLoadError: true });
      return;
    }
    if (requestId !== this._loadStateRequestId) return; // superseded by a newer call
    // Recovered from a prior load failure - clear its banner now that fresh state actually
    // arrived. Only do this if the banner currently showing IS that load error (the flag
    // reflects whichever _showError call ran most recently) so an unrelated, still-relevant
    // action error isn't wiped out just because this background refresh happened to succeed.
    if (this._loadStateErrorShowing) this._showError("");
    this._state = state;
    this._renderDongles();
    this._renderCoverage();
    this._renderSweeps(forceRebuildSweeps);
    this._renderReceivers();
  }

  _handleEvent(event) {
    if (event.type === "sweep_row") {
      event._receivedAt = Date.now(); // client-side only, for the time axis - the add-on doesn't send one
      const rows = (this._sweepRowHistory[event.sweep_id] ??= []);
      rows.unshift(event);
      // Switching a sweep to "keep full history" only stops future rows being discarded -
      // it can't retroactively recover rows already trimmed off while in live (capped) mode.
      const cap = this._scrollMode[event.sweep_id]
        ? scrollRowCapForWidth(event.power_db.length)
        : WATERFALL_HEIGHT;
      if (rows.length > cap) rows.length = cap;
      this._appendRow(event.sweep_id, event);
      this._renderTimeAxis(event.sweep_id);
    } else if (event.type === "decoded_device") {
      event._receivedAt = Date.now(); // client-side only, for the relative-time label
      this._decodedLog.unshift(event);
      if (this._decodedLog.length > MAX_DECODED_LOG) this._decodedLog.length = MAX_DECODED_LOG;
      // Update the persistent battery-state map before it can be trimmed off the log above -
      // see the field comment on _deviceBatteryOk for why this can't just be derived from
      // _decodedLog at render time.
      const decodedDevice = event.device || {};
      // A fresh decode from a pinned device gets a one-shot flash (consumed and cleared by
      // _renderDecodedLog on its next draw) - only for favorites, since flashing every incoming
      // event regardless of relevance would be noise for exactly the users this is meant to help
      // (someone watching one specific sensor among a lot of unrelated traffic).
      const favKey = deviceFavoriteKey(decodedDevice);
      if (this._favoriteDevices.has(favKey)) this._flashDeviceKey = favKey;
      if (Object.hasOwn(decodedDevice, "battery_ok")) {
        const key = batteryStateKey(decodedDevice);
        if (decodedDevice.battery_ok) {
          // Recovered (or was never low) - nothing to alert on, so drop any stored entry
          // rather than keeping a growing pile of healthy devices around forever. Also clears
          // the sound-dedup entry - a real recovery is the only thing that should re-arm the
          // alert for this device's next low report.
          this._deviceBatteryOk.delete(key);
          this._deviceBatterySoundAlerted.delete(key);
        } else {
          // Checked against _deviceBatterySoundAlerted, not _deviceBatteryOk - the latter is
          // cleared on every panel detach/reconnect (see its field comment), which would
          // otherwise make a same-still-low device's next report always look "newly low" again
          // after ordinary dashboard navigation. Only an actual battery_ok:true recovery (above)
          // clears the sound-dedup entry.
          const wasAlreadyLow = this._deviceBatterySoundAlerted.has(key);
          // Delete-then-add (not a plain add on an existing key, which Set leaves in its
          // original position) so this set's iteration order tracks _deviceBatteryOk's own
          // delete-then-set below - both need to agree on which device is "oldest" for their
          // eviction loops (this one, and _deviceBatteryOk's further down) not to disagree and
          // evict two *different* devices, which could otherwise drop a still-actively-reporting
          // device's dedup entry while an actually-stale one is retained, letting the sound
          // replay for a device that's still low without ever having recovered.
          this._deviceBatterySoundAlerted.delete(key);
          this._deviceBatterySoundAlerted.add(key);
          // Bounded independently of _deviceBatteryOk's own eviction loop below - that one only
          // fires based on _deviceBatteryOk's size, but disconnectedCallback clears
          // _deviceBatteryOk (not this set) on every detach, so over many detach/reattach or
          // stream-gap cycles this set could otherwise accumulate more than
          // MAX_TRACKED_LOW_BATTERY_DEVICES stale keys from earlier cycles without ever hitting
          // that loop's condition.
          while (this._deviceBatterySoundAlerted.size > MAX_TRACKED_LOW_BATTERY_DEVICES) {
            this._deviceBatterySoundAlerted.delete(this._deviceBatterySoundAlerted.values().next().value);
          }
          // Delete-then-set (rather than a plain set on an existing key) moves this entry to
          // the end of the Map's iteration order, so the eviction below reliably drops the
          // *oldest* still-low device first when the bound is exceeded.
          this._deviceBatteryOk.delete(key);
          this._deviceBatteryOk.set(key, {
            ok: false,
            model: decodedDevice.model,
            id: decodedDevice.id,
            channel: decodedDevice.channel,
          });
          while (this._deviceBatteryOk.size > MAX_TRACKED_LOW_BATTERY_DEVICES) {
            const evicted = this._deviceBatteryOk.keys().next().value;
            this._deviceBatteryOk.delete(evicted);
            this._deviceBatterySoundAlerted.delete(evicted);
          }
          if (!wasAlreadyLow && this._batterySoundEnabled) this._playBatteryAlertSound();
        }
        // Persisted independently of, and every time it changes alongside, _decodedLog below -
        // see loadBatterySoundAlerted()'s comment for why this can't just be reconstructed from
        // that (capped, unrelated-purpose) log on the next fresh instance.
        saveBatterySoundAlerted(this._deviceBatterySoundAlerted);
      }
      saveDecodedLog(this._decodedLog);
      this._renderDecodedLog();
    } else if (event.type === "status" || event.type === "state_changed") {
      // A receiver/sweep died, or something else changed the add-on's state from outside
      // this panel (an automation service call, another open panel) - reload the
      // authoritative snapshot rather than hand-patch local state.
      this._loadState();
    } else if (event.type === "stream_reconnected" || event.type === "stream_gap") {
      // stream_reconnected: the coordinator's own WS connection to the add-on dropped and just
      // reconnected - see coordinator.py's ws_loop for why it sends this. This panel element
      // can stay attached to HA the whole time that happens (unlike disconnectedCallback's
      // reconnect case above, which only covers *this panel* detaching).
      // stream_gap: the connection never dropped, but the add-on's per-client send queue filled
      // (a slow consumer, or a burst of sweep_row messages) and had to silently discard an
      // older, still-unsent message to bound memory - see broadcaster.py's broadcast(). Either
      // way, an event may have been lost, so discard event-derived state that may have missed
      // an update (e.g. a low-battery device's recovery) rather than keep asserting what's now
      // possibly stale.
      this._deviceBatteryOk.clear();
      this._renderBatteryAlerts();
      this._loadState();
    }
  }

  _showError(message, { isLoadError = false } = {}) {
    const el = this.querySelector("#sdr-hub-error");
    if (!el) return;
    // Tracks whether the *currently displayed* error is specifically a get_state load
    // failure, so a later successful reload can clear just that one - without this, an
    // unrelated action error (e.g. "could not start sweep") showing would get silently wiped
    // out the next time a background state refresh happens to succeed, even though the user
    // still needs to see it. Whichever call to _showError ran most recently determines this.
    this._loadStateErrorShowing = isLoadError && !!message;
    el.textContent = message;
    el.style.display = message ? "block" : "none";
  }

  // ── shell ────────────────────────────────────────────────────────────────

  _renderShell() {
    // Recreates #sdr-hub-sweeps as empty - invalidate the cached "already rendered" keys used
    // by _renderSweeps()'s no-op-refresh skip, or the next _renderSweeps() call would see an
    // unchanged sweep id set and wrongly conclude the (now-empty) container is already
    // populated, leaving the sweep list permanently blank after a shell rebuild.
    this._renderedSweepIdsKey = null;
    this._renderedSweepStatusKey = null;
    // Same invalidation, same reason, for _renderReceivers()'s analogous no-op-refresh skip -
    // #sdr-hub-receivers is about to be recreated empty by this shell rebuild below.
    this._renderedReceiverIdsKey = null;
    this._renderedReceiverStatusKey = null;
    // Same invalidation, same reason, for _renderBatteryAlerts()'s unchanged-message skip -
    // #sdr-hub-battery-alert is about to be recreated empty by this shell rebuild below.
    this._lastBatteryAlertMessage = null;
    const sweepPrefs = loadFormPrefs(SWEEP_FORM_PREFS_KEY);
    const receiverPrefs = loadFormPrefs(RECEIVER_FORM_PREFS_KEY);
    // "Dismissed" only skips showing it by default on load - the Help button in the header
    // always reopens it, so dismissing is never a one-way door for a first-time user who
    // dismissed too quickly or wants a refresher later.
    const helpDismissed = loadHelpDismissed();
    this.innerHTML = `
      <style>
        /* Settles at the same rgba(245,166,35,.1) resting background a favorited decoded-device
           card already gets - see _renderDecodedLog - so the flash reads as "this card just got
           brighter for a moment" rather than ending on a visibly different steady state. */
        @keyframes sdr-hub-flash {
          0% { background-color: rgba(245,166,35,.6); }
          100% { background-color: rgba(245,166,35,.1); }
        }
      </style>
      <div id="sdr-hub-root" style="padding:16px;max-width:960px;margin:0 auto;font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <h1 style="font-size:1.4rem;margin:0;color:var(--primary-text-color,#212121);">SDR Hub</h1>
            <span id="sdr-hub-connection-status" role="status" style="font-size:.8rem;font-weight:600;"></span>
          </div>
          <button data-show-help style="${BTN_SECONDARY}">Help</button>
        </div>
        <div id="sdr-hub-help" style="${CARD};display:${helpDismissed ? "none" : "block"};">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Getting started</h2>
          <ul style="margin:0 0 12px;padding-left:20px;font-size:.9rem;line-height:1.6;">
            <li><strong>Dongles</strong> — attached SDR hardware and what's currently using each one.</li>
            <li><strong>Band coverage</strong> — an at-a-glance view of which frequencies are currently being watched.</li>
            <li><strong>Wideband sweeps</strong> — a live spectrum waterfall across a frequency range you pick.</li>
            <li><strong>Receivers (rtl_433)</strong> — decodes known device protocols (weather stations, sensors, remotes) at specific frequencies.</li>
            <li><strong>Decoded devices</strong> — a log of what receivers have actually decoded.</li>
          </ul>
          <button data-dismiss-help style="${BTN}">Got it, don't show again</button>
        </div>
        <div id="sdr-hub-error" style="display:none;color:var(--error-color,#db4437);margin-bottom:12px;"></div>
        <div id="sdr-hub-battery-alert" role="alert" aria-live="assertive" style="display:none;background:rgba(219,68,55,.08);border:1px solid var(--error-color,#db4437);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.9rem;color:var(--primary-text-color,#212121);"></div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Dongles</h2>
          <div id="sdr-hub-dongles"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Band coverage</h2>
          <div id="sdr-hub-coverage"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Wideband sweeps</h2>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
            <label style="${LABEL}">Colormap<select id="sdr-hub-colormap" style="${INPUT}">
              ${Object.entries(COLORMAPS)
                .map(([key, cm]) => `<option value="${key}" ${key === this._colormap ? "selected" : ""}>${esc(cm.label)}</option>`)
                .join("")}
            </select></label>
            <label style="${LABEL}">Contrast min dB<input id="sdr-hub-db-min" type="number" step="1" value="${esc(this._dbMin)}" style="${INPUT};width:90px"></label>
            <label style="${LABEL}">Contrast max dB<input id="sdr-hub-db-max" type="number" step="1" value="${esc(this._dbMax)}" style="${INPUT};width:90px"></label>
          </div>
          <form id="sdr-hub-add-sweep" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
            <label style="${LABEL}">Preset<select name="preset" data-preset-select style="${INPUT}">
              <option value="">Custom</option>
              ${SWEEP_PRESETS.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join("")}
            </select></label>
            <label style="${LABEL}">Dongle<select name="dongle_serial" style="${INPUT}"></select></label>
            <label style="${LABEL}">Start MHz<input name="start_mhz" type="number" step="0.001" value="${esc(sweepPrefs.start_mhz ?? 88)}" style="${INPUT};width:100px"></label>
            <label style="${LABEL}">Stop MHz<input name="stop_mhz" type="number" step="0.001" value="${esc(sweepPrefs.stop_mhz ?? 108)}" style="${INPUT};width:100px"></label>
            <label style="${LABEL}">Gain dB<input name="gain" type="number" step="0.1" value="${esc(sweepPrefs.gain ?? 30)}" style="${INPUT};width:80px"></label>
            <label style="${LABEL}">Label (optional)<input name="label" placeholder="e.g. FM stations" style="${INPUT};width:140px"></label>
            <label style="${LABEL};display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" name="scroll_mode" ${sweepPrefs.scroll_mode ? "checked" : ""}> Keep full history (scrollable)
            </label>
            <button type="submit" style="${BTN}">Start sweep</button>
          </form>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input id="sdr-hub-sweep-filter" type="text" aria-label="Filter sweeps by label, dongle, or frequency" placeholder="Filter by label, dongle, or frequency…" style="${INPUT};flex:1;box-sizing:border-box;">
            <button id="sdr-hub-stop-all-sweeps" type="button" style="${BTN_DANGER};white-space:nowrap;">Stop all</button>
          </div>
          <div id="sdr-hub-sweeps"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Receivers (rtl_433)</h2>
          <form id="sdr-hub-add-receiver" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
            <label style="${LABEL}">Preset<select name="preset" data-preset-select style="${INPUT}">
              <option value="">Custom</option>
              ${RECEIVER_PRESETS.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join("")}
            </select></label>
            <label style="${LABEL}">Dongle<select name="dongle_serial" style="${INPUT}"></select></label>
            <label style="${LABEL}">Frequencies MHz (comma-separated)<input name="frequencies_mhz" value="${esc(receiverPrefs.frequencies_mhz ?? "433.92")}" style="${INPUT};width:180px"></label>
            <label style="${LABEL}">Hop interval s<input name="hop_interval_s" type="number" value="${esc(receiverPrefs.hop_interval_s ?? 10)}" style="${INPUT};width:90px"></label>
            <label style="${LABEL}">Label (optional)<input name="label" placeholder="e.g. Weather station" style="${INPUT};width:140px"></label>
            <button type="submit" style="${BTN}">Start receiver</button>
          </form>
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input id="sdr-hub-receiver-filter" type="text" aria-label="Filter receivers by label, dongle, or frequency" placeholder="Filter by label, dongle, or frequency…" style="${INPUT};flex:1;box-sizing:border-box;">
            <button id="sdr-hub-stop-all-receivers" type="button" style="${BTN_DANGER};white-space:nowrap;">Stop all</button>
          </div>
          <div id="sdr-hub-receivers"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Decoded devices</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <input id="sdr-hub-decoded-filter" type="text" placeholder="Filter by model or id…" aria-label="Filter decoded devices" style="${INPUT};flex:1;min-width:160px;box-sizing:border-box;">
            <button id="sdr-hub-decoded-time-toggle" type="button" title="Toggle between relative and absolute timestamps" style="${BTN_SECONDARY};white-space:nowrap;">${this._decodedTimeMode === "absolute" ? "Absolute time" : "Relative time"}</button>
            <button id="sdr-hub-clear-decoded" type="button" style="${BTN_SECONDARY};white-space:nowrap;">Clear log</button>
          </div>
          <div id="sdr-hub-decoded" style="max-height:240px;overflow-y:auto;"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Backup &amp; restore</h2>
          <p style="margin:0 0 8px;font-size:.85rem;color:var(--secondary-text-color,#727272);">
            Export every active sweep and receiver as a JSON file, or import one to recreate them.
          </p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="sdr-hub-export-config" type="button" style="${BTN_SECONDARY}">Export config</button>
            <label style="${BTN_SECONDARY};display:inline-flex;align-items:center;cursor:pointer;">
              Import config
              <!-- Visually hidden via clipping, not display:none - display:none removes the
                   input from both the focus and accessibility trees, and the wrapping <label>
                   itself is never in the tab order, so a keyboard-only user would have no way
                   to reach the file picker at all. This clip-based hiding keeps the input
                   focusable/operable (Tab + Enter/Space opens the picker) while staying
                   invisible, matching the visible "Import config" label text. -->
              <input id="sdr-hub-import-config" type="file" accept="application/json"
                style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">
            </label>
            <button id="sdr-hub-copy-all-yaml" type="button" title="Copy every active sweep and receiver as a single automation action list" style="${BTN_SECONDARY}">Copy all as YAML</button>
          </div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Settings</h2>
          <label style="${LABEL};display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:12px;">
            <input type="checkbox" id="sdr-hub-battery-sound-toggle" ${this._batterySoundEnabled ? "checked" : ""}>
            Play a sound when a device first reports low battery
          </label>
          <div>
            <button id="sdr-hub-reset-prefs" type="button" title="Clears all locally-saved preferences (colormap, contrast, favorites, decoded log, etc.) and reloads" style="${BTN_DANGER}">Reset all preferences</button>
          </div>
        </div>
      </div>
    `;

    this.querySelector("#sdr-hub-decoded-filter").addEventListener("input", (ev) => {
      this._decodedFilter = ev.target.value.trim().toLowerCase();
      this._renderDecodedLog();
    });
    this.querySelector("#sdr-hub-decoded-time-toggle").addEventListener("click", (ev) => {
      this._decodedTimeMode = this._decodedTimeMode === "absolute" ? "relative" : "absolute";
      saveDecodedTimeMode(this._decodedTimeMode);
      ev.target.textContent = this._decodedTimeMode === "absolute" ? "Absolute time" : "Relative time";
      this._renderDecodedLog();
    });
    this.querySelector("#sdr-hub-clear-decoded").addEventListener("click", () => {
      // Only clears the *displayed* log, not _deviceBatteryOk - a device that's genuinely still
      // reporting low battery should keep showing in the alert banner even after the user clears
      // this view, since that's a real hardware condition independent of what's on screen.
      this._decodedLog = [];
      // Recorded (and persisted) as an explicit boundary, not just an empty-array write - see
      // _onStorageEvent for why a plain "the log is now []" signal can't reliably survive a race
      // against another tab's own concurrent, legitimate decode.
      this._decodedLogClearedAt = Date.now();
      saveDecodedLogClearedAt(this._decodedLogClearedAt);
      saveDecodedLog(this._decodedLog);
      this._renderDecodedLog();
    });
    const helpEl = this.querySelector("#sdr-hub-help");
    this.querySelector("[data-show-help]").addEventListener("click", () => {
      helpEl.style.display = "block";
    });
    helpEl.querySelector("[data-dismiss-help]").addEventListener("click", () => {
      try {
        localStorage.setItem(HELP_DISMISSED_KEY, "true");
      } catch {
        // Same unavailable-storage case as loadHelpDismissed() - dismissal just won't persist
        // across reloads; still hide the card for this session.
      }
      helpEl.style.display = "none";
    });
    this.querySelector("#sdr-hub-add-sweep").addEventListener("submit", (ev) => this._onAddSweep(ev));
    this.querySelector("#sdr-hub-add-receiver").addEventListener("submit", (ev) => this._onAddReceiver(ev));
    this.querySelector("#sdr-hub-sweep-filter").addEventListener("input", (ev) => {
      this._sweepFilter = ev.target.value.trim().toLowerCase();
      this._applySweepFilter();
    });
    this.querySelector("#sdr-hub-receiver-filter").addEventListener("input", (ev) => {
      this._receiverFilter = ev.target.value.trim().toLowerCase();
      this._applyReceiverFilter();
    });
    // "Stop all" always targets every active sweep/receiver, regardless of the filter text
    // above it - "stop everything" is the whole point of a bulk action, and scoping it to
    // whatever happens to currently be filtered-in would make it a trap for anyone who filtered
    // down to look at one thing and forgot to clear it before reaching for this button.
    this._wireConfirmButton(this.querySelector("#sdr-hub-stop-all-sweeps"), () => this._onStopAllSweeps());
    this._wireConfirmButton(this.querySelector("#sdr-hub-stop-all-receivers"), () => this._onStopAllReceivers());
    this._wirePresetSelect("sdr-hub-add-sweep", SWEEP_PRESETS);
    this._wirePresetSelect("sdr-hub-add-receiver", RECEIVER_PRESETS);
    this._wireColormapControls();
    this.querySelector("#sdr-hub-export-config").addEventListener("click", () => this._exportConfig());
    this.querySelector("#sdr-hub-import-config").addEventListener("change", (ev) => this._onImportConfigFile(ev));
    this._wireCopyButton(this.querySelector("#sdr-hub-copy-all-yaml"), () => this._allConfigYaml());
    this.querySelector("#sdr-hub-battery-sound-toggle").addEventListener("change", (ev) => {
      this._batterySoundEnabled = ev.target.checked;
      saveBatterySoundEnabled(this._batterySoundEnabled);
      // Create (or resume) the AudioContext right here, inside the checkbox's own "change"
      // handler - some browsers/HA WebViews only allow Web Audio to start or resume from a
      // direct user gesture. Waiting until the *later*, gesture-less decoded_device WS event
      // that actually plays the alert would construct/resume the context outside that window,
      // leaving it "running" in name but producing no audible sound - see _playBatteryAlertSound.
      if (this._batterySoundEnabled) this._ensureAudioContextRunning();
    });
    this._wireConfirmButton(this.querySelector("#sdr-hub-reset-prefs"), () => this._onResetPreferences(), "Confirm reset?");
    // #sdr-hub-decoded above is created empty (just like every other container in this
    // template) - _decodedLog itself was already restored from localStorage back in the
    // constructor, independent of and well before any get_state round-trip, so drawing it here
    // (rather than waiting on _loadState() to succeed) shows the persisted history immediately,
    // including when the initial get_state call fails outright.
    this._renderDecodedLog();
    this._wireAudioUnlock();
    this._wireStorageSync();
  }

  // A full page reload after clearing every known key is far simpler and more robust than
  // hand-resetting each piece of in-memory state this panel tracks (colormap, contrast range,
  // favorites, decoded log/filter, time mode, sound toggle, help-dismissed, form prefs) back to
  // its own default one at a time - and guarantees nothing was missed, unlike a growing list of
  // manual resets that could silently drift out of sync with ALL_PREF_KEYS over time.
  _onResetPreferences() {
    for (const key of ALL_PREF_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Unavailable storage - nothing to clear.
      }
    }
    location.reload();
  }

  // Repainting every sweep's history from scratch (_renderSweeps(true), which already replays
  // _sweepRowHistory into a fresh canvas for the scroll-mode-toggle case) is reused here rather
  // than a bespoke repaint path - it's a rare, user-initiated settings change, not a per-row hot
  // path, so the cost of rebuilding is a non-issue and this keeps a single "redraw everything"
  // code path instead of two.
  _wireColormapControls() {
    const colormapSelect = this.querySelector("#sdr-hub-colormap");
    const dbMinInput = this.querySelector("#sdr-hub-db-min");
    const dbMaxInput = this.querySelector("#sdr-hub-db-max");
    colormapSelect.addEventListener("change", () => {
      this._colormap = colormapSelect.value;
      saveColormap(this._colormap);
      this._renderSweeps(true);
    });
    const applyDbRange = () => {
      // Number("") is 0, not NaN - checking the raw string for emptiness first (rather than
      // relying on Number.isFinite alone) stops a cleared-then-blurred field from silently
      // being accepted as a real 0 dB boundary while the input itself still looks blank.
      if (dbMinInput.value.trim() === "" || dbMaxInput.value.trim() === "") {
        dbMinInput.value = this._dbMin;
        dbMaxInput.value = this._dbMax;
        return;
      }
      const min = Number(dbMinInput.value);
      const max = Number(dbMaxInput.value);
      // A non-positive span would divide by <= 0 in _paintRow's t calculation, turning the
      // whole waterfall into a single flat color (or NaN) instead of a clear input error -
      // reject it here and restore the last-good values instead.
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        dbMinInput.value = this._dbMin;
        dbMaxInput.value = this._dbMax;
        return;
      }
      this._dbMin = min;
      this._dbMax = max;
      saveDbRange(min, max);
      this._renderSweeps(true);
    };
    dbMinInput.addEventListener("change", applyDbRange);
    dbMaxInput.addEventListener("change", applyDbRange);
  }

  // Fills the form's fields from the chosen preset - a starting point the user can still edit
  // before submitting, not an auto-submit, since e.g. gain/hop-interval still need a real
  // value picked for their actual hardware/environment.
  _wirePresetSelect(formId, presets) {
    const form = this.querySelector(`#${formId}`);
    const select = form.querySelector("[data-preset-select]");
    select.addEventListener("change", () => {
      const preset = presets[Number(select.value)];
      if (!preset) return; // "Custom" - leave whatever the user already has
      for (const [field, value] of Object.entries(preset)) {
        if (field === "label") continue;
        const input = form.querySelector(`[name="${field}"]`);
        if (input) input.value = value;
      }
    });
  }

  _renderDongleOptions(select, { rtlsdrOnly = false, preferredSerial = null, preferredDriver = null } = {}) {
    // Captures both serial and driver of the previously-selected option, not just its value -
    // two devices from different SoapySDR drivers can share the same serial (or both omit
    // one), so restoring by value alone would always land on the *first* matching option
    // regardless of which one the user actually had selected, silently switching the target
    // device on a later re-render (e.g. after an unrelated state_changed refresh).
    // On the very first render there's no previous selection yet (select has no options at
    // all) - preferredSerial/preferredDriver (the last (serial, driver) pair actually
    // submitted, from localStorage) fill that gap so the dongle picker doesn't just reset to
    // whatever happens to be first, and doesn't land on a *different* device that happens to
    // share the same serial under another driver.
    const previousOption = select.selectedOptions[0];
    const hasPreference = !!previousOption || preferredSerial != null;
    const previousSerial = previousOption ? previousOption.value : (preferredSerial ?? "");
    const previousDriver = previousOption ? previousOption.dataset.driver : (preferredDriver ?? "");
    // rtl_433 receivers only work with actual RTL-SDR hardware (see
    // UnsupportedReceiverDriverError) - filtering the receiver form's dropdown to just those
    // avoids the user picking e.g. a HackRF there and hitting a confusing rejection after
    // submitting, when a wideband sweep would have worked fine on that same device.
    // Treats a missing `driver` (an add-on older than this multi-brand change, which only ever
    // returned RTL-SDR dongles anyway) as "rtlsdr" rather than filtering it out - the panel and
    // add-on are updated/configured independently, so a newer panel talking to an older add-on
    // would otherwise see every device vanish from the receiver picker, unable to start a
    // receiver at all until the add-on itself is upgraded too.
    const devices = rtlsdrOnly ? this._state.devices.filter((d) => (d.driver || "rtlsdr") === "rtlsdr") : this._state.devices;
    // data-driver lets the submit handler send dongle_driver alongside dongle_serial - the
    // panel always knows exactly which specific device it displayed, so it can pass this
    // disambiguator along unconditionally instead of only reacting after an ambiguous-serial
    // error (which the add-on can't attribute to one specific device to retry against anyway).
    select.innerHTML = devices
      .map((d) => `<option value="${esc(d.serial)}" data-driver="${esc(d.driver || "")}">${esc(d.label || d.serial)}</option>`)
      .join("");
    // Checks hasPreference (was there a previous selection OR a remembered serial), not that
    // previousSerial is truthy - an empty string is exactly the valid "device omits a serial"
    // case this whole driver-aware restore exists to support, and would otherwise skip
    // restoration entirely for those devices, silently falling back to the browser's default
    // (first option).
    if (hasPreference) {
      const options = [...select.options];
      // Prefer an exact (serial, driver) match; fall back to serial-only if that specific
      // device is no longer listed (e.g. it was unplugged and a different-driver device
      // happens to share its serial) - better to select *something* plausible than nothing.
      const match =
        options.find((o) => o.value === previousSerial && o.dataset.driver === previousDriver) ||
        options.find((o) => o.value === previousSerial);
      if (match) match.selected = true;
    }
  }

  // Sweeps have a real frequency *range* (start_hz-stop_hz); receivers instead have a list of
  // discrete frequencies_hz they hop between (rtl_433 tunes a narrow window per frequency, not
  // a continuous span) - drawn as thin point markers rather than filled segments so the two
  // are visually distinct at a glance, which is the whole point of this view (issue #3 item
  // #6: see all active captures' coverage together instead of mentally tracking N separate
  // cards). Auto-scales to whatever is currently active, with padding, rather than a fixed
  // "full tunable range" - different SoapySDR devices cover wildly different ranges (a
  // few MHz for some, 6GHz for a HackRF), so there's no one sensible fixed span to show.
  _renderCoverage() {
    const el = this.querySelector("#sdr-hub-coverage");
    if (!el) return;
    const sweeps = this._state.sweeps || [];
    const receivers = this._state.receivers || [];
    const segments = sweeps.map((s) => ({
      start: s.start_hz,
      stop: s.stop_hz,
      error: s.status === "error",
      label: s.label
        ? `${s.label} (${fmtMHz(s.start_hz)}–${fmtMHz(s.stop_hz)} MHz sweep on ${s.dongle_serial})`
        : `${fmtMHz(s.start_hz)}–${fmtMHz(s.stop_hz)} MHz sweep on ${s.dongle_serial}`,
    }));
    const points = [];
    for (const r of receivers) {
      for (const freq of r.frequencies_hz) {
        const label = r.label
          ? `${r.label} (${fmtMHz(freq)} MHz receiver on ${r.dongle_serial})`
          : `${fmtMHz(freq)} MHz receiver on ${r.dongle_serial}`;
        points.push({ freq, error: r.status === "error", label });
      }
    }
    if (segments.length === 0 && points.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No active sweeps or receivers.</p>`;
      return;
    }
    const allHz = [...segments.flatMap((s) => [s.start, s.stop]), ...points.map((p) => p.freq)];
    const minHz = Math.min(...allHz);
    const maxHz = Math.max(...allHz);
    // A floor on the considered span, not just (max-min), so a single sweep/receiver (span 0
    // or narrow) still gets sensible padding instead of the bar being all padding.
    const span = Math.max(maxHz - minHz, 1e6);
    const pad = span * 0.08;
    const rangeStart = Math.max(0, minHz - pad);
    const rangeStop = maxHz + pad;
    const rangeSpan = rangeStop - rangeStart;
    const pct = (hz) => ((hz - rangeStart) / rangeSpan) * 100;
    const SWEEP_COLOR = "var(--primary-color,#03a9f4)";
    const ERROR_COLOR = "var(--error-color,#db4437)";
    const segmentHtml = segments
      .map((s) => {
        const left = pct(s.start);
        // Floors the drawn width so a very narrow sweep is still visible/hoverable rather than
        // collapsing to a sliver at this bar's pixel scale.
        const width = Math.max(pct(s.stop) - left, 0.4);
        return `<div title="${esc(s.label)}" style="position:absolute;left:${left}%;width:${width}%;top:6px;bottom:6px;background:${s.error ? ERROR_COLOR : SWEEP_COLOR};border-radius:3px;opacity:${s.error ? 0.6 : 0.85};"></div>`;
      })
      .join("");
    const pointHtml = points
      .map((p) => {
        const left = pct(p.freq);
        return `<div title="${esc(p.label)}" style="position:absolute;left:${left}%;top:0;bottom:0;width:2px;margin-left:-1px;background:${p.error ? ERROR_COLOR : "var(--secondary-text-color,#727272)"};"></div>`;
      })
      .join("");
    el.innerHTML = `
      <div style="position:relative;height:32px;background:var(--secondary-background-color,#fafafa);border-radius:6px;margin-bottom:4px;">
        ${segmentHtml}
        ${pointHtml}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--secondary-text-color,#727272);">
        <span>${fmtMHz(rangeStart)} MHz</span>
        <span>${fmtMHz(rangeStop)} MHz</span>
      </div>
      <div style="display:flex;gap:12px;font-size:.75rem;color:var(--secondary-text-color,#727272);margin-top:4px;flex-wrap:wrap;">
        <span><span style="display:inline-block;width:10px;height:10px;background:${SWEEP_COLOR};border-radius:2px;vertical-align:middle;margin-right:4px;"></span>Sweep range</span>
        <span><span style="display:inline-block;width:2px;height:10px;background:var(--secondary-text-color,#727272);vertical-align:middle;margin-right:5px;"></span>Receiver frequency</span>
      </div>
    `;
  }

  _renderDongles() {
    const el = this.querySelector("#sdr-hub-dongles");
    if (!el) return;
    if (this._state.devices.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No dongles detected.</p>`;
    } else {
      el.innerHTML = `
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <tr style="text-align:left;color:var(--secondary-text-color,#727272);font-size:.85rem;">
            <th>Serial</th><th>Label</th><th>Driver</th><th>In use by</th>
          </tr>
          ${this._state.devices
            .map(
              (d) => `
            <tr>
              <td>${esc(d.serial)}</td>
              <td>${esc(d.label || "")}</td>
              <td>${esc(d.driver || "")}${d.driver && d.driver !== "rtlsdr" ? ` <span style="color:var(--secondary-text-color,#727272);" title="Only RTL-SDR (driver 'rtlsdr') devices support rtl_433 receivers - this one can still run wideband sweeps.">(sweeps only)</span>` : ""}</td>
              <td>${d.in_use_by ? esc(d.in_use_by) : "<em>free</em>"}</td>
            </tr>`,
            )
            .join("")}
        </table>
        </div>`;
    }
    for (const form of ["sdr-hub-add-sweep", "sdr-hub-add-receiver"]) {
      const select = this.querySelector(`#${form} select[name="dongle_serial"]`);
      if (!select) continue;
      const isReceiver = form === "sdr-hub-add-receiver";
      const prefs = loadFormPrefs(isReceiver ? RECEIVER_FORM_PREFS_KEY : SWEEP_FORM_PREFS_KEY);
      this._renderDongleOptions(select, {
        rtlsdrOnly: isReceiver,
        preferredSerial: prefs.dongle_serial ?? null,
        preferredDriver: prefs.dongle_driver ?? null,
      });
    }
  }

  _renderSweeps(forceRebuild = false) {
    const el = this.querySelector("#sdr-hub-sweeps");
    if (!el) return;
    const activeIds = new Set(this._state.sweeps.map((s) => s.id));
    for (const id of Object.keys(this._sweepRowHistory)) {
      if (!activeIds.has(id)) {
        delete this._sweepRowHistory[id];
        delete this._scrollMode[id];
        delete this._scrollDrawIndex[id];
        delete this._viewportHeight[id];
      }
    }
    // _loadState() (and thus this) runs on every state_changed event, including the harmless
    // 30s poll and other panels' unrelated actions - not just changes to *this* sweep list. The
    // full rebuild below recreates every canvas element and replays its whole retained history
    // into it; in scroll mode _drawScrollRow's canvas-growth path copies the existing bitmap
    // through a temp canvas one row at a time, so replaying a near-200MB history on every no-op
    // refresh can turn into hundreds of GB of pixel copies and freeze the tab. Skip all of that
    // when the set of sweeps hasn't actually changed - only patch the small mutable bits (the
    // error status label) instead. forceRebuild is used by call sites that genuinely need a
    // fresh canvas (the scroll-mode toggle, which changes canvas sizing).
    const idsKey = [...activeIds].sort().join(",");
    const statusKey = this._state.sweeps.map((s) => `${s.id}:${s.status}`).join(",");
    if (!forceRebuild && this._renderedSweepIdsKey === idsKey) {
      if (this._renderedSweepStatusKey !== statusKey) {
        for (const s of this._state.sweeps) {
          const label = el.querySelector(`[data-sweep-status="${CSS.escape(s.id)}"]`);
          if (label) label.textContent = s.status === "error" ? " (error)" : "";
        }
        this._renderedSweepStatusKey = statusKey;
      }
      return;
    }
    this._renderedSweepIdsKey = idsKey;
    this._renderedSweepStatusKey = statusKey;
    if (this._state.sweeps.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No active sweeps.</p>`;
      return;
    }
    // A forced rebuild (colormap/contrast change, or the scroll-mode toggle) replaces every
    // scroll container element outright, which would otherwise silently reset scrollTop to 0 -
    // jumping a user who was mid-history (or intentionally following the bottom) back to the
    // oldest row and, for the bottom-follow case, leaving them stuck there since
    // _drawScrollRow's wasAtBottom check reads the *new* container, which starts at scrollTop 0
    // and hasn't earned "at bottom" yet. Snapshot each sweep's current position (and whether it
    // was pinned to the bottom) before tearing the containers down, then restore it below once
    // the replacement containers exist and have their history replayed back in.
    const preservedScroll = {};
    for (const s of this._state.sweeps) {
      const container = el.querySelector(`[data-sweep-scroll-container="${CSS.escape(s.id)}"]`);
      if (container) {
        preservedScroll[s.id] = {
          atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 4,
          scrollTop: container.scrollTop,
        };
      }
    }
    el.innerHTML = this._state.sweeps
      .map((s) => {
        const scroll = !!this._scrollMode[s.id];
        // In scroll mode the canvas is sized to exactly how much history there already is
        // (capped at scrollRowCapForWidth(width)), not pre-allocated - the container only
        // becomes scrollable (plain CSS overflow:auto) once real content actually exceeds
        // WATERFALL_HEIGHT, and grows one row at a time as new rows arrive (see
        // _drawScrollRow). Live mode is unchanged: always a fixed WATERFALL_HEIGHT.
        const history = this._sweepRowHistory[s.id] || [];
        const historyLen = history.length;
        const rowWidth = history[0]?.power_db.length || 1;
        const canvasHeight = scroll
          ? Math.max(1, Math.min(historyLen, scrollRowCapForWidth(rowWidth)))
          : WATERFALL_HEIGHT;
        // The canvas element gets an explicit `width` attribute (matching the actual row
        // width), not just `height` - without it the bitmap defaults to width=300, and
        // _drawScrollRow's very first replayed row (below) would then see canvas.width !==
        // width and take its "range changed" branch, wiping out this pre-set canvasHeight
        // back down to a 1px canvas. Every subsequent replayed row would then hit the
        // still-growing incremental-resize path (grow-by-one-row + full-bitmap copy through a
        // temp canvas) instead of just being drawn straight into the already-correctly-sized
        // bitmap - turning a full-history repaint (colormap/contrast change) into up to
        // O(historyLen^2) pixel copies.
        const viewportHeight = this._viewportHeight[s.id] ?? WATERFALL_HEIGHT;
        const rangeText = `${fmtMHz(s.start_hz)}–${fmtMHz(s.stop_hz)} MHz`;
        const titleHtml = s.label
          ? `<strong>${esc(s.label)}</strong> <span style="color:var(--secondary-text-color,#727272);">(${rangeText})</span>`
          : rangeText;
        const searchText = `${s.label || ""} ${s.dongle_serial} ${fmtMHz(s.start_hz)} ${fmtMHz(s.stop_hz)}`.toLowerCase();
        return `
      <div data-sweep-row="${esc(s.id)}" data-search="${esc(searchText)}" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>${titleHtml} on ${esc(s.dongle_serial)}
            <span data-sweep-status="${esc(s.id)}" style="color:var(--error-color,#db4437);">${s.status === "error" ? " (error)" : ""}</span></span>
          <span style="display:flex;gap:8px;">
            <button data-save-sweep-png="${esc(s.id)}" title="Save the current waterfall as a PNG image" style="${BTN_SECONDARY}">Save image</button>
            <button data-copy-sweep-yaml="${esc(s.id)}" title="Copy as an sdr_hub.add_sweep automation action" style="${BTN_SECONDARY}">Copy as YAML</button>
            <button data-remove-sweep="${esc(s.id)}" style="${BTN_DANGER}">Stop</button>
          </span>
        </div>
        <label style="${LABEL};display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
          <input type="checkbox" data-scroll-toggle="${esc(s.id)}" ${scroll ? "checked" : ""}>
          Keep full history (scrollable) — only affects rows from now on
        </label>
        <div data-sweep-scroll-container="${esc(s.id)}"
          style="max-height:${viewportHeight}px;overflow-y:auto;border-radius:8px;">
          <div style="position:relative;">
            <canvas data-sweep-canvas="${esc(s.id)}" width="${rowWidth}" height="${canvasHeight}"
              style="width:100%;height:${canvasHeight}px;image-rendering:pixelated;display:block;"></canvas>
            <div data-sweep-axis="${esc(s.id)}" style="position:absolute;inset:0;pointer-events:none;"></div>
          </div>
        </div>
        <div data-sweep-resize="${esc(s.id)}" title="Drag to resize" role="separator" aria-label="Resize waterfall height"
          style="height:20px;margin-top:2px;border-radius:4px;cursor:ns-resize;touch-action:none;
          background:repeating-linear-gradient(to right,var(--divider-color,#e0e0e0) 0 6px,transparent 0 12px);
          display:flex;align-items:center;justify-content:center;"></div>
        <div style="display:flex;justify-content:space-between;font-size:.8rem;color:var(--secondary-text-color,#727272);">
          <div data-sweep-hover="${esc(s.id)}" style="height:1.2em;"></div>
          <div data-sweep-peak="${esc(s.id)}" style="height:1.2em;"></div>
        </div>
      </div>`;
      })
      .join("");
    for (const s of this._state.sweeps) {
      this._wireConfirmButton(el.querySelector(`[data-remove-sweep="${CSS.escape(s.id)}"]`), () =>
        this._onRemoveSweep(s.id),
      );
      this._wireCopyButton(el.querySelector(`[data-copy-sweep-yaml="${CSS.escape(s.id)}"]`), () => this._sweepYaml(s));
      el.querySelector(`[data-save-sweep-png="${CSS.escape(s.id)}"]`).addEventListener("click", () =>
        this._saveSweepImage(s.id),
      );
      const toggle = el.querySelector(`[data-scroll-toggle="${CSS.escape(s.id)}"]`);
      if (toggle) {
        toggle.addEventListener("change", () => {
          this._scrollMode[s.id] = toggle.checked;
          this._renderSweeps(true); // force: rebuilds this sweep's canvas at the new size and replays below
        });
      }
      this._wireCanvasHover(s.id);
      this._wireResizeHandle(s.id);
      // The canvas element (and its bitmap) is fresh after this rerender — replay the
      // retained history so the full waterfall reappears instead of just the latest row,
      // matching what hover (which reads the same history) implies is there. Scroll mode
      // still replays row-by-row via _appendRow (its growth path is already O(n) total, see
      // the `width` attribute comment above); live mode uses the dedicated bulk repaint below
      // instead, since _appendRow/_drawLiveRow's per-arrival canvas shift would otherwise be
      // O(n) full-canvas copies for a single rebuild (see _repaintLiveHistory).
      this._scrollDrawIndex[s.id] = 0;
      const rows = this._sweepRowHistory[s.id];
      if (rows) {
        if (this._scrollMode[s.id]) {
          for (let i = rows.length - 1; i >= 0; i--) this._appendRow(s.id, rows[i]);
        } else {
          const canvas = el.querySelector(`[data-sweep-canvas="${CSS.escape(s.id)}"]`);
          if (canvas) this._repaintLiveHistory(canvas, s.id);
        }
      }
      this._renderTimeAxis(s.id);
      // Restore the position captured above, now that the replacement container has its
      // history replayed back in (so scrollHeight reflects the final content size). A
      // bottom-pinned view is restored by re-pinning to the new bottom rather than replaying
      // the raw scrollTop - the canvas's pre-computed height (see the `width` attribute comment
      // above) already matches the old one for a same-size repaint, but re-deriving "bottom"
      // from the live scrollHeight is what actually keeps a user who was following live data
      // still following it, rather than depending on that size staying identical.
      const preserved = preservedScroll[s.id];
      if (preserved) {
        const container = el.querySelector(`[data-sweep-scroll-container="${CSS.escape(s.id)}"]`);
        if (container) {
          container.scrollTop = preserved.atBottom ? container.scrollHeight : preserved.scrollTop;
        }
      }
    }
    this._applySweepFilter();
  }

  // Hides (rather than excludes from the render above) non-matching sweep cards - keeps the
  // filter orthogonal to _renderSweeps's own no-op-refresh/canvas-history invariants instead of
  // needing to thread it through that already-intricate rebuild logic.
  _applySweepFilter() {
    const el = this.querySelector("#sdr-hub-sweeps");
    if (!el) return;
    const rows = [...el.querySelectorAll("[data-sweep-row]")];
    if (rows.length === 0) return; // "No active sweeps" placeholder - nothing to filter
    let visibleCount = 0;
    for (const row of rows) {
      const match = !this._sweepFilter || (row.dataset.search || "").includes(this._sweepFilter);
      row.style.display = match ? "" : "none";
      if (match) visibleCount++;
    }
    let emptyMsg = el.querySelector("[data-sweep-filter-empty]");
    if (visibleCount === 0) {
      if (!emptyMsg) {
        emptyMsg = document.createElement("p");
        emptyMsg.dataset.sweepFilterEmpty = "";
        emptyMsg.style.color = "var(--secondary-text-color,#727272)";
        el.appendChild(emptyMsg);
      }
      emptyMsg.textContent = `No sweeps match "${this._sweepFilter}".`;
    } else if (emptyMsg) {
      emptyMsg.remove();
    }
  }

  _renderReceivers() {
    const el = this.querySelector("#sdr-hub-receivers");
    if (!el) return;
    // _loadState() (and thus this) runs on every state_changed event, including the harmless
    // 30s poll - a full innerHTML rebuild on every one of those would tear down and recreate
    // each row's Stop button, discarding any in-progress confirm-to-stop arming (see
    // _wireConfirmButton) and forcing the user to start the confirmation over. Skip the rebuild
    // (matching the same no-op-refresh guard _renderSweeps already uses) when the set of
    // receivers and their statuses hasn't actually changed - only patch the status label text.
    const idsKey = this._state.receivers
      .map((r) => r.id)
      .sort()
      .join(",");
    const statusKey = this._state.receivers.map((r) => `${r.id}:${r.status}`).join(",");
    if (this._renderedReceiverIdsKey === idsKey) {
      if (this._renderedReceiverStatusKey !== statusKey) {
        for (const r of this._state.receivers) {
          const statusCell = el.querySelector(`[data-receiver-status="${CSS.escape(r.id)}"]`);
          if (statusCell) {
            statusCell.innerHTML =
              r.status === "error" ? `<span style="color:var(--error-color,#db4437);">error</span>` : "running";
          }
        }
        this._renderedReceiverStatusKey = statusKey;
      }
      this._applyReceiverFilter();
      return;
    }
    this._renderedReceiverIdsKey = idsKey;
    this._renderedReceiverStatusKey = statusKey;
    if (this._state.receivers.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No active receivers.</p>`;
      return;
    }
    el.innerHTML = `
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <tr style="text-align:left;color:var(--secondary-text-color,#727272);font-size:.85rem;">
          <th>Label</th><th>Frequencies</th><th>Dongle</th><th>Status</th><th></th>
        </tr>
        ${this._state.receivers
          .map((r) => {
            const searchText = `${r.label || ""} ${r.dongle_serial} ${r.frequencies_hz.map(fmtMHz).join(" ")}`.toLowerCase();
            return `
          <tr data-receiver-row="${esc(r.id)}" data-search="${esc(searchText)}">
            <td>${r.label ? esc(r.label) : `<em style="color:var(--secondary-text-color,#727272);">—</em>`}</td>
            <td>${r.frequencies_hz.map(fmtMHz).join(", ")} MHz</td>
            <td>${esc(r.dongle_serial)}</td>
            <td data-receiver-status="${esc(r.id)}">${r.status === "error" ? `<span style="color:var(--error-color,#db4437);">error</span>` : "running"}</td>
            <td style="display:flex;gap:8px;">
              <button data-copy-receiver-yaml="${esc(r.id)}" title="Copy as an sdr_hub.add_receiver automation action" style="${BTN_SECONDARY}">Copy as YAML</button>
              <button data-remove-receiver="${esc(r.id)}" style="${BTN_DANGER}">Stop</button>
            </td>
          </tr>`;
          })
          .join("")}
      </table>
      </div>`;
    for (const r of this._state.receivers) {
      this._wireConfirmButton(el.querySelector(`[data-remove-receiver="${CSS.escape(r.id)}"]`), () =>
        this._onRemoveReceiver(r.id),
      );
      this._wireCopyButton(el.querySelector(`[data-copy-receiver-yaml="${CSS.escape(r.id)}"]`), () =>
        this._receiverYaml(r),
      );
    }
    this._applyReceiverFilter();
  }

  // See _applySweepFilter above - same hide-non-matching-rows approach, applied to the
  // receivers table's <tr> elements instead of the sweeps' card <div>s.
  _applyReceiverFilter() {
    const el = this.querySelector("#sdr-hub-receivers");
    if (!el) return;
    const rows = [...el.querySelectorAll("[data-receiver-row]")];
    if (rows.length === 0) return; // "No active receivers" placeholder - nothing to filter
    let visibleCount = 0;
    for (const row of rows) {
      const match = !this._receiverFilter || (row.dataset.search || "").includes(this._receiverFilter);
      row.style.display = match ? "" : "none";
      if (match) visibleCount++;
    }
    let emptyMsg = el.querySelector("[data-receiver-filter-empty]");
    if (visibleCount === 0) {
      if (!emptyMsg) {
        emptyMsg = document.createElement("p");
        emptyMsg.dataset.receiverFilterEmpty = "";
        emptyMsg.style.color = "var(--secondary-text-color,#727272)";
        el.appendChild(emptyMsg);
      }
      emptyMsg.textContent = `No receivers match "${this._receiverFilter}".`;
    } else if (emptyMsg) {
      emptyMsg.remove();
    }
  }

  // Surfaces low-battery devices independently of the decoded-log filter/scroll position - a
  // user monitoring many sensors shouldn't have to clear their filter and scroll the whole log
  // to notice one needs a battery change.
  _renderBatteryAlerts() {
    const el = this.querySelector("#sdr-hub-battery-alert");
    if (!el) return;
    // Reads from _deviceBatteryOk (updated per-event in _handleEvent, and only ever holding
    // currently-low devices - see its field comment), not _decodedLog - the log is capped at
    // MAX_DECODED_LOG and a weakening sensor that stops transmitting after reporting low
    // battery would otherwise have its record evicted by newer events from other devices,
    // silently clearing an alert that never actually recovered.
    // Sorted by key (not Map iteration order) for a presentation order that's stable regardless
    // of which device most recently reported - the eviction logic above deliberately reorders
    // the map's *insertion* order on every refresh (delete-then-set, to track LRU recency), and
    // rendering that order directly would change "A, B" to "B, A" on a no-op refresh, defeating
    // the _lastBatteryAlertMessage dedup below and re-triggering the live-region announcement.
    const low = [...this._deviceBatteryOk.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { model, id, channel }]) => {
        const parts = [id != null ? `id ${id}` : null, channel != null ? `ch ${channel}` : null].filter(Boolean);
        return parts.length ? `${model || "Unknown device"} (${parts.join(", ")})` : model || "Unknown device";
      });
    const message = low.length === 0 ? "" : `⚠️ Low battery: ${low.map(esc).join(", ")}`;
    // Every unrelated decoded_device event (and the 30s poll, via _loadState -> _renderDecodedLog
    // -> here) calls this while any device remains low. This is an aria-live="assertive" region,
    // so replacing its text content is itself an announcement to screen readers even when the
    // text is unchanged - re-set the DOM only when the computed message actually differs, so
    // users aren't interrupted at up to the full rtl_433 event rate for no new information.
    if (this._lastBatteryAlertMessage === message) return;
    this._lastBatteryAlertMessage = message;
    el.style.display = message ? "block" : "none";
    el.innerHTML = message;
  }

  // Creates the AudioContext (if needed) and resumes it if suspended. Split out from
  // _playBatteryAlertSound so the battery-sound-toggle change handler can call this directly
  // from within the user's own click/change gesture - see that handler for why. Best-effort:
  // resume() is async and this doesn't await it, since by the time an actual alert fires later
  // the context is normally already "running" from this gesture-time call.
  _ensureAudioContextRunning() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = this._audioCtx ?? (this._audioCtx = new AudioCtx());
      if (ctx.state === "suspended") ctx.resume();
    } catch {
      // Unsupported/unavailable AudioContext - _playBatteryAlertSound's own try/catch handles
      // this the same way when the alert actually tries to play.
    }
  }

  // A short synthesized beep (Web Audio API oscillator, no external asset) rather than an
  // <audio> element with a bundled sound file - avoids shipping/loading a binary asset for one
  // brief tone. The AudioContext is created lazily and reused across calls (not one per alert) -
  // browsers cap how many can exist at once, and creating one is comparatively expensive.
  _playBatteryAlertSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = this._audioCtx ?? (this._audioCtx = new AudioCtx());
      // Only plays if the context is already unlocked ("running") from an earlier user gesture -
      // see _wireAudioUnlock/_ensureAudioContextRunning, both of which run from an actual click/
      // keydown, unlike this method (called from a gesture-less WS event). Deliberately does NOT
      // call ctx.resume() and wait on it here (an earlier round of this same fix did, and that
      // was itself the bug): resume()'s promise can stay pending rather than reject when there's
      // still no qualifying gesture, and *any* later unrelated interaction on the page - not
      // necessarily one that has anything to do with this alert - would resolve it via
      // _wireAudioUnlock's own resume() call on the same shared context, which would then
      // schedule this now-stale tone at that unrelated, much later moment. Silently dropping this
      // one alert (the banner stays visible regardless) is a smaller cost than a surprise delayed
      // beep for an event that's no longer new.
      if (ctx.state !== "running") return;
      this._scheduleBatteryAlertTone(ctx);
    } catch {
      // Autoplay policy (no prior user gesture on this page) or an unsupported/unavailable
      // AudioContext - this is a convenience notification on top of the always-visible banner,
      // not worth surfacing an error over.
    }
  }

  // The actual oscillator scheduling, split out of _playBatteryAlertSound purely for readability.
  _scheduleBatteryAlertTone(ctx) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }

  _renderDecodedLog() {
    // Independent of the filter text/results below - battery state should stay visible even
    // while a user has the log filtered down to something else entirely.
    this._renderBatteryAlerts();
    const el = this.querySelector("#sdr-hub-decoded");
    if (!el) return;
    if (this._decodedLog.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No devices decoded yet.</p>`;
      return;
    }
    // Matches against model and id specifically (not every field) - a substring match across
    // the *entire* dump (including timestamps, checksums, etc.) would surface confusing false
    // positives, whereas model/id is what a user actually means by "find this device".
    const filtered = this._decodedFilter
      ? this._decodedLog.filter((event) => {
          const d = event.device || {};
          const haystack = `${d.model || ""} ${d.id != null ? d.id : ""}`.toLowerCase();
          return haystack.includes(this._decodedFilter);
        })
      : this._decodedLog;
    if (filtered.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No decoded devices match "${esc(this._decodedFilter)}".</p>`;
      // Cleared here too, same as the end of the normal render path below - otherwise a flash
      // pending for a device hidden by the current filter would stay queued and fire later
      // (once the filter no longer excludes it) as if it had just decoded.
      this._flashDeviceKey = null;
      return;
    }
    const now = Date.now();
    // Favorited devices float to the top (Array.sort is stable, so each group keeps its own
    // newest-first order) - lets a user watching for one specific sensor find it immediately
    // instead of scanning past everything else that's decoded more recently.
    const isFavorite = (event) => this._favoriteDevices.has(deviceFavoriteKey(event.device || {}));
    const sorted = [...filtered].sort((a, b) => Number(isFavorite(b)) - Number(isFavorite(a)));
    let flashConsumed = false;
    el.innerHTML = sorted
      .map((event) => {
        const d = event.device || {};
        const key = deviceFavoriteKey(d);
        const fav = this._favoriteDevices.has(key);
        // Only the first (newest, thanks to the favorite sort-to-top above) matching card
        // consumes the pending flash - without this a device with multiple log entries could
        // flash more than once per new decode.
        const flash = fav && !flashConsumed && key === this._flashDeviceKey;
        if (flash) flashConsumed = true;
        const idParts = [d.id != null ? `id ${d.id}` : null, d.channel != null ? `ch ${d.channel}` : null].filter(
          Boolean,
        );
        const fields = Object.keys(d)
          .filter((k) => !DECODED_HIDDEN_FIELDS.has(k))
          .map((k) => fmtDecodedField(k, d[k]));
        const age = event._receivedAt
          ? this._decodedTimeMode === "absolute"
            ? fmtAbsoluteTime(event._receivedAt)
            : `-${fmtElapsed(now - event._receivedAt)}`
          : "";
        const cardStyle = fav ? `background:rgba(245,166,35,.1);${flash ? "animation:sdr-hub-flash 1.2s ease-out;" : ""}` : "";
        return `
          <div style="padding:6px 0;border-bottom:1px solid var(--divider-color,#e0e0e0);${cardStyle}">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <span style="display:flex;align-items:center;gap:6px;">
                <button data-pin-device="${esc(key)}" title="${fav ? "Remove from favorites" : "Add to favorites"}"
                  style="border:none;background:none;cursor:pointer;padding:0;line-height:1;font-size:1rem;color:${fav ? "#f5a623" : "var(--secondary-text-color,#727272)"};">${fav ? "★" : "☆"}</button>
                <strong>${esc(d.model || "Unknown device")}</strong>
              </span>
              <span style="font-size:.75rem;color:var(--secondary-text-color,#727272);">${esc(age)}</span>
            </div>
            ${idParts.length ? `<div style="font-size:.8rem;color:var(--secondary-text-color,#727272);">${esc(idParts.join(", "))}</div>` : ""}
            ${fields.length ? `<div style="font-size:.85rem;">${fields.map(esc).join(" · ")}</div>` : ""}
          </div>`;
      })
      .join("");
    // Cleared unconditionally after this render (whether or not a card actually consumed it,
    // e.g. the flashed device was filtered out this time) - a flash means "this just happened",
    // not "show it next time this device happens to be visible again".
    this._flashDeviceKey = null;
    el.querySelectorAll("[data-pin-device]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.pinDevice;
        if (this._favoriteDevices.has(key)) this._favoriteDevices.delete(key);
        else this._favoriteDevices.add(key);
        saveFavoriteDevices(this._favoriteDevices);
        this._renderDecodedLog();
      });
    });
  }

  // ── waterfall canvas ─────────────────────────────────────────────────────

  _wireCanvasHover(sweepId) {
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(sweepId)}"]`);
    const readout = this.querySelector(`[data-sweep-hover="${CSS.escape(sweepId)}"]`);
    if (!canvas || !readout) return;
    const showAt = (clientX, clientY) => {
      const rows = this._sweepRowHistory[sweepId];
      if (!rows || rows.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const y = Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * canvas.height));
      let row;
      if (this._scrollMode[sweepId]) {
        // Scroll mode draws oldest-to-newest top-to-bottom (append), unlike live mode's
        // newest-at-top scroll-down - y=0 is the oldest drawn row, increasing y is newer.
        const drawnCount = this._scrollDrawIndex[sweepId] || 0;
        row = y < drawnCount ? rows[drawnCount - 1 - y] : null;
      } else {
        // Row 0 is newest and drawn at canvas y=0; each older row is one pixel further down
        // (the scroll-down in _drawLiveRow) — map the cursor's Y back to that same index so
        // hovering an older band of the waterfall reads that row's data, not the newest.
        row = rows[y];
      }
      const frac = (clientX - rect.left) / rect.width;
      if (!row) {
        readout.textContent = "";
        return;
      }
      const bin = Math.max(0, Math.min(row.power_db.length - 1, Math.round(frac * row.power_db.length)));
      const freqHz = row.start_hz + bin * row.bin_hz;
      const db = row.power_db[bin];
      // Elapsed-since-now (not a wall-clock timestamp) so two hovered points' *delta* can be
      // read directly by subtracting the two "-Xs" values, matching the axis's own relative
      // labels - an absolute clock time would need the same subtraction the label already saves.
      const age = row._receivedAt ? `-${fmtElapsed(Date.now() - row._receivedAt)}` : "";
      readout.textContent = [
        `${fmtMHz(freqHz)} MHz`,
        Number.isFinite(db) ? `${db.toFixed(1)} dB` : null,
        age || null,
      ]
        .filter(Boolean)
        .join(" — ");
    };
    canvas.addEventListener("mousemove", (ev) => showAt(ev.clientX, ev.clientY));
    canvas.addEventListener("mouseleave", () => {
      readout.textContent = "";
    });
    // Touch has no hover concept, but the canvas lives inside an overflow-y:auto history
    // container (scroll mode, and live mode once its viewport's been resized shorter than
    // the canvas) - a continuous touchstart+touchmove drag readout would need
    // preventDefault() to avoid also scrolling the page, which would permanently block the
    // user's normal one-finger swipe-to-scroll on that container. Use a single-tap reveal
    // instead.
    canvas.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 1) return;
      // No preventDefault here - a normal one-finger swipe must still scroll the history
      // container (in scroll mode, or in live mode once the viewport's been resized shorter
      // than the canvas). A tap has no meaningful "hold and drag" gesture on canvas to lose by
      // not calling preventDefault, so just read the tapped point and self-clear after a delay,
      // since touch has no hover-out event to clear it the way mouseleave does.
      showAt(ev.touches[0].clientX, ev.touches[0].clientY);
      // Keyed on the canvas itself (not `this`, the shared custom-element instance across
      // every sweep) so two sweeps' touch readouts don't clear each other's pending timer.
      clearTimeout(canvas._touchClearTimer);
      canvas._touchClearTimer = setTimeout(() => {
        readout.textContent = "";
      }, 2000);
    });
  }

  // Lets the user drag the waterfall's visible viewport taller/shorter (the canvas itself -
  // and thus how much history is retained - is unaffected; this only changes how much of it
  // is shown before the container's own overflow:auto scrolls). Pointer Events (rather than
  // separate mouse/touch handlers) cover mouse, touch, and pen with one code path.
  _wireResizeHandle(sweepId) {
    const handle = this.querySelector(`[data-sweep-resize="${CSS.escape(sweepId)}"]`);
    const container = this.querySelector(`[data-sweep-scroll-container="${CSS.escape(sweepId)}"]`);
    if (!handle || !container) return;
    const MIN_VIEWPORT_PX = 80;
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const startY = ev.clientY;
      const startHeight = container.getBoundingClientRect().height;
      const onMove = (moveEv) => {
        const next = Math.max(MIN_VIEWPORT_PX, Math.round(startHeight + (moveEv.clientY - startY)));
        this._viewportHeight[sweepId] = next;
        container.style.maxHeight = `${next}px`;
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  _renderTimeAxis(sweepId) {
    const axisEl = this.querySelector(`[data-sweep-axis="${CSS.escape(sweepId)}"]`);
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(sweepId)}"]`);
    if (!axisEl || !canvas) return;
    const rows = this._sweepRowHistory[sweepId];
    const scroll = !!this._scrollMode[sweepId];
    // canvas.height is always exactly the drawn content height in scroll mode (it grows one
    // row at a time, no pre-allocation) - read it live rather than assuming a fixed size.
    const canvasHeight = canvas.height;
    // How many rows are actually drawn right now (live mode: capped at WATERFALL_HEIGHT;
    // scroll mode: however many have been appended so far, which is exactly canvasHeight).
    const drawnCount = scroll ? this._scrollDrawIndex[sweepId] || 0 : Math.min(rows ? rows.length : 0, WATERFALL_HEIGHT);
    if (!rows || drawnCount === 0) {
      axisEl.innerHTML = "";
      return;
    }
    const now = Date.now();
    // Scale tick count to the actual drawn pixel extent (drawnCount), not the full canvas
    // height - a fixed number of ticks (e.g. 5) spread across the *entire* scroll history
    // stays readable only while the canvas is short. Once "keep full history" has grown it to
    // thousands of pixels, those same 5 ticks end up thousands of pixels apart - far outside
    // any single scrolled-to viewport, so most scroll positions show zero labels. Keeping tick
    // spacing constant (one roughly every MIN_TICK_SPACING_PX) guarantees a label is always
    // nearby. Using drawnCount rather than canvasHeight also fixes the opposite problem in live
    // mode: canvasHeight is pre-allocated to a fixed WATERFALL_HEIGHT from the first row, so
    // early on (a handful of rows drawn into a 400px canvas) canvasHeight-based spacing would
    // still allow ~10 ticks - all crammed into the first few actually-drawn pixels, overlapping
    // each other, since drawnCount (the real constraint on how many distinct rows exist to
    // label) is far smaller than the canvas's eventual full height.
    // MAX_TICKS is just a sanity ceiling on DOM node count for a pathologically long session.
    const MAX_TICKS = 300;
    const MIN_TICK_SPACING_PX = 40;
    const tickCount = Math.max(1, Math.min(MAX_TICKS, Math.floor(drawnCount / MIN_TICK_SPACING_PX) + 1, drawnCount));
    const labels = [];
    for (let t = 0; t < tickCount; t++) {
      // y=0 is the top of the drawn band in both modes (live: newest; scroll: oldest).
      const frac = tickCount > 1 ? t / (tickCount - 1) : 0;
      const y = Math.round(frac * (drawnCount - 1));
      const rowIndex = scroll ? drawnCount - 1 - y : y; // scroll draws oldest-to-newest top-to-bottom
      const row = rows[rowIndex];
      if (!row || !row._receivedAt) continue;
      const pct = (y / (canvasHeight - 1)) * 100;
      // Centering every label on its row (translateY(-50%)) pushes the topmost/bottommost
      // label half its own height past the container edge, clipping it - anchor those two
      // to the edge instead (no vertical centering) and only center the ones in between.
      const posStyle = t === 0 ? `top:0;` : t === tickCount - 1 ? `bottom:0;` : `top:${pct}%;transform:translateY(-50%);`;
      labels.push(
        `<div style="position:absolute;${posStyle}right:4px;` +
          `font-size:.7rem;color:var(--secondary-text-color,#727272);white-space:nowrap;` +
          `background:var(--card-background-color,#fff);padding:0 3px;border-radius:3px;">` +
          `-${esc(fmtElapsed(now - row._receivedAt))}</div>`,
      );
    }
    axisEl.innerHTML = labels.join("");
  }

  _appendRow(sweepId, row) {
    // Sub-bin-width sweep ranges are now rejected by the add-on's own validation, but guard
    // defensively anyway - a zero-length power_db would make canvas.width 0, and
    // getImageData/createImageData throw on a zero-size request.
    if (!row.power_db || row.power_db.length === 0) return;
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(sweepId)}"]`);
    if (!canvas) return;
    const peak = this._findPeak(row);
    this._renderPeakReadout(sweepId, peak);
    if (this._scrollMode[sweepId]) {
      this._drawScrollRow(canvas, sweepId, row, peak);
    } else {
      this._drawLiveRow(canvas, row, peak);
    }
  }

  // Finds this row's strongest bin, if it stands out enough from the row's own noise floor to
  // be worth calling out - most rows are just noise with no real signal, and marking every
  // row's technical maximum (even noise has *a* highest sample) would be meaningless clutter.
  _findPeak(row) {
    const power_db = row.power_db;
    let maxDb = -Infinity;
    let maxIdx = -1;
    const finite = [];
    for (let i = 0; i < power_db.length; i++) {
      const db = power_db[i];
      if (Number.isFinite(db)) {
        finite.push(db);
        if (db > maxDb) {
          maxDb = db;
          maxIdx = i;
        }
      }
    }
    if (maxIdx < 0) return null;
    finite.sort((a, b) => a - b);
    const median = finite[Math.floor(finite.length / 2)];
    if (maxDb - median < PEAK_MIN_DELTA_DB) return null;
    return { bin: maxIdx, db: maxDb, freqHz: row.start_hz + maxIdx * row.bin_hz };
  }

  _renderPeakReadout(sweepId, peak) {
    const el = this.querySelector(`[data-sweep-peak="${CSS.escape(sweepId)}"]`);
    if (!el) return;
    el.textContent = peak ? `Peak: ${fmtMHz(peak.freqHz)} MHz — ${peak.db.toFixed(1)} dB` : "";
  }

  _drawLiveRow(canvas, row, peak) {
    const width = row.power_db.length;
    if (canvas.width !== width) canvas.width = width; // resets the bitmap; only on first row/range change
    const ctx = canvas.getContext("2d");
    const height = canvas.height;
    if (height > 1) {
      const existing = ctx.getImageData(0, 0, width, height - 1);
      ctx.putImageData(existing, 0, 1);
    }
    this._paintRow(ctx, row, width, 0, peak);
  }

  // Bulk-repaints a live-mode sweep's whole retained history (used by _renderSweeps' forced
  // rebuild - colormap/contrast change, or the scroll-mode toggle) by painting each row
  // directly at its final Y position, instead of replaying via _appendRow/_drawLiveRow one row
  // at a time. _drawLiveRow's per-arrival "scroll down by one" is right for a single new row
  // arriving live, but reusing it here would perform a full-width getImageData/putImageData
  // shift of the whole (up to WATERFALL_HEIGHT-1-row-tall) canvas for *every* retained row -
  // for a wide sweep with a full 400-row history, that's ~400 full-canvas copies for a single
  // colormap selection, easily gigabytes of synchronous pixel copying that can freeze the tab.
  // Since every row's final position is already known up front (newest at y=0, each older row
  // one below), there's nothing to shift - just paint each one once.
  _repaintLiveHistory(canvas, sweepId) {
    const rows = this._sweepRowHistory[sweepId];
    if (!rows || rows.length === 0 || !rows[0].power_db || rows[0].power_db.length === 0) return;
    const width = rows[0].power_db.length;
    if (canvas.width !== width) canvas.width = width;
    const ctx = canvas.getContext("2d");
    const count = Math.min(rows.length, canvas.height);
    for (let i = 0; i < count; i++) {
      const row = rows[i]; // rows[0] is newest - painted at y=0, same convention as _drawLiveRow
      this._paintRow(ctx, row, width, i, this._findPeak(row));
    }
    this._renderPeakReadout(sweepId, this._findPeak(rows[0]));
  }

  _drawScrollRow(canvas, sweepId, row, peak) {
    const width = row.power_db.length;
    // Captured before any resize below - resizing grows scrollHeight first, which would
    // make "was at bottom" read false right at the moment growth happens (the old scrollTop
    // is suddenly short of the new, taller scrollHeight by exactly one row) and break the
    // "only follow if the user hasn't scrolled away" logic exactly when it matters most.
    const container = canvas.closest("[data-sweep-scroll-container]");
    const wasAtBottom = container ? container.scrollTop + container.clientHeight >= container.scrollHeight - 4 : false;

    if (canvas.width !== width) {
      // Range changed - nothing pixel-wise to preserve at the old width.
      canvas.width = width;
      canvas.height = 1;
      canvas.style.height = "1px"; // the .height property is the drawing buffer, not layout size
      this._scrollDrawIndex[sweepId] = 0;
    }
    let y = this._scrollDrawIndex[sweepId] || 0;
    const ctx = canvas.getContext("2d");
    const rowCap = scrollRowCapForWidth(width);
    if (y >= canvas.height) {
      if (canvas.height >= rowCap) {
        // Cap reached - behave as a bounded sliding window instead of silently freezing
        // (dropping new data with no visible sign anything is wrong): shift the whole
        // bitmap up by one row (dropping the oldest) and draw the new row in the now-empty
        // bottom slot, the same way live mode drops its oldest row off the top.
        // A canvas may draw itself as its own source (self-blit): per spec, drawImage takes
        // an implicit snapshot of the source at call time, so there's no feedback corruption,
        // and the browser's compositor performs the shift without a CPU pixel readback. The
        // earlier getImageData/putImageData round-trip forced a full framebuffer readback on
        // every single row once the cap was reached - not the shift itself, but that readback,
        // was the freeze risk (~100MB copied per row for a narrow/fast sweep at the 200MB cap).
        ctx.drawImage(canvas, 0, -1);
        y = canvas.height - 1;
      } else {
        // Still growing (no pre-allocation): canvas resize clears its bitmap, so blit the
        // existing content into a temp canvas first, then back, to preserve it.
        const temp = document.createElement("canvas");
        temp.width = canvas.width;
        temp.height = canvas.height;
        temp.getContext("2d").drawImage(canvas, 0, 0);
        canvas.height += 1;
        // The CSS style height is what actually controls the visible/layout size - the
        // .height property alone only resizes the drawing buffer. Without this, the
        // container's scrollable content height stays frozen at whatever the very first
        // render happened to set it to (often 1px), so drawn rows accumulate correctly in
        // the bitmap but are squeezed into an invisible sliver - looks exactly like data
        // being silently lost even though every row is still there internally.
        canvas.style.height = canvas.height + "px";
        ctx.drawImage(temp, 0, 0);
        y = canvas.height - 1;
      }
    }
    this._paintRow(ctx, row, width, y, peak);
    this._scrollDrawIndex[sweepId] = Math.min(y + 1, rowCap);
    if (container && wasAtBottom) container.scrollTop = container.scrollHeight;
  }

  _paintRow(ctx, row, width, y, peak) {
    const rowImage = ctx.createImageData(width, 1);
    const colorFn = (COLORMAPS[this._colormap] || COLORMAPS.sequential).fn;
    for (let i = 0; i < width; i++) {
      const db = row.power_db[i];
      const t = Number.isFinite(db) ? (db - this._dbMin) / (this._dbMax - this._dbMin) : 0;
      const [r, g, b] = colorFn(t);
      rowImage.data[i * 4] = r;
      rowImage.data[i * 4 + 1] = g;
      rowImage.data[i * 4 + 2] = b;
      rowImage.data[i * 4 + 3] = 255;
    }
    if (peak) {
      // Overwrite the peak bin's pixel with a stark, unmistakable color - baked directly into
      // the bitmap (not a separate overlay), so it stays exactly where it happened even once
      // this row scrolls into history, without needing to track marker positions separately.
      // Pure red rather than white: white is a real, reachable value in every colormap (it's
      // exactly what Grayscale clamps to at/above the contrast max), so a strong or
      // contrast-saturated signal would otherwise paint right over the marker and hide it.
      // None of COLORMAPS' ramps (blue, viridis, grayscale) ever produce pure red, so it stays
      // visually distinct regardless of which colormap is active.
      rowImage.data[peak.bin * 4] = 255;
      rowImage.data[peak.bin * 4 + 1] = 0;
      rowImage.data[peak.bin * 4 + 2] = 0;
      rowImage.data[peak.bin * 4 + 3] = 255;
    }
    ctx.putImageData(rowImage, 0, y);
  }

  // ── forms ────────────────────────────────────────────────────────────────

  // The panel always knows exactly which specific device its dropdown displayed - passing its
  // driver along unconditionally as a disambiguator lets the add-on's optional dongle_driver
  // field resolve an otherwise-ambiguous serial (e.g. two different SoapySDR drivers, or
  // devices that both omit a serial) without the panel needing to react after the fact.
  _selectedDongleDriver(form) {
    const select = form.querySelector('select[name="dongle_serial"]');
    const option = select && select.selectedOptions[0];
    return (option && option.dataset.driver) || undefined;
  }

  _sweepYaml(s) {
    // Includes every field the add-on's SweepCreate accepts, not just the ones the add-sweep
    // form itself exposes - a sweep started with a non-default sample_rate (or one whose
    // dongle_serial is ambiguous across drivers) needs those in the export too, or "copy as
    // YAML" recreates a materially different sweep (default sample_rate) or fails outright
    // (DuplicateDongleSerialError) instead of reproducing this exact running sweep.
    return yamlServiceCall("sdr_hub.add_sweep", {
      dongle_serial: s.dongle_serial,
      dongle_driver: s.dongle_driver,
      start_hz: s.start_hz,
      stop_hz: s.stop_hz,
      gain: s.gain,
      sample_rate: s.sample_rate,
      label: s.label,
    });
  }

  _receiverYaml(r) {
    // See _sweepYaml above - dongle_driver disambiguates a shared serial across drivers, and a
    // non-default protocols filter must round-trip too, or the copied action either fails on
    // an ambiguous serial or silently decodes a broader set of protocols than this receiver
    // was actually restricted to.
    return yamlServiceCall("sdr_hub.add_receiver", {
      dongle_serial: r.dongle_serial,
      dongle_driver: r.dongle_driver,
      frequencies_hz: r.frequencies_hz,
      hop_interval_s: r.hop_interval_s,
      protocols: r.protocols,
      label: r.label,
    });
  }

  // Combines every currently active sweep and receiver into one YAML action list - the per-item
  // "Copy as YAML" buttons already cover recreating a single one; this is for pasting a whole
  // dashboard's worth of captures into one automation/script at once instead of copying each
  // action separately and assembling the list by hand.
  _allConfigYaml() {
    const items = [
      ...(this._state.sweeps || []).map((s) => yamlAsListItem(this._sweepYaml(s))),
      ...(this._state.receivers || []).map((r) => yamlAsListItem(this._receiverYaml(r))),
    ];
    return items.length ? items.join("\n") : "# No active sweeps or receivers to copy.";
  }

  // Requires a second click within CONFIRM_WINDOW_MS before actually invoking onConfirm - guards
  // a running sweep/receiver (which can represent minutes to hours of unsaved capture history)
  // against being stopped by a single stray or misdirected click, without the accessibility/
  // automation-blocking downsides of a native window.confirm() dialog.
  _wireConfirmButton(button, onConfirm, confirmText = "Confirm stop?") {
    const CONFIRM_WINDOW_MS = 4000;
    const original = button.textContent;
    let armed = false;
    let timer = null;
    const disarm = () => {
      armed = false;
      clearTimeout(timer);
      button.textContent = original;
    };
    button.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        button.textContent = confirmText;
        timer = setTimeout(disarm, CONFIRM_WINDOW_MS);
        return;
      }
      disarm();
      onConfirm();
    });
  }

  // Generic "copy this text to the clipboard, then briefly confirm" wiring shared by every
  // copy-as-YAML button - transient button-text feedback since there's nowhere else obvious to
  // confirm a clipboard write succeeded.
  _wireCopyButton(button, textFn) {
    button.addEventListener("click", async () => {
      const original = button.textContent;
      const text = textFn();
      try {
        // navigator.clipboard requires a secure context (HTTPS or localhost) - it's simply
        // undefined otherwise, which is exactly the case for the plain-HTTP HA installs this
        // project's own README documents (HA_URL=http://homeassistant.local:8123). Falling
        // through to the execCommand("copy") + off-screen-textarea trick keeps the button
        // working there instead of only ever showing an error.
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else if (!this._copyViaExecCommand(text)) {
          throw new Error("Clipboard access unavailable in this browser context");
        }
        button.textContent = "Copied!";
      } catch (err) {
        this._showError(`Could not copy to clipboard: ${err.message || err}`);
      }
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    });
  }

  // Legacy fallback for browsers/contexts without the (secure-context-only) Clipboard API.
  // Selecting the text in an off-screen textarea and invoking the deprecated but still
  // universally-supported document.execCommand("copy") is the standard workaround for this.
  _copyViaExecCommand(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.top = "0";
    textarea.style.left = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  // canvas.toBlob() (not toDataURL(), which base64-encodes the whole image in memory as a
  // string first) generates the PNG bytes directly - meaningfully cheaper for a large scroll-
  // mode waterfall, which can be many thousands of pixels tall.
  _saveSweepImage(sweepId) {
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(sweepId)}"]`);
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        this._showError("Could not save image: canvas produced no data");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sdr-hub-waterfall-${sweepId}-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  // Exports only the fields sdr_hub/add_sweep and sdr_hub/add_receiver actually accept (not
  // the raw state objects, which also carry server-assigned id/status) - so a re-import sends
  // exactly a valid add_* payload back, and round-tripping export→import produces the same
  // shape whether or not the file was hand-edited in between.
  _exportConfig() {
    const config = {
      version: 1,
      exported_at: new Date().toISOString(),
      sweeps: (this._state.sweeps || []).map((s) => ({
        dongle_serial: s.dongle_serial,
        dongle_driver: s.dongle_driver,
        start_hz: s.start_hz,
        stop_hz: s.stop_hz,
        gain: s.gain,
        sample_rate: s.sample_rate,
        label: s.label,
      })),
      receivers: (this._state.receivers || []).map((r) => ({
        dongle_serial: r.dongle_serial,
        dongle_driver: r.dongle_driver,
        frequencies_hz: r.frequencies_hz,
        hop_interval_s: r.hop_interval_s,
        protocols: r.protocols,
        label: r.label,
      })),
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sdr-hub-config-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Builds the WS payload from only the known add_sweep/add_receiver fields, dropping anything
  // else in the imported JSON (e.g. a stray id/status if the file was edited from exported
  // state elsewhere) - the websocket_api schema rejects unknown keys outright, so forwarding
  // the parsed object as-is would fail the whole import on an otherwise-harmless extra field.
  _sweepImportPayload(s) {
    const payload = { type: "sdr_hub/add_sweep", dongle_serial: s.dongle_serial, start_hz: s.start_hz, stop_hz: s.stop_hz };
    if (s.dongle_driver) payload.dongle_driver = s.dongle_driver;
    if (s.label) payload.label = s.label;
    if (Number.isFinite(s.gain)) payload.gain = s.gain;
    if (Number.isFinite(s.sample_rate)) payload.sample_rate = s.sample_rate;
    return payload;
  }

  _receiverImportPayload(r) {
    const payload = { type: "sdr_hub/add_receiver", dongle_serial: r.dongle_serial, frequencies_hz: r.frequencies_hz };
    if (r.dongle_driver) payload.dongle_driver = r.dongle_driver;
    if (r.label) payload.label = r.label;
    if (Number.isFinite(r.hop_interval_s)) payload.hop_interval_s = r.hop_interval_s;
    if (Array.isArray(r.protocols) && r.protocols.length) payload.protocols = r.protocols;
    return payload;
  }

  async _onImportConfigFile(ev) {
    const file = ev.target.files[0];
    ev.target.value = ""; // clears the input so re-selecting the same file later still fires "change"
    if (!file) return;
    let config;
    try {
      config = JSON.parse(await file.text());
    } catch (err) {
      this._showError(`Could not read config file: ${err.message || err}`);
      return;
    }
    // Requires the actual shape _exportConfig() writes (a numeric version marker plus real
    // sweeps/receivers arrays), not just "any object" - a random unrelated JSON file (e.g. a
    // package.json picked by mistake) would otherwise sail through this check, have its missing
    // sweeps/receivers default to empty arrays below, and report a successful no-op import,
    // misleading the user into thinking their actual backup was restored. Empty arrays are
    // still accepted here (a backup with nothing active is legitimate) - only their absence, or
    // an unrecognized version, is rejected.
    if (
      !config ||
      typeof config !== "object" ||
      config.version !== 1 ||
      !Array.isArray(config.sweeps) ||
      !Array.isArray(config.receivers)
    ) {
      this._showError("Config file is not a valid SDR Hub backup");
      return;
    }
    const sweeps = config.sweeps;
    const receivers = config.receivers;
    const errors = [];
    // Sequential (not Promise.all) so a busy/duplicate dongle rejection on one entry doesn't
    // race the add-on's per-dongle ownership check against another entry targeting the same
    // hardware in the same import.
    for (const s of sweeps) {
      // typeof check, not truthiness - some SDR devices legitimately omit a serial, so
      // dongle_serial: "" is a real device's export (the panel itself supports selecting
      // these; see _renderDongleOptions' hasPreference handling of the same case), not a
      // malformed entry. A truthy check would reject re-importing the panel's own backup for
      // exactly those devices.
      if (!s || typeof s.dongle_serial !== "string" || !Number.isFinite(s.start_hz) || !Number.isFinite(s.stop_hz)) {
        errors.push(`Skipped an invalid sweep entry (missing dongle_serial/start_hz/stop_hz)`);
        continue;
      }
      // A present-but-malformed optional value (e.g. a hand-edited sample_rate stored as a
      // string or null) must reject the entry, not silently fall through to add_sweep's
      // default - _sweepImportPayload only forwards optionals that are already valid numbers,
      // so without this check a materially different sweep gets created while import still
      // reports success.
      if (invalidOptionalNumber(s, "gain") || invalidOptionalNumber(s, "sample_rate")) {
        errors.push(`Skipped sweep entry ${s.label || s.dongle_serial}: gain/sample_rate must be a number if present`);
        continue;
      }
      try {
        await this._callWS(this._sweepImportPayload(s));
      } catch (err) {
        errors.push(`Sweep ${s.label || s.dongle_serial}: ${err.message || err}`);
      }
    }
    for (const r of receivers) {
      // See the matching typeof check in the sweep loop above - same "" is a valid serial-less
      // device reasoning applies here.
      if (!r || typeof r.dongle_serial !== "string" || !Array.isArray(r.frequencies_hz) || r.frequencies_hz.length === 0) {
        errors.push(`Skipped an invalid receiver entry (missing dongle_serial/frequencies_hz)`);
        continue;
      }
      // See the matching gain/sample_rate check in the sweep loop above.
      if (invalidOptionalNumber(r, "hop_interval_s") || invalidOptionalProtocols(r)) {
        errors.push(
          `Skipped receiver entry ${r.label || r.dongle_serial}: hop_interval_s must be a number and protocols must be a list of integers, if present`,
        );
        continue;
      }
      try {
        await this._callWS(this._receiverImportPayload(r));
      } catch (err) {
        errors.push(`Receiver ${r.label || r.dongle_serial}: ${err.message || err}`);
      }
    }
    this._showError(errors.length ? `Imported with ${errors.length} issue(s): ${errors.join("; ")}` : "");
    await this._loadState();
  }

  async _onAddSweep(ev) {
    ev.preventDefault();
    // Captured once, synchronously, rather than reading `ev.target` again after the `await`
    // below - some environments null out an Event's `target` once its dispatch has finished,
    // which silently threw from the second `_selectedDongleDriver(ev.target)` call below (inside
    // saveFormPrefs's arguments), skipping saveFormPrefs entirely and surfacing a confusing
    // "Could not start sweep: Cannot read properties of null" error even on a successful submit.
    const formEl = ev.target;
    const form = new FormData(formEl);
    const wantsScroll = form.get("scroll_mode") === "on"; // unchecked checkboxes are absent from FormData
    // Only true once a new sweep id actually exists and had scroll mode applied to it - a
    // rejected add_sweep (busy dongle, validation error) has no sweep to apply it to, and
    // forcing a rebuild in that case would pointlessly bypass _renderSweeps()'s no-op guard and
    // replay every *other* already-rendered sweep's full retained history, which is exactly the
    // expensive-redraw problem that guard exists to avoid.
    let forceRebuild = false;
    try {
      const sweep = await this._callWS({
        type: "sdr_hub/add_sweep",
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(formEl),
        start_hz: Number(form.get("start_mhz")) * 1e6,
        stop_hz: Number(form.get("stop_mhz")) * 1e6,
        gain: Number(form.get("gain")),
        label: form.get("label") || undefined,
      });
      // Pre-select scroll mode before _loadState()/_renderSweeps() ever creates this sweep's
      // canvas, so it's built at the right size from its very first row instead of the user
      // having to find and check the box after the fact.
      if (wantsScroll && sweep && sweep.id) {
        this._scrollMode[sweep.id] = true;
        forceRebuild = true;
      }
      // Only remembered once the add-on actually accepted these values - a rejected submission
      // (validation error) shouldn't overwrite a previously-working set of defaults.
      saveFormPrefs(SWEEP_FORM_PREFS_KEY, {
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(formEl) ?? "",
        start_mhz: form.get("start_mhz"),
        stop_mhz: form.get("stop_mhz"),
        gain: form.get("gain"),
        scroll_mode: wantsScroll,
      });
      this._showError("");
    } catch (err) {
      this._showError(`Could not start sweep: ${err.message || err}`);
    }
    // The add-on's own state_changed broadcast for a successfully-created sweep can arrive and
    // trigger a _loadState() (via _handleEvent) before this call's own add_sweep response
    // resolves above - that earlier, racing _loadState() already builds and caches the new
    // sweep's canvas in live mode (since _scrollMode[sweep.id] wasn't set yet at that point). The
    // no-op-refresh skip in _renderSweeps() then sees an unchanged id/status set on THIS call's
    // own _loadState() and skips rebuilding, silently discarding the scroll-mode selection just
    // made above. Force a rebuild only in that specific case so it actually takes effect.
    await this._loadState(forceRebuild);
  }

  async _onRemoveSweep(sweepId) {
    try {
      await this._callWS({ type: "sdr_hub/remove_sweep", sweep_id: sweepId });
      this._showError("");
    } catch (err) {
      this._showError(`Could not stop sweep: ${err.message || err}`);
    }
    await this._loadState();
  }

  // Snapshots ids up front rather than iterating this._state.sweeps directly - each removal's
  // own _loadState() reassigns this._state (and thus .sweeps) as it goes, so iterating the live
  // array while removing from it would skip entries. Sequential (not Promise.all) so overlapping
  // _loadState() calls can't resolve out of order and reintroduce a sweep that was already
  // removed - see _loadState's own request-id-guard comment.
  //
  // Doesn't delegate to _onRemoveSweep here (unlike a single stop click) because that method
  // calls _showError() on every iteration - a later successful removal would erase an earlier
  // failure's message even though that sweep is still running. Errors are accumulated instead
  // and reported together once the whole loop finishes.
  async _onStopAllSweeps() {
    const errors = [];
    for (const id of this._state.sweeps.map((s) => s.id)) {
      try {
        await this._callWS({ type: "sdr_hub/remove_sweep", sweep_id: id });
      } catch (err) {
        errors.push(err.message || err);
      }
      await this._loadState();
    }
    this._showError(errors.length ? `Could not stop all sweeps: ${errors.join("; ")}` : "");
  }

  async _onAddReceiver(ev) {
    ev.preventDefault();
    // See _onAddSweep's identical formEl capture above - same reasoning.
    const formEl = ev.target;
    const form = new FormData(formEl);
    const frequenciesHz = String(form.get("frequencies_mhz"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s) * 1e6);
    try {
      await this._callWS({
        type: "sdr_hub/add_receiver",
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(formEl),
        frequencies_hz: frequenciesHz,
        hop_interval_s: Number(form.get("hop_interval_s")) || 10,
        label: form.get("label") || undefined,
      });
      // Only remembered once the add-on actually accepted these values - see _onAddSweep.
      saveFormPrefs(RECEIVER_FORM_PREFS_KEY, {
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(formEl) ?? "",
        frequencies_mhz: form.get("frequencies_mhz"),
        hop_interval_s: form.get("hop_interval_s"),
      });
      this._showError("");
    } catch (err) {
      this._showError(`Could not start receiver: ${err.message || err}`);
    }
    await this._loadState();
  }

  async _onRemoveReceiver(receiverId) {
    try {
      await this._callWS({ type: "sdr_hub/remove_receiver", receiver_id: receiverId });
      this._showError("");
    } catch (err) {
      this._showError(`Could not stop receiver: ${err.message || err}`);
    }
    await this._loadState();
  }

  // See _onStopAllSweeps above - same snapshot-ids-then-sequentially-remove reasoning, and same
  // reason for accumulating errors instead of delegating to _onRemoveReceiver.
  async _onStopAllReceivers() {
    const errors = [];
    for (const id of this._state.receivers.map((r) => r.id)) {
      try {
        await this._callWS({ type: "sdr_hub/remove_receiver", receiver_id: id });
      } catch (err) {
        errors.push(err.message || err);
      }
      await this._loadState();
    }
    this._showError(errors.length ? `Could not stop all receivers: ${errors.join("; ")}` : "");
  }
}

customElements.define("sdr-hub-panel", SdrHubPanel);
