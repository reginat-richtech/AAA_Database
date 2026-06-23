// Per-user access control. A user sees an agreement (and everything derived
// from it — its tech request, its project tree) when they are its salesman or
// they uploaded it. Admins (ADMIN_EMAILS) see everything. The rule lives here
// once and is enforced server-side in every data route.
import { NextResponse } from 'next/server';
import { auth } from '../auth';
import { query } from './db';
import { ensureExtSchema } from './ingest/schema';

// Bootstrap admins from env — these can never be locked out, even if the DB
// table is empty/unavailable. Additional admins are managed in ext.app_user
// via the Users page (/users) and take effect on the user's next request.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'regina.t@richtechsystem.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

// Admin if listed in env (bootstrap) OR ext.app_user(role='admin').
export async function isAdmin(email) {
  if (!email) return false;
  if (isAdminEmail(email)) return true;
  try {
    const { rows } = await query(
      `select 1 from ext.app_user where lower(email) = lower($1) and role = 'admin' limit 1`,
      [email],
    );
    return rows.length > 0;
  } catch {
    return false;   // table not created yet → env admins only
  }
}

// Resolve the signed-in user for a route. Returns null when unauthenticated.
// Includes the org fields (department + title) used by Task Tracking.
export async function currentUser() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return null;
  let department = null, title = 'member';
  try {
    const { rows } = await query('select department, title from ext.app_user where lower(email) = lower($1)', [email]);
    if (rows[0]) { department = rows[0].department || null; title = rows[0].title || 'member'; }
  } catch { /* table not created yet */ }
  return { email, name: session.user.name || email, isAdmin: await isAdmin(email), department, title };
}

// Record a signed-in user (refreshing last_seen) so admins can see everyone on
// the Users page. New users default to role 'user'; an existing role is kept.
export async function touchUser(email, name) {
  const e = String(email || '').toLowerCase();
  if (!e) return;
  try {
    await ensureExtSchema();
    await query(
      `insert into ext.app_user (email, role, name, last_seen, updated_at)
       values ($1, 'user', $2, now(), now())
       on conflict (email) do update set
         name = coalesce(excluded.name, ext.app_user.name), last_seen = now()`,
      [e, name || null],
    );
  } catch { /* never block page render */ }
}

// Guard for the top of an API route: returns { user } or { response } (401).
//   const { user, response } = await requireUser(); if (response) return response;
export async function requireUser() {
  const user = await currentUser();
  if (!user) return { response: NextResponse.json({ error: 'Not signed in.' }, { status: 401 }) };
  return { user };
}

// Guard for admin-only routes (the AI intelligence tabs show company-wide CRM /
// finance / travel data, so they are restricted to ADMIN_EMAILS).
export async function requireAdmin() {
  const user = await currentUser();
  if (!user) return { response: NextResponse.json({ error: 'Not signed in.' }, { status: 401 }) };
  if (!user.isAdmin) return { response: NextResponse.json({ error: 'Admins only.' }, { status: 403 }) };
  return { user };
}

// SQL predicate restricting ops.legal_agreement rows to those `user` may see.
// Admins → "true". Others → salesman_email or uploaded_by equals their email.
// `startIndex` is the $N placeholder for the email param; `alias` optionally
// prefixes the columns (e.g. "a" for `legal_agreement a`).
export function visibilitySql(user, startIndex, alias = '') {
  if (user.isAdmin) return { sql: 'true', params: [] };
  const p = alias ? `${alias}.` : '';
  return {
    sql: `(lower(${p}salesman_email) = $${startIndex} or lower(${p}uploaded_by) = $${startIndex})`,
    params: [user.email],
  };
}

// In-memory check for a single already-fetched agreement row. Row must include
// salesman_email and uploaded_by.
export function canSee(user, row) {
  if (!row) return false;
  if (user.isAdmin) return true;
  const e = user.email;
  return (row.salesman_email || '').toLowerCase() === e
      || (row.uploaded_by || '').toLowerCase() === e;
}
