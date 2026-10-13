// UI wiring for the browser app. All model / report text is inserted with textContent (never innerHTML).

import { makeProvider, PROVIDERS } from "./llm.js";
import { checkViolations, toJson, toMarkdown } from "./pipeline.js";
import { bytesToBase64, sniffImageType } from "./util.js";
import "./theme.js";

const $ = (id) => document.getElementById(id);
const OTHER = "__other__";

/** Tiny element builder: h("div", {class: "x"}, "text", child, ...) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ------------------------------------------------------------ storage (never required)
const store = {
  get(k) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  set(k, v, persist) {
    try {
      sessionStorage.setItem(k, v);
      if (persist) localStorage.setItem(k, v); else localStorage.removeItem(k);
    } catch { /* storage blocked: key just isn't remembered */ }
  },
  del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { /* ignore */ } },
  persisted(k) { try { return localStorage.getItem(k) !== null; } catch { return false; } },
};
const keyName = (p) => `fvc-key-${p}`;

// ------------------------------------------------------------ state
const state = {
  connected: null,        // {provider, key, models}
  files: { viol: null, rag: null, shots: [] },
  running: false,
  loading: 0,             // files still being read
  results: null,
};

// ------------------------------------------------------------ provider panel
function refreshProviderUI() {
  const p = $("provider").value;
  const info = PROVIDERS[p];
  $("apikey").placeholder = info.keyHint;
  const hint = $("keyhint");
  hint.replaceChildren("Get a key at ", h("a", { href: info.keyUrl, target: "_blank", rel: "noopener" }, info.keySite), ".");
  $("apikey").value = store.get(keyName(p)) || "";
  $("remember").checked = store.persisted(keyName(p));
  setDisconnected();
}

function setDisconnected(msg = "", cls = "") {
  state.connected = null;
  $("modelbox").hidden = true;
  $("connstatus").className = `status ${cls}`;
  $("connstatus").textContent = msg;
  refreshRunButton();
}

async function connect() {
  const p = $("provider").value;
  const key = $("apikey").value.trim().replace(/^["']|["']$/g, "");
  if (!key) return setDisconnected("Paste an API key first.", "err");
  if (key.includes("…") || key.endsWith("...")) return setDisconnected("That looks like the placeholder; paste your real key.", "err");
  const btn = $("connect");
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    const models = await makeProvider(p, key).listModels();
    if (!models.length) throw new Error("No suitable models are available to this key.");
    if ($("remember").checked) store.set(keyName(p), key, true); else store.set(keyName(p), key, false);
    state.connected = { provider: p, key, models };
    const sel = $("model");
    sel.replaceChildren(...models.map((m, i) => h("option", { value: m }, i === 0 ? `${m}  (recommended)` : m)),
      h("option", { value: OTHER }, "Other (type a model id)…"));
    $("custombox").hidden = true;
    $("modelbox").hidden = false;
    $("connstatus").className = "status ok";
    $("connstatus").textContent = `Connected to ${PROVIDERS[p].label}: ${models.length} models available.`;
  } catch (e) {
    setDisconnected(e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
    refreshRunButton();
  }
}

function selectedModel() {
  if (!state.connected) return null;
  const v = $("model").value;
  return v === OTHER ? ($("custommodel").value.trim() || null) : v;
}

// ------------------------------------------------------------ files
async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

async function loadImage(file) {
  const bytes = await readFile(file);
  let mime = sniffImageType(bytes);
  let b64 = bytesToBase64(bytes);
  const bmp = await createImageBitmap(new Blob([bytes]));
  const { width, height } = bmp;
  if (!mime || mime === "image/gif") { // normalise to PNG
    const c = new OffscreenCanvas(width, height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    b64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    mime = "image/png";
  }
  bmp.close();
  return { name: file.name, b64, mime, width, height, url: URL.createObjectURL(file) };
}

async function setFiles(kind, fileList) {
  const files = [...fileList];
  if (!files.length) return;
  state.loading++;
  refreshRunButton();
  try {
    if (kind === "shots") {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      state.files.shots.forEach((s) => URL.revokeObjectURL(s.url));
      state.files.shots = await Promise.all(imgs.map(loadImage));
      $("drop-shots").querySelector(".filename").textContent = state.files.shots.map((s) => s.name).join(", ");
      $("drop-shots").classList.toggle("filled", state.files.shots.length > 0);
      $("thumbs").replaceChildren(...state.files.shots.map((s) => h("img", { src: s.url, alt: s.name, title: s.name })));
    } else {
      const f = files.find((x) => x.type === "application/pdf" || x.name.toLowerCase().endsWith(".pdf"));
      if (!f) return;
      state.files[kind] = { name: f.name, b64: bytesToBase64(await readFile(f)) };
      const drop = $(kind === "viol" ? "drop-viol" : "drop-rag");
      drop.querySelector(".filename").textContent = f.name;
      drop.classList.add("filled");
    }
  } catch (e) {
    log(`Could not read file: ${e.message}`, true);
  } finally {
    state.loading--;
  }
  refreshRunButton();
}

function wireDrop(dropId, inputId, kind) {
  const drop = $(dropId), input = $(inputId);
  input.addEventListener("change", () => setFiles(kind, input.files));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); setFiles(kind, e.dataTransfer.files); });
}

// ------------------------------------------------------------ run
function refreshRunButton() {
  const model = selectedModel();
  const ready = !!(model && state.files.viol && !state.running && !state.loading);
  $("run").disabled = !ready;
  $("runhint").textContent = state.running ? "Working… this can take a minute or two per violation."
    : state.loading ? "Reading files…"
    : !state.connected ? "Connect to an AI provider first."
    : !model ? "Choose a model."
    : !state.files.viol ? "Add the Violation Details PDF."
    : `Ready. Uses ${PROVIDERS[state.connected.provider].label} · ${model}.`;
}

function log(msg, isErr = false) {
  $("logpanel").hidden = false;
  const li = h("li", { class: isErr ? "err" : null }, msg);
  $("log").append(li);
  $("log").scrollTop = $("log").scrollHeight;
}

/** Crops a screenshot in the browser for the agent's zoom tool. */
async function cropper(shot, a) {
  const raw = Uint8Array.from(atob(shot.b64), (ch) => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([raw], { type: shot.mime }));
  const W = bmp.width, H = bmp.height;
  const cl = (v, m) => Math.max(0, Math.min(m, Math.round(v)));
  const [x0, x1] = [cl(a.x0, W), cl(a.x1, W)].sort((p, q) => p - q);
  const [y0, y1] = [cl(a.y0, H), cl(a.y1, H)].sort((p, q) => p - q);
  if (x1 - x0 < 10 || y1 - y0 < 10) throw new Error(`Crop box too small; image is ${W}x${H} px.`);
  const scale = Math.min(4, 1200 / Math.max(x1 - x0, y1 - y0));
  const s = Math.max(1, scale);
  const c = new OffscreenCanvas(Math.round((x1 - x0) * s), Math.round((y1 - y0) * s));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await c.convertToBlob({ type: "image/png" });
  return { b64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mime: "image/png" };
}

async function run() {
  const model = selectedModel();
  if (!model || !state.files.viol || state.running || state.loading) return;
  const { provider, key } = state.connected;
  const llm = makeProvider(provider, key, model);
  state.running = true;
  refreshRunButton();
  $("log").replaceChildren();
  $("logtitle").textContent = "Working…";
  $("spinner").classList.remove("done");
  $("results").replaceChildren();
  log(`Started with ${llm.label} · ${model}`);
  try {
    const { cases } = await checkViolations(llm, {
      violationPdf: state.files.viol, ragPdf: state.files.rag, shots: state.files.shots,
    }, { progress: (m) => log(m), useAgent: $("useagent").checked, cropper });
    state.results = { cases, label: `${llm.label} · ${model}` };
    renderResults();
    $("logtitle").textContent = "Finished";
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    log(e.message || String(e), true);
    $("logtitle").textContent = "Failed";
  } finally {
    state.running = false;
    $("spinner").classList.add("done");
    refreshRunButton();
  }
}

// ------------------------------------------------------------ results
const VERDICT_TEXT = { VALID: "✓ Valid", LIKELY_FALSE: "✕ Likely false", NEEDS_REVIEW: "! Needs review" };

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderResults() {
  const { cases, label } = state.results;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const counts = {};
  cases.forEach((c) => { const k = c.verdict?.verdict || (c.error ? "ERROR" : "NA"); counts[k] = (counts[k] || 0) + 1; });

  const mdBtn = h("button", { class: "btn", type: "button" }, "Download report (.md)");
  mdBtn.onclick = () => download(`violation_check_${stamp}.md`, toMarkdown(cases, label), "text/markdown");
  const jsonBtn = h("button", { class: "btn", type: "button" }, "Download data (.json)");
  jsonBtn.onclick = () => download(`violation_check_${stamp}.json`, toJson(cases), "application/json");

  const bar = h("div", { class: "summary-bar" },
    h("h2", { style: "margin:0" }, `Results · ${cases.length} violation${cases.length === 1 ? "" : "s"}`),
    ...Object.entries(counts).map(([k, n]) => h("span", { class: `pill ${k}` }, `${n} ${VERDICT_TEXT[k] || (k === "ERROR" ? "error" : "checks only")}`)),
    h("span", { class: "grow" }), mdBtn, jsonBtn);

  $("results").replaceChildren(bar, h("p", { class: "hint", style: "margin:0 0 14px" }, `Reviewed with ${label}`),
    ...cases.map(renderCase));
}

function renderCase(c) {
  const e = c.event, v = c.verdict;
  const kind = v ? v.verdict : c.error ? "ERROR" : "NA";
  const head = h("div", { class: "case-head" },
    h("span", { class: `pill ${kind}` }, v ? VERDICT_TEXT[v.verdict] : c.error ? "Error" : "Checks only"),
    h("span", { class: "title" }, c.id),
    h("span", { class: "meta" }, `${e.event} · ${e.start_time}–${e.end_time} (${e.duration_seconds} s) · ${Math.round(e.speed_kph)} km/h · ${e.asset}`));

  const left = h("div");
  if (v) {
    left.append(
      h("p", { class: "verdict-summary" }, v.summary),
      h("div", { class: "conf" }, "Confidence",
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${Math.round(v.confidence * 100)}%;display:block` })),
        `${Math.round(v.confidence * 100)}%`),
      h("h4", {}, "Reasons"), h("ul", {}, v.reasons.map((r) => h("li", {}, r))),
      h("h4", {}, "Evidence"), h("ul", {}, v.evidence.map((x) => h("li", {}, x))),
      h("div", { class: "action" }, h("strong", {}, "Recommended action: "), v.recommended_action));
  } else if (c.error) {
    left.append(h("div", { class: "error-box" }, c.error));
  }
  left.append(h("h4", {}, "Deterministic checks"),
    h("table", { class: "rules" }, h("tbody", {}, c.rules.map((r) => h("tr", {},
      h("td", {}, r.rule),
      h("td", {}, h("span", { class: `pill ${r.status === "N/A" ? "NA" : r.status}` }, r.status)),
      h("td", {}, h("strong", {}, r.name), h("br"), r.detail))))));

  const right = h("div", { class: "shot" });
  if (c.screenshot) {
    const img = h("img", { src: c.screenshot.url, alt: c.screenshotName, title: "Open full size" });
    img.onclick = () => window.open(c.screenshot.url, "_blank", "noopener");
    right.append(img);
  } else {
    right.append(h("p", { class: "none" }, "No matching tracking screenshot uploaded."));
  }
  if (c.tracking) {
    right.append(h("details", {}, h("summary", {}, "Data read from screenshot"),
      h("pre", {}, JSON.stringify(Object.fromEntries(Object.entries(c.tracking).filter(([, x]) => x !== null && !(Array.isArray(x) && !x.length))), null, 1))));
  }
  return h("article", { class: "case" }, head, h("div", { class: "case-body" }, left, right));
}

// ------------------------------------------------------------ init
$("provider").addEventListener("change", refreshProviderUI);
$("apikey").addEventListener("input", () => { if (state.connected) setDisconnected(); });
$("apikey").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("showkey").addEventListener("click", () => { const i = $("apikey"); i.type = i.type === "password" ? "text" : "password"; });
$("remember").addEventListener("change", () => {
  const p = $("provider").value;
  if (!$("remember").checked) store.del(keyName(p));
  else if (state.connected?.provider === p) store.set(keyName(p), state.connected.key, true);
});
$("connect").addEventListener("click", connect);
$("model").addEventListener("change", () => { $("custombox").hidden = $("model").value !== OTHER; refreshRunButton(); });
$("custommodel").addEventListener("input", refreshRunButton);
$("run").addEventListener("click", run);
wireDrop("drop-viol", "f-viol", "viol");
wireDrop("drop-rag", "f-rag", "rag");
wireDrop("drop-shots", "f-shots", "shots");
refreshProviderUI();
