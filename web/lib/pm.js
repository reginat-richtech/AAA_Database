// PM tracker helpers (ported from the old repo's PM workspace model).
// Workspace → Sheet → Task. Membership roles gate access; the coarse task
// `status` is derived from its Kanban column.
import { query } from './db';

export const DEFAULT_COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#94a3b8' },
  { id: 'in_progress', name: 'In Progress', color: '#3b82f6' },
  { id: 'review', name: 'Review', color: '#f59e0b' },
  { id: 'done', name: 'Done', color: '#22c55e' },
];
export const COLUMN_STATUS = { todo: 'open', in_progress: 'in_progress', review: 'in_progress', done: 'done' };
export const ROLES = ['owner', 'admin', 'member', 'viewer'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const normalizePriority = (p) => (PRIORITIES.includes(p) ? p : 'medium');
export const statusForColumn = (colId, columns) => {
  if (COLUMN_STATUS[colId]) return COLUMN_STATUS[colId];          // standard columns
  // Custom column: last column = done, else open (best-effort).
  const last = columns && columns.length ? columns[columns.length - 1].id : null;
  return colId === last ? 'done' : 'open';
};

// The three Team-Preparation sheets created in each project workspace.
export const PREP_SHEETS = [
  { key: 'shipping', name: 'Shipping preparation' },
  { key: 'equipment', name: 'Prepare & test equipment' },
  { key: 'customer_comm', name: 'Customer communication (PM)' },
];

export const canWrite = (role) => !!role && role !== 'viewer';
export const canManage = (role) => role === 'owner' || role === 'admin';

// The user's role in a workspace, or null if no access.
//   • Department workspaces (a department was chosen on create) are scoped to that
//     team: the dept's members see it (managers act as 'admin'), the creator
//     manages it, and app-admins see all. Nobody outside the department gets in.
//   • Private workspaces (no department) are membership-gated; app-admins act as 'admin'.
export async function workspaceRole(workspaceId, user) {
  if (!workspaceId) return null;
  const { rows } = await query('select department, owner_email from ext.pm_workspace where id = $1', [workspaceId]);
  if (!rows[0]) return null;
  const dept = rows[0].department;
  if (dept) {
    if (user.isAdmin) return 'admin';
    if ((rows[0].owner_email || '').toLowerCase() === (user.email || '').toLowerCase()) return 'admin';  // the creator manages it
    if (user.department === dept) return user.title === 'manager' ? 'admin' : 'member';
    return null;
  }
  const m = await query(
    'select role from ext.pm_workspace_member where workspace_id = $1 and lower(user_email) = lower($2)',
    [workspaceId, user.email],
  );
  if (m.rows[0]) return m.rows[0].role;
  return user.isAdmin ? 'admin' : null;
}

// Role for the workspace that owns a sheet.
export async function sheetRole(sheetId, user) {
  const { rows } = await query('select workspace_id from ext.pm_sheet where id = $1', [sheetId]);
  if (!rows[0]) return { role: null, workspaceId: null };
  return { role: await workspaceRole(rows[0].workspace_id, user), workspaceId: rows[0].workspace_id };
}

// Role for the workspace that owns the sheet that owns a task.
export async function taskRole(taskId, user) {
  const { rows } = await query(
    `select s.workspace_id from ext.pm_task t join ext.pm_sheet s on s.id = t.sheet_id where t.id = $1`,
    [taskId],
  );
  if (!rows[0]) return { role: null, workspaceId: null };
  return { role: await workspaceRole(rows[0].workspace_id, user), workspaceId: rows[0].workspace_id };
}
