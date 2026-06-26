import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { getJotformSubmission } from '../../../../lib/jotform';
import { parseTRFSubmission } from '../../../../lib/integrations/trf';
import { normSo } from '../../../../lib/projectStages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Find the project (ops.legal_agreement) whose tech-request carries this SO number,
// so a Travel Request can be auto-linked to its project. normSo lets "SO-1234" ==
// "1234". Returns the agreement uuid or null.
async function resolveAgreementBySo(rawSo) {
  const target = normSo(rawSo);
  if (!target) return null;
  const { rows } = await query(
    `select agreement_id, answers->>'so_number' as so from ops.tech_request_submission
      where answers->>'so_number' is not null`,
  );
  for (const r of rows) if (normSo(r.so) === target) return r.agreement_id;
  return null;
}

// Records a JotForm workflow stage event (idempotent on submission_id + stage).
// Accepts POST (normal JotForm delivery) AND GET (JotForm "GET" webhooks + the
// connection test). Point a webhook here with ?stage=<name>.
//
// TRAVEL (Option B — JotForm is the front door):
//   * ?stage=travel_submit  → wire to the form's Settings→Integrations→Webhook
//                             (fires on EVERY submission). Captures the full TRF.
//   * ?stage=travel (or travel_approved) → wire to the Approval Flow Webhook
//                             (fires on approve). Flips the request to 'approved'.
//   Both upsert ONE row per submission in ops.travel_request (separate from the
//   Project Tracker). Other stages (e.g. ?stage=approved) still feed jotform_stage_event.
async function handle(request) {
  const url = new URL(request.url);
  const q = url.searchParams;

  // Optional shared-secret gate: if JOTFORM_WEBHOOK_SECRET is set, require ?token=.
  const secret = process.env.JOTFORM_WEBHOOK_SECRET;
  if (secret && q.get('token') !== secret) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  // POST carries the submission in the body; GET carries it on the query string.
  // Read the body ONCE (reading json() first would consume the stream).
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

  const stage = q.get('stage') || body.stage;
  if (!stage) return NextResponse.json({ error: 'stage is required (?stage=...)' }, { status: 400 });

  const submission_id = pick('submissionID', 'submission_id', 'so_number');
  const form_id = pick('formID', 'form_id');

  // A bare connection test (no submission) succeeds without writing a junk row.
  if (submission_id) {
    const payload = Object.keys(body).length ? body : Object.fromEntries(q);
    const isTravel = String(stage).startsWith('travel');
    if (isTravel) {
      // Stage → status: *_submit captures a new/edited request; *_deny|*_reject is
      // a denial; anything else (travel / travel_approved) is an approval.
      const trStatus = /submit/i.test(String(stage)) ? 'requested'
        : /den|reject/i.test(String(stage)) ? 'denied'
          : 'approved';

      // Read the submission back from JotForm for clean, well-typed fields
      // (degrades to the webhook body when the API key isn't set / call fails).
      const f = await getJotformSubmission(submission_id);
      const parsed = f.ok ? parseTRFSubmission(f.answers) : {};

      // SO number: an explicit ?so_number= wins, else what the form carried.
      const so = String(pick('so_number', 'soOr', 'so') || parsed.so_number || '').trim() || null;
      const agreement_id = await resolveAgreementBySo(so);

      // ONE row per submission (stage pinned to 'travel'): the submit webhook
      // creates it ('requested'); the approval webhook flips status to 'approved'
      // without clobbering captured fields, regardless of arrival order.
      await query(
        `insert into ops.travel_request
           (form_id, submission_id, so_number, stage, traveler, destination, purpose, start_date, end_date, status, source, agreement_id, payload)
         values ($1,$2,$3,'travel',$4,$5,$6,$7,$8,$9,'jotform',$10,$11)
         on conflict (submission_id, stage) do update set
           so_number    = coalesce(excluded.so_number, ops.travel_request.so_number),
           traveler     = coalesce(excluded.traveler, ops.travel_request.traveler),
           destination  = coalesce(excluded.destination, ops.travel_request.destination),
           purpose      = coalesce(excluded.purpose, ops.travel_request.purpose),
           start_date   = coalesce(excluded.start_date, ops.travel_request.start_date),
           end_date     = coalesce(excluded.end_date, ops.travel_request.end_date),
           agreement_id = coalesce(excluded.agreement_id, ops.travel_request.agreement_id),
           status       = case
                            when excluded.status in ('approved','denied') then excluded.status
                            when ops.travel_request.status in ('approved','denied') then ops.travel_request.status
                            else excluded.status
                          end,
           payload      = excluded.payload,
           updated_at   = now()`,
        [form_id, submission_id, so,
         parsed.traveler || payload.traveler || payload.name || null,
         parsed.destination || null, parsed.purpose || null, parsed.start_date || null, parsed.end_date || null,
         trStatus, agreement_id,
         JSON.stringify(f.ok ? f.answers : payload)],
      );
    } else {
      await query(
        `insert into ops.jotform_stage_event (form_id, submission_id, stage, payload)
         values ($1,$2,$3,$4)
         on conflict (submission_id, stage) do update set payload = excluded.payload, received_at = now()`,
        [form_id, submission_id, stage, JSON.stringify(payload)],
      );
    }
  }
  return NextResponse.json({ ok: true, stage, recorded: !!submission_id });
}

export const GET = handle;
export const POST = handle;
