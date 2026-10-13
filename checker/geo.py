"""Geo helpers: great-circle distance and OpenStreetMap road lookup."""

from __future__ import annotations

import math
from typing import Optional

import requests

from .config import load_config

EARTH_RADIUS_M = 6_371_000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def implied_speed_kph(distance_m: float, seconds: float) -> Optional[float]:
    if seconds <= 0:
        return None
    return distance_m / seconds * 3.6


def _point_segment_distance_m(lat, lon, a, b) -> float:
    """Distance from a point to segment a-b using a local equirectangular projection."""
    k = math.cos(math.radians(lat))
    to_xy = lambda p: ((p[1] - lon) * k * 111_320.0, (p[0] - lat) * 110_540.0)  # noqa: E731
    ax, ay = to_xy(a)
    bx, by = to_xy(b)
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
    px, py = ax + t * dx, ay + t * dy
    return math.hypot(px, py)


def nearest_road(lat: float, lon: float, search_radius_m: int = 300) -> dict:
    """Find the nearest OSM road to a point.

    Returns a dict with keys: ok, distance_m, name, ref, highway, maxspeed, candidates, error.
    Never raises; network problems are reported in `error`.
    """
    cfg = load_config()
    query = (
        f"[out:json][timeout:{cfg['overpass_timeout_s']}];"
        f"way(around:{search_radius_m},{lat},{lon})[highway];"
        "out tags geom;"
    )
    elements, errors = None, []
    for url in cfg["overpass_urls"]:
        try:
            resp = requests.post(
                url,
                data={"data": query},
                timeout=cfg["overpass_timeout_s"] + 5,
                headers={"User-Agent": "violation-checker/1.0"},
            )
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            break
        except (requests.RequestException, ValueError) as e:
            errors.append(f"{url}: {e}")
    if elements is None:
        return {"ok": False, "error": "Overpass lookup failed: " + " | ".join(errors)}

    roads = []
    for el in elements:
        geom = el.get("geometry") or []
        pts = [(g["lat"], g["lon"]) for g in geom]
        if len(pts) < 2:
            continue
        d = min(_point_segment_distance_m(lat, lon, pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        tags = el.get("tags", {})
        roads.append(
            {
                "distance_m": round(d, 1),
                "name": tags.get("name:en") or tags.get("name"),
                "ref": tags.get("ref"),
                "highway": tags.get("highway"),
                "maxspeed": tags.get("maxspeed"),
                "surface": tags.get("surface"),
            }
        )
    roads.sort(key=lambda r: r["distance_m"])
    if not roads:
        return {"ok": True, "distance_m": None, "candidates": [],
                "note": f"No mapped road within {search_radius_m} m"}
    return {"ok": True, **roads[0], "candidates": roads[:5]}
