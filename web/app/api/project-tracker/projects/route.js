import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { PROJECT_STAGES, normSo, buildProject } from '../../../../lib/projectStages';
import { requireUser, visibilitySql } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  // Restrict projects to agreements this user owns (admins see all).
  const vis = visibilitySql(user, 1);

  const agreements = (await query(
    `select id, project_number, filename, status, error, extract_method, agreement_type, title,
            counterparty, robot_types, robot_count, salesman_name, salesman_email, created_at
     from ops.legal_agreement where ${vis.sql} order by created_at desc limit 300`,
    vis.params
  )).rows;

  // Best submission per agreement (approved > finalized > saved).
  const subs = (await query(
    `select distinct on (agreement_id) agreement_id, id, status, submitted_by, answers
     from ops.tech_request_submission
     order by agreement_id,
              case status when 'approved' then 3 when 'finalized' then 2 when 'saved' then 1 else 0 end desc,
              created_at desc`
  )).rows;
  const subByAg = Object.fromEntries(subs.map((s) => [s.agreement_id, s]));

  // Confirmations, deduped by normalized SO (latest wins).
  const confs = (await query(
    'select submission_id, team, so_number, payload, created_at from ops.tech_confirmation order by created_at desc'
  )).rows;
  const confBySo = {};
  for (const c of confs) { const k = normSo(c.so_number); if (!(k in confBySo)) confBySo[k] = c; }

  // Stage-webhook events: travel approvals (matched by SO number) and manager
  // approvals (matched by the JotForm submission id we stored when finalizing).
  const ev = (await query('select submission_id, stage, payload from ops.jotform_stage_event')).rows;
  const travel = new Set();
  const approvedSubIds = new Set();
  for (const e of ev) {
    if (String(e.stage || '').startsWith('travel')) {
      const so = e.payload?.so_number || e.payload?.so || e.submission_id;
      if (so) travel.add(normSo(so));
    }
    if (e.stage === 'approved' && e.submission_id) approvedSubIds.add(String(e.submission_id));
  }

  const projects = agreements.map((a) => {
    const sub = subByAg[a.id] || null;
    const so = sub?.answers?.so_number;
    const conf = so ? confBySo[normSo(so)] : null;
    return buildProject(a, sub, conf, travel, approvedSubIds);
  });

  const counts = {};
  for (const s of PROJECT_STAGES) counts[s.key] = 0;
  for (const p of projects) counts[p.stage_key] = (counts[p.stage_key] || 0) + 1;

  return NextResponse.json({ stages: PROJECT_STAGES, projects, counts, count: projects.length });
}
