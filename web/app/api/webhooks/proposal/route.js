import { NextResponse, after } from 'next/server';
import { query } from '../../../../lib/db';
import { getJotformSubmission } from '../../../../lib/jotform';
import { extractPackageList, extractPackageListFromFile } from '../../../../lib/ai/extractPackages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PROJECT PROPOSAL FORM webhook. JotForm fires this when a proposal is APPROVED
// (Approval Flow webhook element). We read the submission back by id and parse
// it by question-id, then capture it in ops.project_proposal — the Project
// Tracker's entry-point stage. The proposal precedes the agreement, so this is
// the FIRST signal a project exists; the tracker seeds the "Final Proposal Form"
// checklist (and an AI-extracted inventory package list) from this row.
//
// No side-effects beyond capture + a best-effort AI extraction (which degrades
// to an empty list); scheduling/approval logic stays in JotForm.

// Question-id map for the PROJECT FINAL PROPOSAL FORM (261735294288165),
// verified against the live form via the JotForm API.
const QID = {
  contract_number: '157', project_name: '158',
  customer_name: '159', customer_email: '183',
  sales_name: '161', sales_email: '184',
  pm_name: '163', pm_email: '180',
  tech_lead_name: '165', tech_lead_email: '181',
  address: '167', project_info: '107',
  site_survey_file: '170', deployment_file: '174',
  packing_list_file: '186',
  // The live form has ONE combined checkbox ("Site Survey & Deployment Plan →
  // Completed Without Issues"). There is no separate pre-deploy checkbox, so this
  // single flag drives BOTH done-columns in the schema.
  completion: '172',
};

const ans = (answers, qid) => {
  const a = answers?.[qid];
  return a && typeof a === 'object' ? a : { answer: a };
};
// Plain text / email / textarea / textbox value.
function text(answers, qid) {
  const a = ans(answers, qid);
  let v = a.answer;
  if (v && typeof v === 'object') v = a.prettyFormat || '';
  return String(a.prettyFormat || v || '').trim();
}
// control_address → a single readable line (prefer JotForm's prettyFormat).
function address(answers, qid) {
  const a = ans(answers, qid);
  if (a.prettyFormat) return String(a.prettyFormat).trim();
  const v = a.answer;
  if (v && typeof v === 'object') {
    return [v.addr_line1, v.addr_line2, v.city, v.state, v.postal, v.country]
      .filter(Boolean).join(', ').trim();
  }
  return String(v || '').trim();
}
// control_checkbox "Completed" → boolean (answer may be an array or a string).
function checked(answers, qid) {
  const a = ans(answers, qid);
  const hay = JSON.stringify([a.answer, a.prettyFormat]).toLowerCase();
  return hay.includes('completed') || hay.includes('"yes"') || hay.includes('true');
}
// control_fileupload → first uploaded file URL (answer is a URL or array of URLs).
function fileUrl(answers, qid) {
  const a = ans(answers, qid);
  const v = a.answer;
  if (Array.isArray(v)) return String(v.find(Boolean) || '').trim();
  return String(v || a.prettyFormat || '').trim();
}

// Fast, synchronous parse — NO AI here. The slow Packing-List read+translate runs
// in after() (post-response) so the webhook replies in ~1s and JotForm's workflow
// webhook step doesn't time out (it was hanging on a ~17s response).
function parseProposal(answers) {
  const completed = checked(answers, QID.completion); // single combined checkbox
  return {
    contract_number: text(answers, QID.contract_number),
    project_name: text(answers, QID.project_name),
    customer_name: text(answers, QID.customer_name),
    customer_email: text(answers, QID.customer_email),
    sales_name: text(answers, QID.sales_name),
    sales_email: text(answers, QID.sales_email),
    pm_name: text(answers, QID.pm_name),
    pm_email: text(answers, QID.pm_email),
    tech_lead_name: text(answers, QID.tech_lead_name),
    tech_lead_email: text(answers, QID.tech_lead_email),
    address: address(answers, QID.address),
    project_info: text(answers, QID.project_info),
    site_survey_done: completed,
    predeploy_review_done: completed,
    site_survey_url: fileUrl(answers, QID.site_survey_file),
    deployment_url: fileUrl(answers, QID.deployment_file),
    packing_list_url: fileUrl(answers, QID.packing_list_file),
  };
}

async function handle(request) {
  const url = new URL(request.url);
  const q = url.searchParams;

  // Optional shared-secret gate: if JOTFORM_WEBHOOK_SECRET is set, require ?token=.
  const secret = process.env.JOTFORM_WEBHOOK_SECRET;
  if (secret && q.get('token') !== secret) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  // POST carries the submission in the body; GET carries it on the query string.
  let body = {};
  if (request.method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    try { body = ct.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData()); }
    catch { body = {}; }
  }
  const pick = (...keys) => {
    for (const k of keys) { if (body[k] != null) return body[k]; const v = q.get(k); if (v != null) return v; }
    return null;
  };

  const submissionId = pick('submissionID', 'submission_id', 'submissionId', 'sid');
  // A bare connection test (no submission) succeeds without writing a junk row.
  if (!submissionId) {
    return NextResponse.json({ ok: true, recorded: false, detail: 'no submissionID received — nothing recorded (test ping?)' });
  }
  let formId = pick('formID', 'form_id', 'formId');

  // Auto-capture: read the submission back and parse by qid. Best-effort — if the
  // API read fails (no key / transient), record a minimal row from any params and
  // DON'T clobber an existing good row.
  const fetched = await getJotformSubmission(submissionId);
  let p;
  if (fetched.ok) {
    p = parseProposal(fetched.answers);
    if (!formId) formId = fetched.form_id;
  } else {
    p = {
      contract_number: pick('contract_number') || '', project_name: pick('project_name') || '',
      customer_name: pick('customer_name', 'customerFull') || '', customer_email: pick('customer_email') || '',
      sales_name: '', sales_email: '', pm_name: '', pm_email: '', tech_lead_name: '', tech_lead_email: '',
      address: '', project_info: '', site_survey_done: false, predeploy_review_done: false,
      site_survey_url: '', deployment_url: '', packing_list_url: '', package_list: [],
      _fetch_error: fetched.error || fetched.skipped || 'unknown',
    };
  }
  // Store the FULL raw JotForm answers in payload when we read the submission back,
  // so no field is lost even if it has no dedicated column; fall back to the parsed
  // minimal object when the read failed.
  const rawPayload = fetched.ok ? fetched.answers : p;

  const conflict = fetched.ok
    ? `do update set form_id = coalesce(excluded.form_id, ops.project_proposal.form_id),
         contract_number = excluded.contract_number, project_name = excluded.project_name,
         customer_name = excluded.customer_name, customer_email = excluded.customer_email,
         sales_name = excluded.sales_name, sales_email = excluded.sales_email,
         pm_name = excluded.pm_name, pm_email = excluded.pm_email,
         tech_lead_name = excluded.tech_lead_name, tech_lead_email = excluded.tech_lead_email,
         address = excluded.address, project_info = excluded.project_info,
         site_survey_done = excluded.site_survey_done, predeploy_review_done = excluded.predeploy_review_done,
         site_survey_url = excluded.site_survey_url, deployment_url = excluded.deployment_url,
         packing_list_url = excluded.packing_list_url,
         payload = excluded.payload`
         // package_list is intentionally NOT updated here — it's filled by the
         // post-response after() block, so a re-fire never wipes it back to [].
    : 'do nothing'; // a failed re-read must not wipe a previously captured row

  await query(
    `insert into ops.project_proposal
       (submission_id, form_id, contract_number, project_name, customer_name, customer_email,
        sales_name, sales_email, pm_name, pm_email, tech_lead_name, tech_lead_email,
        address, project_info, site_survey_done, predeploy_review_done,
        site_survey_url, deployment_url, packing_list_url, package_list, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     on conflict (submission_id) ${conflict}`,
    [
      submissionId, formId, p.contract_number, p.project_name, p.customer_name, p.customer_email,
      p.sales_name, p.sales_email, p.pm_name, p.pm_email, p.tech_lead_name, p.tech_lead_email,
      p.address, p.project_info, p.site_survey_done, p.predeploy_review_done,
      p.site_survey_url, p.deployment_url, p.packing_list_url,
      '[]', JSON.stringify(rawPayload),
    ],
  );

  // Slow part (download Packing List PDF + AI read/translate) runs AFTER the
  // response is flushed, then back-fills package_list. Keeps the webhook ~1s so
  // JotForm's approval workflow doesn't hang on the webhook step.
  if (fetched.ok && (p.packing_list_url || p.project_info)) {
    after(async () => {
      try {
        let pkgs = await extractPackageListFromFile(p.packing_list_url);
        if (!pkgs || !pkgs.length) pkgs = await extractPackageList(p.project_info);
        if (pkgs && pkgs.length) {
          await query('update ops.project_proposal set package_list = $2 where submission_id = $1',
            [submissionId, JSON.stringify(pkgs)]);
        }
      } catch { /* best-effort: a missing package list never breaks capture */ }
    });
  }

  return NextResponse.json({
    ok: true, recorded: true, submission_id: submissionId,
    customer: p.customer_name || null, packages: 'extracting', captured: fetched.ok,
  });
}

export const GET = handle;
export const POST = handle;
