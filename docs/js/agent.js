// The reviewing agent (port of checker/agent.py): the selected LLM inspects one violation with tools
// and submits a verdict.

import { haversineM, impliedSpeedKph, nearestRoad } from "./geo.js";
import { policySummary } from "./policy.js";
import { HAVERSINE_ARGS, ROAD_ARGS, VERDICT_ARGS, ZOOM_ARGS } from "./schemas.js";

export const SYSTEM_PROMPT = `You are a fleet road-safety analyst at a UAE transport company. Telematics (IVMS) units raise speeding \
violations automatically, and drivers are penalised for them. Your job is to decide, for ONE violation, \
whether it is genuine or a false positive, so that drivers are not penalised for device errors and real \
offences are not dismissed.

You receive: the violation row, facts read from the Historical Tracking screenshot (if any), the \
screenshot itself, the ADNOC IVMS policy the platform is configured with, and the results of deterministic \
checks R1-R8. The numbers in the checks are computed \
by code - trust them and do not recompute them by hand. You can call tools to zoom into the screenshot, \
compute point-to-point speeds and look up roads in OpenStreetMap.

Common false-positive signatures:
- GPS jump: the trace between two consecutive fixes a few seconds apart is a long, perfectly straight \
line, often cutting through buildings, blocks or open desert instead of following a road. If the line \
length divided by the duration is far above any possible vehicle speed, the position (and any zone-based \
speed limit applied from it) is wrong.
- Wrong zone / geofence: the vehicle is really on a highway with a higher limit, but a bad fix put it in a \
low-limit zone (city, camp, sand track), so a legal speed was judged against the wrong limit.
- Duration is NOT a defence for Reckless: the policy threshold time is >= 0 s, so a 3-second Reckless \
event is valid by duration. Over speed, however, needs 30 s continuous above the limit; a shorter \
Over speed event should not have been recorded.

Signals that support a genuine violation: the trace follows a road; the odometer distance over the event \
matches the reported speed (R1 PASS) AND the position is plausible; the speed clearly exceeds the limit of \
the road the vehicle is actually on (Reckless = limit + 20 km/h or more).

For Reckless and Over speed the decisive question is usually: was the speed limit applied (from the \
geofenced zone) the correct one for where the vehicle really was? Use R5/R8, the trace and lookup_road. \
If the vehicle was really on a black-top road with a higher posted limit, re-judge the speed against \
that limit using the policy.

Note: R1 PASS only shows the speed reading is internally consistent - it does NOT prove the location (and \
hence the applicable limit) is right. Weigh location evidence separately.

How to estimate a trace's length visually: use map features of known size (UAE residential villa plots are \
roughly 25-40 m wide, typical city blocks 100-200 m, highway carriageways 20-40 m), or the coordinate \
readout, and say how you estimated it. Zoom in before judging whether a line follows a road.

Verdicts:
- VALID: evidence supports that the driver really exceeded the applicable limit.
- LIKELY_FALSE: strong evidence of a device / GPS / zoning error.
- NEEDS_REVIEW: mixed or insufficient evidence - say exactly what a human should check (e.g. pull the raw \
GPS log, check the vehicle's speed 30 s before and after, verify the geofence boundary).

Finish by calling submit_verdict exactly once. Reasons must cite concrete evidence (times, speeds, \
distances, rule IDs). Be fair to both the driver and the company.`;

/**
 * @param llm      provider from llm.js
 * @param c        case {id, event, rules, tracking, screenshot: {b64, mime, width, height} | null}
 * @param cropper  async (screenshot, {x0,y0,x1,y1}) -> {b64, mime}   (canvas in the browser)
 */
export async function reviewViolation(llm, c, rag, cropper, onProgress, roadLookup = nearestRoad, vehicleClass = "light") {
  let result = null;
  const tools = [
    {
      name: "zoom_screenshot", schema: ZOOM_ARGS,
      description: "Crop the tracking screenshot to a box (original pixel coordinates) and return it enlarged. " +
        "Use it to see whether the trace follows a road and to read labels.",
      handler: async (a) => {
        if (!c.screenshot) return "No screenshot available for this violation.";
        const img = await cropper(c.screenshot, a);
        return [{ type: "image", ...img }];
      },
    },
    {
      name: "haversine_speed", schema: HAVERSINE_ARGS,
      description: "Great-circle distance between two coordinates and the speed needed to cover it in the given seconds.",
      handler: async (a) => {
        const d = haversineM(a.lat1, a.lon1, a.lat2, a.lon2);
        const v = impliedSpeedKph(d, a.seconds);
        return JSON.stringify({ distance_m: Math.round(d * 10) / 10, implied_speed_kph: v === null ? null : Math.round(v * 10) / 10 });
      },
    },
    {
      name: "lookup_road", schema: ROAD_ARGS,
      description: "Nearest OpenStreetMap roads to a coordinate: name, ref, type, posted maxspeed and distance in metres.",
      handler: async (a) => JSON.stringify(await roadLookup(a.lat, a.lon, Math.max(50, Math.min(1000, a.search_radius_m | 0)))),
    },
    {
      name: "submit_verdict", schema: VERDICT_ARGS,
      description: "Submit the final verdict for this violation. Call exactly once, at the end.",
      handler: async (a) => { result = a; return "Verdict recorded."; },
    },
  ];

  const rulesTxt = c.rules.map((r) => `- ${r.rule} ${r.name}: ${r.status} - ${r.detail}`).join("\n");
  const parts = [];
  if (c.screenshot) {
    parts.push({ type: "image", b64: c.screenshot.b64, mime: c.screenshot.mime },
      { type: "text", text: `Historical Tracking screenshot above (${c.screenshot.width}x${c.screenshot.height} px).` });
  }
  parts.push({ type: "text", text:
    `Violation ID: ${c.id}\n\nViolation row:\n${JSON.stringify(c.event, null, 1)}\n\n` +
    `Tracking facts read from the screenshot:\n${c.tracking ? JSON.stringify(c.tracking, null, 1) : "no matching screenshot"}\n\n` +
    `${policySummary(vehicleClass)}\n\n` +
    `Deterministic checks:\n${rulesTxt}\n\n` +
    `Road Safety RAG report:\n${rag ? JSON.stringify(rag, null, 1) : "not provided"}\n\n` +
    "Investigate with the tools, then call submit_verdict." });

  const lastText = await llm.runTools(SYSTEM_PROMPT, parts, tools, () => result !== null,
    (name, args) => onProgress?.(`${name}(${JSON.stringify(args).slice(0, 120)})`));
  if (!result) throw new Error("The model finished without submitting a verdict. Last message: " + lastText.slice(0, 500));
  return { ...result, confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)) };
}
