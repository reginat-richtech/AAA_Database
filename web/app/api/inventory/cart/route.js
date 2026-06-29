import { NextResponse } from 'next/server';
import { requireUser } from '../../../../lib/access';
import { query, mutateAs } from '../../../../lib/db';
import { normName } from '../../../../lib/projectStages';
import { matchPackageList } from '../../../../lib/inventoryMatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-project "inventory needed" carts. Each project carries its form info (robot
// types/count from the agreement) so the inventory team knows what it needs; the
// cart itself reuses inventory.project_allocation (same data the Task Tracker shows).
// Each project also gets a `recommendations` pick-list: its proposal's AI-extracted
// package list matched to current stock (what's needed vs what's on hand).
export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;
  const canEdit = user.isAdmin || user.department === 'inventory';
  // Only the inventory MANAGER (or an admin) signs off the finished checklist.
  const canConfirm = user.isAdmin || (user.title === 'manager' && user.department === 'inventory');

  const projects = (await query(
    `select id::text as id, project_number, title, counterparty, agreement_type, robot_types, robot_count, created_at
       from ops.legal_agreement order by created_at desc limit 500`,
  )).rows;

  let carts = [], inventory = [];
  try {
    carts = (await query(
      `select id, project_id, cn_sku_id, sku, product_name, quantity, note, added_by, created_at
         from inventory.project_allocation order by created_at`,
    )).rows;
    inventory = (await query(
      `select id, sku, product_name, quantity, category, product_line, item_class
         from inventory.cn_sku order by product_name limit 1000`,
    )).rows;
  } catch { carts = []; inventory = []; }

  // Proposals = the project's entry point (they precede the agreement). Matched to
  // an agreement by normalized customer name — the same join the Project Tracker
  // uses. Degrades to none if the proposal table (0170) isn't present.
  let proposals = [];
  try {
    proposals = (await query(
      `select id::text as id, contract_number, project_name, customer_name, package_list, created_at
         from ops.project_proposal order by created_at desc`,
    )).rows;
  } catch { proposals = []; }
  const propByCustomer = {};
  for (const p of proposals) { const k = normName(p.customer_name); if (k && !(k in propByCustomer)) propByCustomer[k] = p; }

  // Current stock = the most recent count period.
  let stockRows = [];
  try {
    const period = (await query(`select count_period from inventory.cn_sku order by count_period desc limit 1`)).rows[0]?.count_period;
    if (period) {
      stockRows = (await query(
        `select id, product_name, sku, product_line, item_class, quantity
           from inventory.cn_sku where count_period = $1`, [period],
      )).rows;
    }
  } catch { stockRows = []; }

  const recFor = (pkg) => (Array.isArray(pkg) && pkg.length ? matchPackageList(pkg, stockRows) : []);

  // Inventory sign-off = the Team-Prep "Shipping preparation" task (ext.task
  // auto_key='shipping') — ONE source of truth shared with the Project Tracker, so
  // confirming here also lights up that step there. Read who/when marked it done.
  const shipByProject = {};
  try {
    const rows = (await query(
      `select project_id, status, done_by_name, done_by_email, done_at
         from ext.task where auto_key = 'shipping'`,
    )).rows;
    for (const r of rows) shipByProject[r.project_id] = r;
  } catch { /* ext.task not present yet */ }
  const confirmFor = (id) => {
    const t = shipByProject[String(id)] || null;
    return {
      inventory_confirmed: t?.status === 'done',
      confirmed_by_name: t?.done_by_name || t?.done_by_email || null,
      confirmed_at: t?.done_at || null,
    };
  };

  // Agreement-rooted project cards. Each carries its matched proposal id so cart
  // items allocated at the proposal stage stay visible once the agreement lands.
  const matchedProposalIds = new Set();
  const agreementProjects = projects.map((p) => {
    const proposal = propByCustomer[normName(p.counterparty)] || null;
    if (proposal) matchedProposalIds.add(proposal.id);
    return {
      ...p, proposal_id: proposal?.id || null, recommendations: recFor(proposal?.package_list),
      ...confirmFor(p.id), can_confirm: canConfirm,
    };
  });

  // Proposals with no agreement yet → standalone cards, so the inventory team can
  // prep from the package list before the agreement exists.
  const proposalProjects = proposals
    .filter((p) => !matchedProposalIds.has(p.id))
    .map((p) => ({
      id: p.id, project_number: p.contract_number || 'Proposal',
      title: p.project_name || p.customer_name || 'New proposal',
      counterparty: p.customer_name || null, agreement_type: null,
      robot_types: null, robot_count: null, created_at: p.created_at,
      is_proposal: true, proposal_id: p.id, recommendations: recFor(p.package_list),
      // Sign-off needs an agreement (the shipping prep task lives on the project).
      inventory_confirmed: false, confirmed_by_name: null, confirmed_at: null, can_confirm: false,
    }));

  return NextResponse.json({ canEdit, canConfirm, projects: [...proposalProjects, ...agreementProjects], carts, inventory });
}

// Remove one item from a project's cart (admins + inventory department).
export async function DELETE(req) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!(user.isAdmin || user.department === 'inventory')) {
    return NextResponse.json({ error: 'Only admins or the inventory team can edit the cart.' }, { status: 403 });
  }
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await mutateAs(user.email, (q) => q('delete from inventory.project_allocation where id = $1::bigint', [id]));
  return NextResponse.json({ ok: true });
}
