"""Shared default values and magic numbers for the sdr_hub add-on.

Centralizing these avoids the same literal (sample rate, gain, FFT size, ...)
being duplicated - with occasionally-different values - across models.py,
scanner.py, and decode.py.
"""

from __future__ import annotations

# SoapySDR sweep defaults (SweepCreate / SweepConfig).
DEFAULT_SAMPLE_RATE_HZ: float = 2.4e6
DEFAULT_GAIN_DB: float = 30.0
FFT_SIZE: int = 2048

# RTL2832U/R820T direct-conversion tuners leak the local oscillator into the ADC, producing
# a spurious "DC spike" at the exact center frequency of every capture window - a hardware
# artifact, not a real signal (every SDR waterfall tool has this, e.g. SDR#/GQRX). Since a
# wideband sweep retunes every sample_rate Hz, this shows up as one fake blob per step,
# evenly spaced. Blank this many bins on each side of the FFT's center bin before display.
DC_SPIKE_BLANK_BINS: int = 2

# readStream returning a negative SoapySDR error code (timeout, overflow, ...) is common
# and usually transient during a long sweep (confirmed empirically: a real sweep hit
# OVERFLOW (-4) mid-run with no other sign of trouble) - only treat it as a fatal,
# dongle-is-gone condition once it's persisted for this many consecutive reads in a row.
MAX_CONSECUTIVE_READ_ERRORS: int = 10

# How many times to re-read a hop that returned OVERFLOW before giving up on it.
#
# OVERFLOW is not a symptom of trouble here, it is expected by construction: setFrequency is called
# with the stream still active, so the driver keeps buffering during retune and settle, and the
# first read after each hop is the one that reports the buffers filled and were discarded. The
# device is fine and the very next read succeeds - measured on live hardware, every occurrence was
# a single one, since the failure itself is what drains the backlog.
#
# Treating it as an unrecoverable gap meant discarding a full FFT_SIZE-bin hop for a condition that
# clears immediately: measured over a 863-870 MHz sweep, 3.3% of emitted rows were missing a whole
# hop - a third of the spectrum - and nulls render as the weakest signal, so those rows read as a
# quiet band rather than as missing data.
OVERFLOW_READ_RETRIES: int = 2

# A bin counts as "occupied" when its session peak stands this far above the estimated noise floor.
# Matches the panel's per-row peak-callout threshold: two different answers to "is this a real
# signal" would let two readouts disagree about the same bin.
OCCUPANCY_MIN_DELTA_DB: float = 6.0

# Which quantile of the per-bin averages is taken as the noise floor.
#
# The median is only the noise floor while noise is the majority of the band. Once persistent
# carriers occupy half the bins the median *is* a carrier level, and adding the threshold to it then
# classifies those carriers as unoccupied - reporting 0% on precisely the busy band this statistic
# exists to detect. A quantile below the occupied population avoids that, at the cost of sitting
# below the true floor on a quiet band and calling some noise occupied. The two errors pull in
# opposite directions, so the value is a measured compromise rather than a preference:
#
#   band 60% occupied      median -> 0.0% (wrong)   q=0.25 -> 60.0%   q=0.10 -> 60.0%
#   quiet, one row, s=2dB  median -> 0.1%           q=0.25 -> 0.9%    q=0.10 -> 4.6%
#   quiet, 200 rows        median -> 0.0%           q=0.25 -> 0.0%    q=0.10 -> 0.0%
#
# 0.25 takes almost all of the busy-band correction for a fraction of the quiet-band cost, and
# holds until carriers exceed 75% of the band. The last row is what actually ships: these are
# averages over every row of the session, so per-bin spread falls as sqrt(N) and the single-row
# figures above are a worst case seen only in the first moments of a sweep.
NOISE_FLOOR_QUANTILE: float = 0.25

# rtl_433 receiver defaults (ReceiverCreate / ReceiverConfig).
DEFAULT_HOP_INTERVAL_S: int = 10

# Per-client outbound WebSocket queue depth. Once full, the oldest pending
# message is dropped so a slow client applies backpressure without letting
# the server's memory grow unboundedly (see Broadcaster).
WS_SEND_QUEUE_MAXSIZE: int = 64

# Cap on the *native*-resolution bin count a sweep range is allowed to request, before any
# downsampling. A legitimate full-range sweep (24MHz-1764MHz at the default sample rate) is
# ~1.48M bins - generous headroom above that catches a mistyped huge stop frequency or a tiny
# positive sample rate turning into a request for tens/hundreds of millions (or billions) of
# bins, which would allocate a many-GB float32 array and OOM the add-on's thread/container
# well after the caller was already told the sweep started successfully.
MAX_NATIVE_BINS: int = 10_000_000

# Cap on delivered points per sweep row, regardless of how wide a range is requested.
# Native resolution (bin_hz = sample_rate/FFT_SIZE) produces a bin count proportional to
# range width - a full 24-1764MHz sweep is ~1.48M bins, which serializes to double-digit
# megabytes and silently exceeds the WebSocket's 1MB frame limit (the send just fails,
# repeatedly, with nothing ever reaching a client). Rows wider than this are downsampled
# by averaging adjacent bins (see scanner.py) rather than delivered at native resolution -
# 8192 points is still finer than almost any waterfall display can usefully render, and
# keeps every row safely under the frame limit even before accounting for the 1-decimal
# rounding also applied at serialization.
MAX_ROW_POINTS: int = 8192
