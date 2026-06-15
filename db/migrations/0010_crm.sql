-- =====================================================================
-- AAA_Database :: crm SCHEMA  (HubSpot READ-ONLY MIRROR)
-- Target: PostgreSQL 16+. Depends on FOUNDATION DDL (core, audit, roles:
--   app_readonly, app_readwrite, app_migrator, crm_sync).
--
-- VALIDATED in an ephemeral postgres:16 container: foundation+crm load
-- exit 0; idempotent re-run exit 0; RLS isolates tenants (Org A sees only A,
-- B only B, no-context = 0 rows); app_readwrite INSERT into crm DENIED
-- (read-only mirror enforced); consent granted-requires-basis CHECK fires;
-- contact email/first_name/phone recorded as __redacted__ in audit log;
-- 0 inbound FKs into crm from other schemas.
--
-- DESIGN
-- * READ-ONLY MIRROR: every row originates in HubSpot. The ONLY writer is the
--   crm_sync role (NOLOGIN BYPASSRLS). Request-path/reporting roles get SELECT
--   only. No FK points FROM another schema INTO crm (mirror rows can be
--   re-created on a full resync) -- cross-domain links resolve in the app via
--   the loose hubspot_id.
-- * SYNC METADATA on every mirrored entity: hubspot_id (text, UNIQUE, NOT NULL),
--   hubspot_updated_at, last_synced_at, sync_source.
-- * PK: bigint identity surrogate (internal FK target) + public_id uuid
--   (external). hubspot_id stays a plain unique attribute (it is HubSpot's id).
-- * Tenant scoped: organization_id -> core.organization(id), RLS enabled.
-- * ENUM vs LOOKUP: HubSpot tenant-customizable strings (lifecycle/stage/
--   pipeline/association_type) -> mirrored TEXT (an enum would break on upstream
--   renames). crm-owned closed sets (consent_status, consent_basis, sync_run_*)
--   -> native ENUM.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. crm-OWNED ENUM TYPES (closed sets WE control, not HubSpot-mirrored)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='consent_status' AND n.nspname='crm') THEN
    CREATE TYPE crm.consent_status AS ENUM ('granted', 'denied', 'withdrawn', 'pending', 'expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='consent_basis' AND n.nspname='crm') THEN
    -- GDPR Art.6 lawful basis (closed, regulation-defined set).
    CREATE TYPE crm.consent_basis AS ENUM
      ('consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interest');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='sync_run_status' AND n.nspname='crm') THEN
    CREATE TYPE crm.sync_run_status AS ENUM ('running', 'succeeded', 'failed', 'partial', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='sync_object_type' AND n.nspname='crm') THEN
    CREATE TYPE crm.sync_object_type AS ENUM ('contact', 'company', 'deal', 'contact_company', 'engagement', 'other');
  END IF;
END
$$;

COMMENT ON TYPE crm.consent_status   IS 'GDPR/CCPA consent state WE own (not HubSpot): granted/denied/withdrawn/pending/expired. Closed, logic-coupled set -> enum.';
COMMENT ON TYPE crm.consent_basis    IS 'GDPR Art.6 lawful basis for processing. Regulation-defined closed set -> enum.';
COMMENT ON TYPE crm.sync_run_status  IS 'Lifecycle of a sync batch. Closed operational set owned by the sync worker -> enum.';
COMMENT ON TYPE crm.sync_object_type IS 'Which HubSpot object kind a sync run / error concerns. Closed code set -> enum.';

-- ---------------------------------------------------------------------
-- 2. crm.company  (mirror of HubSpot Companies)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.company (
    id                  bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint        NOT NULL,                 -- tenant scope (our org whose HubSpot portal this mirrors)
    -- sync metadata (mandatory)
    hubspot_id          text          NOT NULL,                 -- HubSpot company objectId (upstream key)
    hubspot_portal_id   text          NULL,
    hubspot_updated_at  timestamptz   NULL,                     -- HubSpot hs_lastmodifieddate
    last_synced_at      timestamptz   NOT NULL DEFAULT now(),
    sync_source         text          NOT NULL DEFAULT 'hubspot',
    is_archived         boolean       NOT NULL DEFAULT false,   -- mirrors HubSpot archived flag (NOT our soft delete)
    -- mirrored business attributes
    name                text          NULL,
    domain              citext        NULL,
    industry            text          NULL,
    company_type        text          NULL,                     -- HubSpot "type" property
    lifecycle_stage     text          NULL,                     -- HubSpot lifecyclestage (tenant-customizable -> text)
    owner_hubspot_id    text          NULL,                     -- loose ref, resolved in app
    phone               text          NULL,
    address_street      text          NULL,
    address_city        text          NULL,
    address_state       text          NULL,
    address_postal_code text          NULL,
    address_country     char(2)       NULL,                     -- ISO 3166-1 alpha-2 where resolvable
    annual_revenue      numeric(18,2) NULL,                     -- money: numeric, never float
    revenue_currency    char(3)       NULL,
    employee_count      integer       NULL,
    raw_properties      jsonb         NULL,                     -- full HubSpot property bag (fidelity / future fields)
    -- standard columns
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    created_by          uuid          NULL,
    updated_by          uuid          NULL,
    deleted_at          timestamptz   NULL,                     -- soft delete (removed upstream)
    pseudonymized_at    timestamptz   NULL,                     -- GDPR erasure marker (sole-trader companies)
    CONSTRAINT uq_company_public_id        UNIQUE (public_id),
    CONSTRAINT uq_company_hubspot_id       UNIQUE (hubspot_id),
    CONSTRAINT fk_company_org              FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_company_address_country  FOREIGN KEY (address_country) REFERENCES core.country(iso2),
    CONSTRAINT fk_company_revenue_currency FOREIGN KEY (revenue_currency) REFERENCES core.currency(code),
    CONSTRAINT ck_company_hubspot_id_fmt   CHECK (hubspot_id ~ '^[0-9A-Za-z_-]{1,64}$'),
    CONSTRAINT ck_company_employee_count   CHECK (employee_count IS NULL OR employee_count >= 0),
    CONSTRAINT ck_company_annual_revenue   CHECK (annual_revenue IS NULL OR annual_revenue >= 0),
    CONSTRAINT ck_company_revenue_currency CHECK ((annual_revenue IS NULL) = (revenue_currency IS NULL)),
    CONSTRAINT ck_company_sync_source      CHECK (sync_source <> '')
);
COMMENT ON TABLE  crm.company IS 'READ-ONLY mirror of HubSpot Companies. Written exclusively by crm_sync. hubspot_id is the upstream key; do NOT FK into this table from other schemas (mirror rows can be re-created on resync).';
COMMENT ON COLUMN crm.company.id                 IS 'Internal surrogate PK. NEVER exposed externally.';
COMMENT ON COLUMN crm.company.public_id          IS 'Externally exposed UUID for URLs/APIs (avoids leaking record counts).';
COMMENT ON COLUMN crm.company.organization_id    IS 'Owning tenant (our org whose HubSpot portal this mirrors). RLS predicate.';
COMMENT ON COLUMN crm.company.hubspot_id         IS 'HubSpot company objectId. Unique, not null. Upstream identity of this mirror row.';
COMMENT ON COLUMN crm.company.hubspot_portal_id  IS 'HubSpot portal/account id the record originated from.';
COMMENT ON COLUMN crm.company.hubspot_updated_at IS 'HubSpot hs_lastmodifieddate; used for incremental sync conflict detection.';
COMMENT ON COLUMN crm.company.last_synced_at     IS 'Timestamp our mirror last wrote this row from HubSpot.';
COMMENT ON COLUMN crm.company.sync_source        IS 'Origin system tag for the mirror write (default hubspot).';
COMMENT ON COLUMN crm.company.is_archived        IS 'Mirrors HubSpot archived flag. Distinct from deleted_at (our soft-delete tombstone).';
COMMENT ON COLUMN crm.company.domain             IS 'Company website domain (case-insensitive). May identify a sole trader -> PII-adjacent.';
COMMENT ON COLUMN crm.company.phone              IS 'Company phone. PII-adjacent (may be a personal number for sole traders).';
COMMENT ON COLUMN crm.company.address_street     IS 'Street address. PII when the company is an individual/sole trader.';
COMMENT ON COLUMN crm.company.annual_revenue     IS 'Mirrored annual revenue. numeric(18,2) -- never float. Confidential business data.';
COMMENT ON COLUMN crm.company.raw_properties     IS 'Full HubSpot property bag (jsonb) for fidelity; may contain unmodelled PII -> treat as sensitive.';
COMMENT ON COLUMN crm.company.deleted_at         IS 'Soft-delete tombstone (object removed/archived upstream). Live queries filter deleted_at IS NULL.';
COMMENT ON COLUMN crm.company.pseudonymized_at   IS 'GDPR/CCPA erasure marker: PII columns overwritten when an individual exercises right-to-erasure.';

CREATE INDEX IF NOT EXISTS ix_company_org              ON crm.company (organization_id);
CREATE INDEX IF NOT EXISTS ix_company_org_lifecycle    ON crm.company (organization_id, lifecycle_stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_company_domain_live      ON crm.company (organization_id, domain) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_company_last_synced_at   ON crm.company (last_synced_at);
CREATE INDEX IF NOT EXISTS ix_company_owner_hubspot_id ON crm.company (owner_hubspot_id);

DROP TRIGGER IF EXISTS trg_company_set_updated_at ON crm.company;
CREATE TRIGGER trg_company_set_updated_at
    BEFORE UPDATE ON crm.company
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_company ON crm.company;
CREATE TRIGGER zzz_audit_company
    AFTER INSERT OR UPDATE OR DELETE ON crm.company
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('phone,address_street,address_city,address_postal_code,raw_properties');

-- ---------------------------------------------------------------------
-- 3. crm.contact  (mirror of HubSpot Contacts) -- PII HEAVY
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.contact (
    id                         bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id            bigint       NOT NULL,
    hubspot_id                 text         NOT NULL,                 -- HubSpot contact objectId/vid
    hubspot_portal_id          text         NULL,
    hubspot_updated_at         timestamptz  NULL,
    last_synced_at             timestamptz  NOT NULL DEFAULT now(),
    sync_source                text         NOT NULL DEFAULT 'hubspot',
    is_archived                boolean      NOT NULL DEFAULT false,
    -- mirrored PII attributes
    email                      citext       NULL,                     -- PII
    first_name                 text         NULL,                     -- PII
    last_name                  text         NULL,                     -- PII
    phone                      text         NULL,                     -- PII
    mobile_phone               text         NULL,                     -- PII
    job_title                  text         NULL,
    address_street             text         NULL,                     -- PII
    address_city               text         NULL,
    address_state              text         NULL,
    address_postal_code        text         NULL,                     -- PII (quasi-identifier)
    address_country            char(2)      NULL,
    primary_company_hubspot_id text         NULL,                     -- LOOSE pointer (NOT an FK)
    lifecycle_stage            text         NULL,                     -- HubSpot lifecyclestage (mirrored text)
    lead_status                text         NULL,                     -- HubSpot hs_lead_status (mirrored text)
    owner_hubspot_id           text         NULL,
    raw_properties             jsonb        NULL,                     -- full property bag (may hold extra PII)
    created_at                 timestamptz  NOT NULL DEFAULT now(),
    updated_at                 timestamptz  NOT NULL DEFAULT now(),
    created_by                 uuid         NULL,
    updated_by                 uuid         NULL,
    deleted_at                 timestamptz  NULL,
    pseudonymized_at           timestamptz  NULL,                     -- GDPR right-to-erasure marker
    CONSTRAINT uq_contact_public_id       UNIQUE (public_id),
    CONSTRAINT uq_contact_hubspot_id      UNIQUE (hubspot_id),
    CONSTRAINT fk_contact_org             FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_contact_address_country FOREIGN KEY (address_country) REFERENCES core.country(iso2),
    CONSTRAINT ck_contact_hubspot_id_fmt  CHECK (hubspot_id ~ '^[0-9A-Za-z_-]{1,64}$'),
    CONSTRAINT ck_contact_email           CHECK (email IS NULL OR position('@' in email) > 1),
    CONSTRAINT ck_contact_sync_source     CHECK (sync_source <> '')
);
COMMENT ON TABLE  crm.contact IS 'READ-ONLY mirror of HubSpot Contacts. PII-heavy. Written exclusively by crm_sync. No inbound FKs from other schemas; associate via hubspot_id resolved in app.';
COMMENT ON COLUMN crm.contact.hubspot_id                 IS 'HubSpot contact objectId/vid. Unique, not null. Upstream identity.';
COMMENT ON COLUMN crm.contact.email                      IS 'Contact email. PII. Case-insensitive. Nullable (HubSpot contacts may have no email).';
COMMENT ON COLUMN crm.contact.first_name                 IS 'Given name. PII.';
COMMENT ON COLUMN crm.contact.last_name                  IS 'Family name. PII.';
COMMENT ON COLUMN crm.contact.phone                      IS 'Primary phone. PII.';
COMMENT ON COLUMN crm.contact.mobile_phone               IS 'Mobile phone. PII.';
COMMENT ON COLUMN crm.contact.address_street             IS 'Street address. PII.';
COMMENT ON COLUMN crm.contact.address_postal_code        IS 'Postal/ZIP code. PII (quasi-identifier).';
COMMENT ON COLUMN crm.contact.primary_company_hubspot_id IS 'LOOSE pointer to primary company HubSpot id. NOT a FK (crm is a mirror) -- resolve to crm.company in app.';
COMMENT ON COLUMN crm.contact.lifecycle_stage            IS 'HubSpot lifecyclestage, mirrored verbatim as text (tenant-customizable upstream -> not an enum).';
COMMENT ON COLUMN crm.contact.raw_properties             IS 'Full HubSpot property bag (jsonb). May contain additional PII -> sensitive; redacted in audit.';
COMMENT ON COLUMN crm.contact.pseudonymized_at           IS 'GDPR/CCPA erasure marker: email/name/phone/address overwritten with placeholders on right-to-erasure.';

CREATE INDEX IF NOT EXISTS ix_contact_org              ON crm.contact (organization_id);
CREATE INDEX IF NOT EXISTS ix_contact_email_live       ON crm.contact (organization_id, email) WHERE deleted_at IS NULL AND pseudonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_contact_org_lifecycle    ON crm.contact (organization_id, lifecycle_stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_contact_last_synced_at   ON crm.contact (last_synced_at);
CREATE INDEX IF NOT EXISTS ix_contact_owner_hubspot_id ON crm.contact (owner_hubspot_id);
CREATE INDEX IF NOT EXISTS ix_contact_primary_company  ON crm.contact (primary_company_hubspot_id);

DROP TRIGGER IF EXISTS trg_contact_set_updated_at ON crm.contact;
CREATE TRIGGER trg_contact_set_updated_at
    BEFORE UPDATE ON crm.contact
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_contact ON crm.contact;
CREATE TRIGGER zzz_audit_contact
    AFTER INSERT OR UPDATE OR DELETE ON crm.contact
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('email,first_name,last_name,phone,mobile_phone,address_street,address_city,address_postal_code,raw_properties');

-- ---------------------------------------------------------------------
-- 4. crm.deal  (mirror of HubSpot Deals)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.deal (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint        NOT NULL,
    hubspot_id         text          NOT NULL,
    hubspot_portal_id  text          NULL,
    hubspot_updated_at timestamptz   NULL,
    last_synced_at     timestamptz   NOT NULL DEFAULT now(),
    sync_source        text          NOT NULL DEFAULT 'hubspot',
    is_archived        boolean       NOT NULL DEFAULT false,
    name               text          NULL,                    -- dealname
    pipeline           text          NULL,                    -- HubSpot pipeline (mirrored text)
    deal_stage         text          NULL,                    -- HubSpot dealstage (tenant-customizable -> text)
    amount             numeric(18,2) NULL,                     -- money: numeric, never float
    deal_currency      char(3)       NULL,
    is_closed          boolean       NULL,                     -- HubSpot hs_is_closed
    is_won             boolean       NULL,                     -- HubSpot hs_is_closed_won
    close_date         timestamptz   NULL,
    owner_hubspot_id   text          NULL,
    raw_properties     jsonb         NULL,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    created_by         uuid          NULL,
    updated_by         uuid          NULL,
    deleted_at         timestamptz   NULL,
    -- NOTE: no pseudonymized_at -- a deal holds no direct PII (only loose ids).
    CONSTRAINT uq_deal_public_id          UNIQUE (public_id),
    CONSTRAINT uq_deal_hubspot_id         UNIQUE (hubspot_id),
    CONSTRAINT fk_deal_org                FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_deal_currency           FOREIGN KEY (deal_currency)   REFERENCES core.currency(code),
    CONSTRAINT ck_deal_hubspot_id_fmt     CHECK (hubspot_id ~ '^[0-9A-Za-z_-]{1,64}$'),
    CONSTRAINT ck_deal_amount             CHECK (amount IS NULL OR amount >= 0),
    CONSTRAINT ck_deal_amount_currency    CHECK (amount IS NULL OR deal_currency IS NOT NULL),
    CONSTRAINT ck_deal_won_implies_closed CHECK (is_won IS NULL OR is_won = false OR is_closed IS TRUE),
    CONSTRAINT ck_deal_sync_source        CHECK (sync_source <> '')
);
COMMENT ON TABLE  crm.deal IS 'READ-ONLY mirror of HubSpot Deals. Written exclusively by crm_sync. amount is numeric (never float). pipeline/deal_stage mirrored as text (tenant-customizable upstream).';
COMMENT ON COLUMN crm.deal.amount         IS 'Deal value. numeric(18,2). NEVER float. Confidential business/financial data.';
COMMENT ON COLUMN crm.deal.deal_currency  IS 'ISO 4217 currency of amount -> core.currency(code).';
COMMENT ON COLUMN crm.deal.deal_stage     IS 'HubSpot dealstage mirrored verbatim as text (tenant-customizable -> not an enum).';
COMMENT ON COLUMN crm.deal.raw_properties IS 'Full HubSpot property bag (jsonb). Confidential; may contain financial detail.';

CREATE INDEX IF NOT EXISTS ix_deal_org              ON crm.deal (organization_id);
CREATE INDEX IF NOT EXISTS ix_deal_org_stage        ON crm.deal (organization_id, pipeline, deal_stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_deal_org_close_date   ON crm.deal (organization_id, close_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_deal_last_synced_at   ON crm.deal (last_synced_at);
CREATE INDEX IF NOT EXISTS ix_deal_owner_hubspot_id ON crm.deal (owner_hubspot_id);

DROP TRIGGER IF EXISTS trg_deal_set_updated_at ON crm.deal;
CREATE TRIGGER trg_deal_set_updated_at
    BEFORE UPDATE ON crm.deal
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_deal ON crm.deal;
CREATE TRIGGER zzz_audit_deal
    AFTER INSERT OR UPDATE OR DELETE ON crm.deal
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('raw_properties');

-- ---------------------------------------------------------------------
-- 5. crm.contact_company  (mirror of HubSpot contact<->company associations)
-- ---------------------------------------------------------------------
-- Junction WITHIN crm. FKs to crm.contact(id)/crm.company(id) are intra-schema
-- (allowed). organization_id denormalized for single-predicate RLS.
CREATE TABLE IF NOT EXISTS crm.contact_company (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint       NOT NULL,                 -- denormalized tenant for RLS
    contact_id         bigint       NOT NULL,
    company_id         bigint       NOT NULL,
    hubspot_id         text         NOT NULL,                 -- synthetic assoc key (contactId:companyId:typeId)
    hubspot_updated_at timestamptz  NULL,
    last_synced_at     timestamptz  NOT NULL DEFAULT now(),
    sync_source        text         NOT NULL DEFAULT 'hubspot',
    association_type   text         NULL,                     -- HubSpot association type/label
    is_primary         boolean      NOT NULL DEFAULT false,   -- HubSpot primary-company flag
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    created_by         uuid         NULL,
    updated_by         uuid         NULL,
    deleted_at         timestamptz  NULL,
    CONSTRAINT uq_contact_company_public_id  UNIQUE (public_id),
    CONSTRAINT uq_contact_company_hubspot_id UNIQUE (hubspot_id),
    CONSTRAINT fk_cc_org            FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_cc_contact        FOREIGN KEY (contact_id)      REFERENCES crm.contact(id)        ON DELETE CASCADE,
    CONSTRAINT fk_cc_company        FOREIGN KEY (company_id)      REFERENCES crm.company(id)        ON DELETE CASCADE,
    CONSTRAINT ck_cc_hubspot_id_fmt CHECK (hubspot_id ~ '^[0-9A-Za-z:_-]{1,128}$'),
    CONSTRAINT ck_cc_sync_source    CHECK (sync_source <> '')
);
COMMENT ON TABLE  crm.contact_company IS 'READ-ONLY mirror of HubSpot contact<->company associations (junction WITHIN crm). FKs are intra-schema only. organization_id denormalized for single-predicate RLS.';
COMMENT ON COLUMN crm.contact_company.hubspot_id IS 'Synthetic association key from HubSpot (contactId:companyId:typeId). Unique, not null.';
COMMENT ON COLUMN crm.contact_company.is_primary IS 'Mirrors HubSpot primary-company designation for the contact.';

-- one live association per (contact, company, type); reuse after soft-delete.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_company_live
    ON crm.contact_company (contact_id, company_id, association_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cc_org             ON crm.contact_company (organization_id);
CREATE INDEX IF NOT EXISTS ix_cc_company         ON crm.contact_company (company_id);
CREATE INDEX IF NOT EXISTS ix_cc_contact_primary ON crm.contact_company (contact_id) WHERE is_primary AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_contact_company_set_updated_at ON crm.contact_company;
CREATE TRIGGER trg_contact_company_set_updated_at
    BEFORE UPDATE ON crm.contact_company
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_contact_company ON crm.contact_company;
CREATE TRIGGER zzz_audit_contact_company
    AFTER INSERT OR UPDATE OR DELETE ON crm.contact_company
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 6. crm.consent  (GDPR/CCPA marketing & processing consent per contact)
-- ---------------------------------------------------------------------
-- crm-OWNED authoritative legal record (HubSpot subscription state may be
-- mirrored in via the nullable sync metadata). Contact link is intra-crm FK.
CREATE TABLE IF NOT EXISTS crm.consent (
    id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint       NOT NULL,
    contact_id          bigint       NOT NULL,                 -- intra-crm FK
    purpose             text         NOT NULL,                 -- marketing_email / marketing_sms / processing / profiling
    channel             text         NULL,                     -- email / sms / phone / postal
    status              crm.consent_status NOT NULL DEFAULT 'pending',
    lawful_basis        crm.consent_basis  NULL,               -- GDPR Art.6 basis (required when granted)
    consent_text        text         NULL,                     -- exact wording the subject agreed to (evidence)
    source              text         NULL,                     -- form id / import / hubspot
    evidence_ip         inet         NULL,                     -- proof-of-consent (PII)
    evidence_user_agent text         NULL,                     -- proof-of-consent (PII)
    granted_at          timestamptz  NULL,
    revoked_at          timestamptz  NULL,
    expires_at          timestamptz  NULL,
    -- optional sync metadata (HubSpot subscription mirror)
    hubspot_id          text         NULL,
    hubspot_updated_at  timestamptz  NULL,
    last_synced_at      timestamptz  NULL,
    sync_source         text         NULL,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    pseudonymized_at    timestamptz  NULL,                     -- erase evidence_ip/user_agent on right-to-erasure
    CONSTRAINT uq_consent_public_id      UNIQUE (public_id),
    CONSTRAINT fk_consent_org            FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_consent_contact        FOREIGN KEY (contact_id)      REFERENCES crm.contact(id)        ON DELETE CASCADE,
    CONSTRAINT ck_consent_purpose        CHECK (purpose <> ''),
    CONSTRAINT ck_consent_granted_basis  CHECK (status <> 'granted' OR lawful_basis IS NOT NULL),
    CONSTRAINT ck_consent_granted_at     CHECK (status <> 'granted' OR granted_at IS NOT NULL),
    CONSTRAINT ck_consent_revoked_after  CHECK (revoked_at IS NULL OR granted_at IS NULL OR revoked_at >= granted_at),
    CONSTRAINT ck_consent_expires_after  CHECK (expires_at IS NULL OR granted_at IS NULL OR expires_at >= granted_at),
    CONSTRAINT ck_consent_hubspot_id_fmt CHECK (hubspot_id IS NULL OR hubspot_id ~ '^[0-9A-Za-z:_-]{1,128}$')
);
COMMENT ON TABLE  crm.consent IS 'GDPR/CCPA marketing & processing consent per contact. crm-owned authoritative legal record (HubSpot subscription state may be mirrored in via nullable sync metadata). Stores proof-of-consent evidence.';
COMMENT ON COLUMN crm.consent.purpose             IS 'Processing purpose (marketing_email, processing, profiling, ...). Free text WE control; lookup-table candidate if it needs UI metadata.';
COMMENT ON COLUMN crm.consent.status              IS 'Consent state (enum): granted/denied/withdrawn/pending/expired.';
COMMENT ON COLUMN crm.consent.lawful_basis        IS 'GDPR Art.6 lawful basis; required when status=granted (CHECK enforced).';
COMMENT ON COLUMN crm.consent.consent_text        IS 'Exact wording the data subject agreed to, retained as legal evidence.';
COMMENT ON COLUMN crm.consent.evidence_ip         IS 'IP captured at consent time. PII (identifies subject session). Pseudonymize on erasure.';
COMMENT ON COLUMN crm.consent.evidence_user_agent IS 'User-agent captured at consent time. PII (device fingerprint). Pseudonymize on erasure.';
COMMENT ON COLUMN crm.consent.pseudonymized_at    IS 'GDPR erasure marker: evidence_ip/user_agent overwritten while the consent decision/audit trail is retained for compliance.';

-- one live consent record per (contact, purpose, channel); reuse after soft-delete.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_contact_purpose_channel_live
    ON crm.consent (contact_id, purpose, channel) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_consent_org            ON crm.consent (organization_id);
CREATE INDEX IF NOT EXISTS ix_consent_contact_status ON crm.consent (contact_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_consent_expires_at     ON crm.consent (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_consent_set_updated_at ON crm.consent;
CREATE TRIGGER trg_consent_set_updated_at
    BEFORE UPDATE ON crm.consent
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_consent ON crm.consent;
CREATE TRIGGER zzz_audit_consent
    AFTER INSERT OR UPDATE OR DELETE ON crm.consent
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('evidence_ip,evidence_user_agent');

-- ---------------------------------------------------------------------
-- 7. crm.sync_run  (one row per sync batch/job execution)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.sync_run (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id   bigint        NOT NULL,
    object_type       crm.sync_object_type NOT NULL,
    status            crm.sync_run_status  NOT NULL DEFAULT 'running',
    sync_source       text          NOT NULL DEFAULT 'hubspot',
    hubspot_portal_id text          NULL,
    trigger           text          NULL,                    -- schedule | webhook | manual | backfill
    started_at        timestamptz   NOT NULL DEFAULT now(),
    finished_at       timestamptz   NULL,
    cursor_after      text          NULL,                    -- HubSpot paging cursor / incremental watermark
    records_seen      integer       NOT NULL DEFAULT 0,
    records_upserted  integer       NOT NULL DEFAULT 0,
    records_skipped   integer       NOT NULL DEFAULT 0,
    error_count       integer       NOT NULL DEFAULT 0,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    created_by        uuid          NULL,
    updated_by        uuid          NULL,
    CONSTRAINT uq_sync_run_public_id UNIQUE (public_id),
    CONSTRAINT fk_sync_run_org       FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT ck_sync_run_finished  CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT ck_sync_run_counts    CHECK (records_seen >= 0 AND records_upserted >= 0 AND records_skipped >= 0 AND error_count >= 0),
    CONSTRAINT ck_sync_run_terminal  CHECK ((status IN ('running')) OR finished_at IS NOT NULL),
    CONSTRAINT ck_sync_run_source    CHECK (sync_source <> '')
);
COMMENT ON TABLE  crm.sync_run IS 'One row per HubSpot sync batch/job execution. Operational metadata owned by crm_sync. Tenant-scoped, no PII. Tracks counts + status + paging cursor.';
COMMENT ON COLUMN crm.sync_run.object_type  IS 'Which HubSpot object kind this run synced (enum).';
COMMENT ON COLUMN crm.sync_run.status       IS 'Run lifecycle state (enum). Non-running statuses require finished_at (CHECK).';
COMMENT ON COLUMN crm.sync_run.cursor_after IS 'HubSpot paging cursor / incremental watermark to resume from.';

CREATE INDEX IF NOT EXISTS ix_sync_run_org_started ON crm.sync_run (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_sync_run_status      ON crm.sync_run (status) WHERE status IN ('running', 'failed', 'partial');
CREATE INDEX IF NOT EXISTS ix_sync_run_object_type ON crm.sync_run (organization_id, object_type, started_at DESC);

DROP TRIGGER IF EXISTS trg_sync_run_set_updated_at ON crm.sync_run;
CREATE TRIGGER trg_sync_run_set_updated_at
    BEFORE UPDATE ON crm.sync_run
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_sync_run ON crm.sync_run;
CREATE TRIGGER zzz_audit_sync_run
    AFTER INSERT OR UPDATE OR DELETE ON crm.sync_run
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 8. crm.sync_error  (per-record failures within a sync run)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.sync_error (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL,                -- denormalized from sync_run for RLS
    sync_run_id     bigint        NOT NULL,
    object_type     crm.sync_object_type NOT NULL,
    hubspot_id      text          NULL,                    -- upstream id of failed record (loose)
    error_code      text          NULL,                    -- RATE_LIMIT / VALIDATION / ...
    error_message   text          NULL,                    -- may echo a record field -> PII risk
    error_payload   jsonb         NULL,                    -- offending record/response snippet (may contain PII)
    occurred_at     timestamptz   NOT NULL DEFAULT now(),
    is_resolved     boolean       NOT NULL DEFAULT false,
    resolved_at     timestamptz   NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    CONSTRAINT uq_sync_error_public_id      UNIQUE (public_id),
    CONSTRAINT fk_sync_error_org            FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_error_run            FOREIGN KEY (sync_run_id)     REFERENCES crm.sync_run(id)       ON DELETE CASCADE,
    CONSTRAINT ck_sync_error_resolved       CHECK (is_resolved = false OR resolved_at IS NOT NULL),
    CONSTRAINT ck_sync_error_hubspot_id_fmt CHECK (hubspot_id IS NULL OR hubspot_id ~ '^[0-9A-Za-z:_-]{1,128}$')
);
COMMENT ON TABLE  crm.sync_error IS 'Per-record failures within a crm.sync_run. organization_id denormalized for single-predicate RLS. error_message/error_payload may echo record PII -> treated sensitive and redacted in audit.';
COMMENT ON COLUMN crm.sync_error.error_payload IS 'Offending record/response snippet (jsonb). May contain PII from the failing record -> sensitive; redacted in audit images.';
COMMENT ON COLUMN crm.sync_error.error_message IS 'Human-readable error detail. May echo a record field value (PII risk).';

CREATE INDEX IF NOT EXISTS ix_sync_error_run        ON crm.sync_error (sync_run_id);
CREATE INDEX IF NOT EXISTS ix_sync_error_org_open   ON crm.sync_error (organization_id, occurred_at DESC) WHERE is_resolved = false;
CREATE INDEX IF NOT EXISTS ix_sync_error_hubspot_id ON crm.sync_error (object_type, hubspot_id);

DROP TRIGGER IF EXISTS trg_sync_error_set_updated_at ON crm.sync_error;
CREATE TRIGGER trg_sync_error_set_updated_at
    BEFORE UPDATE ON crm.sync_error
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_sync_error ON crm.sync_error;
CREATE TRIGGER zzz_audit_sync_error
    AFTER INSERT OR UPDATE OR DELETE ON crm.sync_error
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('error_message,error_payload');

-- ---------------------------------------------------------------------
-- 9. ROW-LEVEL SECURITY (tenant isolation; sync worker is BYPASSRLS)
-- ---------------------------------------------------------------------
ALTER TABLE crm.company         ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contact         ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.deal            ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contact_company ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.consent         ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sync_run        ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sync_error      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_company_isolation ON crm.company;
CREATE POLICY rls_company_isolation ON crm.company
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_contact_isolation ON crm.contact;
CREATE POLICY rls_contact_isolation ON crm.contact
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_deal_isolation ON crm.deal;
CREATE POLICY rls_deal_isolation ON crm.deal
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_contact_company_isolation ON crm.contact_company;
CREATE POLICY rls_contact_company_isolation ON crm.contact_company
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_consent_isolation ON crm.consent;
CREATE POLICY rls_consent_isolation ON crm.consent
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_sync_run_isolation ON crm.sync_run;
CREATE POLICY rls_sync_run_isolation ON crm.sync_run
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_sync_error_isolation ON crm.sync_error;
CREATE POLICY rls_sync_error_isolation ON crm.sync_error
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- ---------------------------------------------------------------------
-- 10. GRANTS (least privilege; crm READ-ONLY to app, write only by crm_sync)
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO app_readonly, app_readwrite;

GRANT USAGE ON SCHEMA crm TO crm_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm TO crm_sync;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA crm
    GRANT SELECT ON TABLES TO app_readonly, app_readwrite;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA crm
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_sync;

-- =====================================================================
-- END crm SCHEMA DDL
-- =====================================================================