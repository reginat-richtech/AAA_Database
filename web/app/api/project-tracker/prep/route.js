import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { requireUser } from '../../../../lib/access';
import { query, mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { PREP_AUTO_TASKS, taskPerms } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mark (or un-mark) one Team-Preparation step done for a project. The 3 steps are
// the per-department prep tasks (ext.task auto_key rows). Only that department's
// manager — or an admin — may mark it, and we record who/when. The task is
// created on demand so the tracker works even if Task Tracking never seeded it.
//   POST { project_id, prep_key: 'shipping'|'equipment'|'customer_comm', done: bool }
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();

  const b = await req.json().catch(() => ({}));
  const projectId = b.project_id ? String(b.project_id) : null;
  const def = PREP_AUTO_TASKS.find((p) => p.key === b.prep_key);
  if (!projectId || !def) {
    return NextResponse.json({ error: 'project_id and a valid prep_key are required.' }, { status: 400 });
  }

  // Only the step's department manager (or an admin) may mark it.
  if (!taskPerms(user, { department: def.department }).canManage) {
    return NextResponse.json(
      { error: `Only the ${def.department} manager or an admin can mark "${def.title}".` },
      { status: 403 },
    );
  }

  // The project must exist.
  const proj = (await query('select id from ops.legal_agreement where id::text = $1', [projectId])).rows[0];
  if (!proj) return NextResponse.json({ error: 'Unknown project.' }, { status: 404 });

  const done = b.done !== false; // default to marking done
  const status = done ? 'done' : 'open';
  const column_id = done ? 'done' : 'todo';
  const doneEmail = done ? user.email : null;
  const doneName = done ? (user.name || user.email) : null;

  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `insert into ext.task
         (id, project_id, title, department, created_by, status, priority, column_id, auto_key,
          done_by_email, done_by_name, done_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,'medium',$7,$8,$9,$10, ${done ? 'now()' : 'null'}, now())
       on conflict (project_id, auto_key) do update set
         status = excluded.status, column_id = excluded.column_id,
         done_by_email = excluded.done_by_email, done_by_name = excluded.done_by_name,
         done_at = ${done ? 'now()' : 'null'}, updated_at = now()
       returning id, status, done_by_email, done_by_name, done_at`,
      [crypto.randomUUID(), projectId, def.title, def.department, user.email, status, column_id, def.key,
        doneEmail, doneName],
    );
    return rows[0];
  });

  return NextResponse.json({
    ok: true,
    step: {
      key: def.key, title: def.title, department: def.department,
      task_id: row.id, done: row.status === 'done',
      done_by_name: row.done_by_name, done_by_email: row.done_by_email, done_at: row.done_at,
    },
  });
}
