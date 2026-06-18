// Client-side cache for the AI tabs — so switching tabs and opening an alert
// detail never shows a reload. Stale-while-revalidate:
//   • peekAi() returns the last value instantly, even if a little old (up to
//     MAX_STALE) → the page renders immediately, no spinner.
//   • getAi() returns the cached value if it's still FRESH; otherwise it fetches
//     once in the background and updates the cache (the page updates silently).
// Survives client-side navigation (in-memory Map) and full reloads (sessionStorage).
const FRESH_TTL = 120000;        // 2 min: within this, no refetch at all
const MAX_STALE = 6 * 3600000;   // 6 h: still show cached instantly, then revalidate
const mem = new Map();           // endpoint -> { at, data }
const inflight = new Map();      // endpoint -> Promise

function fromSession(endpoint) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem('ai-cache:' + endpoint);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return Date.now() - o.at < MAX_STALE ? o : null;
  } catch { return null; }
}
function toSession(endpoint, entry) {
  try { sessionStorage.setItem('ai-cache:' + endpoint, JSON.stringify(entry)); } catch { /* quota / SSR */ }
}
function entryOf(endpoint) {
  const m = mem.get(endpoint);
  if (m && Date.now() - m.at < MAX_STALE) return m;
  const s = fromSession(endpoint);
  if (s) { mem.set(endpoint, s); return s; }
  return null;
}

// Last cached value (even slightly stale) for instant display; null if none / too old.
export function peekAi(endpoint) {
  const e = entryOf(endpoint);
  return e ? e.data : null;
}

// Cached if FRESH; otherwise fetch once (deduped) and refresh the cache. Only
// successful payloads are cached, so a transient error self-heals next time.
export function getAi(endpoint, { force = false } = {}) {
  const e = entryOf(endpoint);
  if (!force && e && Date.now() - e.at < FRESH_TTL) return Promise.resolve(e.data);
  if (inflight.has(endpoint)) return inflight.get(endpoint);
  const p = fetch(endpoint)
    .then((r) => r.json())
    .then((data) => { if (data && data.ok !== false) setAi(endpoint, data); return data; })
    .finally(() => inflight.delete(endpoint));
  inflight.set(endpoint, p);
  return p;
}

// Write a result into the cache (used after a Refresh/sync re-pull).
export function setAi(endpoint, data) {
  if (data && data.ok !== false) {
    const entry = { at: Date.now(), data };
    mem.set(endpoint, entry);
    toSession(endpoint, entry);
  }
}

// Fire-and-forget warm the cache for several endpoints (skips ones already fresh).
export function prefetchAi(endpoints) {
  if (typeof window === 'undefined') return;
  for (const ep of endpoints) {
    const e = entryOf(ep);
    if ((!e || Date.now() - e.at >= FRESH_TTL) && !inflight.has(ep)) getAi(ep).catch(() => {});
  }
}
