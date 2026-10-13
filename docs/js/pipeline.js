// End-to-end: documents in -> one case per violation out (port of checker/pipeline.py).

import { reviewViolation } from "./agent.js";
import { nearestRoad } from "./geo.js";
import { matchTracking, runRules, violationId } from "./rules.js";
import { RAG_SUMMARY, TRACKING_EVIDENCE, VIOLATION_REPORT } from "./schemas.js";
import { mapLimit } from "./util.js";

export const EXTRACT_SYSTEM =
  "You transcribe fleet-telematics reports and map screenshots into JSON. " +
  "Copy values exactly as shown. Use null for anything not visible - never guess. " +
  "Dates as YYYY-MM-DD, times as HH:MM:SS (screens use DD/MM/YYYY).";

const TRACKING_PROMPT =
  "This is a Historical Tracking screenshot. Extract the selected trip row (From, To, Distance, Duration) " +
  "and every field of the event popup. The popup 'Location' looks like 'Speed 80 km/hr#<zone name> - (lat, lon)': " +
  "put 80 in zone_speed_limit_kph, the zone name in zone_name and the coordinates in popup_lat/popup_lon. " +
  "Only fill other_endpoint_lat/lon if a second point's coordinates are explicitly labelled on screen " +
  "(the cursor readout in the map corner is NOT a trace endpoint).";

/**
 * @param input {violationPdf: {b64,name}, ragPdf?: {b64,name}, shots: [{name, b64, mime, width, height}]}
 * @param opts  {progress(msg), useAgent, cropper, roadLookup, vehicleClass}
 */
export async function checkViolations(llm, input, opts = {}) {
  const progress = opts.progress || (() => {});
  const roadLookup = opts.roadLookup || nearestRoad;
  const pdf = (f) => ({ type: "pdf", b64: f.b64, name: f.name });

  progress(`Reading the documents with ${llm.label} (${llm.model})…`);
  const [report, rag, trackings] = await Promise.all([
    llm.parse(EXTRACT_SYSTEM, [pdf(input.violationPdf),
      { type: "text", text: "Extract every violation row from this Violation Details report." }], VIOLATION_REPORT, "violation_report"),
    input.ragPdf ? llm.parse(EXTRACT_SYSTEM, [pdf(input.ragPdf),
      { type: "text", text: "Extract the per-driver rows of this Road Safety RAG report." }], RAG_SUMMARY, "rag_summary") : null,
    mapLimit(input.shots || [], 4, async (s) => ({
      name: s.name,
      tracking: await llm.parse(EXTRACT_SYSTEM, [{ type: "image", b64: s.b64, mime: s.mime },
        { type: "text", text: TRACKING_PROMPT }], TRACKING_EVIDENCE, "tracking_evidence"),
    })),
  ]);
  const events = report.events || [];
  progress(`Found ${events.length} violation(s) and ${trackings.length} tracking screenshot(s).`);

  const matched = matchTracking(events, trackings);
  progress("Looking up roads in OpenStreetMap…");
  const roads = new Map();
  await Promise.all([...matched].map(async ([i, m]) => {
    const t = m.tracking;
    if (t.popup_lat != null && t.popup_lon != null) roads.set(i, await roadLookup(t.popup_lat, t.popup_lon));
  }));
  const vehicleClass = opts.vehicleClass || "light";
  const rules = runRules(events, matched, rag, roads, { vehicleClass });
  const shotsByName = Object.fromEntries((input.shots || []).map((s) => [s.name, s]));

  const cases = events.map((ev, i) => {
    const m = matched.get(i);
    return {
      id: violationId(ev), event: ev, tracking: m?.tracking || null, screenshotName: m?.name || null,
      screenshot: m ? shotsByName[m.name] : null, rules: rules.get(i), verdict: null, error: null,
    };
  });

  if (opts.useAgent !== false) {
    await mapLimit(cases, 3, async (c) => {
      progress(`Agent reviewing ${c.id}…`);
      try {
        c.verdict = await reviewViolation(llm, c, rag, opts.cropper, (m) => progress(`  [${c.id}] ${m}`), roadLookup, vehicleClass);
      } catch (e) {
        c.error = e.message || String(e);
      }
      progress(`Done: ${c.id}`);
    });
  }
  return { cases, rag };
}

export function toMarkdown(cases, modelLabel = "") {
  const lines = ["# Violation Check Report", ""];
  if (modelLabel) lines.push(`_Reviewed with ${modelLabel}_`, "");
  for (const c of cases) {
    const e = c.event;
    lines.push(`## ${c.id}`,
      `**Event:** ${e.event} | ${e.start_time}-${e.end_time} (${e.duration_seconds} s) | ${Math.round(e.speed_kph)} km/h | ${e.asset}`, "");
    if (c.verdict) {
      const v = c.verdict;
      lines.push(`**Verdict:** ${v.verdict} (confidence ${Math.round(v.confidence * 100)}%)`, "", v.summary, "",
        "**Reasons**", ...v.reasons.map((r) => `- ${r}`), "",
        "**Evidence**", ...v.evidence.map((x) => `- ${x}`), "",
        `**Recommended action:** ${v.recommended_action}`, "");
    } else if (c.error) {
      lines.push(`**Error:** ${c.error}`, "");
    }
    lines.push("| Rule | Check | Result | Detail |", "|---|---|---|---|",
      ...c.rules.map((r) => `| ${r.rule} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, "\\|")} |`), "");
  }
  return lines.join("\n");
}

/** JSON export without the (large) base64 screenshots. */
export function toJson(cases) {
  return JSON.stringify(cases.map(({ screenshot, ...rest }) => rest), null, 2);
}
