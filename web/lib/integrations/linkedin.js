// LinkedIn (Company Page) integration — OAuth + Posts + Comments, modeled on the
// QuickBooks flow (qbAuth.js). The connect routes (app/api/linkedin/*) drive the
// browser consent; tokens persist in ext.integration_credential (provider
// 'linkedin'). Posting to an organization needs the Community Management API
// product (scope w_organization_social); reading comments needs r_organization_social.
import { query, pool } from '../db';
import { ensureExtSchema } from '../ingest/schema';

const CID = process.env.LINKEDIN_CLIENT_ID || '';
const CSEC = process.env.LINKEDIN_CLIENT_SECRET || '';
const ORG_ID_ENV = process.env.LINKEDIN_ORG_ID || '';               // optional: skip auto-discovery
const API_VERSION = process.env.LINKEDIN_API_VERSION || '202405';   // LinkedIn-Version header (YYYYMM)
const SCOPES = process.env.LINKEDIN_SCOPES || 'w_organization_social r_organization_social rw_organization_admin';
const DRY_RUN = process.env.LINKEDIN_DRY_RUN === '1';                // simulate publishing — never calls LinkedIn
const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const REST = 'https://api.linkedin.com/rest';

export function linkedinConfigured() { return !!(CID && CSEC); }

// Deterministic OAuth redirect URI (behind the Container Apps proxy, prefer the
// canonical public URL; fall back to the request origin for local dev).
export function linkedinRedirectUri(reqUrl) {
  const base = (process.env.LINKEDIN_REDIRECT_BASE || process.env.AUTH_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/api/linkedin/callback`;
  try { return `${new URL(reqUrl).origin}/api/linkedin/callback`; } catch { return '/api/linkedin/callback'; }
}

export function buildAuthorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({ response_type: 'code', client_id: CID, redirect_uri: redirectUri, state, scope: SCOPES });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

async function tokenRequest(body) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: CID, client_secret: CSEC }),
  });
  if (!r.ok) throw new Error(`LinkedIn token ${r.status}: ${(await r.text()).slice(0, 180)}`);
  return r.json(); // { access_token, expires_in, refresh_token, refresh_token_expires_in, scope }
}
export const exchangeCode = (code, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
export const refreshAccessToken = (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

// Schema: LinkedIn posts live in the shared ext.social_post table (the Social
// Media tool); here we only need to extend the credential row with the rotating
// access token + its expiry. Kept in ext.* (the app role can create there).
export async function ensureLinkedinSchema() {
  await ensureExtSchema();
  await pool.query(`alter table ext.integration_credential add column if not exists access_token text`);
  await pool.query(`alter table ext.integration_credential add column if not exists expires_at timestamptz`);
}

// ── Credential store ──────────────────────────────────────────────────────────
export async function getLinkedinCredential() {
  try {
    const { rows } = await query(
      `select refresh_token, access_token, expires_at, realm_id, company_name
       from ext.integration_credential where provider = 'linkedin'`
    );
    if (rows[0] && (rows[0].access_token || rows[0].refresh_token)) return rows[0];
  } catch { /* table/columns not created yet */ }
  return null;
}

export async function saveLinkedinCredential({ access_token, refresh_token, expires_in, org_id, company_name }) {
  await ensureLinkedinSchema();
  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
  await pool.query(
    `insert into ext.integration_credential
       (provider, refresh_token, access_token, expires_at, realm_id, environment, company_name, updated_at)
     values ('linkedin', $1, $2, $3, $4, 'production', $5, now())
     on conflict (provider) do update set
       refresh_token = coalesce(excluded.refresh_token, ext.integration_credential.refresh_token),
       access_token  = excluded.access_token,
       expires_at    = excluded.expires_at,
       realm_id      = coalesce(excluded.realm_id, ext.integration_credential.realm_id),
       company_name  = coalesce(excluded.company_name, ext.integration_credential.company_name),
       updated_at    = now()`,
    [refresh_token || null, access_token, expiresAt, org_id || null, company_name || null]
  );
}

// Returns a usable access token, refreshing if it's within 5 min of expiry.
export async function getValidAccessToken() {
  const cred = await getLinkedinCredential();
  if (!cred) return null;
  const exp = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (cred.access_token && exp - Date.now() > 5 * 60 * 1000) return cred.access_token;
  if (cred.refresh_token) {
    const tok = await refreshAccessToken(cred.refresh_token);
    await saveLinkedinCredential({
      access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in,
      org_id: cred.realm_id, company_name: cred.company_name,
    });
    return tok.access_token;
  }
  return cred.access_token || null;
}

// ── REST helper (versioned headers required by the Posts/Comments APIs) ─────────
async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${REST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { ok: r.ok, status: r.status, json, headers: r.headers };
}

// Find the Company Page the connected member administers (first APPROVED admin ACL).
export async function discoverOrganization(token) {
  const r = await api('/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED', { token });
  if (!r.ok) return null;
  const el = (r.json.elements || [])[0];
  if (!el) return null;
  const orgUrn = el.organizationalTarget || el.organization || '';
  const id = String(orgUrn).split(':').pop();
  if (!id) return null;
  let name = '';
  try {
    const o = await api(`/organizations/${id}`, { token });
    if (o.ok) name = o.json.localizedName || o.json.name?.localized?.en_US || '';
  } catch { /* name is best-effort */ }
  return { id, urn: `urn:li:organization:${id}`, name };
}

export function orgUrn(cred) {
  const id = cred?.realm_id || ORG_ID_ENV;
  return id ? `urn:li:organization:${id}` : null;
}

// Publish a text post to the organization. Returns the created share URN.
// draft:true creates it in DRAFT state — it lives in the Page admin's Drafts and
// is NOT distributed to followers (used for safe testing; delete with deleteLinkedinPost).
export async function publishPost({ token, authorUrn, commentary, visibility = 'PUBLIC', draft = false }) {
  const body = {
    author: authorUrn,
    commentary,
    visibility,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: draft ? 'DRAFT' : 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  const r = await api('/posts', { method: 'POST', token, body });
  const postUrn = r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || r.json?.id || '';
  return { ok: r.ok, status: r.status, postUrn, error: r.ok ? null : JSON.stringify(r.json).slice(0, 400) };
}

// Delete a post/draft by URN (cleanup after a draft test). Returns { ok }.
export async function deleteLinkedinPost(urn) {
  let token;
  try { token = await getValidAccessToken(); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  if (!token) return { ok: false, error: 'LinkedIn not connected' };
  const r = await api(`/posts/${encodeURIComponent(urn)}`, { method: 'DELETE', token });
  return { ok: r.ok, status: r.status, error: r.ok ? null : JSON.stringify(r.json).slice(0, 400) };
}

// Read comments on a published post (share/ugcPost URN).
export async function listComments({ token, postUrn }) {
  const r = await api(`/socialActions/${encodeURIComponent(postUrn)}/comments`, { token });
  if (!r.ok) return { ok: false, status: r.status, comments: [], error: JSON.stringify(r.json).slice(0, 400) };
  const comments = (r.json.elements || []).map((c) => ({
    urn: c['$URN'] || c.id || '',
    message: c.message?.text || '',
    author: c.actor || '',
    created: c.created?.time || null,
    raw: c,
  }));
  return { ok: true, comments };
}

// Publish a Social Media post to the connected Company Page. Matches the
// publishToX / publishToFacebook signature used by the /social action route:
// returns { ok, id } (id = the created share URN, stored in social_post.x_post_id)
// or { ok:false, skipped|error } so the workflow records the failure cleanly.
export async function publishToLinkedin(post, { draft = false, dryRun = DRY_RUN } = {}) {
  if (!String(post.content || '').trim()) return { ok: false, error: 'LinkedIn post needs text' };
  // Dry-run: validate then simulate — never touches LinkedIn (safe before API approval).
  if (dryRun) return { ok: true, id: `urn:li:share:DRYRUN-${post.id || 'test'}`, dryRun: true };
  const cred = await getLinkedinCredential();
  if (!cred) return { ok: false, skipped: 'LinkedIn not connected' };
  const author = orgUrn(cred);
  if (!author) return { ok: false, skipped: 'No LinkedIn organization (reconnect, or set LINKEDIN_ORG_ID)' };
  let token;
  try { token = await getValidAccessToken(); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  if (!token) return { ok: false, skipped: 'No LinkedIn access token' };
  const r = await publishPost({ token, authorUrn: author, commentary: post.content, visibility: 'PUBLIC', draft });
  if (r.ok) return { ok: true, id: r.postUrn, draft: draft || undefined };
  return { ok: false, error: r.error || `HTTP ${r.status}` };
}

export async function linkedinStatus() {
  const cred = await getLinkedinCredential();
  return {
    configured: linkedinConfigured(),
    connected: !!cred,
    org: cred?.realm_id || ORG_ID_ENV || null,
    company: cred?.company_name || null,
    expires_at: cred?.expires_at || null,
  };
}
