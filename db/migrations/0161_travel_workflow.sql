-- 0161_travel_workflow.sql
-- Standalone TRAVEL workflow, separate from the Project Tracker pipeline.
--
-- Two ways a travel request lands here:
--   * APP   — any signed-in user starts one on the /travel-requests page
--             (POST /api/travel-requests). These carry purpose/destination/dates
--             and an optional link to a project (ops.legal_agreement).
--   * JOTFORM — the Travel Request Form approval webhook (?stage=travel…) writes a
--               row straight in (source='jotform', status='approved').
--
-- Travel used to be the "Trip & Travel Requests" node of the 10-stage Project
-- Tracker, with approvals mixed into ops.jotform_stage_event (stage LIKE 'travel%').
-- It is now its own table; the tracker no longer carries a travel stage.
--
-- Idempotent. Depends on 0080_ops_features (ops.legal_agreement + jotform_stage_event),
-- 0060_workflow (core.set_updated_at), 0150_app_audit (audit.attach_audit), and
-- 0001_foundation (roles app_readonly/app_readwrite).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS ops;

-- ---------------------------------------------------------------------
-- ops.travel_request — one row per travel request.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.travel_request (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- people
    traveler       text,                                 -- who is traveling
    requested_by   text,                                 -- email of the app user who filed it
    -- the trip
    purpose        text,                                 -- reason for travel
    destination    text,
    start_date     date,
    end_date       date,
    notes          text,
    -- workflow
    status         text NOT NULL DEFAULT 'requested',    -- requested | approved | denied | booked | completed
    source         text NOT NULL DEFAULT 'app',          -- app | jotform
    -- optional link to a project (Project Tracker = ops.legal_agreement)
    agreement_id   uuid REFERENCES ops.legal_agreement(id) ON DELETE SET NULL,
    so_number      text,                                 -- sales order, for cross-table matching / webhook path
    -- JotForm webhook provenance (null for app-created rows)
    form_id        text,
    submission_id  text,
    stage          text,
    payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- one webhook event per (submission, stage); app rows have both NULL (NULLs are
    -- distinct in a UNIQUE index, so multiple app rows never collide).
    CONSTRAINT uq_travel_request_submission UNIQUE (submission_id, stage),
    CONSTRAINT ck_travel_request_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS ix_travel_request_created ON ops.travel_request (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_travel_request_so      ON ops.travel_request (so_number);
CREATE INDEX IF NOT EXISTS ix_travel_request_agr     ON ops.travel_request (agreement_id);
CREATE INDEX IF NOT EXISTS ix_travel_request_sub     ON ops.travel_request (submission_id);
COMMENT ON TABLE ops.travel_request IS 'Standalone travel requests (app-created or Travel Request Form webhook); separate from the Project Tracker pipeline.';

-- keep updated_at fresh on every UPDATE
DROP TRIGGER IF EXISTS trg_travel_request_set_updated_at ON ops.travel_request;
CREATE TRIGGER trg_travel_request_set_updated_at
    BEFORE UPDATE ON ops.travel_request
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ---------------------------------------------------------------------
-- Backfill: move existing travel events out of the shared stage-event table
-- (they were JotForm approvals), then drop them so the tracker stays clean.
-- ---------------------------------------------------------------------
INSERT INTO ops.travel_request (form_id, submission_id, so_number, stage, traveler, status, source, payload, created_at)
SELECT form_id,
       submission_id,
       NULLIF(payload->>'so_number', ''),
       stage,
       NULLIF(COALESCE(payload->>'traveler', payload->>'name'), ''),
       'approved',
       'jotform',
       payload,
       received_at
FROM   ops.jotform_stage_event
WHERE  stage LIKE 'travel%'
ON CONFLICT (submission_id, stage) DO NOTHING;

DELETE FROM ops.jotform_stage_event WHERE stage LIKE 'travel%';

-- ---------------------------------------------------------------------
-- Bring the table under the tamper-evident audit trail (admin-owned table, so it
-- is attached here as admin — matching 0150). Guarded: skip if audit isn't present.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF to_regprocedure('audit.attach_audit(text,text,text,text)') IS NOT NULL THEN
        PERFORM audit.attach_audit('ops', 'travel_request');
    END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Grants (match the ops schema's existing grant model).
-- ---------------------------------------------------------------------
GRANT SELECT                          ON ops.travel_request TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE  ON ops.travel_request TO app_readwrite;
