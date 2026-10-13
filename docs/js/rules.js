// Deterministic checks R1-R8 (port of checker/rules.py). The agent receives these; it never recomputes them.

import { haversineM, impliedSpeedKph } from "./geo.js";
import { classifyEvent, inNightWindow, POLICY, ragBand, roadTypeFromOsm, roadTypeFromZone } from "./policy.js";
import { eventStart, parseTs } from "./util.js";

export const CONFIG = {
  speed_consistency_tolerance_kph: 15, // R1
  max_plausible_speed_kph: 200,        // R1, R2
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
  const name = "Duration vs. policy threshold";
  const type = classifyEvent(ev.event);
  if (!type) return res("R3", name, NA, `Event type '${ev.event}' is not covered by the policy table.`);
  const p = POLICY.events[type];
  if (ev.duration_seconds < p.min_duration_s)
    return res("R3", name, FAIL, `${p.label} needs >= ${p.min_duration_s} s (${POLICY.version}); this event lasted only ` +
      `${ev.duration_seconds} s, so it should not have been recorded.`);
  if (p.min_duration_s === 0)
    return res("R3", name, PASS, `${p.label} has a >= 0 s threshold (${POLICY.version}): a ${ev.duration_seconds} s event ` +
      "is valid by duration alone. Short duration is not a defence; the location is what matters.");
  return res("R3", name, PASS, `Lasted ${ev.duration_seconds} s (>= ${p.min_duration_s} s required for ${p.label}).`);
}

export function r4ZoneLimit(ev, tr) {
  const name = "Speed vs. policy trigger";
  const type = classifyEvent(ev.event);
  const speed = ev.speed_kph;
  if (type === "night_driving") {
    const inWin = inNightWindow(ev.start_time);
    const minV = POLICY.events.night_driving.min_speed_kph;
    if (inWin === false) return res("R4", name, FAIL, `${ev.start_time} is outside the 21:00-04:30 night window.`);
    if (speed < minV) return res("R4", name, FAIL, `${r0(speed)} km/h is below the ${minV} km/h night-driving threshold.`);
    return res("R4", name, PASS, `${ev.start_time} is inside 21:00-04:30 at ${r0(speed)} km/h.`);
  }
  if (type === "seatbelt") {
    const minV = POLICY.events.seatbelt.min_speed_kph;
    return speed >= minV ? res("R4", name, PASS, `${r0(speed)} km/h >= ${minV} km/h seatbelt threshold.`)
      : res("R4", name, FAIL, `${r0(speed)} km/h is below the ${minV} km/h seatbelt threshold.`);
  }
  if (!tr || !has(tr.zone_speed_limit_kph)) return res("R4", name, NA, "Zone speed limit not visible.");
  const lim = tr.zone_speed_limit_kph;
  const zone = tr.zone_name || "unknown zone";
  if (type === "reckless") {
    const over = POLICY.events.reckless.over_limit_kph;
    const trigger = lim + over;
    if (speed < trigger)
      return res("R4", name, FAIL, `Reckless needs >= ${r0(trigger)} km/h (${r0(lim)} limit + ${over}); ` +
        `reported ${r0(speed)} km/h, so this is not reckless even in '${zone}'.`);
    return res("R4", name, PASS, `${r0(speed)} km/h >= ${r0(trigger)} km/h (${r0(lim)} km/h limit of '${zone}' + ${over}): ` +
      "reckless by policy, if the zone assignment is correct.");
  }
  if (speed <= lim)
    return res("R4", name, FAIL, `${r0(speed)} km/h does not exceed the ${r0(lim)} km/h limit of '${zone}'.`);
  return res("R4", name, PASS, `${r0(speed)} km/h exceeds the ${r0(lim)} km/h limit of '${zone}' by ${r0(speed - lim)} km/h ` +
    "(if the zone assignment is correct).");
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
  const type = classifyEvent(ev.event);
  const count = type === "reckless" ? row.reckless : type === "over_speed" ? row.over_speed : null;
  let impact = "";
  if (count !== null && count > 0) {
    const now = ragBand(type, count), after = ragBand(type, count - 1);
    impact = ` ${POLICY.events[type].label}: ${count} this month = ${now}` +
      (after !== now ? `; overturning this event makes it ${after}.` : `; overturning this event alone keeps it ${after}.`);
  }
  return res("R7", name, PASS, detail + " Counts agree." + impact);
}

export function r8ZonePolicy(ev, tr, road, vehicleClass = "light") {
  const name = "Zone vs. ADNOC policy and the actual road";
  if (!tr || !has(tr.zone_speed_limit_kph)) return res("R8", name, NA, "Zone speed limit not visible.");
  const lim = tr.zone_speed_limit_kph;
  const zoneRoad = roadTypeFromZone(tr.zone_name);
  const caps = POLICY.max_speed[vehicleClass];
  const notes = [];
  let status = PASS;

  if (zoneRoad) {
    const cap = caps[zoneRoad];
    const label = zoneRoad === "black_top" ? "black top" : "off road";
    if (lim > cap) {
      status = FLAG;
      notes.push(`Zone limit ${r0(lim)} km/h is above the policy max of ${cap} km/h for ${label}: geofence misconfigured.`);
    } else {
      notes.push(`Zone '${tr.zone_name}' is ${label}; its ${r0(lim)} km/h limit is within the policy max (${cap} km/h).`);
    }
  } else {
    notes.push(`Road type of zone '${tr.zone_name || "?"}' is unclear from its name.`);
  }

  const onRoad = !!(road && road.ok && has(road.distance_m) && road.distance_m <= CONFIG.road_search_radius_m);
  const osmType = onRoad ? roadTypeFromOsm(road) : null;
  if (zoneRoad === "off_road" && osmType === "black_top") {
    status = FLAG;
    const maxspeed = num(road.maxspeed);
    let outcome = "";
    if (maxspeed) {
      const eff = Math.min(maxspeed, POLICY.absolute_max_kph, caps.black_top);
      const reckless = classifyEvent(ev.event) === "reckless";
      const trig = reckless ? eff + POLICY.events.reckless.over_limit_kph : eff;
      outcome = ` Against that road's ${r0(eff)} km/h limit, ${r0(ev.speed_kph)} km/h would ` +
        `${ev.speed_kph >= trig ? "still" : "NOT"} be ${reckless ? "reckless" : "over the limit"}.`;
    }
    notes.push(`But the GPS point is on ${roadLabel(road)}, a black-top road: the off-road limit may have been applied wrongly.${outcome}`);
  } else if (zoneRoad === "black_top" && road && road.ok && !onRoad) {
    status = FLAG;
    notes.push("But the GPS point is not on any mapped road, so the position itself is doubtful.");
  } else if (zoneRoad === "off_road" && road && road.ok && !onRoad) {
    notes.push("The GPS point is not on a mapped road. That fits off-road driving, but also fits a bad GPS fix.");
  }
  if (ev.speed_kph > POLICY.absolute_max_kph)
    notes.push(`${r0(ev.speed_kph)} km/h is above the ${POLICY.absolute_max_kph} km/h absolute maximum on any road.`);
  return res("R8", name, status, notes.join(" "));
}

/** Returns Map(eventIndex -> RuleResult[]). matched: Map(i -> {name, tracking}); roads: Map(i -> road). */
export function runRules(events, matched, rag, roads, opts = {}) {
  const vehicleClass = opts.vehicleClass || "light";
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
      r8ZonePolicy(ev, tr, roads.get(i), vehicleClass),
    ]);
  });
  return out;
}
