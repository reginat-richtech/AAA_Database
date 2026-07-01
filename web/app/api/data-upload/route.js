import { NextResponse } from 'next/server';
import { pool, query, mutateAs } from '../../../lib/db';
import { extractAgreement, headlineFields } from '../../../lib/extract';
import { requireUser, visibilitySql } from '../../../lib/access';
import { sendEmail } from '../../../lib/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Escape values interpolated into the notification email's HTML body.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Best-effort: email the salesperson a link to the Technician Request Form once
// their agreement is in. Never throws — a mail problem must not fail the upload.
async function notifySalesperson(row) {
  if (!row?.salesman_email) return { skipped: 'no salesman_email on agreement' };
  const base = (process.env.AUTH_URL || '').replace(/\/$/, '');
  if (!base) return { skipped: 'AUTH_URL not set — cannot build an absolute link' };
  const link = `${base}/tech-request?agreement=${row.id}`;
  const customer = row.counterparty || row.title || 'the customer';
  const html =
    `<p>Hi ${esc(row.salesman_name) || 'there'},</p>` +
    `<p>The agreement for <strong>${esc(customer)}</strong> (${esc(row.project_number)}) has been submitted.</p>` +
    `<p>Please complete the <strong>Technician Request Form</strong> to move the project to the next stage:</p>` +
    `<p><a href="${esc(link)}">${esc(link)}</a></p>` +
    `<p style="color:#888;font-size:12px">— AAA Project Tracker</p>`;
  try {
    return await sendEmail({
      to: row.salesman_email,
      subject: `Action needed: Technician Request for ${row.project_number}`,
      text: `The agreement for ${customer} (${row.project_number}) is in. Complete the Technician Request Form: ${link}`,
      html,
    });
  } catch (e) {
    return { to: row.salesman_email, error: String(e?.message || e) };
  }
}

const LIST_COLS = `id, project_number, filename, status, error, agreement_type, title,
  counterparty, contract_value, currency, robot_types, robot_count, salesman_name,
  salesman_email, deal_id, extract_method, created_at`;

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  const vis = visibilitySql(user, 1);

  const { rows } = await query(
    `select ${LIST_COLS} from ops.legal_agreement where ${vis.sql} order by created_at desc limit 100`,
    vis.params
  );
  return NextResponse.json({ agreements: rows, count: rows.length });
}

export async function POST(request) {
  const { user, response } = await requireUser();
  if (response) return response;
  const form = await request.formData();
  const file = form.get('file');
  const salesman_name = String(form.get('salesman_name') || '').trim() || null;
  const salesman_email = String(form.get('salesman_email') || '').trim() || null;
  const deal_id = String(form.get('deal_id') || '').trim() || null;
  // Contract/SO # of the proposal this agreement is for (carried by the tracker's
  // "+ Upload agreement" link). Drives "submit once": one agreement per contract.
  const contract_number = String(form.get('contract') || '').trim() || null;
  // The proposal this agreement was started from (carried by the tracker's
  // "+ Upload agreement" link). Stored so the tracker attaches agreement→proposal
  // by id — reliable even when there's no contract number and names differ.
  const proposal_id = String(form.get('proposal_id') || '').trim() || null;
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'A PDF file is required.' }, { status: 400 });
  }
  if (contract_number) {
    const dup = (await query(
      'select project_number from ops.legal_agreement where lower(contract_number) = lower($1) limit 1',
      [contract_number],
    )).rows[0];
    if (dup) {
      return NextResponse.json(
        { error: `An agreement for contract ${contract_number} was already submitted (${dup.project_number}). Open that one to edit it.` },
        { status: 409 },
      );
    }
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || 'application/pdf';

  // PDF → Claude → structured fields.
  const { ok, extracted, extract_method, error } = await extractAgreement(bytes);
  const hf = ok ? headlineFields(extracted) : {};

  let row;
  try {
    row = await mutateAs(user.email, async (q) => {
      const { rows } = await q(
        `insert into ops.legal_agreement
          (filename, file_size, extract_method, uploaded_by, salesman_name, salesman_email, deal_id,
           status, error, agreement_type, title, counterparty, effective_date, execution_date,
           expiration_date, auto_renewal, contract_value, currency, governing_law,
           termination_notice_days, robot_types, robot_count, summary, extracted_json,
           source_pdf, content_type, contract_number, proposal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         returning ${LIST_COLS}, extracted_json as extracted, summary`,
        [
          file.name || 'document.pdf', bytes.length, extract_method, user.email,
          salesman_name, salesman_email, deal_id,
          ok ? 'ready' : 'error', error,
          hf.agreement_type ?? null, hf.title ?? null, hf.counterparty ?? null,
          hf.effective_date ?? null, hf.execution_date ?? null, hf.expiration_date ?? null,
          hf.auto_renewal ?? null, hf.contract_value ?? null, hf.currency ?? 'USD',
          hf.governing_law ?? null, hf.termination_notice_days ?? null,
          hf.robot_types ?? null, hf.robot_count ?? null, hf.summary ?? null,
          JSON.stringify(extracted || {}), bytes, contentType, contract_number, proposal_id,
        ],
      );
      return rows[0];
    });
  } catch (e) {
    // Unique-index race: another agreement for this contract slipped in first.
    if (e?.code === '23505') {
      return NextResponse.json({ error: `An agreement for contract ${contract_number} already exists.` }, { status: 409 });
    }
    throw e;
  }

  // Notify the salesperson with the Technician Request link (best-effort).
  const notify = await notifySalesperson(row);
  return NextResponse.json({ ...row, notify });
}
