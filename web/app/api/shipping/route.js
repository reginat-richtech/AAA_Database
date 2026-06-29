import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query, mutateAs } from '../../../lib/db';
import { normName, normSo } from '../../../lib/projectStages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'shipped', 'delivered'];
// Proposal addresses come from JotForm as HTML ("Street Address: x<br>City: y<br>…").
const htmlToText = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
const orNull = (v) => { const s = String(v ?? '').trim(); return s || null; };
const numOrNull = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : null; };
const dateOrNull = (v) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 10) : null; };

// Shipping stage: projects whose inventory has been checked out (their 'shipping'
// prep task is done) are ready to ship. Each gets a shipment record (or null) plus
// autofill defaults (recipient + address) pulled from the agreement / proposal.
export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  const canEdit = user.isAdmin || user.department === 'inventory';

  // Checked-out agreements (shipping prep done), newest first.
  const projects = (await query(
    `select a.id::text as id, a.project_number, a.title, a.counterparty, a.contract_number, t.done_at as checked_out_at,
            a.extracted_json->>'client_contact_name' as client_contact_name,
            a.extracted_json->>'client_email'        as client_email,
            a.extracted_json->>'client_phone'        as client_phone,
            a.extracted_json->>'client_address'      as client_address
       from ops.legal_agreement a
       join ext.task t on t.project_id = a.id::text and t.auto_key = 'shipping' and t.status = 'done'
      order by t.done_at desc nulls last limit 300`,
  )).rows;

  const ids = projects.map((p) => p.id);
  let shipments = {};
  if (ids.length) {
    const rows = (await query(`select * from ops.shipment where project_id = any($1::text[])`, [ids])).rows;
    for (const s of rows) shipments[s.project_id] = s;
  }

  // Proposals → richer address/recipient fallback (matched like the Project Tracker:
  // by contract number first, then customer name).
  let propByContract = {}, propByCustomer = {};
  try {
    const props = (await query(
      `select contract_number, customer_name, customer_email, address from ops.project_proposal`,
    )).rows;
    for (const p of props) {
      const cn = normSo(p.contract_number); if (cn && !(cn in propByContract)) propByContract[cn] = p;
      const ck = normName(p.customer_name); if (ck && !(ck in propByCustomer)) propByCustomer[ck] = p;
    }
  } catch { /* 0170 not present */ }

  const out = projects.map((p) => {
    const prop = (p.contract_number && propByContract[normSo(p.contract_number)]) || propByCustomer[normName(p.counterparty)] || null;
    return {
      id: p.id, project_number: p.project_number, title: p.title, counterparty: p.counterparty,
      checked_out_at: p.checked_out_at,
      shipment: shipments[p.id] || null,
      autofill: {
        recipient_name: p.client_contact_name || prop?.customer_name || p.counterparty || '',
        recipient_email: p.client_email || prop?.customer_email || '',
        recipient_phone: p.client_phone || '',
        address: p.client_address || htmlToText(prop?.address) || '',
      },
    };
  });

  return NextResponse.json({ canEdit, projects: out });
}

// Create / update a project's shipment. Admins + inventory team.
export async function PATCH(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!(user.isAdmin || user.department === 'inventory')) {
    return NextResponse.json({ error: 'Only admins or the inventory team can edit shipping.' }, { status: 403 });
  }
  const b = await req.json().catch(() => ({}));
  const projectId = orNull(b.project_id);
  if (!projectId) return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
  const proj = (await query('select id from ops.legal_agreement where id::text = $1', [projectId])).rows[0];
  if (!proj) return NextResponse.json({ error: 'Unknown project.' }, { status: 404 });

  const status = STATUSES.includes(b.status) ? b.status : 'pending';
  // No carrier shipment (on-site/pickup) → clear carrier-specific fields; address +
  // estimated arrival date are always kept.
  const shippingNeeded = b.shipping_needed !== false;
  const vals = [
    projectId, orNull(b.recipient_name), orNull(b.recipient_email), orNull(b.recipient_phone),
    orNull(b.address),
    shippingNeeded ? orNull(b.carrier) : null,
    shippingNeeded ? orNull(b.tracking_number) : null,
    shippingNeeded ? numOrNull(b.est_cost) : null,
    orNull(b.currency) || 'USD',
    shippingNeeded ? dateOrNull(b.est_ship_date) : null,
    dateOrNull(b.est_delivery_date), status, orNull(b.notes), shippingNeeded, user.email,
  ];

  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `insert into ops.shipment
         (project_id, recipient_name, recipient_email, recipient_phone, address, carrier, tracking_number,
          est_cost, currency, est_ship_date, est_delivery_date, status, notes, shipping_needed, created_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       on conflict (project_id) do update set
         recipient_name = excluded.recipient_name, recipient_email = excluded.recipient_email,
         recipient_phone = excluded.recipient_phone, address = excluded.address, carrier = excluded.carrier,
         tracking_number = excluded.tracking_number, est_cost = excluded.est_cost, currency = excluded.currency,
         est_ship_date = excluded.est_ship_date, est_delivery_date = excluded.est_delivery_date,
         status = excluded.status, notes = excluded.notes, shipping_needed = excluded.shipping_needed, updated_at = now()
       returning *`,
      vals,
    );
    return rows[0];
  });
  return NextResponse.json(row);
}
