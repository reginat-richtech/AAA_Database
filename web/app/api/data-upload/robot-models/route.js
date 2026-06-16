import { NextResponse } from 'next/server';
import { ROBOT_MODELS, SERVICE_TYPES, AGREEMENT_TYPES } from '../../../../lib/extract';
import { requireUser } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { response } = await requireUser();
  if (response) return response;
  return NextResponse.json({
    models: ROBOT_MODELS,
    service_types: SERVICE_TYPES,
    agreement_types: AGREEMENT_TYPES,
  });
}
