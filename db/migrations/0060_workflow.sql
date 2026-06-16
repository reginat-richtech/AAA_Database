-- =====================================================================
-- AAA_Database :: WORKFLOW DOMAIN  (tech requests + project tracker)
-- Target: PostgreSQL 16+   Depends on 0001_foundation (core.*, audit.*, roles).
--
-- Backs two frontend features:
--   * workflow.tech_request -- submissions from the "Tech Request" form
--   * workflow.project      -- the "Project Tracker"
-- Follows the foundation conventions exactly (dual key, organization_id +
-- RLS isolation, set_updated_at + audit triggers, soft delete). Self-contained
-- and idempotent.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS workflow;
COMMENT ON SCHEMA workflow IS 'Operational workflow: tech requests and project tracking (frontend-facing).';

-- ---------------------------------------------------------------------
-- Enums (closed, code-coupled status sets)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='tech_request_priority' AND n.nspname='workflow') THEN
    CREATE TYPE workflow.tech_request_priority AS ENUM ('low','medium','high','urgent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='tech_request_status' AND n.nspname='workflow') THEN
    CREATE TYPE workflow.tech_request_status AS ENUM ('submitted','in_review','approved','rejected','completed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='project_status' AND n.nspname='workflow') THEN
    CREATE TYPE workflow.project_status AS ENUM ('planning','active','on_hold','completed','cancelled');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- workflow.tech_request
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow.tech_request (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL REFERENCES core.organization(id) ON DELETE CASCADE,
    request_number  text          NULL,
    title           text          NOT NULL,
    description     text          NULL,
    requester_name  text          NOT NULL,
    requester_email citext        NOT NULL,
    category        text          NULL,
    priority        workflow.tech_request_priority NOT NULL DEFAULT 'medium',
    status          workflow.tech_request_status   NOT NULL DEFAULT 'submitted',
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    deleted_at      timestamptz   NULL,
    CONSTRAINT uq_tech_request_public_id UNIQUE (public_id),
    CONSTRAINT ck_tech_request_email CHECK (position('@' in requester_email) > 1),
    CONSTRAINT ck_tech_request_title CHECK (length(btrim(title)) > 0)
);
CREATE INDEX IF NOT EXISTS ix_tech_request_org    ON workflow.tech_request (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tech_request_status ON workflow.tech_request (organization_id, status) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tech_request_number_live ON workflow.tech_request (organization_id, request_number) WHERE request_number IS NOT NULL AND deleted_at IS NULL;
COMMENT ON TABLE workflow.tech_request IS 'Tech Request form submissions.';

DROP TRIGGER IF EXISTS trg_tech_request_set_updated_at ON workflow.tech_request;
CREATE TRIGGER trg_tech_request_set_updated_at
    BEFORE UPDATE ON workflow.tech_request
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_tech_request ON workflow.tech_request;
CREATE TRIGGER zzz_audit_tech_request
    AFTER INSERT OR UPDATE OR DELETE ON workflow.tech_request
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('requester_email');

-- ---------------------------------------------------------------------
-- workflow.project
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow.project (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL REFERENCES core.organization(id) ON DELETE CASCADE,
    name            text          NOT NULL,
    code            text          NULL,
    description     text          NULL,
    status          workflow.project_status NOT NULL DEFAULT 'planning',
    start_date      date          NULL,
    target_date     date          NULL,
    owner_name      text          NULL,
    tech_request_id bigint        NULL REFERENCES workflow.tech_request(id) ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    deleted_at      timestamptz   NULL,
    CONSTRAINT uq_project_public_id UNIQUE (public_id),
    CONSTRAINT ck_project_name CHECK (length(btrim(name)) > 0),
    CONSTRAINT ck_project_dates CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date)
);
CREATE INDEX IF NOT EXISTS ix_project_org    ON workflow.project (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_project_status ON workflow.project (organization_id, status) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_code_live ON workflow.project (organization_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;
COMMENT ON TABLE workflow.project IS 'Project Tracker entries; optionally linked to a tech_request.';

DROP TRIGGER IF EXISTS trg_project_set_updated_at ON workflow.project;
CREATE TRIGGER trg_project_set_updated_at
    BEFORE UPDATE ON workflow.project
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_project ON workflow.project;
CREATE TRIGGER zzz_audit_project
    AFTER INSERT OR UPDATE OR DELETE ON workflow.project
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- Row-level security (tenant isolation) + grants
-- ---------------------------------------------------------------------
ALTER TABLE workflow.tech_request ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tech_request_isolation ON workflow.tech_request;
CREATE POLICY rls_tech_request_isolation ON workflow.tech_request
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

ALTER TABLE workflow.project ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_isolation ON workflow.project;
CREATE POLICY rls_project_isolation ON workflow.project
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

GRANT USAGE ON SCHEMA workflow TO app_readwrite, app_readonly;
GRANT SELECT                  ON ALL TABLES IN SCHEMA workflow TO app_readonly;
GRANT SELECT, INSERT, UPDATE  ON ALL TABLES IN SCHEMA workflow TO app_readwrite;
