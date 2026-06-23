// Org model for Task Tracking — departments, titles, task enums, and the single
// source of truth for "what can this person do to this task". Pure (no imports),
// so it's shared by API routes (server) and the Task page (client).

export const DEPARTMENTS = ['sales', 'legal', 'marketing', 'finance', 'tech', 'inventory'];
export const DEPARTMENT_LABEL = {
  sales: 'Sales', legal: 'Legal', marketing: 'Marketing',
  finance: 'Finance', tech: 'Tech', inventory: 'Inventory',
};
export const TITLES = ['member', 'manager'];

export const TASK_STATUS = ['todo', 'in_progress', 'blocked', 'done'];
export const TASK_STATUS_LABEL = { todo: 'To-do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
export const TASK_PRIORITY = ['low', 'normal', 'high'];

// The three Team-Preparation tasks auto-created on every project that reaches
// that step — one per department. `key` is stable (used for idempotent seeding).
export const PREP_AUTO_TASKS = [
  { key: 'equipment', title: 'Prepare & test equipment', department: 'tech' },
  { key: 'customer_comm', title: 'Customer communication (PM)', department: 'sales' },
  { key: 'shipping', title: 'Shipping preparation', department: 'inventory' },
];

export const normalizeDepartment = (d) => (DEPARTMENTS.includes(d) ? d : null);
export const normalizeTitle = (t) => (TITLES.includes(t) ? t : 'member');
export const normalizeStatus = (s) => (TASK_STATUS.includes(s) ? s : 'todo');
export const normalizePriority = (p) => (TASK_PRIORITY.includes(p) ? p : 'normal');

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
