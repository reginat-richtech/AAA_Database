// HubSpot deal helpers for the Project Tracker's "connect a deal" feature.
// The deal PICKER searches the synced ext.hubspot_deal table (fast, no rate limit);
// connecting a deal additionally pulls its CUSTOMER (associated company + primary
// contact) live from the HubSpot API, since that isn't part of the synced deal.
const HS_BASE = 'https://api.hubapi.com';
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_TOKEN || '';

export function hubspotConfigured() { return !!TOKEN; }

async function hsGet(path) {
  try {
    const r = await fetch(HS_BASE + path, { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Pull a deal's customer = its associated company (name/domain/phone/address) +
// primary associated contact (name/email/phone/title). Best-effort: returns null
// on any failure so connecting a deal never hard-fails on the customer pull.
export async function fetchDealCustomer(dealId) {
  if (!TOKEN || !dealId) return null;
  let company = null, contact = null;

  const compAssoc = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/companies`);
  const companyId = compAssoc?.results?.[0]?.toObjectId || compAssoc?.results?.[0]?.id;
  if (companyId) {
    const c = await hsGet(`/crm/v3/objects/companies/${companyId}?properties=name,domain,phone,address,city,state,zip,country`);
    const p = c?.properties;
    if (p) company = {
      id: String(companyId), name: p.name || null, domain: p.domain || null, phone: p.phone || null,
      address: [p.address, p.city, p.state, p.zip, p.country].filter(Boolean).join(', ') || null,
    };
  }

  const conAssoc = await hsGet(`/crm/v3/objects/deals/${dealId}/associations/contacts`);
  const contactId = conAssoc?.results?.[0]?.toObjectId || conAssoc?.results?.[0]?.id;
  if (contactId) {
    const c = await hsGet(`/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname,phone,jobtitle`);
    const p = c?.properties;
    if (p) contact = {
      id: String(contactId), name: [p.firstname, p.lastname].filter(Boolean).join(' ') || null,
      email: p.email || null, phone: p.phone || null, jobtitle: p.jobtitle || null,
    };
  }

  if (!company && !contact) return null;
  return { company, contact, pulled_at: new Date().toISOString() };
}
