import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query } from '../../../../../lib/db';
import { ensureExtSchema } from '../../../../../lib/ingest/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mark a project complete / reopen it. Project completion is a soft flag — tasks
// stay fully editable afterward. Managers (any department) and admins only.
export async function PATCH(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!(user.isAdmin || user.title === 'manager')) {
    return NextResponse.json({ error: 'Only a manager or admin can change project completion.' }, { status: 403 });
  }
  await ensureExtSchema();
  const { id } = await params;
  const proj = (await query('select id from ops.legal_agreement where id::text = $1', [String(id)])).rows[0];
  if (!proj) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const completing = b.status === 'complete';
  if (completing) {
    await query(
      `insert into ext.task_project (project_id, status, completed_by, completed_at, updated_at)
       values ($1, 'complete', $2, now(), now())
       on conflict (project_id) do update set status='complete', completed_by=$2, completed_at=now(), updated_at=now()`,
      [String(id), user.email],
    );
  } else {
    await query(
      `insert into ext.task_project (project_id, status, completed_by, completed_at, updated_at)
       values ($1, 'active', null, null, now())
       on conflict (project_id) do update set status='active', completed_by=null, completed_at=null, updated_at=now()`,
      [String(id)],
    );
  }
  const { rows } = await query(
    'select project_id, status, completed_by, completed_at from ext.task_project where project_id = $1',
    [String(id)],
  );
  return NextResponse.json(rows[0] || { project_id: String(id), status: 'active' });
}
