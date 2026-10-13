"""Deterministic checks. The agent receives these results; it never recomputes the numbers itself."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from .config import load_config
from . import policy as P
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
    name = "Duration vs. policy threshold"
    etype = P.classify_event(ev.event)
    if not etype:
        return RuleResult(rule="R3", name=name, status=S.NA,
                          detail=f"Event type '{ev.event}' is not covered by the policy table.")
    p = P.EVENTS[etype]
    if ev.duration_seconds < p["min_duration_s"]:
        return RuleResult(rule="R3", name=name, status=S.FAIL,
                          detail=f"{p['label']} needs >= {p['min_duration_s']} s ({P.VERSION}); this event lasted only "
                                 f"{ev.duration_seconds} s, so it should not have been recorded.")
    if p["min_duration_s"] == 0:
        return RuleResult(rule="R3", name=name, status=S.PASS,
                          detail=f"{p['label']} has a >= 0 s threshold ({P.VERSION}): a {ev.duration_seconds} s event is "
                                 "valid by duration alone. Short duration is not a defence; the location is what matters.")
    return RuleResult(rule="R3", name=name, status=S.PASS,
                      detail=f"Lasted {ev.duration_seconds} s (>= {p['min_duration_s']} s required for {p['label']}).")


def r4_zone_limit(ev: ViolationEvent, tr: Optional[TrackingEvidence]) -> RuleResult:
    name = "Speed vs. policy trigger"
    etype = P.classify_event(ev.event)
    speed = ev.speed_kph
    if etype == "night_driving":
        min_v = P.EVENTS["night_driving"]["min_speed_kph"]
        if P.in_night_window(ev.start_time) is False:
            return RuleResult(rule="R4", name=name, status=S.FAIL,
                              detail=f"{ev.start_time} is outside the 21:00-04:30 night window.")
        if speed < min_v:
            return RuleResult(rule="R4", name=name, status=S.FAIL,
                              detail=f"{speed:.0f} km/h is below the {min_v} km/h night-driving threshold.")
        return RuleResult(rule="R4", name=name, status=S.PASS,
                          detail=f"{ev.start_time} is inside 21:00-04:30 at {speed:.0f} km/h.")
    if etype == "seatbelt":
        min_v = P.EVENTS["seatbelt"]["min_speed_kph"]
        ok = speed >= min_v
        return RuleResult(rule="R4", name=name, status=S.PASS if ok else S.FAIL,
                          detail=f"{speed:.0f} km/h {'>=' if ok else 'is below'} the {min_v} km/h seatbelt threshold.")
    if not tr or tr.zone_speed_limit_kph is None:
        return RuleResult(rule="R4", name=name, status=S.NA, detail="Zone speed limit not visible.")
    lim = tr.zone_speed_limit_kph
    zone = tr.zone_name or "unknown zone"
    if etype == "reckless":
        over = P.EVENTS["reckless"]["over_limit_kph"]
        trigger = lim + over
        if speed < trigger:
            return RuleResult(rule="R4", name=name, status=S.FAIL,
                              detail=f"Reckless needs >= {trigger:.0f} km/h ({lim:.0f} limit + {over}); reported "
                                     f"{speed:.0f} km/h, so this is not reckless even in '{zone}'.")
        return RuleResult(rule="R4", name=name, status=S.PASS,
                          detail=f"{speed:.0f} km/h >= {trigger:.0f} km/h ({lim:.0f} km/h limit of '{zone}' + {over}): "
                                 "reckless by policy, if the zone assignment is correct.")
    if speed <= lim:
        return RuleResult(rule="R4", name=name, status=S.FAIL,
                          detail=f"{speed:.0f} km/h does not exceed the {lim:.0f} km/h limit of {zone}.")
    return RuleResult(rule="R4", name=name, status=S.PASS,
                      detail=f"{speed:.0f} km/h exceeds the {lim:.0f} km/h limit of '{zone}' by {speed - lim:.0f} km/h "
                             "(if the zone assignment is correct).")


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
    etype = P.classify_event(ev.event)
    count = {"reckless": row.reckless, "over_speed": row.over_speed}.get(etype)
    impact = ""
    if count:
        now, after = P.rag_band(etype, count), P.rag_band(etype, count - 1)
        impact = (f" {P.EVENTS[etype]['label']}: {count} this month = {now}; "
                  + (f"overturning this event makes it {after}." if after != now
                     else f"overturning this event alone keeps it {after}."))
    return RuleResult(rule="R7", name=name, status=S.PASS, detail=detail + " Counts agree." + impact)


def r8_zone_policy(ev: ViolationEvent, tr: Optional[TrackingEvidence], road: Optional[dict],
                   vehicle_class: str = "light") -> RuleResult:
    name = "Zone vs. ADNOC policy and the actual road"
    if not tr or tr.zone_speed_limit_kph is None:
        return RuleResult(rule="R8", name=name, status=S.NA, detail="Zone speed limit not visible.")
    lim = tr.zone_speed_limit_kph
    zone_road = P.road_type_from_zone(tr.zone_name)
    caps = P.MAX_SPEED[vehicle_class]
    notes, status = [], S.PASS
    if zone_road:
        cap = caps[zone_road]
        label = "black top" if zone_road == "black_top" else "off road"
        if lim > cap:
            status = S.FLAG
            notes.append(f"Zone limit {lim:.0f} km/h is above the policy max of {cap} km/h for {label}: "
                         "geofence misconfigured.")
        else:
            notes.append(f"Zone '{tr.zone_name}' is {label}; its {lim:.0f} km/h limit is within the policy max "
                         f"({cap} km/h).")
    else:
        notes.append(f"Road type of zone '{tr.zone_name or '?'}' is unclear from its name.")

    radius = _cfg()["road_search_radius_m"]
    on_road = bool(road and road.get("ok") and road.get("distance_m") is not None and road["distance_m"] <= radius)
    osm_type = P.road_type_from_osm(road) if on_road else None
    if zone_road == "off_road" and osm_type == "black_top":
        status = S.FLAG
        outcome = ""
        maxspeed = _num(road.get("maxspeed"))
        if maxspeed:
            eff = min(maxspeed, P.ABSOLUTE_MAX_KPH, caps["black_top"])
            reckless = P.classify_event(ev.event) == "reckless"
            trig = eff + P.EVENTS["reckless"]["over_limit_kph"] if reckless else eff
            outcome = (f" Against that road's {eff:.0f} km/h limit, {ev.speed_kph:.0f} km/h would "
                       f"{'still' if ev.speed_kph >= trig else 'NOT'} be {'reckless' if reckless else 'over the limit'}.")
        notes.append(f"But the GPS point is on {_road_label(road)}, a black-top road: the off-road limit may have "
                     f"been applied wrongly.{outcome}")
    elif zone_road == "black_top" and road and road.get("ok") and not on_road:
        status = S.FLAG
        notes.append("But the GPS point is not on any mapped road, so the position itself is doubtful.")
    elif zone_road == "off_road" and road and road.get("ok") and not on_road:
        notes.append("The GPS point is not on a mapped road. That fits off-road driving, but also fits a bad GPS fix.")
    if ev.speed_kph > P.ABSOLUTE_MAX_KPH:
        notes.append(f"{ev.speed_kph:.0f} km/h is above the {P.ABSOLUTE_MAX_KPH} km/h absolute maximum on any road.")
    return RuleResult(rule="R8", name=name, status=status, detail=" ".join(notes))


def run_rules(
    events: list[ViolationEvent],
    matched: dict[int, tuple[str, TrackingEvidence]],
    rag: Optional[RagSummary],
    roads: dict[int, dict],
    vehicle_class: str = "light",
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
            r8_zone_policy(ev, tr, roads.get(i), vehicle_class),
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
