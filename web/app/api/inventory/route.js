import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// China SKU inventory, grouped by the SKU's product-family prefix (category).
// Returns the rows for one count period plus the category breakdown so the
// page can search/filter client-side. Any signed-in user may read it.
export async function GET(req) {
  const { response } = await requireUser();
  if (response) return response;

  let periods = [];
  try {
    periods = (await query(`select distinct count_period from inventory.cn_sku order by count_period desc`)).rows.map((r) => r.count_period);
  } catch {
    return NextResponse.json({ period: null, periods: [], categories: [], rows: [] });
  }
  if (!periods.length) return NextResponse.json({ period: null, periods: [], categories: [], rows: [] });

  const want = new URL(req.url).searchParams.get('period');
  const period = want && periods.includes(want) ? want : periods[0];

  const rows = (await query(
    `select product_name, sku, type, category, quantity, location
       from inventory.cn_sku where count_period = $1
      order by category nulls last, product_name`,
    [period],
  )).rows;

  const catMap = {};
  for (const r of rows) { const c = r.category || 'Other'; catMap[c] = (catMap[c] || 0) + 1; }
  const categories = Object.entries(catMap).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);

  return NextResponse.json({ period, periods, categories, rows });
}
