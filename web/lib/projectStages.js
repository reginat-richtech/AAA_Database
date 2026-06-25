// Project Tracker stage model — ported from the AAA app's PROJECT_STAGES +
// per-project node/task computation (admin.py). Read-only: it joins an
// agreement with its best tech-request submission and a tech confirmation
// (by normalized SO number).
//
// NOTE: Travel was pulled out of this pipeline into its own standalone tracker
// (ops.travel_request + /travel-requests). There is intentionally no travel stage
// here anymore.

export const PROJECT_STAGES = [
  { key: 'proposal', label: 'Final Proposal Form', color: '#ef4444', tracked: true },
  { key: 'agreement', label: 'Agreement', color: '#f97316', tracked: true },
  { key: 'invoice', label: 'QuickBooks Invoice', color: '#eab308', tracked: false },
  { key: 'request', label: 'Technician Request Form', color: '#84cc16', tracked: true },
  { key: 'review', label: 'Tech Department Review & Approve', color: '#22c55e', tracked: true },
  { key: 'prep', label: 'Team Preparation', color: '#14b8a6', tracked: true },
  { key: 'confirmation', label: 'Technician Confirmation', color: '#0ea5e9', tracked: true },
  { key: 'closure', label: 'Installation & Closure', color: '#8b5cf6', tracked: false },
  { key: 'finance', label: 'Finance Review & Reconciliation', color: '#ec4899', tracked: false },
];

// The Step-1 (Final Proposal Form) intake checklist. Each item is computed from
// a captured ops.project_proposal row (see proposalTasks); the labels mirror the
// PROJECT PROPOSAL FORM's real fields, captured via /api/webhooks/proposal.
export const PROPOSAL_CHECKS = [
  { key: 'customer_info', label: 'Customer information' },
  { key: 'project_info', label: 'Project information & requirements' },
  { key: 'inventory_package', label: 'Inventory package list' },
  { key: 'site_survey', label: 'Site survey report' },
  { key: 'predeploy_review', label: 'Pre-deployment tech review' },
  { key: 'deployment_instruction', label: 'Deployment instruction' },
];

// True once a project has reached the Team Preparation step — i.e. its Tech
// Department Review & Approve step is complete (approved in-app or via JotForm).
// `submission` is the project's best tech-request submission. Gates which
// projects appear in Task Tracking and accept task assignment.
export function reachedTeamPrep(submission, approvedSubmissionIds = new Set()) {
  if (!submission) return false;
  if (submission.status === 'approved') return true;
  const jf = submission.answers?._jotform || null;
  const jfSubId = jf?.submission_id || jf?.submissionID || null;
  return !!(jfSubId && approvedSubmissionIds.has(String(jfSubId)));
}

// Normalize an SO number for cross-table matching: "SO-1234" == "so 1234" == "1234".
export function normSo(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SO/, '');
}

// done=null → "manual" (untracked); true/false → "done"/"pending".
const task = (label, done, detail, url) => ({
  label, status: done === null || done === undefined ? 'manual' : done ? 'done' : 'pending',
  detail: detail || null, url: url || null,
});

// Final Proposal Form checklist, computed from a captured ops.project_proposal
// row (or null when no proposal is linked to this project yet → all pending).
function proposalTasks(proposal) {
  const p = proposal || null;
  const pkg = (p && p.package_list) || [];
  const pkgText = pkg.map((x) => `${Number(x.quantity) > 1 ? `${x.quantity}× ` : ''}${x.item}`).join(', ');
  return [
    task('Customer information', !!(p && (p.customer_name || p.customer_email)),
      p ? ([p.customer_name, p.customer_email].filter(Boolean).join(' · ') || null) : null),
    task('Project information & requirements', !!(p && p.project_info),
      p && p.project_info ? p.project_info.slice(0, 90) : null),
    task('Inventory package list', pkg.length > 0, pkgText || null, (p && p.deployment_url) || null),
    task('Site survey report', !!(p && (p.site_survey_done || p.site_survey_url)),
      p && p.site_survey_url ? 'file uploaded' : (p && p.site_survey_done ? 'marked complete' : null),
      (p && p.site_survey_url) || null),
    task('Pre-deployment tech review', !!(p && p.predeploy_review_done),
      p && p.predeploy_review_done ? 'marked complete' : null),
    task('Deployment instruction', !!(p && p.deployment_url),
      p && p.deployment_url ? 'file uploaded' : null, (p && p.deployment_url) || null),
  ];
}

export function buildProject(a, submission, confirmation, approvedSubmissionIds = new Set(), proposal = null) {
  const ann = (submission && submission.answers) || {};
  const appr = ann._approval || null;
  const cal = ann._calendar || null;
  const jf = ann._jotform || null;
  const emailsSent = (ann._emails || []).filter((e) => e && e.sent).length;
  const conf = confirmation || null;
  const confPayload = (conf && conf.payload) || {};
  const so = ann.so_number || '';

  // Manager approval is satisfied by the in-app "Approve & schedule" (status=approved)
  // OR a JotForm workflow approval — a jotform_stage_event(stage='approved') whose
  // submission_id matches the one we pushed to JotForm when the form was finalized.
  const jfSubId = jf?.submission_id || jf?.submissionID || null;
  const jotformApproved = !!(jfSubId && approvedSubmissionIds.has(String(jfSubId)));
  const managerApproved = submission?.status === 'approved' || jotformApproved;

  const done = {
    proposal: !!proposal,
    agreement: true,
    request: ['finalized', 'approved'].includes(submission?.status),
    review: managerApproved,
    prep: !!conf,
    confirmation: !!conf,
  };

  // current stage = furthest tracked node that is done
  let stageIdx = 0;
  PROJECT_STAGES.forEach((s, i) => { if (s.tracked && done[s.key]) stageIdx = i; });
  const stageKey = PROJECT_STAGES[stageIdx].key;

  const tasksFor = (key) => {
    switch (key) {
      case 'proposal':
        return proposalTasks(proposal);
      case 'agreement':
        return [
          task('Agreement PDF uploaded', !!a.filename, a.filename),
          task('AI extraction', a.status === 'ready', a.status === 'ready' ? a.extract_method : a.error),
          task('Salesman assigned', !!(a.salesman_name || a.salesman_email), a.salesman_name || a.salesman_email),
        ];
      case 'invoice':
        return [task('QuickBooks invoice issued', null)];
      case 'request':
        return [
          task('Request form drafted', !!submission, submission ? `by ${submission.submitted_by || ''}` : null),
          task('Submitted to JotForm', submission?.status === 'finalized' || submission?.status === 'approved', so ? `SO ${so}` : null, jf?.url || null),
        ];
      case 'review':
        return [
          task('Manager approval', managerApproved, appr ? `by ${appr.approved_by} · ${(appr.approved_at || '').slice(0, 10)}` : (jotformApproved ? 'Approved in JotForm' : null)),
          task('Team & sales notified', emailsSent > 0, emailsSent ? `${emailsSent} email(s) sent` : null),
        ];
      case 'prep':
        return [
          task('Shipping preparation', null),
          task('Prepare & test equipment', null), task('Customer communication (PM)', null),
          task('Calendar invite created', !!cal?.html_link, cal?.date, cal?.html_link),
        ];
      case 'confirmation':
        return [
          task('Technicians assigned', !!conf, (confPayload.technicians || []).join(', ') || null),
          task('Confirmation form approved', !!conf, confPayload.team || null),
          task('Technicians arrival date set', !!confPayload.fly_out, confPayload.fly_out ? `out ${confPayload.fly_out} → back ${confPayload.fly_back || '?'}` : null),
        ];
      case 'closure':
        return [task('Onsite installation', null), task('Install checklist', null), task('Customer sign-off', null), task('Project complete', null)];
      case 'finance':
        return [
          task('Final invoice issued & sent', null),
          task('Payment received', null),
          task('Income reconciled in QuickBooks', null),
          task('Expenses & travel costs reconciled', null),
          task('Project financials closed', null),
        ];
      default: return [];
    }
  };

  const nodes = PROJECT_STAGES.map((s, i) => ({
    ...s,
    status: !s.tracked ? 'manual' : done[s.key] ? 'done' : i === stageIdx ? 'current' : 'pending',
    tasks: tasksFor(s.key),
  }));

  return {
    id: a.id, project_number: a.project_number, title: a.title, counterparty: a.counterparty,
    agreement_type: a.agreement_type, robot_types: a.robot_types, robot_count: a.robot_count,
    salesman_name: a.salesman_name, salesman_email: a.salesman_email, so_number: so,
    created_at: a.created_at, stage: stageIdx, stage_key: stageKey,
    jotform_url: jf?.url || null, calendar_link: cal?.html_link || null,
    nodes,
  };
}

// A standalone Project Tracker row for a proposal that has no agreement yet.
// The proposal is the project's first step, so it sits at stage 0 ("Final
// Proposal Form") with every downstream stage still pending/manual.
export function buildProposalProject(proposal) {
  const p = proposal;
  const done = { proposal: true };
  let stageIdx = 0;
  PROJECT_STAGES.forEach((s, i) => { if (s.tracked && done[s.key]) stageIdx = i; });
  const nodes = PROJECT_STAGES.map((s, i) => ({
    ...s,
    status: !s.tracked ? 'manual' : done[s.key] ? 'done' : i === stageIdx ? 'current' : 'pending',
    tasks: s.key === 'proposal' ? proposalTasks(p) : [],
  }));
  return {
    id: p.id, project_number: p.contract_number || 'PROPOSAL',
    title: p.project_name || p.customer_name || 'New proposal',
    counterparty: p.customer_name || null,
    agreement_type: null, robot_types: null, robot_count: null,
    salesman_name: p.sales_name || null, salesman_email: p.sales_email || null,
    so_number: '', created_at: p.created_at,
    stage: stageIdx, stage_key: 'proposal',
    jotform_url: null, calendar_link: null, is_proposal_only: true,
    nodes,
  };
}

// Normalize a customer/counterparty name for best-effort proposal↔agreement
// matching: "Acme, Inc." == "acme inc" == "ACME INC".
export function normName(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
