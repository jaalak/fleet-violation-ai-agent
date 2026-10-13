"""End-to-end: documents in -> one CaseResult per violation out."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

from .agent import review_violation
from .extract import extract_rag, extract_tracking, extract_violations
from .geo import nearest_road
from .llm import LLMProvider
from .models import CaseResult, RagSummary, TrackingEvidence
from .rules import match_tracking, run_rules, violation_id

Progress = Callable[[str], None]


def check_violations(
    llm: LLMProvider,
    violation_pdf: bytes,
    rag_pdf: Optional[bytes] = None,
    screenshots: Optional[list[tuple[str, bytes]]] = None,
    progress: Progress = lambda _msg: None,
    use_agent: bool = True,
) -> tuple[list[CaseResult], Optional[RagSummary]]:
    screenshots = screenshots or []

    progress(f"Reading the documents with {llm.label} ({llm.model})...")
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_viol = pool.submit(extract_violations, llm, violation_pdf)
        f_rag = pool.submit(extract_rag, llm, rag_pdf) if rag_pdf else None
        f_shots = [(name, pool.submit(extract_tracking, llm, data)) for name, data in screenshots]
        report = f_viol.result()
        rag = f_rag.result() if f_rag else None
        trackings: list[tuple[str, TrackingEvidence]] = [(n, f.result()) for n, f in f_shots]
    events = report.events
    progress(f"Found {len(events)} violation(s) and {len(trackings)} tracking screenshot(s).")

    matched = match_tracking(events, trackings)

    progress("Looking up roads in OpenStreetMap...")
    roads: dict[int, dict] = {}
    for i, (_, tr) in matched.items():
        if tr.popup_lat is not None and tr.popup_lon is not None:
            roads[i] = nearest_road(tr.popup_lat, tr.popup_lon)

    rules = run_rules(events, matched, rag, roads)
    shot_bytes = dict(screenshots)

    cases = []
    for i, ev in enumerate(events):
        name, tr = matched.get(i, (None, None))
        cases.append(CaseResult(violation_id=violation_id(ev), event=ev, tracking=tr,
                                screenshot_name=name, rules=rules[i]))

    if use_agent:
        def run(case: CaseResult) -> None:
            progress(f"Agent reviewing {case.violation_id}...")
            try:
                case.verdict = review_violation(
                    llm, case.violation_id, case.event, case.rules, case.tracking,
                    shot_bytes.get(case.screenshot_name) if case.screenshot_name else None, rag,
                    on_progress=lambda m, vid=case.violation_id: progress(f"  [{vid}] {m}"),
                )
            except Exception as e:  # keep the other cases going; show the error in the UI
                case.error = f"{type(e).__name__}: {e}"
            progress(f"Done: {case.violation_id}")

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(run, cases))

    return cases, rag


def to_markdown(cases: list[CaseResult], model_label: str = "") -> str:
    lines = ["# Violation Check Report", ""] + ([f"_Reviewed with {model_label}_", ""] if model_label else [])
    for c in cases:
        e = c.event
        lines += [f"## {c.violation_id}",
                  f"**Event:** {e.event} | {e.start_time}-{e.end_time} ({e.duration_seconds} s) | "
                  f"{e.speed_kph:.0f} km/h | {e.asset}", ""]
        if c.verdict:
            v = c.verdict
            lines += [f"**Verdict:** {v.verdict.value} (confidence {v.confidence:.0%})", "", v.summary, "",
                      "**Reasons**", *[f"- {r}" for r in v.reasons], "",
                      "**Evidence**", *[f"- {x}" for x in v.evidence], "",
                      f"**Recommended action:** {v.recommended_action}", ""]
        elif c.error:
            lines += [f"**Error:** {c.error}", ""]
        lines += ["| Rule | Check | Result | Detail |", "|---|---|---|---|",
                  *[f"| {r.rule} | {r.name} | {r.status.value} | {r.detail} |" for r in c.rules], ""]
    return "\n".join(lines)
