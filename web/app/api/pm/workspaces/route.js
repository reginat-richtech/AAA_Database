import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { mutateAs } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { DEPARTMENTS } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Create a workspace; the creator becomes its owner member.
// A department may be chosen — that scopes access to the department's team.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) return NextResponse.json({ error: 'Workspace name is required.' }, { status: 400 });

  let department = b.department ? String(b.department).trim().toLowerCase() : null;
  if (department && !DEPARTMENTS.includes(department)) {
    return NextResponse.json({ error: 'Unknown department.' }, { status: 400 });
  }
  // Non-admins can only create a workspace for their own department.
  if (department && !user.isAdmin && department !== user.department) {
    return NextResponse.json({ error: 'You can only create a workspace for your own department.' }, { status: 403 });
  }

  const icon = b.icon ? String(b.icon).slice(0, 8) : (department ? '👥' : '📋');
  const description = b.description ? String(b.description).slice(0, 2000) : null;
  const id = crypto.randomUUID();
  await mutateAs(user.email, async (q) => {
    await q('insert into ext.pm_workspace (id, name, description, owner_email, icon, department) values ($1,$2,$3,$4,$5,$6)', [id, name, description, user.email, icon, department]);
    await q('insert into ext.pm_workspace_member (id, workspace_id, user_email, role) values ($1,$2,$3,$4) on conflict do nothing', [crypto.randomUUID(), id, user.email, 'owner']);
  });
  return NextResponse.json({ id, name, icon, description, department });
}
