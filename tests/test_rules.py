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
    popup_odometer_km=100000.000, zone_name="BT-Test-City", zone_speed_limit_kph=80,
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


def test_r3_reckless_has_no_minimum_duration(results):
    # ADNOC HRT-2026-01: reckless threshold time is >= 0 s, so 3 s events are valid by duration
    assert all(rules_by_id(r)["R3"].status == RuleStatus.PASS for r in results.values())


def test_r3_over_speed_needs_30_seconds():
    over = EVENTS[0].model_copy(update={"event": "Adnoc-over-speed"})
    assert rules_by_id(run_rules([over], {}, None, {})[0])["R3"].status == RuleStatus.FAIL
    long = over.model_copy(update={"duration_seconds": 45})
    assert rules_by_id(run_rules([long], {}, None, {})[0])["R3"].status == RuleStatus.PASS


def test_r4_reckless_needs_limit_plus_20():
    under = [ev("18:27:29", "18:27:32", 95)]
    assert rules_by_id(run_rules(under, {0: ("c", TRACK_CITY)}, None, {})[0])["R4"].status == RuleStatus.FAIL


def test_r7_shows_rag_impact(results):
    detail = rules_by_id(results[0])["R7"].detail
    assert "= RED" in detail and "makes it AMBER" in detail


def test_r8_off_road_zone_but_on_black_top_road():
    roads = {0: {"ok": True, "distance_m": 6.0, "highway": "trunk", "ref": "E13", "maxspeed": "120"}}
    r8 = rules_by_id(run_rules(EVENTS[1:], {0: ("d", TRACK_DESERT)}, None, roads)[0])["R8"]
    assert r8.status == RuleStatus.FLAG and "would NOT be reckless" in r8.detail


def test_r8_heavy_vehicle_zone_above_policy():
    fast_zone = TRACK_CITY.model_copy(update={"zone_speed_limit_kph": 100})
    r8 = rules_by_id(run_rules(EVENTS[:1], {0: ("c", fast_zone)}, None, {}, vehicle_class="heavy")[0])["R8"]
    assert r8.status == RuleStatus.FLAG


def test_r4_exceeds_zone_limit(results):
    assert rules_by_id(results[0])["R4"].status == RuleStatus.PASS


def test_r4_fails_when_under_limit():
    slow = [ev("18:27:29", "18:27:32", 75)]  # below even the 80 km/h zone limit
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
