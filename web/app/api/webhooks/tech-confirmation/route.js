import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { getJotformSubmission } from '../../../../lib/jotform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Technician Confirmation webhook. JotForm fires this when a Technician
// Confirmation form is APPROVED. We read the submission back by id and parse it
// by question-id, so the SO number (and team/dates/technicians) are captured
// automatically — no need to map an SO field into the webhook URL. The row lands
// in ops.tech_confirmation, which the Project Tracker joins by normalized SO to
// advance stages 6 (Team Prep), 7 (Confirmation), and 8 (Travel).
//
// No calendar/email side-effects here by design — scheduling lives in JotForm.

// Question-id map for the Technician Confirmation form (261615438877065),
// captured from the live form. Same map the old FastAPI app used.
const QID = { team: '16', contact_email: '5', so_number: '15', fly_out: '6', fly_back: '14' };
// (name_qid, email_qid) for technicians 1..5.
const TECH_QIDS = [['8', '17'], ['9', '18'], ['10', '19'], ['11', '20'], ['12', '21']];

const ans = (answers, qid) => {
  const a = answers?.[qid];
  return a && typeof a === 'object' ? a : { answer: a };
};
function text(answers, qid) {
  const a = ans(answers, qid);
  let v = a.answer;
  if (v && typeof v === 'object') v = a.prettyFormat || '';
  return String(a.prettyFormat || v || '').trim();
}
function fullName(answers, qid) {
  const a = ans(answers, qid);
  const v = a.answer;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return [v.first, v.last].filter(Boolean).join(' ').trim(); // {first,last} name field
  }
  return String(a.prettyFormat || v || '').trim();
}
// Normalize a JotForm date answer (datetime subfields or a display string) to
// ISO YYYY-MM-DD, or '' if it can't be read.
function isoDate(answers, qid) {
  const a = ans(answers, qid);
  const v = a.answer;
  if (v && typeof v === 'object') {
    const { year, month, day } = v;
    if (year && month && day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const s = String(a.prettyFormat || v || '').trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return '';
}

function parseConfirmation(answers) {
  const techs = [];
  for (const [nq, eq] of TECH_QIDS) {
    const name = fullName(answers, nq);
    const email = text(answers, eq);
    if (name || email) techs.push({ name, email });
  }
  return {
    team: text(answers, QID.team),
    contact_email: text(answers, QID.contact_email),
    so_number: text(answers, QID.so_number),
    fly_out: isoDate(answers, QID.fly_out),
    fly_back: isoDate(answers, QID.fly_back),
    // The tracker renders technicians via .join(', ') → store names as strings.
    technicians: techs.map((t) => t.name || t.email).filter(Boolean),
    technician_emails: techs.map((t) => t.email).filter(Boolean),
  };
}

async function handle(request) {
  const url = new URL(request.url);
  const q = url.searchParams;

  // Optional shared-secret gate: if JOTFORM_WEBHOOK_SECRET is set, require ?token=.
  const secret = process.env.JOTFORM_WEBHOOK_SECRET;
  if (secret && q.get('token') !== secret) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  // POST carries the submission in the body; GET carries it on the query string.
  let body = {};
  if (request.method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    try { body = ct.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData()); }
    catch { body = {}; }
  }
  const pick = (...keys) => {
    for (const k of keys) { if (body[k] != null) return body[k]; const v = q.get(k); if (v != null) return v; }
    return null;
  };

  const submissionId = pick('submissionID', 'submission_id', 'submissionId', 'sid');
  // A bare connection test (no submission) succeeds without writing a junk row.
  if (!submissionId) {
    return NextResponse.json({ ok: true, recorded: false, detail: 'no submissionID received — nothing recorded (test ping?)' });
  }
  let formId = pick('formID', 'form_id', 'formId');

  // Approve vs deny: wire the Approval Flow's Approve step to ?decision=approved
  // (or omit — approved is the default) and the Deny step to ?decision=denied.
  // The Project Tracker only completes Confirmation/Prep on an APPROVED row; a
  // denied one shows "❌ Denied — resubmit to re-confirm" and reopens on redo.
  const decision = /den|reject/i.test(String(pick('decision', 'stage') || '')) ? 'denied' : 'approved';

  // Auto-capture: read the submission back and parse by qid. Best-effort — if the
  // API read fails (no key / transient), fall back to any params on the request
  // and DON'T clobber an existing good row.
  const fetched = await getJotformSubmission(submissionId);
  let payload;
  if (fetched.ok) {
    payload = parseConfirmation(fetched.answers);
    if (!formId) formId = fetched.form_id;
  } else {
    payload = {
      team: pick('team') || '', contact_email: pick('contact_email', 'email') || '',
      so_number: pick('so_number', 'soOr', 'so') || '', fly_out: '', fly_back: '',
      technicians: [], _fetch_error: fetched.error || fetched.skipped || 'unknown',
    };
  }
  payload.decision = decision;

  const conflict = fetched.ok
    ? `do update set form_id = coalesce(excluded.form_id, ops.tech_confirmation.form_id),
         team = excluded.team, so_number = excluded.so_number,
         contact_email = excluded.contact_email, payload = excluded.payload`
    : 'do nothing'; // a failed re-read must not wipe a previously captured row
  await query(
    `insert into ops.tech_confirmation (submission_id, form_id, team, so_number, contact_email, payload)
     values ($1,$2,$3,$4,$5,$6) on conflict (submission_id) ${conflict}`,
    [submissionId, formId, payload.team || '', payload.so_number || '', payload.contact_email || '', JSON.stringify(payload)],
  );

  return NextResponse.json({
    ok: true, recorded: true, submission_id: submissionId, decision,
    so_number: payload.so_number || null, captured: fetched.ok,
  });
}

export const GET = handle;
export const POST = handle;
