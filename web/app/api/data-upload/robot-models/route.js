import { NextResponse } from 'next/server';
import { ROBOT_MODELS, SERVICE_TYPES, AGREEMENT_TYPES } from '../../../../lib/extract';

export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({
    models: ROBOT_MODELS,
    service_types: SERVICE_TYPES,
    agreement_types: AGREEMENT_TYPES,
  });
}
