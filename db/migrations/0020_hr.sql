-- =====================================================================
-- AAA_Database :: HR DOMAIN SCHEMA
-- Target: PostgreSQL 16+. Depends on FOUNDATION DDL (core/audit objects).
-- Scope: employees & working-time data (HIGH sensitivity PII).
-- Follows AAA_Database Foundation Conventions EXACTLY:
--   dual key (bigint id + public_id uuid), standard columns,
--   organization_id tenant scoping + RLS, set_updated_at + audit triggers,
--   snake_case singular tables, encryption/tokenization for secrets.
-- VALIDATED in postgres:16: clean load + idempotent re-run (exit 0);
--   RLS isolation + WITH CHECK block; audit redaction; generated
--   worked_hours; bank-tokenization & self-manager CHECKs; soft-delete reuse.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. HR ENUM TYPES (tiny, closed, code-coupled sets only)
-- ---------------------------------------------------------------------
-- Policy (foundation sec.5): native ENUM only for small, stable, app-logic-
-- coupled sets needing no per-row metadata. Sets a business user would edit,
-- or that need label/description/sort_order, become LOOKUP tables (see
-- hr.leave_type, hr.shift).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='employment_type' AND n.nspname='hr') THEN
    CREATE TYPE hr.employment_type AS ENUM
      ('full_time','part_time','contractor','intern','temporary');
  END IF;
END$$;
COMMENT ON TYPE hr.employment_type IS 'Worker engagement type. Closed, payroll-logic-coupled set -> enum (not lookup).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='employment_status' AND n.nspname='hr') THEN
    CREATE TYPE hr.employment_status AS ENUM
      ('pending','active','on_leave','suspended','terminated');
  END IF;
END$$;
COMMENT ON TYPE hr.employment_status IS 'Lifecycle of an employment record. Closed, code-coupled -> enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='leave_request_status' AND n.nspname='hr') THEN
    CREATE TYPE hr.leave_request_status AS ENUM
      ('draft','submitted','approved','rejected','cancelled','taken');
  END IF;
END$$;
COMMENT ON TYPE hr.leave_request_status IS 'Approval workflow state for a leave request. Closed state machine -> enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='timesheet_status' AND n.nspname='hr') THEN
    CREATE TYPE hr.timesheet_status AS ENUM
      ('open','submitted','approved','rejected','locked');
  END IF;
END$$;
COMMENT ON TYPE hr.timesheet_status IS 'Approval state of a timesheet period. Closed state machine -> enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='attendance_status' AND n.nspname='hr') THEN
    CREATE TYPE hr.attendance_status AS ENUM
      ('present','absent','late','partial','remote','holiday','on_leave');
  END IF;
END$$;
COMMENT ON TYPE hr.attendance_status IS 'Outcome of a worked/expected day. Closed code-coupled set -> enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='time_entry_source' AND n.nspname='hr') THEN
    CREATE TYPE hr.time_entry_source AS ENUM
      ('web','mobile','kiosk','biometric','badge','import','manual');
  END IF;
END$$;
COMMENT ON TYPE hr.time_entry_source IS 'Capture channel for a clock in/out event. Closed device/integration set -> enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='pay_frequency' AND n.nspname='hr') THEN
    CREATE TYPE hr.pay_frequency AS ENUM
      ('hourly','weekly','biweekly','semimonthly','monthly','annual');
  END IF;
END$$;
COMMENT ON TYPE hr.pay_frequency IS 'Frequency the compensation amount is expressed/paid in. Closed payroll set -> enum.';

-- ---------------------------------------------------------------------
-- 1. hr.department -- org structure node (tenant-scoped, self-referencing).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.department (
    id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id      bigint      NOT NULL,
    parent_department_id bigint      NULL,
    code                 citext      NOT NULL,
    name                 text        NOT NULL,
    description          text        NULL,
    head_employment_id   bigint      NULL,
    cost_center          text        NULL,
    is_active            boolean     NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    created_by           uuid        NULL,
    updated_by           uuid        NULL,
    deleted_at           timestamptz NULL,
    CONSTRAINT uq_department_public_id UNIQUE (public_id),
    CONSTRAINT ck_department_code      CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT ck_department_not_self  CHECK (parent_department_id IS NULL OR parent_department_id <> id),
    CONSTRAINT fk_department_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_department_parent FOREIGN KEY (parent_department_id)
        REFERENCES hr.department(id) ON DELETE RESTRICT
    -- fk_department_head added AFTER hr.employment exists (forward reference)
);
COMMENT ON TABLE  hr.department IS 'Organizational unit within a tenant. Self-referencing tree via parent_department_id. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.department.id                   IS 'Internal surrogate PK. Never exposed externally.';
COMMENT ON COLUMN hr.department.public_id            IS 'External UUID for URLs/APIs. Avoids leaking headcount/org-size.';
COMMENT ON COLUMN hr.department.parent_department_id IS 'Parent node for the department hierarchy; NULL for a top-level unit. RESTRICT to avoid silently orphaning children.';
COMMENT ON COLUMN hr.department.head_employment_id   IS 'Optional department head, references hr.employment(id). FK added after hr.employment is defined.';
COMMENT ON COLUMN hr.department.cost_center          IS 'Finance/GL cost-center reference for reporting roll-ups.';
COMMENT ON COLUMN hr.department.deleted_at           IS 'Soft-delete tombstone. Queries must filter deleted_at IS NULL.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_department_org_code_live
    ON hr.department (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_department_org    ON hr.department (organization_id);
CREATE INDEX IF NOT EXISTS ix_department_parent ON hr.department (parent_department_id);

DROP TRIGGER IF EXISTS trg_department_set_updated_at ON hr.department;
CREATE TRIGGER trg_department_set_updated_at
    BEFORE UPDATE ON hr.department
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_department ON hr.department;
CREATE TRIGGER zzz_audit_department
    AFTER INSERT OR UPDATE OR DELETE ON hr.department
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 2. hr.position -- job/role definition (tenant-scoped).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.position (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    department_id   bigint       NULL,
    code            citext       NOT NULL,
    title           text         NOT NULL,
    description     text         NULL,
    job_family      text         NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_position_public_id UNIQUE (public_id),
    CONSTRAINT ck_position_code CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT fk_position_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_position_department FOREIGN KEY (department_id)
        REFERENCES hr.department(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.position IS 'Job/role definition (the seat, distinct from the person filling it). Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.position.department_id IS 'Default department for the role; SET NULL if the department is removed (the role definition survives).';
COMMENT ON COLUMN hr.position.job_family    IS 'Optional career-track grouping for reporting/compensation banding.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_org_code_live
    ON hr.position (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_position_org        ON hr.position (organization_id);
CREATE INDEX IF NOT EXISTS ix_position_department ON hr.position (department_id);

DROP TRIGGER IF EXISTS trg_position_set_updated_at ON hr.position;
CREATE TRIGGER trg_position_set_updated_at
    BEFORE UPDATE ON hr.position
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_position ON hr.position;
CREATE TRIGGER zzz_audit_position
    AFTER INSERT OR UPDATE OR DELETE ON hr.position
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 3. hr.employee -- the PERSON. HIGHEST sensitivity table.
--    Distinct from core.app_user (login accounts). Optional 1:1 link.
--    PII handling (foundation sec.8):
--      * national_id (SSN/NI/etc) -> NEVER plaintext. Encrypted bytea
--        (pgcrypto pgp_sym_encrypt; key in KMS) + non-reversible HMAC hash
--        for dedupe/lookup without exposure.
--      * bank account -> NEVER raw IBAN/account number. Tokenized externally:
--        store token + last4 + bank/processor only (mirrors payments policy;
--        keeps DB out of PCI/sensitive scope).
--      * date_of_birth/home address/legal name -> retained PII; protect via
--        RLS + column grants + at-rest encryption; pseudonymized_at supports
--        right-to-erasure.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.employee (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint      NOT NULL,
    app_user_id         bigint      NULL,
    employee_number     citext      NOT NULL,
    legal_first_name    text        NOT NULL,
    legal_last_name     text        NOT NULL,
    preferred_name      text        NULL,
    date_of_birth       date        NULL,
    national_id_enc     bytea       NULL,
    national_id_hash    bytea       NULL,
    national_id_country char(2)     NULL,
    personal_email      citext      NULL,
    work_email          citext      NULL,
    phone               text        NULL,
    address_line1       text        NULL,
    address_line2       text        NULL,
    address_city        text        NULL,
    address_region      text        NULL,
    address_postal_code text        NULL,
    address_country     char(2)     NULL,
    bank_account_token     text     NULL,
    bank_account_last4     char(4)  NULL,
    bank_name              text     NULL,
    bank_account_processor text     NULL,
    hire_date           date        NULL,
    termination_date    date        NULL,
    is_active           boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid        NULL,
    updated_by          uuid        NULL,
    deleted_at          timestamptz NULL,
    pseudonymized_at    timestamptz NULL,
    CONSTRAINT uq_employee_public_id UNIQUE (public_id),
    CONSTRAINT ck_employee_number     CHECK (employee_number ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'),
    CONSTRAINT ck_employee_last4      CHECK (bank_account_last4 IS NULL OR bank_account_last4 ~ '^[0-9]{4}$'),
    CONSTRAINT ck_employee_pers_email CHECK (personal_email IS NULL OR position('@' in personal_email) > 1),
    CONSTRAINT ck_employee_work_email CHECK (work_email     IS NULL OR position('@' in work_email)     > 1),
    CONSTRAINT ck_employee_dob_past   CHECK (date_of_birth  IS NULL OR date_of_birth <= CURRENT_DATE),
    CONSTRAINT ck_employee_term_after_hire
        CHECK (termination_date IS NULL OR hire_date IS NULL OR termination_date >= hire_date),
    CONSTRAINT ck_employee_bank_tokenized CHECK (
        (bank_account_last4 IS NULL AND bank_name IS NULL AND bank_account_processor IS NULL)
        OR bank_account_token IS NOT NULL
    ),
    CONSTRAINT fk_employee_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE RESTRICT,
    CONSTRAINT fk_employee_app_user FOREIGN KEY (app_user_id)
        REFERENCES core.app_user(id) ON DELETE SET NULL,
    CONSTRAINT fk_employee_nid_country FOREIGN KEY (national_id_country)
        REFERENCES core.country(iso2),
    CONSTRAINT fk_employee_addr_country FOREIGN KEY (address_country)
        REFERENCES core.country(iso2)
);
COMMENT ON TABLE  hr.employee IS 'A natural person employed by a tenant. HIGHEST-sensitivity PII table (legal name, DOB, national id, address, bank payout). national_id encrypted; bank account tokenized (never raw). Distinct from core.app_user. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.employee.app_user_id            IS 'Optional 1:1 link to the platform login account (core.app_user). NULL when the employee has no system login. SET NULL on account deletion.';
COMMENT ON COLUMN hr.employee.employee_number        IS 'Internal/HR-facing employee number. Unique per tenant. Use public_id for any external exposure.';
COMMENT ON COLUMN hr.employee.legal_first_name       IS 'Legal given name. PII. Overwritten on pseudonymization.';
COMMENT ON COLUMN hr.employee.legal_last_name        IS 'Legal family name. PII. Overwritten on pseudonymization.';
COMMENT ON COLUMN hr.employee.date_of_birth          IS 'Date of birth. Sensitive-PII (age/identity). Column-restrict + encrypt-at-rest.';
COMMENT ON COLUMN hr.employee.national_id_enc        IS 'Encrypted national identifier (SSN/NI/etc.) via pgcrypto pgp_sym_encrypt; key from KMS, never stored in DB. Sensitive-PII. NEVER plaintext.';
COMMENT ON COLUMN hr.employee.national_id_hash       IS 'Keyed HMAC of the national id for dedupe/lookup without decryption. Non-reversible.';
COMMENT ON COLUMN hr.employee.national_id_country    IS 'Issuing country of the national id (core.country.iso2), used to interpret format.';
COMMENT ON COLUMN hr.employee.personal_email         IS 'Personal email. PII. Overwritten on pseudonymization.';
COMMENT ON COLUMN hr.employee.phone                  IS 'Personal phone number. PII.';
COMMENT ON COLUMN hr.employee.address_line1          IS 'Home street address. PII. Candidate for column-level encryption.';
COMMENT ON COLUMN hr.employee.bank_account_token     IS 'External-processor token for payout. NOT a bank account number. Raw account/IBAN is NEVER stored (keeps DB out of sensitive payment scope).';
COMMENT ON COLUMN hr.employee.bank_account_last4     IS 'Last 4 digits for display/verification only.';
COMMENT ON COLUMN hr.employee.bank_account_processor IS 'Tokenization provider name (e.g. stripe, wise).';
COMMENT ON COLUMN hr.employee.pseudonymized_at       IS 'Set when GDPR/CCPA erasure has overwritten PII (name/email/address/national_id) with placeholders. Preserves FKs and working-time aggregates.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_org_number_live
    ON hr.employee (organization_id, employee_number) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_org_nid_hash_live
    ON hr.employee (organization_id, national_id_hash)
    WHERE national_id_hash IS NOT NULL AND deleted_at IS NULL AND pseudonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_employee_org      ON hr.employee (organization_id);
CREATE INDEX IF NOT EXISTS ix_employee_app_user ON hr.employee (app_user_id);
CREATE INDEX IF NOT EXISTS ix_employee_lastname ON hr.employee (organization_id, legal_last_name);

DROP TRIGGER IF EXISTS trg_employee_set_updated_at ON hr.employee;
CREATE TRIGGER trg_employee_set_updated_at
    BEFORE UPDATE ON hr.employee
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_employee ON hr.employee;
CREATE TRIGGER zzz_audit_employee
    AFTER INSERT OR UPDATE OR DELETE ON hr.employee
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified(
        'national_id_enc,national_id_hash,bank_account_token,date_of_birth,address_line1,address_line2,address_postal_code'
    );

-- ---------------------------------------------------------------------
-- 4. hr.employment -- time-bounded person<->position/dept assignment.
--    Carries the MANAGER hierarchy (self-FK manager_employment_id).
--    A person may have multiple employments over time (rehire, transfer).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.employment (
    id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id       bigint      NOT NULL,
    employee_id           bigint      NOT NULL,
    position_id           bigint      NOT NULL,
    department_id         bigint      NOT NULL,
    manager_employment_id bigint      NULL,
    employment_type       hr.employment_type   NOT NULL,
    status                hr.employment_status NOT NULL DEFAULT 'active',
    is_primary            boolean     NOT NULL DEFAULT true,
    fte                   numeric(4,3) NOT NULL DEFAULT 1.000,
    start_date            date        NOT NULL,
    end_date              date        NULL,
    work_location         text        NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid        NULL,
    updated_by            uuid        NULL,
    deleted_at            timestamptz NULL,
    CONSTRAINT uq_employment_public_id UNIQUE (public_id),
    CONSTRAINT ck_employment_fte          CHECK (fte > 0 AND fte <= 1),
    CONSTRAINT ck_employment_dates        CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT ck_employment_not_self_mgr CHECK (manager_employment_id IS NULL OR manager_employment_id <> id),
    CONSTRAINT fk_employment_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_employment_employee FOREIGN KEY (employee_id)
        REFERENCES hr.employee(id) ON DELETE RESTRICT,
    CONSTRAINT fk_employment_position FOREIGN KEY (position_id)
        REFERENCES hr.position(id) ON DELETE RESTRICT,
    CONSTRAINT fk_employment_department FOREIGN KEY (department_id)
        REFERENCES hr.department(id) ON DELETE RESTRICT,
    CONSTRAINT fk_employment_manager FOREIGN KEY (manager_employment_id)
        REFERENCES hr.employment(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.employment IS 'Time-bounded assignment of an employee to a position + department, with reporting line. Multiple rows per employee over time (transfer/rehire). Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.employment.manager_employment_id IS 'Reporting line: the manager''s employment row (self-FK). NULL for top of hierarchy. SET NULL if the manager employment is removed.';
COMMENT ON COLUMN hr.employment.is_primary  IS 'TRUE for the employee''s primary concurrent engagement. Enforced unique among live, non-terminated primary rows per employee.';
COMMENT ON COLUMN hr.employment.fte         IS 'Full-time equivalent 0<fte<=1 (e.g. 0.500 = half time). numeric, never float.';
COMMENT ON COLUMN hr.employment.start_date  IS 'Effective start of this assignment.';
COMMENT ON COLUMN hr.employment.end_date    IS 'Effective end (NULL = current/open).';

CREATE INDEX IF NOT EXISTS ix_employment_org        ON hr.employment (organization_id);
CREATE INDEX IF NOT EXISTS ix_employment_employee   ON hr.employment (employee_id);
CREATE INDEX IF NOT EXISTS ix_employment_position   ON hr.employment (position_id);
CREATE INDEX IF NOT EXISTS ix_employment_department ON hr.employment (department_id);
CREATE INDEX IF NOT EXISTS ix_employment_manager    ON hr.employment (manager_employment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employment_primary_live
    ON hr.employment (employee_id)
    WHERE is_primary AND deleted_at IS NULL AND status <> 'terminated';

DROP TRIGGER IF EXISTS trg_employment_set_updated_at ON hr.employment;
CREATE TRIGGER trg_employment_set_updated_at
    BEFORE UPDATE ON hr.employment
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_employment ON hr.employment;
CREATE TRIGGER zzz_audit_employment
    AFTER INSERT OR UPDATE OR DELETE ON hr.employment
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- Wire the forward-referenced department head FK now that hr.employment exists.
ALTER TABLE hr.department DROP CONSTRAINT IF EXISTS fk_department_head;
ALTER TABLE hr.department
    ADD CONSTRAINT fk_department_head FOREIGN KEY (head_employment_id)
        REFERENCES hr.employment(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_department_head ON hr.department (head_employment_id);

-- ---------------------------------------------------------------------
-- 5. hr.compensation -- effective-dated pay. salary AMOUNT is sensitive.
--    Money is numeric (never float) + currency_code -> core.currency.
--    amount_enc holds the encrypted exact figure; amount_band is a coarse,
--    less-sensitive value usable for reporting without exposing exact pay.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.compensation (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    employment_id   bigint       NOT NULL,
    pay_grade       text         NULL,
    pay_frequency   hr.pay_frequency NOT NULL,
    currency_code   char(3)      NOT NULL,
    amount_enc      bytea        NOT NULL,
    amount_band     text         NULL,
    effective_from  date         NOT NULL,
    effective_to    date         NULL,
    is_current      boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_compensation_public_id UNIQUE (public_id),
    CONSTRAINT ck_compensation_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT fk_compensation_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_compensation_employment FOREIGN KEY (employment_id)
        REFERENCES hr.employment(id) ON DELETE CASCADE,
    CONSTRAINT fk_compensation_currency FOREIGN KEY (currency_code)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  hr.compensation IS 'Effective-dated compensation per employment. Exact amount is encrypted (numeric encoded then pgp_sym_encrypt -> bytea); currency from core.currency. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.compensation.amount_enc     IS 'Encrypted pay amount. Plaintext is numeric (never float); encrypted via pgcrypto pgp_sym_encrypt, key from KMS. Sensitive (financial). NEVER store plaintext salary.';
COMMENT ON COLUMN hr.compensation.amount_band    IS 'Optional coarse band (e.g. salary range) for reporting without exposing exact pay.';
COMMENT ON COLUMN hr.compensation.pay_grade      IS 'Pay grade/band label tied to the position level.';
COMMENT ON COLUMN hr.compensation.currency_code  IS 'ISO 4217 currency (core.currency.code). minor_unit governs rounding of the decrypted amount.';
COMMENT ON COLUMN hr.compensation.is_current     IS 'TRUE for the active compensation row. Unique among live, current rows per employment.';

CREATE INDEX IF NOT EXISTS ix_compensation_org        ON hr.compensation (organization_id);
CREATE INDEX IF NOT EXISTS ix_compensation_employment ON hr.compensation (employment_id, effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_compensation_current_live
    ON hr.compensation (employment_id)
    WHERE is_current AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_compensation_set_updated_at ON hr.compensation;
CREATE TRIGGER trg_compensation_set_updated_at
    BEFORE UPDATE ON hr.compensation
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_compensation ON hr.compensation;
CREATE TRIGGER zzz_audit_compensation
    AFTER INSERT OR UPDATE OR DELETE ON hr.compensation
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('amount_enc');

-- ---------------------------------------------------------------------
-- 6. hr.shift -- LOOKUP table of named shift templates (business-editable).
--    Lookup (not enum): editable at runtime, carries metadata (times,
--    unpaid-break minutes, color), joined for display.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.shift (
    id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id      bigint      NOT NULL,
    code                 citext      NOT NULL,
    name                 text        NOT NULL,
    start_time           time        NOT NULL,
    end_time             time        NOT NULL,
    crosses_midnight     boolean     NOT NULL DEFAULT false,
    unpaid_break_minutes integer     NOT NULL DEFAULT 0,
    color_hex            char(7)     NULL,
    is_active            boolean     NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    created_by           uuid        NULL,
    updated_by           uuid        NULL,
    deleted_at           timestamptz NULL,
    CONSTRAINT uq_shift_public_id UNIQUE (public_id),
    CONSTRAINT ck_shift_code  CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT ck_shift_break CHECK (unpaid_break_minutes >= 0 AND unpaid_break_minutes < 1440),
    CONSTRAINT ck_shift_color CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT fk_shift_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE  hr.shift IS 'Reusable shift template (LOOKUP: business-editable, carries times/break/color metadata). Times are local wall-clock templates; crosses_midnight flags overnight shifts. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.shift.crosses_midnight     IS 'TRUE when end_time <= start_time because the shift ends the next day.';
COMMENT ON COLUMN hr.shift.unpaid_break_minutes IS 'Minutes deducted as unpaid break when computing worked hours.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_org_code_live
    ON hr.shift (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_shift_org ON hr.shift (organization_id);

DROP TRIGGER IF EXISTS trg_shift_set_updated_at ON hr.shift;
CREATE TRIGGER trg_shift_set_updated_at
    BEFORE UPDATE ON hr.shift
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_shift ON hr.shift;
CREATE TRIGGER zzz_audit_shift
    AFTER INSERT OR UPDATE OR DELETE ON hr.shift
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 7. hr.timesheet -- a period (e.g. weekly) container per employment.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.timesheet (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    employment_id   bigint       NOT NULL,
    period_start    date         NOT NULL,
    period_end      date         NOT NULL,
    status          hr.timesheet_status NOT NULL DEFAULT 'open',
    total_hours     numeric(7,2) NOT NULL DEFAULT 0,
    submitted_at    timestamptz  NULL,
    approved_at     timestamptz  NULL,
    approved_by_employment_id bigint NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_timesheet_public_id UNIQUE (public_id),
    CONSTRAINT ck_timesheet_period CHECK (period_end >= period_start),
    CONSTRAINT ck_timesheet_total  CHECK (total_hours >= 0),
    CONSTRAINT fk_timesheet_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_timesheet_employment FOREIGN KEY (employment_id)
        REFERENCES hr.employment(id) ON DELETE CASCADE,
    CONSTRAINT fk_timesheet_approver FOREIGN KEY (approved_by_employment_id)
        REFERENCES hr.employment(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.timesheet IS 'A time-recording period (e.g. weekly) for one employment, with approval workflow. total_hours is a denormalized numeric roll-up of its time_entry rows. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.timesheet.total_hours IS 'Sum of worked hours across child time_entry rows. numeric(7,2), never float.';

CREATE INDEX IF NOT EXISTS ix_timesheet_org        ON hr.timesheet (organization_id);
CREATE INDEX IF NOT EXISTS ix_timesheet_employment ON hr.timesheet (employment_id, period_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheet_emp_period_live
    ON hr.timesheet (employment_id, period_start) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_timesheet_set_updated_at ON hr.timesheet;
CREATE TRIGGER trg_timesheet_set_updated_at
    BEFORE UPDATE ON hr.timesheet
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_timesheet ON hr.timesheet;
CREATE TRIGGER zzz_audit_timesheet
    AFTER INSERT OR UPDATE OR DELETE ON hr.timesheet
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 8. hr.time_entry -- individual clock in/out within a timesheet.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.time_entry (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    timesheet_id    bigint       NOT NULL,
    employment_id   bigint       NOT NULL,
    shift_id        bigint       NULL,
    work_date       date         NOT NULL,
    clock_in        timestamptz  NOT NULL,
    clock_out       timestamptz  NULL,
    break_minutes   integer      NOT NULL DEFAULT 0,
    worked_hours    numeric(7,2) GENERATED ALWAYS AS (
        CASE WHEN clock_out IS NULL THEN 0
             ELSE round((EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600.0)::numeric
                        - (break_minutes::numeric / 60.0), 2)
        END
    ) STORED,
    source          hr.time_entry_source NOT NULL DEFAULT 'web',
    note            text         NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_time_entry_public_id UNIQUE (public_id),
    CONSTRAINT ck_time_entry_break CHECK (break_minutes >= 0 AND break_minutes < 1440),
    CONSTRAINT ck_time_entry_span  CHECK (clock_out IS NULL OR clock_out >= clock_in),
    CONSTRAINT fk_time_entry_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_time_entry_timesheet FOREIGN KEY (timesheet_id)
        REFERENCES hr.timesheet(id) ON DELETE CASCADE,
    CONSTRAINT fk_time_entry_employment FOREIGN KEY (employment_id)
        REFERENCES hr.employment(id) ON DELETE CASCADE,
    CONSTRAINT fk_time_entry_shift FOREIGN KEY (shift_id)
        REFERENCES hr.shift(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.time_entry IS 'A single clock in/out punch belonging to a timesheet. clock_in/out are absolute timestamptz instants. worked_hours is a STORED generated column (numeric). Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.time_entry.employment_id IS 'Denormalized from the parent timesheet so RLS/queries need no join.';
COMMENT ON COLUMN hr.time_entry.clock_in      IS 'Absolute instant of clock-in (timestamptz). Never store local wall time.';
COMMENT ON COLUMN hr.time_entry.clock_out     IS 'Absolute instant of clock-out; NULL = open/in-progress punch.';
COMMENT ON COLUMN hr.time_entry.worked_hours  IS 'Generated: (clock_out-clock_in) hours minus break, rounded to 2 dp. numeric, never float. 0 while punch open.';
COMMENT ON COLUMN hr.time_entry.source        IS 'Capture channel (web/mobile/kiosk/biometric/badge/import/manual).';

CREATE INDEX IF NOT EXISTS ix_time_entry_org        ON hr.time_entry (organization_id);
CREATE INDEX IF NOT EXISTS ix_time_entry_timesheet  ON hr.time_entry (timesheet_id);
CREATE INDEX IF NOT EXISTS ix_time_entry_employment ON hr.time_entry (employment_id, work_date);
CREATE INDEX IF NOT EXISTS ix_time_entry_shift      ON hr.time_entry (shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_entry_open_punch_live
    ON hr.time_entry (employment_id)
    WHERE clock_out IS NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_time_entry_set_updated_at ON hr.time_entry;
CREATE TRIGGER trg_time_entry_set_updated_at
    BEFORE UPDATE ON hr.time_entry
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_time_entry ON hr.time_entry;
CREATE TRIGGER zzz_audit_time_entry
    AFTER INSERT OR UPDATE OR DELETE ON hr.time_entry
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 9. hr.attendance -- per-day attendance outcome per employment.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.attendance (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    employment_id   bigint       NOT NULL,
    shift_id        bigint       NULL,
    work_date       date         NOT NULL,
    status          hr.attendance_status NOT NULL,
    expected_hours  numeric(5,2) NOT NULL DEFAULT 0,
    actual_hours    numeric(5,2) NOT NULL DEFAULT 0,
    late_minutes    integer      NOT NULL DEFAULT 0,
    note            text         NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_attendance_public_id UNIQUE (public_id),
    CONSTRAINT ck_attendance_hours CHECK (expected_hours >= 0 AND actual_hours >= 0),
    CONSTRAINT ck_attendance_late  CHECK (late_minutes >= 0),
    CONSTRAINT fk_attendance_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_employment FOREIGN KEY (employment_id)
        REFERENCES hr.employment(id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_shift FOREIGN KEY (shift_id)
        REFERENCES hr.shift(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.attendance IS 'Daily attendance outcome per employment (present/absent/late/...). One row per employment per day. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.attendance.expected_hours IS 'Scheduled hours for the day. numeric, never float.';
COMMENT ON COLUMN hr.attendance.actual_hours   IS 'Recorded worked hours for the day. numeric, never float.';

CREATE INDEX IF NOT EXISTS ix_attendance_org        ON hr.attendance (organization_id);
CREATE INDEX IF NOT EXISTS ix_attendance_employment ON hr.attendance (employment_id, work_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_emp_day_live
    ON hr.attendance (employment_id, work_date) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_attendance_set_updated_at ON hr.attendance;
CREATE TRIGGER trg_attendance_set_updated_at
    BEFORE UPDATE ON hr.attendance
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_attendance ON hr.attendance;
CREATE TRIGGER zzz_audit_attendance
    AFTER INSERT OR UPDATE OR DELETE ON hr.attendance
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 10. hr.leave_type -- LOOKUP of leave categories (business-editable).
--     Lookup (not enum): tenants add/rename types, need paid/accrual
--     metadata, joined for display.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.leave_type (
    id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id   bigint       NOT NULL,
    code              citext       NOT NULL,
    name              text         NOT NULL,
    description       text         NULL,
    is_paid           boolean      NOT NULL DEFAULT true,
    affects_accrual   boolean      NOT NULL DEFAULT true,
    requires_approval boolean      NOT NULL DEFAULT true,
    sort_order        integer      NOT NULL DEFAULT 0,
    is_active         boolean      NOT NULL DEFAULT true,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        uuid         NULL,
    updated_by        uuid         NULL,
    deleted_at        timestamptz  NULL,
    CONSTRAINT uq_leave_type_public_id UNIQUE (public_id),
    CONSTRAINT ck_leave_type_code CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT fk_leave_type_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE  hr.leave_type IS 'Leave/absence category (LOOKUP: business-editable, carries paid/accrual/approval metadata, joined for display). Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.leave_type.affects_accrual IS 'Whether taking this leave consumes an accrual balance.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_type_org_code_live
    ON hr.leave_type (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_leave_type_org ON hr.leave_type (organization_id);

DROP TRIGGER IF EXISTS trg_leave_type_set_updated_at ON hr.leave_type;
CREATE TRIGGER trg_leave_type_set_updated_at
    BEFORE UPDATE ON hr.leave_type
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_leave_type ON hr.leave_type;
CREATE TRIGGER zzz_audit_leave_type
    AFTER INSERT OR UPDATE OR DELETE ON hr.leave_type
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 11. hr.leave_request -- absence request + approval (per employment).
--     reason may contain personal context; medical_note is special-category
--     (health) PII -> encrypted.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr.leave_request (
    id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id   bigint       NOT NULL,
    employment_id     bigint       NOT NULL,
    leave_type_id     bigint       NOT NULL,
    status            hr.leave_request_status NOT NULL DEFAULT 'draft',
    start_date        date         NOT NULL,
    end_date          date         NOT NULL,
    is_half_day       boolean      NOT NULL DEFAULT false,
    total_days        numeric(5,2) NOT NULL,
    reason            text         NULL,
    medical_note_enc  bytea        NULL,
    reviewed_by_employment_id bigint NULL,
    reviewed_at       timestamptz  NULL,
    decision_note     text         NULL,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now(),
    created_by        uuid         NULL,
    updated_by        uuid         NULL,
    deleted_at        timestamptz  NULL,
    CONSTRAINT uq_leave_request_public_id UNIQUE (public_id),
    CONSTRAINT ck_leave_request_dates CHECK (end_date >= start_date),
    CONSTRAINT ck_leave_request_days  CHECK (total_days > 0),
    CONSTRAINT fk_leave_request_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_leave_request_employment FOREIGN KEY (employment_id)
        REFERENCES hr.employment(id) ON DELETE CASCADE,
    CONSTRAINT fk_leave_request_type FOREIGN KEY (leave_type_id)
        REFERENCES hr.leave_type(id) ON DELETE RESTRICT,
    CONSTRAINT fk_leave_request_reviewer FOREIGN KEY (reviewed_by_employment_id)
        REFERENCES hr.employment(id) ON DELETE SET NULL
);
COMMENT ON TABLE  hr.leave_request IS 'Leave/absence request per employment with approval workflow. medical_note is special-category (health) PII -> encrypted. Tenant-scoped + RLS.';
COMMENT ON COLUMN hr.leave_request.total_days       IS 'Requested duration in days (supports halves). numeric, never float.';
COMMENT ON COLUMN hr.leave_request.reason           IS 'Free-text reason. May contain personal context; treat as PII.';
COMMENT ON COLUMN hr.leave_request.medical_note_enc IS 'Encrypted medical/health note (special-category PII). pgcrypto pgp_sym_encrypt; key from KMS. Sensitive-PII.';

CREATE INDEX IF NOT EXISTS ix_leave_request_org        ON hr.leave_request (organization_id);
CREATE INDEX IF NOT EXISTS ix_leave_request_employment ON hr.leave_request (employment_id, start_date DESC);
CREATE INDEX IF NOT EXISTS ix_leave_request_type       ON hr.leave_request (leave_type_id);
CREATE INDEX IF NOT EXISTS ix_leave_request_status     ON hr.leave_request (organization_id, status);

DROP TRIGGER IF EXISTS trg_leave_request_set_updated_at ON hr.leave_request;
CREATE TRIGGER trg_leave_request_set_updated_at
    BEFORE UPDATE ON hr.leave_request
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS zzz_audit_leave_request ON hr.leave_request;
CREATE TRIGGER zzz_audit_leave_request
    AFTER INSERT OR UPDATE OR DELETE ON hr.leave_request
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('medical_note_enc');

-- ---------------------------------------------------------------------
-- 12. ROW-LEVEL SECURITY (tenant isolation) -- every hr table.
-- ---------------------------------------------------------------------
ALTER TABLE hr.department     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.position       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employment     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.compensation   ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.shift          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.timesheet      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.time_entry     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.attendance     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_type     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_request  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department','position','employee','employment','compensation',
                           'shift','timesheet','time_entry','attendance','leave_type','leave_request'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_isolation ON hr.%1$s;', t);
    EXECUTE format(
      'CREATE POLICY rls_%1$s_isolation ON hr.%1$s '
      'USING (organization_id = core.current_organization_id()) '
      'WITH CHECK (organization_id = core.current_organization_id());', t);
  END LOOP;
END$$;

-- ---------------------------------------------------------------------
-- 13. GRANTS (least privilege). Soft-delete only -> no DELETE to app roles.
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA hr TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA hr TO app_readwrite;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA hr
    GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA hr
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_readwrite;

-- =====================================================================
-- END HR DOMAIN SCHEMA
-- =====================================================================