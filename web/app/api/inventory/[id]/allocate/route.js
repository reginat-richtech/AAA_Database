import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query, mutateAs } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A project's inventory is "ended" (locked) once its 'shipping' prep task is done.
async function inventoryEnded(projectId) {
  try {
    const { rows } = await query(
      `select 1 from ext.task where project_id = $1 and auto_key = 'shipping' and status = 'done' limit 1`,
      [projectId],
    );
    return rows.length > 0;
  } catch { return false; } // ext.task not present → not locked
}

// Allocate an inventory item to a project. Admins + inventory department only.
export async function POST(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!(user.isAdmin || user.department === 'inventory')) {
    return NextResponse.json({ error: 'Only admins or the inventory team can allocate inventory.' }, { status: 403 });
  }
  const { id } = await params;
  const item = (await query('select id, sku, product_name from inventory.cn_sku where id = $1::bigint', [id])).rows[0];
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const project_id = b.project_id ? String(b.project_id) : null;
  if (!project_id) return NextResponse.json({ error: 'Pick a project.' }, { status: 400 });
  // A project may be an agreement OR a proposal-only entry (no agreement yet), so
  // the inventory team can prep from the proposal before the agreement lands.
  let proj = (await query('select id from ops.legal_agreement where id::text = $1', [project_id])).rows[0];
  if (!proj) { try { proj = (await query('select id from ops.project_proposal where id::text = $1', [project_id])).rows[0]; } catch { /* 0170 not migrated */ } }
  if (!proj) return NextResponse.json({ error: 'Project not found.' }, { status: 400 });

  // Locked once inventory is ended (the project's 'shipping' prep task is done).
  if (await inventoryEnded(project_id)) {
    return NextResponse.json({ error: 'Inventory for this project is ended (locked). Reopen it to make changes.' }, { status: 409 });
  }

  const qn = Number(String(b.quantity ?? '').trim());
  const quantity = Number.isFinite(qn) ? qn : null;
  const note = b.note ? String(b.note).slice(0, 500) : null;

  // Shopping-cart merge: if this SKU is already in the project's (un-consumed) cart,
  // add to that line's quantity instead of creating a duplicate row.
  const row = await mutateAs(user.email, async (q) => {
    const existing = (await q(
      `select id from inventory.project_allocation
        where project_id = $1 and cn_sku_id = $2 and consumed_at is null
        order by created_at limit 1`,
      [project_id, item.id],
    )).rows[0];
    if (existing) {
      const { rows } = await q(
        `update inventory.project_allocation
            set quantity = coalesce(quantity, 0) + coalesce($1::numeric, 0),
                note = coalesce($2, note)
          where id = $3 returning id, project_id, cn_sku_id, quantity`,
        [quantity, note, existing.id],
      );
      return rows[0];
    }
    const { rows } = await q(
      `insert into inventory.project_allocation (project_id, cn_sku_id, sku, product_name, quantity, note, added_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning id, project_id, cn_sku_id, quantity`,
      [project_id, item.id, item.sku, item.product_name, quantity, note, user.email],
    );
    return rows[0];
  });
  return NextResponse.json(row);
}
