import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { formTypeFor, missingRequired, buildJotformPayload, JOTFORM_IDS } from '../../../../lib/techRequestForm';
import { createJotformSubmission } from '../../../../lib/jotform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Save a draft (finalize=false) or finalize + push to JotForm (finalize=true).
export async function POST(request) {
  const b = await request.json();
  const agreementId = b.agreement_id;
  if (!agreementId) return NextResponse.json({ error: 'agreement_id required' }, { status: 400 });

  const ag = (await query('select agreement_type from ops.legal_agreement where id = $1', [agreementId])).rows[0];
  if (!ag) return NextResponse.json({ error: 'agreement not found' }, { status: 404 });

  const existing = (await query(
    'select id, answers from ops.tech_request_submission where agreement_id = $1 order by created_at desc limit 1',
    [agreementId]
  )).rows[0];
  const answers = { ...((existing && existing.answers) || {}), ...(b.answers || {}) };

  let status = 'saved';
  let jotform = null;

  if (b.finalize) {
    const missing = missingRequired(ag.agreement_type, answers);
    if (missing.length) return NextResponse.json({ error: 'Missing required fields: ' + missing.join(', ') }, { status: 400 });
    if (String(answers.signature || '').trim().toLowerCase() !== String(answers.requester_name || '').trim().toLowerCase()) {
      return NextResponse.json({ error: 'Signature must match the requester name.' }, { status: 400 });
    }
    const formType = formTypeFor(ag.agreement_type);
    const { payload, skipped } = buildJotformPayload(ag.agreement_type, answers);
    const jf = await createJotformSubmission(JOTFORM_IDS[formType], payload);
    jotform = { ...jf, skipped_fields: skipped };
    answers._jotform = jotform;
    status = 'finalized';
  }

  const formType = formTypeFor(ag.agreement_type);
  let id;
  if (existing) {
    id = existing.id;
    await query(
      `update ops.tech_request_submission
       set answers = $2, status = $3, agreement_type = $4, form_type = $5,
           submitted_by = coalesce(submitted_by, $6)
       where id = $1`,
      [id, JSON.stringify(answers), status, ag.agreement_type, formType, answers.requester_email || 'admin']
    );
  } else {
    const r = await query(
      `insert into ops.tech_request_submission (agreement_id, agreement_type, form_type, status, submitted_by, answers)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [agreementId, ag.agreement_type, formType, status, answers.requester_email || 'admin', JSON.stringify(answers)]
    );
    id = r.rows[0].id;
  }
  return NextResponse.json({ id, saved: true, status, jotform });
}
