import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/access';
import { hubspotBrief } from '../../../../lib/integrations/hubspot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  return NextResponse.json(await hubspotBrief());
}
