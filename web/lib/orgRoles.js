// Org model for Task Tracking — departments, titles, task enums, and the single
// source of truth for "what can this person do to this task". Pure (no imports),
// so it's shared by API routes (server) and the Task page (client).

export const DEPARTMENTS = ['sales', 'legal', 'marketing', 'finance', 'tech', 'inventory'];
export const DEPARTMENT_LABEL = {
  sales: 'Sales', legal: 'Legal', marketing: 'Marketing',
  finance: 'Finance', tech: 'Tech', inventory: 'Inventory',
};
export const TITLES = ['member', 'manager'];

export const TASK_STATUS = ['open', 'in_progress', 'done', 'cancelled'];
export const TASK_STATUS_LABEL = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
export const TASK_PRIORITY = ['low', 'medium', 'high', 'urgent'];
export const TASK_TYPE = ['feature', 'bug', 'admin', 'research', 'meeting', 'other'];
export const TASK_TYPE_LABEL = { feature: 'Feature', bug: 'Bug', admin: 'Admin', research: 'Research', meeting: 'Meeting', other: 'Other' };

// The three Team-Preparation tasks auto-created on every project that reaches
// that step — one per department. `key` is stable (used for idempotent seeding).
export const PREP_AUTO_TASKS = [
  { key: 'equipment', title: 'Prepare & test equipment', department: 'tech' },
  { key: 'customer_comm', title: 'Customer communication (PM)', department: 'sales' },
  { key: 'shipping', title: 'Shipping preparation', department: 'inventory' },
];

export const normalizeDepartment = (d) => (DEPARTMENTS.includes(d) ? d : null);
export const normalizeTitle = (t) => (TITLES.includes(t) ? t : 'member');
export const normalizeStatus = (s) => (TASK_STATUS.includes(s) ? s : 'open');
export const normalizePriority = (p) => (TASK_PRIORITY.includes(p) ? p : 'medium');
export const normalizeType = (t) => (TASK_TYPE.includes(t) ? t : 'other');

// ── Kanban columns (ported from the old PM tracker) ──────────────────────────
// A task lives in a `column_id` (its board position) and has a `position`
// (sort order within the column). The coarse `status` is DERIVED from the
// column, exactly like the old repo (review still counts as in-progress).
export const TASK_COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#94a3b8' },
  { id: 'in_progress', name: 'In Progress', color: '#3b82f6' },
  { id: 'review', name: 'Review', color: '#f59e0b' },
  { id: 'done', name: 'Done', color: '#22c55e' },
];
export const COLUMN_STATUS = { todo: 'open', in_progress: 'in_progress', review: 'in_progress', done: 'done' };
export const STATUS_COLUMN = { open: 'todo', in_progress: 'in_progress', done: 'done', cancelled: 'done' };
export const normalizeColumn = (c) => (TASK_COLUMNS.some((x) => x.id === c) ? c : 'todo');
export const columnForStatus = (s) => STATUS_COLUMN[s] || 'todo';

// Capabilities for one user against one task:
//   canEdit   — change status/details (admin, dept manager, or the creator/assignee)
//   canManage — assign to others / delete (admin or the task's department manager)
// `user` = { email, isAdmin, department, title }; `task` = { department, assignee_email, created_by }.
export function taskPerms(user, task) {
  if (!user) return { canEdit: false, canManage: false };
  if (user.isAdmin) return { canEdit: true, canManage: true };
  const email = String(user.email || '').toLowerCase();
  const sameDept = !!task && task.department === user.department;
  const isMgr = user.title === 'manager' && sameDept;
  const isOwn = !!task && (
    String(task.assignee_email || '').toLowerCase() === email ||
    String(task.created_by || '').toLowerCase() === email
  );
  // An unclaimed task in your own department (e.g. an auto-seeded prep task) can
  // be picked up and worked by any member of that department.
  const unclaimedInDept = sameDept && !!task && !task.assignee_email;
  return { canEdit: isMgr || isOwn || unclaimedInDept, canManage: isMgr };
}

// Can this user create a task at all, and can they assign it to other people?
export function createPerms(user) {
  if (!user) return { canCreate: false, canAssignOthers: false };
  if (user.isAdmin) return { canCreate: true, canAssignOthers: true };
  const canCreate = !!user.department;                 // must belong to a department
  const canAssignOthers = canCreate && user.title === 'manager';
  return { canCreate, canAssignOthers };
}
