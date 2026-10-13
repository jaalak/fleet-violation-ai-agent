// Great-circle distance and OpenStreetMap (Overpass) road lookup, straight from the browser.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversineM(lat1, lon1, lat2, lon2) {
  const dp = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function impliedSpeedKph(distanceM, seconds) {
  return seconds > 0 ? (distanceM / seconds) * 3.6 : null;
}

function pointSegmentM(lat, lon, a, b) {
  const k = Math.cos(rad(lat));
  const xy = (p) => [(p.lon - lon) * k * 111320, (p.lat - lat) * 110540];
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay;
  const seg2 = dx * dx + dy * dy;
  const tt = seg2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / seg2));
  return Math.hypot(ax + tt * dx, ay + tt * dy);
}

export const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** Never throws; failures come back as {ok:false, error}. */
export async function nearestRoad(lat, lon, radiusM = 300, fetchImpl = fetch) {
  const query = `[out:json][timeout:20];way(around:${radiusM},${lat},${lon})[highway];out tags geom;`;
  const errors = [];
  for (const url of OVERPASS_URLS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      // form-encoded POST is a CORS "simple request": no preflight needed
      const resp = await fetchImpl(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: ctl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const elements = (await resp.json()).elements || [];
      const roads = [];
      for (const el of elements) {
        const g = el.geometry || [];
        if (g.length < 2) continue;
        let d = Infinity;
        for (let i = 0; i < g.length - 1; i++) d = Math.min(d, pointSegmentM(lat, lon, g[i], g[i + 1]));
        const tags = el.tags || {};
        roads.push({
          distance_m: Math.round(d * 10) / 10,
          name: tags["name:en"] || tags.name || null,
          ref: tags.ref || null,
          highway: tags.highway || null,
          maxspeed: tags.maxspeed || null,
        });
      }
      roads.sort((a, b) => a.distance_m - b.distance_m);
      if (!roads.length) return { ok: true, distance_m: null, candidates: [], note: `No mapped road within ${radiusM} m` };
      return { ok: true, ...roads[0], candidates: roads.slice(0, 5) };
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.name === "AbortError" ? "timeout" : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "OpenStreetMap lookup failed (" + errors.join("; ") + ")" };
}
