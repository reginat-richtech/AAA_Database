import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { mutateAs } from '../../../../../lib/db';
import { ensureExtSchema } from '../../../../../lib/ingest/schema';
import { sheetRole, canWrite } from '../../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const { role } = await sheetRole(id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this sheet.' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const sets = [], vals = [id];
  if (b.name !== undefined) { vals.push(String(b.name).trim().slice(0, 200) || 'Sheet'); sets.push(`name=$${vals.length}`); }
  if (b.description !== undefined) { vals.push(b.description ? String(b.description).slice(0, 2000) : null); sets.push(`description=$${vals.length}`); }
  if (b.sort_order !== undefined && Number.isFinite(Number(b.sort_order))) { vals.push(Number(b.sort_order)); sets.push(`sort_order=$${vals.length}`); }
  if (b.done !== undefined) {
    if (!(user.isAdmin || user.title === 'manager')) return NextResponse.json({ error: 'Only an admin or manager can confirm a prep task done.' }, { status: 403 });
    vals.push(!!b.done); sets.push(`done=$${vals.length}`);
  }
  if (Array.isArray(b.columns)) {
    const cols = b.columns
      .filter((c) => c && c.id && c.name)
      .map((c) => ({ id: String(c.id).slice(0, 40), name: String(c.name).slice(0, 60), color: String(c.color || '#94a3b8').slice(0, 9) }));
    if (cols.length) { vals.push(JSON.stringify(cols)); sets.push(`columns=$${vals.length}::jsonb`); }
  }
  if (!sets.length) return NextResponse.json({ ok: true });
  await mutateAs(user.email, (q) => q(`update ext.pm_sheet set ${sets.join(', ')}, updated_at=now() where id=$1`, vals));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  const { role } = await sheetRole(id, user);
  if (!canWrite(role)) return NextResponse.json({ error: 'No access to this sheet.' }, { status: 403 });
  await mutateAs(user.email, async (q) => {
    await q('delete from ext.pm_task where sheet_id=$1', [id]);
    await q('delete from ext.pm_sheet where id=$1', [id]);
  });
  return NextResponse.json({ ok: true });
}
