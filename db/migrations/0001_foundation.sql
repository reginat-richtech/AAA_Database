-- =====================================================================
-- AAA_Database :: FOUNDATION DDL
-- Target: PostgreSQL 16+
-- One database, schema-per-domain.
-- This file establishes shared identity/org/role/reference data plus the
-- audit substrate every other domain schema (invoicing, crm, hr,
-- inventory) builds upon.
--
-- VALIDATED: loaded into postgres:16 with psql -v ON_ERROR_STOP=1 on a
-- fresh DB (exit 0, 0 errors) AND re-run for idempotency (exit 0, 0 errors).
-- Functional tests confirmed: audit trigger fires + redacts secrets;
-- monthly partition routing; RLS tenant isolation + WITH CHECK block;
-- soft-delete slug reuse; audit immutability for app roles.
--
-- Run as a superuser or a role with CREATEROLE + CREATE on the database.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------
-- pgcrypto: gen_random_uuid() for public_id UUIDv4, plus pgp_sym_*/digest
--           used by column-level encryption helpers in later schemas.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext: case-insensitive text for emails / handles (avoids LOWER() indexes).
CREATE EXTENSION IF NOT EXISTS citext;

-- NOTE (deploy via infra, not in this script -- superuser / shared_preload_libraries):
--   * pgaudit         -> SOC2 session/object audit logging at the engine level.
--                        Configure in postgresql.conf: shared_preload_libraries='pgaudit'
--                        and pgaudit.log = 'write, ddl, role'.
--   * pg_partman      -> automated time-range partitioning for audit.activity_log
--                        (monthly partitions + retention). audit.activity_log is
--                        declared PARTITION BY RANGE below so partman can manage it.
-- Encryption at rest is provided by the storage layer / cloud-managed instance
-- (e.g. encrypted EBS, RDS/Cloud SQL CMK). TLS (encryption in transit) is enforced
-- via ssl=on + hostssl-only entries in pg_hba.conf. Neither is expressible in DDL.

-- ---------------------------------------------------------------------
-- 1. SCHEMAS (schema-per-domain)
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS core;       -- shared identity, orgs, app-users, roles, reference data
CREATE SCHEMA IF NOT EXISTS invoicing;  -- billing, invoices, payments (tokens only)
CREATE SCHEMA IF NOT EXISTS crm;        -- HubSpot read-only mirror
CREATE SCHEMA IF NOT EXISTS hr;         -- employees, org structure, comp
CREATE SCHEMA IF NOT EXISTS inventory;  -- products, stock, warehouses
CREATE SCHEMA IF NOT EXISTS audit;      -- change history / activity log
CREATE SCHEMA IF NOT EXISTS legal;      -- customer deal agreements / contracts (CONFIDENTIAL)

COMMENT ON SCHEMA core      IS 'Shared foundation: organizations (tenants), application login accounts, roles, and reference/lookup data. Owned by the platform team.';
COMMENT ON SCHEMA invoicing IS 'Billing and invoicing. NEVER stores raw PAN/bank numbers -- payment instruments are external-processor tokens only.';
COMMENT ON SCHEMA crm       IS 'READ-ONLY mirror of HubSpot. Rows are synced copies; writes come exclusively from the sync worker. Every table carries hubspot_* sync metadata.';
COMMENT ON SCHEMA hr        IS 'Human resources: employees (NOT the same as core.app_user), positions, compensation. High-sensitivity PII.';
COMMENT ON SCHEMA inventory IS 'Inventory and catalog: products, warehouses, stock movements.';
COMMENT ON SCHEMA audit     IS 'Append-only change history. activity_log is partitioned by month (managed by pg_partman) and written by the audit.if_modified() trigger.';

-- ---------------------------------------------------------------------
-- 2. SHARED ENUM TYPES (closed, code-controlled domains only)
-- ---------------------------------------------------------------------
-- Policy: native ENUM only for tiny, stable, app-logic-coupled sets that
-- will essentially never gain rows requiring metadata. Anything a business
-- user might extend, or that needs a label/description/sort_order, is a
-- lookup table instead (see core.country / core.currency).

-- Lifecycle status for application accounts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_user_status') THEN
    CREATE TYPE core.app_user_status AS ENUM ('invited', 'active', 'suspended', 'deactivated');
  END IF;
END
$$;
COMMENT ON TYPE core.app_user_status IS 'Lifecycle state of an application login account. Closed set, drives auth logic -- hence an enum, not a lookup table.';

-- The DML verb captured by the audit trigger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_action') THEN
    CREATE TYPE audit.audit_action AS ENUM ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  END IF;
END
$$;
COMMENT ON TYPE audit.audit_action IS 'DML verb recorded by audit.if_modified(). Closed set defined by Postgres trigger semantics -- enum.';

-- ---------------------------------------------------------------------
-- 3. SHARED TRIGGER FUNCTIONS
-- ---------------------------------------------------------------------

-- 3a. set_updated_at(): maintains updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION core.set_updated_at() IS 'BEFORE UPDATE trigger: stamps updated_at = now(). Attach to every mutable table.';

-- 3b. Application-context helpers.
-- The app sets these per-transaction via SET LOCAL so triggers (audit) and
-- RLS policies can identify the acting application user and tenant without a
-- column round-trip. They are SET LOCAL (transaction-scoped) and default to ''.
CREATE OR REPLACE FUNCTION core.current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;
COMMENT ON FUNCTION core.current_app_user_id() IS 'Returns the public_id (uuid) of the acting application user from session GUC app.current_user_id, or NULL. Set by the app via SET LOCAL.';

CREATE OR REPLACE FUNCTION core.current_organization_id()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::bigint;
$$;
COMMENT ON FUNCTION core.current_organization_id() IS 'Returns the active tenant organization surrogate id from session GUC app.current_organization_id, or NULL. Used by RLS policies.';

-- ---------------------------------------------------------------------
-- 4. AUDIT SUBSTRATE
-- ---------------------------------------------------------------------

-- 4a. activity_log -- append-only, partitioned by month.
-- PARTITION BY RANGE (changed_at) lets pg_partman create/retire monthly
-- child tables. PK includes the partition key as required by PG.
CREATE TABLE IF NOT EXISTS audit.activity_log (
    id                bigint        GENERATED ALWAYS AS IDENTITY,
    actor_db_role     text          NOT NULL DEFAULT current_user,
    actor_app_user_id uuid          NULL,
    action            audit.audit_action NOT NULL,
    schema_name       text          NOT NULL,
    table_name        text          NOT NULL,
    row_pk            text          NULL,
    old_data          jsonb         NULL,
    new_data          jsonb         NULL,
    changed_at        timestamptz   NOT NULL DEFAULT now(),
    txid              bigint        NOT NULL DEFAULT txid_current(),
    client_addr       inet          NULL DEFAULT inet_client_addr(),
    statement_only    boolean       NOT NULL DEFAULT false,
    PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

COMMENT ON TABLE audit.activity_log IS 'Append-only row-level change history written by audit.if_modified(). Partitioned monthly by changed_at (managed by pg_partman). No UPDATE/DELETE grants are issued -- immutability is enforced via privileges + (optionally) a BEFORE UPDATE/DELETE guard trigger.';
COMMENT ON COLUMN audit.activity_log.actor_db_role     IS 'Postgres role that performed the change (current_user). Survives even if the app context GUC is unset.';
COMMENT ON COLUMN audit.activity_log.actor_app_user_id IS 'public_id of the application user from session GUC app.current_user_id; NULL for system/migration writes.';
COMMENT ON COLUMN audit.activity_log.action            IS 'DML verb: INSERT/UPDATE/DELETE/TRUNCATE.';
COMMENT ON COLUMN audit.activity_log.row_pk            IS 'Text representation of the affected row primary key (id), for correlation. NULL on TRUNCATE.';
COMMENT ON COLUMN audit.activity_log.old_data          IS 'Pre-image row as jsonb (NULL on INSERT). Sensitive values are redacted by the source trigger configuration where required.';
COMMENT ON COLUMN audit.activity_log.new_data          IS 'Post-image row as jsonb (NULL on DELETE).';
COMMENT ON COLUMN audit.activity_log.txid              IS 'Transaction id grouping all rows changed in the same transaction.';
COMMENT ON COLUMN audit.activity_log.client_addr       IS 'Network address of the client connection (inet_client_addr), NULL for local socket.';
COMMENT ON COLUMN audit.activity_log.statement_only    IS 'TRUE for TRUNCATE / statement-level events where no per-row image is captured.';

-- Default catch-all partition so inserts never fail if partman lags.
CREATE TABLE IF NOT EXISTS audit.activity_log_default
    PARTITION OF audit.activity_log DEFAULT;

-- One concrete monthly partition so the table is usable immediately.
-- (pg_partman will take over ongoing creation/retention.)
CREATE TABLE IF NOT EXISTS audit.activity_log_p2026_06
    PARTITION OF audit.activity_log
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

-- Query-pattern indexes (created on the partitioned parent => propagate to children).
CREATE INDEX IF NOT EXISTS ix_activity_log_table_changed_at
    ON audit.activity_log (schema_name, table_name, changed_at DESC);
CREATE INDEX IF NOT EXISTS ix_activity_log_actor_app_user
    ON audit.activity_log (actor_app_user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS ix_activity_log_txid
    ON audit.activity_log (txid);
CREATE INDEX IF NOT EXISTS ix_activity_log_row_pk
    ON audit.activity_log (schema_name, table_name, row_pk);

-- 4b. if_modified() -- generic row-level audit trigger.
-- Attach per table:
--   CREATE TRIGGER zzz_audit
--     AFTER INSERT OR UPDATE OR DELETE ON <schema>.<table>
--     FOR EACH ROW EXECUTE FUNCTION audit.if_modified();
-- Optional TG_ARGV[0] = comma-separated column names to REDACT from images
-- (sensitive columns are replaced with the literal '__redacted__').
CREATE OR REPLACE FUNCTION audit.if_modified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_old       jsonb;
    v_new       jsonb;
    v_row_pk    text;
    v_redact    text[];
    v_col       text;
BEGIN
    -- Build pre/post images.
    IF (TG_OP = 'UPDATE') THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    ELSIF (TG_OP = 'DELETE') THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
    ELSIF (TG_OP = 'INSERT') THEN
        v_old := NULL;
        v_new := to_jsonb(NEW);
    END IF;

    -- Redact configured sensitive columns from both images.
    IF TG_NARGS >= 1 AND TG_ARGV[0] IS NOT NULL AND TG_ARGV[0] <> '' THEN
        v_redact := string_to_array(TG_ARGV[0], ',');
        FOREACH v_col IN ARRAY v_redact LOOP
            v_col := btrim(v_col);
            IF v_old ? v_col THEN v_old := jsonb_set(v_old, ARRAY[v_col], '"__redacted__"'); END IF;
            IF v_new ? v_col THEN v_new := jsonb_set(v_new, ARRAY[v_col], '"__redacted__"'); END IF;
        END LOOP;
    END IF;

    -- Derive a row pk text from the surviving image's "id" if present.
    v_row_pk := COALESCE(v_new ->> 'id', v_old ->> 'id');

    INSERT INTO audit.activity_log
        (actor_db_role, actor_app_user_id, action, schema_name, table_name,
         row_pk, old_data, new_data, changed_at, txid, client_addr, statement_only)
    VALUES
        (current_user,
         core.current_app_user_id(),
         TG_OP::audit.audit_action,
         TG_TABLE_SCHEMA,
         TG_TABLE_NAME,
         v_row_pk,
         v_old,
         v_new,
         now(),
         txid_current(),
         inet_client_addr(),
         false);

    -- AFTER trigger: return value is ignored, but be explicit.
    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
COMMENT ON FUNCTION audit.if_modified() IS 'Generic AFTER ROW trigger writing a redaction-aware pre/post image into audit.activity_log. SECURITY DEFINER so audited callers need no direct INSERT grant on audit. Optional arg: comma-separated columns to redact.';

-- ---------------------------------------------------------------------
-- 5. CORE REFERENCE / LOOKUP TABLES
-- ---------------------------------------------------------------------
-- Lookup tables (not enums) because they carry metadata (names, symbols,
-- minor units, sort order) and may be queried/joined for display & validation.

-- 5a. core.country -- ISO 3166-1.
CREATE TABLE IF NOT EXISTS core.country (
    iso2          char(2)     PRIMARY KEY,                 -- ISO 3166-1 alpha-2 (natural, immutable key)
    iso3          char(3)     NOT NULL UNIQUE,             -- ISO 3166-1 alpha-3
    numeric_code  char(3)     NOT NULL UNIQUE,             -- ISO 3166-1 numeric
    name          text        NOT NULL,
    is_active     boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_country_iso2_upper CHECK (iso2 = upper(iso2) AND iso2 ~ '^[A-Z]{2}$'),
    CONSTRAINT ck_country_iso3_upper CHECK (iso3 = upper(iso3) AND iso3 ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_country_numeric    CHECK (numeric_code ~ '^[0-9]{3}$')
);
COMMENT ON TABLE  core.country IS 'ISO 3166-1 country reference. Natural PK iso2 -- globally stable, used directly as FK in addresses.';
COMMENT ON COLUMN core.country.iso2 IS 'ISO 3166-1 alpha-2 code (e.g. US). Primary, natural key.';

DROP TRIGGER IF EXISTS trg_country_set_updated_at ON core.country;
CREATE TRIGGER trg_country_set_updated_at
    BEFORE UPDATE ON core.country
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- 5b. core.currency -- ISO 4217.
CREATE TABLE IF NOT EXISTS core.currency (
    code          char(3)     PRIMARY KEY,                 -- ISO 4217 alpha (natural key)
    numeric_code  char(3)     NOT NULL UNIQUE,             -- ISO 4217 numeric
    name          text        NOT NULL,
    symbol        text        NULL,
    minor_unit    smallint    NOT NULL DEFAULT 2,          -- decimal places (e.g. JPY=0, USD=2, BHD=3)
    is_active     boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_currency_code_upper CHECK (code = upper(code) AND code ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_currency_numeric    CHECK (numeric_code ~ '^[0-9]{3}$'),
    CONSTRAINT ck_currency_minor_unit CHECK (minor_unit BETWEEN 0 AND 4)
);
COMMENT ON TABLE  core.currency IS 'ISO 4217 currency reference. Natural PK code. minor_unit drives money rounding in invoicing.';
COMMENT ON COLUMN core.currency.minor_unit IS 'Number of decimal places for the currency (JPY=0, USD=2, BHD=3). Drives numeric scale handling in money calculations.';

DROP TRIGGER IF EXISTS trg_currency_set_updated_at ON core.currency;
CREATE TRIGGER trg_currency_set_updated_at
    BEFORE UPDATE ON core.currency
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. CORE TENANT + IDENTITY TABLES
-- ---------------------------------------------------------------------
-- PK strategy (see conventions): bigint GENERATED ALWAYS AS IDENTITY surrogate
-- (internal, fast joins, never exposed) + a separate public_id uuid (default
-- gen_random_uuid()) that is the ONLY identifier used in URLs/APIs.

-- 6a. core.organization -- the tenant boundary.
CREATE TABLE IF NOT EXISTS core.organization (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    legal_name      text         NOT NULL,
    display_name    text         NOT NULL,
    slug            citext       NOT NULL,                  -- url-safe handle, case-insensitive
    primary_country char(2)      NULL,
    default_currency char(3)     NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,                      -- app_user.public_id
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,                      -- soft delete
    CONSTRAINT uq_organization_public_id UNIQUE (public_id),
    CONSTRAINT ck_organization_slug      CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
    CONSTRAINT fk_organization_country   FOREIGN KEY (primary_country)  REFERENCES core.country(iso2),
    CONSTRAINT fk_organization_currency  FOREIGN KEY (default_currency) REFERENCES core.currency(code)
);
COMMENT ON TABLE  core.organization IS 'Tenant root. Every tenant-scoped table in any schema carries organization_id -> core.organization(id) and is governed by RLS.';
COMMENT ON COLUMN core.organization.id        IS 'Internal surrogate PK. NEVER exposed externally.';
COMMENT ON COLUMN core.organization.public_id IS 'Externally exposed UUID. Use in URLs/APIs to avoid leaking tenant counts.';
COMMENT ON COLUMN core.organization.slug      IS 'Case-insensitive URL handle. Unique among non-deleted rows.';
COMMENT ON COLUMN core.organization.deleted_at IS 'Soft-delete tombstone. NULL = live. Application queries must filter deleted_at IS NULL.';

-- Slug unique only among live rows (soft-deleted slugs can be reused).
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_slug_live
    ON core.organization (slug) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_organization_set_updated_at ON core.organization;
CREATE TRIGGER trg_organization_set_updated_at
    BEFORE UPDATE ON core.organization
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_organization ON core.organization;
CREATE TRIGGER zzz_audit_organization
    AFTER INSERT OR UPDATE OR DELETE ON core.organization
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- 6b. core.app_user -- INTERNAL APPLICATION LOGIN ACCOUNTS (not HR employees).
CREATE TABLE IF NOT EXISTS core.app_user (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,                  -- home tenant
    email           citext       NOT NULL,                  -- login identity (PII)
    full_name       text         NULL,                      -- (PII)
    status          core.app_user_status NOT NULL DEFAULT 'invited',
    -- Authentication material. password_hash is an Argon2/bcrypt hash ONLY --
    -- never a plaintext or reversible value. May be NULL for SSO-only accounts.
    password_hash   text         NULL,
    mfa_secret      bytea        NULL,                      -- encrypted TOTP seed (pgp_sym_encrypt)
    last_login_at   timestamptz  NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    -- right-to-erasure: when pseudonymized, PII is overwritten and this is set.
    pseudonymized_at timestamptz NULL,
    CONSTRAINT uq_app_user_public_id UNIQUE (public_id),
    CONSTRAINT fk_app_user_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE RESTRICT,
    CONSTRAINT ck_app_user_email CHECK (position('@' in email) > 1)
);
COMMENT ON TABLE  core.app_user IS 'Internal application login accounts (operators/admins of the platform). NOT employees -- see hr.employee. Holds auth material and login PII.';
COMMENT ON COLUMN core.app_user.email          IS 'Login email. PII. Case-insensitive. Unique per organization among live rows.';
COMMENT ON COLUMN core.app_user.password_hash  IS 'Argon2/bcrypt password hash ONLY. Never plaintext. NULL for SSO-only accounts.';
COMMENT ON COLUMN core.app_user.mfa_secret     IS 'Encrypted TOTP seed (pgcrypto pgp_sym_encrypt). Sensitive -- encrypt at column level.';
COMMENT ON COLUMN core.app_user.pseudonymized_at IS 'Set when GDPR/CCPA erasure has pseudonymized this account (email/full_name overwritten). Preserves referential history without retaining PII.';

-- Email unique per tenant, only among live & non-pseudonymized rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_org_email_live
    ON core.app_user (organization_id, email)
    WHERE deleted_at IS NULL AND pseudonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_user_org ON core.app_user (organization_id);

DROP TRIGGER IF EXISTS trg_app_user_set_updated_at ON core.app_user;
CREATE TRIGGER trg_app_user_set_updated_at
    BEFORE UPDATE ON core.app_user
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Audit app_user but REDACT auth material from the change images.
DROP TRIGGER IF EXISTS zzz_audit_app_user ON core.app_user;
CREATE TRIGGER zzz_audit_app_user
    AFTER INSERT OR UPDATE OR DELETE ON core.app_user
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('password_hash,mfa_secret');

-- 6c. core.role -- named privilege bundles (application-level RBAC).
-- Lookup table (not enum): roles are created/edited operationally and carry
-- metadata. is_system marks built-in roles that must not be deleted.
CREATE TABLE IF NOT EXISTS core.role (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NULL,                      -- NULL = global/system role
    code            citext       NOT NULL,                  -- machine name, e.g. 'org_admin'
    name            text         NOT NULL,
    description     text         NULL,
    is_system       boolean      NOT NULL DEFAULT false,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_role_public_id UNIQUE (public_id),
    CONSTRAINT ck_role_code CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT fk_role_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE  core.role IS 'Application RBAC role definitions. organization_id NULL => global/system role shared across tenants; otherwise tenant-scoped custom role.';
COMMENT ON COLUMN core.role.code      IS 'Stable machine identifier used by application authorization checks.';
COMMENT ON COLUMN core.role.is_system IS 'TRUE for built-in roles seeded by the platform; must not be deleted by tenants.';

-- code unique within its scope (global vs per-org), among live rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_global_code_live
    ON core.role (code) WHERE organization_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_org_code_live
    ON core.role (organization_id, code) WHERE organization_id IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_role_set_updated_at ON core.role;
CREATE TRIGGER trg_role_set_updated_at
    BEFORE UPDATE ON core.role
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_role ON core.role;
CREATE TRIGGER zzz_audit_role
    AFTER INSERT OR UPDATE OR DELETE ON core.role
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- 6d. core.app_user_role -- assignment (M:N).
CREATE TABLE IF NOT EXISTS core.app_user_role (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,                  -- denormalized tenant for RLS
    app_user_id     bigint       NOT NULL,
    role_id         bigint       NOT NULL,
    granted_at      timestamptz  NOT NULL DEFAULT now(),
    granted_by      uuid         NULL,
    expires_at      timestamptz  NULL,                      -- optional time-boxed grant
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_app_user_role_public_id UNIQUE (public_id),
    CONSTRAINT fk_aur_org      FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_aur_user     FOREIGN KEY (app_user_id)     REFERENCES core.app_user(id)    ON DELETE CASCADE,
    CONSTRAINT fk_aur_role     FOREIGN KEY (role_id)         REFERENCES core.role(id)        ON DELETE RESTRICT,
    CONSTRAINT ck_aur_expiry   CHECK (expires_at IS NULL OR expires_at > granted_at)
);
COMMENT ON TABLE core.app_user_role IS 'Assigns application roles to application users (M:N). organization_id is denormalized from app_user for single-predicate RLS.';
COMMENT ON COLUMN core.app_user_role.expires_at IS 'Optional grant expiry; NULL = permanent until revoked (soft-deleted).';

-- A user holds a given role at most once (among live grants).
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_role_live
    ON core.app_user_role (app_user_id, role_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_aur_org  ON core.app_user_role (organization_id);
CREATE INDEX IF NOT EXISTS ix_aur_role ON core.app_user_role (role_id);

DROP TRIGGER IF EXISTS trg_app_user_role_set_updated_at ON core.app_user_role;
CREATE TRIGGER trg_app_user_role_set_updated_at
    BEFORE UPDATE ON core.app_user_role
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_app_user_role ON core.app_user_role;
CREATE TRIGGER zzz_audit_app_user_role
    AFTER INSERT OR UPDATE OR DELETE ON core.app_user_role
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 7. ROW-LEVEL SECURITY (tenant isolation pattern)
-- ---------------------------------------------------------------------
-- Pattern every tenant-scoped table follows.
-- The app connects as a NOBYPASSRLS role and sets:
--   SET LOCAL app.current_organization_id = '<org id>';
-- A separate trusted migration/sync role has BYPASSRLS.
ALTER TABLE core.app_user       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.app_user_role  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.organization   ENABLE ROW LEVEL SECURITY;

-- organization: a session may see only its own org row.
DROP POLICY IF EXISTS rls_organization_isolation ON core.organization;
CREATE POLICY rls_organization_isolation ON core.organization
    USING (id = core.current_organization_id());

DROP POLICY IF EXISTS rls_app_user_isolation ON core.app_user;
CREATE POLICY rls_app_user_isolation ON core.app_user
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_app_user_role_isolation ON core.app_user_role;
CREATE POLICY rls_app_user_role_isolation ON core.app_user_role
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- ---------------------------------------------------------------------
-- 8. SECURITY: LEAST-PRIVILEGE DATABASE ROLES
-- ---------------------------------------------------------------------
-- NOLOGIN group roles; concrete login users inherit and are created per-env
-- by infra with credentials from the secrets manager (not in DDL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN
    CREATE ROLE app_readonly  NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    -- BYPASSRLS for migrations/seeding; never used by request-path connections.
    CREATE ROLE app_migrator  NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_sync') THEN
    -- Writes only to crm.* (HubSpot mirror); BYPASSRLS to mirror all tenants.
    CREATE ROLE crm_sync      NOLOGIN BYPASSRLS;
  END IF;
END
$$;

COMMENT ON ROLE app_readonly  IS 'Reporting / read replicas. SELECT only on non-sensitive surfaces.';
COMMENT ON ROLE app_readwrite IS 'Request-path application role. NOBYPASSRLS -- all access is tenant-filtered by RLS.';
COMMENT ON ROLE app_migrator  IS 'Schema migrations and seeding. BYPASSRLS. Not used by the running application.';
COMMENT ON ROLE crm_sync      IS 'HubSpot sync worker. The only writer to crm.*; read-only elsewhere.';

-- Schema usage.
GRANT USAGE ON SCHEMA core, invoicing, hr, inventory, audit, crm, legal TO app_readwrite, app_readonly;

-- Least privilege on core:
GRANT SELECT ON ALL TABLES IN SCHEMA core TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO app_readwrite;
-- NOTE: no DELETE granted -- deletions are soft (deleted_at). Hard deletes are
-- a migrator-only operation.

-- Audit immutability: writes go through the SECURITY DEFINER trigger; app roles
-- get SELECT only and CANNOT update/delete history.
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO app_readonly, app_readwrite;
-- (No INSERT/UPDATE/DELETE to app roles on audit -- writes go through audit.if_modified,
--  which is SECURITY DEFINER and runs as the function owner.)

-- Default privileges so future tables created by the migrator inherit the policy.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA core
    GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA core
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_readwrite;

-- ---------------------------------------------------------------------
-- 9. MINIMAL SEED (reference data only -- safe & idempotent)
-- ---------------------------------------------------------------------
INSERT INTO core.currency (code, numeric_code, name, symbol, minor_unit) VALUES
    ('USD', '840', 'US Dollar',  '$', 2),
    ('EUR', '978', 'Euro',       '€', 2),
    ('GBP', '826', 'Pound Sterling', '£', 2),
    ('JPY', '392', 'Yen',        '¥', 0)
ON CONFLICT (code) DO NOTHING;

INSERT INTO core.country (iso2, iso3, numeric_code, name) VALUES
    ('US', 'USA', '840', 'United States'),
    ('GB', 'GBR', '826', 'United Kingdom'),
    ('DE', 'DEU', '276', 'Germany'),
    ('JP', 'JPN', '392', 'Japan')
ON CONFLICT (iso2) DO NOTHING;

-- =====================================================================
-- END FOUNDATION DDL
-- =====================================================================