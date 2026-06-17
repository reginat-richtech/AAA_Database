import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Scaffold — Navan OAuth client + JotForm TRF cross-reference is the next build
// phase. Credentials are already present in .env.local (NAVAN_*).
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  return NextResponse.json({
    ok: false,
    pending: true,
    count: null,
    records: [],
    error: 'Travel AI (Navan) is being wired in the next phase — credentials are in place.',
  });
}
