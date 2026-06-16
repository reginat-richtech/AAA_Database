import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Agreements available to start a tech request from, with their latest
// request status (none | saved | finalized | approved).
export async function GET() {
  const { rows } = await query(
    `select a.id, a.project_number, a.agreement_type, a.counterparty, a.robot_types,
            a.robot_count, a.salesman_name, a.salesman_email, a.created_at, a.status,
            coalesce(s.status, 'none') as request_status, s.id as submission_id
     from ops.legal_agreement a
     left join lateral (
        select id, status from ops.tech_request_submission t
        where t.agreement_id = a.id
        order by case status when 'approved' then 3 when 'finalized' then 2 when 'saved' then 1 else 0 end desc,
                 created_at desc
        limit 1
     ) s on true
     order by a.created_at desc
     limit 100`
  );
  return NextResponse.json({ agreements: rows, count: rows.length });
}
