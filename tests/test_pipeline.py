"""End-to-end pipeline test with a scripted fake LLM (no network, no API key)."""

import io

import pytest
from PIL import Image as PILImage

import checker.agent as agent_mod
import checker.pipeline as pipeline_mod
from checker.llm import Image, LLMProvider, strict_schema
from checker.models import RagSummary, TrackingEvidence, VerdictLabel, ViolationReport
from checker.pipeline import check_violations, to_markdown
from test_rules import EVENTS, RAG, TRACK_CITY, TRACK_DESERT


def fake_screenshot() -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (1600, 722), (210, 180, 140)).save(buf, "JPEG")
    return buf.getvalue()


class FakeLLM(LLMProvider):
    label = "Fake"

    def __init__(self):
        super().__init__(None, "fake-1")
        self.tool_calls = []
        self._shots = iter([TRACK_CITY, TRACK_DESERT])

    def check(self):
        return True, "ok"

    def list_models(self):
        return ["fake-1"]

    def parse(self, system, parts, schema):
        if schema is ViolationReport:
            return ViolationReport(events=EVENTS)
        if schema is RagSummary:
            return RAG
        if schema is TrackingEvidence:
            return next(self._shots)
        raise AssertionError(schema)

    def run_tools(self, system, parts, tools, stop, max_turns=15, on_tool=None):
        by = {t.name: t for t in tools}
        script = [
            ("zoom_screenshot", {"x0": 600, "y0": 80, "x1": 1150, "y1": 650}),
            ("lookup_road", {"lat": 24.14, "lon": 54.18, "search_radius_m": 300}),
            ("submit_verdict", {"verdict": "LIKELY_FALSE", "confidence": 1.7, "summary": "GPS jump",
                                "reasons": ["~1 km in 3 s"], "evidence": ["R3 FLAG"],
                                "recommended_action": "Request raw GPS log"}),
        ]
        for name, args in script:
            on_tool and on_tool(name, args)
            out = by[name].handler(by[name].args.model_validate(args))
            self.tool_calls.append((name, out))
            if stop():
                return "done"
        return ""


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    fake_road = lambda lat, lon, r=300: {"ok": True, "distance_m": 12.0, "highway": "service"}  # noqa: E731
    monkeypatch.setattr(pipeline_mod, "nearest_road", fake_road)
    monkeypatch.setattr(agent_mod, "nearest_road", fake_road)


def test_full_pipeline_with_fake_llm():
    llm = FakeLLM()
    shot = fake_screenshot()
    msgs = []
    cases, rag = check_violations(llm, b"%PDF-fake", b"%PDF-fake", [("a.jpg", shot), ("b.jpg", shot)],
                                  progress=msgs.append)
    assert rag == RAG and len(cases) == 2
    assert [c.screenshot_name for c in cases] == ["a.jpg", "b.jpg"]
    for c in cases:
        assert c.error is None, c.error
        assert c.verdict.verdict == VerdictLabel.LIKELY_FALSE
        assert c.verdict.confidence == 1.0  # clamped
    zoom_out = next(out for name, out in llm.tool_calls if name == "zoom_screenshot")
    assert isinstance(zoom_out[0], Image) and zoom_out[0].data[:4] == b"\x89PNG"
    assert any("submit_verdict" in m for m in msgs)
    md = to_markdown(cases, "Fake / fake-1")
    assert "LIKELY_FALSE" in md and "Fake / fake-1" in md


def test_strict_schema_requires_every_field():
    s = strict_schema(agent_mod.RoadArgs)
    assert s["additionalProperties"] is False
    assert set(s["required"]) == {"lat", "lon", "search_radius_m"}
    assert "title" not in s
    v = strict_schema(agent_mod.VerdictArgs)
    assert v["properties"]["verdict"]["enum"] == ["VALID", "LIKELY_FALSE", "NEEDS_REVIEW"]
