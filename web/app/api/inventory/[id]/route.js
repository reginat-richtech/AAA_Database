import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { mutateAs } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RET = 'id, product_name, sku, type, category, product_line, item_class, quantity, location';
const canEdit = (user) => user.isAdmin || user.department === 'inventory';

// Manage one stock item (admins + inventory department only; audited via mutateAs):
//   { delta: ±n }            load (+) / remove (−) stock
//   { quantity: n }          set exact on-hand (stock count / adjustment)
//   { location, product_name } edit fields
// Quantity is never allowed to go negative. The row is locked FOR UPDATE so two
// concurrent load/remove actions can't race on the same item.
export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canEdit(user)) return NextResponse.json({ error: 'Only admins or the inventory team can change stock.' }, { status: 403 });

  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  const hasDelta = b.delta !== undefined && b.delta !== null && b.delta !== '';
  const hasSet = b.quantity !== undefined && b.quantity !== null && b.quantity !== '';
  const delta = hasDelta ? Number(b.delta) : null;
  const setQty = hasSet ? Number(b.quantity) : null;
  if (hasDelta && !Number.isFinite(delta)) return NextResponse.json({ error: 'delta must be a number.' }, { status: 400 });
  if (hasSet && (!Number.isFinite(setQty) || setQty < 0)) return NextResponse.json({ error: 'quantity must be 0 or more.' }, { status: 400 });
  const location = b.location !== undefined ? String(b.location || '').slice(0, 300) : undefined;
  const product_name = b.product_name !== undefined ? String(b.product_name || '').trim().slice(0, 300) : undefined;

  try {
    const row = await mutateAs(user.email, async (q) => {
      const cur = (await q('select quantity from inventory.cn_sku where id = $1::bigint for update', [id])).rows[0];
      if (!cur) throw Object.assign(new Error('not found'), { http: 404 });

      let newQty = Number(cur.quantity) || 0;
      if (hasDelta) newQty += delta;
      else if (hasSet) newQty = setQty;
      if (newQty < 0) throw Object.assign(new Error('That would make the quantity negative.'), { http: 422 });

      const sets = [], vals = [];
      if (hasDelta || hasSet) { vals.push(newQty); sets.push(`quantity = $${vals.length}`); }
      if (location !== undefined) { vals.push(location || null); sets.push(`location = $${vals.length}`); }
      if (product_name) { vals.push(product_name); sets.push(`product_name = $${vals.length}`); }
      if (!sets.length) throw Object.assign(new Error('Nothing to update.'), { http: 400 });

      vals.push(id);
      return (await q(
        `update inventory.cn_sku set ${sets.join(', ')} where id = $${vals.length}::bigint returning ${RET}`,
        vals,
      )).rows[0];
    });
    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: e?.http || 500 });
  }
}

// Delete a stock item (admins + inventory department only; audited).
export async function DELETE(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!canEdit(user)) return NextResponse.json({ error: 'Only admins or the inventory team can delete items.' }, { status: 403 });

  const { id } = await params;
  try {
    const r = await mutateAs(user.email, (q) => q('delete from inventory.cn_sku where id = $1::bigint', [id]));
    if (!r.rowCount) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Most likely the item is still allocated to a project (FK), or DELETE isn't granted.
    if (e?.code === '23503') {
      return NextResponse.json({ error: 'This item is allocated to a project. Remove it from project carts first.' }, { status: 409 });
    }
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
