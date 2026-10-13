// ADNOC IVMS & AFDD System Configuration, version HRT-2026-01 (Group High Risk Transport).
// The thresholds the platform is configured with; violations are checked against these.

export const POLICY = {
  version: "HRT-2026-01",

  // Max speed by vehicle class and road type (km/h). On black top the posted / geofenced limit applies,
  // and no road may exceed absolute_max_kph. Internal roads are set by risk assessment.
  max_speed: {
    light:     { black_top: 140, off_road: 80 },
    bus_small: { black_top: 100, off_road: 60 }, // buses with 22 seats or fewer
    heavy:     { black_top: 80,  off_road: 60 }, // buses with 23+ seats and all other heavy vehicles
  },
  absolute_max_kph: 140,

  events: {
    over_speed:    { label: "Over speed", min_duration_s: 30,
                     rule: "Above the road speed limit continuously for 30 s" },
    reckless:      { label: "Reckless", min_duration_s: 0, over_limit_kph: 20,
                     rule: "Speed ≥ configured road limit + 20 km/h, threshold time ≥ 0 s" },
    seatbelt:      { label: "Seatbelt", min_duration_s: 10, min_speed_kph: 10,
                     rule: "Seatbelt unbuckled ≥ 10 s at ≥ 10 km/h" },
    night_driving: { label: "Night driving", min_duration_s: 0, min_speed_kph: 10, window: ["21:00", "04:30"],
                     rule: "Any driving between 21:00 and 04:30 at ≥ 10 km/h" },
  },

  // RAG bands per driver per month: green when 0, amber up to amber_max, red above.
  rag: {
    over_speed:    { amber_max: 3 },
    reckless:      { amber_max: 1 },
    night_driving: { amber_max: 1 },
    seatbelt:      { amber_max: 0 }, // any seatbelt violation is red
  },
};

export const VEHICLE_CLASSES = {
  light: "Light vehicle",
  bus_small: "Bus, 22 seats or fewer",
  heavy: "Heavy vehicle / bus 23+ seats",
};

/** Map a platform event name (e.g. "Adnoc-over-speed-reckless") to a policy event type. */
export function classifyEvent(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("reckless")) return "reckless";
  if (/over.?speed/.test(s)) return "over_speed";
  if (/seat.?belt/.test(s)) return "seatbelt";
  if (s.includes("night")) return "night_driving";
  return null;
}

/** Road type implied by the platform's zone name ("BT-City-..." = black top, desert/sand tracks = off road). */
export function roadTypeFromZone(zone) {
  const s = String(zone || "");
  if (/(^|[^a-z])bt([^a-z]|$)|black\s*top|highway|motorway/i.test(s)) return "black_top";
  if (/desert|sand|off.?road|track|dune|gatch|graded/i.test(s)) return "off_road";
  return null;
}

const PAVED = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
  "service", "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
const UNPAVED_SURFACE = /unpaved|sand|dirt|gravel|ground|earth|compacted|fine_gravel|mud/;

/** Road type of an OpenStreetMap road (highway + surface tags). */
export function roadTypeFromOsm(road) {
  if (!road || !road.highway) return null;
  if (road.surface && UNPAVED_SURFACE.test(road.surface)) return "off_road";
  if (road.highway === "track" || road.highway === "path") return "off_road";
  return PAVED.has(road.highway) ? "black_top" : null;
}

/** "GREEN" | "AMBER" | "RED" for a monthly count of one event type. */
export function ragBand(type, count) {
  const band = POLICY.rag[type];
  if (!band) return null;
  if (count === 0) return "GREEN";
  return count <= band.amber_max ? "AMBER" : "RED";
}

/** True if "HH:MM:SS" falls inside the night-driving window (which wraps past midnight). */
export function inNightWindow(time) {
  const m = String(time || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mins = +m[1] * 60 + +m[2];
  const [a, b] = POLICY.events.night_driving.window.map((t) => { const [h, mm] = t.split(":"); return +h * 60 + +mm; });
  return mins >= a || mins < b;
}

/** Policy text for the agent's prompt. */
export function policySummary(vehicleClass) {
  const ms = POLICY.max_speed[vehicleClass];
  return [
    `ADNOC IVMS policy ${POLICY.version}. Vehicle class: ${VEHICLE_CLASSES[vehicleClass]}.`,
    `- Max speed for this class: black top ${ms.black_top} km/h (posted / geofenced limit applies; never above ${POLICY.absolute_max_kph} km/h on any road), off road ${ms.off_road} km/h.`,
    ...Object.values(POLICY.events).map((e) => `- ${e.label}: ${e.rule}.`),
    `- RAG per month: Over speed amber ≤3, red >3; Reckless amber ≤1, red >1; Night driving amber ≤1, red >1; Seatbelt red >0.`,
  ].join("\n");
}
