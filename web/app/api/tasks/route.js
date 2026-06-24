import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query, mutateAs } from '../../../lib/db';
import { ensureExtSchema } from '../../../lib/ingest/schema';
import { reachedTeamPrep } from '../../../lib/projectStages';
import { normalizeStatus, normalizePriority, normalizeType, normalizeDepartment, PREP_AUTO_TASKS } from '../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEL = `t.id, t.project_id, t.title, t.description, t.note, t.type, t.department, t.assignee_email, t.created_by,
  t.status, t.priority, t.column_id, t.position, t.tags, t.start_date, t.end_date, t.due_date, t.created_at, t.updated_at,
  a.project_number, a.title as project_title, a.counterparty,
  (select count(*) from ext.task_update u where u.task_id = t.id) as updates_count`;

// Shared team task tracker: every signed-in user sees all tasks and can add/edit.
// A task may optionally link to a project; project-linked prep tasks are still
// auto-seeded once a project reaches Team Preparation (preserves that integration).
export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();

  // Auto-seed the 3 Team-Prep tasks (tech / sales / inventory) once per project.
  const subs = (await query(
    `select distinct on (agreement_id) agreement_id, status, answers
       from ops.tech_request_submission
       order by agreement_id, case status when 'approved' then 3 when 'finalized' then 2 when 'saved' then 1 else 0 end desc, created_at desc`,
  )).rows;
  const approvedSubIds = new Set(
    (await query(`select submission_id from ops.jotform_stage_event where stage = 'approved'`)).rows
      .map((e) => String(e.submission_id)).filter(Boolean),
  );
  const reached = new Set();
  for (const s of subs) if (reachedTeamPrep(s, approvedSubIds)) reached.add(String(s.agreement_id));
  if (reached.size) {
    const seeded = new Set(
      (await query(`select project_id from ext.task_project where seeded_at is not null and project_id = any($1::text[])`, [[...reached]])).rows
        .map((r) => String(r.project_id)),
    );
    for (const pid of reached) {
      if (seeded.has(pid)) continue;
      for (const a of PREP_AUTO_TASKS) {
        await query(
          `insert into ext.task (id, project_id, title, department, created_by, status, priority, auto_key)
           values ($1,$2,$3,$4,'system','open','medium',$5) on conflict (project_id, auto_key) do nothing`,
          [crypto.randomUUID(), pid, a.title, a.department, a.key],
        );
      }
      await query(
        `insert into ext.task_project (project_id, seeded_at, updated_at) values ($1, now(), now())
         on conflict (project_id) do update set seeded_at = coalesce(ext.task_project.seeded_at, now()), updated_at = now()`,
        [pid],
      );
    }
  }

  const { rows: tasks } = await query(
    `select ${SEL} from ext.task t
       left join ops.legal_agreement a on a.id::text = t.project_id
      order by t.created_at desc limit 1000`,
  );

  // Projects for the optional project picker.
  const { rows: projects } = await query(
    `select a.id::text as id, a.project_number, a.title, a.counterparty
       from ops.legal_agreement a order by a.created_at desc limit 500`,
  );

  // Everyone signed in (for the assignee dropdown).
  let members = [];
  try { members = (await query(`select email, name, department, title from ext.app_user order by email`)).rows; }
  catch { members = []; }

  // Inventory items (for the "add inventory to project" picker) + existing allocations.
  let inventory = [], allocations = [];
  try {
    inventory = (await query(`select id, sku, product_name, quantity from inventory.cn_sku order by product_name limit 1000`)).rows;
    allocations = (await query(`select id, project_id, cn_sku_id, sku, product_name, quantity, added_by from inventory.project_allocation order by created_at desc`)).rows;
  } catch { inventory = []; allocations = []; }

  return NextResponse.json({
    me: { email: user.email, isAdmin: user.isAdmin, department: user.department },
    tasks, projects, members, inventory, allocations,
  });
}

// Create a task. Open to any signed-in user; project & department are optional.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return NextResponse.json({ error: 'Task name is required.' }, { status: 400 });

  let project_id = body.project_id ? String(body.project_id) : null;
  if (project_id) {
    const proj = (await query('select id from ops.legal_agreement where id::text = $1', [project_id])).rows[0];
    if (!proj) project_id = null;   // ignore an unknown project rather than erroring
  }
  const department = normalizeDepartment(body.department);             // optional (null ok)
  const description = body.description ? String(body.description).slice(0, 4000) : null;
  const note = body.note ? String(body.note).slice(0, 4000) : null;
  const status = normalizeStatus(body.status);
  const priority = normalizePriority(body.priority);
  const type = body.type ? normalizeType(body.type) : null;
  const start_date = body.start_date ? String(body.start_date).slice(0, 10) : null;
  const end_date = body.end_date ? String(body.end_date).slice(0, 10) : null;
  const assignee = body.assignee_email ? String(body.assignee_email).trim().toLowerCase() : null;

  const row = await mutateAs(user.email, async (q) => {
    const { rows } = await q(
      `insert into ext.task (id, project_id, title, description, note, type, department, assignee_email, created_by, status, priority, start_date, end_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [crypto.randomUUID(), project_id, title, description, note, type, department, assignee, user.email, status, priority, start_date, end_date],
    );
    return rows[0];
  });
  return NextResponse.json(row);
}
