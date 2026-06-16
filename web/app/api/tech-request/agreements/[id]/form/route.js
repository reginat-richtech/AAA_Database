import { NextResponse } from 'next/server';
import { query } from '../../../../../../lib/db';
import { schemaFor, formTypeFor, autofillFromAgreement, JOTFORM_IDS, FORM_TITLES } from '../../../../../../lib/techRequestForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  const { id } = await params;
  const a = (await query(
    'select *, extracted_json as extracted from ops.legal_agreement where id = $1', [id]
  )).rows[0];
  if (!a) return NextResponse.json({ error: 'agreement not found' }, { status: 404 });

  const sub = (await query(
    `select id, status, answers from ops.tech_request_submission where agreement_id = $1
     order by case status when 'approved' then 3 when 'finalized' then 2 when 'saved' then 1 else 0 end desc, created_at desc limit 1`,
    [id]
  )).rows[0] || null;

  const formType = formTypeFor(a.agreement_type);
  const values = { ...autofillFromAgreement(a), ...((sub && sub.answers) || {}) };
  return NextResponse.json({
    agreement_id: a.id,
    project_number: a.project_number,
    agreement_type: a.agreement_type,
    form_type: formType,
    counterparty: a.counterparty,
    sections: schemaFor(a.agreement_type),
    values,
    submission: sub,
    locked: sub?.status === 'finalized' || sub?.status === 'approved',
    can_approve: sub?.status === 'finalized',
    jotform_form_id: JOTFORM_IDS[formType],
    jotform_form_title: FORM_TITLES[formType],
  });
}
