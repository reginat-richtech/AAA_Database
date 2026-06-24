import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { query, mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { sheetRole, canWrite, statusForColumn, normalizePriority } from '../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Create a task in a sheet.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const b = await req.json().catch(() => ({}));
  const sheet_id = b.sheet_id ? String(b.sheet_id) : null;
  if (!sheet_id) return NextResponse.json({ error: 'sheet_id is required.' }, { status: 400 });
  const { role } = await sheetRole(sheet_id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this sheet.' }, { status: 403 });
  const title = String(b.title || '').trim().slice(0, 300);
  if (!title) return NextResponse.json({ error: 'Task title is required.' }, { status: 400 });

  const sheet = (await query('select columns from ext.pm_sheet where id=$1', [sheet_id])).rows[0];
  const columns = sheet?.columns || [];
  const ids = columns.map((c) => c.id);
  const column_id = ids.includes(b.column_id) ? b.column_id : (ids[0] || 'todo');
  const status = statusForColumn(column_id, columns);
  const priority = normalizePriority(b.priority);
  const assignee = b.assignee_email ? String(b.assignee_email).trim().toLowerCase() : null;
  const due_date = b.due_date ? String(b.due_date).slice(0, 10) : null;
  const description = b.description ? String(b.description).slice(0, 4000) : null;

  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `insert into ext.pm_task (id, sheet_id, title, description, status, priority, column_id, position, assignee_email, due_date, created_by)
       values ($1,$2,$3,$4,$5,$6,$7, coalesce((select max(position)+1 from ext.pm_task where sheet_id=$2 and column_id=$7),0), $8,$9,$10)
       returning *`,
      [crypto.randomUUID(), sheet_id, title, description, status, priority, column_id, assignee, due_date, user.email],
    );
    return rows[0];
  });
  return NextResponse.json(row);
}
