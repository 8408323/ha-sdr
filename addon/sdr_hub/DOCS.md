# SDR Hub add-on

Owns the RTL-SDR hardware: SoapySDR-driven wideband spectrum sweeps and
configurable fixed-frequency receivers (backed by `rtl_433` for known
ISM-band protocols). Exposes an HTTP + WebSocket API on port `8765` — REST
for managing receivers/devices (with interactive docs at `/docs`), WebSocket
for the continuous data stream (spectrum rows, decoded-device events).

Built for the `sdr_hub` HACS integration, but the API is meant to be usable
directly by other HACS integrations/add-ons too.

## Requirements

- One or more supported RTL2832U-based SDR dongles (developed against a
  Nooelec NESDR SMArt v5) passed through to the host running HAOS.
- The `sdr_hub` HACS custom integration installed and configured with this
  add-on's host/port and API token (or any other client speaking the API).

## Configuration

- `log_level`: `debug` | `info` | `warning` | `error`.
- `api_token`: shared secret required as `Authorization: Bearer <token>` on
  every request. Leave empty to auto-generate one on first start — check the
  add-on log for it.

## Hardware model

Each attached dongle can service one "capture window" (a center frequency +
bandwidth) for one receiver or sweep at a time. v1 enforces this strictly:
claiming a dongle that's already in use by another receiver/sweep returns a
409 conflict rather than sharing or time-multiplexing the window. With
multiple dongles attached, each can service a different receiver/sweep
concurrently. Window-sharing and time-multiplexing across a single dongle
are on the roadmap, not yet implemented.
