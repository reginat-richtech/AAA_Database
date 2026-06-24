import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { query, mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { normalizeStatus, normalizePriority, normalizeType, normalizeDepartment, normalizeColumn, COLUMN_STATUS, STATUS_COLUMN } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLS = `id, project_id, title, description, note, type, department, assignee_email, created_by,
  status, priority, column_id, position, tags, start_date, end_date, due_date, created_at, updated_at`;

async function load(id) {
  const { rows } = await query(`select ${COLS} from ext.task where id = $1`, [id]);
  return rows[0] || null;
}

// Edit a task — open to any signed-in user (shared tracker). Only fields present
// in the body are changed.
export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const title = b.title != null ? (String(b.title).trim().slice(0, 200) || task.title) : task.title;
  const description = b.description !== undefined ? (b.description ? String(b.description).slice(0, 4000) : null) : task.description;
  const note = b.note !== undefined ? (b.note ? String(b.note).slice(0, 4000) : null) : task.note;
  // Kanban: column and status stay in sync (status derives from column, like the old repo).
  let status = b.status != null ? normalizeStatus(b.status) : task.status;
  let column_id = b.column_id !== undefined ? normalizeColumn(b.column_id) : (task.column_id || STATUS_COLUMN[task.status] || 'todo');
  if (b.column_id !== undefined) status = COLUMN_STATUS[column_id] || status;
  else if (b.status != null) column_id = STATUS_COLUMN[status] || column_id;
  const position = b.position !== undefined && Number.isFinite(Number(b.position)) ? Number(b.position) : task.position;
  const priority = b.priority != null ? normalizePriority(b.priority) : task.priority;
  const type = b.type !== undefined ? (b.type ? normalizeType(b.type) : null) : task.type;
  const start_date = b.start_date !== undefined ? (b.start_date ? String(b.start_date).slice(0, 10) : null) : task.start_date;
  const end_date = b.end_date !== undefined ? (b.end_date ? String(b.end_date).slice(0, 10) : null) : task.end_date;
  const assignee = b.assignee_email !== undefined ? (b.assignee_email ? String(b.assignee_email).trim().toLowerCase() : null) : task.assignee_email;
  let project_id = task.project_id;
  if (b.project_id !== undefined) {
    project_id = b.project_id ? String(b.project_id) : null;
    if (project_id) {
      const proj = (await query('select id from ops.legal_agreement where id::text = $1', [project_id])).rows[0];
      if (!proj) project_id = task.project_id;
    }
  }
  const department = b.department !== undefined ? normalizeDepartment(b.department) : task.department;
  const tags = b.tags !== undefined
    ? (Array.isArray(b.tags) ? b.tags : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
    : (task.tags || []);

  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `update ext.task set title=$2, description=$3, note=$4, type=$5, status=$6, priority=$7,
         column_id=$8, position=$9, start_date=$10, end_date=$11, assignee_email=$12, project_id=$13, department=$14, tags=$15::jsonb, updated_at=now()
       where id=$1 returning ${COLS}`,
      [id, title, description, note, type, status, priority, column_id, position, start_date, end_date, assignee, project_id, department, JSON.stringify(tags)],
    );
    return rows[0];
  });
  return NextResponse.json(row);
}

// Delete a task — the creator or an admin only.
export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const isOwner = (task.created_by || '').toLowerCase() === user.email;
  if (!user.isAdmin && !isOwner) return NextResponse.json({ error: 'Only the creator or an admin can delete this task.' }, { status: 403 });
  await mutateAs(user.email, (q) => q('delete from ext.task where id = $1', [id]));
  return NextResponse.json({ ok: true });
}
