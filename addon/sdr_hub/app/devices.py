from __future__ import annotations

from dataclasses import dataclass

import SoapySDR


@dataclass
class Dongle:
    """A single attached RTL-SDR dongle, as reported by SoapySDR's device enumerator."""

    serial: str
    label: str


def discover_dongles() -> list[Dongle]:
    """Enumerates attached RTL-SDR dongles via SoapySDR."""
    results = SoapySDR.Device.enumerate({"driver": "rtlsdr"})
    return [Dongle(serial=dict(r).get("serial", ""), label=dict(r).get("label", "")) for r in results]
