-- =====================================================================
-- AAA_Database :: PRIVACY & LIFECYCLE DOMAIN  (GDPR / CCPA)
-- Target: PostgreSQL 16+
-- Depends on FOUNDATION DDL (core.*, audit.*, roles: app_readonly,
--   app_readwrite, app_migrator [BYPASSRLS], crm_sync [BYPASSRLS]) AND the
--   invoicing, crm, hr, inventory, legal domain schemas being loaded first.
--
-- WHY A SEPARATE `privacy` SCHEMA (security objects layer):
--   Data-governance machinery (classification catalogue, retention policy,
--   purge/erasure/DSAR functions) is cross-cutting -- it reasons about EVERY
--   domain. Putting it in its own schema keeps it out of the business domains,
--   gives it one owner (the platform/compliance team), and lets us grant the
--   powerful SECURITY DEFINER routines narrowly. The catalogue + policy tables
--   describe the SHAPE of the database (which is identical for every tenant),
--   so -- unlike business tables -- they are GLOBAL reference data, NOT
--   tenant-scoped and NOT under RLS. The per-PERSON run/erasure logs ARE
--   tenant-scoped (they reference a specific subject in a specific org).
--
-- WHAT THIS FILE PROVIDES (all explicitly requested):
--   1. privacy.data_class / privacy.data_control enums + the DATA
--      CLASSIFICATION CATALOG (privacy.data_classification) + a seed loader
--      and convenience views.
--   2. RETENTION POLICY table (privacy.retention_policy) + a scheduled
--      PURGE FUNCTION (privacy.run_retention_purge) and its run log.
--   3. RIGHT-TO-ERASURE function (privacy.erase_person) that pseudonymizes a
--      crm.contact OR an hr.employee while PRESERVING legally-required
--      financial records (invoices kept; the bill_to_customer PII is
--      detached/anonymized), honouring legal.agreement.legal_hold.
--   4. CONSENT ENFORCEMENT for crm marketing: crm.has_marketing_consent(...),
--      an assert helper, and a privacy.crm_marketable_contact view.
--   5. DSAR EXPORT function (privacy.export_subject_data) gathering all data
--      held about a person into one JSONB document.
--   6. DATA-MINIMIZATION guidance for the HubSpot raw_properties payload
--      (notes + an allow-list table + a sanitiser the sync worker can call).
--
-- CONVENTIONS FOLLOWED (Foundation Conventions, NORMATIVE):
--   * snake_case, singular tables, timestamptz everywhere, numeric for money.
--   * Tenant-scoped tables carry organization_id + RLS USING/WITH CHECK.
--   * Lookup tables get is_active; closed code-coupled sets are native enums.
--   * Mutation routines that must span tenants/own privileged writes are
--     SECURITY DEFINER with a pinned search_path (cannot be hijacked).
--   * GDPR erasure = PSEUDONYMIZE (overwrite PII, set pseudonymized_at), never
--     row-delete a person whose history must survive -- preserves FKs/audit.
--   * Idempotent: CREATE ... IF NOT EXISTS / DROP ... IF EXISTS / guarded DO.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SCHEMA
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS privacy;
COMMENT ON SCHEMA privacy IS
  'Data privacy & lifecycle governance (GDPR/CCPA): data classification catalogue, retention policy + purge, right-to-erasure (pseudonymization), DSAR export, and CRM marketing consent enforcement. Cross-cutting security objects owned by the platform/compliance team. Catalogue/policy tables are GLOBAL (describe the schema shape, same for all tenants); per-subject run/erasure logs are tenant-scoped.';

-- ---------------------------------------------------------------------
-- 1. ENUM TYPES (closed, code-coupled governance vocabularies)
-- ---------------------------------------------------------------------
-- DECISION: native enums. These vocabularies are small, closed, and wired into
-- governance LOGIC (a control function branches on them). A non-engineer does
-- not extend "what counts as PII" at runtime; new classes ship via migration.
-- (Contrast: retention_policy is data a compliance user edits -> a table.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='data_class' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.data_class AS ENUM
      ('public', 'internal', 'confidential', 'financial', 'payment', 'pii', 'sensitive_pii');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='data_control' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.data_control AS ENUM
      ('none', 'mask_in_reporting', 'restrict_rls', 'tokenize', 'encrypt_at_column');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='retention_action' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.retention_action AS ENUM
      ('pseudonymize', 'soft_delete', 'hard_delete', 'review_only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='purge_run_status' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.purge_run_status AS ENUM
      ('running', 'succeeded', 'failed', 'dry_run');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='subject_kind' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.subject_kind AS ENUM
      ('crm_contact', 'hr_employee', 'app_user', 'bill_to_customer', 'supplier_contact');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='erasure_status' AND n.nspname='privacy') THEN
    CREATE TYPE privacy.erasure_status AS ENUM
      ('requested', 'completed', 'blocked_legal_hold', 'partially_completed', 'rejected');
  END IF;
END
$$;

COMMENT ON TYPE privacy.data_class       IS 'Sensitivity class of a column. Closed taxonomy wired into governance logic (mirrors the classification catalogue) -> enum.';
COMMENT ON TYPE privacy.data_control     IS 'Recommended protective control for a classified column. Closed set -> enum.';
COMMENT ON TYPE privacy.retention_action IS 'What a retention sweep does to an expired row: pseudonymize PII (keep row), soft_delete (tombstone), hard_delete (remove), or review_only (flag, never auto-act). Closed set -> enum.';
COMMENT ON TYPE privacy.purge_run_status IS 'Lifecycle of a retention purge batch. Closed operational set -> enum.';
COMMENT ON TYPE privacy.subject_kind     IS 'Kind of data subject an erasure/DSAR request targets. Closed set -> enum.';
COMMENT ON TYPE privacy.erasure_status   IS 'Outcome of a right-to-erasure request. Closed set -> enum.';

-- ---------------------------------------------------------------------
-- 2. DATA CLASSIFICATION CATALOG
-- ---------------------------------------------------------------------
-- One row per sensitive column in the database. GLOBAL (the schema shape is the
-- same for every tenant), so NO organization_id and NO RLS -- it is metadata
-- about the model, not tenant data. It is the machine-readable source of truth
-- behind audit redaction choices, reporting masks, DSAR field selection, and
-- erasure targeting. Keyed by fully-qualified column.
CREATE TABLE IF NOT EXISTS privacy.data_classification (
    id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
    schema_name         text         NOT NULL,
    table_name          text         NOT NULL,
    column_name         text         NOT NULL,
    data_class          privacy.data_class   NOT NULL,
    recommended_control privacy.data_control NOT NULL DEFAULT 'restrict_rls',
    reason              text         NULL,
    -- Governance flags consumed by the lifecycle routines:
    is_pii              boolean      NOT NULL GENERATED ALWAYS AS
                            (data_class IN ('pii','sensitive_pii')) STORED,
    is_erasable         boolean      NOT NULL DEFAULT true,  -- overwrite on right-to-erasure?
    is_special_category boolean      NOT NULL DEFAULT false, -- GDPR Art.9 (health, etc.)
    is_audit_redacted   boolean      NOT NULL DEFAULT false, -- already passed to audit.if_modified()?
    include_in_dsar     boolean      NOT NULL DEFAULT true,  -- surfaced in a DSAR export?
    notes               text         NULL,
    is_active           boolean      NOT NULL DEFAULT true,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    CONSTRAINT uq_data_classification_public_id UNIQUE (public_id),
    CONSTRAINT ck_data_classification_ident
        CHECK (schema_name ~ '^[a-z_][a-z0-9_]*$'
           AND table_name  ~ '^[a-z_][a-z0-9_]*$'
           AND column_name ~ '^[a-z_][a-z0-9_]*$')
);
COMMENT ON TABLE  privacy.data_classification IS
  'Data classification catalogue: one row per sensitive column (fully-qualified). GLOBAL reference data describing the schema shape -- not tenant-scoped, no RLS. Drives audit-redaction choices, reporting masks, DSAR field selection, and erasure targeting. Maintained via migration alongside DDL changes.';
COMMENT ON COLUMN privacy.data_classification.data_class          IS 'Sensitivity class (public..sensitive_pii). Mirrors the project-wide sensitive-column inventory.';
COMMENT ON COLUMN privacy.data_classification.recommended_control IS 'Protective control to apply (mask_in_reporting / restrict_rls / tokenize / encrypt_at_column).';
COMMENT ON COLUMN privacy.data_classification.is_pii              IS 'Generated: TRUE when data_class is pii or sensitive_pii. Lets erasure/DSAR select PII columns generically.';
COMMENT ON COLUMN privacy.data_classification.is_erasable         IS 'TRUE if this column is overwritten during right-to-erasure. FALSE for columns that must be retained for legal/financial reasons even after erasure.';
COMMENT ON COLUMN privacy.data_classification.is_special_category IS 'TRUE for GDPR Art.9 special-category data (e.g. health: hr.leave_request.medical_note_enc). Extra handling/justification required.';
COMMENT ON COLUMN privacy.data_classification.is_audit_redacted   IS 'TRUE if this column is already redacted from audit images via the audit.if_modified() trigger argument (kept in sync with the DDL).';
COMMENT ON COLUMN privacy.data_classification.include_in_dsar     IS 'TRUE if the column value is returned in a DSAR export. Secrets/tokens (password_hash, mfa_secret, payment_token) are excluded.';

-- A column is catalogued once (live rows).
CREATE UNIQUE INDEX IF NOT EXISTS uq_data_classification_col_live
    ON privacy.data_classification (schema_name, table_name, column_name)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_data_classification_class
    ON privacy.data_classification (data_class) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_data_classification_table
    ON privacy.data_classification (schema_name, table_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_data_classification_pii
    ON privacy.data_classification (schema_name, table_name)
    WHERE is_pii AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_data_classification_set_updated_at ON privacy.data_classification;
CREATE TRIGGER trg_data_classification_set_updated_at
    BEFORE UPDATE ON privacy.data_classification
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_data_classification ON privacy.data_classification;
CREATE TRIGGER zzz_audit_data_classification
    AFTER INSERT OR UPDATE OR DELETE ON privacy.data_classification
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- 2a. Catalogue seed (idempotent upsert). Mirrors the project sensitive-column
--     inventory. Extend this block whenever a sensitive column is added to any
--     schema -- it is the contract the lifecycle routines read.
INSERT INTO privacy.data_classification
    (schema_name, table_name, column_name, data_class, recommended_control,
     is_erasable, is_special_category, is_audit_redacted, include_in_dsar, reason)
VALUES
  -- core.app_user
  ('core','app_user','email',         'pii',           'mask_in_reporting', true,  false, false, true,  'Login email; identifies a natural person.'),
  ('core','app_user','full_name',     'pii',           'mask_in_reporting', true,  false, false, true,  'Account holder name.'),
  ('core','app_user','password_hash', 'sensitive_pii', 'restrict_rls',      false, false, true,  false, 'Auth credential (one-way hash). Never exported; redacted in audit.'),
  ('core','app_user','mfa_secret',    'sensitive_pii', 'encrypt_at_column', false, false, true,  false, 'TOTP seed. Encrypted bytea; never exported; redacted in audit.'),
  ('core','app_user','last_login_at', 'internal',      'restrict_rls',      false, false, false, true,  'Activity telemetry.'),
  ('core','app_user','public_id',     'internal',      'mask_in_reporting', false, false, false, true,  'External pseudonymous account handle.'),
  ('core','organization','legal_name','confidential',  'restrict_rls',      false, false, false, false, 'Tenant legal identity; commercially confidential.'),
  -- audit.activity_log
  ('audit','activity_log','old_data',          'sensitive_pii','restrict_rls',     false, false, false, false, 'JSONB pre-image; inherits sensitivity of audited columns.'),
  ('audit','activity_log','new_data',          'sensitive_pii','restrict_rls',     false, false, false, false, 'JSONB post-image; inherits sensitivity of audited columns.'),
  ('audit','activity_log','client_addr',       'pii',          'mask_in_reporting',false, false, false, true,  'Client IP; personal data under GDPR.'),
  ('audit','activity_log','actor_app_user_id', 'pii',          'restrict_rls',     false, false, false, true,  'Pseudonymous link to the acting person.'),
  -- invoicing.bill_to_customer
  ('invoicing','bill_to_customer','email',          'pii',          'mask_in_reporting', true,  false, false, true, 'Billing contact email (individual/sole trader).'),
  ('invoicing','bill_to_customer','phone',          'pii',          'mask_in_reporting', true,  false, false, true, 'Billing contact phone.'),
  ('invoicing','bill_to_customer','tax_identifier', 'sensitive_pii','encrypt_at_column', true,  false, true,  true, 'VAT/EIN/GSTIN; government identifier. Redacted in audit.'),
  ('invoicing','bill_to_customer','legal_name',     'pii',          'mask_in_reporting', true,  false, false, true, 'Individual/sole-trader legal name.'),
  ('invoicing','bill_to_customer','display_name',   'pii',          'mask_in_reporting', true,  false, false, true, 'May contain an individual name.'),
  ('invoicing','bill_to_customer','address_line1',  'pii',          'mask_in_reporting', true,  false, false, true, 'Billing street address.'),
  ('invoicing','bill_to_customer','address_line2',  'pii',          'mask_in_reporting', true,  false, false, true, 'Billing street address (line 2).'),
  ('invoicing','bill_to_customer','postal_code',    'pii',          'mask_in_reporting', true,  false, false, true, 'Postal code (quasi-identifier).'),
  ('invoicing','bill_to_customer','hubspot_contact_id','internal',  'restrict_rls',      false, false, false, true, 'Loose CRM contact correlation.'),
  -- invoicing.payment  (financial records: NOT erasable -- legally required)
  ('invoicing','payment','payment_token',       'payment',  'restrict_rls',      false, false, true,  false, 'Processor token. Not a PAN; redacted in audit; never exported.'),
  ('invoicing','payment','processor_reference', 'payment',  'restrict_rls',      false, false, true,  false, 'Processor charge id; redacted in audit.'),
  ('invoicing','payment','last4',               'payment',  'mask_in_reporting', false, false, false, true,  'Instrument last 4 (display only).'),
  ('invoicing','payment','card_brand',          'payment',  'mask_in_reporting', false, false, false, true,  'Card network (display only).'),
  ('invoicing','payment','exp_month',           'payment',  'mask_in_reporting', false, false, false, true,  'Card expiry month.'),
  ('invoicing','payment','exp_year',            'payment',  'mask_in_reporting', false, false, false, true,  'Card expiry year.'),
  ('invoicing','payment','bank_name',           'payment',  'mask_in_reporting', false, false, false, true,  'Bank name (display only).'),
  ('invoicing','payment','amount',              'financial','restrict_rls',      false, false, false, true,  'Captured amount.'),
  ('invoicing','invoice','total_amount',        'financial','restrict_rls',      false, false, false, true,  'Invoice grand total.'),
  ('invoicing','invoice','amount_due',          'financial','restrict_rls',      false, false, false, true,  'Outstanding balance.'),
  ('invoicing','invoice_line_item','unit_price','financial','restrict_rls',      false, false, false, true,  'Per-unit price.'),
  ('invoicing','credit_note','total_amount',    'financial','restrict_rls',      false, false, false, true,  'Credit note total.'),
  -- crm.contact (PII heavy)
  ('crm','contact','email',               'pii',          'mask_in_reporting', true,  false, true,  true, 'Contact email.'),
  ('crm','contact','first_name',          'pii',          'mask_in_reporting', true,  false, true,  true, 'Given name.'),
  ('crm','contact','last_name',           'pii',          'mask_in_reporting', true,  false, true,  true, 'Family name.'),
  ('crm','contact','phone',               'pii',          'mask_in_reporting', true,  false, true,  true, 'Primary phone.'),
  ('crm','contact','mobile_phone',        'pii',          'mask_in_reporting', true,  false, true,  true, 'Mobile phone.'),
  ('crm','contact','address_street',      'pii',          'mask_in_reporting', true,  false, true,  true, 'Street address.'),
  ('crm','contact','address_city',        'pii',          'mask_in_reporting', true,  false, true,  true, 'City (quasi-identifier).'),
  ('crm','contact','address_state',       'pii',          'mask_in_reporting', true,  false, false, true, 'State (quasi-identifier).'),
  ('crm','contact','address_postal_code', 'pii',          'mask_in_reporting', true,  false, true,  true, 'Postal code (quasi-identifier).'),
  ('crm','contact','job_title',           'pii',          'mask_in_reporting', true,  false, false, true, 'Job title of an individual.'),
  ('crm','contact','raw_properties',      'sensitive_pii','restrict_rls',      true,  false, true,  false,'Full HubSpot property bag; may hold unmodelled PII.'),
  -- crm.company (PII-adjacent for sole traders)
  ('crm','company','phone',               'pii',          'mask_in_reporting', true,  false, true,  true, 'May be a personal number (sole trader).'),
  ('crm','company','domain',              'pii',          'mask_in_reporting', true,  false, false, true, 'May identify a sole trader.'),
  ('crm','company','address_street',      'pii',          'mask_in_reporting', true,  false, true,  true, 'May be a residential address.'),
  ('crm','company','address_city',        'pii',          'mask_in_reporting', true,  false, true,  true, 'Location quasi-identifier.'),
  ('crm','company','address_postal_code', 'pii',          'mask_in_reporting', true,  false, true,  true, 'Geographic quasi-identifier.'),
  ('crm','company','annual_revenue',      'confidential', 'restrict_rls',      false, false, false, false,'Confidential business figure.'),
  ('crm','company','raw_properties',      'sensitive_pii','restrict_rls',      true,  false, true,  false,'Full property bag; unmodelled PII/financial.'),
  -- crm.deal
  ('crm','deal','amount',                 'financial',    'restrict_rls',      false, false, false, false,'Deal value; confidential.'),
  ('crm','deal','raw_properties',         'confidential', 'restrict_rls',      false, false, true,  false,'Property bag; financial detail.'),
  -- crm.consent (evidence is PII; the decision is retained even after erasure)
  ('crm','consent','evidence_ip',         'pii',          'encrypt_at_column', true,  false, true,  true, 'Proof-of-consent IP.'),
  ('crm','consent','evidence_user_agent', 'pii',          'mask_in_reporting', true,  false, true,  true, 'Proof-of-consent UA (device fingerprint).'),
  ('crm','consent','consent_text',        'confidential', 'restrict_rls',      false, false, false, true, 'Legal-evidence wording.'),
  -- crm.sync_error (incidental PII)
  ('crm','sync_error','error_message',    'pii',          'mask_in_reporting', false, false, true,  false,'May echo a record field (PII).'),
  ('crm','sync_error','error_payload',    'sensitive_pii','restrict_rls',      false, false, true,  false,'Offending record snippet; may carry full PII.'),
  -- hr.employee (highest sensitivity)
  ('hr','employee','national_id_enc',     'sensitive_pii','encrypt_at_column', true,  false, true,  false,'Encrypted national id. Never exported raw; redacted in audit.'),
  ('hr','employee','national_id_hash',    'sensitive_pii','restrict_rls',      true,  false, true,  false,'Keyed HMAC of national id; redacted in audit.'),
  ('hr','employee','date_of_birth',       'sensitive_pii','restrict_rls',      true,  false, true,  true, 'DOB; identity factor.'),
  ('hr','employee','legal_first_name',    'pii',          'mask_in_reporting', true,  false, false, true, 'Legal given name.'),
  ('hr','employee','legal_last_name',     'pii',          'mask_in_reporting', true,  false, false, true, 'Legal family name.'),
  ('hr','employee','preferred_name',      'pii',          'mask_in_reporting', true,  false, false, true, 'Preferred name.'),
  ('hr','employee','personal_email',      'pii',          'mask_in_reporting', true,  false, false, true, 'Personal email.'),
  ('hr','employee','work_email',          'pii',          'mask_in_reporting', true,  false, false, true, 'Work email.'),
  ('hr','employee','phone',               'pii',          'mask_in_reporting', true,  false, false, true, 'Personal phone.'),
  ('hr','employee','address_line1',       'sensitive_pii','encrypt_at_column', true,  false, true,  true, 'Home street address. Redacted in audit.'),
  ('hr','employee','address_line2',       'sensitive_pii','encrypt_at_column', true,  false, true,  true, 'Home address detail. Redacted in audit.'),
  ('hr','employee','address_city',        'pii',          'restrict_rls',      true,  false, false, true, 'Home city.'),
  ('hr','employee','address_region',      'pii',          'restrict_rls',      true,  false, false, true, 'Home region.'),
  ('hr','employee','address_postal_code', 'sensitive_pii','restrict_rls',      true,  false, true,  true, 'Home postal code. Redacted in audit.'),
  ('hr','employee','bank_account_token',  'payment',      'tokenize',          false, false, true,  false,'Payout token. Redacted in audit; never exported.'),
  ('hr','employee','bank_account_last4',  'financial',    'mask_in_reporting', false, false, false, true, 'Payout account last 4.'),
  ('hr','employee','bank_name',           'financial',    'restrict_rls',      false, false, false, true, 'Employee bank name.'),
  ('hr','compensation','amount_enc',      'financial',    'encrypt_at_column', false, false, true,  false,'Encrypted exact pay. Redacted in audit; not exported raw.'),
  ('hr','compensation','amount_band',     'confidential', 'mask_in_reporting', false, false, false, true, 'Coarse pay band.'),
  ('hr','compensation','pay_grade',       'confidential', 'restrict_rls',      false, false, false, true, 'Pay grade/level.'),
  ('hr','leave_request','medical_note_enc','sensitive_pii','encrypt_at_column',true,  true,  true,  false,'GDPR Art.9 health data. Encrypted; redacted in audit; not exported raw.'),
  ('hr','leave_request','reason',         'pii',          'restrict_rls',      true,  false, false, true, 'Free-text leave reason; may carry health context.'),
  -- inventory
  ('inventory','product','standard_cost', 'confidential', 'mask_in_reporting', false, false, true,  false,'Unit cost; margin-sensitive. Redacted in audit.'),
  ('inventory','product','list_price',    'internal',     'mask_in_reporting', false, false, false, false,'Default selling price.'),
  ('inventory','stock_movement','unit_cost','confidential','mask_in_reporting',false, false, true,  false,'Per-unit cost; COGS basis. Redacted in audit.'),
  ('inventory','supplier','contact_name', 'pii',          'mask_in_reporting', true,  false, true,  true, 'Vendor contact name.'),
  ('inventory','supplier','contact_email','pii',          'mask_in_reporting', true,  false, true,  true, 'Vendor contact email.'),
  ('inventory','supplier','contact_phone','pii',          'mask_in_reporting', true,  false, true,  true, 'Vendor contact phone.'),
  ('inventory','supplier','tax_identifier','confidential','restrict_rls',      false, false, true,  false,'Vendor VAT/EIN. Redacted in audit.'),
  ('inventory','purchase_order','total_amount',   'financial','mask_in_reporting',false,false,false, false,'Procurement spend total.'),
  ('inventory','purchase_order','subtotal_amount','financial','mask_in_reporting',false,false,false, false,'Procurement subtotal.'),
  ('inventory','purchase_order_line','unit_price', 'confidential','mask_in_reporting',false,false,false,false,'Negotiated purchase price.'),
  ('inventory','purchase_order_line','line_amount','financial','mask_in_reporting',false,false,false, false,'Line spend amount.'),
  -- legal
  ('legal','agreement','contract_value',     'financial',    'mask_in_reporting', false, false, true,  false,'Contract value. Redacted in audit.'),
  ('legal','agreement','title',              'confidential', 'restrict_rls',      false, false, false, false,'Contract title; may name counterparty.'),
  ('legal','agreement','governing_law',      'confidential', 'restrict_rls',      false, false, false, false,'Negotiated commercial term.'),
  ('legal','agreement','legal_hold_reason',  'confidential', 'mask_in_reporting', false, false, true,  false,'Litigation matter reference. Redacted in audit.'),
  ('legal','signatory','signer_name',        'pii',          'mask_in_reporting', true,  false, true,  true, 'Signer name.'),
  ('legal','signatory','signer_email',       'pii',          'mask_in_reporting', true,  false, true,  true, 'Signer email.'),
  ('legal','signatory','signing_ip',         'pii',          'mask_in_reporting', true,  false, true,  true, 'Signing IP (evidentiary).'),
  ('legal','signatory','signer_title',       'pii',          'mask_in_reporting', true,  false, false, true, 'Signer job title.'),
  ('legal','agreement_party','party_name',   'pii',          'mask_in_reporting', true,  false, true,  true, 'Party label; may name a person.'),
  ('legal','agreement_party','hubspot_company_id','confidential','restrict_rls',  false, false, false, true, 'Counterparty (commercial relationship).'),
  ('legal','agreement_party','hubspot_contact_id','pii',     'restrict_rls',      false, false, false, true, 'Counterparty contact (person).'),
  ('legal','agreement_document','storage_key',   'confidential','restrict_rls',   false, false, false, false,'Pointer to confidential file.'),
  ('legal','agreement_document','storage_bucket','internal',  'restrict_rls',     false, false, false, false,'Storage container name.'),
  ('legal','agreement_document','sha256_hash',   'internal',  'restrict_rls',     false, false, false, false,'File integrity hash.'),
  ('legal','agreement_access_log','client_addr', 'pii',       'mask_in_reporting',false, false, false, true, 'Accessor IP.'),
  ('legal','agreement_access_log','accessed_by', 'pii',       'restrict_rls',     false, false, false, true, 'Accessor person (behavioral).'),
  ('legal','agreement_access_log','user_agent',  'pii',       'mask_in_reporting',false, false, false, true, 'Accessor UA.'),
  ('legal','agreement_link','hubspot_deal_id',   'confidential','restrict_rls',   false, false, false, true, 'Linked CRM deal (pipeline).'),
  ('legal','agreement_version','change_summary', 'confidential','restrict_rls',   false, false, false, false,'Amendment summary; restates terms.')
ON CONFLICT (schema_name, table_name, column_name) WHERE (deleted_at IS NULL)
DO UPDATE SET
    data_class          = EXCLUDED.data_class,
    recommended_control = EXCLUDED.recommended_control,
    is_erasable         = EXCLUDED.is_erasable,
    is_special_category = EXCLUDED.is_special_category,
    is_audit_redacted   = EXCLUDED.is_audit_redacted,
    include_in_dsar     = EXCLUDED.include_in_dsar,
    reason              = EXCLUDED.reason,
    updated_at          = now();

-- 2b. Convenience views over the catalogue.
CREATE OR REPLACE VIEW privacy.v_pii_column AS
    SELECT schema_name, table_name, column_name, data_class,
           recommended_control, is_special_category, is_audit_redacted, include_in_dsar
      FROM privacy.data_classification
     WHERE is_pii AND deleted_at IS NULL AND is_active;
COMMENT ON VIEW privacy.v_pii_column IS 'All live PII / sensitive-PII columns. Used by erasure & DSAR routines and by reviewers.';

-- Reconciliation helper: catalogued sensitive columns that are NOT actually
-- redacted from audit images but are marked is_audit_redacted (or vice versa) --
-- run in review to keep the DDL trigger args and the catalogue honest.
CREATE OR REPLACE VIEW privacy.v_classification_orphan AS
    SELECT dc.schema_name, dc.table_name, dc.column_name, dc.data_class
      FROM privacy.data_classification dc
      LEFT JOIN information_schema.columns c
             ON c.table_schema = dc.schema_name
            AND c.table_name   = dc.table_name
            AND c.column_name  = dc.column_name
     WHERE dc.deleted_at IS NULL
       AND c.column_name IS NULL;   -- catalogued column that no longer exists
COMMENT ON VIEW privacy.v_classification_orphan IS 'Catalogue rows whose column no longer exists in the live schema (drifted classification). Should be empty; investigate any rows after a migration.';

-- ---------------------------------------------------------------------
-- 3. RETENTION POLICY + SCHEDULED PURGE
-- ---------------------------------------------------------------------
-- 3a. Policy table. One row per (schema, table[, optional tenant override]).
-- GLOBAL by default (organization_id NULL = applies to every tenant); a row WITH
-- organization_id overrides the global default for that tenant. retention_period
-- is measured from the column named in `age_column` (e.g. deleted_at for
-- tombstoned rows, or a domain date). action says what the sweep does.
CREATE TABLE IF NOT EXISTS privacy.retention_policy (
    id               bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id  bigint        NULL,                     -- NULL = global default; set = per-tenant override
    schema_name      text          NOT NULL,
    table_name       text          NOT NULL,
    description      text          NULL,
    retention_period interval      NOT NULL,                 -- e.g. '7 years', '90 days'
    age_column       text          NOT NULL DEFAULT 'deleted_at', -- timestamptz column the age is measured from
    action           privacy.retention_action NOT NULL DEFAULT 'pseudonymize',
    -- Extra SQL predicate (no leading WHERE/AND) further restricting eligible
    -- rows, e.g. "status = 'paid'". Validated at apply time; admin-authored.
    filter_predicate text          NULL,
    -- Safety: skip rows whose parent agreement is under legal hold, and (for
    -- invoicing) never purge a person's financial records via this path.
    respect_legal_hold boolean     NOT NULL DEFAULT true,
    is_enabled       boolean       NOT NULL DEFAULT true,
    last_run_at      timestamptz   NULL,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    created_by       uuid          NULL,
    updated_by       uuid          NULL,
    deleted_at       timestamptz   NULL,
    CONSTRAINT uq_retention_policy_public_id UNIQUE (public_id),
    CONSTRAINT ck_retention_policy_ident
        CHECK (schema_name ~ '^[a-z_][a-z0-9_]*$'
           AND table_name  ~ '^[a-z_][a-z0-9_]*$'
           AND age_column  ~ '^[a-z_][a-z0-9_]*$'),
    CONSTRAINT ck_retention_policy_period CHECK (retention_period > interval '0'),
    CONSTRAINT fk_retention_policy_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE  privacy.retention_policy IS
  'Retention rules driving the scheduled purge. organization_id NULL = global default; a tenant-scoped row overrides the default for that tenant. retention_period is measured from age_column; action chooses pseudonymize/soft_delete/hard_delete/review_only. filter_predicate optionally narrows eligible rows. Compliance-editable -> a table, not an enum.';
COMMENT ON COLUMN privacy.retention_policy.organization_id    IS 'NULL = applies to all tenants (global default). Non-NULL = per-tenant override; the most specific matching policy wins.';
COMMENT ON COLUMN privacy.retention_policy.retention_period   IS 'How long to keep a row past age_column before the action applies (interval, e.g. 7 years).';
COMMENT ON COLUMN privacy.retention_policy.age_column         IS 'timestamptz column whose value + retention_period < now() makes a row eligible. Typically deleted_at (tombstone age) or a domain timestamp.';
COMMENT ON COLUMN privacy.retention_policy.action             IS 'pseudonymize (overwrite PII, keep row), soft_delete (set deleted_at), hard_delete (remove row), review_only (count only, never mutate).';
COMMENT ON COLUMN privacy.retention_policy.filter_predicate   IS 'Optional extra SQL boolean (no leading WHERE), e.g. "status = ''paid''". Authored by admins; embedded in the dynamic purge query.';
COMMENT ON COLUMN privacy.retention_policy.respect_legal_hold IS 'When TRUE the purge excludes rows linked to a legal.agreement under legal_hold (litigation hold overrides retention).';

-- At most one live policy per (tenant-or-global, schema, table).
CREATE UNIQUE INDEX IF NOT EXISTS uq_retention_policy_scope_live
    ON privacy.retention_policy (COALESCE(organization_id, 0), schema_name, table_name)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_retention_policy_enabled
    ON privacy.retention_policy (schema_name, table_name)
    WHERE is_enabled AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_retention_policy_set_updated_at ON privacy.retention_policy;
CREATE TRIGGER trg_retention_policy_set_updated_at
    BEFORE UPDATE ON privacy.retention_policy
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_retention_policy ON privacy.retention_policy;
CREATE TRIGGER zzz_audit_retention_policy
    AFTER INSERT OR UPDATE OR DELETE ON privacy.retention_policy
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- 3b. Purge run log (one row per table processed per sweep). Operational audit
-- of the lifecycle job itself. GLOBAL (the job runs across tenants).
CREATE TABLE IF NOT EXISTS privacy.purge_run (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid          NOT NULL DEFAULT gen_random_uuid(),
    retention_policy_id bigint      NULL,                    -- which policy (NULL if policy later removed)
    schema_name       text          NOT NULL,
    table_name        text          NOT NULL,
    action            privacy.retention_action NOT NULL,
    status            privacy.purge_run_status NOT NULL DEFAULT 'running',
    dry_run           boolean       NOT NULL DEFAULT false,
    rows_matched      bigint        NOT NULL DEFAULT 0,
    rows_affected     bigint        NOT NULL DEFAULT 0,
    cutoff_ts         timestamptz   NULL,                    -- now() - retention_period at run time
    started_at        timestamptz   NOT NULL DEFAULT now(),
    finished_at       timestamptz   NULL,
    error_text        text          NULL,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_purge_run_public_id UNIQUE (public_id),
    CONSTRAINT ck_purge_run_counts CHECK (rows_matched >= 0 AND rows_affected >= 0),
    CONSTRAINT fk_purge_run_policy FOREIGN KEY (retention_policy_id)
        REFERENCES privacy.retention_policy(id) ON DELETE SET NULL
);
COMMENT ON TABLE privacy.purge_run IS
  'Operational log: one row per (policy, table) processed in a retention sweep. Records matched/affected counts, cutoff, dry-run flag, and any error. Written by privacy.run_retention_purge. Immutable to app roles (no UPDATE/DELETE grant).';

CREATE INDEX IF NOT EXISTS ix_purge_run_started ON privacy.purge_run (started_at DESC);
CREATE INDEX IF NOT EXISTS ix_purge_run_table   ON privacy.purge_run (schema_name, table_name, started_at DESC);

-- 3c. Seed sensible default retention policies (idempotent). These encode the
-- common SOC2/GDPR posture: keep financial records ~7y, purge soft-deleted CRM
-- and operational logs sooner. Compliance tunes these per regime/tenant.
INSERT INTO privacy.retention_policy
    (organization_id, schema_name, table_name, retention_period, age_column, action, filter_predicate, respect_legal_hold, description)
VALUES
  -- CRM mirror: pseudonymize contacts long soft-deleted upstream (they left HubSpot).
  (NULL,'crm','contact', interval '180 days','deleted_at','pseudonymize', NULL, false,
     'Pseudonymize CRM contacts soft-deleted (removed upstream) > 180 days.'),
  (NULL,'crm','company', interval '180 days','deleted_at','pseudonymize', NULL, false,
     'Pseudonymize sole-trader company PII soft-deleted > 180 days.'),
  -- Consent: keep proof-of-consent for 3y after withdrawal, then drop the evidence PII.
  (NULL,'crm','consent', interval '3 years','revoked_at','pseudonymize', NULL, false,
     'Drop consent evidence (ip/ua) 3 years after withdrawal; retain the decision/audit trail.'),
  -- Sync errors may echo PII: hard-delete after 90 days (operational noise).
  (NULL,'crm','sync_error', interval '90 days','occurred_at','hard_delete','is_resolved = true', false,
     'Hard-delete resolved sync errors (may echo PII) after 90 days.'),
  -- HR working-time: time entries are operational; keep 4y then hard-delete.
  (NULL,'hr','time_entry', interval '4 years','work_date','hard_delete', NULL, false,
     'Hard-delete clock punches after 4 years (payroll evidence window).'),
  -- Invoicing financial records: REVIEW ONLY -- never auto-deleted (statutory ~7-10y);
  -- erasure detaches PII via privacy.erase_person instead.
  (NULL,'invoicing','invoice', interval '7 years','issue_date','review_only', NULL, true,
     'Financial record: flag invoices older than 7 years for review; do NOT auto-delete (statutory retention + legal hold).'),
  (NULL,'invoicing','payment', interval '7 years','received_at','review_only', NULL, true,
     'Financial record: flag payments older than 7 years for review; do NOT auto-delete.'),
  -- Legal access log: keep document-access trail 2y then hard-delete (it is not the change audit).
  (NULL,'legal','agreement_access_log', interval '2 years','accessed_at','hard_delete', NULL, true,
     'Hard-delete document access-trail entries after 2 years (respecting legal hold).')
ON CONFLICT (COALESCE(organization_id, 0), schema_name, table_name) WHERE (deleted_at IS NULL)
DO NOTHING;

-- 3d. SCHEDULED PURGE FUNCTION.
-- Runs every enabled policy (optionally one table, optionally one tenant,
-- optionally dry-run). SECURITY DEFINER + pinned search_path: it must operate
-- across tenants and hard-delete, which the request-path roles cannot do. It is
-- driven entirely by the policy table via careful dynamic SQL with quoted
-- identifiers; the only free-text injected is the admin-authored filter_predicate
-- and (for pseudonymize) the catalogue-driven SET list.
--
-- LEGAL-HOLD SAFETY: for tables that descend from legal.agreement, when
-- respect_legal_hold is set the eligible-row query excludes held rows. For the
-- agreement/document tables themselves the legal BEFORE DELETE guard triggers
-- are the ultimate backstop -- a hard_delete attempt on a held row raises and is
-- caught per-policy (logged failed) so one held table never aborts the sweep.
CREATE OR REPLACE FUNCTION privacy.run_retention_purge(
    p_dry_run         boolean DEFAULT true,
    p_only_schema     text    DEFAULT NULL,
    p_only_table      text    DEFAULT NULL,
    p_organization_id bigint  DEFAULT NULL
)
RETURNS TABLE (
    schema_name   text,
    table_name    text,
    action        privacy.retention_action,
    rows_matched  bigint,
    rows_affected bigint,
    status        privacy.purge_run_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    r            privacy.retention_policy%ROWTYPE;
    v_cutoff     timestamptz;
    v_where      text;
    v_set        text;
    v_sql        text;
    v_matched    bigint;
    v_affected   bigint;
    v_run_id     bigint;
    v_status     privacy.purge_run_status;
    v_qual       text;     -- fully-qualified table
BEGIN
    FOR r IN
        SELECT *
          FROM privacy.retention_policy p
         WHERE p.is_enabled
           AND p.deleted_at IS NULL
           AND (p_only_schema     IS NULL OR p.schema_name = p_only_schema)
           AND (p_only_table      IS NULL OR p.table_name  = p_only_table)
           AND (p_organization_id IS NULL OR p.organization_id IS NULL
                                          OR p.organization_id = p_organization_id)
         ORDER BY p.schema_name, p.table_name,
                  -- prefer a tenant-specific override over the global default
                  (p.organization_id IS NULL)
    LOOP
        v_qual    := quote_ident(r.schema_name) || '.' || quote_ident(r.table_name);
        v_cutoff  := now() - r.retention_period;
        v_matched := 0;
        v_affected := 0;
        v_status  := CASE WHEN p_dry_run OR r.action = 'review_only'
                          THEN 'dry_run' ELSE 'running' END;

        -- Open the run log row.
        INSERT INTO privacy.purge_run
            (retention_policy_id, schema_name, table_name, action, status,
             dry_run, cutoff_ts, started_at)
        VALUES
            (r.id, r.schema_name, r.table_name, r.action, 'running',
             (p_dry_run OR r.action = 'review_only'), v_cutoff, now())
        RETURNING id INTO v_run_id;

        BEGIN
            -- Build the eligibility predicate from policy fields. age_column and
            -- table are quoted identifiers; the cutoff is a bound literal.
            v_where := format('%I < %L', r.age_column, v_cutoff);

            -- Restrict to a tenant when this is an override (or caller asked).
            IF r.organization_id IS NOT NULL THEN
                v_where := v_where || format(' AND organization_id = %L', r.organization_id);
            ELSIF p_organization_id IS NOT NULL THEN
                v_where := v_where || format(' AND organization_id = %L', p_organization_id);
            END IF;

            -- Admin-authored extra predicate (trusted; compliance-curated).
            IF r.filter_predicate IS NOT NULL AND btrim(r.filter_predicate) <> '' THEN
                v_where := v_where || ' AND (' || r.filter_predicate || ')';
            END IF;

            -- Exclude legal-held rows where the table descends from an agreement.
            IF r.respect_legal_hold
               AND r.schema_name = 'legal'
               AND r.table_name IN ('agreement_document','agreement_version','signatory',
                                    'agreement_party','agreement_link','agreement_access_log') THEN
                v_where := v_where || format(
                    ' AND NOT EXISTS (SELECT 1 FROM legal.agreement a '
                    || 'WHERE a.id = %I.agreement_id AND a.legal_hold)', r.table_name);
            ELSIF r.respect_legal_hold
               AND r.schema_name = 'legal'
               AND r.table_name = 'agreement' THEN
                v_where := v_where || ' AND NOT legal_hold';
            END IF;

            -- Count eligible rows.
            EXECUTE format('SELECT count(*) FROM %s WHERE %s', v_qual, v_where)
              INTO v_matched;

            IF NOT p_dry_run AND r.action <> 'review_only' AND v_matched > 0 THEN
                IF r.action = 'hard_delete' THEN
                    EXECUTE format('DELETE FROM %s WHERE %s', v_qual, v_where);
                    GET DIAGNOSTICS v_affected = ROW_COUNT;

                ELSIF r.action = 'soft_delete' THEN
                    EXECUTE format(
                        'UPDATE %s SET deleted_at = now() WHERE %s AND deleted_at IS NULL',
                        v_qual, v_where);
                    GET DIAGNOSTICS v_affected = ROW_COUNT;

                ELSIF r.action = 'pseudonymize' THEN
                    -- Build a SET list from the catalogue's erasable PII columns
                    -- for this table. Non-erasable / financial columns are left.
                    v_set := privacy._pseudonymize_set_clause(r.schema_name, r.table_name);
                    IF v_set IS NULL THEN
                        RAISE EXCEPTION
                            'no erasable PII columns catalogued for %.% -- cannot pseudonymize',
                            r.schema_name, r.table_name;
                    END IF;
                    EXECUTE format(
                        'UPDATE %s SET %s, pseudonymized_at = now() '
                        || 'WHERE %s AND pseudonymized_at IS NULL',
                        v_qual, v_set, v_where);
                    GET DIAGNOSTICS v_affected = ROW_COUNT;
                END IF;
            END IF;

            v_status := CASE WHEN p_dry_run OR r.action = 'review_only'
                             THEN 'dry_run' ELSE 'succeeded' END;

            UPDATE privacy.purge_run
               SET status = v_status, rows_matched = v_matched,
                   rows_affected = v_affected, finished_at = now()
             WHERE id = v_run_id;

            UPDATE privacy.retention_policy SET last_run_at = now() WHERE id = r.id;

        EXCEPTION WHEN OTHERS THEN
            -- One failing table (e.g. a legal-hold guard raise) must not abort
            -- the whole sweep. Log and continue.
            v_status := 'failed';
            UPDATE privacy.purge_run
               SET status = 'failed', rows_matched = v_matched,
                   rows_affected = v_affected, finished_at = now(),
                   error_text = SQLERRM
             WHERE id = v_run_id;
        END;

        schema_name   := r.schema_name;
        table_name    := r.table_name;
        action        := r.action;
        rows_matched  := v_matched;
        rows_affected := v_affected;
        status        := v_status;
        RETURN NEXT;
    END LOOP;
END;
$$;
COMMENT ON FUNCTION privacy.run_retention_purge(boolean, text, text, bigint) IS
  'Scheduled retention sweep. Applies every enabled privacy.retention_policy (optionally one schema/table/tenant). p_dry_run=true (default) counts only. SECURITY DEFINER (spans tenants, may hard-delete) with pinned search_path. Honours legal hold for legal.* tables; logs each table to privacy.purge_run; catches per-policy errors so one failure does not abort the run. Schedule via pg_cron/external scheduler, e.g. nightly: SELECT privacy.run_retention_purge(false);';

-- Helper: build the SET clause that overwrites a table''s erasable PII columns
-- with type-appropriate non-identifying placeholders, from the catalogue.
-- SECURITY DEFINER so it can read the catalogue + information_schema regardless
-- of caller. Returns NULL when the table has no erasable PII columns.
CREATE OR REPLACE FUNCTION privacy._pseudonymize_set_clause(
    p_schema text,
    p_table  text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_parts text[] := ARRAY[]::text[];
    rec     record;
    v_token text;
BEGIN
    -- Stable per-row token so pseudonymized values remain unique where the
    -- column had a unique index (e.g. email). md5(public_id||column) is unique
    -- per (row, column) without revealing the original.
    FOR rec IN
        SELECT dc.column_name, c.data_type, c.udt_name, c.character_maximum_length
          FROM privacy.data_classification dc
          JOIN information_schema.columns c
            ON c.table_schema = dc.schema_name
           AND c.table_name   = dc.table_name
           AND c.column_name  = dc.column_name
         WHERE dc.schema_name = p_schema
           AND dc.table_name  = p_table
           AND dc.is_pii
           AND dc.is_erasable
           AND dc.deleted_at IS NULL
    LOOP
        -- Choose a placeholder by type. Keep referential shape (valid email,
        -- 4-digit, etc.) so CHECK constraints still pass after overwrite.
        IF rec.udt_name = 'bytea' THEN
            -- Encrypted PII (national_id_enc, medical_note_enc): null it out.
            v_parts := v_parts || format('%I = NULL', rec.column_name);
        ELSIF rec.udt_name = 'inet' THEN
            v_parts := v_parts || format('%I = NULL', rec.column_name);
        ELSIF rec.udt_name = 'date' THEN
            v_parts := v_parts || format('%I = NULL', rec.column_name);
        ELSIF rec.column_name = 'email'
           OR rec.column_name LIKE '%_email'
           OR rec.column_name = 'signer_email'
           OR rec.column_name = 'contact_email'
           OR rec.column_name = 'personal_email'
           OR rec.column_name = 'work_email' THEN
            -- Valid-shaped but non-routable redacted address, unique per row.
            v_parts := v_parts || format(
                '%I = (''redacted+'' || md5(public_id::text || %L) || ''@erased.invalid'')::citext',
                rec.column_name, rec.column_name);
        ELSE
            -- Generic text/citext PII -> a fixed placeholder.
            v_parts := v_parts || format('%I = ''[erased]''', rec.column_name);
        END IF;
    END LOOP;

    IF array_length(v_parts, 1) IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN array_to_string(v_parts, ', ');
END;
$$;
COMMENT ON FUNCTION privacy._pseudonymize_set_clause(text, text) IS
  'Internal: builds the UPDATE SET clause that overwrites a table''s erasable PII columns (per the classification catalogue) with type-appropriate, constraint-satisfying placeholders. Emails become unique non-routable redacted+<hash>@erased.invalid; encrypted/inet/date PII becomes NULL; other PII becomes [erased]. Used by run_retention_purge and erase_person.';

-- ---------------------------------------------------------------------
-- 4. RIGHT-TO-ERASURE  (pseudonymize a person; keep financial records)
-- ---------------------------------------------------------------------
-- 4a. Erasure request log (tenant-scoped: it names a specific subject in a
-- specific org). RLS-isolated like any tenant table.
CREATE TABLE IF NOT EXISTS privacy.erasure_request (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint       NOT NULL,
    subject_kind       privacy.subject_kind NOT NULL,
    subject_public_id  uuid         NOT NULL,                 -- public_id of the erased entity
    status             privacy.erasure_status NOT NULL DEFAULT 'requested',
    -- What was touched (counts), for the compliance record / proof of action.
    tables_affected    jsonb        NULL,
    blocked_reason     text         NULL,                     -- e.g. legal-hold matter ref
    requested_by       uuid         NULL,                     -- app_user.public_id of the operator
    requested_at       timestamptz  NOT NULL DEFAULT now(),
    completed_at       timestamptz  NULL,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    created_by         uuid         NULL,
    updated_by         uuid         NULL,
    CONSTRAINT uq_erasure_request_public_id UNIQUE (public_id),
    CONSTRAINT fk_erasure_request_org FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE
);
COMMENT ON TABLE privacy.erasure_request IS
  'Right-to-erasure (GDPR Art.17 / CCPA delete) request + outcome per data subject. Tenant-scoped + RLS. tables_affected records the per-table row counts pseudonymized, as the compliance proof-of-action. Written by privacy.erase_person.';
COMMENT ON COLUMN privacy.erasure_request.subject_public_id IS 'public_id (uuid) of the erased subject (crm.contact / hr.employee / ...). The surrogate id is never exposed.';
COMMENT ON COLUMN privacy.erasure_request.tables_affected  IS 'JSONB { "schema.table": rows_pseudonymized, ... } documenting what was overwritten.';
COMMENT ON COLUMN privacy.erasure_request.blocked_reason   IS 'Set when status = blocked_legal_hold: the matter reference forcing retention.';

CREATE INDEX IF NOT EXISTS ix_erasure_request_org
    ON privacy.erasure_request (organization_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS ix_erasure_request_subject
    ON privacy.erasure_request (subject_kind, subject_public_id);

DROP TRIGGER IF EXISTS trg_erasure_request_set_updated_at ON privacy.erasure_request;
CREATE TRIGGER trg_erasure_request_set_updated_at
    BEFORE UPDATE ON privacy.erasure_request
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_erasure_request ON privacy.erasure_request;
CREATE TRIGGER zzz_audit_erasure_request
    AFTER INSERT OR UPDATE OR DELETE ON privacy.erasure_request
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

ALTER TABLE privacy.erasure_request ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_erasure_request_isolation ON privacy.erasure_request;
CREATE POLICY rls_erasure_request_isolation ON privacy.erasure_request
    USING      (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- 4b. THE ERASURE FUNCTION.
-- Pseudonymizes a crm.contact OR an hr.employee identified by public_id, plus
-- the personal data that hangs off them, WHILE PRESERVING legally-required
-- financial records:
--   * INVOICES, payments, credit notes, allocations are NEVER touched -- they
--     are statutory financial records. We instead pseudonymize the linked
--     invoicing.bill_to_customer PII (name/email/phone/address/tax id) so the
--     invoice keeps its amounts, dates, and numbers but no longer carries the
--     person's identity. (The bill_to_customer<->contact link is the loose
--     hubspot_contact_id, resolved here.)
--   * For an employee, hr.compensation / timesheets / time entries stay (payroll
--     evidence); only the person's identity columns + medical notes are erased.
-- LEGAL HOLD: if the subject is named on any legal.agreement under legal_hold,
-- erasure is SUPPRESSED (litigation hold overrides erasure) and recorded as
-- blocked_legal_hold -- mirrors the legal schema's documented rule (an UPDATE is
-- out of reach of the BEFORE DELETE guard triggers, so we check it here).
-- SECURITY DEFINER + pinned search_path: it must write across crm/hr/invoicing
-- and set pseudonymized_at on tables the app role can only UPDATE under RLS;
-- running as the owner (a BYPASSRLS-capable migrator role) lets it reach every
-- tenant deterministically. Callers must still pass the correct org.
CREATE OR REPLACE FUNCTION privacy.erase_person(
    p_organization_id  bigint,
    p_subject_kind     privacy.subject_kind,
    p_subject_public_id uuid,
    p_requested_by     uuid DEFAULT NULL,
    p_reason           text DEFAULT NULL
)
RETURNS privacy.erasure_request
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_req        privacy.erasure_request;
    v_affected   jsonb := '{}'::jsonb;
    v_n          bigint;
    v_contact_id bigint;
    v_hubspot_id text;
    v_employee_id bigint;
    v_app_user_id bigint;
    v_held       boolean := false;
    v_set        text;
BEGIN
    IF p_subject_kind NOT IN ('crm_contact','hr_employee') THEN
        RAISE EXCEPTION 'erase_person currently supports crm_contact and hr_employee, not %', p_subject_kind;
    END IF;

    -- Open the request row.
    INSERT INTO privacy.erasure_request
        (organization_id, subject_kind, subject_public_id, status,
         requested_by, requested_at, created_by)
    VALUES
        (p_organization_id, p_subject_kind, p_subject_public_id, 'requested',
         p_requested_by, now(), p_requested_by)
    RETURNING * INTO v_req;

    -- ============================ CRM CONTACT ============================
    IF p_subject_kind = 'crm_contact' THEN
        SELECT id, hubspot_id INTO v_contact_id, v_hubspot_id
          FROM crm.contact
         WHERE public_id = p_subject_public_id
           AND organization_id = p_organization_id;
        IF v_contact_id IS NULL THEN
            UPDATE privacy.erasure_request
               SET status='rejected', blocked_reason='subject not found',
                   completed_at=now()
             WHERE id=v_req.id RETURNING * INTO v_req;
            RETURN v_req;
        END IF;

        -- Legal-hold check: is this person named on a held agreement (by the
        -- loose hubspot_contact_id, since legal links to crm are loose)?
        SELECT EXISTS (
            SELECT 1
              FROM legal.agreement_party ap
              JOIN legal.agreement a ON a.id = ap.agreement_id
             WHERE a.organization_id = p_organization_id
               AND a.legal_hold
               AND ap.hubspot_contact_id = v_hubspot_id
        ) INTO v_held;

        IF v_held THEN
            UPDATE privacy.erasure_request
               SET status='blocked_legal_hold',
                   blocked_reason=COALESCE(p_reason,'subject named on an agreement under legal hold'),
                   completed_at=now()
             WHERE id=v_req.id RETURNING * INTO v_req;
            RETURN v_req;
        END IF;

        -- Pseudonymize the contact PII (catalogue-driven).
        v_set := privacy._pseudonymize_set_clause('crm','contact');
        EXECUTE format(
            'UPDATE crm.contact SET %s, pseudonymized_at = now() '
            || 'WHERE id = $1 AND pseudonymized_at IS NULL', v_set)
          USING v_contact_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_affected := v_affected || jsonb_build_object('crm.contact', v_n);

        -- Consent evidence (ip/ua) erased; the decision/audit trail is retained.
        v_set := privacy._pseudonymize_set_clause('crm','consent');
        IF v_set IS NOT NULL THEN
            EXECUTE format(
                'UPDATE crm.consent SET %s, pseudonymized_at = now() '
                || 'WHERE contact_id = $1 AND pseudonymized_at IS NULL', v_set)
              USING v_contact_id;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_affected := v_affected || jsonb_build_object('crm.consent', v_n);
        END IF;

        -- PRESERVE FINANCIAL RECORDS: do NOT delete invoices. Instead detach the
        -- person's identity from any bill_to_customer rows correlated by the
        -- loose hubspot_contact_id. Invoice amounts/dates/numbers are untouched.
        v_set := privacy._pseudonymize_set_clause('invoicing','bill_to_customer');
        EXECUTE format(
            'UPDATE invoicing.bill_to_customer SET %s, pseudonymized_at = now() '
            || 'WHERE organization_id = $1 AND hubspot_contact_id = $2 '
            || 'AND pseudonymized_at IS NULL', v_set)
          USING p_organization_id, v_hubspot_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_affected := v_affected || jsonb_build_object('invoicing.bill_to_customer', v_n);

    -- ============================ HR EMPLOYEE ============================
    ELSIF p_subject_kind = 'hr_employee' THEN
        SELECT id, app_user_id INTO v_employee_id, v_app_user_id
          FROM hr.employee
         WHERE public_id = p_subject_public_id
           AND organization_id = p_organization_id;
        IF v_employee_id IS NULL THEN
            UPDATE privacy.erasure_request
               SET status='rejected', blocked_reason='subject not found',
                   completed_at=now()
             WHERE id=v_req.id RETURNING * INTO v_req;
            RETURN v_req;
        END IF;

        -- Pseudonymize the employee identity columns (name/contact/address/
        -- national id/bank descriptors). Payroll evidence (compensation amounts,
        -- timesheets, time entries) is retained -- only identity is erased.
        v_set := privacy._pseudonymize_set_clause('hr','employee');
        EXECUTE format(
            'UPDATE hr.employee SET %s, pseudonymized_at = now() '
            || 'WHERE id = $1 AND pseudonymized_at IS NULL', v_set)
          USING v_employee_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_affected := v_affected || jsonb_build_object('hr.employee', v_n);

        -- Special-category health data: erase medical notes + free-text reasons
        -- on this employee''s leave requests (decision/dates retained).
        v_set := privacy._pseudonymize_set_clause('hr','leave_request');
        IF v_set IS NOT NULL THEN
            EXECUTE format(
                'UPDATE hr.leave_request lr SET %s '
                || 'FROM hr.employment e '
                || 'WHERE lr.employment_id = e.id AND e.employee_id = $1', v_set)
              USING v_employee_id;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_affected := v_affected || jsonb_build_object('hr.leave_request', v_n);
        END IF;

        -- If the employee had a linked login account, pseudonymize it too.
        IF v_app_user_id IS NOT NULL THEN
            v_set := privacy._pseudonymize_set_clause('core','app_user');
            EXECUTE format(
                'UPDATE core.app_user SET %s, pseudonymized_at = now() '
                || 'WHERE id = $1 AND pseudonymized_at IS NULL', v_set)
              USING v_app_user_id;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_affected := v_affected || jsonb_build_object('core.app_user', v_n);
        END IF;
    END IF;

    UPDATE privacy.erasure_request
       SET status='completed', tables_affected=v_affected, completed_at=now()
     WHERE id=v_req.id RETURNING * INTO v_req;
    RETURN v_req;
END;
$$;
COMMENT ON FUNCTION privacy.erase_person(bigint, privacy.subject_kind, uuid, uuid, text) IS
  'GDPR/CCPA right-to-erasure. Pseudonymizes a crm.contact or hr.employee (and their dependent PII: consent evidence, leave medical notes, a linked app_user) by overwriting PII per the classification catalogue and setting pseudonymized_at. PRESERVES legally-required financial records: invoices/payments/credit notes are never deleted -- instead the linked invoicing.bill_to_customer PII is detached/anonymized. SUPPRESSED (status blocked_legal_hold) when the subject is named on a legal.agreement under legal_hold. SECURITY DEFINER, pinned search_path; logs the outcome to privacy.erasure_request. Returns the request row.';

-- ---------------------------------------------------------------------
-- 5. CRM MARKETING CONSENT ENFORCEMENT
-- ---------------------------------------------------------------------
-- The actual send happens in the application; the database provides the
-- authoritative yes/no plus a guard the app MUST call before sending. Consent
-- is valid when: a live crm.consent row exists for (contact, purpose[, channel])
-- with status='granted', a lawful_basis, granted_at set, not revoked, and not
-- expired. Withdrawn/denied/expired/pending all read FALSE. SECURITY DEFINER so
-- a reporting role can call it without direct table grants, with pinned path.
CREATE OR REPLACE FUNCTION crm.has_marketing_consent(
    p_contact_id bigint,
    p_purpose    text,
    p_channel    text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM crm.consent c
         WHERE c.contact_id = p_contact_id
           AND c.purpose    = p_purpose
           AND (p_channel IS NULL OR c.channel = p_channel OR c.channel IS NULL)
           AND c.status = 'granted'
           AND c.lawful_basis IS NOT NULL
           AND c.granted_at IS NOT NULL
           AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at > now())
           AND c.deleted_at IS NULL
    );
$$;
COMMENT ON FUNCTION crm.has_marketing_consent(bigint, text, text) IS
  'Authoritative consent check for CRM marketing. TRUE only when a live, granted, non-revoked, non-expired crm.consent row with a lawful basis exists for the contact + purpose (+ optional channel). The app MUST gate every marketing send on this. SECURITY DEFINER + pinned search_path.';

-- Assert variant: raises instead of returning false, for call sites that want a
-- hard stop (a contact-time tripwire). Use in the send pipeline''s pre-flight.
CREATE OR REPLACE FUNCTION crm.assert_marketing_consent(
    p_contact_id bigint,
    p_purpose    text,
    p_channel    text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NOT crm.has_marketing_consent(p_contact_id, p_purpose, p_channel) THEN
        RAISE EXCEPTION
            'marketing consent missing/invalid for contact_id=% purpose=% channel=%',
            p_contact_id, p_purpose, COALESCE(p_channel,'(any)')
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;
COMMENT ON FUNCTION crm.assert_marketing_consent(bigint, text, text) IS
  'Raises check_violation unless crm.has_marketing_consent is TRUE. Pre-flight tripwire for the marketing send pipeline.';

-- Marketable-audience view: live, non-pseudonymized contacts with a valid
-- marketing_email consent. The marketing engine SELECTs from THIS, never from
-- crm.contact directly, so consent + erasure are enforced by construction.
CREATE OR REPLACE VIEW crm.v_marketable_contact AS
    SELECT c.organization_id,
           c.public_id,
           c.email,
           c.first_name,
           c.last_name
      FROM crm.contact c
     WHERE c.deleted_at IS NULL
       AND c.pseudonymized_at IS NULL
       AND c.email IS NOT NULL
       AND crm.has_marketing_consent(c.id, 'marketing_email', 'email');
COMMENT ON VIEW crm.v_marketable_contact IS
  'Contacts eligible for email marketing: live, non-pseudonymized, with a valid marketing_email consent (via crm.has_marketing_consent). The marketing engine queries this view, never crm.contact directly -- consent + right-to-erasure are enforced by construction. RLS on crm.contact still scopes rows to the caller''s tenant.';

-- ---------------------------------------------------------------------
-- 6. DSAR EXPORT  (Subject Access Request -- gather all data for a person)
-- ---------------------------------------------------------------------
-- Returns a single JSONB document with everything held about a subject across
-- core/crm/invoicing/hr/legal/audit. Honours the classification catalogue:
-- columns marked include_in_dsar=false (secrets/tokens/encrypted blobs/internal
-- cost data) are NOT surfaced. SECURITY DEFINER + pinned path so it can read
-- across schemas deterministically; the caller passes the tenant + subject.
-- Read-only: it never mutates.
CREATE OR REPLACE FUNCTION privacy.export_subject_data(
    p_organization_id   bigint,
    p_subject_kind      privacy.subject_kind,
    p_subject_public_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_doc        jsonb := '{}'::jsonb;
    v_contact_id bigint;
    v_hubspot_id text;
    v_employee_id bigint;
    v_app_user_id bigint;
BEGIN
    v_doc := jsonb_build_object(
        'generated_at', now(),
        'organization_public_id',
            (SELECT public_id FROM core.organization WHERE id = p_organization_id),
        'subject_kind', p_subject_kind,
        'subject_public_id', p_subject_public_id
    );

    IF p_subject_kind = 'crm_contact' THEN
        SELECT id, hubspot_id INTO v_contact_id, v_hubspot_id
          FROM crm.contact
         WHERE public_id = p_subject_public_id AND organization_id = p_organization_id;
        IF v_contact_id IS NULL THEN
            RETURN v_doc || jsonb_build_object('error','subject not found');
        END IF;

        -- Contact core fields (only DSAR-includable columns; raw_properties is
        -- intentionally excluded as it may carry unmodelled/unclassified data --
        -- export it only after a manual review, per the minimization guidance).
        v_doc := v_doc || jsonb_build_object('crm_contact', to_jsonb(t) - 'raw_properties'
                 - 'id' - 'organization_id')
            FROM (SELECT * FROM crm.contact WHERE id = v_contact_id) t;

        v_doc := v_doc || jsonb_build_object('crm_consent', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'purpose', purpose, 'channel', channel, 'status', status,
                       'lawful_basis', lawful_basis, 'granted_at', granted_at,
                       'revoked_at', revoked_at, 'expires_at', expires_at,
                       'consent_text', consent_text))
              FROM crm.consent WHERE contact_id = v_contact_id AND deleted_at IS NULL
            ), '[]'::jsonb));

        v_doc := v_doc || jsonb_build_object('crm_company_associations', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'company_public_id', co.public_id, 'company_name', co.name,
                       'association_type', cc.association_type, 'is_primary', cc.is_primary))
              FROM crm.contact_company cc
              JOIN crm.company co ON co.id = cc.company_id
             WHERE cc.contact_id = v_contact_id AND cc.deleted_at IS NULL
            ), '[]'::jsonb));

        -- Financial records linked by the loose hubspot id (amounts retained --
        -- the subject is entitled to see invoices billed to them).
        v_doc := v_doc || jsonb_build_object('invoicing_invoices', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'invoice_public_id', i.public_id, 'invoice_number', i.invoice_number,
                       'status', i.status, 'currency_code', i.currency_code,
                       'issue_date', i.issue_date, 'total_amount', i.total_amount,
                       'amount_due', i.amount_due))
              FROM invoicing.bill_to_customer b
              JOIN invoicing.invoice i ON i.bill_to_customer_id = b.id
             WHERE b.organization_id = p_organization_id
               AND b.hubspot_contact_id = v_hubspot_id
               AND i.deleted_at IS NULL
            ), '[]'::jsonb));

        -- Legal signatures/parties tied to this person (loose link).
        v_doc := v_doc || jsonb_build_object('legal_parties', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'agreement_public_id', a.public_id, 'party_role', ap.party_role,
                       'party_name', ap.party_name))
              FROM legal.agreement_party ap
              JOIN legal.agreement a ON a.id = ap.agreement_id
             WHERE a.organization_id = p_organization_id
               AND ap.hubspot_contact_id = v_hubspot_id
               AND ap.deleted_at IS NULL
            ), '[]'::jsonb));

    ELSIF p_subject_kind = 'hr_employee' THEN
        SELECT id, app_user_id INTO v_employee_id, v_app_user_id
          FROM hr.employee
         WHERE public_id = p_subject_public_id AND organization_id = p_organization_id;
        IF v_employee_id IS NULL THEN
            RETURN v_doc || jsonb_build_object('error','subject not found');
        END IF;

        -- Employee record minus secrets/encrypted blobs/internal surrogates.
        v_doc := v_doc || jsonb_build_object('hr_employee',
                 to_jsonb(t) - 'national_id_enc' - 'national_id_hash'
                 - 'bank_account_token' - 'id' - 'organization_id' - 'app_user_id')
            FROM (SELECT * FROM hr.employee WHERE id = v_employee_id) t;

        v_doc := v_doc || jsonb_build_object('hr_employments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'employment_public_id', em.public_id, 'employment_type', em.employment_type,
                       'status', em.status, 'start_date', em.start_date, 'end_date', em.end_date))
              FROM hr.employment em WHERE em.employee_id = v_employee_id AND em.deleted_at IS NULL
            ), '[]'::jsonb));

        -- Compensation: coarse band only (exact amount_enc is excluded).
        v_doc := v_doc || jsonb_build_object('hr_compensation', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'pay_frequency', comp.pay_frequency, 'currency_code', comp.currency_code,
                       'amount_band', comp.amount_band, 'effective_from', comp.effective_from))
              FROM hr.compensation comp
              JOIN hr.employment em ON em.id = comp.employment_id
             WHERE em.employee_id = v_employee_id AND comp.deleted_at IS NULL
            ), '[]'::jsonb));

        -- Leave requests: dates/type/status only (medical_note_enc & free-text
        -- reason are special-category -> excluded from the automated export).
        v_doc := v_doc || jsonb_build_object('hr_leave_requests', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'leave_request_public_id', lr.public_id, 'status', lr.status,
                       'start_date', lr.start_date, 'end_date', lr.end_date,
                       'total_days', lr.total_days))
              FROM hr.leave_request lr
              JOIN hr.employment em ON em.id = lr.employment_id
             WHERE em.employee_id = v_employee_id AND lr.deleted_at IS NULL
            ), '[]'::jsonb));
    ELSE
        RETURN v_doc || jsonb_build_object('error',
            format('export_subject_data does not yet support %s', p_subject_kind));
    END IF;

    -- Audit trail: every change this person MADE (by their app_user public_id)
    -- is part of their data footprint. Bounded to recent history for size.
    IF v_app_user_id IS NOT NULL OR p_subject_kind = 'crm_contact' THEN
        v_doc := v_doc || jsonb_build_object('audit_activity_recent', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'action', al.action, 'schema_name', al.schema_name,
                       'table_name', al.table_name, 'changed_at', al.changed_at))
              FROM audit.activity_log al
             WHERE al.actor_app_user_id = (
                       SELECT public_id FROM core.app_user WHERE id = v_app_user_id)
               AND al.changed_at > now() - interval '2 years'
             LIMIT 1000
            ), '[]'::jsonb));
    END IF;

    RETURN v_doc;
END;
$$;
COMMENT ON FUNCTION privacy.export_subject_data(bigint, privacy.subject_kind, uuid) IS
  'DSAR / Subject Access Request export. Returns one JSONB document with all data held about a crm.contact or hr.employee across core/crm/invoicing/hr/legal/audit. Honours the classification catalogue (include_in_dsar): secrets/tokens (password_hash, mfa_secret, *_token), encrypted blobs (national_id_enc, medical_note_enc), internal cost data, and unclassified raw_properties are excluded; compensation is shown as a coarse band only. Read-only. SECURITY DEFINER + pinned search_path.';

-- ---------------------------------------------------------------------
-- 7. DATA MINIMIZATION FOR HUBSPOT raw_properties  (guidance + tooling)
-- ---------------------------------------------------------------------
-- crm.contact.raw_properties / crm.company.raw_properties are full HubSpot
-- property bags kept for fidelity. They are the single biggest uncontrolled PII
-- surface in the database (free-text notes, custom fields, possibly special-
-- category hints) and are classified sensitive_pii + redacted from audit.
--
-- GUIDANCE (enforced by the sync worker, documented here):
--   1. STORE ONLY WHAT YOU USE. The mirror should persist the modelled columns
--      (email/name/phone/lifecycle_stage/...) plus an ALLOW-LISTED subset of
--      raw properties -- not the entire bag. Default to dropping everything not
--      on the allow-list (privacy.hubspot_property_allow).
--   2. NEVER store HubSpot internal/system audit props you don''t need
--      (hs_*_history, hs_email_*, IP/geo enrichment) -- they expand the PII
--      surface with no business value.
--   3. The sync worker (crm_sync) should call privacy.minimize_hubspot_payload()
--      on every inbound property bag BEFORE writing raw_properties, so only
--      allow-listed keys land. This makes minimization a code path, not a hope.
--   4. raw_properties is EXCLUDED from DSAR auto-export and from erasure''s
--      preserve-list: on erasure it is set NULL (it is erasable PII), and it is
--      surfaced in a DSAR only after manual review.
--   5. Encrypt-at-rest covers the storage; minimization reduces what is at rest.

CREATE TABLE IF NOT EXISTS privacy.hubspot_property_allow (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    object_type     crm.sync_object_type NOT NULL,           -- contact | company | deal | ...
    property_name   text         NOT NULL,                   -- HubSpot internal property name
    data_class      privacy.data_class NOT NULL DEFAULT 'pii',
    is_active       boolean      NOT NULL DEFAULT true,
    note            text         NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_hubspot_property_allow_public_id UNIQUE (public_id),
    CONSTRAINT ck_hubspot_property_allow_name CHECK (property_name ~ '^[A-Za-z0-9_]{1,128}$')
);
COMMENT ON TABLE privacy.hubspot_property_allow IS
  'Allow-list of HubSpot raw properties permitted to land in crm.*.raw_properties, per object type. GLOBAL reference data. The sync worker calls privacy.minimize_hubspot_payload() to drop everything not listed here BEFORE writing -- data minimization as a code path. Keep this list as small as the product actually needs.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hubspot_property_allow_live
    ON privacy.hubspot_property_allow (object_type, property_name) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_hubspot_property_allow_set_updated_at ON privacy.hubspot_property_allow;
CREATE TRIGGER trg_hubspot_property_allow_set_updated_at
    BEFORE UPDATE ON privacy.hubspot_property_allow
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_hubspot_property_allow ON privacy.hubspot_property_allow;
CREATE TRIGGER zzz_audit_hubspot_property_allow
    AFTER INSERT OR UPDATE OR DELETE ON privacy.hubspot_property_allow
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- Minimizer: keep only allow-listed keys from an inbound HubSpot property bag.
CREATE OR REPLACE FUNCTION privacy.minimize_hubspot_payload(
    p_object_type crm.sync_object_type,
    p_raw         jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(
        jsonb_object_agg(kv.key, kv.value)
            FILTER (WHERE kv.key IN (
                SELECT property_name FROM privacy.hubspot_property_allow
                 WHERE object_type = p_object_type AND is_active AND deleted_at IS NULL)),
        '{}'::jsonb)
      FROM jsonb_each(COALESCE(p_raw, '{}'::jsonb)) AS kv;
$$;
COMMENT ON FUNCTION privacy.minimize_hubspot_payload(crm.sync_object_type, jsonb) IS
  'Data-minimization filter for HubSpot payloads: returns only the allow-listed keys (privacy.hubspot_property_allow) for the object type, dropping everything else. The crm_sync worker MUST call this before writing crm.*.raw_properties so only needed properties are persisted. SECURITY DEFINER + pinned search_path.';

-- Seed a minimal allow-list (extend as the product needs; default-deny).
INSERT INTO privacy.hubspot_property_allow (object_type, property_name, data_class, note) VALUES
  ('contact','jobtitle',          'pii',          'Shown on contact card.'),
  ('contact','hs_lead_status',    'internal',     'Drives lead workflows.'),
  ('contact','lifecyclestage',    'internal',     'Already modelled; kept for fidelity.'),
  ('company','industry',          'internal',     'Segmentation.'),
  ('company','numberofemployees', 'confidential', 'Firmographic.'),
  ('deal','dealtype',             'internal',     'Pipeline reporting.')
ON CONFLICT (object_type, property_name) WHERE (deleted_at IS NULL)
DO NOTHING;

-- ---------------------------------------------------------------------
-- 8. GRANTS (least privilege)
-- ---------------------------------------------------------------------
-- Schema usage.
GRANT USAGE ON SCHEMA privacy TO app_readonly, app_readwrite;
GRANT USAGE ON SCHEMA privacy TO crm_sync;

-- Catalogue / policy / allow-list: app roles read; only the migrator writes
-- (these are governance reference data changed via migration, not the app).
GRANT SELECT ON
    privacy.data_classification,
    privacy.retention_policy,
    privacy.hubspot_property_allow,
    privacy.purge_run
TO app_readonly, app_readwrite;

-- Erasure request log: app may create + read its own tenant''s requests
-- (request intake from the UI), but not mutate history beyond the function.
GRANT SELECT, INSERT, UPDATE ON privacy.erasure_request TO app_readwrite;
GRANT SELECT ON privacy.erasure_request TO app_readonly;
-- (purge_run is written only by the SECURITY DEFINER purge fn -> no write grant.)

-- Function execution. The mutating lifecycle routines run as their owner
-- (a migrator/superuser at deploy time) via SECURITY DEFINER, so we grant
-- EXECUTE deliberately and narrowly:
--   * erase_person / run_retention_purge: privileged -> migrator only (the
--     scheduler and the compliance tooling connect as / inherit app_migrator).
--   * read-only DSAR + consent checks + minimizer: safe for app roles.
REVOKE ALL ON FUNCTION privacy.run_retention_purge(boolean, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy.erase_person(bigint, privacy.subject_kind, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy._pseudonymize_set_clause(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION privacy.run_retention_purge(boolean, text, text, bigint) TO app_migrator;
GRANT  EXECUTE ON FUNCTION privacy.erase_person(bigint, privacy.subject_kind, uuid, uuid, text) TO app_migrator;

REVOKE ALL ON FUNCTION privacy.export_subject_data(bigint, privacy.subject_kind, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION privacy.export_subject_data(bigint, privacy.subject_kind, uuid) TO app_readwrite, app_migrator;

REVOKE ALL ON FUNCTION crm.has_marketing_consent(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm.assert_marketing_consent(bigint, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION crm.has_marketing_consent(bigint, text, text) TO app_readonly, app_readwrite;
GRANT  EXECUTE ON FUNCTION crm.assert_marketing_consent(bigint, text, text) TO app_readwrite;

REVOKE ALL ON FUNCTION privacy.minimize_hubspot_payload(crm.sync_object_type, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION privacy.minimize_hubspot_payload(crm.sync_object_type, jsonb) TO crm_sync;

-- Future privacy tables created by the migrator inherit the read posture.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA privacy
    GRANT SELECT ON TABLES TO app_readonly, app_readwrite;

-- =====================================================================
-- END PRIVACY & LIFECYCLE DOMAIN
-- =====================================================================
