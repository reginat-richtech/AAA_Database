import { NextResponse } from 'next/server';
import { query, mutateAs } from '../../../../lib/db';
import { requireUser } from '../../../../lib/access';
import { fetchDealCustomer } from '../../../../lib/integrations/hubspotDeals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Connect (or unlink) a HubSpot deal to a project at Step 1. Stores deal_id +
// cached name/amount on ops.project_proposal, and pulls the deal's CUSTOMER
// (company + primary contact) live from HubSpot. Admin or the proposal's
// salesperson only. Body: { proposal_id, deal_id } (deal_id null/'' to unlink).
export async function POST(request) {
  const { user, response } = await requireUser();
  if (response) return response;
  let body = {};
  try { body = await request.json(); } catch { /* */ }
  const proposalId = body.proposal_id;
  const dealId = body.deal_id ? String(body.deal_id) : null;
  if (!proposalId) return NextResponse.json({ error: 'proposal_id is required' }, { status: 400 });

  const prop = (await query('select id, sales_email from ops.project_proposal where id = $1', [proposalId])).rows[0];
  if (!prop) return NextResponse.json({ error: 'proposal not found' }, { status: 404 });
  if (!user.isAdmin && prop.sales_email && prop.sales_email.toLowerCase() !== user.email) {
    return NextResponse.json({ error: 'Only an admin or the project salesperson can change the deal.' }, { status: 403 });
  }

  if (!dealId) {
    await mutateAs(user.email, (q) => q(
      `update ops.project_proposal set deal_id=null, deal_name=null, deal_amount=null, deal_customer=null, deal_linked_at=null where id=$1`,
      [proposalId]));
    return NextResponse.json({ ok: true, cleared: true });
  }

  const deal = (await query('select id, name, amount from ext.hubspot_deal where id = $1', [dealId])).rows[0];
  if (!deal) return NextResponse.json({ error: 'deal not found in synced HubSpot data' }, { status: 404 });

  // Pull the customer (company + contact) from HubSpot — best-effort.
  const customer = await fetchDealCustomer(dealId);

  await mutateAs(user.email, (q) => q(
    `update ops.project_proposal
        set deal_id=$2, deal_name=$3, deal_amount=$4, deal_customer=$5, deal_linked_at=now()
      where id=$1`,
    [proposalId, dealId, deal.name || null, deal.amount ?? null, customer ? JSON.stringify(customer) : null]));

  return NextResponse.json({ ok: true, deal: { id: dealId, name: deal.name || null, amount: deal.amount ?? null, customer } });
}
