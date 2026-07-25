# Changelog

## 0.2.0

**Update required for the SDR Hub panel.** Decoded events now carry a server-assigned
`event_id`, `seq` and `received_at`. The panel uses these to converge the decoded log and
low-battery state across multiple open browser tabs, and ignores events without them —
so an older add-on paired with this integration shows an "add-on is out of date" notice
and no decoded log or battery alerts until it is updated.

- Decoded events are stamped with `event_id`, `seq` and `received_at` at the source.
- The event sequence is durably reserved before any value is broadcast, so it stays
  monotonic across restarts even if the system clock moves backwards.
- Stream gaps and reconnects carry a `gap_id` so every panel tab handles the same gap
  exactly once.

## 0.1.0

Initial release: SoapySDR wideband spectrum sweeps and `rtl_433` receivers over a local
HTTP + WebSocket API.
