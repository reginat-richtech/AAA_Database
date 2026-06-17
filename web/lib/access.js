// Per-user access control. A user sees an agreement (and everything derived
// from it — its tech request, its project tree) when they are its salesman or
// they uploaded it. Admins (ADMIN_EMAILS) see everything. The rule lives here
// once and is enforced server-side in every data route.
import { NextResponse } from 'next/server';
import { auth } from '../auth';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'regina.t@richtechsystem.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

// Resolve the signed-in user for a route. Returns null when unauthenticated.
export async function currentUser() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return null;
  return { email, name: session.user.name || email, isAdmin: isAdminEmail(email) };
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
