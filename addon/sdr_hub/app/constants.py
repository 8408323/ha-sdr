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

# rtl_433 receiver defaults (ReceiverCreate / ReceiverConfig).
DEFAULT_HOP_INTERVAL_S: int = 10

# Per-client outbound WebSocket queue depth. Once full, the oldest pending
# message is dropped so a slow client applies backpressure without letting
# the server's memory grow unboundedly (see Broadcaster).
WS_SEND_QUEUE_MAXSIZE: int = 64
