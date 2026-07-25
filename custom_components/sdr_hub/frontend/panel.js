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

// ── cross-tab coordination ───────────────────────────────────────────────────
//
// Every open panel tab holds its own independent WebSocket subscription and receives the exact
// same broadcasts. That shapes what does and doesn't need coordinating here:
//
//   * Decoded log and low-battery state are *convergent*. Because the add-on now stamps each
//     decoded_device with a single server-assigned event_id and received_at (see main.py's
//     on_device), every tab observes the identical event stream and, sorting by
//     (received_at, event_id) and deduping by event_id, independently computes an identical
//     result. Two tabs persisting concurrently therefore write the *same bytes*, so plain
//     last-writer-wins is harmless and no mutual exclusion is needed. (This is what an earlier
//     revision got wrong: it generated the id client-side, so one physical decode became N
//     distinct ids across N tabs and "merging" them duplicated every event.)
//   * The alert *sound* is not convergent - it's a side effect, not state, so "exactly once
//     across all tabs" genuinely needs mutual exclusion. That's what the leader election below
//     provides, and it's the only thing that needs it.
//
// Deliberately built on localStorage + BroadcastChannel rather than the Web Locks API: locks is
// [SecureContext], so `navigator.locks` is undefined on the plain-HTTP LAN origins Home
// Assistant is most commonly reached over (verified: it's present on http://localhost:8123,
// which the spec exempts, but absent on http://<lan-ip>:8123). Building coordination on it
// would silently no-op on exactly the deployments this project targets. BroadcastChannel has no
// such restriction.
const BROADCAST_CHANNEL_NAME = "sdr_hub_panel_sync";
// Which tab currently owns playing the alert sound: {tabId, ts}, refreshed by that tab's
// heartbeat. A claim older than LEADER_TTL_MS is treated as abandoned (tab closed/crashed/
// suspended) and may be taken over.
const SOUND_LEADER_KEY = "sdr_hub_sound_leader";
// Written purely to provoke a "storage" event in other tabs when BroadcastChannel is
// unavailable. The shared state itself lives in IndexedDB, which has no cross-document change
// event, so without this a browser lacking BroadcastChannel would leave peers rendering state
// that has since been cleared or updated.
const SYNC_NONCE_KEY = "sdr_hub_sync_nonce";
const LEADER_TTL_MS = 5000;
const LEADER_HEARTBEAT_MS = 2000;

// Claims `key` for `tabId` unless a different tab holds it and its claim is still fresh.
// Write-then-verify: if two tabs write in the same instant the last write wins, and re-reading
// means at most one of them sees its own id and proceeds. A split that still slips through is
// bounded by the heartbeat below, which steps down on finding the claim is no longer ours.
function claimLeadership(key, tabId) {
  try {
    const now = Date.now();
    const raw = localStorage.getItem(key);
    const current = raw ? JSON.parse(raw) : null;
    const held = current && typeof current.tabId === "string" && Number.isFinite(current.ts);
    // A timestamp in the future means the clock moved backwards after the lease was written.
    // The plain TTL test would then read negative and treat an abandoned lease as perpetually
    // fresh, muting every other tab until the clock caught up - potentially hours.
    const age = now - current?.ts;
    if (held && current.tabId !== tabId && age >= 0 && age < LEADER_TTL_MS) return false;
    localStorage.setItem(key, JSON.stringify({ tabId, ts: now }));
    const after = JSON.parse(localStorage.getItem(key) || "null");
    return !!after && after.tabId === tabId;
  } catch {
    // Storage unusable - there is no shared state to coordinate over anyway, so act
    // unilaterally rather than freezing this tab out of doing anything at all.
    return true;
  }
}

function holdsLeadership(key, tabId) {
  try {
    const raw = localStorage.getItem(key);
    const current = raw ? JSON.parse(raw) : null;
    if (!current || current.tabId !== tabId) return false;
    const age = Date.now() - current.ts;
    return age >= 0 && age < LEADER_TTL_MS;
  } catch {
    return true;
  }
}

function releaseLeadership(key, tabId) {
  try {
    const raw = localStorage.getItem(key);
    const current = raw ? JSON.parse(raw) : null;
    if (current && current.tabId === tabId) localStorage.removeItem(key);
  } catch {
    // Unavailable storage - the claim (if any) simply expires on its own.
  }
}

// ── shared persistent state (IndexedDB) ──────────────────────────────────────
//
// The decoded log and battery state live here rather than in localStorage because they are
// mutated by read-modify-write from every open tab, and localStorage offers no way to make that
// atomic: `getItem` then `setItem` is two operations another document can interleave with, so a
// lagging tab can clobber a newer value. Successive attempts to work around that - a pre-write
// generation re-read, then a single-writer leader election - each narrowed the window without
// closing it, because neither localStorage nor BroadcastChannel provides mutual exclusion and
// Web Locks is [SecureContext], hence unavailable on the plain-HTTP origins Home Assistant is
// usually reached over.
//
// IndexedDB does provide it: a `readwrite` transaction is genuinely atomic across tabs, so
// get-merge-put inside one transaction cannot interleave with another tab's. That makes the
// coordination correct by construction instead of by convention. Note the mutator passed to
// idbMutate must be synchronous - awaiting inside it would let the transaction auto-commit.
//
// localStorage is still used for the small single-writer values (plain preferences, leader
// leases) where last-writer-wins is the desired semantics anyway.
const IDB_NAME = "sdr_hub_panel";
const IDB_STORE = "state";
const IDB_KEY_BATTERY = "battery_state";
const IDB_KEY_DECODED = "decoded_log";
let _idbPromise = null;

function openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  }).catch((err) => {
    // Private browsing or a disabled store. Persistence degrades to in-memory for this session -
    // a convenience feature going away is much better than the panel refusing to work, and
    // crucially it degrades to *no sharing* rather than to unsynchronized sharing, so it cannot
    // reintroduce the clobbering this exists to prevent.
    _idbPromise = null;
    throw err;
  });
  return _idbPromise;
}

// Atomic get-merge-put. `mutate` receives the stored value (or undefined) and returns the value
// to store; returning undefined leaves it untouched. Resolves with whatever is authoritative
// afterwards, so callers never have to guess whether their write won.
async function idbMutate(key, mutate) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const getReq = store.get(key);
    let outcome;
    getReq.onsuccess = () => {
      outcome = mutate(getReq.result);
      if (outcome !== undefined) store.put(outcome, key);
      else outcome = getReq.result;
    };
    tx.oncomplete = () => resolve(outcome);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}


// Normalizes whatever came out of the store into the shapes the merge helpers expect. Guards the
// same corrupt/hand-edited cases the localStorage loaders did.
function normalizeBatteryRecord(raw) {
  const gen = raw && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
  const entries = raw && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  // The stream gaps already applied to this record. Gaps carry a server-assigned id (see
  // broadcaster.py), so every tab can recognise the same gap and apply it exactly once - without
  // inferring "has a peer already handled this?" from its own generation counter, which is
  // unreliable while a hydration is still in flight.
  //
  // A *set* rather than just the most recent one: with gaps A then B, a tab whose A handling was
  // delayed would otherwise see lastGapId === B, treat A as new, and clear a valid post-B
  // transition. Bounded, so a long-lived record cannot grow without limit; a duplicate older than
  // the window degrades to the previous behaviour rather than to something worse.
  const rawGaps = raw && Array.isArray(raw.appliedGaps) ? raw.appliedGaps.filter((g) => typeof g === "string") : [];
  const legacyGap = raw && typeof raw.lastGapId === "string" ? [raw.lastGapId] : [];
  const appliedGaps = [...new Set([...rawGaps, ...legacyGap])].slice(-MAX_TRACKED_APPLIED_GAPS);
  // Per-key memory of evicted recovery tombstones: key -> the order at which it was known to have
  // recovered. A count-limited tombstone set cannot by itself dominate an arbitrarily delayed
  // writer (a tab suspended mid-write can resume long after its device's tombstone was pushed out,
  // find the key absent, and have its stale `low` accepted as new), so this retains what those
  // evicted tombstones knew.
  //
  // Deliberately per-key rather than a single global order. A global floor rejected *any* absent
  // device's low report below it, so once 50 unrelated devices had recovered, a tab receiving a
  // genuinely late first-low for some other device silently dropped a real warning - with no
  // evidence that particular key had ever recovered. Only the key's own recovery may suppress it.
  const rawEvicted = raw && raw.evicted && typeof raw.evicted === "object" ? raw.evicted : {};
  const evicted = new Map(Object.entries(rawEvicted).filter(([, v]) => Number.isFinite(v)));
  return {
    gen,
    appliedGaps,
    evicted,
    map: new Map(
      Object.entries(entries).filter(
        ([, v]) => v && typeof v === "object" && Number.isFinite(v.ord) && typeof v.low === "boolean",
      ),
    ),
  };
}

function serializeBatteryRecord(gen, map, evicted = new Map(), appliedGaps = []) {
  return {
    gen,
    appliedGaps: appliedGaps.slice(-MAX_TRACKED_APPLIED_GAPS),
    evicted: Object.fromEntries(evicted),
    entries: Object.fromEntries(map),
  };
}

// Union of two eviction maps, keeping the highest known recovery order per key. Used wherever two
// views of the battery state are combined, so neither side's eviction knowledge is rolled back by
// merging with an older snapshot.
// Stamps the low-episode identity onto a transition given the previous state of that key.
// lowSince is the ord at which the device last went from not-low to low, carried across repeat low
// reports; a recovery ends the episode so the next low starts a new one. Alert markers are matched
// on it (see mergeBatteryLowState), which is why it must be derived from authoritative state.
function withEpisode(base, previous) {
  if (!base.low) return base;
  const lowSince = previous?.low ? (previous.lowSince ?? previous.ord) : base.ord;
  return { ...base, lowSince };
}

function mergeEvicted(a, b) {
  const out = new Map(a);
  for (const [key, ord] of b) {
    const existing = out.get(key);
    if (!Number.isFinite(existing) || ord > existing) out.set(key, ord);
  }
  // Bounded like the tombstone set itself, but far larger: entries are one number each, so this
  // stays negligible while making eviction-of-the-eviction-record vanishingly rare. Past this cap
  // the oldest knowledge is dropped and behaviour degrades to the pre-eviction-tracking case.
  if (out.size <= MAX_TRACKED_EVICTED_TOMBSTONES) return out;
  return new Map([...out.entries()].sort(([, x], [, y]) => y - x).slice(0, MAX_TRACKED_EVICTED_TOMBSTONES));
}

// Display time for a decoded event. The server's received_at is authoritative and identical in
// every tab; _receivedAt is this tab's own arrival time and exists only for events from an add-on
// that predates received_at. Preferring the server value is what keeps the stored copies of one
// event byte-identical across tabs - see the note in _persistDecodedEvent.
function decodedDisplayTime(event) {
  if (Number.isFinite(event?.received_at)) return event.received_at * 1000;
  return Number.isFinite(event?._receivedAt) ? event._receivedAt : null;
}

function normalizeDecodedRecord(raw) {
  const gen = raw && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
  const list = raw && Array.isArray(raw.entries) ? raw.entries : [];
  // Highest event order the clearing tab had already seen when it cleared. It is what lets a
  // generation mismatch be classified rather than blanket-rejected: an event ordered *after* the
  // clear is one that raced the peer notification, not one the clear was meant to remove.
  const clearedOrd = raw && Number.isFinite(raw.clearedOrd) ? raw.clearedOrd : null;
  return {
    gen,
    clearedOrd,
    log: list
      .filter(
        (e) =>
          e && typeof e === "object" && e.device && typeof e.device === "object" && isConvergentEvent(e) && e._gen === gen,
      )
      .sort(compareDecodedEvents)
      .slice(0, MAX_DECODED_LOG),
  };
}

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
// Monotonic "generation" counter, bumped by every "Clear log" click (locally or in another
// tab). Each persisted decoded-log entry is tagged with the generation read from storage at the
// moment it was written (see _persistDecodedEvent) - an entry whose generation doesn't match the
// current one belongs to an already-superseded log and is dropped on load. Reading the
// generation at *write* time, rather than stamping it when the event arrived, is what makes a
// concurrent clear impossible to race past. This also replaces an earlier
// wall-clock-timestamp-boundary approach, which couldn't order an event against a clear that
// happened in the same millisecond (Date.now() resolution is 1ms or coarser); a monotonic
// integer has no such limit.
const DECODED_LOG_GEN_KEY = "sdr_hub_decoded_log_gen";
const BATTERY_SOUND_ALERT_KEY = "sdr_hub_battery_sound_alert";
// Canonical, cross-tab-shared map of currently-low-battery devices (batteryStateKey -> {model,
// id, channel}). Convergent state: every tab observes the same battery_ok transitions from its
// own subscription and derives an identical map, so concurrent writers store the same value and
// this needs no locking - see _updateBatteryState.
const BATTERY_LOW_KEY = "sdr_hub_battery_low_state";
// Keys whose *removal* by another tab means this tab's state is stale enough to warrant a
// reload - so this doubles as both the reset list (_onResetPreferences) and the
// reload-on-external-removal trigger (_onStorageEvent). SOUND_LEADER_KEY is deliberately absent
// despite also being reset: it's removed on every ordinary detach as leadership is handed over,
// which would otherwise reload every other open tab each time any one tab navigated away.
const ALL_PREF_KEYS = [
  SWEEP_FORM_PREFS_KEY,
  RECEIVER_FORM_PREFS_KEY,
  HELP_DISMISSED_KEY,
  COLORMAP_KEY,
  DB_RANGE_KEY,
  FAVORITE_DEVICES_KEY,
  DECODED_TIME_MODE_KEY,
  DECODED_LOG_KEY,
  DECODED_LOG_GEN_KEY,
  BATTERY_SOUND_ALERT_KEY,
  BATTERY_LOW_KEY,
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



// Per-key last-writer-wins by the *server* event order (see eventOrder), which is what makes
// this map genuinely convergent rather than merely "usually the same".
//
// This map is not a set union like the decoded log - it's a fold over an ordered stream of
// battery_ok transitions, so two tabs sitting at different positions in that stream legitimately
// hold different maps. Storing a bare {model,id,channel} (as an earlier revision did) carried no
// information to reconcile them, so a lagging tab's whole-map write could resurrect a device
// that had already recovered. Tagging every entry with its transition's own server order and
// keeping the newer one makes the merge commutative, associative and idempotent - a real
// LWW-register - so write order genuinely stops mattering.
//
// Recoveries are kept as tombstones (low:false) rather than deleted for exactly the same reason:
// an absent key carries no order, so a stale "still low" write would otherwise win over a newer
// recovery simply by being present.
function mergeBatteryLowState(current, incoming, evicted = new Map()) {
  const out = new Map(current);
  for (const [key, entry] of incoming) {
    const existing = out.get(key);
    // No surviving record for this key *and* this key's own evicted tombstone says it had already
    // recovered by then: this is a delayed writer (a suspended tab resuming) whose contradicting
    // tombstone is gone. Accepting it would reinstate a warning for a device that already
    // recovered. Scoped to the key's own recovery order, so another device's recovery can never
    // suppress a legitimate late low.
    const evictedOrd = evicted.get(key);
    if (!existing && entry.low && Number.isFinite(evictedOrd) && entry.ord <= evictedOrd) continue;
    if (!existing || entry.ord > existing.ord) {
      // Carry the alert marker forward across a low->low refresh. Each repeat low report from a
      // still-low sensor has a newer ord, so replacing outright would drop alertedAt and make
      // the next comparison see the transition as never-alerted - re-playing the tone on every
      // single transmission, rather than once when it first went low.
      // Carry the marker only within the same episode (same lowSince) - across a recovery the
      // episode ends, and the next low must be able to alert again.
      const sameEpisode =
        existing && existing.low && entry.low && (existing.lowSince ?? existing.ord) === (entry.lowSince ?? entry.ord);
      const keepAlerted = sameEpisode ? existing.alertedAt : undefined;
      out.set(key, keepAlerted !== undefined ? { ...entry, alertedAt: keepAlerted } : entry);
    } else if (
      Number.isFinite(entry.alertedAt) &&
      existing.low &&
      entry.low &&
      (existing.lowSince ?? existing.ord) === (entry.lowSince ?? entry.ord) &&
      !(Number.isFinite(existing.alertedAt) && existing.alertedAt >= entry.alertedAt)
    ) {
      // The incoming copy carries an alert marker this one lacks (or a newer one) - the sound
      // leader's marker propagating. Deliberately *not* gated on equal ord: the leader writes
      // the marker without awaiting, so a repeat low with a newer ord can commit first, and an
      // ord-gated adoption would then reject the marker entirely. The device is still in the
      // same low episode either way, so keep the newer state and carry the marker onto it -
      // otherwise the episode looks unalerted once that leader closes and another tab beeps again.
      out.set(key, { ...existing, alertedAt: entry.alertedAt });
    }
  }
  // Bound low entries and tombstones *separately*. A single shared cap let healthy devices push
  // out a genuinely-low one: every healthy report refreshes its tombstone's ord, so ~100 chatty
  // healthy sensors (or noisy/rotating decoded ids) would evict the silent low device that
  // persistence exists to remember - exactly the dead-battery case, which never reports again to
  // reinstate itself. Eviction orders by transition order, not Map insertion order, so it stays
  // deterministic across tabs.
  const byRecency = (entries) => entries.sort(([, a], [, b]) => b.ord - a.ord);
  const allDead = byRecency([...out.entries()].filter(([, e]) => !e.low));
  const low = byRecency([...out.entries()].filter(([, e]) => e.low)).slice(0, MAX_TRACKED_LOW_BATTERY_DEVICES);
  const dead = allDead.slice(0, MAX_TRACKED_BATTERY_TOMBSTONES);
  // Every tombstone about to be dropped records its own key and order, so the knowledge it carried
  // ("this device had recovered by ord N") survives its eviction, scoped to the device it concerns.
  const nextEvicted = mergeEvicted(
    evicted,
    new Map(allDead.slice(MAX_TRACKED_BATTERY_TOMBSTONES).map(([k, e]) => [k, e.ord])),
  );
  if (low.length + dead.length === out.size) return { map: out, evicted: nextEvicted };
  return { map: new Map([...low, ...dead]), evicted: nextEvicted };
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



// The single value every cross-tab merge and sort orders on. Prefers the add-on's monotonic
// `seq` over its wall-clock `received_at`: a host clock can move backwards (NTP correction,
// manual change), which would make new events sort behind already-persisted ones - they'd be
// truncated away as "old", and a stale low-battery entry could never be superseded by its own
// recovery. `seq` only ever increases. received_at remains the fallback for events from an
// add-on predating it; the two never interleave in practice (an add-on either sends seq or it
// doesn't), and seq is seeded from epoch-ms so it also stays above any received_at in seconds.
function eventOrder(e) {
  return Number.isFinite(e.seq) ? e.seq : e.received_at;
}

// Total order over decoded events, newest first. Uses only server-assigned values (see
// eventOrder, then event_id as a deterministic tiebreak) so that every tab sorts an identical
// event set into an identical array - which is precisely what lets concurrent per-tab persists
// be safe without any mutual exclusion, since they then write the same value rather than
// competing ones. Never uses per-tab arrival time, which differs between tabs and would break
// that convergence.
function compareDecodedEvents(a, b) {
  const ao = eventOrder(a);
  const bo = eventOrder(b);
  if (bo !== ao) return bo - ao;
  return a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0;
}

// Anything without a server-assigned event_id and orderable position is from an add-on older
// than the change that added them (main.py's on_device). Such an event can't participate in
// cross-tab convergence - there's no shared identity to dedup on - so it's kept for *this* tab's
// live display but deliberately never persisted (see _persistDecodedEvent), rather than being
// persisted under a fabricated client-side id that would duplicate across tabs.
function isConvergentEvent(e) {
  return !!e && typeof e.event_id === "string" && Number.isFinite(eventOrder(e));
}



// Dedups by the *server-assigned* event_id and re-sorts into the canonical total order, so the
// result depends only on the set of events seen - not on which tab computed it or in what order
// its own WebSocket happened to deliver them. Two tabs running this over the same events produce
// byte-identical output, which is what makes an unsynchronized last-writer-wins persist safe.
function mergeDecodedLog(current, incoming) {
  const byId = new Map(current.map((e) => [e.event_id, e]));
  for (const e of incoming) byId.set(e.event_id, e);
  return [...byId.values()].sort(compareDecodedEvents).slice(0, MAX_DECODED_LOG);
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
// Recovered devices are retained as tombstones so a stale "still low" write can't beat a newer
// recovery (see mergeBatteryLowState). They're bounded separately from, and never compete with,
// actual low entries - a shared budget would let chatty healthy sensors evict a silent
// low-battery one. Kept smaller since a tombstone only needs to outlive in-flight peer writes,
// not remain indefinitely the way an unacknowledged low battery does.
const MAX_TRACKED_BATTERY_TOMBSTONES = 50;
// Evicted-tombstone records are a key and a number each, so this can be an order of magnitude
// larger than the tombstone cap itself at negligible cost.
const MAX_TRACKED_EVICTED_TOMBSTONES = 500;
// Applied stream-gap ids retained for duplicate detection. Gaps are rare (a full send queue or a
// reconnect), so a small window comfortably covers any realistic delay between tabs.
const MAX_TRACKED_APPLIED_GAPS = 32;

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
    // activity. Filtered to the current clear-generation on load (see DECODED_LOG_GEN_KEY) so a
    // stale, already-superseded entry can't resurface.
    // Start empty and hydrate from IndexedDB asynchronously (see _hydratePersistedState).
    this._decodedLogGen = 0;
    this._decodedLog = [];
    // Bumped synchronously whenever the log is cleared or reset. An in-flight persist/hydrate
    // captures it and discards its own result if it changed meanwhile - the generation alone
    // can't cover this, since it only advances once the clear's transaction commits, leaving a
    // window in which an older equal-generation result would repopulate what was just cleared.
    this._clearEpoch = 0;
    // In-flight generation-changing operations, per state domain - see _trackBarrier.
    this._barriers = { decoded: null, battery: null };
    // batteryStateKey(device) -> {model, id, channel, low, at, alertedAt?} - the canonical,
    // cross-tab-shared low-battery state (see BATTERY_LOW_KEY and mergeBatteryLowState).
    //
    // Deliberately seeded from storage rather than left empty, even though nothing may have been
    // subscribed since it was written, so it can be arbitrarily stale. That is a real tradeoff
    // and it's resolved in favour of restoring: the case where restoring is *wrong* (device
    // recovered while the browser was closed) self-corrects on that device's very next report,
    // typically within a minute for rtl_433 sensors - whereas the case where blanking is wrong
    // (the battery actually died, so the device has stopped transmitting entirely) is both the
    // most important one to surface and the one that would never repair itself, since no further
    // report is coming. Every entry carries its transition time in `at`, so staleness is at
    // least representable if this is ever revisited.
    //
    // The exception is a stream_gap/reconnect, where the loss is upstream of every tab so no
    // peer's value is any better - _handleEvent clears it outright there rather than restoring.
    this._deviceBatteryOk = new Map();
    this._maxSeenOrd = 0;
    // Bumped synchronously by every battery invalidation. An operation captures it on arrival and
    // re-checks after waiting, which is the only way to tell "nothing happened while I waited"
    // from "an invalidation ran while I waited" - the generation alone cannot, since after the
    // wait it already reads the post-invalidation value.
    this._batteryEpoch = 0;
    this._batteryGen = 0;
    // Per-key evicted-tombstone knowledge, mirrored from the durable record (see mergeEvicted).
    this._batteryEvicted = new Map();
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
    // Identifies this specific tab in the sound-leader election (see _claimSoundLeadership) -
    // random per panel instance, never persisted, since it's meaningless outside this document's
    // lifetime.
    this._tabId = generateId();
    this._soundLeaderTimer = null;
    this._broadcastChannel = null;
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
      // Captured as a promise and awaited by every mutation path before it reads a generation.
      // These were previously started but not awaited before _subscribe() opened the live
      // stream, so a decode arriving in that window captured generation 0, no-opped against a
      // higher stored generation, and then had its own optimistic update overwritten by the
      // empty settled record it read back - the event vanished from the tab that saw it.
      this._hydrated = this._trackBarrier("both", Promise.all([this._hydrateDecodedLog(), this._hydrateBatteryState()]));
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
      const wasDisconnected = this._connectionStatus === "disconnected";
      this._connectionStatus = "connected";
      this._renderConnectionStatus();
      // An HA-side restart or integration reload drops this WebSocket and the client silently
      // resubscribes without detaching this element, so events can be missed with no
      // stream_gap/stream_reconnected to signal it (coordinator.py emits the latter only after
      // its *first* connection).
      //
      // Crucially this is a *local* loss, unlike a stream gap: only this tab's socket dropped,
      // and other tabs may have stayed connected throughout with an accurate map. Publishing a
      // dominant global clear here would destroy their correct state - and if the affected
      // device has stopped transmitting, that warning would never come back. So re-sync from
      // shared storage instead, which is exactly what a still-connected peer has been keeping
      // up to date, and don't touch the generation.
      if (wasDisconnected) {
        // The decoded log is re-read too. While this tab's socket was down a still-connected
        // peer could have persisted events it never saw, and nothing else would pull them in:
        // peer notifications are one-shot, so if decoding then goes quiet the log stays missing
        // that history indefinitely. Merged rather than adopted - this tab stayed attached and
        // its own in-memory log is not stale, just incomplete.
        this._hydrated = this._trackBarrier("both", Promise.all([this._hydrateBatteryState({ adopt: true }), this._hydrateDecodedLog()]));
      }
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
      // this tab's in-memory state is now stale and there's a full reset to pick up - reloading
      // (matching _onResetPreferences()'s own approach) is the simplest way to guarantee this tab
      // picks that up instead of racing it with its own subsequent writes.
      if (ev.newValue === null && (ev.key === null || ALL_PREF_KEYS.includes(ev.key))) {
        location.reload();
        return;
      }
      // Fallback notification from a peer without BroadcastChannel - re-read both stores.
      // Tracked with the barriers for exactly the same reason as the BroadcastChannel branches:
      // a peer's clear or reset advances a generation, and an untracked read here lets a local
      // decode or transition capture the old one, no-op, and lose its optimistic update. This
      // path is the one taken when BroadcastChannel is unavailable, so leaving it untracked made
      // the protection depend on which notification mechanism happened to be in use.
      if (ev.key === SYNC_NONCE_KEY) {
        this._trackBarrier("decoded", this._hydrateDecodedLog());
        this._trackBarrier("battery", this._hydrateBatteryState());
        return;
      }
      // Another tab's decoded-log write or "Clear log" click - reload the canonical state
      // Same reasoning for the battery map, using its own LWW merge so a lagging peer's write
      // can't resurrect a device this tab already saw recover.
      // The sound preference is a single user choice, not per-tab - keep the checkbox and the
      // in-memory flag in step when it's toggled elsewhere, so a tab left open doesn't keep
      // contending for (or ignoring) the alert based on a setting the user has since changed.
      if (ev.key === BATTERY_SOUND_ALERT_KEY) {
        this._batterySoundEnabled = loadBatterySoundEnabled();
        const toggle = this.querySelector("#sdr-hub-battery-sound-toggle");
        if (toggle) toggle.checked = this._batterySoundEnabled;
        if (this._batterySoundEnabled) {
          // Re-arm the gesture unlock. _wireAudioUnlock consumes its listeners on the first
          // gesture, and if sound happened to be disabled at that moment it created no
          // AudioContext - so without re-arming, a tab enabled from elsewhere could never
          // satisfy _canPlayAlertSound() and would stay silent (and stop contending for the
          // alert) until a reload or a local toggle, even after the enabling tab closed.
          // Only re-arm if the previous one-time listener has actually been consumed. Forcing
          // the flag false while it is still armed would attach a second listener and overwrite
          // _audioUnlockAbort, leaving the first one's signal unreachable - it would then never
          // detach and would keep firing on every gesture, across detach/reattach cycles.
          if (!this._audioUnlockAbort || this._audioUnlockAbort.signal.aborted) {
            this._audioUnlockWired = false;
            this._wireAudioUnlock();
          }
        } else {
          // Stop contending if it was just turned off here; the claim then expires on its own.
          this._releaseSoundLeadership();
        }
      }
    };
    window.addEventListener("storage", this._onStorageEvent);
    // BroadcastChannel carries the handful of things that *aren't* convergent derived state and
    // so can't just be re-read from storage - currently only an explicit "Clear log" action,
    // which needs to reach other tabs promptly rather than whenever they next happen to look.
    // Chosen over the Web Locks API for cross-tab work generally because, unlike locks, it is
    // available in insecure contexts (see BROADCAST_CHANNEL_NAME's comment).
    try {
      this._broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      this._broadcastChannel.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        // Tracked with the barrier, exactly like initial and reconnect hydration: a peer's clear
        // or invalidation advances the generation, so an untracked read here leaves a decode
        // arriving mid-read free to capture the old generation, no-op against the bumped one, and
        // then lose its optimistic entry when the empty record is applied. If the peer that
        // cleared has since closed, nothing else would ever persist that event.
        if (msg.kind === "decoded_changed") {
          this._trackBarrier("decoded", this._hydrateDecodedLog());
          return;
        }
        if (msg.kind === "legacy_alert") {
          // Applied only within the same episode, so a marker delayed past a recovery can't
          // silence the next one. Local-only, exactly like the transition it refers to.
          const entry = this._deviceBatteryOk.get(msg.key);
          if (entry && entry.low && (entry.lowSince ?? entry.ord) === msg.lowSince && !Number.isFinite(entry.alertedAt)) {
            this._deviceBatteryOk = new Map(this._deviceBatteryOk).set(msg.key, { ...entry, alertedAt: msg.ord });
          }
          return;
        }
        if (msg.kind === "battery_changed") {
          this._trackBarrier("battery", this._hydrateBatteryState());
          return;
        }
        if (msg.kind === "state_reset") {
          // A peer cleared the IndexedDB-backed state. Its own localStorage removals may have
          // been no-ops (everything already at defaults), so this is the only signal.
          // Cleared locally for immediate feedback, then re-read from IndexedDB rather than
          // left at generation 0. The reset writes empty records at *previous generation + 1*,
          // so pinning the caches to 0 made this tab's next event stamp expectedGen 0, no-op
          // against the higher stored generation, and lose that first post-reset report. adopt
          // because a reset is authoritative - merging would resurrect what it removed.
          this._clearEpoch++;
          this._decodedLog = [];
          this._deviceBatteryOk = new Map();
          this._renderDecodedLog();
          this._renderBatteryAlerts();
          this._hydrated = this._trackBarrier("both", Promise.all([this._hydrateDecodedLog(), this._hydrateBatteryState({ adopt: true })]));
          return;
        }
      };
    } catch {
      // No BroadcastChannel (very old browser). _postSync falls back to bumping a localStorage
      // nonce, which does emit a storage event peers can act on - the earlier claim that the
      // storage handler already covered this was wrong once the state moved to IndexedDB, since
      // nothing in localStorage changes on a clear any more.
      this._broadcastChannel = null;
    }
  }

  _postSync(message) {
    try {
      if (this._broadcastChannel) {
        this._broadcastChannel.postMessage(message);
        return;
      }
    } catch {
      // Channel closed mid-teardown - fall through to the nonce below.
    }
    try {
      // No channel: bump a nonce so peers get a storage event and re-read from IndexedDB.
      localStorage.setItem(SYNC_NONCE_KEY, `${Date.now()}-${Math.random()}`);
    } catch {
      // Nothing left to notify with; peers reconcile on their next reattach or event.
    }
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
    // Reload the canonical low-battery state on every connectedCallback, not just once in the
    // constructor, and deliberately *outside*/independent of the `!_subscribing` branch below -
    // disconnectedCallback tears down the WS subscription and the storage listener on every
    // detach, including one where _subscribe() had a call still in flight (_subscribing already
    // true), which leaves that branch a no-op on this reattach even though the listeners were
    // still torn down for its whole duration. While detached this instance misses both a live
    // battery_ok:true recovery from the add-on AND another tab's own update to BATTERY_LOW_KEY -
    // reloading picks up whatever the shared canonical state has settled on in the meantime.
    //
    // Merged with what this instance still holds rather than adopting storage outright - same
    // reasoning as the storage handler. A detach/reattach doesn't discard in-memory state, and
    // that state can legitimately be ahead of storage (a peer wrote a staler value, or this
    // tab's own writes were blocked by quota), so replacing would lose it.
    // Both are re-read from IndexedDB, which is authoritative - see the storage-layer comment.
    // adopt:true because a detached element's battery cache is strictly stale (see the method).
    this._hydrated = this._trackBarrier("both", Promise.all([this._hydrateBatteryState({ adopt: true }), this._hydrateDecodedLog()]));
    this._renderBatteryAlerts();
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
      if (this._broadcastChannel) {
        this._broadcastChannel.close();
        this._broadcastChannel = null;
      }
    }
    // Hand the sound role back immediately - _audioCtx was just closed above, so this tab can no
    // longer play anything, and holding the claim until it expires would leave alerts unplayed
    // by any tab for up to LEADER_TTL_MS.
    this._releaseSoundLeadership();
    // _deviceBatteryOk is just a cache of the canonical, cross-tab-shared BATTERY_LOW_KEY - a
    // detach doesn't need to (and shouldn't) wipe it, since connectedCallback reloads it fresh
    // from storage on reattach regardless, picking up whatever the shared source of truth has
    // settled on in the meantime (including recoveries this tab itself missed while detached).
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
    // A different coordinator session means Home Assistant restarted, so the add-on event stream
    // was interrupted for *every* tab - not just this one's socket. The reconnect path otherwise
    // treats the loss as tab-local and adopts the shared battery map from a peer that could not
    // have stayed connected either, so a recovery transmitted during the restart could leave a
    // low-battery banner asserted indefinitely if the device then went quiet. Keyed on the
    // session id so all tabs converge on handling it exactly once, like a stream gap.
    if (state.session_id) {
      if (this._coordinatorSession && this._coordinatorSession !== state.session_id) {
        this._invalidateBatteryState(`session:${state.session_id}`);
      }
      this._coordinatorSession = state.session_id;
    }
    this._state = state;
    this._renderDongles();
    this._renderCoverage();
    this._renderSweeps(forceRebuildSweeps);
    this._renderReceivers();
  }

  async _handleEvent(event) {
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
      // Purely for this tab's own relative-age labels. Ordering and identity come from the
      // add-on's event_id/received_at instead (see compareDecodedEvents) - those are identical
      // in every tab, this is not.
      event._receivedAt = Date.now();
      const decodedDevice = event.device || {};
      // A fresh decode from a pinned device gets a one-shot flash (consumed and cleared by
      // _renderDecodedLog on its next draw) - only for favorites, since flashing every incoming
      // event regardless of relevance would be noise for exactly the users this is meant to help
      // (someone watching one specific sensor among a lot of unrelated traffic).
      const favKey = deviceFavoriteKey(decodedDevice);
      if (this._favoriteDevices.has(favKey)) this._flashDeviceKey = favKey;
      this._persistDecodedEvent(event);
      if (Object.hasOwn(decodedDevice, "battery_ok")) this._updateBatteryState(event);
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
      // way an event may have been lost, and crucially the loss is *upstream of every tab*: both
      // signals originate from the coordinator's single shared connection to the add-on, so no
      // other tab saw the missed recovery either. Re-reading the shared low-battery state would
      // therefore just re-adopt the same stale assertion from a peer. Clear it instead and let
      // the next real report from each device repopulate it - the alternative is a banner that
      // could claim a recovered device is still low indefinitely, if it happens to go quiet.
      await this._invalidateBatteryState(event.gap_id ?? null);
      this._loadState();
    }
  }

  // Fully synchronous, and deliberately unsynchronized: the merge is over server-assigned
  // event_ids into a canonical total order (see mergeDecodedLog/compareDecodedEvents), so every
  // tab that has seen the same events computes the identical array. Concurrent writers therefore
  // store the same value rather than competing ones, which is what makes last-writer-wins safe
  // here without any lock. The generation is re-read from storage at write time (not stamped
  // when the event arrived) so a "Clear log" that lands in between is always observed, never
  // raced past.
  // Merges an authoritative snapshot into the in-memory view rather than replacing it.
  // Transactions overlap, so a snapshot can predate an optimistic entry added after the read
  // began - assigning it directly would make that entry vanish until its own write settled, or
  // permanently if the write failed. A generation change is the exception: that means a clear or
  // invalidation, where discarding entries is the entire point.
  _applySettledDecoded(settled) {
    const sameGen = settled.gen === this._decodedLogGen;
    const convergent = sameGen
      ? mergeDecodedLog(this._decodedLog.filter(isConvergentEvent), settled.log)
      : settled.log;
    // Legacy (pre-upgrade) entries exist only in this tab's memory and carry no generation, so
    // an IndexedDB clear can't remove them - they must be dropped explicitly when the generation
    // advances, or a peer would keep showing history the user explicitly cleared.
    const legacy = sameGen ? this._decodedLog.filter((e) => !isConvergentEvent(e)) : [];
    // Convergent events come first: they are the newly-arrived ones, and legacy entries are by
    // definition older. Putting legacy first meant a full pre-upgrade log pushed every new event
    // past the cap, freezing the visible feed until reload.
    this._decodedLog = [...convergent, ...legacy].slice(0, MAX_DECODED_LOG);
    this._decodedLogGen = settled.gen;
    this._renderDecodedLog();
  }

  // Re-reads the authoritative decoded log from IndexedDB. Used on first load, on reattach, and
  // whenever a peer signals a change - IndexedDB has no cross-document change event of its own,
  // so BroadcastChannel carries the notification while the database remains the source of truth.
  // Registers an operation that will change a generation, so mutations can wait for it rather
  // than racing it. Hydration alone was too narrow a gate: a clear or a gap invalidation opens
  // its transaction first, so a mutation starting afterwards still reads the *pre-bump*
  // generation, no-ops when its own transaction observes the bumped one, and then has its
  // optimistic update erased by the empty settled record. Every generation-changing operation
  // has to be part of the barrier, not just the initial load.
  _trackBarrier(kind, promise) {
    const guarded = Promise.resolve(promise).catch(() => {});
    for (const k of kind === "both" ? ["decoded", "battery"] : [kind]) {
      // Aggregated with whatever is already outstanding, never assigned over it. Overwriting made
      // the displaced operation invisible: a Clear waiting on a prior barrier could be replaced by
      // a peer hydration, after which a decode waited only on the hydration, wrote under the old
      // generation, and was then erased when the orphaned clear finally committed. _awaitBarrier
      // cannot see a promise that was overwritten, so the aggregation has to happen here.
      const existing = this._barriers[k];
      this._barriers[k] = existing ? Promise.all([existing, guarded]).then(() => {}) : guarded;
    }
    return promise;
  }

  // Waits until no generation-changing operation for `kind` is in flight. Loops because awaiting
  // yields, during which another operation can register - re-checking until the barrier is
  // unchanged is what makes the generation read afterwards actually current. Bounded so a
  // pathological stream of clears can't starve a decode forever; the generation guard inside the
  // transaction remains the correctness backstop either way. Never rejects: the tracked
  // operations swallow their own storage failures.
  async _awaitBarrier(kind) {
    for (let i = 0; i < 8; i++) {
      const barrier = this._barriers[kind];
      if (!barrier) return;
      await barrier;
      if (this._barriers[kind] === barrier) return;
    }
  }

  async _hydrateDecodedLog() {
    const epoch = this._clearEpoch;
    try {
      const settled = normalizeDecodedRecord(await idbGet(IDB_KEY_DECODED));
      if (epoch !== this._clearEpoch) return;
      this._applySettledDecoded(settled);
    } catch {
      // No usable store - whatever is in memory stands.
    }
  }

  // `adopt` replaces rather than merges. Used on reattach: while detached this element received
  // no events, so its cache is strictly behind - and worse, a recovery tombstone it never saw can
  // since have been evicted, leaving nothing in the store able to contradict its retained stale
  // low. Merging an unbounded-age cache would then pin a false banner indefinitely. During normal
  // operation merging is right, since a snapshot can predate a transition applied optimistically
  // while the read was in flight.
  async _hydrateBatteryState({ adopt = false } = {}) {
    try {
      const settled = normalizeBatteryRecord(await idbGet(IDB_KEY_BATTERY));
      this._deviceBatteryOk =
        !adopt && settled.gen === this._batteryGen
          ? mergeBatteryLowState(this._deviceBatteryOk, settled.map, mergeEvicted(this._batteryEvicted, settled.evicted))
              .map
          : settled.map;
      this._batteryGen = settled.gen;
      // Unioned, never replaced: a settled snapshot can be older than eviction knowledge this tab
      // has already derived locally, and taking the record's copy outright would roll that back and
      // let a delayed low resurrect the evicted device.
      this._batteryEvicted = mergeEvicted(this._batteryEvicted, settled.evicted);
      this._renderBatteryAlerts();
    } catch {
      // No usable store - whatever is in memory stands.
    }
  }

  // The Clear-log transaction, split out so it can be published as a barrier before its first
  // await (see _trackBarrier). Bumping the generation and emptying the log happen in one
  // transaction, so a decode being persisted concurrently either lands before the bump (and is
  // discarded with the old generation) or after it (and is kept) - never half-applied.
  async _runDecodedClear(previous) {
    // Bumped here rather than only in the click handler, synchronously before any await. Leaving
    // it to the caller meant the epoch signal depended on who initiated the clear, so a clear
    // reached by any other path left in-flight events unable to tell a clear had happened - and
    // with barriers aggregating, their post-wait generation read matches and the boundary check
    // is skipped, writing them back into the log the clear just emptied.
    this._clearEpoch++;
    if (previous) await previous;
    try {
      const record = await idbMutate(IDB_KEY_DECODED, (raw) => {
        const current = normalizeDecodedRecord(raw);
        // The boundary is the highest order this tab has seen, including anything already in the
        // stored log - that is exactly "what the user was looking at when they cleared".
        // Seeded with the *existing* boundary as well as this tab's own high-water mark. A tab
        // clearing an already-empty log can have a lower (or unset) _maxSeenOrd than the boundary
        // a previous clear recorded, and lowering it would re-admit writes from before that
        // earlier clear - they would compare above the reduced boundary and be let back in.
        const clearedOrd = current.log.reduce(
          (m, e) => Math.max(m, Number.isFinite(eventOrder(e)) ? eventOrder(e) : m),
          Math.max(this._maxSeenOrd ?? 0, current.clearedOrd ?? 0),
        );
        return { gen: current.gen + 1, clearedOrd, entries: [] };
      });
      const settled = normalizeDecodedRecord(record);
      this._decodedLogGen = settled.gen;
      this._decodedLog = settled.log;
      this._renderDecodedLog();
      this._postSync({ kind: "decoded_changed" });
    } catch {
      // No usable store - the local clear stands for this session.
    }
  }

  async _persistDecodedEvent(event) {
    const seenOrder = eventOrder(event);
    if (Number.isFinite(seenOrder)) this._maxSeenOrd = Math.max(this._maxSeenOrd ?? 0, seenOrder);
    // Pre-add-on-upgrade events have no shared identity to converge on - show them in this tab
    // (so a newer panel against an older add-on still works) but never persist them, since a
    // fabricated client-side id would duplicate the same decode once per open tab.
    if (!isConvergentEvent(event)) {
      this._decodedLog = [event, ...this._decodedLog].slice(0, MAX_DECODED_LOG);
      this._renderDecodedLog();
      return;
    }
    // Legacy (non-convergent) entries from an older add-on are kept in the local view - they
    // only need excluding from *persistence*, and dropping them here would blank the visible
    // history the moment the add-on is upgraded mid-session.
    const legacy = this._decodedLog.filter((e) => !isConvergentEvent(e));
    this._decodedLog = [...mergeDecodedLog(this._decodedLog.filter(isConvergentEvent), [event]), ...legacy].slice(
      0,
      MAX_DECODED_LOG,
    );
    this._renderDecodedLog();
    // Read *after* hydration settles. The optimistic render above is deliberately kept ahead of
    // it so the card still appears immediately; only the generation the write is stamped with
    // has to wait, since a generation read before hydration is a guess (0) rather than a fact.
    // Captured BEFORE the wait, for the same reason as the battery path: an aggregated barrier
    // now carries a clear registered after this event arrived, so afterwards the generation
    // matches and the boundary check would be skipped - letting an event the clear covered be
    // written back into the just-cleared log.
    const arrivalEpoch = this._clearEpoch;
    await this._awaitBarrier("decoded");
    const expectedGen = this._decodedLogGen;
    try {
      // The whole get-merge-put happens inside one readwrite transaction, so a concurrent tab
      // cannot interleave and clobber this with a shorter prefix of the same log. The generation
      // is read *within* the transaction too, so a clear that lands first is always observed.
      const record = await idbMutate(IDB_KEY_DECODED, (raw) => {
        const current = normalizeDecodedRecord(raw);
        // A generation mismatch means a clear landed between this event arriving and the
        // transaction running. That is NOT automatically a reason to discard: there is an
        // unavoidable interval between a peer committing its clear and its notification reaching
        // this tab, and an event delivered in that interval is a genuinely *post-clear* event that
        // simply had no way to know. Blanket-rejecting them lost such events permanently, since
        // the later hydration cannot recover what was never written.
        //
        // clearedOrd is what separates the two cases: the clear records the highest order its tab
        // had seen, so anything ordered above it post-dates the clear and belongs in the new
        // generation. Anything at or below it is what the user actually asked to remove.
        // Applied whenever a clear happened at all - either observed as a generation change, or
        // as an epoch change while this event was waiting. The latter is invisible to the
        // generation comparison but means the same thing: a clear covered this event.
        if (current.gen !== expectedGen || arrivalEpoch !== this._clearEpoch) {
          const order = eventOrder(event);
          const boundary = current.clearedOrd;
          if (!Number.isFinite(order) || !Number.isFinite(boundary) || order <= boundary) return undefined;
        }
        // _receivedAt is deliberately stripped: it is this tab's arrival time, so persisting it
        // made two tabs' copies of the *same* server event differ. mergeDecodedLog replaces by
        // event_id, so a suspended tab flushing an old queued event could overwrite the canonical
        // copy and make an old decode read as newly received everywhere, including after reload.
        // Display falls back to the server's received_at (see decodedDisplayTime).
        const { _receivedAt, ...convergent } = event;
        const merged = mergeDecodedLog(current.log, [{ ...convergent, _gen: current.gen }]);
        return { gen: current.gen, clearedOrd: current.clearedOrd, entries: merged };
      });
      const settled = normalizeDecodedRecord(record);
      // A clear landed while this was in flight. Applying a pre-clear snapshot would repopulate
      // exactly what the clear removed - unless this event itself survived the boundary check
      // above, in which case the snapshot legitimately contains it and dropping it would discard
      // a post-clear event that was correctly written.
      if (arrivalEpoch !== this._clearEpoch && !settled.log.some((e) => e.event_id === event.event_id)) return;
      this._applySettledDecoded(settled);
      this._postSync({ kind: "decoded_changed" });
    } catch {
      // No usable store - the optimistic in-memory update above stands for this session.
    }
  }

  // Discards all low-battery state and bumps the generation so the clear *dominates* rather
  // than merges. A peer still processing a pre-gap event would otherwise persist its stale low
  // entry afterwards and the union in the storage handler would pull it straight back in,
  // leaving a banner nothing can contradict. Used for both stream_gap/stream_reconnected and an
  // HA-side WebSocket reconnect - in every one of those the loss is upstream of all tabs, so no
  // peer holds a better copy and re-reading shared state would just re-adopt the same staleness.
  // Discards all low-battery state and bumps the generation, atomically. Used for stream_gap /
  // stream_reconnected, where the loss is upstream of every tab so no peer holds a better copy.
  // The bump happens inside the transaction, so a concurrent transition either lands before it
  // (and is discarded by the bump) or after it (and is correctly attributed to the new
  // generation) - there is no interleaving that can resurrect pre-gap state.
  // Deliberately NOT async: the barrier must be published *synchronously*, before this function
  // can yield. An earlier attempt awaited the existing barrier first and published afterwards,
  // which left the very window this is meant to close - a transition starting in the same tick
  // ran its own barrier check before the invalidation had registered, read the pre-bump
  // generation, and was discarded. Chaining is done by handing the previous barrier to the
  // worker instead, which also avoids it awaiting its own promise and deadlocking.
  _invalidateBatteryState(gapId = null) {
    // Bumped before any await so an already-in-flight transition can detect it, mirroring
    // _clearEpoch on the decoded side.
    this._batteryEpoch++;
    this._deviceBatteryOk = new Map();
    this._renderBatteryAlerts();
    const previous = this._barriers.battery;
    // Idempotency is keyed on the gap's own server-assigned id, not on a generation captured
    // here. Both alternatives were wrong: capturing after awaiting `previous` adopted the
    // generation a peer's invalidation had already created and bumped it a second time, erasing
    // that peer's valid post-gap transition; capturing before the await used a generation that
    // may still be the constructor default while hydration is pending, so the transaction
    // mismatched, no-opped, and left the stale map the gap was meant to discard. The id
    // distinguishes "a peer already handled *this* gap" from "my generation is merely stale",
    // which no generation counter can express.
    return this._trackBarrier("battery", this._runBatteryInvalidation(previous, gapId));
  }

  async _runBatteryInvalidation(previous, gapId) {
    if (previous) await previous;
    // Read after the wait: by now hydration has settled, so this is the real stored generation
    // rather than a guess. Only used for the legacy fallback below.
    const expectedGen = this._batteryGen;
    try {
      const record = await idbMutate(IDB_KEY_BATTERY, (raw) => {
        const current = normalizeBatteryRecord(raw);
        // Every tab receives the same gap and every tab used to bump unconditionally, so a slow
        // tab's bump could land after a fast tab had already invalidated and persisted a valid
        // post-gap transition, erasing it. The recorded id makes the first application win and
        // every duplicate a no-op, regardless of what any tab's cached generation says.
        if (gapId) {
          if (current.appliedGaps.includes(gapId)) return undefined;
        } else if (current.gen !== expectedGen) {
          // Legacy add-on with no gap_id - fall back to the generation guard. Weaker (it cannot
          // tell a peer's duplicate from a stale local generation) but better than bumping
          // unconditionally.
          return undefined;
        }
        // Eviction knowledge carries across the bump: it describes writers that may still be in
        // flight, which a generation change does not retract.
        return serializeBatteryRecord(
          current.gen + 1,
          new Map(),
          current.evicted,
          gapId ? [...current.appliedGaps, gapId] : current.appliedGaps,
        );
      });
      const settled = normalizeBatteryRecord(record);
      this._batteryGen = settled.gen;
      this._batteryEvicted = mergeEvicted(this._batteryEvicted, settled.evicted);
      this._deviceBatteryOk = settled.map;
      this._renderBatteryAlerts();
      this._postSync({ kind: "battery_changed" });
    } catch {
      // No usable store - the local clear above stands for this session.
    }
  }

  // Merges this transition into the shared map as an LWW-register keyed on the server's own
  // received_at (see mergeBatteryLowState), so tabs at different positions in the event stream
  // reconcile correctly instead of overwriting each other.
  //
  // The alert decision is deliberately *not* derived from "did this write change the map".
  // Doing that let whichever tab merely wrote first consume the transition - including a muted
  // or audio-locked tab, which would then permanently suppress the alert in every tab that could
  // actually have played it. Instead the transition carries its own timestamp and only the sound
  // leader records `alertedAt`, so a playable tab still sees an un-alerted transition regardless
  // of how many silent tabs processed it first.
  async _updateBatteryState(event) {
    const decodedDevice = event.device || {};
    const key = batteryStateKey(decodedDevice);
    const isLow = !decodedDevice.battery_ok;
    const ord = eventOrder(event);
    // No episode derivation here any more, and deliberately no barrier wait for it. Both are done
    // inside the IndexedDB transaction against its own authoritative map (see withEpisode), which
    // is the only state that cannot be stale relative to the write being committed.
    const base = {
      model: decodedDevice.model,
      id: decodedDevice.id,
      channel: decodedDevice.channel,
      low: isLow,
      ord,
    };
    // Every tab receives this same broadcast and applies it, but each does so inside its own
    // IndexedDB transaction, so the concurrent updates serialize at the database rather than
    // racing. Awaited so the alert decision below reads the settled state, not a guess.
    // Events from an add-on predating seq/received_at carry no server order, so they must stay
    // tab-local - exactly as the decoded log already refuses to persist non-convergent events.
    // Substituting Date.now() looked harmless but fed an unordered value into a shared LWW map:
    // a lagging tab's earlier event could be stamped later than another tab's subsequent
    // recovery and overwrite it, pinning a low-battery warning that nothing would clear.
    if (!isConvergentEvent(event)) {
      // Waited on even though nothing is persisted: an adopting hydration in flight (first load,
      // reattach, HA reconnect) replaces _deviceBatteryOk wholesale with its snapshot, and since
      // this branch deliberately never writes, the report would simply vanish until the device
      // transmitted again.
      await this._awaitBarrier("battery");
      // Forced strictly increasing. Date.now() has millisecond resolution, so two legacy reports
      // in the same millisecond produced equal orders and the LWW merge rejected the second as
      // not-newer - a recovery immediately followed by a low would leave the recovery standing
      // and never alert. Only ever local, so a per-tab counter is sufficient here.
      const localOrd = Math.max(Number.isFinite(ord) ? ord : Date.now(), (this._lastLegacyOrd ?? 0) + 1);
      this._lastLegacyOrd = localOrd;
      const localBase = { ...base, ord: localOrd };
      this._deviceBatteryOk = mergeBatteryLowState(
        this._deviceBatteryOk,
        new Map([[key, withEpisode(localBase, this._deviceBatteryOk.get(key))]]),
        this._batteryEvicted,
      ).map;
      this._renderBatteryAlerts();
      // The same first-low alert decision the convergent path makes below, against this tab's own
      // map. Returning early without it meant an enabled sound preference produced no tone at all
      // for any legacy low-battery transition - the banner updated silently.
      const localWinner = this._deviceBatteryOk.get(key);
      if (localWinner && localWinner.low && localWinner.ord === localOrd && !Number.isFinite(localWinner.alertedAt)) {
        this._maybePlayLeaderAlert(key, localOrd, { local: true });
      }
      return;
    }
    const applied = await this._applyBatteryTransition(key, base);
    // Only a transition that is genuinely newer than whatever has already been alerted for this
    // device is a candidate - covers both a repeat low report and an out-of-order/replayed one.
    // Reads alertedAt off the resulting entry rather than `previous`, since the merge carries it
    // forward across a low->low refresh (see mergeBatteryLowState); using `previous` alone would
    // miss a marker another tab had already written.
    const winner = applied.get(key);
    if (!winner || !winner.low || winner.ord !== ord) return;
    const priorAlert = winner.alertedAt;
    if (Number.isFinite(priorAlert)) return;
    this._maybePlayLeaderAlert(key, ord);
  }

  // Applies one transition to the shared battery state inside a single IndexedDB transaction.
  // No leader election is involved: the transaction *is* the mutual exclusion, so concurrent
  // tabs serialize at the database rather than racing a lease. Returns the map this tab should
  // reason about (used for the alert decision).
  async _applyBatteryTransition(key, base) {
    // Optimistic local update so the banner and alert decision don't lag a round-trip.
    // Both halves of the merge result are kept. Taking only the map left the cached floor stale
    // when a 51st recovery evicted a tombstone, so a delayed low for the evicted device was
    // accepted into memory; the durable transaction still rejected it, but the settled merge
    // never deletes local-only keys, so this tab could show a false low-battery banner until an
    // adopting rehydrate or reattach happened to clear it.
    const optimistic = mergeBatteryLowState(
      this._deviceBatteryOk,
      new Map([[key, withEpisode(base, this._deviceBatteryOk.get(key))]]),
      this._batteryEvicted,
    );
    this._deviceBatteryOk = optimistic.map;
    this._batteryEvicted = optimistic.evicted;
    this._renderBatteryAlerts();
    // Captured BEFORE the wait. Since barriers now aggregate, the wait follows an invalidation
    // registered *after* this transition arrived all the way through, so the generation read
    // afterwards is the post-invalidation one - and a pre-gap transition would sail into the
    // freshly cleared generation, recreating exactly the stale banner the gap existed to remove.
    const arrivalEpoch = this._batteryEpoch;
    await this._awaitBarrier("battery");
    if (arrivalEpoch !== this._batteryEpoch) return this._deviceBatteryOk;
    const expectedGen = this._batteryGen;
    try {
      const record = await idbMutate(IDB_KEY_BATTERY, (raw) => {
        const current = normalizeBatteryRecord(raw);
        // Same reasoning as _persistDecodedEvent: a transition that began before an
        // invalidation must not be merged into the generation that invalidation created, or a
        // delayed transaction in any tab could recreate the banner the bump was meant to discard.
        if (current.gen !== expectedGen) return undefined;
        // The episode is derived HERE, from the transaction's own authoritative map, not from
        // whatever this tab happened to have cached when the event arrived. Deriving it outside
        // meant a repeat low arriving mid-hydration saw an incomplete cache, was stamped as a new
        // episode, and dropped the persisted alertedAt - so the device beeped again. No barrier
        // wait can fix that reliably; reading the same state the write commits against can.
        const merged = mergeBatteryLowState(
          current.map,
          new Map([[key, withEpisode(base, current.map.get(key))]]),
          mergeEvicted(this._batteryEvicted, current.evicted),
        );
        return serializeBatteryRecord(current.gen, merged.map, merged.evicted, current.appliedGaps);
      });
      const settled = normalizeBatteryRecord(record);
      // Same overlapping-transaction reasoning as _persistDecodedEvent - merge unless the
      // generation moved, which means an invalidation that is meant to discard entries.
      this._deviceBatteryOk =
        settled.gen === this._batteryGen
          ? mergeBatteryLowState(this._deviceBatteryOk, settled.map, mergeEvicted(this._batteryEvicted, settled.evicted))
              .map
          : settled.map;
      this._batteryGen = settled.gen;
      // Unioned, never replaced: a settled snapshot can be older than eviction knowledge this tab
      // has already derived locally, and taking the record's copy outright would roll that back and
      // let a delayed low resurrect the evicted device.
      this._batteryEvicted = mergeEvicted(this._batteryEvicted, settled.evicted);
      this._renderBatteryAlerts();
      this._postSync({ kind: "battery_changed" });
      return this._deviceBatteryOk;
    } catch {
      return this._deviceBatteryOk;
    }
  }

  // Plays the alert only in the tab currently holding sound leadership. Only tabs that can
  // *actually* produce sound right now (pref enabled and an already-unlocked AudioContext)
  // contend for it - otherwise a muted or audio-locked tab could win the election and silently
  // swallow the alert for every tab that could have played it.
  //
  // Recording alertedAt is done here, by the winning tab only, rather than in the shared state
  // write - that separation is what keeps a silent tab's state update from marking a transition
  // as already-alerted.
  _maybePlayLeaderAlert(key, ord, { local = false } = {}) {
    if (!this._canPlayAlertSound()) return;
    if (!this._claimSoundLeadership()) return;
    const entry = this._deviceBatteryOk.get(key);
    if (entry && local) {
      // Legacy events carry no server order and are deliberately never persisted, so the marker
      // stays in this tab's map. Writing it through _applyBatteryTransition would push exactly
      // the unordered entry into shared state that the legacy branch exists to keep out. Sound
      // leadership is still honoured, so multiple open tabs don't each beep for the same report.
      this._deviceBatteryOk = new Map(this._deviceBatteryOk).set(key, { ...entry, alertedAt: ord });
      // Announced to peers so followers record it too. Only the leader beeps, so only the leader
      // was marking the episode alerted; if that tab then closed or lost its lease, the next
      // repeat report let a follower claim leadership and beep again with no recovery in between.
      // Carried over BroadcastChannel rather than IndexedDB - the entry is unordered and must
      // stay out of shared state, but the marker still needs to reach every tab.
      this._postSync({ kind: "legacy_alert", key, ord, lowSince: entry.lowSince ?? entry.ord });
    } else if (entry) {
      // Routed through the state leader like any other mutation rather than written directly.
      // The sound leader and the state leader are different roles and can be different tabs, so
      // writing this tab's whole (possibly lagging) map here would bypass the single-writer
      // guarantee entirely - e.g. overwriting a recovery the state leader had already persisted
      // with the stale low entry this tab is still holding.
      this._applyBatteryTransition(key, { ...entry, alertedAt: ord });
    }
    this._playBatteryAlertSound();
  }

  _canPlayAlertSound() {
    return !!this._batterySoundEnabled && !!this._audioCtx && this._audioCtx.state === "running";
  }

  // Best-effort mutual exclusion for the alert *sound* only - never for state. A claim is taken
  // when the stored one is absent, expired (its owner closed/crashed/was suspended past
  // LEADER_TTL_MS), or already ours. Two tabs claiming in the same instant is possible and its
  // worst case is one duplicated beep - acceptable for a notification, and categorically
  // different from the data-integrity guarantees the (convergent) log and battery state get.
  _claimSoundLeadership() {
    // Delegates to the shared helper rather than repeating the lease logic - the duplicate copy
    // that used to live here silently missed the backward-clock fix applied to claimLeadership.
    if (!claimLeadership(SOUND_LEADER_KEY, this._tabId)) return false;
    this._startSoundLeaderHeartbeat();
    return true;
  }

  // Keeps this tab's claim fresh while it remains able to play sound, so other tabs don't treat
  // it as abandoned and take over. Stops (letting the claim expire naturally) as soon as this
  // tab can no longer actually play - e.g. the user unticked the sound preference.
  _startSoundLeaderHeartbeat() {
    if (this._soundLeaderTimer) return;
    this._soundLeaderTimer = setInterval(() => {
      if (!this._canPlayAlertSound()) {
        // Release rather than just stopping the timer. Leaving the lease to age out means every
        // other playable tab rejects it as fresh for up to the TTL, so a device that sends a
        // single low report in that window is never heard at all - the same missed-alert gap the
        // toggle and detach paths already avoid by releasing immediately.
        this._releaseSoundLeadership();
        return;
      }
      // Only renew a claim that's still ours - another tab may have legitimately taken over
      // while this one was suspended, and stomping that would recreate the split we're avoiding.
      if (!holdsLeadership(SOUND_LEADER_KEY, this._tabId)) {
        this._stopSoundLeaderHeartbeat();
        return;
      }
      claimLeadership(SOUND_LEADER_KEY, this._tabId);
    }, LEADER_HEARTBEAT_MS);
  }

  _stopSoundLeaderHeartbeat() {
    if (!this._soundLeaderTimer) return;
    clearInterval(this._soundLeaderTimer);
    this._soundLeaderTimer = null;
  }

  // Releases leadership outright rather than waiting out LEADER_TTL_MS - on an ordinary detach
  // another tab should be able to take over immediately, not after a multi-second gap during
  // which a low-battery alert would go unplayed by anyone.
  _releaseSoundLeadership() {
    this._stopSoundLeaderHeartbeat();
    releaseLeadership(SOUND_LEADER_KEY, this._tabId);
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
    this.querySelector("#sdr-hub-clear-decoded").addEventListener("click", async () => {
      // Only clears the *displayed* log, not the low-battery state - a device that's genuinely
      // still reporting low battery should keep showing in the alert banner even after the user
      // clears this view, since that's a real hardware condition independent of what's on screen.
      // Bumping the generation counter (rather than just writing an empty array) is what lets
      // every tab distinguish "cleared" from "hasn't seen these events yet": a decode persisted
      // afterwards reads the new generation at write time and is tagged with it, while anything
      // still carrying the old one is filtered out on load. Unlike the array itself, this is a
      // genuine user action rather than convergent derived state, so it's also announced over
      // BroadcastChannel for tabs to pick up immediately. See DECODED_LOG_GEN_KEY.
      this._decodedLog = [];
      this._renderDecodedLog();
      // Published as a barrier so a decode arriving after the click waits for the bump. Without
      // it that decode read the pre-clear generation, its transaction (opened second) saw the
      // bumped one and no-opped, and the settled empty record then removed its optimistic card -
      // losing an event the surrounding comment promises is retained.
      const previousClear = this._barriers.decoded;
      await this._trackBarrier("decoded", this._runDecodedClear(previousClear));
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
      if (this._batterySoundEnabled) {
        this._ensureAudioContextRunning();
      } else {
        // Hand the claim back immediately. A "storage" event never fires in the tab that made
        // the change, so nothing else here would notice, and the heartbeat merely stops without
        // removing the claim - leaving other playable tabs refusing alerts for up to
        // LEADER_TTL_MS while this now-muted tab still nominally owns the role. A sensor that
        // sends no repeat low report in that window would produce no sound at all.
        this._releaseSoundLeadership();
      }
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
  async _onResetPreferences() {
    this._clearEpoch++;
    // The IndexedDB writes come first, before any localStorage removal. removeItem emits a
    // storage event, and _onStorageEvent reloads peers on any ALL_PREF_KEYS removal - so doing
    // it first made peers reload *while these transactions were still uncommitted*, hydrate the
    // pre-reset records, and then miss the one-shot state_reset message because the listener
    // they would have received it on was torn down by their own reload.
    //
    // Awaited, not fired-and-forgotten, for the same class of reason: the reload below can tear
    // the page down before the transaction commits - it first yields at `await openIdb()` -
    // which would leave the log and battery map that Reset was supposed to clear intact.
    try {
      // Deliberately *not* a delete. Deleting returns both records to an absent state that
      // normalizes to generation 0 - indistinguishable from a fresh install - so a mutation
      // already awaiting IndexedDB in another tab would commit afterwards, read generation 0,
      // and recreate exactly the state the reset removed. Writing an empty record at an advanced
      // generation is durable and observable: a pending mutation sees the higher generation and
      // its result is discarded, and peers hydrate into a replace rather than a merge.
      await idbMutate(IDB_KEY_DECODED, (raw) => {
        const cur = normalizeDecodedRecord(raw);
        // Same monotonic-boundary reasoning as the Clear-log transaction above.
        const clearedOrd = cur.log.reduce(
          (m, e) => Math.max(m, Number.isFinite(eventOrder(e)) ? eventOrder(e) : m),
          Math.max(this._maxSeenOrd ?? 0, cur.clearedOrd ?? 0),
        );
        return { gen: cur.gen + 1, clearedOrd, entries: [] };
      });
      await idbMutate(IDB_KEY_BATTERY, (raw) => {
        const cur = normalizeBatteryRecord(raw);
        return serializeBatteryRecord(cur.gen + 1, new Map(), cur.evicted, cur.appliedGaps);
      });
    } catch {
      // No usable store - nothing persisted to clear.
    }
    // SOUND_LEADER_KEY is cleared here but deliberately kept *out* of ALL_PREF_KEYS - see that
    // list's own comment. Releasing leadership removes it on every ordinary detach, and
    // _onStorageEvent reloads the page whenever an ALL_PREF_KEYS entry is removed elsewhere, so
    // listing it there would make every open tab reload each time any one tab navigated away.
    for (const key of [...ALL_PREF_KEYS, SOUND_LEADER_KEY]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Unavailable storage - nothing to clear.
      }
    }
    // Peers get no signal otherwise: IndexedDB has no cross-document change event, and if every
    // localStorage preference was already at its default then removeItem is a no-op that emits
    // no storage event either, so other panels would keep rendering the reset-away state.
    this._postSync({ kind: "state_reset" });
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
    // of which device most recently reported - merge/eviction reorder the map's own iteration
    // order, and rendering that directly would flip "A, B" to "B, A" on a no-op refresh,
    // defeating the _lastBatteryAlertMessage dedup below and re-triggering the live-region
    // announcement. Recovered devices are retained as low:false tombstones (see
    // mergeBatteryLowState) purely so the merge can order them - filter them out for display.
    const low = [...this._deviceBatteryOk.entries()]
      .filter(([, entry]) => entry.low)
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
        const shownAt = decodedDisplayTime(event);
        const age = shownAt
          ? this._decodedTimeMode === "absolute"
            ? fmtAbsoluteTime(shownAt)
            : `-${fmtElapsed(now - shownAt)}`
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
