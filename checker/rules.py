"""Deterministic checks. The agent receives these results; it never recomputes the numbers itself."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from .config import load_config
from .geo import haversine_m, implied_speed_kph
from .models import RagSummary, RuleResult, RuleStatus, TrackingEvidence, ViolationEvent

S = RuleStatus


def _cfg() -> dict:
    return load_config()["rules"]


def event_start(ev: ViolationEvent) -> datetime:
    return datetime.fromisoformat(f"{ev.date} {ev.start_time}")


def _parse_ts(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.strip().replace("/", "-"))
    except ValueError:
        return None


def violation_id(ev: ViolationEvent) -> str:
    return f"{ev.date} {ev.start_time} | {ev.driver.split(' - ')[0]}"


# ---------- Matching ----------

def match_tracking(
    events: list[ViolationEvent], trackings: list[tuple[str, TrackingEvidence]]
) -> dict[int, tuple[str, TrackingEvidence]]:
    """Map event index -> (screenshot name, evidence) by closest timestamp within tolerance."""
    tol = _cfg()["match_tolerance_s"]
    out: dict[int, tuple[str, TrackingEvidence]] = {}
    used: set[int] = set()
    for i, ev in enumerate(events):
        start = event_start(ev)
        best, best_dt = None, None
        for j, (_, tr) in enumerate(trackings):
            if j in used:
                continue
            for ts in (tr.popup_timestamp, tr.trip_start):
                t = _parse_ts(ts)
                if t is None:
                    continue
                dt = abs((t - start).total_seconds())
                if dt <= tol and (best_dt is None or dt < best_dt):
                    best, best_dt = j, dt
        if best is not None:
            used.add(best)
            out[i] = trackings[best]
    return out


# ---------- Individual rules ----------

def r1_speed_consistency(ev: ViolationEvent, tr: Optional[TrackingEvidence]) -> RuleResult:
    name = "Speed vs. trip distance"
    if not tr or tr.trip_distance_km is None:
        return RuleResult(rule="R1", name=name, status=S.NA, detail="No trip distance available.")
    secs = tr.trip_duration_seconds or ev.duration_seconds
    v = implied_speed_kph(tr.trip_distance_km * 1000, secs)
    if v is None:
        return RuleResult(rule="R1", name=name, status=S.NA, detail="Trip duration is zero.")
    c = _cfg()
    diff = abs(v - ev.speed_kph)
    detail = (f"{tr.trip_distance_km:.3f} km in {secs} s = {v:.0f} km/h; "
              f"reported {ev.speed_kph:.0f} km/h (diff {diff:.0f}).")
    if v > c["max_plausible_speed_kph"]:
        return RuleResult(rule="R1", name=name, status=S.FAIL, detail=detail + " Physically impossible.")
    if diff > c["speed_consistency_tolerance_kph"]:
        return RuleResult(rule="R1", name=name, status=S.FLAG,
                          detail=detail + " Odometer distance does not support the reported speed.")
    return RuleResult(rule="R1", name=name, status=S.PASS,
                      detail=detail + " Odometer distance is consistent with the reported speed.")


def r2_gps_jump(ev: ViolationEvent, tr: Optional[TrackingEvidence]) -> RuleResult:
    name = "GPS jump (point-to-point speed)"
    if not tr or None in (tr.popup_lat, tr.popup_lon, tr.other_endpoint_lat, tr.other_endpoint_lon):
        return RuleResult(rule="R2", name=name, status=S.NA,
                          detail="Only one coordinate on screen - the agent estimates the trace length visually.")
    secs = tr.trip_duration_seconds or ev.duration_seconds
    d = haversine_m(tr.popup_lat, tr.popup_lon, tr.other_endpoint_lat, tr.other_endpoint_lon)
    v = implied_speed_kph(d, secs) or 0
    detail = f"GPS points {d:.0f} m apart in {secs} s = {v:.0f} km/h."
    if v > _cfg()["max_plausible_speed_kph"]:
        return RuleResult(rule="R2", name=name, status=S.FAIL, detail=detail + " Impossible -> GPS jump.")
    return RuleResult(rule="R2", name=name, status=S.PASS, detail=detail)


def r3_duration(ev: ViolationEvent) -> RuleResult:
    name = "Sustained duration"
    m = _cfg()["min_violation_duration_s"]
    if ev.duration_seconds < m:
        return RuleResult(rule="R3", name=name, status=S.FLAG,
                          detail=f"Lasted only {ev.duration_seconds} s (< {m} s) - could be a single-sample spike.")
    return RuleResult(rule="R3", name=name, status=S.PASS,
                      detail=f"Sustained for {ev.duration_seconds} s.")


def r4_zone_limit(ev: ViolationEvent, tr: Optional[TrackingEvidence]) -> RuleResult:
    name = "Speed vs. zone limit"
    if not tr or tr.zone_speed_limit_kph is None:
        return RuleResult(rule="R4", name=name, status=S.NA, detail="Zone speed limit not visible.")
    lim = tr.zone_speed_limit_kph
    zone = tr.zone_name or "unknown zone"
    if ev.speed_kph <= lim:
        return RuleResult(rule="R4", name=name, status=S.FAIL,
                          detail=f"{ev.speed_kph:.0f} km/h does not exceed the {lim:.0f} km/h limit of {zone}.")
    return RuleResult(rule="R4", name=name, status=S.PASS,
                      detail=f"{ev.speed_kph:.0f} km/h exceeds the {lim:.0f} km/h limit of '{zone}' "
                             f"by {ev.speed_kph - lim:.0f} km/h (if the zone assignment is correct).")


def r5_road_check(tr: Optional[TrackingEvidence], road: Optional[dict], speed_kph: float) -> RuleResult:
    name = "GPS point on a real road (OpenStreetMap)"
    if not tr or tr.popup_lat is None:
        return RuleResult(rule="R5", name=name, status=S.NA, detail="No coordinates.")
    if not road or not road.get("ok"):
        return RuleResult(rule="R5", name=name, status=S.NA,
                          detail=(road or {}).get("error", "Road lookup not run."))
    radius = _cfg()["road_search_radius_m"]
    dist = road.get("distance_m")
    if dist is None or dist > radius:
        where = "no mapped road nearby" if dist is None else f"nearest road {dist:.0f} m away ({_road_label(road)})"
        return RuleResult(rule="R5", name=name, status=S.FLAG,
                          detail=f"({tr.popup_lat}, {tr.popup_lon}) is off-road: {where}. "
                                 f"{speed_kph:.0f} km/h off-road suggests a bad GPS fix.")
    label = _road_label(road)
    maxspeed = _num(road.get("maxspeed"))
    if maxspeed and tr.zone_speed_limit_kph and maxspeed > tr.zone_speed_limit_kph and speed_kph <= maxspeed:
        return RuleResult(rule="R5", name=name, status=S.FLAG,
                          detail=f"On {label} ({dist:.0f} m), OSM limit {maxspeed:.0f} km/h; the platform applied "
                                 f"{tr.zone_speed_limit_kph:.0f} km/h. Check the geofence is correct for this road.")
    return RuleResult(rule="R5", name=name, status=S.PASS,
                      detail=f"On {label} ({dist:.0f} m from the point)"
                             + (f", OSM limit {maxspeed:.0f} km/h." if maxspeed else "."))


def r6_odometer(
    pairs: list[tuple[ViolationEvent, Optional[TrackingEvidence]]], idx: int
) -> RuleResult:
    """Average speed between this event and the previous one with an odometer reading."""
    name = "Odometer plausibility"
    ev, tr = pairs[idx]
    if not tr or tr.popup_odometer_km is None:
        return RuleResult(rule="R6", name=name, status=S.NA, detail="No odometer reading.")
    prev = [(e, t) for e, t in pairs[:idx] if t and t.popup_odometer_km is not None and e.driver == ev.driver]
    if not prev:
        return RuleResult(rule="R6", name=name, status=S.NA, detail="No earlier event to compare with.")
    pe, pt = prev[-1]
    dkm = tr.popup_odometer_km - pt.popup_odometer_km
    hours = (event_start(ev) - event_start(pe)).total_seconds() / 3600
    if dkm < 0:
        return RuleResult(rule="R6", name=name, status=S.FAIL, detail=f"Odometer went backwards ({dkm:.1f} km).")
    if hours <= 0:
        return RuleResult(rule="R6", name=name, status=S.NA, detail="Events at the same time.")
    avg = dkm / hours
    detail = f"{dkm:.1f} km since {pe.start_time} ({hours * 60:.0f} min) = avg {avg:.0f} km/h."
    if avg > _cfg()["max_plausible_avg_speed_kph"]:
        return RuleResult(rule="R6", name=name, status=S.FLAG, detail=detail + " Implausibly high.")
    return RuleResult(rule="R6", name=name, status=S.PASS, detail=detail)


def r7_cross_report(ev: ViolationEvent, events: list[ViolationEvent], rag: Optional[RagSummary]) -> RuleResult:
    name = "Matches Road Safety RAG report"
    if rag is None:
        return RuleResult(rule="R7", name=name, status=S.NA, detail="No RAG report uploaded.")
    key = _norm(ev.driver)
    row = next((r for r in rag.drivers if _norm(r.driver) == key), None)
    if row is None:
        return RuleResult(rule="R7", name=name, status=S.FLAG, detail="Driver not found in the RAG report.")
    mine = [e for e in events if _norm(e.driver) == key]
    n_reckless = sum("reckless" in e.event.lower() for e in mine)
    n_over = sum("over-speed" in e.event.lower() and "reckless" not in e.event.lower() for e in mine)
    detail = (f"RAG: reckless={row.reckless}, over-speed={row.over_speed}; "
              f"violation list: reckless={n_reckless}, over-speed={n_over}.")
    if (row.reckless, row.over_speed) != (n_reckless, n_over):
        return RuleResult(rule="R7", name=name, status=S.FLAG, detail=detail + " Counts differ.")
    return RuleResult(rule="R7", name=name, status=S.PASS, detail=detail + " Counts agree.")


def run_rules(
    events: list[ViolationEvent],
    matched: dict[int, tuple[str, TrackingEvidence]],
    rag: Optional[RagSummary],
    roads: dict[int, dict],
) -> dict[int, list[RuleResult]]:
    order = sorted(range(len(events)), key=lambda i: event_start(events[i]))
    pairs = [(events[i], matched.get(i, (None, None))[1]) for i in order]
    out: dict[int, list[RuleResult]] = {}
    for pos, i in enumerate(order):
        ev, tr = pairs[pos]
        out[i] = [
            r1_speed_consistency(ev, tr),
            r2_gps_jump(ev, tr),
            r3_duration(ev),
            r4_zone_limit(ev, tr),
            r5_road_check(tr, roads.get(i), ev.speed_kph),
            r6_odometer(pairs, pos),
            r7_cross_report(ev, events, rag),
        ]
    return out


# ---------- helpers ----------

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _num(s) -> Optional[float]:
    if s is None:
        return None
    m = re.search(r"\d+(\.\d+)?", str(s))
    return float(m.group()) if m else None


def _road_label(road: dict) -> str:
    parts = [p for p in (road.get("ref"), road.get("name")) if p]
    return " / ".join(parts) + f" [{road.get('highway')}]" if parts else f"unnamed {road.get('highway')} road"
