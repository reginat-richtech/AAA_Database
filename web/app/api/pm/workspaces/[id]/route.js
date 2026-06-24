import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query, mutateAs } from '../../../../../lib/db';
import { ensureExtSchema } from '../../../../../lib/ingest/schema';
import { workspaceRole, canManage } from '../../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  if (!canManage(await workspaceRole(id, user))) return NextResponse.json({ error: 'Only an owner or admin can edit this workspace.' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const sets = [], vals = [id];
  if (b.name !== undefined) { vals.push(String(b.name).trim().slice(0, 200) || 'Workspace'); sets.push(`name=$${vals.length}`); }
  if (b.icon !== undefined) { vals.push(String(b.icon).slice(0, 8) || '📋'); sets.push(`icon=$${vals.length}`); }
  if (b.description !== undefined) { vals.push(b.description ? String(b.description).slice(0, 2000) : null); sets.push(`description=$${vals.length}`); }
  if (b.archived !== undefined) { vals.push(!!b.archived); sets.push(`archived=$${vals.length}`); }
  if (!sets.length) return NextResponse.json({ ok: true });
  await mutateAs(user.email, (q) => q(`update ext.pm_workspace set ${sets.join(', ')}, updated_at=now() where id=$1`, vals));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  if (!canManage(await workspaceRole(id, user))) return NextResponse.json({ error: 'Only an owner or admin can delete this workspace.' }, { status: 403 });
  const w = (await query('select project_id from ext.pm_workspace where id=$1', [id])).rows[0];
  if (w?.project_id) return NextResponse.json({ error: 'Auto-managed workspaces can’t be deleted.' }, { status: 400 });
  await mutateAs(user.email, async (q) => {
    await q('delete from ext.pm_task where sheet_id in (select id from ext.pm_sheet where workspace_id=$1)', [id]);
    await q('delete from ext.pm_sheet where workspace_id=$1', [id]);
    await q('delete from ext.pm_workspace_member where workspace_id=$1', [id]);
    await q('delete from ext.pm_workspace where id=$1', [id]);
  });
  return NextResponse.json({ ok: true });
}
