import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/access';
import { travelReview } from '../../../../lib/integrations/navan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { response } = await requireAdmin();
  if (response) return response;
  const days = new URL(request.url).searchParams.get('days') === '30' ? 30 : 7;
  return NextResponse.json(await travelReview(days));
}
