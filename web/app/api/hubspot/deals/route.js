import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { requireUser } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Deal picker for "connect a HubSpot deal" — searches the synced ext.hubspot_deal
// table by name (fast, no live API). Empty q → most-recently-modified deals.
export async function GET(request) {
  const { response } = await requireUser();
  if (response) return response;
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  const { rows } = await query(
    `select id, name, amount, stage_id, closedate, is_closed
       from ext.hubspot_deal
      where ($1 = '' or name ilike $2)
      order by lastmodified desc nulls last
      limit 25`,
    [q, `%${q}%`],
  );
  return NextResponse.json({ deals: rows });
}
