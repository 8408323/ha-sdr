from __future__ import annotations

from dataclasses import dataclass, field

import SoapySDR


@dataclass
class Dongle:
    """A single attached SDR device, as reported by SoapySDR's device enumerator.

    Not RTL-SDR-specific despite the name (kept for compatibility with existing callers/UI
    labels) - `driver` is whichever SoapySDR driver module actually owns this device (e.g.
    "rtlsdr", "hackrf", "airspy").

    `args` holds the *complete* raw enumerate() kwargs for this device, not just
    driver+serial - some SoapySDR drivers need more than that to reopen the exact same
    device (e.g. a `device_id` alongside serial, or `remote` for network-attached devices),
    and constructing `SoapySDR.Device({"driver": ..., "serial": ...})` from scratch would
    silently drop those, either failing to open the device or opening the wrong one.
    """

    serial: str
    label: str
    driver: str
    args: dict[str, str] = field(default_factory=dict)


def discover_dongles() -> list[Dongle]:
    """Enumerates every attached SDR device across all installed SoapySDR driver modules.

    Wideband sweeps (scanner.py) work with any SoapySDR-supported device this returns.
    rtl_433 receivers (decode.py) only work with actual RTL-SDR hardware regardless of what's
    discovered here - device_manager.py's add_receiver() checks `driver == "rtlsdr"` before
    claiming a device for that purpose, since rtl_433 talks to librtlsdr directly and has no
    way to use a HackRF/Airspy/etc. even if SoapySDR can see one.
    """
    results = SoapySDR.Device.enumerate()
    dongles = []
    for r in results:
        args = dict(r)
        dongles.append(
            Dongle(serial=args.get("serial", ""), label=args.get("label", ""), driver=args.get("driver", ""), args=args)
        )
    return dongles
