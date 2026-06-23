import { NextResponse } from 'next/server';
import { requireUser } from '../../../lib/access';
import { query } from '../../../lib/db';
import { ensureExtSchema } from '../../../lib/ingest/schema';
import { reachedTeamPrep } from '../../../lib/projectStages';
import { createPerms, normalizeDepartment, normalizeStatus, normalizePriority, PREP_AUTO_TASKS } from '../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEL = `t.id, t.project_id, t.title, t.description, t.department, t.assignee_email, t.created_by,
  t.status, t.priority, t.due_date, t.created_at, t.updated_at,
  a.project_number, a.title as project_title, a.counterparty`;

// List tasks the user may see (own department; admins see all; people with no
// department see only what's assigned to / created by them) + the data the
// composer needs: the current user, the project picker, and dept members.
export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();

  // 1) Which projects have reached Team Preparation (approval complete)?
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

  // 2) Auto-seed the 3 Team-Prep tasks (tech / sales / inventory) once per project.
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
           values ($1,$2,$3,$4,'system','todo','normal',$5) on conflict (project_id, auto_key) do nothing`,
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

  // 3) Visible tasks (own department; admins see all; no-dept users see their own).
  const params = [];
  let where;
  if (user.isAdmin) where = 'true';
  else if (user.department) { params.push(user.department); where = 't.department = $1'; }
  else { params.push(user.email); where = '(lower(t.assignee_email) = $1 or lower(t.created_by) = $1)'; }

  const { rows: tasks } = await query(
    `select ${SEL} from ext.task t
       left join ops.legal_agreement a on a.id::text = t.project_id
      where ${where} order by t.created_at desc limit 500`,
    params,
  );

  // 4) Projects (with completion state) that have reached Team Preparation. Admins
  //    see all of them and every department's tasks; members see their own department's.
  const { rows: allProjects } = await query(
    `select a.id::text as id, a.project_number, a.title, a.counterparty,
            coalesce(tp.status, 'active') as status, tp.completed_by, tp.completed_at
       from ops.legal_agreement a
       left join ext.task_project tp on tp.project_id = a.id::text
      order by a.created_at desc limit 300`,
  );
  const projects = allProjects.filter((p) => reached.has(String(p.id)));

  // Department roster for the assignee dropdown.
  let members = [];
  try {
    members = user.isAdmin
      ? (await query(`select email, name, department, title from ext.app_user where department is not null order by department, email`)).rows
      : user.department
        ? (await query(`select email, name, department, title from ext.app_user where department = $1 order by email`, [user.department])).rows
        : [];
  } catch { members = []; }

  return NextResponse.json({
    me: { email: user.email, isAdmin: user.isAdmin, department: user.department, title: user.title },
    tasks, projects, members,
  });
}

// Create a task (linked to a project). Members create in their own department and
// may only self-assign; managers/admins may assign to others.
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  await ensureExtSchema();
  const { canCreate, canAssignOthers } = createPerms(user);
  if (!canCreate) return NextResponse.json({ error: 'Ask an admin to set your department before creating tasks.' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const department = user.isAdmin ? normalizeDepartment(body.department) : user.department;
  if (!department) return NextResponse.json({ error: 'A department is required.' }, { status: 400 });

  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return NextResponse.json({ error: 'Task title is required.' }, { status: 400 });

  const project_id = body.project_id ? String(body.project_id) : null;
  if (!project_id) return NextResponse.json({ error: 'Link the task to a project.' }, { status: 400 });
  const proj = (await query('select id from ops.legal_agreement where id::text = $1', [project_id])).rows[0];
  if (!proj) return NextResponse.json({ error: 'Project not found.' }, { status: 400 });

  // Tasks can only be assigned to projects that have reached Team Preparation.
  const sub = (await query(
    `select status, answers from ops.tech_request_submission where agreement_id::text = $1
       order by case status when 'approved' then 3 when 'finalized' then 2 when 'saved' then 1 else 0 end desc, created_at desc limit 1`,
    [project_id],
  )).rows[0];
  const approvedIds = new Set();
  const jfSubId = sub?.answers?._jotform?.submission_id || sub?.answers?._jotform?.submissionID || null;
  if (jfSubId) {
    const ev = (await query(`select 1 from ops.jotform_stage_event where stage='approved' and submission_id = $1 limit 1`, [String(jfSubId)])).rows;
    if (ev.length) approvedIds.add(String(jfSubId));
  }
  if (!reachedTeamPrep(sub, approvedIds)) {
    return NextResponse.json({ error: 'This project hasn’t reached the Team Preparation step yet, so tasks can’t be assigned to it.' }, { status: 400 });
  }

  const description = body.description ? String(body.description).slice(0, 4000) : null;
  const status = normalizeStatus(body.status);
  const priority = normalizePriority(body.priority);
  const due_date = body.due_date ? String(body.due_date).slice(0, 10) : null;
  let assignee = body.assignee_email ? String(body.assignee_email).trim().toLowerCase() : null;
  if (!canAssignOthers) assignee = assignee === user.email ? user.email : null;   // members may only self-assign

  const { rows } = await query(
    `insert into ext.task (id, project_id, title, description, department, assignee_email, created_by, status, priority, due_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [crypto.randomUUID(), project_id, title, description, department, assignee, user.email, status, priority, due_date],
  );
  return NextResponse.json(rows[0]);
}
