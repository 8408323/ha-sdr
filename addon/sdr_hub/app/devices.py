from __future__ import annotations

from dataclasses import dataclass

import SoapySDR


@dataclass
class Dongle:
    """A single attached SDR device, as reported by SoapySDR's device enumerator.

    Not RTL-SDR-specific despite the name (kept for compatibility with existing callers/UI
    labels) - `driver` is whichever SoapySDR driver module actually owns this device (e.g.
    "rtlsdr", "hackrf", "airspy"), needed to reopen the same device later since SoapySDR
    can't disambiguate by serial alone across driver modules.
    """

    serial: str
    label: str
    driver: str


def discover_dongles() -> list[Dongle]:
    """Enumerates every attached SDR device across all installed SoapySDR driver modules.

    Wideband sweeps (scanner.py) work with any SoapySDR-supported device this returns.
    rtl_433 receivers (decode.py) only work with actual RTL-SDR hardware regardless of what's
    discovered here - device_manager.py's add_receiver() checks `driver == "rtlsdr"` before
    claiming a device for that purpose, since rtl_433 talks to librtlsdr directly and has no
    way to use a HackRF/Airspy/etc. even if SoapySDR can see one.
    """
    results = SoapySDR.Device.enumerate()
    return [
        Dongle(
            serial=dict(r).get("serial", ""),
            label=dict(r).get("label", ""),
            driver=dict(r).get("driver", ""),
        )
        for r in results
    ]
