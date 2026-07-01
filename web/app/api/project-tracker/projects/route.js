import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { PROJECT_STAGES, normSo, normName, buildProject, buildProposalProject } from '../../../../lib/projectStages';
import { requireUser, visibilitySql } from '../../../../lib/access';
import { PREP_AUTO_TASKS } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  // Restrict projects to agreements this user owns (admins see all).
  const vis = visibilitySql(user, 1);

  const agreements = (await query(
    `select id, project_number, filename, status, error, extract_method, agreement_type, title,
            counterparty, robot_types, robot_count, salesman_name, salesman_email, contract_number, proposal_id, created_at,
            extracted_json->>'client_contact_name' as client_contact_name,
            extracted_json->>'client_email'        as client_email,
            extracted_json->>'client_phone'        as client_phone,
            extracted_json->>'client_address'      as client_address
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

  // Stage-webhook events: manager approve/deny decisions (matched by the JotForm
  // submission id we stored when finalizing). The LATEST decision per submission
  // wins, so a deny after an approve (or a re-approve after a deny) reflects
  // correctly. Travel lives in ops.travel_request / the /travel-requests page now.
  const decisions = (await query(
    `select submission_id, stage, received_at from ops.jotform_stage_event
      where stage in ('approved','denied') and submission_id is not null`
  )).rows;
  const latest = {};
  for (const e of decisions) {
    const k = String(e.submission_id);
    if (!latest[k] || e.received_at > latest[k].at) latest[k] = { stage: e.stage, at: e.received_at };
  }
  const approvedSubIds = new Set(Object.keys(latest).filter((k) => latest[k].stage === 'approved'));
  const deniedSubIds = new Set(Object.keys(latest).filter((k) => latest[k].stage === 'denied'));

  // Onsite installation reports (Stage 8 — On-site Customer Checklist/Confirmation),
  // matched by normalized SO; latest per SO wins. Captured by the jotform-stage
  // webhook (?stage=installation).
  const installBySo = {};
  try {
    const installEv = (await query(
      `select payload, received_at from ops.jotform_stage_event where stage = 'installation' order by received_at desc`
    )).rows;
    for (const e of installEv) { const k = normSo(e.payload?.so_number); if (k && !(k in installBySo)) installBySo[k] = e.payload; }
  } catch { /* ignore */ }

  // Shipment per project (ops.shipment, one row per agreement id) — surfaces the
  // shipping estimate on each card. Degrades to none if ops.shipment isn't migrated.
  const shipByProject = {};
  try {
    const shipRows = (await query(
      `select project_id, est_ship_date, est_delivery_date, status, carrier, tracking_number, shipping_needed
         from ops.shipment`
    )).rows;
    for (const s of shipRows) shipByProject[String(s.project_id)] = s;
  } catch { /* ops.shipment not migrated yet */ }

  // Invoices connected to each project (ops.invoice.project_id = agreement/proposal id).
  // Surfaced on the QuickBooks Invoice stage; people connect an existing invoice here.
  const invByProject = {};
  try {
    const invRows = (await query(
      `select id::text as id, project_id, invoice_number, qb_doc_number, customer_name, status, lines, created_at
         from ops.invoice where project_id is not null order by created_at`
    )).rows;
    for (const r of invRows) { (invByProject[String(r.project_id)] ||= []).push(r); }
  } catch { /* ops.invoice not migrated yet */ }

  // Final Proposal Form submissions — the project's entry point (they precede
  // the agreement). Latest per normalized customer name wins for best-effort
  // matching to an agreement; unmatched ones become standalone stage-0 projects.
  // Degrade gracefully if ops.project_proposal isn't migrated yet (0170) so the
  // tracker still renders agreements rather than 500ing the whole page.
  let proposals = [];
  try {
    proposals = (await query(
      `select id, submission_id, form_id, project_number, contract_number, project_name, customer_name, customer_email,
              sales_name, sales_email, deployment_url, site_survey_url, packing_list_url,
              site_survey_done, predeploy_review_done, project_info, package_list, created_at,
              deal_id, deal_name, deal_amount, deal_customer
       from ops.project_proposal order by created_at desc`
    )).rows;
  } catch (e) {
    console.warn('[project-tracker] ops.project_proposal unavailable — run migration 0170 to enable proposals:', e.message);
  }
  // Index proposals three ways. The agreement's proposal_id (set when the upload
  // was started from a proposal's "+ Upload agreement") is the EXACT link and wins.
  // Contract/SO number is the next-most-reliable (the agreement carries the
  // proposal's contract_number); customer name is a best-effort last resort for
  // agreements uploaded outside the proposal flow.
  const propById = {};
  const propByCustomer = {};
  const propByContract = {};
  for (const p of proposals) {
    propById[p.id] = p;
    const ck = normName(p.customer_name); if (ck && !(ck in propByCustomer)) propByCustomer[ck] = p;
    const cn = normSo(p.contract_number); if (cn && !(cn in propByContract)) propByContract[cn] = p;
  }

  // Team-Preparation tasks (the 3 department prep steps live in ext.task as
  // auto_key rows). Each step is markable only by that department's manager or an
  // admin; here we read each step's status + who marked it. Degrades to none if
  // ext.task isn't present yet.
  const prepByProject = {};
  try {
    const prepRows = (await query(
      `select id, project_id, auto_key, status, done_by_name, done_by_email, done_at
         from ext.task where auto_key is not null`
    )).rows;
    for (const r of prepRows) {
      if (!prepByProject[r.project_id]) prepByProject[r.project_id] = {};
      prepByProject[r.project_id][r.auto_key] = r;
    }
  } catch { /* ext.task not migrated yet */ }

  const prepFor = (agreementId) => ({
    steps: PREP_AUTO_TASKS.map((pt) => {
      const t = prepByProject[String(agreementId)]?.[pt.key] || null;
      return {
        key: pt.key, title: pt.title, department: pt.department,
        task_id: t?.id || null,
        done: t?.status === 'done',
        done_by_name: t?.done_by_name || null,
        done_by_email: t?.done_by_email || null,
        done_at: t?.done_at || null,
        can_mark: user.isAdmin || (user.title === 'manager' && user.department === pt.department),
      };
    }),
  });

  const matchedProposalIds = new Set();
  const projects = agreements.map((a) => {
    const sub = subByAg[a.id] || null;
    const so = sub?.answers?.so_number;
    const conf = so ? confBySo[normSo(so)] : null;
    const proposal = (a.proposal_id && propById[a.proposal_id])
      || (a.contract_number && propByContract[normSo(a.contract_number)])
      || propByCustomer[normName(a.counterparty)] || null;
    if (proposal) matchedProposalIds.add(proposal.id);
    const install = so ? installBySo[normSo(so)] || null : null;
    const shipment = shipByProject[String(a.id)] || null;
    return buildProject(a, sub, conf, approvedSubIds, proposal, deniedSubIds, prepFor(a.id), install, shipment, invByProject[String(a.id)] || []);
  });

  // Unmatched proposals stand on their own as stage-0 entry points (owner = the
  // salesperson; admins see all), listed ahead of agreement-rooted projects.
  const proposalOnly = proposals
    .filter((p) => !matchedProposalIds.has(p.id))
    .filter((p) => user.isAdmin || (p.sales_email && p.sales_email.toLowerCase() === user.email))
    .map((p) => buildProposalProject(p, invByProject[String(p.id)] || []));
  const allProjects = [...proposalOnly, ...projects];

  const counts = {};
  for (const s of PROJECT_STAGES) counts[s.key] = 0;
  for (const p of allProjects) counts[p.stage_key] = (counts[p.stage_key] || 0) + 1;
  // The Invoice stage isn't a tracked/linear step, so no project's stage_key is
  // 'invoice'. Surface a real number on the top rail = projects that have an invoice
  // (created in-app or connected/imported from QuickBooks).
  counts.invoice = allProjects.filter((p) => (p.invoices || []).length > 0).length;

  return NextResponse.json({ stages: PROJECT_STAGES, projects: allProjects, counts, count: allProjects.length });
}
