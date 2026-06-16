import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Records a workflow stage event (idempotent on submission_id + stage). Point a
// JotForm webhook here with ?stage=<name> (e.g. ?stage=travel_requested). The
// Project Tracker reads these to advance the "Trip & Travel" stage.
export async function POST(request) {
  const url = new URL(request.url);
  let body = {};
  try { body = await request.json(); }
  catch {
    try { body = Object.fromEntries(await request.formData()); } catch { body = {}; }
  }
  const stage = url.searchParams.get('stage') || body.stage;
  if (!stage) return NextResponse.json({ error: 'stage is required (?stage=...)' }, { status: 400 });
  const submission_id = body.submissionID || body.submission_id || body.so_number || null;
  const form_id = body.formID || body.form_id || null;

  await query(
    `insert into ops.jotform_stage_event (form_id, submission_id, stage, payload)
     values ($1,$2,$3,$4)
     on conflict (submission_id, stage) do nothing`,
    [form_id, submission_id, stage, JSON.stringify(body)]
  );
  return NextResponse.json({ ok: true });
}
