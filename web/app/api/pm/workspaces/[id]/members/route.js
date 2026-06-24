import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../../lib/access';
import { query, mutateAs } from '../../../../../../lib/db';
import { ensureExtSchema } from '../../../../../../lib/ingest/schema';
import { workspaceRole, canManage, ROLES } from '../../../../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Add / update a workspace member (owner or admin only).
export async function POST(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  if (!canManage(await workspaceRole(id, user))) return NextResponse.json({ error: 'Only an owner or admin can manage members.' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  const role = ROLES.includes(b.role) && b.role !== 'owner' ? b.role : 'member';
  await mutateAs(user.email, (q) => q(
    `insert into ext.pm_workspace_member (id, workspace_id, user_email, role) values ($1,$2,$3,$4)
     on conflict (workspace_id, lower(user_email)) do update set role = excluded.role`,
    [crypto.randomUUID(), id, email, role],
  ));
  return NextResponse.json({ ok: true, email, role });
}

// Remove a member (owner or admin only; the owner can't be removed).
export async function DELETE(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { id } = await params;
  if (!canManage(await workspaceRole(id, user))) return NextResponse.json({ error: 'Only an owner or admin can manage members.' }, { status: 403 });
  const email = String(new URL(req.url).searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });
  const owner = (await query('select owner_email from ext.pm_workspace where id=$1', [id])).rows[0];
  if (owner && owner.owner_email.toLowerCase() === email) return NextResponse.json({ error: 'The owner cannot be removed.' }, { status: 400 });
  await mutateAs(user.email, (q) => q('delete from ext.pm_workspace_member where workspace_id=$1 and lower(user_email)=lower($2)', [id, email]));
  return NextResponse.json({ ok: true });
}
