import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';
import { requireUser } from '../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public URL of the Travel Request Form (JotForm). People fill THIS to start a
// request; submissions flow back via the jotform-stage webhook (?stage=travel_submit)
// and approvals via the Approval Flow webhook (?stage=travel).
const TRF_FORM_ID = process.env.TRAVEL_REQUEST_FORM_ID || '253216066321044';
const FORM_URL = process.env.TRAVEL_REQUEST_FORM_URL || `https://form.jotform.com/${TRF_FORM_ID}`;

// Standalone Travel Requests tracker — display-only. JotForm is the front door
// (Option B): the website shows submissions and links out to the form to start one.
export async function GET() {
  const { response } = await requireUser();
  if (response) return response;

  const rows = (await query(
    `select t.id, t.traveler, t.purpose, t.destination, t.start_date, t.end_date,
            t.notes, t.status, t.source, t.so_number, t.agreement_id, t.payload, t.created_at,
            a.project_number, a.title as project_title, a.counterparty
       from ops.travel_request t
       left join ops.legal_agreement a on a.id = t.agreement_id
      order by t.created_at desc
      limit 500`
  )).rows;

  const requests = rows.map((r) => ({
    id: r.id,
    traveler: r.traveler || r.payload?.traveler || r.payload?.name || null,
    purpose: r.purpose || null,
    destination: r.destination || null,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status || 'requested',
    source: r.source || 'jotform',
    so_number: r.so_number || null,
    project: r.agreement_id
      ? { id: r.agreement_id, project_number: r.project_number, title: r.project_title, counterparty: r.counterparty }
      : null,
    created_at: r.created_at,
    jotform_url: r.payload?.url || r.payload?.editUrl || null,
  }));

  return NextResponse.json({ requests, count: requests.length, formUrl: FORM_URL });
}
