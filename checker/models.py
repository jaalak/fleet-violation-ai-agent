"""Data models shared by extraction, rules, agent and UI."""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------- Extracted from documents ----------

class ViolationEvent(BaseModel):
    driver: str = Field(description="Driver name and phone exactly as printed")
    date: str = Field(description="Event date as YYYY-MM-DD")
    event: str = Field(description="Event type, e.g. Adnoc-over-speed-reckless")
    start_time: str = Field(description="'From' time as HH:MM:SS")
    end_time: str = Field(description="'To' time as HH:MM:SS")
    duration_seconds: int
    speed_kph: float
    asset: str = Field(description="Vehicle / asset name")
    site: Optional[str] = None


class ViolationReport(BaseModel):
    period_from: Optional[str] = None
    period_to: Optional[str] = None
    events: list[ViolationEvent]
    total_events: Optional[int] = None
    max_speed_kph: Optional[float] = None


class RagDriverRow(BaseModel):
    driver: str
    distance_km: Optional[float] = None
    driving_duration: Optional[str] = None
    max_speed_kph: Optional[float] = None
    over_speed: int = 0
    reckless: int = 0
    night_driving: int = 0
    seatbelt: int = 0
    harsh_braking: int = 0
    harsh_acceleration: int = 0
    phone_use: int = 0
    smoking: int = 0
    fatigue: int = 0
    distraction: int = 0


class RagSummary(BaseModel):
    period_from: Optional[str] = None
    period_to: Optional[str] = None
    drivers: list[RagDriverRow]


class TrackingEvidence(BaseModel):
    """Facts read off one Historical Tracking screenshot."""

    trip_start: Optional[str] = Field(None, description="Trip 'From' as YYYY-MM-DD HH:MM:SS")
    trip_end: Optional[str] = Field(None, description="Trip 'To' as YYYY-MM-DD HH:MM:SS")
    trip_distance_km: Optional[float] = None
    trip_duration_seconds: Optional[int] = None
    popup_event: Optional[str] = Field(None, description="Popup title, e.g. Adnoc-over-speed-alarm - Started")
    popup_driver: Optional[str] = None
    popup_timestamp: Optional[str] = Field(None, description="Popup date/time as YYYY-MM-DD HH:MM:SS")
    popup_speed_kph: Optional[float] = None
    popup_odometer_km: Optional[float] = None
    zone_name: Optional[str] = Field(None, description="Location/zone text after the speed limit, e.g. BT-City-Madinat Zayed")
    zone_speed_limit_kph: Optional[float] = Field(None, description="Speed limit in the location text, e.g. 80")
    popup_lat: Optional[float] = None
    popup_lon: Optional[float] = None
    other_endpoint_lat: Optional[float] = Field(
        None, description="Latitude of the OTHER end of the trace, only if it is printed on screen for that point"
    )
    other_endpoint_lon: Optional[float] = None
    visible_place_names: list[str] = Field(default_factory=list, description="Road / place labels visible on the map")


# ---------- Rule engine ----------

class RuleStatus(str, Enum):
    PASS = "PASS"      # supports the violation being genuine
    FLAG = "FLAG"      # suspicious, weakens the violation
    FAIL = "FAIL"      # strong evidence the violation is false
    NA = "N/A"         # not enough data


class RuleResult(BaseModel):
    rule: str
    name: str
    status: RuleStatus
    detail: str


# ---------- Final verdict ----------

class VerdictLabel(str, Enum):
    VALID = "VALID"
    LIKELY_FALSE = "LIKELY_FALSE"
    NEEDS_REVIEW = "NEEDS_REVIEW"


class Verdict(BaseModel):
    violation_id: str
    verdict: VerdictLabel
    confidence: float = Field(description="0.0 - 1.0")
    summary: str
    reasons: list[str]
    evidence: list[str]
    recommended_action: str


class CaseResult(BaseModel):
    """Everything the UI shows for one violation."""

    violation_id: str
    event: ViolationEvent
    tracking: Optional[TrackingEvidence] = None
    screenshot_name: Optional[str] = None
    rules: list[RuleResult]
    verdict: Optional[Verdict] = None
    error: Optional[str] = None
