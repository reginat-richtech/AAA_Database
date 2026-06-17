// HubSpot CRM — activity brief, ported from the old app's /hubspot/activity-brief.
// Deal cards: (1) new deals this week (2026+), (2) stage moves in the last 7 days
// (from dealstage history), (3) open deals past their close date (stalled).
// Plus an email-activity-by-PM section: top/bottom reps by emails sent yesterday,
// each with one-line LLM summaries (ported from the old app's email section).
//
// Two cached paths:
//   - cardsBrief()  → deal cards only (cheap). Used by the sidebar badge count.
//   - hubspotBrief() → cards + email activity (+ LLM). Used by the page.
// This keeps the badge from triggering LLM calls on every admin page load.
const HS_BASE = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const DAY = 86400000;
const YEAR_CUTOFF = Date.parse('2026-01-01T00:00:00Z');
const NOT_CLOSED = { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' };
const PROPS = ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'hs_lastmodifieddate'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayStartMs(offsetDays = 0) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  return String(d.getTime());
}
function fmtMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n ? '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null;
}
const tsOf = (v) => (v == null ? 0 : (isNaN(+v) ? Date.parse(v) : +v)) || 0;

async function hsFetch(path, opts = {}, attempt = 0) {
  const res = await fetch(HS_BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  // HubSpot's Search API allows only ~4 req/s; a brief burst returns 429. Respect
  // Retry-After when present, else exponential backoff, and retry a few times.
  if (res.status === 429 && attempt < 5) {
    const ra = Number(res.headers.get('Retry-After'));
    const waitMs = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + 200;
    await sleep(waitMs);
    return hsFetch(path, opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
async function hsSearch(filters, { limit = 100, sortProp = 'hs_lastmodifieddate', sortDir = 'DESCENDING' } = {}) {
  const d = await hsFetch('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters }], properties: PROPS, limit, sorts: [{ propertyName: sortProp, direction: sortDir }] }),
  });
  return { results: d.results || [], total: d.total || 0 };
}
// Pipeline stage id -> human label (and used to color stage-move cards).
async function stageLabels() {
  try {
    const d = await hsFetch('/crm/v3/pipelines/deals');
    const m = {};
    for (const pl of d.results || []) for (const st of pl.stages || []) m[st.id] = st.label;
    return m;
  } catch { return {}; }
}
function stageSeverity(label) {
  const s = (label || '').toLowerCase();
  if (s.includes('lost')) return { sev: 'fail', icon: '❌' };
  if (s.includes('won')) return { sev: 'ok', icon: '🏆' };
  if (s.includes('trial')) return { sev: 'info', icon: '🧪' };
  return { sev: 'warn', icon: '🔄' };
}

// Owner id -> display name (HubSpot owners API; paged).
async function ownerMap() {
  try {
    const m = {};
    let after = null;
    for (let i = 0; i < 5; i++) {
      const d = await hsFetch(`/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`);
      for (const o of d.results || []) {
        m[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || String(o.id);
      }
      after = d.paging?.next?.after;
      if (!after) break;
    }
    return m;
  } catch { return {}; }
}

// Extract a bare email address from a HubSpot "to"/"from" entry (dict or string).
function emailAddr(v) {
  if (!v) return '';
  const raw = String(typeof v === 'object' ? (v.email || '') : v).trim();
  if (!raw) return '';
  const m = raw.match(/<([^<>@\s]+@[^<>@\s]+)>/) || raw.match(/([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})/i);
  return (m ? m[1] : raw).toLowerCase();
}

// Recent EMAIL engagements via the v1 API (port of _fetch_recent_engagements,
// EMAIL-only). Returns { timestamp, owner_id, subject, body, to[], direction }.
async function recentEmails(daysBack = 2, maxPages = 10, maxResults = 500) {
  const cutoff = Date.now() - daysBack * DAY;
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await hsFetch(`/engagements/v1/engagements/recent/modified?count=100&offset=${offset}`);
    } catch { break; }
    for (const eng of data.results || []) {
      const e = eng.engagement || {};
      const ts = Number(e.timestamp ?? e.createdAt) || 0;
      if (!ts || ts < cutoff) continue;
      const type = String(e.type || '').toUpperCase();
      if (type !== 'EMAIL' && type !== 'INCOMING_EMAIL' && type !== 'FORWARDED_EMAIL') continue;
      const md = eng.metadata || {};
      const ownerIdsFrom = md.ownerIdsFrom || [];
      const sentVia = md.sentVia || '';
      const ownerIdsTo = md.ownerIdsTo || [];
      let direction;
      if (type === 'INCOMING_EMAIL') direction = 'inbound';
      else if (ownerIdsFrom.length || sentVia) direction = 'outbound';
      else if (ownerIdsTo.length) direction = 'inbound';
      else direction = 'unknown';
      let owner_id = String(e.ownerId || '');
      if (!owner_id && ownerIdsFrom.length) owner_id = String(ownerIdsFrom[0]);
      out.push({
        timestamp: ts,
        owner_id,
        direction,
        subject: md.subject || '(no subject)',
        body: String(md.html || md.text || '').replace(/<[^>]+>/g, ' ').slice(0, 1200).trim(),
        to: (md.to || []).map(emailAddr).filter(Boolean),
        date: new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      });
    }
    if (maxResults > 0 && out.length >= maxResults) break;
    if (!data.hasMore) break;
    offset = data.offset ?? offset + 100;
  }
  return out;
}

// One LLM call → { overall, per: [one-line summary per email] }. Degrades to
// empty strings if no OpenAI key or the call fails.
async function aiEmailSummary(pmName, emails) {
  const sample = emails.slice(0, 15);
  if (!OPENAI_KEY) return { overall: '', per: sample.map(() => '') };
  const blocks = sample.map((e, i) =>
    `Email ${i + 1}: Subject: ${e.subject} | To: ${(e.to || []).join(', ') || '(unknown)'}` + (e.body ? ` | Body: ${e.body.slice(0, 400)}` : ''));
  const prompt = `${pmName} sent ${emails.length} emails yesterday.\n\n${blocks.join('\n')}\n\n`
    + `Return ONLY valid JSON: {"overall":"<2-3 sentence overall summary>","emails":["<1 sentence for email 1>", ...]} `
    + `with exactly ${sample.length} entries in "emails".`;
  try {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 0.2, max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a sales coach. Respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}');
    const per = (parsed.emails || []).map(String);
    while (per.length < sample.length) per.push('');
    return { overall: String(parsed.overall || ''), per: per.slice(0, sample.length) };
  } catch { return { overall: '', per: sample.map(() => '') }; }
}

// Section: email activity by PM — outbound emails sent yesterday, grouped by
// owner, ranked top-3 / bottom-3, each summarized by the LLM.
async function computeEmail() {
  let engagements = [];
  try { engagements = await recentEmails(2, 10, 500); } catch { engagements = []; }
  const yStart = Number(dayStartMs(-1)), yEnd = Number(dayStartMs(0));
  const yest = engagements.filter((e) => e.direction !== 'inbound' && e.owner_id && e.timestamp >= yStart && e.timestamp < yEnd);

  const byPm = {};
  for (const e of yest) (byPm[e.owner_id] = byPm[e.owner_id] || []).push(e);
  const ranked = Object.entries(byPm).sort((a, b) => b[1].length - a[1].length);
  const top3 = ranked.slice(0, 3);
  const topIds = new Set(top3.map(([oid]) => oid));
  const bot3 = ranked.slice(-3).filter(([oid]) => !topIds.has(oid));

  const owners = await ownerMap();
  const build = async ([oid, emails]) => {
    const name = owners[oid] || oid;
    const { overall, per } = await aiEmailSummary(name, emails);
    return {
      owner_id: oid, owner_name: name, count: emails.length, ai_summary: overall,
      emails: emails.slice(0, 15).map((e, i) => ({ subject: e.subject, to: (e.to || []).slice(0, 5), date: e.date, summary: per[i] || '' })),
    };
  };
  const entries = await Promise.all([...top3, ...bot3].map(build));
  return {
    top: entries.filter((e) => topIds.has(e.owner_id)),
    bottom: entries.filter((e) => !topIds.has(e.owner_id)),
    total_emails_yesterday: yest.length,
    total_pms_active: Object.keys(byPm).length,
  };
}

// Deal cards (sections 1, 2, 3). Searches run sequentially (HubSpot Search API
// ≈ 4 req/s); stageLabels overlaps the first search.
async function computeCards() {
  const weekAgoMs = dayStartMs(-7);
  const todayMs = dayStartMs(0);

  const stagePromise = stageLabels();
  const newRes = await hsSearch([{ propertyName: 'createdate', operator: 'GTE', value: weekAgoMs }, { propertyName: 'createdate', operator: 'LT', value: todayMs }], { limit: 200 });
  const modRes = await hsSearch([{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: weekAgoMs }], { limit: 100 });
  const overdueRes = await hsSearch([NOT_CLOSED, { propertyName: 'closedate', operator: 'LT', value: todayMs }], { limit: 5, sortProp: 'closedate', sortDir: 'ASCENDING' });
  const stageMap = await stagePromise;

  const cards = [];

  // 1 — New deals this week (created 2026+)
  const newDeals = (newRes.results || []).filter((d) => tsOf(d.properties?.createdate) >= YEAR_CUTOFF);
  if (newDeals.length) {
    const names = newDeals.slice(0, 3).map((d) => {
      const p = d.properties || {}; const m = fmtMoney(p.amount);
      return (p.dealname || 'Untitled') + (m ? ` · ${m}` : '');
    });
    cards.push({
      id: 'new_deals', sev: 'info', icon: '🆕',
      title: `${newDeals.length} New Deal${newDeals.length !== 1 ? 's' : ''} This Week`,
      msg: names.join(', ') + (newDeals.length > 3 ? ` +${newDeals.length - 3} more` : ''),
      detail: {
        kind: 'deals',
        deals: newDeals.map((d) => {
          const p = d.properties || {};
          return { id: d.id, name: p.dealname || `Deal #${d.id}`, amount: fmtMoney(p.amount) || '—', stage: stageMap[p.dealstage] || p.dealstage || '—', created: (p.createdate || '').slice(0, 10), close: (p.closedate || '').slice(0, 10) };
        }),
      },
    });
  }

  // 2 — Stage moves in the last 7 days (read dealstage history for modified deals)
  const ids = (modRes.results || []).map((d) => d.id);
  const hist = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const r = await hsFetch('/crm/v3/objects/deals/batch/read', {
        method: 'POST',
        body: JSON.stringify({ inputs: ids.slice(i, i + 50).map((id) => ({ id })), propertiesWithHistory: ['dealstage'], properties: [] }),
      });
      for (const row of r.results || []) hist[row.id] = row;
    } catch { /* skip a failed batch, keep going */ }
  }
  const wS = Number(weekAgoMs), wE = Number(todayMs), seen = new Set();
  for (const d of modRes.results || []) {
    const h = hist[d.id]?.propertiesWithHistory?.dealstage;
    if (!Array.isArray(h) || h.length < 2) continue;
    const inWin = h.filter((e) => tsOf(e.timestamp) >= wS && tsOf(e.timestamp) < wE);
    if (!inWin.length) continue;
    const newStage = inWin[0].value;                       // newest-first
    const older = h.filter((e) => tsOf(e.timestamp) < wS);
    const oldStage = older.length ? older[0].value : '';
    if (!oldStage || oldStage === newStage) continue;
    const key = `${d.id}:${oldStage}:${newStage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = d.properties || {}, m = fmtMoney(p.amount);
    const to = stageMap[newStage] || newStage, from = stageMap[oldStage] || oldStage;
    const { sev, icon } = stageSeverity(to);
    const movedTs = tsOf(inWin[0].timestamp);
    cards.push({
      id: `move_${d.id}`, sev, icon, title: p.dealname || `Deal #${d.id}`, msg: `${from} → ${to}${m ? ` · ${m}` : ''}`,
      detail: { kind: 'move', deal: { id: d.id, name: p.dealname || `Deal #${d.id}`, amount: m || '—', from, to, close: (p.closedate || '').slice(0, 10), movedAt: movedTs ? new Date(movedTs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '' } },
    });
  }
  const stageMoves = cards.filter((c) => c.id.startsWith('move_')).length;

  // 3 — Overdue / stalled deals, collapsed into ONE card
  const overdue = overdueRes.results || [];
  if (overdueRes.total) {
    const names = overdue.slice(0, 3).map((d) => {
      const p = d.properties || {}; const m = fmtMoney(p.amount);
      const over = p.closedate ? Math.round((Date.now() - tsOf(p.closedate)) / DAY) : null;
      return (p.dealname || 'deal') + (m ? ` · ${m}` : '') + (over != null ? ` · ${over}d overdue` : '');
    });
    cards.push({
      id: 'overdue', sev: 'fail', icon: '⏰',
      title: `${overdueRes.total} Stalled Deal${overdueRes.total !== 1 ? 's' : ''} — Past Close Date`,
      msg: names.join(', ') + (overdueRes.total > 3 ? ` +${overdueRes.total - 3} more` : ''),
      rec: 'Review and update close dates or move to Closed Lost',
      detail: {
        kind: 'deals',
        total: overdueRes.total,
        deals: overdue.map((d) => {
          const p = d.properties || {};
          const over = p.closedate ? Math.round((Date.now() - tsOf(p.closedate)) / DAY) : null;
          return { id: d.id, name: p.dealname || `Deal #${d.id}`, amount: fmtMoney(p.amount) || '—', close: (p.closedate || '').slice(0, 10), daysOverdue: over };
        }),
      },
    });
  }

  const rank = { fail: 0, warn: 1, info: 2, ok: 3 };
  cards.sort((a, b) => rank[a.sev] - rank[b.sev]);

  return { ok: true, count: cards.length, cards, brief: { newDeals: newDeals.length, stageMoves, overdue: overdueRes.total }, error: null };
}

// ── caches: cardsBrief (cheap, for the badge) + hubspotBrief (full, for the page) ──
let _cardsCache = null, _cardsInflight = null;
const CARDS_TTL = 20000;
function cardsBrief() {
  if (!TOKEN) return Promise.resolve({ ok: false, count: 0, cards: [], error: 'HubSpot token not configured' });
  if (_cardsCache && Date.now() - _cardsCache.at < CARDS_TTL) return Promise.resolve(_cardsCache.data);
  if (_cardsInflight) return _cardsInflight;
  _cardsInflight = computeCards()
    .catch((e) => ({ ok: false, count: 0, cards: [], error: String(e?.message || e) }))
    .then((data) => { _cardsCache = { at: Date.now(), data }; _cardsInflight = null; return data; });
  return _cardsInflight;
}

let _fullCache = null, _fullInflight = null;
const FULL_TTL = 45000;
export async function hubspotBrief() {
  if (!TOKEN) return { ok: false, count: 0, cards: [], error: 'HubSpot token not configured' };
  if (_fullCache && Date.now() - _fullCache.at < FULL_TTL) return _fullCache.data;
  if (_fullInflight) return _fullInflight;
  _fullInflight = (async () => {
    const base = await cardsBrief();
    if (!base.ok) return base;
    let email_activity = null;
    try { email_activity = await computeEmail(); } catch { email_activity = null; }
    return { ...base, email_activity };
  })()
    .catch((e) => ({ ok: false, count: 0, cards: [], error: String(e?.message || e) }))
    .then((data) => { _fullCache = { at: Date.now(), data }; _fullInflight = null; return data; });
  return _fullInflight;
}

// Light path for the sidebar badge — deal cards only, no email/LLM.
export async function hubspotCount() {
  const r = await cardsBrief();
  return r.ok ? r.count : null;
}
