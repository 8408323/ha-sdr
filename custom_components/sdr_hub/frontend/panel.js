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

const WATERFALL_MIN_DB = -20;
const WATERFALL_MAX_DB = 60;
const WATERFALL_HEIGHT = 200;
const MAX_DECODED_LOG = 50;

class SdrHubPanel extends HTMLElement {
  constructor() {
    super();
    this._state = { devices: [], receivers: [], sweeps: [] };
    this._sweepRowHistory = {}; // sweep_id -> [SweepRow, ...] newest-first, capped at WATERFALL_HEIGHT (index = canvas row = hover Y), for hover lookups
    this._decodedLog = []; // most-recent-first
    this._unsub = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._renderShell();
      this._loadState();
      this._subscribe();
    }
  }

  set panel(panel) {
    this._panel = panel;
  }

  connectedCallback() {
    if (!this._hass) return;
    if (!this.querySelector("#sdr-hub-root")) this._renderShell();
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  }

  async _callWS(message) {
    return this._hass.callWS(message);
  }

  async _subscribe() {
    try {
      this._unsub = await this._hass.connection.subscribeMessage(
        (event) => this._handleEvent(event),
        { type: "sdr_hub/subscribe" },
      );
    } catch (err) {
      this._showError(`Could not subscribe to live updates: ${err.message || err}`);
    }
  }

  async _loadState() {
    try {
      this._state = await this._callWS({ type: "sdr_hub/get_state" });
    } catch (err) {
      this._showError(`Could not load SDR Hub state: ${err.message || err}`);
      return;
    }
    this._renderDongles();
    this._renderSweeps();
    this._renderReceivers();
  }

  _handleEvent(event) {
    if (event.type === "sweep_row") {
      const rows = (this._sweepRowHistory[event.sweep_id] ??= []);
      rows.unshift(event);
      if (rows.length > WATERFALL_HEIGHT) rows.length = WATERFALL_HEIGHT;
      this._drawWaterfallRow(event);
    } else if (event.type === "decoded_device") {
      this._decodedLog.unshift(event);
      if (this._decodedLog.length > MAX_DECODED_LOG) this._decodedLog.length = MAX_DECODED_LOG;
      this._renderDecodedLog();
    } else if (event.type === "status") {
      // A receiver/sweep died (or similar) — the add-on already released the dongle;
      // reload the authoritative snapshot rather than hand-patch local state.
      this._loadState();
    }
  }

  _showError(message) {
    const el = this.querySelector("#sdr-hub-error");
    if (!el) return;
    el.textContent = message;
    el.style.display = message ? "block" : "none";
  }

  // ── shell ────────────────────────────────────────────────────────────────

  _renderShell() {
    this.innerHTML = `
      <div id="sdr-hub-root" style="padding:16px;max-width:960px;margin:0 auto;font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif);">
        <h1 style="font-size:1.4rem;margin:0 0 16px;color:var(--primary-text-color,#212121);">SDR Hub</h1>
        <div id="sdr-hub-error" style="display:none;color:var(--error-color,#db4437);margin-bottom:12px;"></div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Dongles</h2>
          <div id="sdr-hub-dongles"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Wideband sweeps</h2>
          <form id="sdr-hub-add-sweep" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
            <label style="${LABEL}">Dongle<select name="dongle_serial" style="${INPUT}"></select></label>
            <label style="${LABEL}">Start MHz<input name="start_mhz" type="number" step="0.001" value="88" style="${INPUT};width:100px"></label>
            <label style="${LABEL}">Stop MHz<input name="stop_mhz" type="number" step="0.001" value="108" style="${INPUT};width:100px"></label>
            <label style="${LABEL}">Gain dB<input name="gain" type="number" step="0.1" value="30" style="${INPUT};width:80px"></label>
            <button type="submit" style="${BTN}">Start sweep</button>
          </form>
          <div id="sdr-hub-sweeps"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Receivers (rtl_433)</h2>
          <form id="sdr-hub-add-receiver" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:12px;">
            <label style="${LABEL}">Dongle<select name="dongle_serial" style="${INPUT}"></select></label>
            <label style="${LABEL}">Frequencies MHz (comma-separated)<input name="frequencies_mhz" value="433.92" style="${INPUT};width:180px"></label>
            <label style="${LABEL}">Hop interval s<input name="hop_interval_s" type="number" value="10" style="${INPUT};width:90px"></label>
            <button type="submit" style="${BTN}">Start receiver</button>
          </form>
          <div id="sdr-hub-receivers"></div>
        </div>

        <div style="${CARD}">
          <h2 style="margin:0 0 8px;font-size:1.1rem;">Decoded devices</h2>
          <div id="sdr-hub-decoded" style="font-family:monospace;font-size:.85rem;max-height:240px;overflow-y:auto;"></div>
        </div>
      </div>
    `;

    this.querySelector("#sdr-hub-add-sweep").addEventListener("submit", (ev) => this._onAddSweep(ev));
    this.querySelector("#sdr-hub-add-receiver").addEventListener("submit", (ev) => this._onAddReceiver(ev));
  }

  _renderDongleOptions(select) {
    const current = select.value;
    select.innerHTML = this._state.devices
      .map((d) => `<option value="${esc(d.serial)}">${esc(d.label || d.serial)}</option>`)
      .join("");
    if (current) select.value = current;
  }

  _renderDongles() {
    const el = this.querySelector("#sdr-hub-dongles");
    if (!el) return;
    if (this._state.devices.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No dongles detected.</p>`;
    } else {
      el.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">
          <tr style="text-align:left;color:var(--secondary-text-color,#727272);font-size:.85rem;">
            <th>Serial</th><th>Label</th><th>In use by</th>
          </tr>
          ${this._state.devices
            .map(
              (d) => `
            <tr>
              <td>${esc(d.serial)}</td>
              <td>${esc(d.label || "")}</td>
              <td>${d.in_use_by ? esc(d.in_use_by) : "<em>free</em>"}</td>
            </tr>`,
            )
            .join("")}
        </table>`;
    }
    for (const form of ["sdr-hub-add-sweep", "sdr-hub-add-receiver"]) {
      const select = this.querySelector(`#${form} select[name="dongle_serial"]`);
      if (select) this._renderDongleOptions(select);
    }
  }

  _renderSweeps() {
    const el = this.querySelector("#sdr-hub-sweeps");
    if (!el) return;
    const activeIds = new Set(this._state.sweeps.map((s) => s.id));
    for (const id of Object.keys(this._sweepRowHistory)) {
      if (!activeIds.has(id)) delete this._sweepRowHistory[id];
    }
    if (this._state.sweeps.length === 0) {
      el.innerHTML = `<p style="color:var(--secondary-text-color,#727272);">No active sweeps.</p>`;
      return;
    }
    el.innerHTML = this._state.sweeps
      .map(
        (s) => `
      <div style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>${fmtMHz(s.start_hz)}–${fmtMHz(s.stop_hz)} MHz on ${esc(s.dongle_serial)}
            ${s.status === "error" ? `<span style="color:var(--error-color,#db4437);"> (error)</span>` : ""}</span>
          <button data-remove-sweep="${esc(s.id)}" style="${BTN_DANGER}">Stop</button>
        </div>
        <canvas data-sweep-canvas="${esc(s.id)}" height="${WATERFALL_HEIGHT}"
          style="width:100%;height:${WATERFALL_HEIGHT}px;image-rendering:pixelated;display:block;border-radius:8px;"></canvas>
        <div data-sweep-hover="${esc(s.id)}" style="font-size:.8rem;color:var(--secondary-text-color,#727272);height:1.2em;"></div>
      </div>`,
      )
      .join("");
    for (const s of this._state.sweeps) {
      el.querySelector(`[data-remove-sweep="${CSS.escape(s.id)}"]`).addEventListener("click", () =>
        this._onRemoveSweep(s.id),
      );
      this._wireCanvasHover(s.id);
      const rows = this._sweepRowHistory[s.id];
      if (rows && rows.length > 0) this._drawWaterfallRow(rows[0]);
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
      <table style="width:100%;border-collapse:collapse;">
        <tr style="text-align:left;color:var(--secondary-text-color,#727272);font-size:.85rem;">
          <th>Frequencies</th><th>Dongle</th><th>Status</th><th></th>
        </tr>
        ${this._state.receivers
          .map(
            (r) => `
          <tr>
            <td>${r.frequencies_hz.map(fmtMHz).join(", ")} MHz</td>
            <td>${esc(r.dongle_serial)}</td>
            <td>${r.status === "error" ? `<span style="color:var(--error-color,#db4437);">error</span>` : "running"}</td>
            <td><button data-remove-receiver="${esc(r.id)}" style="${BTN_DANGER}">Stop</button></td>
          </tr>`,
          )
          .join("")}
      </table>`;
    for (const r of this._state.receivers) {
      el.querySelector(`[data-remove-receiver="${CSS.escape(r.id)}"]`).addEventListener("click", () =>
        this._onRemoveReceiver(r.id),
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
    el.innerHTML = this._decodedLog
      .map((event) => `<div>${esc(JSON.stringify(event.device))}</div>`)
      .join("");
  }

  // ── waterfall canvas ─────────────────────────────────────────────────────

  _wireCanvasHover(sweepId) {
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(sweepId)}"]`);
    const readout = this.querySelector(`[data-sweep-hover="${CSS.escape(sweepId)}"]`);
    if (!canvas || !readout) return;
    canvas.addEventListener("mousemove", (ev) => {
      const rows = this._sweepRowHistory[sweepId];
      if (!rows || rows.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      // Row 0 is newest and drawn at canvas y=0; each older row is one pixel further down
      // (the scroll-down in _drawWaterfallRow) — map the cursor's Y back to that same index
      // so hovering an older band of the waterfall reads that row's data, not the newest.
      const rowIndex = Math.max(0, Math.floor(((ev.clientY - rect.top) / rect.height) * canvas.height));
      const row = rows[rowIndex];
      const frac = (ev.clientX - rect.left) / rect.width;
      if (!row) {
        readout.textContent = "";
        return;
      }
      const bin = Math.max(0, Math.min(row.power_db.length - 1, Math.round(frac * row.power_db.length)));
      const freqHz = row.start_hz + bin * row.bin_hz;
      const db = row.power_db[bin];
      readout.textContent =
        Number.isFinite(db) ? `${fmtMHz(freqHz)} MHz — ${db.toFixed(1)} dB` : `${fmtMHz(freqHz)} MHz`;
    });
    canvas.addEventListener("mouseleave", () => {
      readout.textContent = "";
    });
  }

  _drawWaterfallRow(row) {
    const canvas = this.querySelector(`[data-sweep-canvas="${CSS.escape(row.sweep_id)}"]`);
    if (!canvas) return;
    const width = row.power_db.length;
    if (canvas.width !== width) canvas.width = width; // resets the bitmap; only on first row/range change
    const ctx = canvas.getContext("2d");
    const height = canvas.height;

    if (height > 1) {
      const existing = ctx.getImageData(0, 0, width, height - 1);
      ctx.putImageData(existing, 0, 1);
    }
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
    ctx.putImageData(rowImage, 0, 0);
  }

  // ── forms ────────────────────────────────────────────────────────────────

  async _onAddSweep(ev) {
    ev.preventDefault();
    const form = new FormData(ev.target);
    try {
      await this._callWS({
        type: "sdr_hub/add_sweep",
        dongle_serial: form.get("dongle_serial"),
        start_hz: Number(form.get("start_mhz")) * 1e6,
        stop_hz: Number(form.get("stop_mhz")) * 1e6,
        gain: Number(form.get("gain")),
      });
      this._showError("");
    } catch (err) {
      this._showError(`Could not start sweep: ${err.message || err}`);
    }
    await this._loadState();
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
        frequencies_hz: frequenciesHz,
        hop_interval_s: Number(form.get("hop_interval_s")) || 10,
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
