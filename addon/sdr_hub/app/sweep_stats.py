"""Per-sweep session statistics: an estimated noise floor, peak hold, and band occupancy.

Computed here rather than in each panel tab, which is where it started. A per-tab statistic is
neither shared nor durable: two open panels disagree about the same hardware, a reload resets the
peak hold to whatever arrives next, and Home Assistant itself - the thing an automation reacts to -
has no access to it at all. One accumulator per sweep, on the side that owns the data, gives every
consumer the same answer.
"""

from __future__ import annotations

import math

from constants import NOISE_FLOOR_QUANTILE, OCCUPANCY_MIN_DELTA_DB


class SweepStats:
    """Accumulates one sweep's session statistics across the rows it emits."""

    def __init__(self) -> None:
        # Incremented on every reset and published with each snapshot. A reset is a *boundary* in
        # the row stream, and only the side that owns the accumulator can say where it falls: a
        # client clearing its own copy when the button is pressed cannot know whether a row already
        # in flight belongs before or after, so a transient in that row would be kept by one view
        # and dropped by the other. Carrying the generation lets every consumer place the boundary
        # exactly where this side did. Same mechanism the decoded log already uses for its clear.
        self.generation = 0
        self._bins = 0
        self._peak: list[float | None] = []
        # Linear power, not dB. Summing decibels computes a geometric mean, which understates an
        # intermittent signal badly: a bin at -100 dB except when a sensor transmits at -40 dB
        # averages to -70 dB that way, against a true mean power near -43 dB. Only the mean needs
        # the linear domain - a peak comparison in dB is exact, since dB is monotonic in power.
        self._sum_linear: list[float] = []
        self._counts: list[int] = []

    def reset(self) -> None:
        self.generation += 1
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
        # A low quantile of the per-bin averages - not the mean, and not the median either.
        #
        # The mean is pulled up by exactly the bins being looked for. The median fixes that only
        # while noise is the majority: at 50% occupancy the median is itself a carrier level, so
        # adding the threshold to it hides every carrier and reports an empty band precisely when
        # the band is busiest. Both failures are the same shape - an estimator contaminated by the
        # population it is meant to be measured against - and only a quantile below that population
        # avoids it.
        averages.sort()
        index = min(len(averages) - 1, int(len(averages) * NOISE_FLOOR_QUANTILE))
        noise_floor = averages[index]
        # Occupancy compares each bin's *average* against the floor, not its peak hold.
        #
        # Comparing peaks against an average-derived floor compared two different populations, and
        # the bias grew without bound: a peak hold is the maximum of every row so far, so on pure
        # noise it drifts several sigma above the mean as the session lengthens while the floor
        # stays put. Measured on 200 rows of 3 dB noise with nothing transmitting, that reported
        # 86.4% of the band occupied. The longer a sweep ran, the busier an empty band looked.
        #
        # Averages also answer the more useful question. Peak hold says "something was here once",
        # which a single burst satisfies for the rest of the session; the average says the bin is
        # persistently occupied, which is what "the band is busy" means to an automation. The peak
        # is still published in its own right as peak_db.
        measured = [
            10 * math.log10(self._sum_linear[i] / self._counts[i]) for i in range(self._bins) if self._counts[i]
        ]
        if not measured:
            return None
        occupied = sum(1 for value in measured if value >= noise_floor + OCCUPANCY_MIN_DELTA_DB)
        peaks = [p for p in self._peak if p is not None]
        return {
            "generation": self.generation,
            "noise_floor_db": round(noise_floor, 1),
            "occupancy_pct": round(100.0 * occupied / len(measured), 1),
            "peak_db": round(max(peaks), 1) if peaks else round(max(measured), 1),
            "bins_measured": len(measured),
        }
