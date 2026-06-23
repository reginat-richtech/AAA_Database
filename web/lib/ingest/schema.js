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

    create table if not exists ext.hubspot_deal (
      id           text primary key,
      name         text,
      amount       numeric(16,2),
      stage_id     text,
      pipeline_id  text,
      owner_id     text,
      createdate   timestamptz,
      closedate    timestamptz,
      lastmodified timestamptz,
      is_closed    boolean,
      raw          jsonb not null,
      synced_at    timestamptz not null default now()
    );
    create index if not exists hubspot_deal_created_idx  on ext.hubspot_deal (createdate desc);
    create index if not exists hubspot_deal_modified_idx on ext.hubspot_deal (lastmodified desc);

    create table if not exists ext.hubspot_engagement (
      id        text primary key,
      type      text,
      owner_id  text,
      direction text,
      ts        timestamptz,
      raw       jsonb not null,
      synced_at timestamptz not null default now()
    );
    create index if not exists hubspot_engagement_ts_idx on ext.hubspot_engagement (ts desc);

    create table if not exists ext.hubspot_owner (
      id        text primary key,
      name      text,
      email     text,
      raw       jsonb not null,
      synced_at timestamptz not null default now()
    );

    create table if not exists ext.hubspot_pipeline (
      stage_id      text primary key,
      pipeline_id   text,
      label         text,
      display_order integer,
      raw           jsonb not null,
      synced_at     timestamptz not null default now()
    );

    create table if not exists ext.integration_credential (
      provider      text primary key,
      refresh_token text,
      realm_id      text,
      environment   text,
      company_name  text,
      updated_at    timestamptz not null default now()
    );

    create table if not exists ext.app_user (
      email      text primary key,
      role       text not null default 'user',   -- 'admin' | 'user' (system access)
      name       text,
      added_by   text,
      department text,                            -- sales|legal|marketing|finance|tech|inventory
      title      text not null default 'member',  -- 'member' | 'manager' (org level for tasks)
      last_seen  timestamptz,
      updated_at timestamptz not null default now()
    );
    alter table ext.app_user add column if not exists last_seen timestamptz;
    alter table ext.app_user add column if not exists department text;
    alter table ext.app_user add column if not exists title text not null default 'member';

    create table if not exists ext.social_post (
      id             text primary key,
      platform       text not null default 'x',
      author_email   text not null,
      author_name    text,
      content        text not null default '',
      image_url      text,
      scheduled_at   timestamptz,
      status         text not null default 'draft',   -- draft | submitted | approved | rejected | published
      reviewer_email text,
      reviewer_note  text,
      published_at   timestamptz,
      x_post_id      text,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    );
    create index if not exists social_post_author_idx on ext.social_post (author_email, created_at desc);
    create index if not exists social_post_status_idx on ext.social_post (status, scheduled_at);

    create table if not exists ext.social_media (
      id           text primary key,
      post_id      text not null,
      kind         text,                -- 'image' | 'video'
      content_type text,
      filename     text,
      bytes        bytea not null,
      size         integer,
      created_at   timestamptz not null default now()
    );
    create index if not exists social_media_post_idx on ext.social_media (post_id, created_at);

    create table if not exists ext.task (
      id             text primary key,
      project_id     text not null,                  -- ops.legal_agreement.id (as text)
      title          text not null,
      description    text,
      department     text not null,                  -- owning department
      assignee_email text,
      created_by     text,
      status         text not null default 'todo',   -- todo | in_progress | blocked | done
      priority       text not null default 'normal', -- low | normal | high
      auto_key       text,                            -- set for auto-seeded prep tasks: equipment|customer_comm|shipping
      due_date       date,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    );
    alter table ext.task add column if not exists auto_key text;
    create index if not exists task_dept_idx     on ext.task (department, status);
    create index if not exists task_project_idx  on ext.task (project_id);
    create index if not exists task_assignee_idx on ext.task (assignee_email);
    -- one auto-seeded task per (project, auto_key); manual tasks keep auto_key NULL (NULLs are distinct).
    create unique index if not exists task_auto_uidx on ext.task (project_id, auto_key);

    create table if not exists ext.task_project (
      project_id   text primary key,                -- ops.legal_agreement.id (as text)
      status       text not null default 'active',  -- 'active' | 'complete'
      completed_by text,
      completed_at timestamptz,
      seeded_at    timestamptz,                      -- when the 3 prep tasks were auto-created (once)
      updated_at   timestamptz not null default now()
    );
    alter table ext.task_project add column if not exists seeded_at timestamptz;

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
