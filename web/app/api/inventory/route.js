import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query } from '../../../lib/db';
import { isValidSku, normalizeSku } from '../../../lib/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Derive the classification columns from a SKU + name (same rules as the bulk load).
function deriveCategory(sku) {
  const s = String(sku || '');
  if (s.includes('-')) { const seg = s.split('-')[1]; if (seg) return seg.toUpperCase(); }
  return 'Other';
}
function deriveLine(category) {
  const c = category || '';
  if (/^AD/.test(c)) return 'ADAM';
  if (/^MAT/.test(c)) return 'Matradee';
  if (/^SCO/.test(c)) return 'Scorpion';
  if (/^TIT/.test(c) || /^TT/.test(c)) return 'Titan';
  if (/^DUST/.test(c)) return 'DUST-E';
  if (/^ACE/.test(c)) return 'ACE';
  if (/^DEX/.test(c)) return 'DEX';
  return null;
}
function deriveClass(name) {
  const n = String(name || '');
  if (/^Finished Goods:/i.test(n)) return 'finished_goods';
  if (/^Raw Material/i.test(n)) return 'part';
  return 'accessory';
}

// China SKU inventory, grouped by product family / category / class. Anyone may
// read; only admins + the inventory department may add/delete/allocate.
export async function GET(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  const canEdit = user.isAdmin || user.department === 'inventory';

  let periods = [];
  try {
    periods = (await query(`select distinct count_period from inventory.cn_sku order by count_period desc`)).rows.map((r) => r.count_period);
  } catch {
    return NextResponse.json({ period: null, periods: [], categories: [], productLines: [], itemClasses: [], catalog: [], projects: [], allocations: [], canEdit, rows: [] });
  }
  if (!periods.length) return NextResponse.json({ period: null, periods: [], categories: [], productLines: [], itemClasses: [], catalog: [], projects: [], allocations: [], canEdit, rows: [] });

  const want = new URL(req.url).searchParams.get('period');
  const period = want && periods.includes(want) ? want : periods[0];

  const rows = (await query(
    `select id, product_name, sku, type, category, product_line, item_class, quantity, location
       from inventory.cn_sku where count_period = $1
      order by product_line nulls last, category nulls last, product_name`,
    [period],
  )).rows;

  const catMap = {}, lineMap = {}, classMap = {};
  for (const r of rows) {
    catMap[r.category || 'Other'] = (catMap[r.category || 'Other'] || 0) + 1;
    lineMap[r.product_line || 'Other'] = (lineMap[r.product_line || 'Other'] || 0) + 1;
    classMap[r.item_class || 'unclassified'] = (classMap[r.item_class || 'unclassified'] || 0) + 1;
  }
  const categories = Object.entries(catMap).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  const productLines = Object.entries(lineMap).map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count);
  const itemClasses = Object.entries(classMap).map(([item_class, count]) => ({ item_class, count })).sort((a, b) => b.count - a.count);

  let catalog = [];
  try { catalog = (await query(`select name, offering_type, product_line from inventory.product_catalog order by product_line, offering_type, name`)).rows; } catch { catalog = []; }

  // Projects (for the "add to project" picker) + existing allocations.
  let projects = [], allocations = [];
  try { projects = (await query(`select id::text as id, project_number, title, counterparty from ops.legal_agreement order by created_at desc limit 300`)).rows; } catch { projects = []; }
  try {
    allocations = (await query(
      `select a.id, a.cn_sku_id, a.project_id, a.quantity, a.note, a.added_by, l.project_number, l.title as project_title
         from inventory.project_allocation a left join ops.legal_agreement l on l.id::text = a.project_id
        order by a.created_at desc`,
    )).rows;
  } catch { allocations = []; }

  return NextResponse.json({ period, periods, categories, productLines, itemClasses, catalog, projects, allocations, canEdit, rows });
}

// Add a new inventory item (admins + inventory department only).
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!(user.isAdmin || user.department === 'inventory')) {
    return NextResponse.json({ error: 'Only admins or the inventory team can add items.' }, { status: 403 });
  }
  const b = await req.json().catch(() => ({}));
  // Every field is required.
  const product_name = String(b.product_name || '').trim().slice(0, 300);
  const sku = normalizeSku(b.sku).slice(0, 100);
  const location = String(b.location || '').trim().slice(0, 300);
  const qn = Number(String(b.quantity ?? '').trim());
  if (!product_name) return NextResponse.json({ error: 'Product name is required.' }, { status: 400 });
  if (!sku) return NextResponse.json({ error: 'SKU is required.' }, { status: 400 });
  if (!isValidSku(sku)) return NextResponse.json({ error: 'SKU must look like SE-ADAM-EC2X (SOURCE-CATEGORY-CODE).' }, { status: 400 });
  if (!Number.isFinite(qn) || qn < 0) return NextResponse.json({ error: 'Quantity is required (0 or more).' }, { status: 400 });
  if (!location) return NextResponse.json({ error: 'Location is required.' }, { status: 400 });
  const quantity = qn;

  // Default to the most recent count period so it shows with current stock.
  const periodRow = (await query(`select count_period from inventory.cn_sku order by count_period desc limit 1`)).rows[0];
  const period = periodRow?.count_period || 'June 2026';

  const category = deriveCategory(sku);
  const product_line = deriveLine(category);
  const item_class = deriveClass(product_name);

  const { rows } = await query(
    `insert into inventory.cn_sku (count_period, product_name, sku, category, product_line, item_class, quantity, location, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, product_name, sku, type, category, product_line, item_class, quantity, location`,
    [period, product_name, sku, category, product_line, item_class, quantity, location,
      JSON.stringify({ product_name, sku, quantity, location, added_by: user.email })],
  );
  return NextResponse.json(rows[0]);
}
