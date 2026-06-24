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
    -- Stable per-user UUID: this is the actor identity recorded in audit.activity_log
    -- (actor_app_user_id). Email stays the PK; id is the durable, opaque handle.
    alter table ext.app_user add column if not exists id uuid not null default gen_random_uuid();
    create unique index if not exists app_user_id_uidx on ext.app_user (id);

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
    -- New free-form columns + date/period; project & department are now optional (standalone tasks).
    alter table ext.task add column if not exists type       text;
    alter table ext.task add column if not exists note       text;
    alter table ext.task add column if not exists start_date date;
    alter table ext.task add column if not exists end_date   date;
    alter table ext.task alter column project_id drop not null;
    alter table ext.task alter column department drop not null;
    update ext.task set start_date = due_date where start_date is null and due_date is not null;
    -- Tags + align status/priority values to the old repo's set (open/cancelled, medium/urgent).
    alter table ext.task add column if not exists tags jsonb not null default '[]'::jsonb;
    alter table ext.task alter column status set default 'open';
    alter table ext.task alter column priority set default 'medium';
    update ext.task set status = 'open' where status = 'todo';
    -- Kanban (ported from old PM tracker): column position + sort order; status derives from column.
    alter table ext.task add column if not exists column_id text;
    alter table ext.task add column if not exists position  integer;
    update ext.task set status = 'in_progress' where status = 'blocked';
    update ext.task set priority = 'medium' where priority = 'normal';

    -- Append-only daily-update log per task.
    create table if not exists ext.task_update (
      id         text primary key,
      task_id    text not null references ext.task(id) on delete cascade,
      author     text,
      body       text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists task_update_idx on ext.task_update (task_id, created_at desc);

    create table if not exists ext.task_project (
      project_id   text primary key,                -- ops.legal_agreement.id (as text)
      status       text not null default 'active',  -- 'active' | 'complete'
      completed_by text,
      completed_at timestamptz,
      seeded_at    timestamptz,                      -- when the 3 prep tasks were auto-created (once)
      updated_at   timestamptz not null default now()
    );
    alter table ext.task_project add column if not exists seeded_at timestamptz;

    -- ── PM tracker (ported from the old repo: Workspace → Sheet → Task) ──────────
    create table if not exists ext.pm_workspace (
      id          text primary key,
      name        text not null,
      description text,
      owner_email text not null,
      icon        text not null default '📋',
      archived    boolean not null default false,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    );
    create table if not exists ext.pm_workspace_member (
      id           text primary key,
      workspace_id text not null,
      user_email   text not null,
      role         text not null default 'member',   -- owner | admin | member | viewer
      joined_at    timestamptz not null default now()
    );
    create unique index if not exists pm_member_uidx on ext.pm_workspace_member (workspace_id, lower(user_email));
    create table if not exists ext.pm_sheet (
      id           text primary key,
      workspace_id text not null,
      name         text not null,
      description  text,
      columns      jsonb not null default '[{"id":"todo","name":"To Do","color":"#94a3b8"},{"id":"in_progress","name":"In Progress","color":"#3b82f6"},{"id":"review","name":"Review","color":"#f59e0b"},{"id":"done","name":"Done","color":"#22c55e"}]'::jsonb,
      sort_order   integer not null default 0,
      archived     boolean not null default false,
      created_by   text,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    );
    create index if not exists pm_sheet_ws_idx on ext.pm_sheet (workspace_id, sort_order);
    create table if not exists ext.pm_task (
      id             text primary key,
      sheet_id       text not null,
      title          text not null,
      description    text,
      status         text not null default 'open',     -- derived from column_id
      priority       text not null default 'medium',    -- low | medium | high | urgent
      column_id      text not null default 'todo',
      position       integer not null default 0,
      assignee_email text,
      due_date       date,
      tags           jsonb not null default '[]'::jsonb,
      created_by     text,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    );
    create index if not exists pm_task_sheet_idx on ext.pm_task (sheet_id, column_id, position);
    -- A workspace can belong to a department (chosen on create; many per dept allowed).
    alter table ext.pm_workspace add column if not exists department text;
    drop index if exists ext.pm_ws_dept_uidx;
    create index if not exists pm_ws_dept_idx on ext.pm_workspace (department);
    alter table ext.pm_workspace add column if not exists project_id text;   -- legacy (project link removed)
    alter table ext.pm_sheet add column if not exists stage_key text;
    alter table ext.pm_sheet add column if not exists done boolean not null default false;  -- prep-task completion (syncs to Project Tracker)

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

  // Tamper-evident audit: bring the app's own ext.* tables under the same
  // hash-chained audit trail as the canonical schema, using the project's
  // standard attacher audit.attach_audit() (idempotent; consistent trigger
  // naming; also wires the TRUNCATE logger). These tables are owned by the app
  // DB role, so this runtime attach works. The admin-owned tables the app also
  // edits (ops.*, inventory.*) are attached by migration 0150 instead — the app
  // role can't DDL them. The acting user is stamped per-write by mutateAs().
  const hasAudit = (await pool.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'audit' and p.proname = 'attach_audit' limit 1`,
  )).rowCount > 0;
  if (hasAudit) {
    // Standard attach (full row history + TRUNCATE logger) for app-owned tables —
    // incl. the Kanban/PM tables (ext.pm_*) added later by the task-tracker rebuild.
    for (const [sch, tbl] of [
      ['ext', 'task'], ['ext', 'task_update'], ['ext', 'task_project'], ['ext', 'social_post'],
      ['ext', 'pm_sheet'], ['ext', 'pm_workspace'], ['ext', 'pm_workspace_member'],
      ['inventory', 'cn_sku'],
    ]) {
      try {
        await pool.query('select audit.attach_audit($1, $2)', [sch, tbl]);
      } catch (e) {
        console.warn(`[audit] attach ${sch}.${tbl} skipped: ${e.message}`);
      }
    }
    // ext.social_media holds raw image/video bytes — audit add/remove but REDACT
    // the `bytes` blob so the log records the action, not the file contents.
    try { await pool.query(`select audit.attach_audit('ext', 'social_media', 'bytes')`); }
    catch (e) { console.warn(`[audit] attach ext.social_media skipped: ${e.message}`); }
    // ext.pm_task (Kanban tasks): a value-aware trigger so drag-to-reorder (bulk
    // position-only updates) doesn't flood the log — only INSERT/DELETE and changes
    // to meaningful fields (title, status/column, priority, assignee, …) are recorded.
    // Needs EXECUTE on audit.if_modified (granted to app_readwrite in migration 0150).
    try {
      await pool.query(`
        drop trigger if exists zzz_audit_pm_task on ext.pm_task;
        drop trigger if exists zzz_audit_pm_task_iud on ext.pm_task;
        drop trigger if exists zzz_audit_pm_task_upd on ext.pm_task;
        create trigger zzz_audit_pm_task_iud after insert or delete on ext.pm_task
          for each row execute function audit.if_modified();
        create trigger zzz_audit_pm_task_upd after update on ext.pm_task
          for each row when (
            old.title             is distinct from new.title
            or old.description    is distinct from new.description
            or old.status         is distinct from new.status
            or old.priority       is distinct from new.priority
            or old.column_id      is distinct from new.column_id
            or old.assignee_email is distinct from new.assignee_email
            or old.due_date       is distinct from new.due_date
            or old.tags           is distinct from new.tags
          ) execute function audit.if_modified();
      `);
    } catch (e) {
      console.warn(`[audit] pm_task trigger skipped: ${e.message}`);
    }
  }
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
