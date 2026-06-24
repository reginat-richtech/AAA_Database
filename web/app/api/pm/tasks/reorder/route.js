import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query, mutateAs } from '../../../../../lib/db';
import { ensureExtSchema } from '../../../../../lib/ingest/schema';
import { sheetRole, canWrite, statusForColumn } from '../../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Batch reorder after a Kanban drag. Body: { sheet_id, column_id, ordered_ids }.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const b = await req.json().catch(() => ({}));
  const sheet_id = b.sheet_id ? String(b.sheet_id) : null;
  if (!sheet_id) return NextResponse.json({ error: 'sheet_id required' }, { status: 400 });
  const { role } = await sheetRole(sheet_id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this sheet.' }, { status: 403 });

  const sheet = (await query('select columns from ext.pm_sheet where id=$1', [sheet_id])).rows[0];
  const columns = sheet?.columns || [];
  const column_id = columns.some((c) => c.id === b.column_id) ? b.column_id : (columns[0]?.id || 'todo');
  const status = statusForColumn(column_id, columns);
  const ids = Array.isArray(b.ordered_ids) ? b.ordered_ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ ok: true, updated: 0 });

  await mutateAs(user.email, async (q) => {
    for (let i = 0; i < ids.length; i++) {
      await q('update ext.pm_task set column_id=$2, position=$3, status=$4, updated_at=now() where id=$1 and sheet_id=$5', [ids[i], column_id, i, status, sheet_id]);
    }
  });
  return NextResponse.json({ ok: true, updated: ids.length });
}
