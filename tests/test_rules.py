"""Rule tests. Values mirror a real report shape but the driver, vehicle and locations are fictional."""

import pytest

from checker.geo import haversine_m
from checker.models import RagDriverRow, RagSummary, RuleStatus, TrackingEvidence, ViolationEvent
from checker.rules import match_tracking, run_rules

DRIVER = "Test Driver - 050-0000000"


def ev(start, end, speed):
    return ViolationEvent(driver=DRIVER, date="2026-10-11", event="Adnoc-over-speed-reckless",
                          start_time=start, end_time=end, duration_seconds=3, speed_kph=speed,
                          asset="Toyota Fortuner-TEST-01")


EVENTS = [ev("18:27:29", "18:27:32", 105), ev("19:41:13", "19:41:16", 120)]

TRACK_CITY = TrackingEvidence(
    trip_start="2026-10-11 18:27:29", trip_end="2026-10-11 18:27:32", trip_distance_km=0.084,
    trip_duration_seconds=3, popup_timestamp="2026-10-11 18:27:29", popup_speed_kph=105,
    popup_odometer_km=100000.000, zone_name="Test-City-Zone", zone_speed_limit_kph=80,
    popup_lat=24.140588, popup_lon=54.188889,
)
TRACK_DESERT = TrackingEvidence(
    trip_start="2026-10-11 19:41:13", trip_end="2026-10-11 19:41:16", trip_distance_km=0.099,
    trip_duration_seconds=3, popup_timestamp="2026-10-11 19:41:13", popup_speed_kph=119,
    popup_odometer_km=100063.430, zone_name="Test-Desert-Sand-Tracks",
    zone_speed_limit_kph=80, popup_lat=24.191039, popup_lon=53.987946,
)
RAG = RagSummary(drivers=[RagDriverRow(driver=DRIVER, distance_km=2611, max_speed_kph=141, reckless=2)])


def rules_by_id(results):
    return {r.rule: r for r in results}


@pytest.fixture
def results():
    # screenshots deliberately passed in reverse order to exercise matching
    matched = match_tracking(EVENTS, [("desert.jpg", TRACK_DESERT), ("city.jpg", TRACK_CITY)])
    assert matched[0][0] == "city.jpg" and matched[1][0] == "desert.jpg"
    return run_rules(EVENTS, matched, RAG, roads={})


def test_haversine_known_distance():
    # 0.01 deg of latitude ~ 1.11 km
    assert haversine_m(23.0, 53.0, 23.01, 53.0) == pytest.approx(1112, rel=0.01)


def test_r1_odometer_consistent_with_reported_speed(results):
    r1 = rules_by_id(results[0])["R1"]
    assert r1.status == RuleStatus.PASS  # 84 m / 3 s = 101 km/h vs 105
    assert rules_by_id(results[1])["R1"].status == RuleStatus.PASS  # 99 m / 3 s = 119 km/h vs 120


def test_r2_gps_jump_detected_when_both_endpoints_known():
    jump = TRACK_CITY.model_copy(update={"other_endpoint_lat": 24.144648, "other_endpoint_lon": 54.180461})
    r2 = rules_by_id(run_rules(EVENTS[:1], {0: ("c", jump)}, None, {})[0])["R2"]
    assert r2.status == RuleStatus.FAIL  # ~970 m in 3 s


def test_r2_na_with_single_point(results):
    assert rules_by_id(results[0])["R2"].status == RuleStatus.NA


def test_r3_short_events_flagged(results):
    assert all(rules_by_id(r)["R3"].status == RuleStatus.FLAG for r in results.values())


def test_r4_exceeds_zone_limit(results):
    assert rules_by_id(results[0])["R4"].status == RuleStatus.PASS


def test_r4_fails_when_under_limit():
    slow = [ev("18:27:29", "18:27:32", 75)]
    r4 = rules_by_id(run_rules(slow, {0: ("c", TRACK_CITY)}, None, {})[0])["R4"]
    assert r4.status == RuleStatus.FAIL


def test_r5_off_road_flagged():
    roads = {0: {"ok": True, "distance_m": 180.0, "highway": "residential", "name": "Test Street"}}
    r5 = rules_by_id(run_rules(EVENTS[:1], {0: ("c", TRACK_CITY)}, None, roads)[0])["R5"]
    assert r5.status == RuleStatus.FLAG


def test_r5_zone_stricter_than_road():
    roads = {0: {"ok": True, "distance_m": 5.0, "highway": "trunk", "ref": "E13", "maxspeed": "120"}}
    r5 = rules_by_id(run_rules(EVENTS[1:], {0: ("d", TRACK_DESERT)}, None, roads)[0])["R5"]
    assert r5.status == RuleStatus.FLAG


def test_r6_odometer_between_events(results):
    r6 = rules_by_id(results[1])["R6"]
    assert r6.status == RuleStatus.PASS  # 63.4 km in 74 min ~ 51 km/h
    assert rules_by_id(results[0])["R6"].status == RuleStatus.NA


def test_r7_counts_match_rag(results):
    assert rules_by_id(results[0])["R7"].status == RuleStatus.PASS


def test_r7_mismatch_flagged():
    rag = RagSummary(drivers=[RagDriverRow(driver=DRIVER, reckless=3)])
    r7 = rules_by_id(run_rules(EVENTS, {}, rag, {})[0])["R7"]
    assert r7.status == RuleStatus.FLAG
