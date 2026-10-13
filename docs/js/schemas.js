// JSON schemas for extraction and tool arguments.
// Written in the strict style all three providers accept: every property required, nulls via anyOf,
// no additional properties.

const nul = (type, description) => ({ anyOf: [{ type }, { type: "null" }], ...(description && { description }) });
const t = (type, description) => ({ type, ...(description && { description }) });
export const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items, description) => ({ type: "array", items, ...(description && { description }) });

const VIOLATION_EVENT = obj({
  driver: t("string", "Driver name and phone exactly as printed"),
  date: t("string", "Event date as YYYY-MM-DD"),
  event: t("string", "Event type, e.g. Adnoc-over-speed-reckless"),
  start_time: t("string", "'From' time as HH:MM:SS"),
  end_time: t("string", "'To' time as HH:MM:SS"),
  duration_seconds: t("integer"),
  speed_kph: t("number"),
  asset: t("string", "Vehicle / asset name"),
  site: nul("string"),
});

export const VIOLATION_REPORT = obj({
  period_from: nul("string"),
  period_to: nul("string"),
  events: arr(VIOLATION_EVENT),
  total_events: nul("integer"),
  max_speed_kph: nul("number"),
});

const count = t("integer");
export const RAG_SUMMARY = obj({
  period_from: nul("string"),
  period_to: nul("string"),
  drivers: arr(obj({
    driver: t("string"),
    distance_km: nul("number"),
    driving_duration: nul("string"),
    max_speed_kph: nul("number"),
    over_speed: count, reckless: count, night_driving: count, seatbelt: count,
    harsh_braking: count, harsh_acceleration: count, phone_use: count, smoking: count,
    fatigue: count, distraction: count,
  })),
});

export const TRACKING_EVIDENCE = obj({
  trip_start: nul("string", "Trip 'From' as YYYY-MM-DD HH:MM:SS"),
  trip_end: nul("string", "Trip 'To' as YYYY-MM-DD HH:MM:SS"),
  trip_distance_km: nul("number"),
  trip_duration_seconds: nul("integer"),
  popup_event: nul("string", "Popup title, e.g. Adnoc-over-speed-alarm - Started"),
  popup_driver: nul("string"),
  popup_timestamp: nul("string", "Popup date/time as YYYY-MM-DD HH:MM:SS"),
  popup_speed_kph: nul("number"),
  popup_odometer_km: nul("number"),
  zone_name: nul("string", "Location/zone text after the speed limit"),
  zone_speed_limit_kph: nul("number", "Speed limit in the location text, e.g. 80"),
  popup_lat: nul("number"),
  popup_lon: nul("number"),
  other_endpoint_lat: nul("number", "Latitude of the OTHER end of the trace, only if printed on screen for that point"),
  other_endpoint_lon: nul("number"),
  visible_place_names: arr(t("string"), "Road / place labels visible on the map"),
});

// ----- agent tools -----
export const ZOOM_ARGS = obj({
  x0: t("integer", "Left edge in original-image pixels"),
  y0: t("integer", "Top edge in pixels"),
  x1: t("integer", "Right edge in pixels"),
  y1: t("integer", "Bottom edge in pixels"),
});
export const HAVERSINE_ARGS = obj({
  lat1: t("number"), lon1: t("number"), lat2: t("number"), lon2: t("number"),
  seconds: t("number", "Time between the two fixes"),
});
export const ROAD_ARGS = obj({
  lat: t("number"), lon: t("number"),
  search_radius_m: t("integer", "Search radius in metres, 50-1000 (use 300 if unsure)"),
});
export const VERDICT_ARGS = obj({
  verdict: { type: "string", enum: ["VALID", "LIKELY_FALSE", "NEEDS_REVIEW"] },
  confidence: t("number", "0.0 to 1.0"),
  summary: t("string", "One or two sentences a fleet manager can read at a glance"),
  reasons: arr(t("string"), "Key reasons, most important first"),
  evidence: arr(t("string"), "Concrete observations with numbers (rule IDs, distances, speeds)"),
  recommended_action: t("string", "What the fleet / HSE team should do next"),
});
