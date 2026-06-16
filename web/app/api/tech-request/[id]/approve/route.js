import { NextResponse } from 'next/server';
import { query } from '../../../../../lib/db';
import { scheduleLeaderFor, scheduleDateFor, renderSubmission } from '../../../../../lib/techRequestForm';
import { calendarCreate, sendEmail } from '../../../../../lib/google';
import { requireUser } from '../../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Manager approval → calendar invite + email notifications → status 'approved'.
// Approval is a manager action — restricted to admins (ADMIN_EMAILS).
export async function POST(_request, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!user.isAdmin) return NextResponse.json({ error: 'Only a manager can approve.' }, { status: 403 });
  const { id } = await params;
  const sub = (await query(
    `select s.id, s.agreement_type, s.status, s.answers, a.counterparty
     from ops.tech_request_submission s
     join ops.legal_agreement a on a.id = s.agreement_id
     where s.id = $1`, [id]
  )).rows[0];
  if (!sub) return NextResponse.json({ error: 'submission not found' }, { status: 404 });

  const answers = sub.answers || {};
  const leader = scheduleLeaderFor(sub.agreement_type, answers);
  const fallback = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const date = scheduleDateFor(sub.agreement_type, answers) || fallback;
  const { text, html } = renderSubmission(sub.agreement_type, answers, sub.counterparty);

  const calendar = await calendarCreate({
    summary: `Tech Request — ${sub.counterparty || ''}`,
    description: text,
    date,
    attendees: [leader, answers.requester_email],
  });

  const recipients = [
    { email: leader, role: 'team_manager' },
    { email: answers.requester_email, role: 'sales' },
  ].filter((r) => r.email);
  const emails = [];
  for (const r of recipients) {
    const res = await sendEmail({
      to: r.email,
      subject: `Tech Request approved — ${sub.counterparty || ''}`,
      text, html,
    });
    emails.push({ ...res, role: r.role });
  }

  answers._approval = { approved_by: user.email, approved_at: new Date().toISOString(), leader };
  answers._calendar = calendar;
  answers._emails = emails;
  await query(
    'update ops.tech_request_submission set status = $2, answers = $3 where id = $1',
    [id, 'approved', JSON.stringify(answers)]
  );

  return NextResponse.json({ id, status: 'approved', leader, calendar, emails });
}
