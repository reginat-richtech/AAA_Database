import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query } from '../../../lib/db';
import { ensureExtSchema } from '../../../lib/ingest/schema';
import { workspaceRole } from '../../../lib/pm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bootstrap for the PM tracker page: the workspaces the user can access, and (for
// the selected workspace) its sheets, tasks, and members.
export async function GET(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();

  const sheetCount = `(select count(*) from ext.pm_sheet s where s.workspace_id = w.id and not s.archived)`;
  const memberCount = `(select count(*) from ext.pm_workspace_member mm where mm.workspace_id = w.id)`;
  // Department workspaces → that team (managers act as admin); manual ones → members. Admins see all.
  const workspaces = user.isAdmin
    ? (await query(
        `select w.id, w.name, w.icon, w.description, w.department,
                case when w.department is not null then 'admin'
                     else coalesce((select role from ext.pm_workspace_member m where m.workspace_id = w.id and lower(m.user_email) = lower($1)), 'admin') end as role,
                ${sheetCount} as sheet_count, ${memberCount} as member_count
           from ext.pm_workspace w where not w.archived order by w.department nulls last, w.created_at`, [user.email])).rows
    : (await query(
        `select w.id, w.name, w.icon, w.description, w.department,
                case when w.department is not null then $3
                     else (select role from ext.pm_workspace_member m where m.workspace_id = w.id and lower(m.user_email) = lower($1)) end as role,
                ${sheetCount} as sheet_count, ${memberCount} as member_count
           from ext.pm_workspace w
          where not w.archived and (w.department = $2
             or exists (select 1 from ext.pm_workspace_member m where m.workspace_id = w.id and lower(m.user_email) = lower($1)))
          order by w.department nulls last, w.created_at`, [user.email, user.department, user.title === 'manager' ? 'admin' : 'member'])).rows;

  const want = new URL(req.url).searchParams.get('workspace');
  const selectedId = want && workspaces.some((w) => w.id === want) ? want : (workspaces[0]?.id || null);

  let sheets = [], tasks = [], members = [], role = null;
  if (selectedId) {
    role = await workspaceRole(selectedId, user);
    sheets = (await query(
      `select id, name, description, columns, sort_order, stage_key, done from ext.pm_sheet
        where workspace_id = $1 and not archived order by sort_order, created_at`, [selectedId])).rows;
    if (sheets.length) {
      tasks = (await query(
        `select id, sheet_id, title, description, status, priority, column_id, position, assignee_email, due_date, tags, created_by, created_at, updated_at
           from ext.pm_task where sheet_id = any($1::text[]) order by position, created_at`,
        [sheets.map((s) => s.id)])).rows;
    }
    members = (await query(
      `select id, user_email, role, joined_at from ext.pm_workspace_member where workspace_id = $1 order by case role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end, user_email`,
      [selectedId])).rows;
  }

  // Assignee picker: for a department workspace, only that department's people;
  // for manual workspaces, everyone signed in.
  let people = [];
  const selectedWs = workspaces.find((w) => w.id === selectedId);
  try {
    people = selectedWs?.department
      ? (await query('select email, name, department, title from ext.app_user where department = $1 order by email', [selectedWs.department])).rows
      : (await query('select email, name, department, title from ext.app_user order by email')).rows;
  } catch { people = []; }

  return NextResponse.json({
    me: { email: user.email, isAdmin: user.isAdmin, title: user.title, department: user.department },
    workspaces, selectedId, role, sheets, tasks, members, people,
  });
}
