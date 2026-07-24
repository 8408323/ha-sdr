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

# readStream returning a negative SoapySDR error code (timeout, overflow, ...) is common
# and usually transient during a long sweep (confirmed empirically: a real sweep hit
# OVERFLOW (-4) mid-run with no other sign of trouble) - only treat it as a fatal,
# dongle-is-gone condition once it's persisted for this many consecutive reads in a row.
MAX_CONSECUTIVE_READ_ERRORS: int = 10

# rtl_433 receiver defaults (ReceiverCreate / ReceiverConfig).
DEFAULT_HOP_INTERVAL_S: int = 10

# Per-client outbound WebSocket queue depth. Once full, the oldest pending
# message is dropped so a slow client applies backpressure without letting
# the server's memory grow unboundedly (see Broadcaster).
WS_SEND_QUEUE_MAXSIZE: int = 64

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
