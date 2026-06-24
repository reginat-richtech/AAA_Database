import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { workspaceRole, canWrite } from '../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Create a sheet in a workspace (default Kanban columns).
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const b = await req.json().catch(() => ({}));
  const workspace_id = b.workspace_id ? String(b.workspace_id) : null;
  if (!workspace_id) return NextResponse.json({ error: 'workspace_id is required.' }, { status: 400 });
  if (!canWrite(await workspaceRole(workspace_id, user))) return NextResponse.json({ error: 'You don’t have access to this workspace.' }, { status: 403 });
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) return NextResponse.json({ error: 'Sheet name is required.' }, { status: 400 });
  const id = crypto.randomUUID();
  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `insert into ext.pm_sheet (id, workspace_id, name, created_by, sort_order)
       values ($1,$2,$3,$4, coalesce((select max(sort_order)+1 from ext.pm_sheet where workspace_id=$2), 0))
       returning id, name, description, columns, sort_order`,
      [id, workspace_id, name, user.email],
    );
    return rows[0];
  });
  return NextResponse.json(row);
}
