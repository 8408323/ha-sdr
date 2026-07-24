# ha-sdr-scanner

Unofficial Home Assistant project for RTL-SDR dongles (developed against a
[Nooelec NESDR SMArt v5](https://www.nooelec.com/store/sdr/sdr-receivers/smart.html),
RTL2832U-based). Two things, in one repo:

- **Wideband spectrum scanner** — sweeps a frequency range, computes a live
  power spectrum, and renders it as a real-time waterfall.
- **Known-device decoding** — decodes common ISM-band devices (weather
  stations, TPMS, etc.) into Home Assistant entities.

The waterfall is a genuine HTML/JS frontend on the HA navbar (a registered
custom panel), not a Lovelace card — a canvas-based live waterfall doesn't fit
the card model.

## Why two components, not one HACS integration

Home Assistant Core's own Python environment (what HACS integrations run in)
doesn't reliably have `librtlsdr`/`SoapySDR` available, and can't hold a USB
device open the way a long-running scan needs. So the SDR I/O lives in a
**Home Assistant Add-on** (its own Docker container, direct USB passthrough),
and a thin **HACS custom integration** talks to it over a local WebSocket API,
creates entities, and registers the navbar panel. This mirrors the pattern
used by [rtl_433-for-hass](https://rtl-433-hass.github.io/).

```
Nooelec dongle (USB)
      │
      ▼
 Add-on container  ──SoapySDR/rtl_433──  sweep + decode engine
      │  (WebSocket API, localhost)
      ▼
 HACS integration  ──  entities + navbar panel (custom_components/sdr_scanner)
      │
      ▼
 Browser: live waterfall + decoded-device list (frontend/panel.js)
```

Only one process can hold the dongle at a time, so the add-on arbitrates
between "decode mode" (continuous, default) and "sweep mode" (on-demand,
exclusive, used while the waterfall panel is open).

## Repository layout

```
addon/sdr_scanner/          # HA Add-on: config.yaml, Dockerfile, WebSocket API
  app/
    main.py                 # WebSocket/HTTP server
    scanner.py               # SoapySDR FFT sweep engine
    decode.py                 # rtl_433 wrapper for known-device decoding
custom_components/sdr_scanner/  # HACS integration
  frontend/panel.js          # the navbar panel (waterfall + device list)
  panel.py                   # registers the panel with HA's frontend
  coordinator.py              # WebSocket client to the add-on
```

## Status

Early scaffolding — see open issues for what's next. Development hardware is
temporarily attached to a Windows machine and forwarded into WSL2 via
`usbipd-win` (`usbipd bind`/`attach --wsl`); target deployment is a Raspberry
Pi 5 running Proxmox + HAOS, with the dongle passed through to the HAOS VM.

## Development

Secrets (a local `HA_TOKEN` for test scripts, the add-on's API token) go in a
gitignored `.env` — see `.env.example`. Never commit real tokens, captured IQ
samples, or `secrets.yaml`.
