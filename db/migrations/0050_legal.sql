-- =====================================================================
-- AAA_Database :: LEGAL DOMAIN DDL
-- Target: PostgreSQL 16+
-- Depends on FOUNDATION DDL (schemas, core.*, audit.*, roles) AND the
-- invoicing domain (invoicing.invoice) being loaded first. A separate
-- holistic migration run loads all schemas together; FKs into core.* and
-- invoicing.invoice(id) are treated as known-good and simply declared.
--
-- Scope: customer deal agreements / contracts (CONFIDENTIAL: commercial
-- terms + PII). The agreement FILE ITSELF lives in encrypted OBJECT
-- STORAGE (S3/GCS/Azure Blob). This schema stores ONLY metadata, a storage
-- reference, and an integrity hash -- NEVER the file bytes (no bytea blob).
--   * legal.agreement              -- contract header + lifecycle + legal hold
--   * legal.agreement_version      -- amendment/renewal history (self-FK)
--   * legal.agreement_document     -- storage pointer + sha256 tamper-evidence
--   * legal.signatory              -- signer PII + e-sign status
--   * legal.agreement_party        -- buyer/seller/witness; LOOSE crm link
--   * legal.agreement_link         -- REAL FK to invoicing.invoice + loose deal
--   * legal.agreement_access_log   -- who VIEWED/DOWNLOADED a document, when
--   * legal.agreement_type         -- LOOKUP (business-extensible: MSA/SOW/NDA/...)
--
-- Conventions followed EXACTLY (see Foundation Conventions, NORMATIVE):
--   * Dual key: bigint GENERATED ALWAYS AS IDENTITY surrogate + public_id uuid.
--   * Standard columns + organization_id on EVERY tenant-scoped table.
--   * snake_case, singular table names, no domain prefix on table names.
--   * timestamptz everywhere; numeric(p,s) for money; currency_code -> core.currency.
--   * set_updated_at + zzz_audit triggers; RLS tenant isolation with WITH CHECK.
--   * Soft delete (deleted_at) + partial unique indexes (_live) for value reuse.
--   * PII tables carry pseudonymized_at; PII redacted from audit images.
--   * No FK INTO crm (read-only mirror) or audit; FKs INTO core/invoicing OK.
--   * NO raw payment/bank data anywhere; the file itself is never stored here.
--
-- LITIGATION HOLD OVERRIDE: when legal_hold = true, the agreement and its
-- documents MUST survive retention purge AND GDPR erasure. Because the only
-- actor strong enough to hard-delete is the BYPASSRLS migrator/purge job,
-- the rule is enforced by BEFORE DELETE guard triggers (below) that raise on
-- held rows -- DDL CHECKs alone cannot stop a DELETE. See section 10.
--
-- Idempotent: CREATE ... IF NOT EXISTS / DROP TRIGGER IF EXISTS / guarded DO blocks.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. ENUM TYPES vs LOOKUP -- decisions for the legal domain
-- ---------------------------------------------------------------------
-- DECISION SUMMARY:
--   * agreement.status        -> ENUM (legal.agreement_status). Closed contract
--       lifecycle (draft/in_review/active/expired/terminated/superseded) wired
--       into state-machine + retention logic. New states require migration +
--       code. No per-row metadata. => native enum (explicitly required).
--   * agreement_type          -> LOOKUP TABLE (legal.agreement_type). The set
--       (MSA, SOW, NDA, order form, ...) is business-extensible, carries display
--       metadata (label, description, sort_order, is_active) and is joined for
--       display. "A non-engineer might ask to add a value." => lookup table
--       (explicitly required).
--   * agreement_party.party_role     -> ENUM (legal.party_role: buyer/seller/
--       witness). Tiny closed set, no metadata. => enum.
--   * signatory.party_side           -> ENUM (legal.party_side: internal/
--       counterparty/third_party). Closed, code-coupled. => enum.
--   * signatory.esign_status         -> ENUM (legal.esign_status). Closed e-sign
--       lifecycle mirrored from the provider's fixed states. => enum.
--   * agreement_document.document_kind -> ENUM (legal.document_kind). Closed
--       classification of the stored artifact. => enum.
--   * agreement_access_log.access_action -> ENUM (legal.access_action: viewed/
--       downloaded). Closed audit verb set. => enum.
--   * agreement_link.target_type     -> ENUM (legal.link_target_type). Closed
--       set of associable record kinds. => enum.
--   * agreement.renewal_term_unit    -> ENUM (legal.renewal_term_unit: day/week/
--       month/year). Closed calendar unit set. => enum.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'agreement_status' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.agreement_status AS ENUM
      ('draft', 'in_review', 'active', 'expired', 'terminated', 'superseded');
  END IF;
END
$$;
COMMENT ON TYPE legal.agreement_status IS 'Contract lifecycle state. Closed set driving the agreement state machine + retention rules -- enum, not lookup. superseded => replaced by a newer agreement/version.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'renewal_term_unit' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.renewal_term_unit AS ENUM ('day', 'week', 'month', 'year');
  END IF;
END
$$;
COMMENT ON TYPE legal.renewal_term_unit IS 'Calendar unit for an auto-renewal term length (e.g. 12 month). Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'party_role' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.party_role AS ENUM ('buyer', 'seller', 'witness');
  END IF;
END
$$;
COMMENT ON TYPE legal.party_role IS 'Role a party plays on an agreement: buyer, seller, witness. Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'party_side' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.party_side AS ENUM ('internal', 'counterparty', 'third_party');
  END IF;
END
$$;
COMMENT ON TYPE legal.party_side IS 'Which side of the deal a signatory represents: internal (our org), counterparty (the customer), or third_party (e.g. a witness/guarantor). Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'esign_status' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.esign_status AS ENUM
      ('not_sent', 'sent', 'viewed', 'signed', 'declined', 'expired', 'voided');
  END IF;
END
$$;
COMMENT ON TYPE legal.esign_status IS 'E-signature lifecycle for a single signatory, mirrored from the e-sign provider (DocuSign/Adobe Sign/etc.). Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'document_kind' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.document_kind AS ENUM
      ('original', 'amendment', 'renewal', 'exhibit', 'signed_copy', 'supporting');
  END IF;
END
$$;
COMMENT ON TYPE legal.document_kind IS 'Classification of a stored agreement artifact. Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'access_action' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.access_action AS ENUM ('viewed', 'downloaded');
  END IF;
END
$$;
COMMENT ON TYPE legal.access_action IS 'Confidential-document access verb recorded in the access log: viewed (metadata/preview) or downloaded (bytes fetched from storage). Closed set -- enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'link_target_type' AND n.nspname = 'legal') THEN
    CREATE TYPE legal.link_target_type AS ENUM ('invoice', 'deal');
  END IF;
END
$$;
COMMENT ON TYPE legal.link_target_type IS 'Kind of record an agreement_link associates: invoice (REAL FK to invoicing.invoice) or deal (LOOSE hubspot_deal_id, no FK -- crm is a read-only mirror). Closed set -- enum.';

-- ---------------------------------------------------------------------
-- 1. legal.agreement_type -- LOOKUP (business-extensible agreement kinds)
-- ---------------------------------------------------------------------
-- Tenant-scoped lookup: each org curates its own catalogue of agreement
-- types (MSA, SOW, NDA, order form, DPA, ...). Dual-key kept because it is an
-- entity admins extend operationally and carries display metadata.
CREATE TABLE IF NOT EXISTS legal.agreement_type (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    code            citext       NOT NULL,                  -- tenant-stable machine code: 'msa','sow','nda','order_form'
    name            text         NOT NULL,                  -- display label
    description     text         NULL,
    sort_order      integer      NOT NULL DEFAULT 0,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_agreement_type_public_id UNIQUE (public_id),
    CONSTRAINT ck_agreement_type_code CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT fk_agreement_type_org  FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE  legal.agreement_type IS 'Business-extensible catalogue of agreement kinds (MSA, SOW, NDA, order form, ...). Lookup table (not enum): editable by business users, carries display metadata, joined for display. Tenant-scoped so each org curates its own list. is_active disables a type without deletion.';
COMMENT ON COLUMN legal.agreement_type.code      IS 'Stable machine code, e.g. msa/sow/nda/order_form. Lowercase, unique per organization among live rows.';
COMMENT ON COLUMN legal.agreement_type.public_id IS 'Externally exposed UUID. Internal joins use id.';

-- code unique per tenant among live rows (soft-deleted codes can be reused).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_type_org_code_live
    ON legal.agreement_type (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_agreement_type_org ON legal.agreement_type (organization_id);

DROP TRIGGER IF EXISTS trg_agreement_type_set_updated_at ON legal.agreement_type;
CREATE TRIGGER trg_agreement_type_set_updated_at
    BEFORE UPDATE ON legal.agreement_type
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_agreement_type ON legal.agreement_type;
CREATE TRIGGER zzz_audit_agreement_type
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement_type
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 2. legal.agreement -- contract header (commercial terms + legal hold)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal.agreement (
    id                  bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint        NOT NULL,
    agreement_type_id   bigint        NOT NULL,             -- FK -> agreement_type (lookup)
    -- Human-facing reference + title. agreement_number is a tenant-unique
    -- business reference; title is the contract's display name (CONFIDENTIAL).
    agreement_number    citext        NOT NULL,
    title               text          NOT NULL,
    status              legal.agreement_status NOT NULL DEFAULT 'draft',
    -- Term.
    effective_date      date          NULL,
    expiry_date         date          NULL,
    auto_renew          boolean       NOT NULL DEFAULT false,
    renewal_term_length integer       NULL,                 -- e.g. 12 (with unit below)
    renewal_term_unit   legal.renewal_term_unit NULL,       -- day/week/month/year
    -- Commercial value. Money => numeric(18,4), NEVER float. currency required
    -- whenever a value is present; scale carries via core.currency.minor_unit.
    contract_value      numeric(18,4) NULL,
    currency_code       char(3)       NULL,                 -- FK -> core.currency(code)
    governing_law       text          NULL,                 -- e.g. 'State of Delaware, USA'
    -- LITIGATION / LEGAL HOLD. When true, this agreement + its documents must
    -- survive retention purge AND GDPR erasure (enforced by guard triggers, s.10).
    legal_hold          boolean       NOT NULL DEFAULT false,
    legal_hold_reason   text          NULL,
    legal_hold_set_at   timestamptz   NULL,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    created_by          uuid          NULL,
    updated_by          uuid          NULL,
    deleted_at          timestamptz   NULL,
    CONSTRAINT uq_agreement_public_id UNIQUE (public_id),
    CONSTRAINT ck_agreement_number CHECK (length(agreement_number) BETWEEN 1 AND 64),
    CONSTRAINT ck_agreement_title  CHECK (length(btrim(title)) > 0),
    -- expiry must not precede effective.
    CONSTRAINT ck_agreement_dates  CHECK (expiry_date IS NULL OR effective_date IS NULL OR expiry_date >= effective_date),
    -- money non-negative; currency mandatory when a value is set.
    CONSTRAINT ck_agreement_value_nonneg   CHECK (contract_value IS NULL OR contract_value >= 0),
    CONSTRAINT ck_agreement_value_currency CHECK (contract_value IS NULL OR currency_code IS NOT NULL),
    -- renewal term length + unit travel together, and only make sense if auto_renew.
    CONSTRAINT ck_agreement_renewal_pair CHECK (
        (renewal_term_length IS NULL AND renewal_term_unit IS NULL)
     OR (renewal_term_length IS NOT NULL AND renewal_term_unit IS NOT NULL AND renewal_term_length > 0)
    ),
    CONSTRAINT ck_agreement_renewal_requires_auto CHECK (
        renewal_term_length IS NULL OR auto_renew = true
    ),
    -- legal-hold metadata travels together: a reason + timestamp exist iff held.
    CONSTRAINT ck_agreement_legal_hold_meta CHECK (
        (legal_hold = false AND legal_hold_reason IS NULL AND legal_hold_set_at IS NULL)
     OR (legal_hold = true  AND legal_hold_set_at IS NOT NULL)
    ),
    CONSTRAINT fk_agreement_org      FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_type     FOREIGN KEY (agreement_type_id)
        REFERENCES legal.agreement_type(id) ON DELETE RESTRICT,
    CONSTRAINT fk_agreement_currency FOREIGN KEY (currency_code)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  legal.agreement IS 'Customer deal agreement / contract header. CONFIDENTIAL: holds commercial terms (contract_value) and links to PII signatories/parties. The agreement FILE lives in object storage; this row is metadata only. When legal_hold = true the row and its documents are protected from retention purge AND GDPR erasure by BEFORE DELETE guard triggers (s.10).';
COMMENT ON COLUMN legal.agreement.agreement_number  IS 'Tenant business reference for the contract. Unique per organization among live rows.';
COMMENT ON COLUMN legal.agreement.title             IS 'Contract display title. CONFIDENTIAL commercial information.';
COMMENT ON COLUMN legal.agreement.status            IS 'Lifecycle state (enum). Drives renewal/expiry automation and retention eligibility.';
COMMENT ON COLUMN legal.agreement.contract_value    IS 'Total contract value (numeric(18,4), never float). CONFIDENTIAL commercial figure; requires currency_code. Redacted from audit images.';
COMMENT ON COLUMN legal.agreement.governing_law     IS 'Governing-law clause text (jurisdiction). Confidential commercial term.';
COMMENT ON COLUMN legal.agreement.auto_renew        IS 'TRUE if the contract auto-renews; renewal_term_length + renewal_term_unit then define the rollover period.';
COMMENT ON COLUMN legal.agreement.legal_hold        IS 'Litigation hold flag. TRUE => agreement + documents MUST survive retention purge AND GDPR erasure (litigation hold overrides auto-deletion). Enforced by guard triggers, not just CHECKs.';
COMMENT ON COLUMN legal.agreement.legal_hold_reason IS 'Why the hold was placed (matter/case reference). Confidential.';
COMMENT ON COLUMN legal.agreement.legal_hold_set_at IS 'When the legal hold was placed. Present whenever legal_hold = true.';

-- agreement_number unique per tenant among live rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_org_number_live
    ON legal.agreement (organization_id, agreement_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_agreement_org    ON legal.agreement (organization_id);
CREATE INDEX IF NOT EXISTS ix_agreement_type   ON legal.agreement (agreement_type_id);
-- Lifecycle dashboards: filter by status within a tenant.
CREATE INDEX IF NOT EXISTS ix_agreement_status ON legal.agreement (organization_id, status) WHERE deleted_at IS NULL;
-- Renewal/expiry sweep: find active agreements expiring soon.
CREATE INDEX IF NOT EXISTS ix_agreement_expiry ON legal.agreement (organization_id, expiry_date)
    WHERE deleted_at IS NULL AND expiry_date IS NOT NULL;
-- Fast lookup of all rows currently under legal hold (purge/erasure exclusion).
CREATE INDEX IF NOT EXISTS ix_agreement_legal_hold ON legal.agreement (organization_id)
    WHERE legal_hold = true;

DROP TRIGGER IF EXISTS trg_agreement_set_updated_at ON legal.agreement;
CREATE TRIGGER trg_agreement_set_updated_at
    BEFORE UPDATE ON legal.agreement
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- contract_value + legal_hold_reason are confidential -> redact from audit images.
DROP TRIGGER IF EXISTS zzz_audit_agreement ON legal.agreement;
CREATE TRIGGER zzz_audit_agreement
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('contract_value,legal_hold_reason');

-- ---------------------------------------------------------------------
-- 3. legal.agreement_version -- amendment / renewal history (self-FK)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal.agreement_version (
    id                   bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id            uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id      bigint       NOT NULL,             -- denormalized for single-predicate RLS
    agreement_id         bigint       NOT NULL,             -- FK -> agreement
    version_no           integer      NOT NULL,             -- 1-based, monotonic within an agreement
    supersedes_version_id bigint      NULL,                 -- self-FK -> the version this one replaces
    change_summary       text         NULL,                 -- what changed in this amendment/renewal
    -- Optional effective window for this specific version (amendments may re-date).
    effective_date       date         NULL,
    created_at           timestamptz  NOT NULL DEFAULT now(),
    updated_at           timestamptz  NOT NULL DEFAULT now(),
    created_by           uuid         NULL,
    updated_by           uuid         NULL,
    deleted_at           timestamptz  NULL,
    CONSTRAINT uq_agreement_version_public_id UNIQUE (public_id),
    CONSTRAINT ck_agreement_version_no_pos CHECK (version_no > 0),
    CONSTRAINT ck_agreement_version_no_self CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> id),
    CONSTRAINT fk_agreement_version_org    FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_version_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_version_supersedes FOREIGN KEY (supersedes_version_id)
        REFERENCES legal.agreement_version(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  legal.agreement_version IS 'Amendment/renewal history for an agreement. version_no is monotonic within an agreement; supersedes_version_id is a self-reference to the prior version this one replaces (chain of amendments). organization_id denormalized for single-predicate RLS.';
COMMENT ON COLUMN legal.agreement_version.version_no            IS 'Monotonic version number within the parent agreement. Unique per agreement among live rows.';
COMMENT ON COLUMN legal.agreement_version.supersedes_version_id IS 'Self-FK to the version this one supersedes (NULL for the first version). Application enforces same-agreement chain.';
COMMENT ON COLUMN legal.agreement_version.change_summary        IS 'Human summary of what this amendment/renewal changed. May reference confidential terms.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_version_agreement_no_live
    ON legal.agreement_version (agreement_id, version_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_agreement_version_org        ON legal.agreement_version (organization_id);
CREATE INDEX IF NOT EXISTS ix_agreement_version_agreement  ON legal.agreement_version (agreement_id);
CREATE INDEX IF NOT EXISTS ix_agreement_version_supersedes ON legal.agreement_version (supersedes_version_id)
    WHERE supersedes_version_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agreement_version_set_updated_at ON legal.agreement_version;
CREATE TRIGGER trg_agreement_version_set_updated_at
    BEFORE UPDATE ON legal.agreement_version
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_agreement_version ON legal.agreement_version;
CREATE TRIGGER zzz_audit_agreement_version
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement_version
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 4. legal.agreement_document -- storage pointer + integrity hash (NO bytea)
-- ---------------------------------------------------------------------
-- The file itself lives in encrypted object storage. This row stores ONLY the
-- pointer (provider/bucket/key), descriptive metadata, and a sha256 hash for
-- tamper-evidence. There is intentionally NO bytea/file column.
CREATE TABLE IF NOT EXISTS legal.agreement_document (
    id                   bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id            uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id      bigint        NOT NULL,            -- denormalized for RLS
    agreement_id         bigint        NOT NULL,            -- FK -> agreement
    agreement_version_id bigint        NULL,                -- FK -> agreement_version (which version this file is)
    document_kind        legal.document_kind NOT NULL DEFAULT 'original',
    -- Storage pointer (NOT the bytes).
    storage_provider     text          NOT NULL,            -- 's3' | 'gcs' | 'azure_blob'
    storage_bucket       text          NOT NULL,            -- bucket / container name
    storage_key          text          NOT NULL,            -- object key / path within the bucket
    -- Descriptive metadata.
    file_name            text          NOT NULL,            -- original uploaded filename
    content_type         text          NOT NULL,            -- MIME type, e.g. 'application/pdf'
    size_bytes           bigint        NOT NULL,            -- object size
    -- Tamper-evidence: SHA-256 of the object content (hex). NOT a secret; an
    -- integrity check. Lets us prove the stored file is unchanged.
    sha256_hash          char(64)      NOT NULL,
    uploaded_at          timestamptz   NOT NULL DEFAULT now(),
    uploaded_by          uuid          NULL,                -- app_user.public_id of uploader
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    created_by           uuid          NULL,
    updated_by           uuid          NULL,
    deleted_at           timestamptz   NULL,
    CONSTRAINT uq_agreement_document_public_id UNIQUE (public_id),
    CONSTRAINT ck_agreement_document_provider CHECK (storage_provider IN ('s3','gcs','azure_blob')),
    CONSTRAINT ck_agreement_document_bucket   CHECK (length(btrim(storage_bucket)) > 0),
    CONSTRAINT ck_agreement_document_key      CHECK (length(btrim(storage_key)) > 0),
    CONSTRAINT ck_agreement_document_filename CHECK (length(btrim(file_name)) > 0),
    CONSTRAINT ck_agreement_document_size     CHECK (size_bytes >= 0),
    -- sha256 hex: exactly 64 hex chars, lowercase-normalized.
    CONSTRAINT ck_agreement_document_sha256   CHECK (sha256_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT fk_agreement_document_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_document_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_document_version   FOREIGN KEY (agreement_version_id)
        REFERENCES legal.agreement_version(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  legal.agreement_document IS 'Metadata + storage pointer + integrity hash for a contract file held in encrypted object storage (S3/GCS/Azure Blob). NEVER stores the file bytes (no bytea column). sha256_hash provides tamper-evidence. When the parent agreement is under legal hold, these rows are protected from purge/erasure by a guard trigger (s.10).';
COMMENT ON COLUMN legal.agreement_document.storage_provider     IS 'Object-storage backend: s3 | gcs | azure_blob.';
COMMENT ON COLUMN legal.agreement_document.storage_bucket       IS 'Bucket/container holding the object. The bucket is encrypted at rest (infra responsibility).';
COMMENT ON COLUMN legal.agreement_document.storage_key          IS 'Object key/path within the bucket. Combined with provider+bucket it locates the encrypted file.';
COMMENT ON COLUMN legal.agreement_document.sha256_hash          IS 'Lowercase hex SHA-256 of the stored object for tamper-evidence (integrity, not a secret). Recompute on download and compare.';
COMMENT ON COLUMN legal.agreement_document.size_bytes           IS 'Object size in bytes (metadata; the bytes live in storage, not here).';
COMMENT ON COLUMN legal.agreement_document.uploaded_by          IS 'app_user.public_id (uuid) of the uploader. Audit-trail reference, survives surrogate concerns.';
COMMENT ON COLUMN legal.agreement_document.agreement_version_id IS 'Which agreement_version this file embodies (NULL if it pre-dates versioning). RESTRICT so a referenced version is not silently removed.';

CREATE INDEX IF NOT EXISTS ix_agreement_document_org       ON legal.agreement_document (organization_id);
CREATE INDEX IF NOT EXISTS ix_agreement_document_agreement ON legal.agreement_document (agreement_id);
CREATE INDEX IF NOT EXISTS ix_agreement_document_version   ON legal.agreement_document (agreement_version_id)
    WHERE agreement_version_id IS NOT NULL;
-- Integrity / dedup lookups by hash within a tenant.
CREATE INDEX IF NOT EXISTS ix_agreement_document_sha256    ON legal.agreement_document (organization_id, sha256_hash);
-- A given storage object should be pointed to once among live rows (guards
-- accidental duplicate registration of the same key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_document_object_live
    ON legal.agreement_document (storage_provider, storage_bucket, storage_key) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_agreement_document_set_updated_at ON legal.agreement_document;
CREATE TRIGGER trg_agreement_document_set_updated_at
    BEFORE UPDATE ON legal.agreement_document
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_agreement_document ON legal.agreement_document;
CREATE TRIGGER zzz_audit_agreement_document
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement_document
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 5. legal.signatory -- signer (PII) + e-sign status
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal.signatory (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id   bigint        NOT NULL,               -- denormalized for RLS
    agreement_id      bigint        NOT NULL,               -- FK -> agreement
    -- Signer identity. PERSONAL DATA (GDPR/CCPA) -> pseudonymized on erasure.
    signer_name       text          NULL,                   -- PII
    signer_email      citext        NULL,                   -- PII
    signer_title      text          NULL,                   -- job title at signing (low-sensitivity)
    party_side        legal.party_side NOT NULL,            -- internal / counterparty / third_party
    -- E-signature workflow.
    esign_provider    text          NULL,                   -- 'docusign' | 'adobe_sign' | 'hellosign' | ...
    esign_status      legal.esign_status NOT NULL DEFAULT 'not_sent',
    esign_envelope_id text          NULL,                   -- provider envelope/request id (loose ref)
    signed_at         timestamptz   NULL,                   -- when this signer completed signing
    signing_ip        inet          NULL,                   -- IP captured at signing (PII -- evidentiary)
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    created_by        uuid          NULL,
    updated_by        uuid          NULL,
    deleted_at        timestamptz   NULL,
    pseudonymized_at  timestamptz   NULL,                   -- GDPR erasure of signer PII
    CONSTRAINT uq_signatory_public_id UNIQUE (public_id),
    CONSTRAINT ck_signatory_email CHECK (signer_email IS NULL OR position('@' in signer_email) > 1),
    -- A completed signature must carry its timestamp. (We do not forbid a
    -- retained signed_at on later voided/expired states -- real e-sign flows
    -- can transition signed -> voided while keeping the historical sign time.)
    CONSTRAINT ck_signatory_signed_at CHECK (
        esign_status <> 'signed' OR signed_at IS NOT NULL
    ),
    CONSTRAINT fk_signatory_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_signatory_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE
);
COMMENT ON TABLE  legal.signatory IS 'A person who signs (or is asked to sign) an agreement. Holds signer PII (name/email/IP) and the per-signer e-sign lifecycle. PII is overwritten and pseudonymized_at set on GDPR/CCPA erasure, preserving the signing record without retaining personal data. PII columns are redacted from audit images.';
COMMENT ON COLUMN legal.signatory.signer_name       IS 'Signer full name. Personal data (PII). Pseudonymized on erasure.';
COMMENT ON COLUMN legal.signatory.signer_email      IS 'Signer email. Personal data (PII). Case-insensitive. Pseudonymized on erasure.';
COMMENT ON COLUMN legal.signatory.signer_title      IS 'Signer job title at time of signing. Low-sensitivity descriptor.';
COMMENT ON COLUMN legal.signatory.party_side        IS 'Which side the signer represents: internal / counterparty / third_party (enum).';
COMMENT ON COLUMN legal.signatory.esign_envelope_id IS 'Provider envelope/request id (DocuSign/Adobe Sign). Loose external reference, no FK.';
COMMENT ON COLUMN legal.signatory.signing_ip        IS 'IP address captured at signing for evidentiary purposes. Personal data -- restrict + redact in reporting; pseudonymized on erasure.';
COMMENT ON COLUMN legal.signatory.pseudonymized_at  IS 'Set when GDPR/CCPA erasure has overwritten signer PII (name/email/IP) while preserving the signature record.';

CREATE INDEX IF NOT EXISTS ix_signatory_org       ON legal.signatory (organization_id);
CREATE INDEX IF NOT EXISTS ix_signatory_agreement ON legal.signatory (agreement_id);
-- Find a signer by email within a tenant (only live, non-pseudonymized rows).
CREATE INDEX IF NOT EXISTS ix_signatory_email     ON legal.signatory (organization_id, signer_email)
    WHERE signer_email IS NOT NULL AND deleted_at IS NULL AND pseudonymized_at IS NULL;
-- E-sign chase list: outstanding signatures per tenant.
CREATE INDEX IF NOT EXISTS ix_signatory_esign_status ON legal.signatory (organization_id, esign_status)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_signatory_set_updated_at ON legal.signatory;
CREATE TRIGGER trg_signatory_set_updated_at
    BEFORE UPDATE ON legal.signatory
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Redact signer PII (name/email/IP) from audit change images.
DROP TRIGGER IF EXISTS zzz_audit_signatory ON legal.signatory;
CREATE TRIGGER zzz_audit_signatory
    AFTER INSERT OR UPDATE OR DELETE ON legal.signatory
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('signer_name,signer_email,signing_ip');

-- ---------------------------------------------------------------------
-- 6. legal.agreement_party -- buyer/seller/witness; LOOSE crm link (NO FK)
-- ---------------------------------------------------------------------
-- Associates an agreement with a customer represented in the HubSpot mirror.
-- crm is a READ-ONLY mirror whose rows can vanish on resync, so we store the
-- LOOSE hubspot_company_id / hubspot_contact_id text and resolve in the app --
-- NO FK into crm. A free-text party_name snapshot keeps the record legible even
-- if the mirror row is unavailable.
CREATE TABLE IF NOT EXISTS legal.agreement_party (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint       NOT NULL,               -- denormalized for RLS
    agreement_id       bigint       NOT NULL,               -- FK -> agreement
    party_role         legal.party_role NOT NULL,           -- buyer / seller / witness
    party_name         text         NULL,                   -- snapshot label (may be a company or person)
    -- LOOSE links into the crm HubSpot mirror -- NO FK (mirror rows are volatile).
    hubspot_company_id text         NULL,
    hubspot_contact_id text         NULL,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    created_by         uuid         NULL,
    updated_by         uuid         NULL,
    deleted_at         timestamptz  NULL,
    pseudonymized_at   timestamptz  NULL,                   -- party_name may be a person -> erasable
    CONSTRAINT uq_agreement_party_public_id UNIQUE (public_id),
    -- At least one identifier must be present so the party is resolvable.
    CONSTRAINT ck_agreement_party_identified CHECK (
        party_name IS NOT NULL OR hubspot_company_id IS NOT NULL OR hubspot_contact_id IS NOT NULL
    ),
    CONSTRAINT fk_agreement_party_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_party_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE
);
COMMENT ON TABLE  legal.agreement_party IS 'Parties to an agreement (buyer/seller/witness). Links to a customer in the HubSpot mirror via LOOSE hubspot_company_id / hubspot_contact_id text -- NO FK into crm (read-only mirror, rows can vanish on resync); resolved in the application. party_name is a snapshot label that stays legible if the mirror row is gone, and may itself be personal data (a named individual) -> pseudonymized_at.';
COMMENT ON COLUMN legal.agreement_party.party_role         IS 'Role on the agreement: buyer / seller / witness (enum).';
COMMENT ON COLUMN legal.agreement_party.party_name         IS 'Snapshot of the party label (company or person). If a named individual, this is personal data -> pseudonymized on erasure.';
COMMENT ON COLUMN legal.agreement_party.hubspot_company_id IS 'Loose reference to a crm HubSpot company mirror row. NOT a FK; resolved in the application.';
COMMENT ON COLUMN legal.agreement_party.hubspot_contact_id IS 'Loose reference to a crm HubSpot contact mirror row. NOT a FK; resolved in the application.';
COMMENT ON COLUMN legal.agreement_party.pseudonymized_at   IS 'Set when GDPR/CCPA erasure has overwritten a personal party_name while preserving the party relationship.';

CREATE INDEX IF NOT EXISTS ix_agreement_party_org       ON legal.agreement_party (organization_id);
CREATE INDEX IF NOT EXISTS ix_agreement_party_agreement ON legal.agreement_party (agreement_id);
CREATE INDEX IF NOT EXISTS ix_agreement_party_hs_company ON legal.agreement_party (hubspot_company_id)
    WHERE hubspot_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_agreement_party_hs_contact ON legal.agreement_party (hubspot_contact_id)
    WHERE hubspot_contact_id IS NOT NULL;
-- Prevent registering the SAME hubspot company/contact in the SAME role on the
-- SAME agreement twice (among live rows). NULL hubspot ids are distinct in PG,
-- so name-only/witness rows are intentionally not constrained by this index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_party_role_live
    ON legal.agreement_party (agreement_id, party_role, hubspot_company_id, hubspot_contact_id)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_agreement_party_set_updated_at ON legal.agreement_party;
CREATE TRIGGER trg_agreement_party_set_updated_at
    BEFORE UPDATE ON legal.agreement_party
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- party_name may be personal data -> redact from audit images.
DROP TRIGGER IF EXISTS zzz_audit_agreement_party ON legal.agreement_party;
CREATE TRIGGER zzz_audit_agreement_party
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement_party
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('party_name');

-- ---------------------------------------------------------------------
-- 7. legal.agreement_link -- REAL FK to invoicing.invoice + LOOSE deal link
-- ---------------------------------------------------------------------
-- Associates an agreement with another record. For invoices we use a REAL
-- cross-schema FK to invoicing.invoice(id) (invoicing is a first-class schema,
-- not a volatile mirror). For HubSpot deals we use a LOOSE hubspot_deal_id text
-- with NO FK (crm is a read-only mirror). target_type discriminates the two.
CREATE TABLE IF NOT EXISTS legal.agreement_link (
    id               bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id  bigint       NOT NULL,                 -- denormalized for RLS
    agreement_id     bigint       NOT NULL,                 -- FK -> agreement
    target_type      legal.link_target_type NOT NULL,       -- 'invoice' | 'deal'
    -- REAL FK target (only for target_type = 'invoice').
    invoice_id       bigint       NULL,                     -- FK -> invoicing.invoice(id)
    -- LOOSE target (only for target_type = 'deal') -- NO FK into crm.
    hubspot_deal_id  text         NULL,
    note             text         NULL,                     -- why the link exists
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    created_by       uuid         NULL,
    updated_by       uuid         NULL,
    deleted_at       timestamptz  NULL,
    CONSTRAINT uq_agreement_link_public_id UNIQUE (public_id),
    -- Exactly the right target column is populated for the discriminator.
    CONSTRAINT ck_agreement_link_target CHECK (
        (target_type = 'invoice' AND invoice_id IS NOT NULL AND hubspot_deal_id IS NULL)
     OR (target_type = 'deal'    AND hubspot_deal_id IS NOT NULL AND invoice_id IS NULL)
    ),
    CONSTRAINT fk_agreement_link_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_agreement_link_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE,
    -- REAL cross-schema FK into invoicing (known-good per validation policy).
    -- RESTRICT: don't let an invoice vanish out from under a contract linkage.
    CONSTRAINT fk_agreement_link_invoice   FOREIGN KEY (invoice_id)
        REFERENCES invoicing.invoice(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  legal.agreement_link IS 'Associates an agreement with another record. target_type discriminates: invoice => REAL FK to invoicing.invoice(id) (RESTRICT); deal => LOOSE hubspot_deal_id text with NO FK (crm is a read-only mirror, resolved in the app). Cross-domain links per spec: invoicing.invoice (real FK) and crm deals (loose id).';
COMMENT ON COLUMN legal.agreement_link.target_type     IS 'Discriminator: invoice (real FK) or deal (loose hubspot id).';
COMMENT ON COLUMN legal.agreement_link.invoice_id      IS 'REAL FK to invoicing.invoice(id) when target_type = invoice. RESTRICT on delete.';
COMMENT ON COLUMN legal.agreement_link.hubspot_deal_id IS 'Loose reference to a crm HubSpot deal mirror row when target_type = deal. NOT a FK; resolved in the application.';

CREATE INDEX IF NOT EXISTS ix_agreement_link_org       ON legal.agreement_link (organization_id);
CREATE INDEX IF NOT EXISTS ix_agreement_link_agreement ON legal.agreement_link (agreement_id);
CREATE INDEX IF NOT EXISTS ix_agreement_link_invoice   ON legal.agreement_link (invoice_id)
    WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_agreement_link_deal      ON legal.agreement_link (hubspot_deal_id)
    WHERE hubspot_deal_id IS NOT NULL;
-- Don't link the same agreement to the same invoice twice (among live rows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_link_invoice_live
    ON legal.agreement_link (agreement_id, invoice_id)
    WHERE deleted_at IS NULL AND invoice_id IS NOT NULL;
-- ...nor to the same deal twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_link_deal_live
    ON legal.agreement_link (agreement_id, hubspot_deal_id)
    WHERE deleted_at IS NULL AND hubspot_deal_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agreement_link_set_updated_at ON legal.agreement_link;
CREATE TRIGGER trg_agreement_link_set_updated_at
    BEFORE UPDATE ON legal.agreement_link
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_agreement_link ON legal.agreement_link;
CREATE TRIGGER zzz_audit_agreement_link
    AFTER INSERT OR UPDATE OR DELETE ON legal.agreement_link
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 8. legal.agreement_access_log -- confidential-document access audit
-- ---------------------------------------------------------------------
-- Records who VIEWED / DOWNLOADED which document, when, and from where. This is
-- a domain-specific access trail for confidential documents (distinct from the
-- generic audit.activity_log change history). It is append-only at the app
-- layer: no updated_at/deleted_at, and app roles get INSERT+SELECT only (s.12).
-- It records a read, so it is NOT itself audited by the zzz_audit trigger
-- (logging a read into the change log would be noise) -- but writes are still
-- immutable to app roles.
CREATE TABLE IF NOT EXISTS legal.agreement_access_log (
    id               bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id  bigint       NOT NULL,                 -- denormalized for RLS
    agreement_id     bigint       NOT NULL,                 -- FK -> agreement
    document_id      bigint       NULL,                     -- FK -> agreement_document (NULL = header-level view)
    access_action    legal.access_action NOT NULL,          -- viewed | downloaded
    -- WHO. accessed_by stores app_user.public_id (uuid) -- audit-trail reference,
    -- consistent with created_by/updated_by convention.
    accessed_by      uuid         NULL,
    accessed_at      timestamptz  NOT NULL DEFAULT now(),
    -- FROM WHERE.
    client_addr      inet         NULL,                     -- requester IP
    user_agent       text         NULL,                     -- requester UA string
    created_at       timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_agreement_access_log_public_id UNIQUE (public_id),
    CONSTRAINT fk_aal_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_aal_agreement FOREIGN KEY (agreement_id)
        REFERENCES legal.agreement(id) ON DELETE CASCADE,
    CONSTRAINT fk_aal_document  FOREIGN KEY (document_id)
        REFERENCES legal.agreement_document(id) ON DELETE CASCADE
);
COMMENT ON TABLE  legal.agreement_access_log IS 'Append-only access trail for confidential agreement documents: who VIEWED/DOWNLOADED which document, when, and from where (IP/UA). Distinct from audit.activity_log (which tracks data CHANGES). App roles get INSERT + SELECT only (no UPDATE/DELETE) so the trail is immutable on the request path; no soft-delete column (append-only).';
COMMENT ON COLUMN legal.agreement_access_log.document_id   IS 'Document accessed (FK -> agreement_document). NULL for an agreement-header view that did not open a specific file.';
COMMENT ON COLUMN legal.agreement_access_log.access_action IS 'viewed (metadata/preview) or downloaded (object bytes fetched from storage).';
COMMENT ON COLUMN legal.agreement_access_log.accessed_by   IS 'app_user.public_id (uuid) of the accessor. NULL only for unattributed/system access.';
COMMENT ON COLUMN legal.agreement_access_log.client_addr   IS 'Requester IP address. Personal data in some regimes -- restrict in reporting.';
COMMENT ON COLUMN legal.agreement_access_log.user_agent    IS 'Requester user-agent string. Low-sensitivity diagnostic data.';

CREATE INDEX IF NOT EXISTS ix_aal_org        ON legal.agreement_access_log (organization_id);
-- Primary query: full access history for a document/agreement, newest first.
CREATE INDEX IF NOT EXISTS ix_aal_document   ON legal.agreement_access_log (document_id, accessed_at DESC)
    WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_aal_agreement  ON legal.agreement_access_log (agreement_id, accessed_at DESC);
-- "What did this user access" investigations.
CREATE INDEX IF NOT EXISTS ix_aal_accessed_by ON legal.agreement_access_log (accessed_by, accessed_at DESC)
    WHERE accessed_by IS NOT NULL;

-- NOTE: no set_updated_at trigger (no updated_at -- the log is immutable) and no
-- zzz_audit trigger (it records reads; auditing a read into the change log is
-- noise). Immutability for app roles is enforced via grants (s.12).

-- ---------------------------------------------------------------------
-- 9. ROW-LEVEL SECURITY (tenant isolation) -- every tenant-scoped table
-- ---------------------------------------------------------------------
ALTER TABLE legal.agreement_type        ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement             ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement_version     ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement_document    ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.signatory             ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement_party       ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement_link        ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal.agreement_access_log  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_agreement_type_isolation ON legal.agreement_type;
CREATE POLICY rls_agreement_type_isolation ON legal.agreement_type
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_isolation ON legal.agreement;
CREATE POLICY rls_agreement_isolation ON legal.agreement
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_version_isolation ON legal.agreement_version;
CREATE POLICY rls_agreement_version_isolation ON legal.agreement_version
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_document_isolation ON legal.agreement_document;
CREATE POLICY rls_agreement_document_isolation ON legal.agreement_document
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_signatory_isolation ON legal.signatory;
CREATE POLICY rls_signatory_isolation ON legal.signatory
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_party_isolation ON legal.agreement_party;
CREATE POLICY rls_agreement_party_isolation ON legal.agreement_party
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_link_isolation ON legal.agreement_link;
CREATE POLICY rls_agreement_link_isolation ON legal.agreement_link
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_agreement_access_log_isolation ON legal.agreement_access_log;
CREATE POLICY rls_agreement_access_log_isolation ON legal.agreement_access_log
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- ---------------------------------------------------------------------
-- 10. LEGAL-HOLD GUARD TRIGGERS (litigation hold overrides deletion)
-- ---------------------------------------------------------------------
-- RULE: when legal_hold = true the agreement and its documents MUST survive
-- retention purge AND GDPR erasure. The only actor able to HARD-delete these
-- rows is the BYPASSRLS migrator/purge job; a DDL CHECK cannot block a DELETE.
-- We therefore install BEFORE DELETE guard triggers that RAISE on held rows.
-- These fire for ALL roles (including BYPASSRLS), so the purge/erasure job must
-- explicitly clear the hold first -- which is the intended legal workflow.
--
-- Implementation detail: the guard reads legal_hold from the row being deleted
-- (agreement) or from the parent agreement (document). Because the only
-- legitimate clear path is "lift the hold, then purge", the trigger is the
-- right enforcement point (not a CHECK, which cannot see DELETE).

CREATE OR REPLACE FUNCTION legal.deny_delete_when_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.legal_hold THEN
        RAISE EXCEPTION
            'agreement % is under legal hold and cannot be deleted (litigation hold overrides retention purge / GDPR erasure); lift the hold first',
            OLD.public_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;
COMMENT ON FUNCTION legal.deny_delete_when_legal_hold() IS 'BEFORE DELETE guard on legal.agreement: raises if the agreement is under legal hold. Enforces "litigation hold overrides auto-deletion" even against the BYPASSRLS purge/erasure job -- the hold must be lifted before the row can be removed.';

CREATE OR REPLACE FUNCTION legal.deny_delete_document_when_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_held boolean;
BEGIN
    -- Look up the parent agreement's hold flag. If the parent is already gone
    -- (e.g. ON DELETE CASCADE from a non-held agreement), allow the delete.
    SELECT a.legal_hold INTO v_held
      FROM legal.agreement a
     WHERE a.id = OLD.agreement_id;

    IF COALESCE(v_held, false) THEN
        RAISE EXCEPTION
            'agreement_document % belongs to agreement (id=%) under legal hold and cannot be deleted; lift the hold first',
            OLD.public_id, OLD.agreement_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;
COMMENT ON FUNCTION legal.deny_delete_document_when_legal_hold() IS 'BEFORE DELETE guard on legal.agreement_document: raises if the parent agreement is under legal hold, so held contract files survive purge/erasure. Allows the delete if the parent is already gone (cascade from a non-held agreement).';

-- Named without zzz_ so it is not confused with the audit trigger. (A BEFORE
-- trigger that aborts the statement makes ordering vs the AFTER audit moot.)
DROP TRIGGER IF EXISTS trg_agreement_legal_hold_guard ON legal.agreement;
CREATE TRIGGER trg_agreement_legal_hold_guard
    BEFORE DELETE ON legal.agreement
    FOR EACH ROW EXECUTE FUNCTION legal.deny_delete_when_legal_hold();

DROP TRIGGER IF EXISTS trg_agreement_document_legal_hold_guard ON legal.agreement_document;
CREATE TRIGGER trg_agreement_document_legal_hold_guard
    BEFORE DELETE ON legal.agreement_document
    FOR EACH ROW EXECUTE FUNCTION legal.deny_delete_document_when_legal_hold();

-- ---------------------------------------------------------------------
-- 11. PSEUDONYMIZATION-AWARE NOTE (GDPR erasure under legal hold)
-- ---------------------------------------------------------------------
-- GDPR right-to-erasure on signatory/agreement_party is performed by the app/
-- migrator as an UPDATE that overwrites PII columns and sets pseudonymized_at
-- (NOT a row delete) -- preserving referential integrity and the signing record.
-- HOWEVER, when the parent agreement.legal_hold = true, erasure must be
-- SUPPRESSED until the hold lifts (litigation hold overrides erasure). Because
-- that is an UPDATE (not a DELETE), it is enforced in the erasure routine
-- (which checks agreement.legal_hold before pseudonymizing), not by the DELETE
-- guards above. Documented here so the erasure job honors the hold for PII too.

-- ---------------------------------------------------------------------
-- 12. LEAST-PRIVILEGE GRANTS (mirror the core/inventory pattern)
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA legal TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA legal TO app_readwrite;
-- No DELETE to app roles: request-path deletes are soft (deleted_at). Hard
-- deletes (retention purge) are a migrator-only operation, and even then are
-- blocked on legal-hold rows by the guard triggers (s.10).

-- agreement_access_log is append-only: app_readwrite may INSERT + SELECT but
-- NOT UPDATE it (revoke the UPDATE just granted above so the trail is immutable
-- on the request path). It has no DELETE grant either.
REVOKE UPDATE ON legal.agreement_access_log FROM app_readwrite;

-- Default privileges so future legal tables created by the migrator inherit it.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA legal
    GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA legal
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_readwrite;

-- =====================================================================
-- END LEGAL DOMAIN DDL
-- =====================================================================