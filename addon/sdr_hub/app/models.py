from __future__ import annotations

from pydantic import BaseModel, Field


class DongleInfo(BaseModel):
    serial: str
    label: str
    in_use_by: str | None = None


class ReceiverCreate(BaseModel):
    dongle_serial: str
    frequencies_hz: list[float] = Field(..., min_length=1)
    protocols: list[int] = Field(default_factory=list)
    hop_interval_s: int = 10


class Receiver(ReceiverCreate):
    id: str
    status: str = "running"


class SweepCreate(BaseModel):
    dongle_serial: str
    start_hz: float
    stop_hz: float
    sample_rate: float = 2.4e6
    gain: float = 30.0


class Sweep(SweepCreate):
    id: str
    status: str = "running"
