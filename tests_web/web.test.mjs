// Tests for the browser app's logic (docs/js). Run: node --test tests_web
// Same fictional data as tests/test_rules.py.
import assert from "node:assert/strict";
import { test } from "node:test";

import { haversineM } from "../docs/js/geo.js";
import { checkViolations, toJson, toMarkdown } from "../docs/js/pipeline.js";
import { FAIL, FLAG, matchTracking, NA, PASS, runRules } from "../docs/js/rules.js";
import { RAG_SUMMARY, TRACKING_EVIDENCE, VERDICT_ARGS, VIOLATION_REPORT } from "../docs/js/schemas.js";
import { bytesToBase64, parseTs, pickLatest, sniffImageType } from "../docs/js/util.js";

const DRIVER = "Test Driver - 050-0000000";
const ev = (start, end, speed) => ({ driver: DRIVER, date: "2026-10-11", event: "Adnoc-over-speed-reckless",
  start_time: start, end_time: end, duration_seconds: 3, speed_kph: speed, asset: "Toyota Fortuner-TEST-01", site: null });
const EVENTS = [ev("18:27:29", "18:27:32", 105), ev("19:41:13", "19:41:16", 120)];
const TRACK_CITY = { trip_start: "2026-10-11 18:27:29", trip_end: "2026-10-11 18:27:32", trip_distance_km: 0.084,
  trip_duration_seconds: 3, popup_timestamp: "11/10/2026 18:27:29", popup_speed_kph: 105, popup_odometer_km: 100000.0,
  zone_name: "Test-City-Zone", zone_speed_limit_kph: 80, popup_lat: 24.140588, popup_lon: 54.188889,
  other_endpoint_lat: null, other_endpoint_lon: null };
const TRACK_DESERT = { ...TRACK_CITY, trip_start: "2026-10-11 19:41:13", trip_end: "2026-10-11 19:41:16",
  trip_distance_km: 0.099, popup_timestamp: "2026-10-11 19:41:13", popup_speed_kph: 119, popup_odometer_km: 100063.43,
  zone_name: "Test-Desert-Sand-Tracks", popup_lat: 24.191039, popup_lon: 53.987946 };
const RAG = { period_from: null, period_to: null, drivers: [{ driver: DRIVER, reckless: 2, over_speed: 0 }] };
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.rule, r]));

function sampleRules(roads = new Map()) {
  const matched = matchTracking(EVENTS, [{ name: "desert.jpg", tracking: TRACK_DESERT }, { name: "city.jpg", tracking: TRACK_CITY }]);
  assert.equal(matched.get(0).name, "city.jpg");
  assert.equal(matched.get(1).name, "desert.jpg");
  return runRules(EVENTS, matched, RAG, roads);
}

test("utils", () => {
  assert.equal(parseTs("11/10/2026 18:27:29"), parseTs("2026-10-11 18:27:29"));
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(bytesToBase64(new Uint8Array([104, 105])), "aGk=");
  assert.deepEqual(pickLatest(["gpt-4.1", "gpt-5.6", "gpt-5", "o3"], /^gpt-(\d+(?:\.\d+)?)$/).slice(0, 2), ["gpt-5.6", "gpt-5"]);
  assert.equal(pickLatest(["claude-opus-4-8", "claude-opus-5-5", "claude-haiku-5-5"], /claude-opus-(\d+(?:-\d+)?)/)[0], "claude-opus-5-5");
  assert.ok(Math.abs(haversineM(23, 53, 23.01, 53) - 1112) < 12);
});

test("rules match the Python version", () => {
  const r = sampleRules();
  assert.equal(byId(r.get(0)).R1.status, PASS);
  assert.equal(byId(r.get(1)).R1.status, PASS);
  assert.equal(byId(r.get(0)).R2.status, NA);
  assert.equal(byId(r.get(0)).R3.status, FLAG);
  assert.equal(byId(r.get(0)).R4.status, PASS);
  assert.equal(byId(r.get(0)).R6.status, NA);
  assert.equal(byId(r.get(1)).R6.status, PASS);
  assert.equal(byId(r.get(0)).R7.status, PASS);
});

test("R2 detects a GPS jump", () => {
  const jump = { ...TRACK_CITY, other_endpoint_lat: 24.144648, other_endpoint_lon: 54.180461 };
  const r = runRules(EVENTS.slice(0, 1), new Map([[0, { name: "c", tracking: jump }]]), null, new Map());
  assert.equal(byId(r.get(0)).R2.status, FAIL);
});

test("R4 fails under the limit; R5 flags off-road and stricter zone", () => {
  const slow = runRules([ev("18:27:29", "18:27:32", 75)], new Map([[0, { name: "c", tracking: TRACK_CITY }]]), null, new Map());
  assert.equal(byId(slow.get(0)).R4.status, FAIL);
  const off = runRules(EVENTS.slice(0, 1), new Map([[0, { name: "c", tracking: TRACK_CITY }]]), null,
    new Map([[0, { ok: true, distance_m: 180, highway: "residential", name: "Test Street" }]]));
  assert.equal(byId(off.get(0)).R5.status, FLAG);
  const zone = runRules(EVENTS.slice(1), new Map([[0, { name: "d", tracking: TRACK_DESERT }]]), null,
    new Map([[0, { ok: true, distance_m: 5, highway: "trunk", ref: "E13", maxspeed: "120" }]]));
  assert.equal(byId(zone.get(0)).R5.status, FLAG);
});

test("R7 flags mismatched counts", () => {
  const r = runRules(EVENTS, new Map(), { drivers: [{ driver: DRIVER, reckless: 3, over_speed: 0 }] }, new Map());
  assert.equal(byId(r.get(0)).R7.status, FLAG);
});

test("schemas are strict: every property required, no extras", () => {
  const walk = (s) => {
    if (s && typeof s === "object") {
      if (s.type === "object") {
        assert.equal(s.additionalProperties, false);
        assert.deepEqual(s.required, Object.keys(s.properties));
      }
      Object.values(s).forEach(walk);
    }
  };
  [VIOLATION_REPORT, RAG_SUMMARY, TRACKING_EVIDENCE, VERDICT_ARGS].forEach(walk);
});

test("full pipeline with a fake provider", async () => {
  const shots = [TRACK_CITY, TRACK_DESERT];
  const toolCalls = [];
  const fake = {
    label: "Fake", model: "fake-1",
    async parse(system, parts, schema) {
      if (schema === VIOLATION_REPORT) return { events: EVENTS, period_from: null, period_to: null, total_events: 2, max_speed_kph: 120 };
      if (schema === RAG_SUMMARY) return RAG;
      if (schema === TRACKING_EVIDENCE) return shots.shift();
      throw new Error("unexpected schema");
    },
    async runTools(system, parts, tools, stop, onTool) {
      assert.ok(parts.some((p) => p.type === "image"), "screenshot is sent to the agent");
      const by = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const [name, args] of [
        ["zoom_screenshot", { x0: 600, y0: 80, x1: 1150, y1: 650 }],
        ["lookup_road", { lat: 24.14, lon: 54.18, search_radius_m: 300 }],
        ["submit_verdict", { verdict: "LIKELY_FALSE", confidence: 1.7, summary: "GPS jump", reasons: ["~1 km in 3 s"],
          evidence: ["R3 FLAG"], recommended_action: "Request raw GPS log" }],
      ]) {
        onTool(name, args);
        toolCalls.push([name, await by[name].handler(args)]);
        if (stop()) return "done";
      }
      return "";
    },
  };
  const shot = (name) => ({ name, b64: "AAAA", mime: "image/jpeg", width: 1600, height: 722 });
  const msgs = [];
  const { cases } = await checkViolations(fake, {
    violationPdf: { b64: "JVBERg==", name: "v.pdf" }, ragPdf: { b64: "JVBERg==", name: "r.pdf" },
    shots: [shot("a.jpg"), shot("b.jpg")],
  }, {
    progress: (m) => msgs.push(m),
    cropper: async () => ({ b64: "iVBORw0KGgo=", mime: "image/png" }),
    roadLookup: async () => ({ ok: true, distance_m: 12, highway: "service" }),
  });
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map((c) => c.screenshotName), ["a.jpg", "b.jpg"]);
  for (const c of cases) {
    assert.equal(c.error, null);
    assert.equal(c.verdict.verdict, "LIKELY_FALSE");
    assert.equal(c.verdict.confidence, 1); // clamped
    assert.equal(byId(c.rules).R5.status, PASS);
  }
  assert.equal(toolCalls[0][1][0].type, "image");
  assert.ok(msgs.some((m) => m.includes("submit_verdict")));
  const md = toMarkdown(cases, "Fake · fake-1");
  assert.ok(md.includes("LIKELY_FALSE") && md.includes("Fake · fake-1"));
  assert.ok(!toJson(cases).includes("AAAA"), "JSON export omits screenshot data");
});
