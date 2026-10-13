"""Streamlit UI: upload the reports + tracking screenshots, get a verdict per violation."""

from __future__ import annotations

import queue
import threading
import time

import streamlit as st

from checker.llm import PROVIDERS, Credentials, make_provider
from checker.models import RuleStatus, VerdictLabel
from checker.policy import VEHICLE_CLASSES
from checker.pipeline import check_violations, to_markdown

st.set_page_config(page_title="Violation Checker", page_icon="🚦", layout="wide")

VERDICT_STYLE = {
    VerdictLabel.VALID: ("✅ VALID", "#1e7e34"),
    VerdictLabel.LIKELY_FALSE: ("❌ LIKELY FALSE", "#c82333"),
    VerdictLabel.NEEDS_REVIEW: ("⚠️ NEEDS REVIEW", "#d39e00"),
}
RULE_ICON = {RuleStatus.PASS: "🟢", RuleStatus.FLAG: "🟠", RuleStatus.FAIL: "🔴", RuleStatus.NA: "⚪"}

st.title("🚦 Violation Checker")
st.caption("Checks IVMS speeding violations against the tracking evidence and flags likely false positives "
           "(GPS jumps, wrong speed zone, single-sample spikes).")

AUTH_METHODS = {
    "anthropic": {"api_key": "API key", "account": "My Anthropic Console account (ant auth login)"},
    "openai": {"api_key": "API key"},
    "gemini": {"api_key": "API key (Google AI Studio)", "account": "My Google account (Vertex AI)"},
}
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}
KEY_HELP = {
    "anthropic": "console.anthropic.com -> Settings -> API Keys (starts with sk-ant-api03-).",
    "openai": "platform.openai.com -> API keys (starts with sk-).",
    "gemini": "aistudio.google.com -> Get API key (free tier available).",
}

with st.sidebar:
    st.header("AI model")
    provider = st.selectbox("Provider", list(PROVIDERS), format_func=PROVIDERS.get)
    methods = AUTH_METHODS[provider]
    method = st.radio("Sign in with", list(methods), format_func=methods.get)
    creds = Credentials(provider=provider, method=method)

    if method == "api_key":
        env_name = ENV_KEYS[provider]
        typed = st.text_input(f"{PROVIDERS[provider]} API key", type="password",
                              help=f"Get one at {KEY_HELP[provider]} Leave empty to use the {env_name} "
                                   "environment variable. The key stays in this browser session only.")
        creds.api_key = typed.strip().strip('"').strip("'") or None
        if provider == "openai":
            st.caption("OpenAI only supports API keys. A ChatGPT Plus/Pro subscription can't be used by "
                       "other apps.")
        if provider == "anthropic":
            st.caption("Claude.ai / Claude Code subscriptions can't be used by other apps; use an API key "
                       "or your Console account.")
    elif provider == "anthropic":
        creds.profile = st.text_input("Profile name", value="default")
        st.caption("One-time setup: run `ant auth login` in a terminal on this computer and sign in to "
                   "your Anthropic Console account in the browser. Usage is billed to that Console account.")
    elif provider == "gemini":
        creds.project = st.text_input("Google Cloud project ID").strip() or None
        creds.location = st.text_input("Region", value="global").strip() or "global"
        st.caption("One-time setup: install the Google Cloud CLI, run "
                   "`gcloud auth application-default login`, and enable the Vertex AI API on the project.")

    # Connection is remembered until the provider / credentials change.
    sig = (provider, method, creds.api_key, creds.profile, creds.project, creds.location)
    conn = st.session_state.get("conn")
    if conn and conn["sig"] != sig:
        conn = st.session_state["conn"] = None

    if st.button("Connect", type="secondary", width="stretch"):
        with st.spinner("Checking credentials..."):
            llm_probe = make_provider(creds)
            ok, msg = llm_probe.check()
            models = llm_probe.list_models() if ok else []
        if ok:
            conn = st.session_state["conn"] = {"sig": sig, "models": models, "msg": msg}
        else:
            st.error(msg)

    model = None
    if conn:
        st.success(conn["msg"])
        choices = conn["models"] + ["Other (type a model id)"]
        model = st.selectbox("Model", choices, help="Best model for this task is listed first.")
        if model == choices[-1]:
            model = st.text_input("Model id").strip() or None
    else:
        st.info("Choose a provider, enter your credentials and click Connect.")

    st.divider()
    vehicle_class = st.selectbox("Vehicle type", list(VEHICLE_CLASSES), format_func=VEHICLE_CLASSES.get,
                                 help="Sets the ADNOC speed limits used in the checks (policy HRT-2026-01).")
    use_agent = st.toggle("Run AI agent review", value=True,
                          help="Off = only extraction + deterministic checks (faster, cheaper).")

c1, c2, c3 = st.columns(3)
viol_pdf = c1.file_uploader("Violation Details report (PDF)", type=["pdf"])
rag_pdf = c2.file_uploader("Road Safety RAG report (PDF, optional)", type=["pdf"])
shots = c3.file_uploader("Historical Tracking screenshots", type=["png", "jpg", "jpeg", "webp"],
                         accept_multiple_files=True)

ready = viol_pdf is not None and model is not None
run = st.button("Check violations", type="primary", disabled=not ready)
if not model:
    st.caption("Connect to an AI provider in the sidebar first.")
if run:
    llm = make_provider(creds, model)
    st.session_state["model_label"] = f"{llm.label} / {model}"
    msgs: queue.Queue = queue.Queue()
    box: dict = {}
    shot_list = [(f.name, f.getvalue()) for f in shots or []]

    def worker():
        try:
            box["result"] = check_violations(llm, viol_pdf.getvalue(), rag_pdf.getvalue() if rag_pdf else None,
                                             shot_list, progress=msgs.put, use_agent=use_agent,
                                             vehicle_class=vehicle_class)
        except Exception as e:  # surfaced below
            box["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    with st.status("Checking...", expanded=True) as status:
        while t.is_alive() or not msgs.empty():
            try:
                st.write(msgs.get(timeout=0.3))
            except queue.Empty:
                pass
        if "error" in box:
            status.update(label="Failed", state="error")
        else:
            status.update(label="Finished", state="complete", expanded=False)
    if "error" in box:
        st.exception(box["error"])
    else:
        st.session_state["cases"], st.session_state["rag"] = box["result"]
        st.session_state["shots"] = dict(shot_list)

cases = st.session_state.get("cases")
if cases:
    shots_by_name = st.session_state.get("shots", {})
    st.subheader("Results")
    if st.session_state.get("model_label"):
        st.caption(f"Reviewed with {st.session_state['model_label']}")
    st.dataframe(
        [{
            "Violation": c.violation_id,
            "Event": c.event.event,
            "Speed (km/h)": c.event.speed_kph,
            "Duration (s)": c.event.duration_seconds,
            "Verdict": VERDICT_STYLE[c.verdict.verdict][0] if c.verdict else ("Error" if c.error else "-"),
            "Confidence": f"{c.verdict.confidence:.0%}" if c.verdict else "",
            "Screenshot": c.screenshot_name or "none",
        } for c in cases],
        width="stretch", hide_index=True,
    )

    for c in cases:
        label = VERDICT_STYLE[c.verdict.verdict][0] if c.verdict else ("Error" if c.error else "Rules only")
        with st.expander(f"{label} — {c.violation_id} — {c.event.speed_kph:.0f} km/h", expanded=True):
            left, right = st.columns([3, 2])
            with left:
                if c.verdict:
                    v = c.verdict
                    text, color = VERDICT_STYLE[v.verdict]
                    st.markdown(f"<h3 style='color:{color};margin:0'>{text} "
                                f"<small>({v.confidence:.0%} confidence)</small></h3>", unsafe_allow_html=True)
                    st.write(v.summary)
                    st.markdown("**Reasons**\n" + "\n".join(f"- {r}" for r in v.reasons))
                    st.markdown("**Evidence**\n" + "\n".join(f"- {x}" for x in v.evidence))
                    st.info(f"**Recommended action:** {v.recommended_action}")
                elif c.error:
                    st.error(c.error)
                st.markdown("**Deterministic checks**")
                st.table([{"": RULE_ICON[r.status], "Rule": r.rule, "Check": r.name, "Result": r.status.value,
                           "Detail": r.detail} for r in c.rules])
            with right:
                if c.screenshot_name and c.screenshot_name in shots_by_name:
                    st.image(shots_by_name[c.screenshot_name], caption=c.screenshot_name)
                else:
                    st.caption("No matching tracking screenshot uploaded.")
                if c.tracking:
                    st.json(c.tracking.model_dump(exclude_none=True), expanded=False)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    d1, d2 = st.columns(2)
    d1.download_button("Download report (Markdown)",
                       to_markdown(cases, st.session_state.get("model_label", "")), f"violation_check_{stamp}.md")
    d2.download_button("Download data (JSON)",
                       "[" + ",".join(c.model_dump_json() for c in cases) + "]",
                       f"violation_check_{stamp}.json", mime="application/json")
