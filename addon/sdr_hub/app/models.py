from __future__ import annotations

from enum import Enum

from constants import DEFAULT_GAIN_DB, DEFAULT_HOP_INTERVAL_S, DEFAULT_SAMPLE_RATE_HZ, FFT_SIZE
from pydantic import BaseModel, Field, model_validator


class EntityStatus(str, Enum):
    """Lifecycle status of a receiver or sweep."""

    RUNNING = "running"
    ERROR = "error"


class EntityKind(str, Enum):
    """Which kind of pooled entity a status/event refers to."""

    RECEIVER = "receiver"
    SWEEP = "sweep"


class DongleInfo(BaseModel):
    serial: str
    label: str
    in_use_by: str | None = None


class ReceiverCreate(BaseModel):
    dongle_serial: str
    frequencies_hz: list[float] = Field(..., min_length=1)
    protocols: list[int] = Field(default_factory=list)
    hop_interval_s: int = DEFAULT_HOP_INTERVAL_S


class Receiver(ReceiverCreate):
    id: str
    status: EntityStatus = EntityStatus.RUNNING


class SweepCreate(BaseModel):
    dongle_serial: str
    start_hz: float
    stop_hz: float
    sample_rate: float = DEFAULT_SAMPLE_RATE_HZ
    gain: float = DEFAULT_GAIN_DB

    @model_validator(mode="after")
    def _validate_range(self) -> SweepCreate:
        # Checked before any arithmetic on sample_rate below: a zero or negative rate reaches
        # the scanner as a zero/negative bin_hz, which either raises ZeroDivisionError deriving
        # n_bins_total or produces a nonsensical negative bin count/half_span - either way the
        # sweep dies in the background thread well after the caller was told it started
        # successfully. This is the shared model used by both the HA service call path and the
        # panel's WS-command path, so it's the one place that actually guards every caller.
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if self.stop_hz <= self.start_hz:
            raise ValueError("stop_hz must be greater than start_hz")
        # A positive range narrower than one FFT bin (bin_hz = sample_rate/FFT_SIZE, e.g.
        # ~1.17kHz at the default sample rate) passed the check above but still produces
        # n_bins_total == 0 in the scanner - an empty power_db that crashes the panel's
        # getImageData/createImageData calls (zero width) instead of just failing to start.
        bin_hz = self.sample_rate / FFT_SIZE
        if (self.stop_hz - self.start_hz) < bin_hz:
            raise ValueError(f"range must be at least one bin wide ({bin_hz:.1f} Hz at this sample rate)")
        return self


class Sweep(SweepCreate):
    id: str
    status: EntityStatus = EntityStatus.RUNNING
