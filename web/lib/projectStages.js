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
  { key: 'closure', label: 'Installation & Closure', color: '#8b5cf6', tracked: true },
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
// doc (optional) = { name, preview, download } for an uploaded form document.
const task = (label, done, detail, url, doc) => ({
  label, status: done === null || done === undefined ? 'manual' : done ? 'done' : 'pending',
  detail: detail || null, url: url || null, doc: doc || null,
});

// Display name = the file's name on the form (last path segment of the JotForm URL).
const docName = (url) => {
  if (!url) return null;
  const raw = String(url).split('/').pop().split('?')[0];
  try { return decodeURIComponent(raw) || 'document'; } catch { return raw || 'document'; }
};
// Build the {name, preview, download} the UI links to (served by /api/proposal-file).
const docFor = (proposalId, key, url) => (proposalId && url ? {
  name: docName(url),
  preview: `/api/proposal-file/${proposalId}?doc=${key}`,
  download: `/api/proposal-file/${proposalId}?doc=${key}&dl=1`,
} : null);

// Viewable JotForm submission link from a submission id (NOT the api.jotform.com
// resource URL, which 401s in a browser). Used to link JotForm-sourced steps.
export const jotformUrl = (subId) => (subId ? `https://www.jotform.com/submission/${subId}` : null);

// The HubSpot deal linked to a proposal (Step 1), with the pulled customer.
const dealOf = (p) => (p && p.deal_id ? {
  id: p.deal_id, name: p.deal_name || null,
  amount: p.deal_amount != null ? Number(p.deal_amount) : null,
  customer: p.deal_customer || null,
} : null);

// Invoices connected to this project (ops.invoice rows whose project_id = the
// project id). Each is reduced to a compact card for the tracker's invoice stage.
const invLineAmt = (l) => (l && l.amount != null && l.amount !== '' ? Number(l.amount) : (Number(l?.quantity) || 0) * (Number(l?.unit_price) || 0));
const invoicesOf = (rows) => (Array.isArray(rows) ? rows : []).map((iv) => ({
  id: typeof iv.id === 'string' ? iv.id : String(iv.id),
  number: iv.invoice_number || iv.qb_doc_number || null,
  status: iv.status || 'draft',
  customer_name: iv.customer_name || null,
  total: (Array.isArray(iv.lines) ? iv.lines : []).reduce((s, l) => s + invLineAmt(l), 0),
  pushed: !!iv.qb_doc_number,
}));

// Final Proposal Form checklist, computed from a captured ops.project_proposal
// row (or null when no proposal is linked to this project yet → all pending).
function proposalTasks(proposal) {
  const p = proposal || null;
  const id = p && p.id;
  const pkg = (p && p.package_list) || [];
  const pkgText = pkg.map((x) => `${Number(x.quantity) > 1 ? `${x.quantity}× ` : ''}${x.item}`).join(', ');
  return [
    task('Submitted on JotForm', !!(p && p.submission_id),
      p && p.submission_id ? 'open the original proposal submission' : null,
      jotformUrl(p && p.submission_id)),
    task('Customer information', !!(p && (p.customer_name || p.customer_email)),
      p ? ([p.customer_name, p.customer_email].filter(Boolean).join(' · ') || null) : null),
    task('Project information & requirements', !!(p && p.project_info),
      p && p.project_info ? p.project_info.slice(0, 90) : null),
    task('Inventory package list', pkg.length > 0,
      pkg.length ? `${pkg.length} item(s): ${pkgText.slice(0, 80)}${pkgText.length > 80 ? '…' : ''}` : null,
      null, docFor(id, 'packing_list', p && p.packing_list_url)),
    task('Site survey report', !!(p && (p.site_survey_done || p.site_survey_url)),
      p && p.site_survey_url ? 'file uploaded' : (p && p.site_survey_done ? 'marked complete' : null),
      null, docFor(id, 'site_survey', p && p.site_survey_url)),
    task('Pre-deployment tech review', !!(p && p.predeploy_review_done),
      p && p.predeploy_review_done ? 'marked complete' : null),
    task('Deployment instruction', !!(p && p.deployment_url),
      p && p.deployment_url ? 'file uploaded' : null,
      null, docFor(id, 'deployment', p && p.deployment_url)),
  ];
}

export function buildProject(a, submission, confirmation, approvedSubmissionIds = new Set(), proposal = null, deniedSubmissionIds = new Set(), prep = null, install = null, shipment = null, invoices = []) {
  const projInvoices = invoicesOf(invoices);
  const ann = (submission && submission.answers) || {};
  const appr = ann._approval || null;
  const cal = ann._calendar || null;
  const jf = ann._jotform || null;
  const emailsSent = (ann._emails || []).filter((e) => e && e.sent).length;
  const conf = confirmation || null;
  const confPayload = (conf && conf.payload) || {};
  // A confirmation is "done" only when its latest decision is approved. Legacy rows
  // with no decision are treated as approved (back-compat). A denied confirmation
  // reopens when the form is resubmitted (a new submission row supersedes it).
  const confDenied = !!conf && confPayload.decision === 'denied';
  const confApproved = !!conf && !confDenied;
  const so = ann.so_number || '';

  // Onsite installation report (Stage 8), parsed from the On-site Customer
  // Checklist/Confirmation form (matched by SO). Closure is "done" once the report
  // says the install passed/completed (a Fail/Incomplete report leaves it pending).
  const inst = install || null;
  const installComplete = !!inst && /complete|pass|success|finish|done/i.test(inst.status || '');

  // Manager approval is satisfied by the in-app "Approve & schedule" (status=approved)
  // OR a JotForm workflow approval — a jotform_stage_event(stage='approved') whose
  // submission_id matches the one we pushed to JotForm when the form was finalized.
  const jfSubId = jf?.submission_id || jf?.submissionID || null;
  // Viewable submission link. NOT jf.url — that's the api.jotform.com resource URL,
  // which 401s in a browser. www.jotform.com/submission/<id> opens for logged-in users.
  const jfUrl = jfSubId ? `https://www.jotform.com/submission/${jfSubId}` : (jf?.url || null);
  const jotformApproved = !!(jfSubId && approvedSubmissionIds.has(String(jfSubId)));
  const managerApproved = submission?.status === 'approved' || jotformApproved;
  // Latest manager decision was a denial (and not since re-approved). Redoing the
  // tech request re-finalizes it → a new JotForm submission id → this clears and
  // the review reopens as pending.
  const managerDenied = !managerApproved && !!(jfSubId && deniedSubmissionIds.has(String(jfSubId)));

  // Team Preparation is done when all 3 department prep tasks are marked done by
  // their managers/admin (or a confirmation already exists, i.e. we're past it).
  // Gated behind manager approval so prep can't "complete" before the review step.
  const prepSteps = (prep && Array.isArray(prep.steps)) ? prep.steps : [];
  const prepAllDone = prepSteps.length === 3 && prepSteps.every((s) => s.done);

  const done = {
    proposal: !!proposal,
    agreement: true,
    request: ['finalized', 'approved'].includes(submission?.status),
    review: managerApproved,
    prep: confApproved || (managerApproved && prepAllDone),
    confirmation: confApproved,
    closure: installComplete,
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
          task('Agreement PDF uploaded', !!a.filename, null, null,
            a.filename ? {
              name: a.filename,
              preview: `/api/data-upload/${a.id}/file`,
              download: `/api/data-upload/${a.id}/file?dl=1`,
            } : null),
          task('AI extraction', a.status === 'ready', a.status === 'ready' ? a.extract_method : a.error),
          task('Customer (extracted)', !!(a.counterparty || a.client_contact_name),
            [a.counterparty, a.client_contact_name].filter(Boolean).join(' · ') || null),
          task('Customer contact (extracted)', !!(a.client_email || a.client_phone || a.client_address),
            [a.client_email, a.client_phone, a.client_address].filter(Boolean).join(' · ') || null),
          task('Salesman assigned', !!(a.salesman_name || a.salesman_email), a.salesman_name || a.salesman_email),
        ];
      case 'invoice':
        if (!projInvoices.length) return [task('QuickBooks invoice issued', null)];
        return projInvoices.map((iv) => task(
          `Invoice ${iv.number || '(draft)'}`,
          iv.pushed ? true : null,
          [iv.customer_name, iv.total ? `$${iv.total.toLocaleString()}` : null, iv.status].filter(Boolean).join(' · ') || null));
      case 'request':
        return [
          task('Request form drafted', !!submission, submission ? `by ${submission.submitted_by || ''}` : null),
          task('Submitted to JotForm', submission?.status === 'finalized' || submission?.status === 'approved', so ? `SO ${so}` : null, jfUrl),
        ];
      case 'review':
        return [
          task('Manager approval', managerApproved,
            appr ? `by ${appr.approved_by} · ${(appr.approved_at || '').slice(0, 10)}`
              : jotformApproved ? 'Approved in JotForm'
                : managerDenied ? '❌ Denied in JotForm — edit & resubmit to re-review'
                  : null),
          task('Team & sales notified', emailsSent > 0, emailsSent ? `${emailsSent} email(s) sent` : null),
        ];
      case 'prep': {
        const rows = prepSteps.length
          ? prepSteps.map((s) => ({
              label: s.title,
              status: s.done ? 'done' : 'pending',
              detail: s.done
                ? `by ${s.done_by_name || s.done_by_email || 'someone'}${s.done_at ? ` · ${String(s.done_at).slice(0, 10)}` : ''}`
                : `${s.department} dept`,
              url: null, doc: null,
              // Extra fields the tracker UI uses to render a mark-done control:
              prep_key: s.key, task_id: s.task_id || null, department: s.department,
              can_mark: !!s.can_mark,
              done_by_name: s.done_by_name || null, done_by_email: s.done_by_email || null, done_at: s.done_at || null,
            }))
          : [
              task('Shipping preparation', null),
              task('Prepare & test equipment', null),
              task('Customer communication (PM)', null),
            ];
        rows.push(task('Calendar invite (skipped for now)', null));
        return rows;
      }
      case 'confirmation':
        return [
          task('Technicians assigned', confApproved, (confPayload.technicians || []).join(', ') || null),
          task('Confirmation form approved', confApproved,
            confDenied ? '❌ Denied in JotForm — resubmit to re-confirm' : (confApproved ? (confPayload.team || null) : null),
            jotformUrl(conf?.submission_id)),
          task('Technicians arrival date set', confApproved && !!confPayload.fly_out, confPayload.fly_out ? `out ${confPayload.fly_out} → back ${confPayload.fly_back || '?'}` : null),
        ];
      case 'closure':
        // Driven by the On-site Customer Checklist/Confirmation form (matched by SO).
        // The stage bubble completes when the report's Status is Pass/Complete.
        return [
          task('Onsite installation', !!inst,
            inst ? [inst.technician, inst.date].filter(Boolean).join(' · ') || 'reported' : null),
          // Techs often set Status=Pass without ticking every per-robot checklist box,
          // so a passed install counts the checklist as done too (not stuck pending).
          task('Install checklist', inst ? (!!inst.checklist_done || installComplete) : null,
            inst ? (inst.checklist_done ? 'checklist items checked' : (installComplete ? `via status: ${inst.status}` : null)) : null),
          task('Customer sign-off', inst ? !!inst.customer_signed : null, inst?.customer_signed ? 'signed' : null),
          task('Project complete', inst ? installComplete : null, inst ? (inst.status || null) : null),
        ];
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
    id: a.id, project_number: a.project_number, contract_number: proposal?.contract_number || null,
    title: a.title, counterparty: a.counterparty,
    agreement_type: a.agreement_type, robot_types: a.robot_types, robot_count: a.robot_count,
    salesman_name: a.salesman_name, salesman_email: a.salesman_email, so_number: so,
    created_at: a.created_at, stage: stageIdx, stage_key: stageKey,
    jotform_url: jfUrl, calendar_link: cal?.html_link || null,
    prep_all_done: prepAllDone, confirmation_done: !!conf,
    proposal_id: proposal?.id || null, deal: dealOf(proposal),
    invoices: projInvoices,
    shipment: shipment ? {
      status: shipment.status || 'pending',
      shipping_needed: shipment.shipping_needed !== false,
      est_ship_date: shipment.est_ship_date ? String(shipment.est_ship_date).slice(0, 10) : null,
      est_delivery_date: shipment.est_delivery_date ? String(shipment.est_delivery_date).slice(0, 10) : null,
      carrier: shipment.carrier || null, tracking_number: shipment.tracking_number || null,
    } : null,
    nodes,
  };
}

// A standalone Project Tracker row for a proposal that has no agreement yet.
// The proposal is the project's first step, so it sits at stage 0 ("Final
// Proposal Form") with every downstream stage still pending/manual.
export function buildProposalProject(proposal, invoices = []) {
  const p = proposal;
  const projInvoices = invoicesOf(invoices);
  const invTasks = projInvoices.map((iv) => task(
    `Invoice ${iv.number || '(draft)'}`, iv.pushed ? true : null,
    [iv.customer_name, iv.total ? `$${iv.total.toLocaleString()}` : null, iv.status].filter(Boolean).join(' · ') || null));
  const done = { proposal: true };
  let stageIdx = 0;
  PROJECT_STAGES.forEach((s, i) => { if (s.tracked && done[s.key]) stageIdx = i; });
  const nodes = PROJECT_STAGES.map((s, i) => ({
    ...s,
    status: !s.tracked ? 'manual' : done[s.key] ? 'done' : i === stageIdx ? 'current' : 'pending',
    tasks: s.key === 'proposal' ? proposalTasks(p) : (s.key === 'invoice' ? invTasks : []),
  }));
  return {
    id: p.id, project_number: p.project_number || p.contract_number || 'PROPOSAL',
    contract_number: p.contract_number || null,
    title: p.project_name || p.customer_name || 'New proposal',
    counterparty: p.customer_name || null,
    agreement_type: null, robot_types: null, robot_count: null,
    salesman_name: p.sales_name || null, salesman_email: p.sales_email || null,
    so_number: '', created_at: p.created_at,
    stage: stageIdx, stage_key: 'proposal',
    jotform_url: jotformUrl(p.submission_id), calendar_link: null, is_proposal_only: true,
    proposal_id: p.id, deal: dealOf(p),
    invoices: projInvoices,
    nodes,
  };
}

// Normalize a customer/counterparty name for best-effort proposal↔agreement
// matching: "Acme, Inc." == "acme inc" == "ACME INC".
export function normName(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
