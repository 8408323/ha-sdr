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

# How long a discovery run listens for, and the bounds a caller may ask for.
#
# The default is a compromise against transmit intervals rather than a round number: the ISM
# sensors this is aimed at report every 30-60 seconds, so a shorter listen routinely reports a
# quiet band that simply had not spoken yet - the single most misleading answer this feature can
# give. The upper bound exists because a discovery run holds the dongle claim for its whole
# duration, blocking every sweep and receiver on that device; anything longer than a few minutes
# is a receiver, which is the thing that already exists for listening indefinitely.
DEFAULT_DISCOVERY_DURATION_S: int = 90
MIN_DISCOVERY_DURATION_S: int = 10
# Twelve hours. The original ceiling was ten minutes, on the reasoning that a longer listen is
# really a receiver - which was wrong about what the two are for. A receiver publishes entities
# for devices you have decided to keep; a survey answers "what is out there", and the honest
# answer for an intermittent transmitter takes hours. An overnight run that spans dawn is what
# catches a light sensor, a rain gauge, or a door contact nobody touched until morning; measured
# here, a ten-minute listen on a live band found one device where ten hours was needed to be
# confident that was all of them.
#
# It is still bounded, and the bound is still about the dongle: a survey holds the claim for its
# whole duration, so an unbounded one is indistinguishable from a leak. Twelve hours covers a
# night without letting a mistyped value occupy the device for a week.
MAX_DISCOVERY_DURATION_S: int = 43200

# Bounds on the optional rtl_433 tuning overrides. Both are "unset means let rtl_433 decide",
# so these only constrain a value the user deliberately supplied.
#
# Gain: 0 is meaningful (minimum gain, for a transmitter close enough to overload the front end),
# and ~49.6 dB is the maximum an R820T offers; anything beyond is silently clamped by the driver,
# which is worse than being told.
MIN_DISCOVERY_GAIN_DB: float = 0.0
MAX_DISCOVERY_GAIN_DB: float = 50.0
# Sample rate: below ~200k the OOK decoders lose the timing resolution they need, and the RTL2832U
# cannot sustain above 3.2M (it drops samples well before that, but the hard limit is where the
# driver stops pretending). Between those the value is a real trade: wider catches signals further
# off the nominal frequency, narrower gives a better noise floor.
MIN_DISCOVERY_SAMPLE_RATE_HZ: float = 200_000.0
MAX_DISCOVERY_SAMPLE_RATE_HZ: float = 3_200_000.0

# Cap on distinct devices one discovery run will accumulate. Reached only on a band far busier
# than a home installation (a block of flats on 433 MHz, or a decoder mis-triggering on noise),
# where the list has long since stopped being readable - past this point new devices are dropped
# and the result is flagged truncated, rather than letting an unbounded dict grow behind a
# snapshot that is rebroadcast on every single decode.
DISCOVERY_MAX_DEVICES: int = 200

# How many *finished* discovery runs to retain before dropping the oldest.
#
# Results outlive their run on purpose - a panel opened afterwards has no other way to see what
# was heard - but "kept until dismissed" is not a bound, and each retained run can hold up to
# DISCOVERY_MAX_DEVICES entries that /discoveries returns in full. Ten is comfortably more than
# the handful a user compares while working out what is on a band, and small enough that the
# worst-case list response stays modest.
MAX_RETAINED_DISCOVERIES: int = 10

# Bound on the tuner frequency-offset correction, in parts per million.
#
# Real RTL-SDR crystals are out by tens of ppm; the cheapest are specified to 100 and a handful of
# the worst reach a few hundred. 1000 ppm at 868 MHz is 868 kHz - far more than any band this
# tunes - so anything beyond that is a typo rather than a calibration, and is worth rejecting
# rather than quietly tuning the receiver off the band the user asked for.
MAX_PPM_ERROR: int = 1000

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
