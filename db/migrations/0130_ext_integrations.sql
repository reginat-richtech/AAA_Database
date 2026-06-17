-- 0130_ext_integrations.sql
-- External-dataset store: full Navan / JotForm / QuickBooks records pulled by the
-- web app's data-sync job. Each table keeps the complete API record as `raw jsonb`
-- plus indexed key columns. The app also creates these on demand (idempotent), so
-- this migration is for documentation/consistency — safe to run more than once.

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
