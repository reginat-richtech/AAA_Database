import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/access';
import { publishToLinkedin, deleteLinkedinPost, linkedinConfigured } from '../../../../lib/integrations/linkedin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Safe LinkedIn test harness (admin-only) — never posts to your followers.
//   POST { mode: 'dry' | 'draft', content? }
//     - 'dry'   : simulate only, no LinkedIn call. Works without API approval.
//     - 'draft' : real API call, but creates an unpublished DRAFT (invisible to followers).
//   DELETE ?urn=<id>  : remove a draft created above.
export async function POST(req) {
  const { response } = await requireAdmin();
  if (response) return response;

  const b = await req.json().catch(() => ({}));
  const content = String(b.content || 'AAA Social test — please ignore.').slice(0, 3000);
  const mode = b.mode === 'draft' ? 'draft' : 'dry';

  if (mode === 'dry') {
    const r = await publishToLinkedin({ content, id: 'test' }, { dryRun: true });
    return NextResponse.json({ mode, ...r });
  }

  // draft mode — needs the app configured + connected + Community Management API approved.
  if (!linkedinConfigured()) {
    return NextResponse.json({ error: 'LinkedIn app not configured (set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET).' }, { status: 400 });
  }
  const r = await publishToLinkedin({ content, id: 'test' }, { draft: true });
  return NextResponse.json({
    mode,
    ...r,
    note: r.ok
      ? 'Created as DRAFT — invisible to followers. Remove via DELETE /api/linkedin/test?urn=<id>, or in your Page admin → Drafts.'
      : undefined,
  }, { status: r.ok ? 200 : 400 });
}

export async function DELETE(req) {
  const { response } = await requireAdmin();
  if (response) return response;
  const urn = new URL(req.url).searchParams.get('urn');
  if (!urn) return NextResponse.json({ error: 'urn is required' }, { status: 400 });
  const r = await deleteLinkedinPost(urn);
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
