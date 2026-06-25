-- =====================================================================
-- AAA_Database :: PROJECT PROPOSAL  (Project Tracker — entry-point stage)
-- Target: PostgreSQL 16+   Depends on 0080_ops_features (ops schema, roles).
--
-- One row per approved PROJECT PROPOSAL FORM submission (JotForm webhook).
-- The proposal is the FIRST step of a project — it precedes the agreement —
-- so the Project Tracker reads these rows to light up the "Final Proposal
-- Form" stage and to seed downstream info (incl. an AI-extracted inventory
-- package list). Recorded from a JotForm webhook; idempotent on submission_id.
-- Self-contained + idempotent.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.project_proposal (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id         text UNIQUE NOT NULL,             -- JotForm submission id
    form_id               text,
    contract_number       text,                             -- form "Project Contract Number"
    project_name          text,
    customer_name         text,
    customer_email        text,
    sales_name            text,
    sales_email           text,
    pm_name               text,
    pm_email              text,
    tech_lead_name        text,
    tech_lead_email       text,
    address               text,
    project_info          text,                             -- free-text "Project Information"
    site_survey_done      boolean NOT NULL DEFAULT false,   -- "Completed" checkbox
    predeploy_review_done boolean NOT NULL DEFAULT false,   -- "Completed" checkbox
    site_survey_url       text,                             -- uploaded Site Survey Report file
    deployment_url        text,                             -- uploaded Deployment Plan file
    packing_list_url      text,                             -- uploaded Packing List file (form QID 186)
    package_list          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- AI-extracted [{item,quantity,notes}]
    payload               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full raw JotForm answers
    created_at            timestamptz NOT NULL DEFAULT now()
);
-- Idempotent column add for databases created before packing_list_url existed
-- (the runner re-applies every migration, so this keeps already-applied DBs current).
ALTER TABLE ops.project_proposal ADD COLUMN IF NOT EXISTS packing_list_url text;

CREATE INDEX IF NOT EXISTS ix_project_proposal_customer ON ops.project_proposal (lower(customer_name));
CREATE INDEX IF NOT EXISTS ix_project_proposal_created  ON ops.project_proposal (created_at DESC);

-- ---------------------------------------------------------------------
-- Grants (re-applied so the new table inherits the ops schema grants)
-- ---------------------------------------------------------------------
GRANT SELECT                          ON ops.project_proposal TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE  ON ops.project_proposal TO app_readwrite;
