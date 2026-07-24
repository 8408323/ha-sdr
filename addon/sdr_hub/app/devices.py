from __future__ import annotations

from dataclasses import dataclass

import SoapySDR


@dataclass
class Dongle:
    serial: str
    label: str


def discover_dongles() -> list[Dongle]:
    """Enumerates attached RTL-SDR dongles via SoapySDR."""
    results = SoapySDR.Device.enumerate({"driver": "rtlsdr"})
    return [Dongle(serial=dict(r).get("serial", ""), label=dict(r).get("label", "")) for r in results]
