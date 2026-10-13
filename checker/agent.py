"""The reviewing agent: the selected LLM looks at the evidence, uses tools, and submits a verdict."""

from __future__ import annotations

import io
import json
from typing import Literal, Optional

from PIL import Image as PILImage
from pydantic import BaseModel, Field

from .extract import to_image
from .geo import haversine_m, implied_speed_kph, nearest_road
from .policy import policy_summary
from .llm import Image, LLMError, LLMProvider, Text, ToolSpec
from .models import RagSummary, RuleResult, TrackingEvidence, Verdict, VerdictLabel, ViolationEvent

SYSTEM_PROMPT = """\
You are a fleet road-safety analyst at a UAE transport company. Telematics (IVMS) units raise speeding \
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
distances, rule IDs). Be fair to both the driver and the company.
"""


# ---------- tool argument schemas ----------

class ZoomArgs(BaseModel):
    x0: int = Field(description="Left edge in original-image pixels")
    y0: int = Field(description="Top edge in pixels")
    x1: int = Field(description="Right edge in pixels")
    y1: int = Field(description="Bottom edge in pixels")


class HaversineArgs(BaseModel):
    lat1: float
    lon1: float
    lat2: float
    lon2: float
    seconds: float = Field(description="Time between the two fixes")


class RoadArgs(BaseModel):
    lat: float
    lon: float
    search_radius_m: int = Field(description="Search radius in metres, 50-1000 (use 300 if unsure)")


class VerdictArgs(BaseModel):
    verdict: Literal["VALID", "LIKELY_FALSE", "NEEDS_REVIEW"]
    confidence: float = Field(description="0.0 to 1.0")
    summary: str = Field(description="One or two sentences a fleet manager can read at a glance")
    reasons: list[str] = Field(description="Key reasons, most important first")
    evidence: list[str] = Field(description="Concrete observations with numbers (rule IDs, distances, speeds)")
    recommended_action: str = Field(description="What the fleet / HSE team should do next")


def _crop(img_bytes: bytes, a: ZoomArgs) -> bytes:
    img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = img.size
    x0, x1 = sorted((max(0, min(w, a.x0)), max(0, min(w, a.x1))))
    y0, y1 = sorted((max(0, min(h, a.y0)), max(0, min(h, a.y1))))
    if x1 - x0 < 10 or y1 - y0 < 10:
        raise ValueError(f"Crop box too small; image is {w}x{h} px.")
    crop = img.crop((x0, y0, x1, y1))
    scale = min(4.0, 1200 / max(crop.size))
    if scale > 1:
        crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), PILImage.LANCZOS)
    buf = io.BytesIO()
    crop.save(buf, "PNG")
    return buf.getvalue()


def review_violation(
    llm: LLMProvider,
    vid: str,
    event: ViolationEvent,
    rules: list[RuleResult],
    tracking: Optional[TrackingEvidence] = None,
    screenshot: Optional[bytes] = None,
    rag: Optional[RagSummary] = None,
    on_progress=None,
    vehicle_class: str = "light",
) -> Verdict:
    result: dict = {}

    def zoom(a: ZoomArgs):
        if screenshot is None:
            return "No screenshot available for this violation."
        return [Image(_crop(screenshot, a), "image/png")]

    def haversine(a: HaversineArgs):
        d = haversine_m(a.lat1, a.lon1, a.lat2, a.lon2)
        v = implied_speed_kph(d, a.seconds)
        return json.dumps({"distance_m": round(d, 1), "implied_speed_kph": None if v is None else round(v, 1)})

    def road(a: RoadArgs):
        return json.dumps(nearest_road(a.lat, a.lon, max(50, min(int(a.search_radius_m), 1000))))

    def submit(a: VerdictArgs):
        result.update(a.model_dump())
        return "Verdict recorded."

    tools = [
        ToolSpec("zoom_screenshot", "Crop the tracking screenshot to a box (original pixel coordinates) and "
                 "return it enlarged. Use it to see whether the trace follows a road and to read labels.",
                 ZoomArgs, zoom),
        ToolSpec("haversine_speed", "Great-circle distance between two coordinates and the speed needed to "
                 "cover it in the given seconds.", HaversineArgs, haversine),
        ToolSpec("lookup_road", "Nearest OpenStreetMap roads to a coordinate: name, ref, type, posted "
                 "maxspeed and distance in metres.", RoadArgs, road),
        ToolSpec("submit_verdict", "Submit the final verdict for this violation. Call exactly once, at the end.",
                 VerdictArgs, submit),
    ]

    rules_txt = "\n".join(f"- {r.rule} {r.name}: {r.status.value} - {r.detail}" for r in rules)
    parts = []
    if screenshot is not None:
        w, h = PILImage.open(io.BytesIO(screenshot)).size
        parts += [to_image(screenshot), Text(f"Historical Tracking screenshot above ({w}x{h} px).")]
    parts.append(Text(
        f"Violation ID: {vid}\n\nViolation row:\n{event.model_dump_json(indent=1)}\n\n"
        f"Tracking facts read from the screenshot:\n"
        f"{tracking.model_dump_json(indent=1) if tracking else 'no matching screenshot'}\n\n"
        f"{policy_summary(vehicle_class)}\n\n"
        f"Deterministic checks:\n{rules_txt}\n\n"
        f"Road Safety RAG report:\n{rag.model_dump_json(indent=1) if rag else 'not provided'}\n\n"
        "Investigate with the tools, then call submit_verdict."
    ))

    def on_tool(name, args):
        if on_progress:
            on_progress(f"{name}({json.dumps(args)[:120]})")

    last_text = llm.run_tools(SYSTEM_PROMPT, parts, tools, stop=lambda: bool(result), on_tool=on_tool)
    if not result:
        raise LLMError("The model finished without submitting a verdict. Last message: " + last_text[:500])
    return Verdict(violation_id=vid, verdict=VerdictLabel(result.pop("verdict")),
                   confidence=max(0.0, min(1.0, result.pop("confidence"))), **result)
