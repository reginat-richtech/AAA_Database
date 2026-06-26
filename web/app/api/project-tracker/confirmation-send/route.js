import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { query } from '../../../../lib/db';
import { sendEmail } from '../../../../lib/google';
import { PREP_AUTO_TASKS } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The live Technician Confirmation form (see /api/webhooks/tech-confirmation).
const CONFIRMATION_FORM_ID = '261615438877065';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Send the Technician Confirmation form for a project once Team Preparation is
// done (calendar step skipped for now). Best-effort email — never throws.
//   POST { project_id }
export async function POST(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  // A manager or admin moves the project to the confirmation step.
  if (!(user.isAdmin || user.title === 'manager')) {
    return NextResponse.json({ error: 'Only a manager or an admin can send the confirmation form.' }, { status: 403 });
  }

  const b = await req.json().catch(() => ({}));
  const projectId = b.project_id ? String(b.project_id) : null;
  if (!projectId) return NextResponse.json({ error: 'project_id is required.' }, { status: 400 });

  const agreement = (await query(
    `select id::text as id, project_number, title, counterparty, salesman_email
       from ops.legal_agreement where id::text = $1`, [projectId],
  )).rows[0];
  if (!agreement) return NextResponse.json({ error: 'Unknown project.' }, { status: 404 });

  // Require all 3 prep steps done before sending.
  const prep = (await query(
    `select auto_key, status, done_by_email from ext.task where project_id = $1 and auto_key is not null`,
    [projectId],
  )).rows;
  const doneKeys = new Set(prep.filter((p) => p.status === 'done').map((p) => p.auto_key));
  const allDone = PREP_AUTO_TASKS.every((p) => doneKeys.has(p.key));
  if (!allDone) {
    return NextResponse.json({ error: 'All Team Preparation steps must be marked done first.' }, { status: 409 });
  }

  // Recipient: the tech person who completed "Prepare & test equipment", else the
  // salesperson on the agreement.
  const techDoneBy = prep.find((p) => p.auto_key === 'equipment')?.done_by_email || null;
  const to = techDoneBy || agreement.salesman_email || null;
  if (!to) return NextResponse.json({ error: 'No recipient found (no tech contact or salesperson on the project).' }, { status: 422 });

  const link = `https://form.jotform.com/${CONFIRMATION_FORM_ID}`;
  const customer = agreement.counterparty || agreement.title || 'the customer';
  const html =
    `<p>Team Preparation is complete for <strong>${esc(customer)}</strong> (${esc(agreement.project_number)}).</p>` +
    `<p>Please complete the <strong>Technician Confirmation form</strong> to assign technicians and set arrival dates:</p>` +
    `<p><a href="${esc(link)}">${esc(link)}</a></p>` +
    `<p style="color:#888;font-size:12px">— AAA Project Tracker</p>`;

  let notify;
  try {
    notify = await sendEmail({
      to,
      subject: `Technician Confirmation needed: ${agreement.project_number}`,
      text: `Team prep is done for ${customer} (${agreement.project_number}). Complete the Technician Confirmation form: ${link}`,
      html,
    });
  } catch (e) {
    notify = { to, error: String(e?.message || e) };
  }

  return NextResponse.json({ ok: true, link, notify });
}
