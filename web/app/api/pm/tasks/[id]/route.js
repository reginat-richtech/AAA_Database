import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query, mutateAs } from '../../../../../lib/db';
import { ensureExtSchema } from '../../../../../lib/ingest/schema';
import { taskRole, canWrite, statusForColumn, normalizePriority } from '../../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLS = `id, sheet_id, title, description, status, priority, column_id, position, assignee_email, due_date, tags, created_by, created_at, updated_at`;

export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const { role } = await taskRole(id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this task.' }, { status: 403 });
  const task = (await query(`select ${COLS} from ext.pm_task where id=$1`, [id])).rows[0];
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const sets = [], vals = [id];
  const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

  if (b.title != null) set('title', String(b.title).trim().slice(0, 300) || task.title);
  if (b.description !== undefined) set('description', b.description ? String(b.description).slice(0, 4000) : null);
  if (b.priority != null) set('priority', normalizePriority(b.priority));
  if (b.assignee_email !== undefined) set('assignee_email', b.assignee_email ? String(b.assignee_email).trim().toLowerCase() : null);
  if (b.due_date !== undefined) set('due_date', b.due_date ? String(b.due_date).slice(0, 10) : null);
  if (Array.isArray(b.tags)) set('tags', JSON.stringify(b.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 30)));
  if (b.column_id !== undefined) {
    const sheet = (await query('select columns from ext.pm_sheet where id=$1', [task.sheet_id])).rows[0];
    const columns = sheet?.columns || [];
    const column_id = columns.some((c) => c.id === b.column_id) ? b.column_id : task.column_id;
    set('column_id', column_id);
    set('status', statusForColumn(column_id, columns));
  }
  if (b.position !== undefined && Number.isFinite(Number(b.position))) set('position', Number(b.position));
  if (!sets.length) return NextResponse.json(task);

  // tags needs ::jsonb cast — rebuild that one assignment if present.
  const setSql = sets.map((s) => (s.startsWith('tags=') ? s + '::jsonb' : s)).join(', ');
  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(`update ext.pm_task set ${setSql}, updated_at=now() where id=$1 returning ${COLS}`, vals);
    return rows[0];
  });
  return NextResponse.json(row);
}

export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const { role } = await taskRole(id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this task.' }, { status: 403 });
  await mutateAs(user.email, (q) => q('delete from ext.pm_task where id=$1', [id]));
  return NextResponse.json({ ok: true });
}
