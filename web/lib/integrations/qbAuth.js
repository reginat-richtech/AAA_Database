// QuickBooks OAuth + credential store — ported from the old app's
// /quickbooks/oauth/{authorize,callback} flow (admin.py). The connect routes
// (app/api/quickbooks/*) drive the browser consent; the sync job reads the
// stored credential. Refresh tokens persist in ext.integration_credential so
// Intuit's token rotation survives across runs.
import { query, pool } from '../db';
import { ensureExtSchema } from '../ingest/schema';

const CID = process.env.QUICKBOOKS_CLIENT_ID || '';
const CSEC = process.env.QUICKBOOKS_CLIENT_SECRET || '';
const ENVIRONMENT = process.env.QUICKBOOKS_ENVIRONMENT || 'production';
const SCOPES = 'com.intuit.quickbooks.accounting';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';

export function qbConfigured() { return !!(CID && CSEC); }
export function qbEnvironment() { return ENVIRONMENT; }
export function qbApiBase(env = ENVIRONMENT) {
  return env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
}

// Deterministic OAuth redirect URI. Behind the Container Apps proxy, req.url can
// resolve to http:// or an internal host, so prefer the canonical public URL
// (AUTH_URL) and only fall back to the request origin for local dev.
export function qbRedirectUri(reqUrl) {
  const base = (process.env.QUICKBOOKS_REDIRECT_BASE || process.env.AUTH_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/api/quickbooks/callback`;
  try { return `${new URL(reqUrl).origin}/api/quickbooks/callback`; } catch { return '/api/quickbooks/callback'; }
}

export function buildAuthorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({ client_id: CID, scope: SCOPES, redirect_uri: redirectUri, response_type: 'code', state });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

async function tokenRequest(body) {
  const basic = Buffer.from(`${CID}:${CSEC}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`QuickBooks token ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
export const exchangeCode = (code, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const refreshAccessToken = (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

// Stored credential first, then a one-shot env fallback (QUICKBOOKS_REFRESH_TOKEN/REALM_ID).
export async function getQbCredential() {
  try {
    const { rows } = await query(
      `select refresh_token, realm_id, environment, company_name from ext.integration_credential where provider = 'quickbooks'`
    );
    if (rows[0] && rows[0].refresh_token) return rows[0];
  } catch { /* table not created yet */ }
  const rt = process.env.QUICKBOOKS_REFRESH_TOKEN || '';
  const realm = process.env.QUICKBOOKS_REALM_ID || '';
  if (rt && realm) return { refresh_token: rt, realm_id: realm, environment: ENVIRONMENT, company_name: null };
  return null;
}

export async function saveQbCredential({ refresh_token, realm_id, environment, company_name }) {
  await ensureExtSchema();
  await pool.query(
    `insert into ext.integration_credential (provider, refresh_token, realm_id, environment, company_name, updated_at)
     values ('quickbooks', $1, $2, $3, $4, now())
     on conflict (provider) do update set
       refresh_token = excluded.refresh_token, realm_id = excluded.realm_id,
       environment = excluded.environment, company_name = excluded.company_name, updated_at = now()`,
    [refresh_token, realm_id, environment || ENVIRONMENT, company_name || null]
  );
}

export async function qbStatus() {
  const cred = await getQbCredential();
  return { configured: qbConfigured(), connected: !!cred, realm: cred?.realm_id || null, company: cred?.company_name || null };
}

// Make an authenticated QuickBooks API call. Refreshes the access token (and
// persists Intuit's rotated refresh token), then calls /v3/company/<realm><path>.
// Returns { data } on success or { error } — never throws.
export async function qbApiRequest(path, { method = 'GET', body } = {}) {
  const cred = await getQbCredential();
  if (!cred) return { error: 'QuickBooks is not connected — an admin must Connect QuickBooks first.' };
  let tok;
  try { tok = await refreshAccessToken(cred.refresh_token); }
  catch (e) { return { error: `QuickBooks auth failed: ${String(e?.message || e)}` }; }
  // QB rotates the refresh token on each refresh — persist it so the next call works.
  if (tok.refresh_token && tok.refresh_token !== cred.refresh_token) {
    try { await saveQbCredential({ ...cred, refresh_token: tok.refresh_token }); } catch { /* best effort */ }
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${qbApiBase(cred.environment)}/v3/company/${cred.realm_id}${path}${sep}minorversion=70`;
  let res, json;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    json = await res.json().catch(() => ({}));
  } catch (e) { return { error: `QuickBooks request failed: ${String(e?.message || e)}` }; }
  if (!res.ok) {
    const f = json?.Fault?.Error?.[0];
    return { error: f?.Message || f?.Detail || `QuickBooks API ${res.status}`, status: res.status };
  }
  return { data: json };
}

// Enabled legacy sales-form custom fields (settable on a txn via the CustomField
// array). Returns [{id:'1'|'2'|'3', name}]. Lets us push app fields (PO #, Project
// Manager) into whatever custom fields the company actually has, matched by name.
export async function qbFetchSalesCustomFields() {
  const r = await qbApiRequest('/preferences');
  if (r.error) return { error: r.error, fields: [] };
  const groups = r.data?.Preferences?.SalesFormsPrefs?.CustomField || [];
  const flat = {};
  for (const g of groups) for (const f of (g.CustomField || [])) flat[f.Name] = f;
  const fields = [];
  for (const n of [1, 2, 3]) {
    const enabled = flat[`SalesFormsPrefs.UseSalesCustom${n}`]?.BooleanValue === true;
    const name = flat[`SalesFormsPrefs.SalesCustomName${n}`]?.StringValue || '';
    if (enabled && name) fields.push({ id: String(n), name });
  }
  return { fields };
}

// The QuickBooks Class list: { classes: [{id, name}] } (FullyQualifiedName preserves
// the "Parent:Child" hierarchy). (Note: QB "Tags" have NO Accounting-API entity.)
export async function qbFetchClasses() {
  const r = await qbApiRequest(`/query?query=${encodeURIComponent('select Id, Name, FullyQualifiedName, Active from Class where Active = true maxresults 500')}`);
  if (r.error) return { error: r.error, classes: [] };
  const classes = (r.data?.QueryResponse?.Class || [])
    .map((c) => ({ id: String(c.Id), name: c.FullyQualifiedName || c.Name }))
    .filter((c) => c.name);
  return { classes };
}

// The QuickBooks employee list: { employees: [{id, name}] }.
export async function qbFetchEmployees() {
  const r = await qbApiRequest(`/query?query=${encodeURIComponent('select Id, DisplayName, GivenName, FamilyName from Employee where Active = true maxresults 1000')}`);
  if (r.error) return { error: r.error, employees: [] };
  const employees = (r.data?.QueryResponse?.Employee || [])
    .map((e) => ({ id: String(e.Id), name: e.DisplayName || [e.GivenName, e.FamilyName].filter(Boolean).join(' ') }))
    .filter((e) => e.name);
  return { employees };
}

// The Project-Manager list from a QuickBooks dropdown custom field.
// QB's custom-field API is newer/limited, so this reads CustomFieldDefinition and
// extracts the option values across a few possible shapes — best-effort.
// Returns { managers: [names], field_id, field_name }.
export async function qbFetchProjectManagers() {
  const r = await qbApiRequest(`/query?query=${encodeURIComponent('select * from CustomFieldDefinition')}`);
  if (r.error) return { error: r.error, managers: [], field_id: null, field_name: null };
  const defs = r.data?.QueryResponse?.CustomFieldDefinition || r.data?.QueryResponse?.CustomFieldDefinitions || [];
  const label = (d) => String(d.Label || d.Name || d.StringValue || '');
  const def = defs.find((d) => /manager|^pm$|project\s*mgr/i.test(label(d))) || null;
  if (!def) return { managers: [], field_id: null, field_name: defs.length ? null : null };
  // Options can live under various keys depending on QB's payload.
  const raw = def.AllowedValues?.Value ?? def.AllowedValues ?? def.DropDownOptions ?? def.Options ?? def.PickListItems ?? [];
  const managers = (Array.isArray(raw) ? raw : [])
    .map((o) => (typeof o === 'string' ? o : (o.Value || o.value || o.Name || o.Label || o.StringValue || '')))
    .filter(Boolean);
  return { managers, field_id: def.Id || null, field_name: label(def) || null };
}

// The QuickBooks customer list: { customers: [{id, name, email, phone, address}] }.
const qbAddr = (a) => (a ? [a.Line1, a.Line2, [a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(' '), a.Country].filter(Boolean).join('\n') : '');
export async function qbFetchCustomers() {
  // NOTE: QB's query language rejects BillAddr (and other sub-entities) in an explicit
  // column list ("Property BillAddr not found"). Must use `select *` to get the address.
  const r = await qbApiRequest(`/query?query=${encodeURIComponent('select * from Customer where Active = true maxresults 1000')}`);
  if (r.error) return { error: r.error, customers: [] };
  const customers = (r.data?.QueryResponse?.Customer || []).map((c) => ({
    id: String(c.Id), name: c.DisplayName,
    email: c.PrimaryEmailAddr?.Address || '', phone: c.PrimaryPhone?.FreeFormNumber || '',
    address: qbAddr(c.BillAddr),
  }));
  return { customers };
}

// Server-side customer search (for large customer lists — 2000+). Matches
// DisplayName by substring; returns up to 30. { customers: [{id,name,email,phone,address}] }.
export async function qbSearchCustomers(qstr) {
  const safe = String(qstr || '').replace(/['\\%_]/g, ' ').trim();
  if (!safe) return { customers: [] };
  // `select *` (not an explicit column list) — QB rejects BillAddr as a named property.
  const r = await qbApiRequest(`/query?query=${encodeURIComponent(`select * from Customer where DisplayName like '%${safe}%' maxresults 30`)}`);
  if (r.error) return { error: r.error, customers: [] };
  const customers = (r.data?.QueryResponse?.Customer || []).map((c) => ({
    id: String(c.Id), name: c.DisplayName,
    email: c.PrimaryEmailAddr?.Address || '', phone: c.PrimaryPhone?.FreeFormNumber || '', address: qbAddr(c.BillAddr),
  }));
  return { customers };
}

// The QuickBooks item/price list: { items: [{id, name, sku, unit_price, type}] }.
// Used to price invoice lines and to reference the real QB item on push.
export async function qbFetchItems() {
  const r = await qbApiRequest(`/query?query=${encodeURIComponent('select Id, Name, Sku, UnitPrice, Type from Item where Active = true maxresults 1000')}`);
  if (r.error) return { error: r.error, items: [] };
  const items = (r.data?.QueryResponse?.Item || []).map((it) => ({
    id: String(it.Id), name: it.Name, sku: it.Sku || null,
    unit_price: it.UnitPrice != null ? Number(it.UnitPrice) : null, type: it.Type || null,
  }));
  return { items };
}
