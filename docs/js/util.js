// Small helpers shared by the browser app. No DOM access here, so they also run under Node for tests.

export function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function sniffImageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  return null;
}

/** "2026-10-11 18:27:29", "11/10/2026 18:27:29" or ISO -> ms since epoch (treated as UTC; only differences matter). */
export function parseTs(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); // DD/MM/YYYY
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  return null;
}

export function eventStart(ev) {
  return parseTs(`${ev.date} ${ev.start_time}`);
}

/** Order ids so the highest version matching `rx` (first group = version, "-" or "." separated) comes first. */
export function pickLatest(ids, rx) {
  const ver = (id) => {
    const m = id.match(rx);
    return m ? parseFloat(m[1].replace("-", ".")) : -1;
  };
  return [...ids].sort((a, b) => ver(b) - ver(a) || (a < b ? 1 : -1));
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
