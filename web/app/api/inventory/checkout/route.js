import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { requireUser } from '../../../../lib/access';
import { query, mutateAs } from '../../../../lib/db';
import { PREP_AUTO_TASKS, taskPerms } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHIP = PREP_AUTO_TASKS.find((p) => p.key === 'shipping'); // {key,title,department:'inventory'}

// Upsert the project's 'shipping' prep task — the shared lock / Project-Tracker
// "Shipping preparation" step. done=true → checked out (locked); false → reopened.
async function markShipping(q, projectId, done, user) {
  await q(
    `insert into ext.task
       (id, project_id, title, department, created_by, status, priority, column_id, auto_key,
        done_by_email, done_by_name, done_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'medium',$7,$8,$9,$10, ${done ? 'now()' : 'null'}, now())
     on conflict (project_id, auto_key) do update set
       status = excluded.status, column_id = excluded.column_id,
       done_by_email = excluded.done_by_email, done_by_name = excluded.done_by_name,
       done_at = ${done ? 'now()' : 'null'}, updated_at = now()`,
    [crypto.randomUUID(), projectId, SHIP.title, SHIP.department, user.email,
      done ? 'done' : 'open', done ? 'done' : 'todo', SHIP.key,
      done ? user.email : null, done ? (user.name || user.email) : null],
  );
}

// Check out a project's inventory cart (consume stock) or reopen it (restore stock).
//   POST { project_id, proposal_id?, reopen?: bool }
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  // Inventory manager or admin only (same gate as the prep sign-off).
  if (!taskPerms(user, { department: 'inventory' }).canManage) {
    return NextResponse.json({ error: 'Only the inventory manager or an admin can check out / reopen.' }, { status: 403 });
  }

  const b = await req.json().catch(() => ({}));
  const projectId = b.project_id ? String(b.project_id) : null;
  if (!projectId) return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });
  const proj = (await query('select id from ops.legal_agreement where id::text = $1', [projectId])).rows[0];
  if (!proj) return NextResponse.json({ error: 'Unknown project (must be an agreement).' }, { status: 404 });

  // Cart lines may sit under the agreement id OR the pre-agreement proposal id.
  const ids = [projectId];
  if (b.proposal_id && String(b.proposal_id) !== projectId) ids.push(String(b.proposal_id));
  const reopen = b.reopen === true;

  try {
    const result = await mutateAs(user.email, async (q) => {
      if (!reopen) {
        // --- CHECK OUT: consume stock ---
        const lines = (await q(
          `select id, cn_sku_id, coalesce(quantity,0) as quantity
             from inventory.project_allocation
            where project_id = any($1::text[]) and consumed_at is null and cn_sku_id is not null and coalesce(quantity,0) > 0`,
          [ids],
        )).rows;
        // Sum needed per SKU.
        const need = new Map();
        for (const l of lines) need.set(l.cn_sku_id, (need.get(l.cn_sku_id) || 0) + Number(l.quantity));
        // Lock each SKU row, read stock, and block if any is short.
        const short = [];
        for (const [skuId, qty] of need) {
          const row = (await q('select product_name, coalesce(quantity,0) as quantity from inventory.cn_sku where id = $1 for update', [skuId])).rows[0];
          const avail = row ? Number(row.quantity) : 0;
          if (qty > avail) short.push({ product_name: row?.product_name || `#${skuId}`, needed: qty, available: avail });
        }
        if (short.length) { const e = new Error('SHORT_STOCK'); e.short = short; throw e; }
        // Decrement stock + mark the lines consumed.
        for (const [skuId, qty] of need) {
          await q('update inventory.cn_sku set quantity = coalesce(quantity,0) - $1 where id = $2', [qty, skuId]);
        }
        if (lines.length) {
          await q('update inventory.project_allocation set consumed_at = now() where id = any($1::bigint[])', [lines.map((l) => l.id)]);
        }
        await markShipping(q, projectId, true, user);
        return { checked_out: true, lines: lines.length };
      }
      // --- REOPEN: restore the consumed stock ---
      const lines = (await q(
        `select id, cn_sku_id, coalesce(quantity,0) as quantity
           from inventory.project_allocation
          where project_id = any($1::text[]) and consumed_at is not null and cn_sku_id is not null and coalesce(quantity,0) > 0`,
        [ids],
      )).rows;
      for (const l of lines) {
        await q('update inventory.cn_sku set quantity = coalesce(quantity,0) + $1 where id = $2', [Number(l.quantity), l.cn_sku_id]);
      }
      if (lines.length) {
        await q('update inventory.project_allocation set consumed_at = null where id = any($1::bigint[])', [lines.map((l) => l.id)]);
      }
      await markShipping(q, projectId, false, user);
      return { reopened: true, lines: lines.length };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e.short) return NextResponse.json({ error: 'Not enough stock to check out.', short: e.short }, { status: 409 });
    throw e;
  }
}
