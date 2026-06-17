// HubSpot CRM — native client + deal-intelligence alerts (no old-app dependency).
// The badge counts *actionable* deals: recently overdue (within OVERDUE_WINDOW_DAYS)
// + closing within APPROACHING_DAYS. The full overdue backlog is reported as
// context (brief.totalOverdue) but kept out of the badge so it stays meaningful —
// a pipeline can carry hundreds of long-dead deals with past close dates.
const HS_BASE = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_TOKEN || '';
const DAY = 86400000;
const OVERDUE_WINDOW_DAYS = 30;
const APPROACHING_DAYS = 7;

const NOT_CLOSED = { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' };
const PROPS = ['dealname', 'amount', 'dealstage', 'closedate', 'hs_lastmodifieddate'];

// Midnight (local) +/- offset, as epoch-ms string for HubSpot date filters.
function dayStartMs(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return String(d.getTime());
}

async function hsSearch(filters, { limit = 1 } = {}) {
  const body = { filterGroups: [{ filters }], properties: PROPS, limit, sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }] };
  const res = await fetch(HS_BASE + '/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const d = await res.json();
  return { results: d.results || [], total: d.total || 0 };
}

function toCard(deal, sev, kind, detail) {
  const p = deal.properties || {};
  return {
    sev, kind,
    title: kind === 'overdue' ? 'Overdue' : 'Closing soon',
    deal: p.dealname || `Deal #${deal.id}`,
    amount: p.amount ? Number(p.amount) : null,
    stage: p.dealstage || '',
    detail, dealId: deal.id,
  };
}

export async function hubspotBrief() {
  if (!TOKEN) return { ok: false, count: 0, alerts: [], brief: null, error: 'HubSpot token not configured' };
  try {
    const todayMs = dayStartMs(0);
    const overdueFromMs = dayStartMs(-OVERDUE_WINDOW_DAYS);
    const approachToMs = dayStartMs(APPROACHING_DAYS);

    const [recentOverdue, closingSoon, totalOverdue, openTotal] = await Promise.all([
      hsSearch([NOT_CLOSED, { propertyName: 'closedate', operator: 'GTE', value: overdueFromMs }, { propertyName: 'closedate', operator: 'LT', value: todayMs }], { limit: 50 }),
      hsSearch([NOT_CLOSED, { propertyName: 'closedate', operator: 'GTE', value: todayMs }, { propertyName: 'closedate', operator: 'LT', value: approachToMs }], { limit: 50 }),
      hsSearch([NOT_CLOSED, { propertyName: 'closedate', operator: 'LT', value: todayMs }], { limit: 1 }),
      hsSearch([NOT_CLOSED], { limit: 1 }),
    ]);

    const alerts = [];
    for (const d of recentOverdue.results) {
      const over = Math.round((Date.now() - new Date(d.properties.closedate).getTime()) / DAY);
      alerts.push(toCard(d, 'fail', 'overdue', `Past close date by ${over}d`));
    }
    for (const d of closingSoon.results) {
      const left = Math.round((new Date(d.properties.closedate).getTime() - Date.now()) / DAY);
      alerts.push(toCard(d, left <= 3 ? 'warn' : 'info', 'approaching', `Closes in ${left}d`));
    }
    const rank = { fail: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => rank[a.sev] - rank[b.sev] || (b.amount || 0) - (a.amount || 0));

    return {
      ok: true,
      count: recentOverdue.total + closingSoon.total,
      alerts,
      brief: {
        openDeals: openTotal.total,
        recentlyOverdue: recentOverdue.total,
        closingSoon: closingSoon.total,
        totalOverdue: totalOverdue.total,
        overdueWindowDays: OVERDUE_WINDOW_DAYS,
      },
      error: null,
    };
  } catch (e) {
    return { ok: false, count: 0, alerts: [], brief: null, error: String(e?.message || e) };
  }
}

export async function hubspotCount() {
  const r = await hubspotBrief();
  return r.ok ? r.count : null;
}
