// Travel Request Form (TRF) matching — ported from the old app
// (_fetch_jotform_travel_requests / _normalize_date / _build_trf_index / _find_trf_match).
//
// TRFs are read from the synced DB (ext.jotform_submission), cleaned, then matched
// to Navan bookings. DEGRADES GRACEFULLY: empty table / parse error → [] and the
// ✅/⏰/❌ flags stay hidden.
import { query } from '../db';

const PROXIMITY_DAYS = 2;
const norm = (s) => String(s || '').trim().toLowerCase();
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// The Richtech "Travel Request Form (TRF)" JotForm id (override via env).
// Fields: requestersName(3) · companyEmail(4) · departureDate(5) · returnDate(6).
const TRF_FORM_ID = process.env.TRAVEL_REQUEST_FORM_ID || '253216066321044';

// Company email domains treated as the same person — Navan and JotForm often
// record different ones (joshua.h@richtechrobotics.com vs @richtechsystem.com).
const COMPANY_DOMAINS = new Set(['richtechrobotics.com', 'richtechsystem.com', 'richtechsystems.com']);
function canonicalEmail(e) {
  const s = norm(e);
  const at = s.lastIndexOf('@');
  if (at === -1) return s;
  const prefix = s.slice(0, at), domain = s.slice(at + 1);
  return COMPANY_DOMAINS.has(domain) ? prefix : s;   // collapse company-domain variants
}

// Robust date normalization → 'YYYY-MM-DD' (ports the old app's _normalize_date:
// ISO, embedded-ISO artifacts, named months, numeric triplets w/ year-first or
// year-last disambiguation).
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function toISO(v) {
  if (!v) return '';
  if (typeof v === 'object') {
    const { year, month, day } = v;
    if (year && month && day) return iso(year, month, day);
    v = v.datetime || v.text || Object.values(v).filter(Boolean).join(' ');
  }
  const s = String(v).trim();
  if (!s) return '';
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;            // ISO / starts ISO
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;             // embedded ISO
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/)) && MONTHS[m[2].slice(0, 3).toLowerCase()])
    return iso(m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);                            // "22 Mar 2026"
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTHS[m[1].slice(0, 3).toLowerCase()])
    return iso(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);                            // "Mar 22, 2026"
  const p = s.split(/[/\-\s.]+/).filter(Boolean).map(Number);
  if (p.length >= 3 && p.every((n) => !isNaN(n))) {
    const [a, b, c] = p;
    if (a > 1000) return iso(a, b, c);                                                          // YYYY M D
    if (c > 1000) return a <= 12 ? iso(c, a, b) : iso(c, b, a);                                 // US M/D/Y else D/M/Y
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

function answersOf(raw) {
  const a = raw && raw.answers;
  if (!a) return [];
  return Object.values(a).map((x) => ({ label: norm(x?.name) + ' ' + norm(x?.text), value: x?.answer }));
}

// Heuristically pull traveler email/name + departure/return dates from a TRF.
export function parseTRF(raw) {
  const a = (raw && raw.answers) || {};
  const byName = {};
  for (const x of Object.values(a)) if (x && x.name) byName[norm(x.name)] = x.answer;
  const fullname = (v) => (v && typeof v === 'object' ? [v.first, v.last].filter(Boolean).join(' ') : String(v || ''));
  const emailIn = (v) => { const m = (typeof v === 'string' ? v : '').match(EMAIL_RE); return m ? m[0] : ''; };

  let email = norm(emailIn(byName.companyemail));
  let name = norm(fullname(byName.requestersname));
  let depart = toISO(byName.departuredate);
  let ret = toISO(byName.returndate);

  if (!email || !name || !depart || !ret) {
    for (const { label, value } of answersOf(raw)) {
      const flat = typeof value === 'string' ? value : '';
      if (!email && (label.includes('email') || EMAIL_RE.test(flat))) email = norm(emailIn(flat));
      if (!name && (label.includes('requester') || label.includes('traveler') || label.includes('employee') || label.includes('name'))) { const v = fullname(value); if (v) name = norm(v); }
      if (!depart && (label.includes('depart') || label.includes('fly out') || label.includes('outbound') || label.includes('start date'))) depart = toISO(value);
      if (!ret && (label.includes('return') || label.includes('fly back') || label.includes('end date') || label.includes('arrival'))) ret = toISO(value);
    }
  }
  return { email, name, depart, ret };
}

// Map a live JotForm TRF submission (answers keyed by question-id, as returned by
// lib/jotform.getJotformSubmission) into the columns ops.travel_request stores.
// Known TRF fields by `name`: requestersName · companyEmail · departureDate ·
// returnDate · soOr. Destination/purpose are matched heuristically (the form may
// or may not have them). Everything degrades to '' / null when absent.
export function parseTRFSubmission(answers) {
  const a = answers || {};
  const byName = {};
  for (const x of Object.values(a)) if (x && x.name) byName[norm(x.name)] = x;
  const fullname = (v) => (v && typeof v === 'object' ? [v.first, v.last].filter(Boolean).join(' ') : String(v || ''));
  const val = (x) => (x ? (x.answer ?? x.prettyFormat ?? '') : '');

  const traveler = fullname(val(byName.requestersname)).trim();
  const email = norm((String(val(byName.companyemail)).match(EMAIL_RE) || [''])[0]);
  const start_date = toISO(val(byName.departuredate)) || null;
  const end_date = toISO(val(byName.returndate)) || null;
  const so_number = String(val(byName.soor) || '').trim() || null;

  // Heuristics for fields whose exact name we don't pin down.
  let destination = '', purpose = '';
  for (const x of Object.values(a)) {
    const label = norm(x?.name) + ' ' + norm(x?.text);
    const flat = typeof x?.answer === 'string' ? x.answer : '';
    if (!flat) continue;
    if (!destination && (label.includes('destination') || label.includes('city') || label.includes('location') || label.includes('where'))) destination = flat.trim();
    if (!purpose && (label.includes('purpose') || label.includes('reason') || label.includes('description') || label.includes('detail'))) purpose = flat.trim();
  }
  return { traveler: traveler || null, email: email || null, destination: destination || null, purpose: purpose || null, start_date, end_date, so_number };
}

// Read TRF submissions from the synced DB. Keep only ACTIVE, non-denied requests
// (matches the old app's _find_trf_match candidate filter).
export async function fetchTravelRequests() {
  try {
    const { rows } = await query('select raw from ext.jotform_submission where form_id = $1', [TRF_FORM_ID]);
    return rows
      .map((r) => r.raw)
      .filter((s) => s && String(s.status || 'ACTIVE').toUpperCase() === 'ACTIVE')   // drop deleted/trash
      .filter((s) => !['deny', 'denied'].includes(norm(s.workflowStatus)))           // drop denied (no-op if not stored)
      .map(parseTRF)
      .filter((t) => t.depart || t.ret);
  } catch {
    return [];
  }
}

const daysApart = (a, b) => Math.abs((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);

// Match one booking to the traveler's TRFs. Returns:
//   request_match: null  → no TRF data connected (caller hides the flag)
//   request_match: false → TRFs exist but none match this booking  (❌)
//   request_match: true  → matched; match_note set for ±-day proximity (⏰), else exact/within (✅)
export function matchTRF(booking, trfs) {
  if (!trfs || !trfs.length) return { request_match: null, match_note: null };
  const bEmail = canonicalEmail(booking.email), bName = norm(booking.name);
  const bDep = booking.depart, bRet = booking.ret || booking.depart;
  // Cross-company-domain email match, or exact name match.
  const mine = trfs.filter((t) =>
    (bEmail && canonicalEmail(t.email) === bEmail) || (bName && t.name && t.name === bName));
  if (!mine.length) return { request_match: false, match_note: null };

  for (const t of mine) if (bDep && t.depart === bDep && (!t.ret || t.ret === bRet)) return { request_match: true, match_note: null };          // exact
  for (const t of mine) if (t.depart && t.ret && bDep && bDep >= t.depart && bDep <= t.ret) return { request_match: true, match_note: null };   // within range
  for (const t of mine) {                                                                                                                       // ±2-day proximity
    if (t.depart && bDep && daysApart(bDep, t.depart) <= PROXIMITY_DAYS) return { request_match: true, match_note: bDep < t.depart ? 'Early flight in' : 'Late flight back' };
    if (t.ret && bRet && daysApart(bRet, t.ret) <= PROXIMITY_DAYS) return { request_match: true, match_note: bRet > t.ret ? 'Late flight back' : 'Early flight in' };
  }
  return { request_match: false, match_note: null };
}
