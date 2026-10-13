// Browser end-to-end test: drives the real page in headless Edge/Chrome over the DevTools protocol, with the
// AI provider and OpenStreetMap replaced by scripted fake responses (no keys, no network).
//
//   1. serve docs/:   python -m http.server 8765 --bind 127.0.0.1   (from docs/)
//   2. run:           node tests_web/browser_e2e.mjs [path-to-browser]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER = process.argv[2] || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL_ = "http://127.0.0.1:8765/";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(BROWSER, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "fvc-"))}`, "--window-size=1366,900", "about:blank"], { stdio: "ignore" });

let ws, nextId = 1;
const pending = new Map(), exceptions = [], consoleErrors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") consoleErrors.push(msg.params.entry.text);
  };
}
const cdp = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result.result.value;
}
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(150); }
  throw new Error("timeout waiting for: " + expr);
}

// Installed in the page before the app runs: fake Claude API + fake Overpass.
const MOCK = `(() => {
  const real = window.fetch;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  const EVENTS = [
    { driver: "Test Driver - 050-0000000", date: "2026-10-11", event: "Adnoc-over-speed-reckless", start_time: "18:27:29", end_time: "18:27:32", duration_seconds: 3, speed_kph: 105, asset: "Toyota Fortuner-TEST-01", site: null },
    { driver: "Test Driver - 050-0000000", date: "2026-10-11", event: "Adnoc-over-speed-reckless", start_time: "19:41:13", end_time: "19:41:16", duration_seconds: 3, speed_kph: 120, asset: "Toyota Fortuner-TEST-01", site: null }];
  const track = (t, km, odo, zone, lat, lon) => ({ trip_start: "2026-10-11 " + t, trip_end: null, trip_distance_km: km, trip_duration_seconds: 3,
    popup_event: "Adnoc-over-speed-alarm - Started", popup_driver: "Test Driver", popup_timestamp: "11/10/2026 " + t, popup_speed_kph: 105,
    popup_odometer_km: odo, zone_name: zone, zone_speed_limit_kph: 80, popup_lat: lat, popup_lon: lon,
    other_endpoint_lat: null, other_endpoint_lon: null, visible_place_names: [] });
  let shot = 0;
  window.__calls = [];
  window.fetch = async (url, init = {}) => {
    url = String(url);
    window.__calls.push(url);
    if (url.includes("api.anthropic.com/v1/models")) return json({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] });
    if (url.includes("api.anthropic.com/v1/messages")) {
      const b = JSON.parse(init.body);
      if (!init.headers["anthropic-dangerous-direct-browser-access"]) return new Response("missing CORS opt-in", { status: 400 });
      const fmt = b.output_config?.format?.schema;
      if (fmt) {
        const props = Object.keys(fmt.properties);
        let out;
        if (props.includes("events")) out = { period_from: null, period_to: null, events: EVENTS, total_events: 2, max_speed_kph: 120 };
        else if (props.includes("drivers")) out = { period_from: null, period_to: null, drivers: [{ driver: "Test Driver - 050-0000000", distance_km: 2611, driving_duration: null, max_speed_kph: 141, over_speed: 0, reckless: 2, night_driving: 0, seatbelt: 0, harsh_braking: 0, harsh_acceleration: 0, phone_use: 0, smoking: 0, fatigue: 0, distraction: 0 }] };
        else out = shot++ === 0 ? track("18:27:29", 0.084, 100000, "BT-Test-City", 24.140588, 54.188889)
                                 : track("19:41:13", 0.099, 100063.43, "Test-Desert-Sand-Tracks", 24.191039, 53.987946);
        return json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }] });
      }
      // agent loop: zoom -> road -> verdict
      const turn = (b.messages.length - 1) / 2;
      const last = b.messages[b.messages.length - 1];
      if (turn >= 1) { // the previous tool result must be present
        const tr = last.content[0];
        if (tr.type !== "tool_result") return new Response("expected tool_result", { status: 400 });
        if (turn === 1 && tr.content[0].type !== "image") return new Response("zoom did not return an image", { status: 400 });
      }
      const calls = [
        { name: "zoom_screenshot", input: { x0: 600, y0: 80, x1: 1150, y1: 650 } },
        { name: "lookup_road", input: { lat: 24.14, lon: 54.18, search_radius_m: 300 } },
        { name: "submit_verdict", input: { verdict: turn === 2 && b.messages[0].content.some(c => c.type === "text" && c.text.includes("19:41:13")) ? "NEEDS_REVIEW" : "LIKELY_FALSE",
          confidence: 0.82, summary: "The trace is a straight line through buildings: a GPS jump.", reasons: ["~1 km covered in 3 s"],
          evidence: ["R3 FLAG: 3 s event", "<img src=x onerror=alert(1)> must render as text"], recommended_action: "Request the raw GPS log from the vendor." } }];
      const c = calls[Math.min(turn, 2)];
      return json({ stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "tu_" + turn, ...c }] });
    }
    if (url.includes("overpass")) return json({ elements: [{ type: "way", tags: { highway: "service" }, geometry: [{ lat: 24.1405, lon: 54.1888 }, { lat: 24.1407, lon: 54.1890 }] }] });
    return real(url, init);
  };
})();`;

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failed = true; };

try {
  await connect();
  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await cdp("Page.navigate", { url: URL_ });
  await waitFor(`document.getElementById("keyhint")?.textContent.includes("Get a key")`);
  check(true, "app loaded and initialised (module scripts allowed by CSP)");

  await evaluate(`document.getElementById("apikey").value = "sk-ant-api03-test"; document.getElementById("connect").click(); true`);
  await waitFor(`!document.getElementById("modelbox").hidden`);
  const firstModel = await evaluate(`document.getElementById("model").value`);
  check(firstModel === "claude-opus-5-5", `Connect lists models with the recommended one first (${firstModel})`);

  // upload: fake PDFs + generated screenshots
  await evaluate(`(async () => {
    const png = async () => { const c = new OffscreenCanvas(1600, 722); const x = c.getContext("2d"); x.fillStyle = "#d9b98c"; x.fillRect(0,0,1600,722);
      x.strokeStyle = "red"; x.lineWidth = 6; x.beginPath(); x.moveTo(640,100); x.lineTo(1130,635); x.stroke(); return c.convertToBlob({ type: "image/png" }); };
    const put = (id, files) => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); const el = document.getElementById(id); el.files = dt.files; el.dispatchEvent(new Event("change")); };
    put("f-viol", [new File(["%PDF-1.4 fake"], "violations.pdf", { type: "application/pdf" })]);
    put("f-rag", [new File(["%PDF-1.4 fake"], "rag.pdf", { type: "application/pdf" })]);
    put("f-shots", [new File([await png()], "city.png", { type: "image/png" }), new File([await png()], "desert.png", { type: "image/png" })]);
    return true; })()`);
  await waitFor(`document.querySelectorAll("#thumbs img").length === 2`);
  check(true, "screenshots show as thumbnails");
  await waitFor(`!document.getElementById("run").disabled`);

  await evaluate(`document.getElementById("run").click(); true`);
  await waitFor(`document.getElementById("logtitle").textContent !== "Working…"`, 30000);
  const title = await evaluate(`document.getElementById("logtitle").textContent`);
  const log = await evaluate(`[...document.querySelectorAll("#log li")].map(l => l.textContent).join("\\n")`);
  check(title === "Finished", `run finished (${title})`);
  if (title !== "Finished") console.log(log);
  const cases = await evaluate(`[...document.querySelectorAll(".case")].map(c => ({ pill: c.querySelector(".case-head .pill").textContent, err: c.querySelector(".error-box")?.textContent || null, rules: c.querySelectorAll(".rules tr").length, img: !!c.querySelector(".shot img") }))`);
  check(cases.length === 2, `two violation cards rendered`);
  check(cases.every((c) => !c.err), "no case errors " + JSON.stringify(cases.map((c) => c.err)));
  check(cases.every((c) => c.rules === 8), "each card shows the 8 checks");
  check(cases.every((c) => c.img), "each card shows its matched screenshot");
  check(cases.map((c) => c.pill).join(" | ").includes("Likely false"), "verdict pill rendered: " + cases.map((c) => c.pill).join(" | "));
  check(log.includes("zoom_screenshot") && log.includes("lookup_road") && log.includes("submit_verdict"), "agent tool calls shown in the log");
  check(await evaluate(`document.body.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;")`), "model text is escaped (no HTML injection)");
  check(await evaluate(`document.querySelector(".rules").textContent.includes("service")`), "OpenStreetMap result used in R5");

  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(tmpdir(), "fvc_e2e.png"), Buffer.from(shot.result.data, "base64"));
  console.log("screenshot:", join(tmpdir(), "fvc_e2e.png"));
  check(exceptions.length === 0, "no uncaught exceptions " + JSON.stringify(exceptions));
  const relevant = consoleErrors.filter((e) => !/favicon/i.test(e));
  check(relevant.length === 0, "no console errors " + JSON.stringify(relevant).slice(0, 400));
} catch (e) {
  console.log("FAIL ", e.message); failed = true;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  proc.kill();
}
process.exit(failed ? 1 : 0);
