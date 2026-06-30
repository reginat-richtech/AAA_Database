import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query, mutateAs } from '../../../lib/db';
import { qbStatus, qbApiRequest, qbFetchItems, qbSearchCustomers, qbFetchProjectManagers, qbFetchEmployees, qbFetchClasses, qbFetchSalesCustomFields } from '../../../lib/integrations/qbAuth';
import { normName, normSo } from '../../../lib/projectStages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const htmlToText = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
const orNull = (v) => { const s = String(v ?? '').trim(); return s || null; };
const numOrNull = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : null; };
const dateOrNull = (v) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 10) : null; };

// Only admins / sales / finance handle invoices.
function canInvoice(user) { return user.isAdmin || ['sales', 'finance'].includes(user.department); }

function normLines(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 200).map((l) => ({
    sku: orNull(l?.sku),
    product_name: (String(l?.product_name || '').trim().slice(0, 300)) || null,
    description: (String(l?.description || '').trim().slice(0, 1000)) || null,
    service_date: (l?.service_date ? String(l.service_date).slice(0, 10) : null),
    quantity: Number(l?.quantity) >= 0 ? Number(l.quantity) : 1,
    unit_price: Number(l?.unit_price) >= 0 ? Number(l.unit_price) : 0,
    amount: (l?.amount !== undefined && l?.amount !== null && l?.amount !== '') ? Number(l.amount) : null,
    taxable: l?.taxable !== false,
    cn_sku_id: l?.cn_sku_id ?? null,
    qb_item_id: l?.qb_item_id ? String(l.qb_item_id) : null,
  })).filter((l) => l.sku || l.product_name || l.description);
}

const INV_COLS = `id, project_id, status, currency, lines, notes, customer_name, customer_email,
  billing_address, shipping_address, invoice_number, invoice_date, due_date, terms, customer_message,
  po_number, payment_instructions, project_manager, tags, class_name, discount_type, discount_value, tax_rate, confirmed_by, confirmed_at,
  qb_invoice_id, qb_doc_number, pushed_at, push_error, created_by, created_at, updated_at`;

const normTags = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);

export async function GET(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canInvoice(user)) return NextResponse.json({ error: 'Invoices are limited to admins, sales and finance.' }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const seedId = params.get('seed');
  if (seedId) return NextResponse.json({ seed: await seedFromProject(seedId) });
  // Server-side customer search (QuickBooks has 2000+ customers — too many to preload).
  const custSearch = params.get('customer_search');
  if (custSearch != null) return NextResponse.json({ customers: (await qbSearchCustomers(custSearch)).customers || [] });

  const invoices = (await query(`select ${INV_COLS} from ops.invoice order by created_at desc limit 500`)).rows;
  const projects = (await query(
    `select id::text as id, project_number, title, counterparty from ops.legal_agreement order by created_at desc limit 500`,
  )).rows;

  // Product list to search when adding line items (current stock period of cn_sku).
  let products = [];
  try {
    products = (await query(
      `select id, sku, product_name, product_line, category from inventory.cn_sku
         where count_period = (select count_period from inventory.cn_sku order by count_period desc limit 1)
         order by product_name`,
    )).rows;
  } catch { products = []; }

  // Customer list to search — deduped from agreements + proposals.
  const custMap = {};
  const ags = (await query(
    `select counterparty as name, extracted_json->>'client_email' as email, extracted_json->>'client_address' as address
       from ops.legal_agreement where counterparty is not null`,
  )).rows;
  for (const a of ags) { const k = normName(a.name); if (k && !custMap[k]) custMap[k] = { name: a.name, email: a.email || '', address: a.address || '' }; }
  try {
    const props = (await query('select customer_name as name, customer_email as email, address from ops.project_proposal where customer_name is not null')).rows;
    for (const p of props) {
      const k = normName(p.name); if (!k) continue;
      if (!custMap[k]) custMap[k] = { name: p.name, email: p.email || '', address: htmlToText(p.address) || '' };
      else { if (!custMap[k].email) custMap[k].email = p.email || ''; if (!custMap[k].address) custMap[k].address = htmlToText(p.address) || ''; }
    }
  } catch { /* 0170 absent */ }
  // QuickBooks data — only when connected (best-effort, degrades to []).
  const qb = await qbStatus();
  let qbItems = [];
  let qbProjectManagers = [];
  let qbEmployees = [];
  let qbClasses = [];
  if (qb.connected) {
    // NOTE: QB customers are NOT preloaded (2000+) — searched server-side via ?customer_search=.
    try { qbItems = (await qbFetchItems()).items || []; } catch { qbItems = []; }
    try { qbProjectManagers = (await qbFetchProjectManagers()).managers || []; } catch { qbProjectManagers = []; }
    try { qbEmployees = (await qbFetchEmployees()).employees || []; } catch { qbEmployees = []; }
    try { qbClasses = (await qbFetchClasses()).classes || []; } catch { qbClasses = []; }
  }
  const customers = Object.values(custMap).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return NextResponse.json({ canEdit: true, invoices, projects, products, customers, qbItems, qbProjectManagers, qbEmployees, qbClasses, qb });
}

// Build autofill (customer + addresses + line items) from a project.
async function seedFromProject(projectId) {
  const ag = (await query(
    `select id::text as id, project_number, title, counterparty, salesman_email, contract_number,
            extracted_json->>'client_email' as client_email, extracted_json->>'client_address' as client_address
       from ops.legal_agreement where id::text = $1`, [projectId],
  )).rows[0];
  if (!ag) return null;
  let prop = null;
  try {
    const props = (await query('select id::text as id, contract_number, customer_name, customer_email, address, deal_customer from ops.project_proposal')).rows;
    const byC = {}, byN = {};
    for (const p of props) { const c = normSo(p.contract_number); if (c && !(c in byC)) byC[c] = p; const n = normName(p.customer_name); if (n && !(n in byN)) byN[n] = p; }
    prop = (ag.contract_number && byC[normSo(ag.contract_number)]) || byN[normName(ag.counterparty)] || null;
  } catch { /* 0170 absent */ }
  // Inventory line items — the project's pick-list. Cart lines can sit under the
  // agreement id OR the pre-agreement proposal id (same as checkout), so pull both.
  // When the list has been "fixed" (checked out — stock consumed, cart locked),
  // those consumed rows are the authoritative bill-for list; prefer them. Otherwise
  // fall back to the current (not-yet-checked-out) allocations so it still autofills.
  const allocIds = [projectId];
  if (prop?.id && prop.id !== projectId) allocIds.push(prop.id);
  const allocs = (await query(
    `select sku, product_name, coalesce(quantity,0) as quantity, cn_sku_id, consumed_at
       from inventory.project_allocation
      where project_id = any($1::text[]) and cn_sku_id is not null order by created_at`, [allocIds],
  )).rows;
  const consumed = allocs.filter((r) => r.consumed_at);
  const inventory_fixed = consumed.length > 0;     // the cart has been checked out
  const cart = inventory_fixed ? consumed : allocs; // bill for the fixed list when present
  // The customer + address can come from several sources that often disagree: the
  // Final Proposal Form (the project's own intake), the connected HubSpot deal, and
  // the signed agreement (whose extracted fields can be junk/placeholder — e.g. an
  // address of "RR"). Rather than silently pick one, return a per-field list of
  // suggestions the UI offers as one-click chips, and DEFAULT each field to the
  // Final Proposal Form value (most authoritative for the project), falling back to
  // the next available source only when the proposal's value is blank.
  const company = prop?.deal_customer?.company || {};
  const contact = prop?.deal_customer?.contact || {};
  const dedup = (arr) => {
    const seen = new Set(); const out = [];
    for (const x of arr) {
      const value = (x.value == null ? '' : String(x.value)).trim();
      if (value && !seen.has(value.toLowerCase())) { seen.add(value.toLowerCase()); out.push({ source: x.source, label: x.label, value }); }
    }
    return out;
  };
  const PF = 'Final Proposal Form', HS = 'HubSpot deal', AG = 'Agreement';
  const sName = dedup([
    { source: 'proposal', label: PF, value: prop?.customer_name },
    { source: 'hubspot', label: HS, value: company.name },
    { source: 'agreement', label: AG, value: ag.counterparty },
  ]);
  const sEmail = dedup([
    { source: 'proposal', label: PF, value: prop?.customer_email },
    { source: 'hubspot', label: HS, value: contact.email },
    { source: 'agreement', label: AG, value: ag.client_email },
  ]);
  const sAddr = dedup([
    { source: 'proposal', label: PF, value: htmlToText(prop?.address) },
    { source: 'hubspot', label: HS, value: company.address },
    { source: 'agreement', label: AG, value: ag.client_address },
  ]);
  // Default = the Final Proposal Form value when present, else the first available.
  const pref = (list) => (list.find((x) => x.source === 'proposal') || list[0])?.value || '';
  return {
    project_id: ag.id, project_number: ag.project_number,
    customer_name: pref(sName),
    customer_email: pref(sEmail),
    billing_address: pref(sAddr),
    shipping_address: pref(sAddr),
    suggest: { customer_name: sName, customer_email: sEmail, billing_address: sAddr, shipping_address: sAddr },
    inventory_fixed,                 // true → lines came from a checked-out (locked) cart
    inventory_count: cart.length,    // how many inventory lines were autofilled
    lines: cart.map((c) => ({ sku: c.sku, product_name: c.product_name, description: '', quantity: Number(c.quantity) || 1, unit_price: 0, taxable: true, cn_sku_id: c.cn_sku_id })),
  };
}

export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canInvoice(user)) return NextResponse.json({ error: 'Invoices are limited to admins, sales and finance.' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const action = b.action || 'save';
  const id = b.id ? String(b.id) : null;

  if (action === 'delete') {
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await mutateAs(user.email, (q) => q('delete from ops.invoice where id = $1', [id]));
    return NextResponse.json({ ok: true });
  }

  const current = id ? (await query(`select ${INV_COLS} from ops.invoice where id = $1`, [id])).rows[0] : null;
  if (id && !current) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  if (action === 'push') return pushToQb(current, user);

  if (current?.status === 'pushed' && action !== 'reopen') {
    return NextResponse.json({ error: 'This invoice was pushed to QuickBooks. Reopen it to edit.' }, { status: 409 });
  }

  const lines = b.lines !== undefined ? normLines(b.lines) : (current?.lines || []);
  let status = 'draft', stampConfirm = false;
  if (action === 'confirm') {
    if (!orNull(b.customer_name) && !current?.customer_name) return NextResponse.json({ error: 'Customer is required.' }, { status: 400 });
    if (!lines.length) return NextResponse.json({ error: 'Add at least one line item.' }, { status: 400 });
    status = 'confirmed'; stampConfirm = true;
  } else if (action === 'reopen') {
    status = 'draft';
  }

  // Field set (use body value if present, else keep current).
  const f = (k, fn = orNull) => (b[k] !== undefined ? fn(b[k]) : (current?.[k] ?? null));
  const vals = [
    id, f('project_id'), status, f('currency') || current?.currency || 'USD', JSON.stringify(lines), f('notes'),
    f('customer_name'), f('customer_email'), f('billing_address'), f('shipping_address'),
    f('invoice_number'), f('invoice_date', dateOrNull), f('due_date', dateOrNull), f('terms'), f('customer_message'),
    f('discount_type'), f('discount_value', numOrNull), f('tax_rate', numOrNull),
    stampConfirm ? user.email : (current?.confirmed_by ?? null), user.email,
    f('po_number'), f('payment_instructions'),
    JSON.stringify(b.tags !== undefined ? normTags(b.tags) : (current?.tags || [])), f('class_name'),
    f('project_manager'),
  ];

  const row = await mutateAs(user.email, async (q) => {
    if (id) {
      const { rows } = await q(
        `update ops.invoice set project_id=$2, status=$3, currency=$4, lines=$5::jsonb, notes=$6,
           customer_name=$7, customer_email=$8, billing_address=$9, shipping_address=$10, invoice_number=$11,
           invoice_date=$12, due_date=$13, terms=$14, customer_message=$15, discount_type=$16, discount_value=$17,
           tax_rate=$18, confirmed_by=$19, po_number=$21, payment_instructions=$22, tags=$23::jsonb, class_name=$24,
           project_manager=$25, confirmed_at=${stampConfirm ? 'now()' : 'confirmed_at'}, updated_at=now()
         where id=$1 returning ${INV_COLS}`,
        vals,
      );
      return rows[0];
    }
    const { rows } = await q(
      `insert into ops.invoice (project_id, status, currency, lines, notes, customer_name, customer_email,
         billing_address, shipping_address, invoice_number, invoice_date, due_date, terms, customer_message,
         discount_type, discount_value, tax_rate, confirmed_by, confirmed_at, created_by, po_number, payment_instructions, tags, class_name, project_manager, updated_at)
       values ($2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,
         coalesce($11, 'INV-' || lpad(nextval('ops.invoice_number_seq')::text, 4, '0')),
         $12,$13,$14,$15,$16,$17,$18,$19, ${stampConfirm ? 'now()' : 'null'}, $20, $21, $22, $23::jsonb, $24, $25, now())
       returning ${INV_COLS}`,
      vals,
    );
    return rows[0];
  });
  return NextResponse.json(row);
}

// Push a confirmed invoice to QuickBooks (best-effort; needs QB connected).
async function pushToQb(inv, user) {
  if (!inv) return NextResponse.json({ error: 'Save the invoice first.' }, { status: 400 });
  if (inv.status === 'draft') return NextResponse.json({ error: 'Confirm the invoice before pushing.' }, { status: 409 });
  if (inv.status === 'pushed') return NextResponse.json({ error: 'Already pushed.' }, { status: 409 });
  const lines = inv.lines || [];
  if (!lines.length) return NextResponse.json({ error: 'No line items.' }, { status: 400 });

  const custName = String(inv.customer_name || 'Customer').slice(0, 100);
  const safe = custName.replace(/['\\]/g, ' ');
  let r = await qbApiRequest(`/query?query=${encodeURIComponent(`select * from Customer where DisplayName = '${safe}'`)}`);
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });
  let customerId = r.data?.QueryResponse?.Customer?.[0]?.Id;
  if (!customerId) {
    const c = await qbApiRequest('/customer', { method: 'POST', body: { DisplayName: custName, ...(inv.customer_email ? { PrimaryEmailAddr: { Address: inv.customer_email } } : {}) } });
    if (c.error) return NextResponse.json({ error: `Create customer: ${c.error}` }, { status: 502 });
    customerId = c.data?.Customer?.Id;
  }
  // Each line uses its own QB item (picked from the price list) when set; otherwise
  // fall back to the first available item (looked up only if needed).
  let fallbackItem = null;
  const needFallback = lines.some((l) => !l.qb_item_id);
  if (needFallback) {
    let ir = await qbApiRequest(`/query?query=${encodeURIComponent("select * from Item where Type = 'Service' maxresults 1")}`);
    fallbackItem = ir.data?.QueryResponse?.Item?.[0]?.Id;
    if (!fallbackItem) { ir = await qbApiRequest(`/query?query=${encodeURIComponent('select * from Item maxresults 1')}`); fallbackItem = ir.data?.QueryResponse?.Item?.[0]?.Id; }
    if (!fallbackItem) return NextResponse.json({ error: 'No QuickBooks Item found — create at least one Item/Service in QuickBooks, or pick items from the price list.' }, { status: 502 });
  }

  // Class → QB ClassRef (looked up by name, best-effort).
  let classId = null;
  if (inv.class_name) {
    const cr = await qbApiRequest(`/query?query=${encodeURIComponent(`select * from Class where Name = '${String(inv.class_name).replace(/['\\]/g, ' ')}'`)}`);
    classId = cr.data?.QueryResponse?.Class?.[0]?.Id || null;
  }
  const qbLines = lines.map((l) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: l.amount != null ? Number(l.amount) : (Number(l.quantity) || 1) * (Number(l.unit_price) || 0),
    Description: [l.sku, l.product_name, l.description].filter(Boolean).join(' — ').slice(0, 1000),
    SalesItemLineDetail: {
      ItemRef: { value: String(l.qb_item_id || fallbackItem) },
      Qty: Number(l.quantity) || 1, UnitPrice: Number(l.unit_price) || 0,
      ...(l.service_date ? { ServiceDate: String(l.service_date).slice(0, 10) } : {}),
      ...(classId ? { ClassRef: { value: classId } } : {}),
    },
  }));
  // Map P.O. Number + Project Manager into real QB sales custom fields when ones
  // exist (matched by name); QB custom-field StringValue maxes at 31 chars.
  let cfDefs = [];
  try { cfDefs = (await qbFetchSalesCustomFields()).fields || []; } catch { cfDefs = []; }
  const findCF = (re) => cfDefs.find((c) => re.test(c.name));
  const poF = inv.po_number ? findCF(/p\.?\s*o\.?|purchase\s*order/i) : null;
  const pmF = inv.project_manager ? findCF(/project\s*manager|\bpm\b|manager/i) : null;
  const customFields = [];
  if (poF) customFields.push({ DefinitionId: poF.id, Name: poF.name, Type: 'StringType', StringValue: String(inv.po_number).slice(0, 31) });
  if (pmF) customFields.push({ DefinitionId: pmF.id, Name: pmF.name, Type: 'StringType', StringValue: String(inv.project_manager).slice(0, 31) });

  const memo = [inv.customer_message, inv.payment_instructions].filter(Boolean).join('\n\n');
  // PrivateNote carries whatever has no native QB field: Tags always (no Tag API),
  // and PO/PM only if they didn't land in a custom field above.
  const priv = [
    inv.notes,
    (inv.po_number && !poF) ? `PO: ${inv.po_number}` : '',
    (inv.project_manager && !pmF) ? `Project Manager: ${inv.project_manager}` : '',
    inv.tags?.length ? `Tags: ${inv.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  const body = {
    CustomerRef: { value: String(customerId) },
    Line: qbLines,
    ...(customFields.length ? { CustomField: customFields } : {}),
    ...(inv.customer_email ? { BillEmail: { Address: inv.customer_email } } : {}),
    ...(inv.invoice_date ? { TxnDate: String(inv.invoice_date).slice(0, 10) } : {}),
    ...(inv.due_date ? { DueDate: String(inv.due_date).slice(0, 10) } : {}),
    ...(inv.invoice_number ? { DocNumber: String(inv.invoice_number).slice(0, 21) } : {}),
    ...(memo ? { CustomerMemo: { value: memo.slice(0, 1000) } } : {}),
    ...(priv ? { PrivateNote: priv.slice(0, 4000) } : {}),
  };
  const out = await qbApiRequest('/invoice', { method: 'POST', body });
  if (out.error) {
    await mutateAs(user.email, (q) => q('update ops.invoice set push_error=$2, updated_at=now() where id=$1', [inv.id, out.error]));
    return NextResponse.json({ error: `QuickBooks: ${out.error}` }, { status: 502 });
  }
  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `update ops.invoice set status='pushed', qb_invoice_id=$2, qb_doc_number=$3, push_error=null, pushed_at=now(), updated_at=now() where id=$1 returning ${INV_COLS}`,
      [inv.id, out.data?.Invoice?.Id || null, out.data?.Invoice?.DocNumber || null],
    );
    return rows[0];
  });
  return NextResponse.json({ ...row, pushed: true });
}
