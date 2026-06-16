import { NextResponse } from 'next/server';
import { pool, query } from '../../../lib/db';
import { extractAgreement, headlineFields } from '../../../lib/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_COLS = `id, project_number, filename, status, error, agreement_type, title,
  counterparty, contract_value, currency, robot_types, robot_count, salesman_name,
  salesman_email, deal_id, extract_method, created_at`;

export async function GET() {
  const { rows } = await query(
    `select ${LIST_COLS} from ops.legal_agreement order by created_at desc limit 100`
  );
  return NextResponse.json({ agreements: rows, count: rows.length });
}

export async function POST(request) {
  const form = await request.formData();
  const file = form.get('file');
  const salesman_name = String(form.get('salesman_name') || '').trim() || null;
  const salesman_email = String(form.get('salesman_email') || '').trim() || null;
  const deal_id = String(form.get('deal_id') || '').trim() || null;
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || 'application/pdf';

  // PDF → Claude → structured fields.
  const { ok, extracted, extract_method, error } = await extractAgreement(bytes);
  const hf = ok ? headlineFields(extracted) : {};

  const { rows } = await query(
    `insert into ops.legal_agreement
      (filename, file_size, extract_method, uploaded_by, salesman_name, salesman_email, deal_id,
       status, error, agreement_type, title, counterparty, effective_date, execution_date,
       expiration_date, auto_renewal, contract_value, currency, governing_law,
       termination_notice_days, robot_types, robot_count, summary, extracted_json,
       source_pdf, content_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     returning ${LIST_COLS}, extracted_json as extracted, summary`,
    [
      file.name || 'document.pdf', bytes.length, extract_method, 'admin',
      salesman_name, salesman_email, deal_id,
      ok ? 'ready' : 'error', error,
      hf.agreement_type ?? null, hf.title ?? null, hf.counterparty ?? null,
      hf.effective_date ?? null, hf.execution_date ?? null, hf.expiration_date ?? null,
      hf.auto_renewal ?? null, hf.contract_value ?? null, hf.currency ?? 'USD',
      hf.governing_law ?? null, hf.termination_notice_days ?? null,
      hf.robot_types ?? null, hf.robot_count ?? null, hf.summary ?? null,
      JSON.stringify(extracted || {}), bytes, contentType,
    ]
  );
  return NextResponse.json(rows[0]);
}
