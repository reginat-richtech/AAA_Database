import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { normalizeColumn, COLUMN_STATUS } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Batch reorder after a Kanban drag (ported from the old repo's /pm/tasks/reorder).
// Body: { column_id, ordered_ids: [...] } — sets each task's column, position
// (its index), and the derived status.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const b = await req.json().catch(() => ({}));
  const column_id = normalizeColumn(b.column_id);
  const ids = Array.isArray(b.ordered_ids) ? b.ordered_ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ ok: true, updated: 0 });
  const status = COLUMN_STATUS[column_id] || 'open';
  await mutateAs(user.email, async (q) => {
    for (let i = 0; i < ids.length; i++) {
      await q('update ext.task set column_id=$2, position=$3, status=$4, updated_at=now() where id=$1', [ids[i], column_id, i, status]);
    }
  });
  return NextResponse.json({ ok: true, updated: ids.length, column_id });
}
