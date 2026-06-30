import { NextResponse } from 'next/server';
import { query, mutateAs } from '../../../../lib/db';
import { requireUser } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Invoices are handled by admins / sales / finance — same gate as the /invoices module.
const canInvoice = (u) => u.isAdmin || ['sales', 'finance'].includes(u.department);

// Total of an invoice's line items (explicit amount, else qty × unit price).
const lineAmt = (l) => (l && l.amount != null && l.amount !== '' ? Number(l.amount) : (Number(l?.quantity) || 0) * (Number(l?.unit_price) || 0));
const totalOf = (lines) => (Array.isArray(lines) ? lines : []).reduce((s, l) => s + lineAmt(l), 0);

// GET ?q= — picker: existing invoices to connect, with which project (if any) each
// is already linked to. Used by the Project Tracker "connect existing invoice" box.
export async function GET(request) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canInvoice(user)) return NextResponse.json({ error: 'Invoices are limited to admins, sales and finance.' }, { status: 403 });
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  const { rows } = await query(
    `select i.id::text as id, i.invoice_number, i.qb_doc_number, i.customer_name, i.status, i.lines, i.project_id,
            coalesce(a.project_number, pp.project_number) as project_number
       from ops.invoice i
       left join ops.legal_agreement a on a.id::text = i.project_id
       left join ops.project_proposal pp on pp.id::text = i.project_id
      where ($1 = '' or i.invoice_number ilike $2 or i.customer_name ilike $2 or i.qb_doc_number ilike $2)
      order by i.created_at desc
      limit 30`,
    [q, `%${q}%`],
  );
  const invoices = rows.map((r) => ({
    id: r.id,
    number: r.invoice_number || r.qb_doc_number || null,
    customer_name: r.customer_name || null,
    status: r.status || 'draft',
    total: totalOf(r.lines),
    project_id: r.project_id || null,
    project_number: r.project_number || null,
  }));
  return NextResponse.json({ invoices });
}

// POST { project_id, invoice_id } — link an existing invoice to this project (sets
// ops.invoice.project_id). project_id null/'' → unlink the invoice. Admin/sales/finance.
export async function POST(request) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canInvoice(user)) return NextResponse.json({ error: 'Only an admin, sales or finance can connect an invoice.' }, { status: 403 });

  let body = {};
  try { body = await request.json(); } catch { /* */ }
  const invoiceId = body.invoice_id ? String(body.invoice_id) : null;
  const projectId = body.project_id ? String(body.project_id) : null; // null → unlink
  if (!invoiceId) return NextResponse.json({ error: 'invoice_id is required' }, { status: 400 });

  const inv = (await query('select id, project_id from ops.invoice where id = $1', [invoiceId])).rows[0];
  if (!inv) return NextResponse.json({ error: 'invoice not found' }, { status: 404 });

  // When linking, sanity-check the project exists (agreement or proposal id).
  if (projectId) {
    const known = (await query(
      `select 1 from ops.legal_agreement where id::text = $1
        union all select 1 from ops.project_proposal where id::text = $1 limit 1`, [projectId],
    )).rows[0];
    if (!known) return NextResponse.json({ error: 'unknown project' }, { status: 404 });
  }

  await mutateAs(user.email, (qfn) => qfn(
    'update ops.invoice set project_id = $2, updated_at = now() where id = $1', [invoiceId, projectId]));

  return NextResponse.json({ ok: true, invoice_id: invoiceId, project_id: projectId, unlinked: !projectId });
}
