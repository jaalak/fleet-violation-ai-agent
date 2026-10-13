"""Read the exported PDFs and tracking screenshots into structured data with the selected LLM."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from PIL import Image as PILImage

from .llm import Image, LLMProvider, Pdf, Text
from .models import RagSummary, TrackingEvidence, ViolationReport

SYSTEM = (
    "You transcribe fleet-telematics reports and map screenshots into JSON. "
    "Copy values exactly as shown. Use null for anything not visible - never guess. "
    "Dates as YYYY-MM-DD, times as HH:MM:SS (screens use DD/MM/YYYY)."
)


def to_image(data: bytes) -> Image:
    """Normalise an uploaded picture to a format every provider accepts."""
    img = PILImage.open(io.BytesIO(data))
    fmt = (img.format or "").lower()
    if fmt in ("jpeg", "png", "webp"):
        return Image(data, f"image/{fmt}")
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")
    return Image(buf.getvalue(), "image/png")


def extract_violations(llm: LLMProvider, pdf: bytes) -> ViolationReport:
    return llm.parse(SYSTEM, [Pdf(pdf, "violation_details.pdf"),
                              Text("Extract every violation row from this Violation Details report.")],
                     ViolationReport)


def extract_rag(llm: LLMProvider, pdf: bytes) -> RagSummary:
    return llm.parse(SYSTEM, [Pdf(pdf, "road_safety_rag.pdf"),
                              Text("Extract the per-driver rows of this Road Safety RAG report.")],
                     RagSummary)


def extract_tracking(llm: LLMProvider, img: bytes) -> TrackingEvidence:
    return llm.parse(SYSTEM, [
        to_image(img),
        Text("This is a Historical Tracking screenshot. Extract the selected trip row "
             "(From, To, Distance, Duration) and every field of the event popup. "
             "The popup 'Location' looks like 'Speed 80 km/hr#<zone name> - (lat, lon)': put 80 in "
             "zone_speed_limit_kph, the zone name in zone_name and the coordinates in popup_lat/popup_lon. "
             "Only fill other_endpoint_lat/lon if a second point's coordinates are explicitly labelled on "
             "screen (the cursor readout in the map corner is NOT a trace endpoint)."),
    ], TrackingEvidence)


if __name__ == "__main__":
    # python -m checker.extract <anthropic|openai|gemini> <model or -> <file.pdf|image> [rag]
    # Credentials come from the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY).
    from .llm import Credentials, make_provider

    provider, model, path = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    llm = make_provider(Credentials(provider=provider), None if model == "-" else model)
    if not llm.model:
        llm.model = llm.list_models()[0]
    data = path.read_bytes()
    if path.suffix.lower() == ".pdf":
        out = extract_rag(llm, data) if sys.argv[4:] == ["rag"] else extract_violations(llm, data)
    else:
        out = extract_tracking(llm, data)
    print(f"# {llm.label} / {llm.model}")
    print(json.dumps(out.model_dump(), indent=2))
