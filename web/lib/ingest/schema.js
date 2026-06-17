// External-dataset store ("ext" schema). Each source gets one table holding the
// COMPLETE API record as `raw jsonb` plus a few indexed key columns for easy SQL.
// Tables are created on demand (idempotent) so the same code self-migrates both
// the local Docker DB and the cloud Postgres — no separate migration step needed.
import { pool } from '../db';

let _ensured = false;

export async function ensureExtSchema() {
  if (_ensured) return;
  await pool.query(`
    create schema if not exists ext;

    create table if not exists ext.navan_booking (
      uuid           text primary key,
      booking_type   text,
      status         text,
      traveler       text,
      traveler_email text,
      start_date     date,
      end_date       date,
      vendor         text,
      usd_total      numeric(14,2),
      currency       text,
      created_at     timestamptz,
      raw            jsonb not null,
      synced_at      timestamptz not null default now()
    );
    create index if not exists navan_booking_created_idx  on ext.navan_booking (created_at desc);
    create index if not exists navan_booking_traveler_idx on ext.navan_booking (traveler);

    create table if not exists ext.jotform_submission (
      id          text primary key,
      form_id     text,
      form_title  text,
      status      text,
      created_at  timestamptz,
      updated_at  timestamptz,
      raw         jsonb not null,
      synced_at   timestamptz not null default now()
    );
    create index if not exists jotform_submission_form_idx    on ext.jotform_submission (form_id);
    create index if not exists jotform_submission_created_idx on ext.jotform_submission (created_at desc);

    create table if not exists ext.quickbooks_invoice (
      id           text primary key,
      doc_number   text,
      customer     text,
      txn_date     date,
      due_date     date,
      total_amount numeric(14,2),
      balance      numeric(14,2),
      currency     text,
      status       text,
      raw          jsonb not null,
      synced_at    timestamptz not null default now()
    );
    create index if not exists qb_invoice_txn_idx on ext.quickbooks_invoice (txn_date desc);

    create table if not exists ext.sync_log (
      id          bigserial primary key,
      source      text not null,
      started_at  timestamptz not null default now(),
      finished_at timestamptz,
      rows        integer,
      ok          boolean,
      error       text
    );
    create index if not exists sync_log_source_idx on ext.sync_log (source, started_at desc);
  `);
  _ensured = true;
}

// Batched UPSERT. `rows` = array of value-arrays in `columns` order. Columns in
// `jsonCols` are cast to ::jsonb. On conflict, every non-key column is refreshed
// and synced_at bumped. Returns the number of rows written.
export async function upsertBatch(table, columns, conflictCol, rows, { jsonCols = [] } = {}) {
  if (!rows.length) return 0;
  const CHUNK = 100;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v, ci) => {
        params.push(v);
        return `$${params.length}${jsonCols.includes(columns[ci]) ? '::jsonb' : ''}`;
      });
      return `(${ph.join(',')})`;
    });
    const updates = columns.filter((c) => c !== conflictCol).map((c) => `${c}=excluded.${c}`).join(',');
    await pool.query(
      `insert into ${table} (${columns.join(',')}) values ${tuples.join(',')}
       on conflict (${conflictCol}) do update set ${updates}, synced_at = now()`,
      params,
    );
    total += chunk.length;
  }
  return total;
}

export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
export const day = (s) => (s ? String(s).slice(0, 10) : null);
