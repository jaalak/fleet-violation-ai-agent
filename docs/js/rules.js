// Deterministic checks R1-R7 (port of checker/rules.py). The agent receives these; it never recomputes them.

import { haversineM, impliedSpeedKph } from "./geo.js";
import { eventStart, parseTs } from "./util.js";

export const CONFIG = {
  speed_consistency_tolerance_kph: 15, // R1
  max_plausible_speed_kph: 200,        // R1, R2
  min_violation_duration_s: 10,        // R3
  road_search_radius_m: 40,            // R5
  max_plausible_avg_speed_kph: 160,    // R6
  match_tolerance_s: 5,                // screenshot <-> violation matching
};

export const PASS = "PASS", FLAG = "FLAG", FAIL = "FAIL", NA = "N/A";
const res = (rule, name, status, detail) => ({ rule, name, status, detail });
const r0 = (x) => Math.round(x);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (s) => {
  const m = s == null ? null : String(s).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const has = (v) => v !== null && v !== undefined;

export function violationId(ev) {
  return `${ev.date} ${ev.start_time} | ${String(ev.driver).split(" - ")[0]}`;
}

/** events[i] -> {name, tracking} by closest timestamp within tolerance. */
export function matchTracking(events, trackings) {
  const used = new Set();
  const out = new Map();
  events.forEach((ev, i) => {
    const start = eventStart(ev);
    let best = null, bestDt = null;
    trackings.forEach((tr, j) => {
      if (used.has(j)) return;
      for (const ts of [tr.tracking.popup_timestamp, tr.tracking.trip_start]) {
        const t = parseTs(ts);
        if (t === null || start === null) continue;
        const dt = Math.abs(t - start) / 1000;
        if (dt <= CONFIG.match_tolerance_s && (bestDt === null || dt < bestDt)) { best = j; bestDt = dt; }
      }
    });
    if (best !== null) { used.add(best); out.set(i, trackings[best]); }
  });
  return out;
}

export function r1SpeedConsistency(ev, tr) {
  const name = "Speed vs. trip distance";
  if (!tr || !has(tr.trip_distance_km)) return res("R1", name, NA, "No trip distance available.");
  const secs = tr.trip_duration_seconds || ev.duration_seconds;
  const v = impliedSpeedKph(tr.trip_distance_km * 1000, secs);
  if (v === null) return res("R1", name, NA, "Trip duration is zero.");
  const diff = Math.abs(v - ev.speed_kph);
  const detail = `${tr.trip_distance_km.toFixed(3)} km in ${secs} s = ${r0(v)} km/h; reported ${r0(ev.speed_kph)} km/h (diff ${r0(diff)}).`;
  if (v > CONFIG.max_plausible_speed_kph) return res("R1", name, FAIL, detail + " Physically impossible.");
  if (diff > CONFIG.speed_consistency_tolerance_kph)
    return res("R1", name, FLAG, detail + " Odometer distance does not support the reported speed.");
  return res("R1", name, PASS, detail + " Odometer distance is consistent with the reported speed.");
}

export function r2GpsJump(ev, tr) {
  const name = "GPS jump (point-to-point speed)";
  if (!tr || ![tr.popup_lat, tr.popup_lon, tr.other_endpoint_lat, tr.other_endpoint_lon].every(has))
    return res("R2", name, NA, "Only one coordinate on screen - the agent estimates the trace length visually.");
  const secs = tr.trip_duration_seconds || ev.duration_seconds;
  const d = haversineM(tr.popup_lat, tr.popup_lon, tr.other_endpoint_lat, tr.other_endpoint_lon);
  const v = impliedSpeedKph(d, secs) || 0;
  const detail = `GPS points ${r0(d)} m apart in ${secs} s = ${r0(v)} km/h.`;
  if (v > CONFIG.max_plausible_speed_kph) return res("R2", name, FAIL, detail + " Impossible -> GPS jump.");
  return res("R2", name, PASS, detail);
}

export function r3Duration(ev) {
  const name = "Sustained duration";
  const m = CONFIG.min_violation_duration_s;
  if (ev.duration_seconds < m)
    return res("R3", name, FLAG, `Lasted only ${ev.duration_seconds} s (< ${m} s) - could be a single-sample spike.`);
  return res("R3", name, PASS, `Sustained for ${ev.duration_seconds} s.`);
}

export function r4ZoneLimit(ev, tr) {
  const name = "Speed vs. zone limit";
  if (!tr || !has(tr.zone_speed_limit_kph)) return res("R4", name, NA, "Zone speed limit not visible.");
  const lim = tr.zone_speed_limit_kph;
  const zone = tr.zone_name || "unknown zone";
  if (ev.speed_kph <= lim)
    return res("R4", name, FAIL, `${r0(ev.speed_kph)} km/h does not exceed the ${r0(lim)} km/h limit of ${zone}.`);
  return res("R4", name, PASS, `${r0(ev.speed_kph)} km/h exceeds the ${r0(lim)} km/h limit of '${zone}' by ` +
    `${r0(ev.speed_kph - lim)} km/h (if the zone assignment is correct).`);
}

function roadLabel(road) {
  const parts = [road.ref, road.name].filter(Boolean);
  return parts.length ? `${parts.join(" / ")} [${road.highway}]` : `unnamed ${road.highway} road`;
}

export function r5RoadCheck(tr, road, speedKph) {
  const name = "GPS point on a real road (OpenStreetMap)";
  if (!tr || !has(tr.popup_lat)) return res("R5", name, NA, "No coordinates.");
  if (!road || !road.ok) return res("R5", name, NA, (road && road.error) || "Road lookup not run.");
  const dist = road.distance_m;
  if (!has(dist) || dist > CONFIG.road_search_radius_m) {
    const where = !has(dist) ? "no mapped road nearby" : `nearest road ${r0(dist)} m away (${roadLabel(road)})`;
    return res("R5", name, FLAG, `(${tr.popup_lat}, ${tr.popup_lon}) is off-road: ${where}. ` +
      `${r0(speedKph)} km/h off-road suggests a bad GPS fix.`);
  }
  const maxspeed = num(road.maxspeed);
  const zl = tr.zone_speed_limit_kph;
  if (maxspeed && zl && maxspeed > zl && speedKph <= maxspeed)
    return res("R5", name, FLAG, `On ${roadLabel(road)} (${r0(dist)} m), OSM limit ${r0(maxspeed)} km/h; the platform ` +
      `applied ${r0(zl)} km/h. Check the geofence is correct for this road.`);
  return res("R5", name, PASS, `On ${roadLabel(road)} (${r0(dist)} m from the point)` +
    (maxspeed ? `, OSM limit ${r0(maxspeed)} km/h.` : "."));
}

/** pairs: [[event, tracking|null], ...] sorted by time. */
export function r6Odometer(pairs, idx) {
  const name = "Odometer plausibility";
  const [ev, tr] = pairs[idx];
  if (!tr || !has(tr.popup_odometer_km)) return res("R6", name, NA, "No odometer reading.");
  const prev = pairs.slice(0, idx).filter(([e, t]) => t && has(t.popup_odometer_km) && e.driver === ev.driver);
  if (!prev.length) return res("R6", name, NA, "No earlier event to compare with.");
  const [pe, pt] = prev[prev.length - 1];
  const dkm = tr.popup_odometer_km - pt.popup_odometer_km;
  const hours = (eventStart(ev) - eventStart(pe)) / 3.6e6;
  if (dkm < 0) return res("R6", name, FAIL, `Odometer went backwards (${dkm.toFixed(1)} km).`);
  if (hours <= 0) return res("R6", name, NA, "Events at the same time.");
  const avg = dkm / hours;
  const detail = `${dkm.toFixed(1)} km since ${pe.start_time} (${r0(hours * 60)} min) = avg ${r0(avg)} km/h.`;
  if (avg > CONFIG.max_plausible_avg_speed_kph) return res("R6", name, FLAG, detail + " Implausibly high.");
  return res("R6", name, PASS, detail);
}

export function r7CrossReport(ev, events, rag) {
  const name = "Matches Road Safety RAG report";
  if (!rag) return res("R7", name, NA, "No RAG report uploaded.");
  const key = norm(ev.driver);
  const row = (rag.drivers || []).find((r) => norm(r.driver) === key);
  if (!row) return res("R7", name, FLAG, "Driver not found in the RAG report.");
  const mine = events.filter((e) => norm(e.driver) === key);
  const nReck = mine.filter((e) => e.event.toLowerCase().includes("reckless")).length;
  const nOver = mine.filter((e) => e.event.toLowerCase().includes("over-speed") && !e.event.toLowerCase().includes("reckless")).length;
  const detail = `RAG: reckless=${row.reckless}, over-speed=${row.over_speed}; violation list: reckless=${nReck}, over-speed=${nOver}.`;
  if (row.reckless !== nReck || row.over_speed !== nOver) return res("R7", name, FLAG, detail + " Counts differ.");
  return res("R7", name, PASS, detail + " Counts agree.");
}

/** Returns Map(eventIndex -> RuleResult[]). matched: Map(i -> {name, tracking}); roads: Map(i -> road). */
export function runRules(events, matched, rag, roads) {
  const order = events.map((_, i) => i).sort((a, b) => eventStart(events[a]) - eventStart(events[b]));
  const pairs = order.map((i) => [events[i], matched.get(i)?.tracking || null]);
  const out = new Map();
  order.forEach((i, pos) => {
    const [ev, tr] = pairs[pos];
    out.set(i, [
      r1SpeedConsistency(ev, tr),
      r2GpsJump(ev, tr),
      r3Duration(ev),
      r4ZoneLimit(ev, tr),
      r5RoadCheck(tr, roads.get(i), ev.speed_kph),
      r6Odometer(pairs, pos),
      r7CrossReport(ev, events, rag),
    ]);
  });
  return out;
}
