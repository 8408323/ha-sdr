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

// Remembers the last values a user actually submitted in the add-sweep/add-receiver forms
// (start/stop/gain/frequencies/hop-interval/scroll-mode/dongle), so reopening the panel - or a
// page reload, which resets all in-memory JS state - doesn't reset a user's typical settings
// back to the hardcoded defaults every time. Scoped to localStorage (this browser only,
// survives reloads) rather than any server-side state, since these are pure UI conveniences,
// not something another client or an automation needs to see.
const SWEEP_FORM_PREFS_KEY = "sdr_hub_sweep_form_prefs";
const RECEIVER_FORM_PREFS_KEY = "sdr_hub_receiver_form_prefs";
const HELP_DISMISSED_KEY = "sdr_hub_help_dismissed";

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
    this._decodedLog = []; // most-recent-first
    this._decodedFilter = ""; // lowercased substring match against model/id, "" = show all
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
      if (!this._decodedAgeInterval) {
        this._decodedAgeInterval = setInterval(() => this._renderDecodedLog(), 30000);
      }
    }
  }

  set panel(panel) {
    this._panel = panel;
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
      this._renderDecodedLog();
    } else if (event.type === "status" || event.type === "state_changed") {
      // A receiver/sweep died, or something else changed the add-on's state from outside
      // this panel (an automation service call, another open panel) - reload the
      // authoritative snapshot rather than hand-patch local state.
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
    const sweepPrefs = loadFormPrefs(SWEEP_FORM_PREFS_KEY);
    const receiverPrefs = loadFormPrefs(RECEIVER_FORM_PREFS_KEY);
    // "Dismissed" only skips showing it by default on load - the Help button in the header
    // always reopens it, so dismissing is never a one-way door for a first-time user who
    // dismissed too quickly or wants a refresher later.
    const helpDismissed = localStorage.getItem(HELP_DISMISSED_KEY) === "true";
    this.innerHTML = `
      <div id="sdr-hub-root" style="padding:16px;max-width:960px;margin:0 auto;font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h1 style="font-size:1.4rem;margin:0;color:var(--primary-text-color,#212121);">SDR Hub</h1>
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
          <div id="sdr-hub-receivers"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Decoded devices</h2>
          <input id="sdr-hub-decoded-filter" type="text" placeholder="Filter by model or id…" style="${INPUT};width:100%;margin-bottom:8px;box-sizing:border-box;">
          <div id="sdr-hub-decoded" style="max-height:240px;overflow-y:auto;"></div>
        </div>
      </div>
    `;

    this.querySelector("#sdr-hub-decoded-filter").addEventListener("input", (ev) => {
      this._decodedFilter = ev.target.value.trim().toLowerCase();
      this._renderDecodedLog();
    });
    const helpEl = this.querySelector("#sdr-hub-help");
    this.querySelector("[data-show-help]").addEventListener("click", () => {
      helpEl.style.display = "block";
    });
    helpEl.querySelector("[data-dismiss-help]").addEventListener("click", () => {
      localStorage.setItem(HELP_DISMISSED_KEY, "true");
      helpEl.style.display = "none";
    });
    this.querySelector("#sdr-hub-add-sweep").addEventListener("submit", (ev) => this._onAddSweep(ev));
    this.querySelector("#sdr-hub-add-receiver").addEventListener("submit", (ev) => this._onAddReceiver(ev));
    this._wirePresetSelect("sdr-hub-add-sweep", SWEEP_PRESETS);
    this._wirePresetSelect("sdr-hub-add-receiver", RECEIVER_PRESETS);
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
        const viewportHeight = this._viewportHeight[s.id] ?? WATERFALL_HEIGHT;
        const rangeText = `${fmtMHz(s.start_hz)}–${fmtMHz(s.stop_hz)} MHz`;
        const titleHtml = s.label
          ? `<strong>${esc(s.label)}</strong> <span style="color:var(--secondary-text-color,#727272);">(${rangeText})</span>`
          : rangeText;
        return `
      <div style="margin-bottom:16px;">
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
            <canvas data-sweep-canvas="${esc(s.id)}" height="${canvasHeight}"
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
      el.querySelector(`[data-remove-sweep="${CSS.escape(s.id)}"]`).addEventListener("click", () =>
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
      // retained history oldest-to-newest so the full waterfall reappears instead of just
      // the latest row, matching what hover (which reads the same history) implies is there.
      this._scrollDrawIndex[s.id] = 0;
      const rows = this._sweepRowHistory[s.id];
      if (rows) {
        for (let i = rows.length - 1; i >= 0; i--) this._appendRow(s.id, rows[i]);
      }
      this._renderTimeAxis(s.id);
    }
  }

  _renderReceivers() {
    const el = this.querySelector("#sdr-hub-receivers");
    if (!el) return;
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
          .map(
            (r) => `
          <tr>
            <td>${r.label ? esc(r.label) : `<em style="color:var(--secondary-text-color,#727272);">—</em>`}</td>
            <td>${r.frequencies_hz.map(fmtMHz).join(", ")} MHz</td>
            <td>${esc(r.dongle_serial)}</td>
            <td>${r.status === "error" ? `<span style="color:var(--error-color,#db4437);">error</span>` : "running"}</td>
            <td style="display:flex;gap:8px;">
              <button data-copy-receiver-yaml="${esc(r.id)}" title="Copy as an sdr_hub.add_receiver automation action" style="${BTN_SECONDARY}">Copy as YAML</button>
              <button data-remove-receiver="${esc(r.id)}" style="${BTN_DANGER}">Stop</button>
            </td>
          </tr>`,
          )
          .join("")}
      </table>
      </div>`;
    for (const r of this._state.receivers) {
      el.querySelector(`[data-remove-receiver="${CSS.escape(r.id)}"]`).addEventListener("click", () =>
        this._onRemoveReceiver(r.id),
      );
      this._wireCopyButton(el.querySelector(`[data-copy-receiver-yaml="${CSS.escape(r.id)}"]`), () =>
        this._receiverYaml(r),
      );
    }
  }

  _renderDecodedLog() {
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
      return;
    }
    const now = Date.now();
    el.innerHTML = filtered
      .map((event) => {
        const d = event.device || {};
        const idParts = [d.id != null ? `id ${d.id}` : null, d.channel != null ? `ch ${d.channel}` : null].filter(
          Boolean,
        );
        const fields = Object.keys(d)
          .filter((k) => !DECODED_HIDDEN_FIELDS.has(k))
          .map((k) => fmtDecodedField(k, d[k]));
        const age = event._receivedAt ? `-${fmtElapsed(now - event._receivedAt)}` : "";
        return `
          <div style="padding:6px 0;border-bottom:1px solid var(--divider-color,#e0e0e0);">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <strong>${esc(d.model || "Unknown device")}</strong>
              <span style="font-size:.75rem;color:var(--secondary-text-color,#727272);">${esc(age)}</span>
            </div>
            ${idParts.length ? `<div style="font-size:.8rem;color:var(--secondary-text-color,#727272);">${esc(idParts.join(", "))}</div>` : ""}
            ${fields.length ? `<div style="font-size:.85rem;">${fields.map(esc).join(" · ")}</div>` : ""}
          </div>`;
      })
      .join("");
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
    for (let i = 0; i < width; i++) {
      const db = row.power_db[i];
      const t = Number.isFinite(db) ? (db - WATERFALL_MIN_DB) / (WATERFALL_MAX_DB - WATERFALL_MIN_DB) : 0;
      const [r, g, b] = sequentialColor(t);
      rowImage.data[i * 4] = r;
      rowImage.data[i * 4 + 1] = g;
      rowImage.data[i * 4 + 2] = b;
      rowImage.data[i * 4 + 3] = 255;
    }
    if (peak) {
      // Overwrite the peak bin's pixel with a stark, unmistakable color - baked directly into
      // the bitmap (not a separate overlay), so it stays exactly where it happened even once
      // this row scrolls into history, without needing to track marker positions separately.
      rowImage.data[peak.bin * 4] = 255;
      rowImage.data[peak.bin * 4 + 1] = 255;
      rowImage.data[peak.bin * 4 + 2] = 255;
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

  async _onAddSweep(ev) {
    ev.preventDefault();
    const form = new FormData(ev.target);
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
        dongle_driver: this._selectedDongleDriver(ev.target),
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
        dongle_driver: this._selectedDongleDriver(ev.target) ?? "",
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

  async _onAddReceiver(ev) {
    ev.preventDefault();
    const form = new FormData(ev.target);
    const frequenciesHz = String(form.get("frequencies_mhz"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s) * 1e6);
    try {
      await this._callWS({
        type: "sdr_hub/add_receiver",
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(ev.target),
        frequencies_hz: frequenciesHz,
        hop_interval_s: Number(form.get("hop_interval_s")) || 10,
        label: form.get("label") || undefined,
      });
      // Only remembered once the add-on actually accepted these values - see _onAddSweep.
      saveFormPrefs(RECEIVER_FORM_PREFS_KEY, {
        dongle_serial: form.get("dongle_serial"),
        dongle_driver: this._selectedDongleDriver(ev.target) ?? "",
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
}

customElements.define("sdr-hub-panel", SdrHubPanel);
