# ha-sdr

Unofficial Home Assistant platform for RTL-SDR dongles (developed against a
[Nooelec NESDR SMArt v5](https://www.nooelec.com/store/sdr/sdr-receivers/smart.html),
RTL2832U-based). Not just a scanner — a general SDR hub for HA/HAOS:

- **Wideband spectrum sweep** — sweeps a frequency range, computes a live
  power spectrum, and renders it as a real-time waterfall.
- **Configurable receivers** — add fixed-frequency receivers from the
  frontend (known ISM-band devices via `rtl_433` today; other demod types
  later), each becoming its own Home Assistant entities.
- **API for other HACS integrations/add-ons** — the hub is meant to be a
  shared resource other custom components can depend on and drive, the same
  way integrations like `mqtt` or `usb` are, not a closed single-purpose tool.

The frontend is a genuine HTML/JS app on the HA navbar (a registered custom
panel), not a Lovelace card — a canvas-based live waterfall and receiver
editor don't fit the card model.

## Why two components, not one HACS integration

Home Assistant Core's own Python environment (what HACS integrations run in)
doesn't reliably have `librtlsdr`/`SoapySDR` available, and can't hold a USB
device open the way a long-running scan needs. So the SDR I/O lives in the
**SDR Hub add-on** (its own Docker container, direct USB passthrough), and a
thin **HACS custom integration** talks to it over a local API, creates
entities, and registers the navbar panel. This mirrors the pattern used by
[rtl_433-for-hass](https://rtl-433-hass.github.io/).

```
Nooelec dongle(s) (USB)
      │
      ▼
 sdr_hub add-on  ── SoapySDR/rtl_433 ──  receiver pool over N dongles
      │  (HTTP + WebSocket API, /docs for the REST surface)
      ▼
 sdr_hub HACS integration  ──  entities + navbar panel
      │
      ▼
 Browser: waterfall + receiver editor + decoded-device list (frontend/panel.js)

 Other HACS integrations ──────────────────────────────┘
   (call the add-on's API directly, or depend on sdr_hub's hass.data API)
```

### Hardware model: multiple dongles, capture windows, receivers

A single RTL2832U dongle has one tuner: it captures one contiguous
~2.4–3.2 MHz-wide window centered on one frequency at a time. Within that
window, multiple signals can be decoded simultaneously from the one IQ
stream (that's how `rtl_433` decodes many devices from one dongle already).
Two frequencies far apart cannot be received at the same instant on one
dongle — only time-sliced, or with a second dongle.

The add-on models this as a pool of dongles, each servicing one capture
window at a time. **Receivers** (user-configured: frequency + decode type)
that fall inside the same window are serviced together; receivers that
don't fit any single window are time-multiplexed across it if only one
dongle covers them. The wideband spectrum sweep is just another receiver
type — a window that wanders across the full tunable range.

## Repository layout

```
addon/sdr_hub/                  # HA Add-on: config.yaml, Dockerfile, API server
  app/
    main.py                     # FastAPI app: REST (receivers/devices, /docs) + WebSocket stream
    scanner.py                  # SoapySDR FFT sweep engine
    decode.py                   # rtl_433 wrapper for known-device decoding
    device_manager.py           # receiver/capture-window pool over N dongles
custom_components/sdr_hub/      # HACS integration
  frontend/panel.js             # the navbar panel (waterfall + receiver editor)
  panel.py                      # registers the panel with HA's frontend
  coordinator.py                # API client to the add-on
```

## Status

Early scaffolding — see open issues for what's next. Works against a real
dongle passed through into a Linux dev environment via `usbipd-win`
(`usbipd bind`/`attach --wsl`) for anyone developing from Windows/WSL2.

## Development

Secrets (a local `HA_TOKEN` for test scripts, the add-on's API token) go in a
gitignored `.env` — see `.env.example`. Never commit real tokens, captured IQ
samples, or `secrets.yaml`.
