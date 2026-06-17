// Sync orchestrator. Runs the requested source loaders, recording each run in
// ext.sync_log, and reports last-run status + stored row counts for the UI.
import { pool } from '../db';
import { ensureExtSchema } from './schema';
import { syncNavan } from './navan';
import { syncJotform } from './jotform';
import { syncQuickbooks } from './quickbooks';

const RUNNERS = { navan: syncNavan, jotform: syncJotform, quickbooks: syncQuickbooks };
export const ALL_SOURCES = ['navan', 'jotform', 'quickbooks'];

export async function runSync(sources) {
  await ensureExtSchema();
  const results = [];
  for (const src of sources) {
    const runner = RUNNERS[src];
    if (!runner) { results.push({ source: src, ok: false, error: 'unknown source' }); continue; }
    const { rows: logRows } = await pool.query('insert into ext.sync_log (source) values ($1) returning id', [src]);
    const logId = logRows[0].id;
    try {
      const r = await runner();
      await pool.query(
        'update ext.sync_log set finished_at=now(), rows=$2, ok=$3, error=$4 where id=$1',
        [logId, r.rows || 0, r.ok !== false, r.skipped || null],
      );
      results.push(r);
    } catch (e) {
      const msg = String(e?.message || e);
      await pool.query('update ext.sync_log set finished_at=now(), ok=false, error=$2 where id=$1', [logId, msg]);
      results.push({ source: src, ok: false, rows: 0, error: msg });
    }
  }
  return results;
}

export async function lastSyncStatus() {
  await ensureExtSchema();
  const last = (await pool.query(`
    select distinct on (source) source, started_at, finished_at, rows, ok, error
    from ext.sync_log order by source, started_at desc
  `)).rows;
  const counts = (await pool.query(`
    select 'navan' as source, count(*)::int n from ext.navan_booking
    union all select 'jotform', count(*)::int from ext.jotform_submission
    union all select 'quickbooks', count(*)::int from ext.quickbooks_invoice
  `)).rows;
  return { last, totals: Object.fromEntries(counts.map((r) => [r.source, r.n])) };
}
