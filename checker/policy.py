"""ADNOC IVMS & AFDD System Configuration, version HRT-2026-01 (Group High Risk Transport).

The thresholds the platform is configured with; violations are checked against these.
Mirrors docs/js/policy.js.
"""

from __future__ import annotations

import re
from typing import Optional

VERSION = "HRT-2026-01"

# Max speed by vehicle class and road type (km/h). On black top the posted / geofenced limit applies,
# and no road may exceed ABSOLUTE_MAX_KPH. Internal roads are set by risk assessment.
MAX_SPEED = {
    "light": {"black_top": 140, "off_road": 80},
    "bus_small": {"black_top": 100, "off_road": 60},  # buses with 22 seats or fewer
    "heavy": {"black_top": 80, "off_road": 60},       # buses with 23+ seats and all other heavy vehicles
}
ABSOLUTE_MAX_KPH = 140

EVENTS = {
    "over_speed": {"label": "Over speed", "min_duration_s": 30,
                   "rule": "Above the road speed limit continuously for 30 s"},
    "reckless": {"label": "Reckless", "min_duration_s": 0, "over_limit_kph": 20,
                 "rule": "Speed >= configured road limit + 20 km/h, threshold time >= 0 s"},
    "seatbelt": {"label": "Seatbelt", "min_duration_s": 10, "min_speed_kph": 10,
                 "rule": "Seatbelt unbuckled >= 10 s at >= 10 km/h"},
    "night_driving": {"label": "Night driving", "min_duration_s": 0, "min_speed_kph": 10,
                      "window": ("21:00", "04:30"),
                      "rule": "Any driving between 21:00 and 04:30 at >= 10 km/h"},
}

# RAG bands per driver per month: green when 0, amber up to amber_max, red above.
RAG = {"over_speed": 3, "reckless": 1, "night_driving": 1, "seatbelt": 0}

VEHICLE_CLASSES = {
    "light": "Light vehicle",
    "bus_small": "Bus, 22 seats or fewer",
    "heavy": "Heavy vehicle / bus 23+ seats",
}


def classify_event(name: str) -> Optional[str]:
    """Map a platform event name (e.g. 'Adnoc-over-speed-reckless') to a policy event type."""
    s = (name or "").lower()
    if "reckless" in s:
        return "reckless"
    if re.search(r"over.?speed", s):
        return "over_speed"
    if re.search(r"seat.?belt", s):
        return "seatbelt"
    if "night" in s:
        return "night_driving"
    return None


def road_type_from_zone(zone: Optional[str]) -> Optional[str]:
    """'BT-City-...' = black top; desert / sand tracks = off road."""
    s = zone or ""
    if re.search(r"(^|[^a-z])bt([^a-z]|$)|black\s*top|highway|motorway", s, re.I):
        return "black_top"
    if re.search(r"desert|sand|off.?road|track|dune|gatch|graded", s, re.I):
        return "off_road"
    return None


_PAVED = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
          "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
_UNPAVED = re.compile(r"unpaved|sand|dirt|gravel|ground|earth|compacted|fine_gravel|mud")


def road_type_from_osm(road: Optional[dict]) -> Optional[str]:
    if not road or not road.get("highway"):
        return None
    if road.get("surface") and _UNPAVED.search(road["surface"]):
        return "off_road"
    if road["highway"] in ("track", "path"):
        return "off_road"
    return "black_top" if road["highway"] in _PAVED else None


def rag_band(event_type: str, count: int) -> Optional[str]:
    if event_type not in RAG:
        return None
    if count == 0:
        return "GREEN"
    return "AMBER" if count <= RAG[event_type] else "RED"


def in_night_window(time: str) -> Optional[bool]:
    m = re.match(r"(\d{1,2}):(\d{2})", time or "")
    if not m:
        return None
    mins = int(m[1]) * 60 + int(m[2])
    a, b = (int(t[:2]) * 60 + int(t[3:]) for t in EVENTS["night_driving"]["window"])
    return mins >= a or mins < b


def policy_summary(vehicle_class: str) -> str:
    ms = MAX_SPEED[vehicle_class]
    return "\n".join([
        f"ADNOC IVMS policy {VERSION}. Vehicle class: {VEHICLE_CLASSES[vehicle_class]}.",
        f"- Max speed for this class: black top {ms['black_top']} km/h (posted / geofenced limit applies; never "
        f"above {ABSOLUTE_MAX_KPH} km/h on any road), off road {ms['off_road']} km/h.",
        *(f"- {e['label']}: {e['rule']}." for e in EVENTS.values()),
        "- RAG per month: Over speed amber <=3, red >3; Reckless amber <=1, red >1; Night driving amber <=1, "
        "red >1; Seatbelt red >0.",
    ])
