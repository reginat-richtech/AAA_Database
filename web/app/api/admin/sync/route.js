import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/access';
import { runSync, lastSyncStatus, ALL_SOURCES } from '../../../../lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // allow long backfills where the platform honors it

function parseSources(req) {
  const raw = new URL(req.url).searchParams.get('source') || 'navan,jotform';
  if (raw === 'all') return ALL_SOURCES;
  return raw.split(',').map((s) => s.trim()).filter((s) => ALL_SOURCES.includes(s));
}

// Two ways in: a machine/cron caller with the shared secret, or a signed-in admin.
async function authorize(req) {
  const secret = process.env.SYNC_CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  if (secret && auth === `Bearer ${secret}`) return { ok: true };
  // A machine caller sent a Bearer token but it didn't match — say so clearly.
  if (auth.startsWith('Bearer ')) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid sync secret' }, { status: 401 }) };
  }
  const { response } = await requireAdmin();
  if (response) return { ok: false, response };
  return { ok: true };
}

export async function POST(req) {
  const a = await authorize(req);
  if (!a.ok) return a.response;
  const sources = parseSources(req);
  if (!sources.length) return NextResponse.json({ error: 'No valid source. Use ?source=navan,jotform,quickbooks or all.' }, { status: 400 });
  const results = await runSync(sources);
  return NextResponse.json({ ran: sources, results });
}

// Status for the Data Sync page (admin only).
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  return NextResponse.json(await lastSyncStatus());
}
