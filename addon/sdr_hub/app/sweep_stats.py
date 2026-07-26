"""Per-sweep session statistics: an estimated noise floor, peak hold, and band occupancy.

Computed here rather than in each panel tab, which is where it started. A per-tab statistic is
neither shared nor durable: two open panels disagree about the same hardware, a reload resets the
peak hold to whatever arrives next, and Home Assistant itself - the thing an automation reacts to -
has no access to it at all. One accumulator per sweep, on the side that owns the data, gives every
consumer the same answer.
"""

from __future__ import annotations

import math

from constants import OCCUPANCY_MIN_DELTA_DB


class SweepStats:
    """Accumulates one sweep's session statistics across the rows it emits."""

    def __init__(self) -> None:
        self._bins = 0
        self._peak: list[float | None] = []
        # Linear power, not dB. Summing decibels computes a geometric mean, which understates an
        # intermittent signal badly: a bin at -100 dB except when a sensor transmits at -40 dB
        # averages to -70 dB that way, against a true mean power near -43 dB. Only the mean needs
        # the linear domain - a peak comparison in dB is exact, since dB is monotonic in power.
        self._sum_linear: list[float] = []
        self._counts: list[int] = []

    def reset(self) -> None:
        self._bins = 0
        self._peak = []
        self._sum_linear = []
        self._counts = []

    def update(self, power_db: list[float | None]) -> None:
        # A changed bin count means the sweep was reconfigured, so bin i is no longer the frequency
        # it was. Carrying the arrays over would place historic peaks at wrong frequencies, which is
        # worse than losing them.
        if len(power_db) != self._bins:
            self._bins = len(power_db)
            self._peak = [None] * self._bins
            self._sum_linear = [0.0] * self._bins
            self._counts = [0] * self._bins
        for i, value in enumerate(power_db):
            # None marks a bin nothing was measured in - a blanked DC spike or a dropped hop. Folding
            # it in as a number would drag the mean toward whatever that number happened to be.
            if value is None or not math.isfinite(value):
                continue
            if self._peak[i] is None or value > self._peak[i]:
                self._peak[i] = value
            self._sum_linear[i] += 10 ** (value / 10)
            self._counts[i] += 1

    def snapshot(self) -> dict | None:
        """Current statistics, or None if nothing measurable has arrived yet."""
        averages = [
            10 * math.log10(self._sum_linear[i] / self._counts[i])
            for i in range(self._bins)
            if self._counts[i]
        ]
        if not averages:
            return None
        # The *median* of the per-bin averages, not the mean. A band with real carriers has a mean
        # pulled up by exactly the bins that are not noise, which then raises the threshold those
        # carriers are measured against and hides them. Verified: with 30% of bins 8 dB above a
        # -100 dB floor, the median lands on -100 and finds every carrier while the mean reads
        # -97.6 and finds none.
        averages.sort()
        noise_floor = averages[len(averages) // 2]
        measured = [p for p in self._peak if p is not None]
        if not measured:
            return None
        occupied = sum(1 for p in measured if p >= noise_floor + OCCUPANCY_MIN_DELTA_DB)
        return {
            "noise_floor_db": round(noise_floor, 1),
            "occupancy_pct": round(100.0 * occupied / len(measured), 1),
            "peak_db": round(max(measured), 1),
            "bins_measured": len(measured),
        }
