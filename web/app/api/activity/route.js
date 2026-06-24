import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/access';
import { query } from '../../../lib/db';
import { ensureExtSchema } from '../../../lib/ingest/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The app's audited tables, by the bare name stored in audit.activity_log.table_name.
const APP_TABLES = ['task', 'task_update', 'task_project', 'pm_task', 'pm_sheet', 'pm_workspace', 'pm_workspace_member', 'social_post', 'social_media', 'cn_sku', 'project_allocation', 'legal_agreement', 'tech_request_submission'];
const LABELS = {
  task: 'Task', task_update: 'Task update', task_project: 'Project board',
  pm_task: 'Task', pm_sheet: 'Board', pm_workspace: 'Workspace', pm_workspace_member: 'Workspace member',
  social_post: 'Social post', social_media: 'Post attachment',
  cn_sku: 'Inventory item', project_allocation: 'Inventory allocation',
  legal_agreement: 'Project / agreement', tech_request_submission: 'Tech request',
};
// Bookkeeping columns we don't surface as user-meaningful "changes".
const SKIP = new Set(['updated_at', 'synced_at', 'created_at', 'row_hash', 'prev_hash', 'last_seen', 'raw', 'bytes', 'size']);
const labelOf = (d) => {
  if (!d) return null;
  return d.title || d.name || d.product_name || d.project_number || d.user_email || d.email || d.filename
    || (d.content ? String(d.content).slice(0, 60) : null)
    || (d.body ? String(d.body).slice(0, 60) : null) || null;
};

// Read the tamper-evident audit trail for the app's tables: who changed what,
// when, and the exact before→after. Admin-only.
export async function GET(req) {
  const { user, response } = await requireAdmin();
  if (response) return response;
  await ensureExtSchema();

  const { searchParams } = new URL(req.url);
  const table = searchParams.get('table');
  const actor = searchParams.get('actor');
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '200', 10) || 200, 1), 500);

  const where = ['al.table_name = any($1)'];
  const params = [APP_TABLES];
  if (table && APP_TABLES.includes(table)) { params.push(table); where.push(`al.table_name = $${params.length}`); }
  if (actor) { params.push(actor); where.push(`lower(u.email) = lower($${params.length})`); }

  const { rows } = await query(
    `select al.id, al.action, al.table_name, al.row_pk,
            u.email as actor_email, u.name as actor_name, al.actor_db_role,
            al.changed_at, al.client_addr, al.old_data, al.new_data
       from audit.activity_log al
       left join ext.app_user u on u.id = al.actor_app_user_id
      where ${where.join(' and ')}
      order by al.changed_at desc, al.id desc
      limit ${limit}`,
    params,
  );

  const events = rows.map((r) => {
    const o = r.old_data || {}, n = r.new_data || {};
    const changes = [];
    if (r.action === 'UPDATE') {
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
        if (SKIP.has(k)) continue;
        if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) changes.push({ field: k, from: o[k] ?? null, to: n[k] ?? null });
      }
    }
    return {
      id: String(r.id), action: r.action, table: r.table_name, label: LABELS[r.table_name] || r.table_name,
      entity: labelOf(n) || labelOf(o) || r.row_pk,
      who: r.actor_email || null, whoName: r.actor_name || null, dbRole: r.actor_db_role,
      at: r.changed_at, ip: r.client_addr ? String(r.client_addr) : null, changes,
    };
  });

  const actors = (await query(
    `select distinct u.email from audit.activity_log al join ext.app_user u on u.id = al.actor_app_user_id
      where al.table_name = any($1) and u.email is not null order by u.email`, [APP_TABLES],
  )).rows.map((x) => x.email);

  return NextResponse.json({ me: { email: user.email }, events, actors, tables: APP_TABLES.map((t) => ({ value: t, label: LABELS[t] })) });
}
