// Project Tracker stage model — ported from the AAA app's PROJECT_STAGES +
// per-project node/task computation (admin.py). Read-only: it joins an
// agreement with its best tech-request submission, a tech confirmation
// (by normalized SO number), and travel stage-webhook events.

export const PROJECT_STAGES = [
  { key: 'proposal', label: 'Final Proposal Form', color: '#ef4444', tracked: false },
  { key: 'agreement', label: 'Agreement', color: '#f97316', tracked: true },
  { key: 'invoice', label: 'QuickBooks Invoice', color: '#eab308', tracked: false },
  { key: 'request', label: 'Technician Request Form', color: '#84cc16', tracked: true },
  { key: 'review', label: 'Review & Scheduling', color: '#22c55e', tracked: true },
  { key: 'prep', label: 'Team Preparation', color: '#14b8a6', tracked: true },
  { key: 'confirmation', label: 'Technician Confirmation', color: '#0ea5e9', tracked: true },
  { key: 'travel', label: 'Trip & Travel Requests', color: '#6366f1', tracked: true },
  { key: 'closure', label: 'Installation & Closure', color: '#8b5cf6', tracked: false },
];

// Normalize an SO number for cross-table matching: "SO-1234" == "so 1234" == "1234".
export function normSo(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SO/, '');
}

// done=null → "manual" (untracked); true/false → "done"/"pending".
const task = (label, done, detail, url) => ({
  label, status: done === null || done === undefined ? 'manual' : done ? 'done' : 'pending',
  detail: detail || null, url: url || null,
});

export function buildProject(a, submission, confirmation, travelApprovedSet, approvedSubmissionIds = new Set()) {
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
    agreement: true,
    request: ['finalized', 'approved'].includes(submission?.status),
    review: managerApproved,
    prep: !!conf,
    confirmation: !!conf,
    travel: travelApprovedSet.has(normSo(so)) || (!!conf && emailsSent > 0),
  };

  // current stage = furthest tracked node that is done
  let stageIdx = 0;
  PROJECT_STAGES.forEach((s, i) => { if (s.tracked && done[s.key]) stageIdx = i; });
  const stageKey = PROJECT_STAGES[stageIdx].key;

  const tasksFor = (key) => {
    switch (key) {
      case 'proposal':
        return [task('Customer information', null), task('Customer requirements', null), task('Inventory needed', null)];
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
          task('Calendar invite created', !!cal?.html_link, cal?.date, cal?.html_link),
          task('Team & sales notified', emailsSent > 0, emailsSent ? `${emailsSent} email(s) sent` : null),
        ];
      case 'prep':
        return [
          task('Assign technician', !!conf, (confPayload.technicians || []).join(', ') || null),
          task('Prepare & test equipment', null), task('Customer communication (PM)', null),
          task('Robot availability & inventory', null),
        ];
      case 'confirmation':
        return [
          task('Confirmation form approved', !!conf, confPayload.team || null),
          task('Travel dates set', !!confPayload.fly_out, confPayload.fly_out ? `out ${confPayload.fly_out} → back ${confPayload.fly_back || '?'}` : null),
          task('Technicians assigned', !!(confPayload.technicians || []).length, (confPayload.technicians || []).join(', ') || null),
        ];
      case 'travel':
        return [
          task('Manager approval (travel)', travelApprovedSet.has(normSo(so)), travelApprovedSet.has(normSo(so)) ? 'Travel request approved' : null),
          task('Navan booking', null), task('Finance approval', null),
        ];
      case 'closure':
        return [task('Onsite installation', null), task('Install checklist', null), task('Customer sign-off', null), task('Project complete', null)];
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
