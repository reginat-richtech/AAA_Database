import { NextResponse } from 'next/server';
import { requireAdmin, isAdminEmail } from '../../../../lib/access';
import { query } from '../../../../lib/db';
import { ensureExtSchema } from '../../../../lib/ingest/schema';
import { normalizeDepartment, normalizeTitle } from '../../../../lib/orgRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['admin', 'user'];
const normEmail = (e) => String(e || '').trim().toLowerCase();
const envAdmins = () => (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// List managed users (ext.app_user) + the built-in env admins (read-only).
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  await ensureExtSchema();
  const { rows } = await query('select email, role, name, department, title, last_seen from ext.app_user');
  const env = new Set(envAdmins());
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    seen.add(r.email.toLowerCase());
    const builtin = env.has(r.email.toLowerCase());   // env admins always show as built-in admin
    out.push({ email: r.email, role: builtin ? 'admin' : r.role, name: r.name, department: r.department || '', title: r.title || 'member', last_seen: r.last_seen, source: builtin ? 'builtin' : 'managed' });
  }
  for (const e of envAdmins()) if (!seen.has(e)) out.push({ email: e, role: 'admin', name: null, department: '', title: 'member', last_seen: null, source: 'builtin' });
  out.sort((a, b) => (b.last_seen ? Date.parse(b.last_seen) : 0) - (a.last_seen ? Date.parse(a.last_seen) : 0) || a.email.localeCompare(b.email));
  return NextResponse.json({ users: out });
}

// Add or update a user's role.
export async function POST(req) {
  const { user, response } = await requireAdmin();
  if (response) return response;
  await ensureExtSchema();
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const role = ROLES.includes(body.role) ? body.role : 'user';
  const department = body.department ? normalizeDepartment(body.department) : null;
  const title = normalizeTitle(body.title);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }
  if (isAdminEmail(email) && role !== 'admin') {
    return NextResponse.json({ error: 'This is a built-in admin (set in deploy config) and can’t be changed here.' }, { status: 400 });
  }
  await query(
    `insert into ext.app_user (email, role, name, department, title, added_by, updated_at) values ($1, $2, $3, $4, $5, $6, now())
     on conflict (email) do update set role = excluded.role,
       name = coalesce(excluded.name, ext.app_user.name),
       department = excluded.department, title = excluded.title, updated_at = now()`,
    [email, role, body.name || null, department, title, user.email],
  );
  return NextResponse.json({ ok: true, email, role, department, title });
}

// Remove a managed user (they revert to a regular user). Built-in env admins can't be removed here.
export async function DELETE(req) {
  const { response } = await requireAdmin();
  if (response) return response;
  await ensureExtSchema();
  const email = normEmail(new URL(req.url).searchParams.get('email'));
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });
  if (isAdminEmail(email)) return NextResponse.json({ error: 'Built-in admin can’t be removed here.' }, { status: 400 });
  await query('delete from ext.app_user where lower(email) = lower($1)', [email]);
  return NextResponse.json({ ok: true, removed: email });
}
