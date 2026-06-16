-- =====================================================================
-- AAA_Database :: OPS FEATURES  (Data Upload / Tech Request / Project Tracker)
-- Target: PostgreSQL 16+   Depends on 0001_foundation (pgcrypto, roles).
--
-- Purpose-built tables that back the three workflow features, modeled on the
-- existing AAA app (single-company, so no organization_id / RLS here):
--   ops.legal_agreement        -- Data Upload: PDF + LLM-extracted fields
--   ops.tech_request_submission-- Tech Request: form answers + status
--   ops.tech_confirmation      -- Technician Confirmation (JotForm webhook)
--   ops.jotform_stage_event    -- workflow stage webhooks (Project Tracker)
-- Self-contained + idempotent.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ops;
COMMENT ON SCHEMA ops IS 'Operational workflow features: data upload, tech requests, project tracking.';

-- Auto-minted human project numbers: PRJ-00001, PRJ-00002, ...
CREATE SEQUENCE IF NOT EXISTS ops.project_number_seq START 1;

-- ---------------------------------------------------------------------
-- Data Upload: one row per uploaded legal-agreement PDF + extraction
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.legal_agreement (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_number           text UNIQUE NOT NULL
                               DEFAULT ('PRJ-' || lpad(nextval('ops.project_number_seq')::text, 5, '0')),
    filename                 text NOT NULL,
    file_size                integer NOT NULL DEFAULT 0,
    extract_method           text,                       -- 'vision' | 'text_parser'
    uploaded_by              text,
    salesman_name            text,
    salesman_email           text,
    deal_id                  text,                        -- HubSpot deal id
    status                   text NOT NULL DEFAULT 'processing',  -- processing|ready|error
    error                    text,
    agreement_type           text,                        -- RaaS|Event Rental|Full Robot Sale|Other
    title                    text,
    counterparty             text,
    effective_date           date,
    execution_date           date,
    expiration_date          date,
    auto_renewal             boolean,
    contract_value           numeric(16,2),
    currency                 text DEFAULT 'USD',
    governing_law            text,
    termination_notice_days  integer,
    robot_types              text,                        -- comma-joined families
    robot_count              integer,
    summary                  text,
    extracted_json           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- full extraction payload
    source_text              text,                        -- truncated extracted text
    source_pdf               bytea,                       -- original file bytes
    content_type             text DEFAULT 'application/pdf',
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_legal_agreement_status CHECK (status IN ('processing','ready','error'))
);
CREATE INDEX IF NOT EXISTS ix_legal_agreement_salesman ON ops.legal_agreement (lower(salesman_email));
CREATE INDEX IF NOT EXISTS ix_legal_agreement_created  ON ops.legal_agreement (created_at DESC);

DROP TRIGGER IF EXISTS trg_legal_agreement_set_updated_at ON ops.legal_agreement;
CREATE TRIGGER trg_legal_agreement_set_updated_at
    BEFORE UPDATE ON ops.legal_agreement
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ---------------------------------------------------------------------
-- Tech Request: a form submission tied (usually) to an agreement
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.tech_request_submission (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id    uuid REFERENCES ops.legal_agreement(id) ON DELETE SET NULL,
    agreement_type  text,
    form_type       text,                                 -- installation|event
    status          text NOT NULL DEFAULT 'saved',        -- saved|finalized|approved
    submitted_by    text,
    answers         jsonb NOT NULL DEFAULT '{}'::jsonb,    -- field answers + _jotform/_calendar/_approval/_emails
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_tech_request_status CHECK (status IN ('saved','finalized','approved'))
);
CREATE INDEX IF NOT EXISTS ix_tech_request_agreement ON ops.tech_request_submission (agreement_id);

DROP TRIGGER IF EXISTS trg_tech_request_submission_set_updated_at ON ops.tech_request_submission;
CREATE TRIGGER trg_tech_request_submission_set_updated_at
    BEFORE UPDATE ON ops.tech_request_submission
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ---------------------------------------------------------------------
-- Technician Confirmation (recorded from a JotForm webhook; idempotent)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.tech_confirmation (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id text UNIQUE NOT NULL,                   -- JotForm submission id
    form_id       text,
    team          text,
    so_number     text,
    contact_email text,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    result        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tech_confirmation_so ON ops.tech_confirmation (so_number);

-- ---------------------------------------------------------------------
-- Workflow stage webhooks (Project Tracker feed); one row per (submission, stage)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.jotform_stage_event (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id       text,
    submission_id text,
    stage         text,
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_jotform_stage_event UNIQUE (submission_id, stage)
);
CREATE INDEX IF NOT EXISTS ix_jotform_stage_event_sub ON ops.jotform_stage_event (submission_id);

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA ops TO app_readwrite, app_readonly;
GRANT SELECT                          ON ALL TABLES    IN SCHEMA ops TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE  ON ALL TABLES    IN SCHEMA ops TO app_readwrite;
GRANT USAGE, SELECT                   ON ALL SEQUENCES IN SCHEMA ops TO app_readwrite;
