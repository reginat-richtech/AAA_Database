import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { query } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { taskPerms, normalizeStatus, normalizePriority, normalizeDepartment } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLS = `id, project_id, title, description, department, assignee_email, created_by,
  status, priority, due_date, created_at, updated_at`;

async function load(id) {
  const { rows } = await query(`select ${COLS} from ext.task where id = $1`, [id]);
  return rows[0] || null;
}

// Update a task. canEdit (admin / dept manager / creator / assignee) may change
// status & details; only canManage (admin / dept manager) may reassign or
// move departments.
export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { canEdit, canManage } = taskPerms(user, task);
  if (!canEdit) return NextResponse.json({ error: 'Not allowed to edit this task' }, { status: 403 });

  const b = await req.json().catch(() => ({}));
  const title = b.title != null ? (String(b.title).trim().slice(0, 200) || task.title) : task.title;
  const description = b.description !== undefined ? (b.description ? String(b.description).slice(0, 4000) : null) : task.description;
  const status = b.status != null ? normalizeStatus(b.status) : task.status;
  const priority = b.priority != null ? normalizePriority(b.priority) : task.priority;
  const due_date = b.due_date !== undefined ? (b.due_date ? String(b.due_date).slice(0, 10) : null) : task.due_date;
  // Managers/admins assign to anyone; a member may claim an unassigned task in
  // their own department (or release their own claim).
  let assignee = task.assignee_email;
  if (b.assignee_email !== undefined) {
    const want = b.assignee_email ? String(b.assignee_email).trim().toLowerCase() : null;
    if (canManage) {
      assignee = want;
    } else if (want === user.email && !task.assignee_email && task.department === user.department) {
      assignee = user.email;                                   // claim an unassigned dept task
    } else if (want === null && (task.assignee_email || '').toLowerCase() === user.email) {
      assignee = null;                                         // release own claim
    }
  }
  let department = task.department;
  if (b.department !== undefined && user.isAdmin) department = normalizeDepartment(b.department) || task.department;

  const { rows } = await query(
    `update ext.task set title=$2, description=$3, status=$4, priority=$5, due_date=$6, assignee_email=$7, department=$8, updated_at=now()
     where id=$1 returning ${COLS}`,
    [id, title, description, status, priority, due_date, assignee, department],
  );
  return NextResponse.json(rows[0]);
}

// Delete a task — managers (of its department) and admins only.
export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { canManage } = taskPerms(user, task);
  if (!canManage) return NextResponse.json({ error: 'Only a manager or admin can delete this task' }, { status: 403 });
  await query('delete from ext.task where id = $1', [id]);
  return NextResponse.json({ ok: true });
}
