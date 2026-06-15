-- =====================================================================
-- AAA_Database :: INVOICING SCHEMA DDL
-- Target: PostgreSQL 16+
-- Domain: Billing & invoicing. Builds on the FOUNDATION DDL (core/audit).
--
-- Conventions enforced (Foundation Conventions, NORMATIVE):
--   * Dual key: bigint identity surrogate `id` + random `public_id` uuid (UNIQUE).
--   * organization_id bigint NOT NULL -> core.organization(id) on every
--     tenant-scoped table (denormalized onto children for single-predicate RLS).
--   * Standard columns: created_at/updated_at (trigger), created_by/updated_by
--     (app_user.public_id), deleted_at soft-delete tombstone.
--   * Money: numeric(18,4); currency_code char(3) -> core.currency(code). Never float.
--   * Enum vs lookup: closed state-machine sets = native ENUM; business-editable /
--     metadata-bearing sets = lookup table (tax_rate).
--   * RLS isolation policy (USING + WITH CHECK) on every tenant-scoped table.
--   * trg_<t>_set_updated_at + zzz_audit_<t> (zzz_ => fires LAST) on every table.
--   * PAYMENTS: tokenized only. NEVER raw PAN/CVV/full bank/routing numbers.
--   * crm is a READ-ONLY mirror: NO FK into crm. Store loose hubspot_* text.
--
-- VALIDATED on PostgreSQL 16.14: fresh load (exit 0) + idempotent re-run (exit 0)
-- + functional tests (audit redaction, RLS isolation + WITH CHECK block,
-- soft-delete number reuse, money/line-kind CHECK enforcement) all green.
-- Idempotent: guarded with IF NOT EXISTS / DO blocks / DROP ... IF EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUM TYPES (closed, code-coupled lifecycle sets -> native enum)
-- ---------------------------------------------------------------------
-- DECISION: invoice/credit-note/payment LIFECYCLE statuses are native ENUMs.
-- Small, closed, tightly coupled to the application state machine; no per-row
-- display metadata and not extended at runtime by business users.
-- (Contrast: tax_rate is a LOOKUP table -- business-editable + metadata, sec 3.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='invoice_status' AND n.nspname='invoicing') THEN
    CREATE TYPE invoicing.invoice_status AS ENUM
      ('draft','sent','partially_paid','paid','overdue','void');
  END IF;
END
$$;
COMMENT ON TYPE invoicing.invoice_status IS
  'Invoice lifecycle: draft -> sent -> (partially_paid|paid|overdue) ; sent/draft -> void. Closed, state-machine-coupled set -> native enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='payment_status' AND n.nspname='invoicing') THEN
    CREATE TYPE invoicing.payment_status AS ENUM
      ('pending','authorized','succeeded','partially_refunded','refunded','failed','canceled');
  END IF;
END
$$;
COMMENT ON TYPE invoicing.payment_status IS
  'Payment lifecycle mirroring an external processor (Stripe-style). Closed code-coupled set -> native enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='payment_method_type' AND n.nspname='invoicing') THEN
    CREATE TYPE invoicing.payment_method_type AS ENUM
      ('card','bank_transfer','ach','sepa_debit','wallet','other');
  END IF;
END
$$;
COMMENT ON TYPE invoicing.payment_method_type IS
  'High-level instrument family for a tokenized payment. Drives which non-sensitive descriptor fields are populated. Closed set -> native enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='credit_note_status' AND n.nspname='invoicing') THEN
    CREATE TYPE invoicing.credit_note_status AS ENUM
      ('draft','issued','applied','void');
  END IF;
END
$$;
COMMENT ON TYPE invoicing.credit_note_status IS
  'Credit note lifecycle: draft -> issued -> applied ; -> void. Closed state-machine set -> native enum.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='line_item_kind' AND n.nspname='invoicing') THEN
    CREATE TYPE invoicing.line_item_kind AS ENUM
      ('product','service','discount','shipping','adjustment');
  END IF;
END
$$;
COMMENT ON TYPE invoicing.line_item_kind IS
  'Nature of an invoice line. product lines may reference inventory.product; non-product lines (discount/shipping) carry no product link. Closed set -> native enum.';

-- ---------------------------------------------------------------------
-- 2. BILL-TO CUSTOMER (invoicing-owned billing party)
-- ---------------------------------------------------------------------
-- WHY a local table instead of FKing crm: crm is a READ-ONLY HubSpot mirror
-- whose rows can vanish on resync, so we MUST NOT FK into it. The billing party
-- is invoicing-owned master data; it OPTIONALLY records the loose hubspot
-- company/contact ids (text) for application-side correlation.
CREATE TABLE IF NOT EXISTS invoicing.bill_to_customer (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint       NOT NULL,
    -- Loose linkage to the crm mirror (NO FK -- see conventions sec 6).
    hubspot_company_id text         NULL,
    hubspot_contact_id text         NULL,
    -- Billing party descriptors (PII when the customer is an individual).
    display_name       text         NOT NULL,
    legal_name         text         NULL,
    email              citext       NULL,                    -- billing contact email (PII)
    phone              text         NULL,                    -- billing contact phone (PII)
    tax_identifier     text         NULL,                    -- VAT/EIN/GSTIN (sensitive tax id)
    -- Billing address (PII when individual).
    address_line1      text         NULL,
    address_line2      text         NULL,
    city               text         NULL,
    region             text         NULL,                    -- state/province
    postal_code        text         NULL,
    country            char(2)      NULL,                    -- core.country(iso2)
    -- Billing defaults.
    default_currency   char(3)      NULL,                    -- core.currency(code)
    is_active          boolean      NOT NULL DEFAULT true,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    created_by         uuid         NULL,
    updated_by         uuid         NULL,
    deleted_at         timestamptz  NULL,
    pseudonymized_at   timestamptz  NULL,                    -- GDPR right-to-erasure
    CONSTRAINT uq_bill_to_customer_public_id UNIQUE (public_id),
    CONSTRAINT fk_bill_to_customer_org      FOREIGN KEY (organization_id)  REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_bill_to_customer_country  FOREIGN KEY (country)          REFERENCES core.country(iso2),
    CONSTRAINT fk_bill_to_customer_currency FOREIGN KEY (default_currency) REFERENCES core.currency(code),
    CONSTRAINT ck_bill_to_customer_email    CHECK (email IS NULL OR position('@' in email) > 1)
);
COMMENT ON TABLE  invoicing.bill_to_customer IS
  'Invoicing-owned billing party (the entity an invoice is billed to). Optionally correlated to the crm HubSpot mirror via loose hubspot_company_id / hubspot_contact_id (NO FK -- crm rows can vanish on resync). PII-bearing -> pseudonymizable.';
COMMENT ON COLUMN invoicing.bill_to_customer.id                 IS 'Internal surrogate PK. Never exposed externally.';
COMMENT ON COLUMN invoicing.bill_to_customer.public_id          IS 'Externally exposed UUID (URLs/APIs). Avoids leaking customer counts.';
COMMENT ON COLUMN invoicing.bill_to_customer.hubspot_company_id IS 'Loose reference to crm company HubSpot id. NOT a FK (crm is a resyncable mirror); resolved in the application.';
COMMENT ON COLUMN invoicing.bill_to_customer.hubspot_contact_id IS 'Loose reference to crm contact HubSpot id. NOT a FK; resolved in the application.';
COMMENT ON COLUMN invoicing.bill_to_customer.email              IS 'Billing contact email. PII -> mask in reporting; overwritten on pseudonymization.';
COMMENT ON COLUMN invoicing.bill_to_customer.tax_identifier     IS 'VAT/EIN/GSTIN tax registration id. Sensitive personal/financial identifier.';
COMMENT ON COLUMN invoicing.bill_to_customer.pseudonymized_at   IS 'Set when GDPR/CCPA erasure has overwritten PII (name/email/phone/address/tax id). Preserves invoice history without retaining personal data.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_to_customer_org_email_live
    ON invoicing.bill_to_customer (organization_id, email)
    WHERE deleted_at IS NULL AND pseudonymized_at IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bill_to_customer_org
    ON invoicing.bill_to_customer (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_bill_to_customer_hubspot_company
    ON invoicing.bill_to_customer (organization_id, hubspot_company_id) WHERE hubspot_company_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bill_to_customer_set_updated_at ON invoicing.bill_to_customer;
CREATE TRIGGER trg_bill_to_customer_set_updated_at
    BEFORE UPDATE ON invoicing.bill_to_customer
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_bill_to_customer ON invoicing.bill_to_customer;
CREATE TRIGGER zzz_audit_bill_to_customer
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.bill_to_customer
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('tax_identifier');

-- ---------------------------------------------------------------------
-- 3. TAX RATE (lookup table -- business-editable, metadata-bearing)
-- ---------------------------------------------------------------------
-- DECISION: lookup table, NOT enum. Tax rates are created/edited by finance
-- users at runtime, carry metadata (label, percentage, jurisdiction), and are
-- joined for display on invoices. Rates change over time so each is its own
-- row; line items snapshot the numeric rate they were billed at (sec 5).
CREATE TABLE IF NOT EXISTS invoicing.tax_rate (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL,
    code            citext        NOT NULL,                  -- machine name e.g. 'us_ca_sales'
    name            text          NOT NULL,                  -- display label e.g. 'CA Sales Tax'
    description     text          NULL,
    rate_percent    numeric(9,6)  NOT NULL,                  -- e.g. 8.250000 = 8.25%
    country         char(2)       NULL,                      -- jurisdiction country
    region          text          NULL,                      -- state/province jurisdiction
    is_inclusive    boolean       NOT NULL DEFAULT false,    -- price-inclusive vs added-on
    is_active       boolean       NOT NULL DEFAULT true,
    effective_from  date          NULL,
    effective_to    date          NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    deleted_at      timestamptz   NULL,
    CONSTRAINT uq_tax_rate_public_id UNIQUE (public_id),
    CONSTRAINT fk_tax_rate_org      FOREIGN KEY (organization_id) REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_tax_rate_country  FOREIGN KEY (country)         REFERENCES core.country(iso2),
    CONSTRAINT ck_tax_rate_code     CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT ck_tax_rate_percent  CHECK (rate_percent >= 0 AND rate_percent <= 100),
    CONSTRAINT ck_tax_rate_effdates CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
COMMENT ON TABLE  invoicing.tax_rate IS
  'Business-editable tax rate definitions (lookup table, not enum -- carries label/percent/jurisdiction metadata and is joined for display). Line items snapshot the numeric rate at billing time so historical invoices are stable when a rate is later edited.';
COMMENT ON COLUMN invoicing.tax_rate.rate_percent IS 'Percentage rate, e.g. 8.250000 means 8.25%. numeric (never float) for exact tax math.';
COMMENT ON COLUMN invoicing.tax_rate.is_inclusive IS 'TRUE = tax is included in the unit price; FALSE = tax is added on top.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_rate_org_code_live
    ON invoicing.tax_rate (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tax_rate_org_active
    ON invoicing.tax_rate (organization_id) WHERE deleted_at IS NULL AND is_active;

DROP TRIGGER IF EXISTS trg_tax_rate_set_updated_at ON invoicing.tax_rate;
CREATE TRIGGER trg_tax_rate_set_updated_at
    BEFORE UPDATE ON invoicing.tax_rate
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_tax_rate ON invoicing.tax_rate;
CREATE TRIGGER zzz_audit_tax_rate
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.tax_rate
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 4. INVOICE (header)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoicing.invoice (
    id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint       NOT NULL,
    bill_to_customer_id bigint       NOT NULL,
    -- Human-facing printed reference, unique per org (e.g. 'INV-2026-000123').
    -- NOT the external API id (public_id is); this is the document number.
    invoice_number      text         NOT NULL,
    status              invoicing.invoice_status NOT NULL DEFAULT 'draft',
    currency_code       char(3)      NOT NULL,               -- core.currency(code)
    issue_date          date         NULL,                   -- set when issued/sent
    due_date            date         NULL,
    -- Monetary roll-ups (computed by the app from line items; stored for query
    -- speed & immutability of the issued document). numeric(18,4), never float.
    subtotal_amount     numeric(18,4) NOT NULL DEFAULT 0,    -- pre-tax net of lines
    tax_amount          numeric(18,4) NOT NULL DEFAULT 0,
    discount_amount     numeric(18,4) NOT NULL DEFAULT 0,
    total_amount        numeric(18,4) NOT NULL DEFAULT 0,    -- grand total billed
    amount_paid         numeric(18,4) NOT NULL DEFAULT 0,    -- sum of allocations
    amount_due          numeric(18,4) NOT NULL DEFAULT 0,    -- total - paid - credited
    notes               text         NULL,
    hubspot_deal_id     text         NULL,                   -- loose crm correlation (NO FK)
    sent_at             timestamptz  NULL,
    paid_at             timestamptz  NULL,
    voided_at           timestamptz  NULL,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    CONSTRAINT uq_invoice_public_id UNIQUE (public_id),
    CONSTRAINT fk_invoice_org      FOREIGN KEY (organization_id)     REFERENCES core.organization(id)          ON DELETE CASCADE,
    CONSTRAINT fk_invoice_customer FOREIGN KEY (bill_to_customer_id) REFERENCES invoicing.bill_to_customer(id) ON DELETE RESTRICT,
    CONSTRAINT fk_invoice_currency FOREIGN KEY (currency_code)       REFERENCES core.currency(code),
    CONSTRAINT ck_invoice_amounts_nonneg CHECK (
        subtotal_amount >= 0 AND tax_amount >= 0 AND discount_amount >= 0
        AND total_amount >= 0 AND amount_paid >= 0
    ),
    CONSTRAINT ck_invoice_due_after_issue CHECK (
        due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date
    ),
    -- A non-draft invoice must have been issued (issue date present).
    CONSTRAINT ck_invoice_issued_has_date CHECK (
        status = 'draft' OR issue_date IS NOT NULL
    )
);
COMMENT ON TABLE  invoicing.invoice IS
  'Invoice header. invoice_number is the human-facing printed reference (unique per org); public_id is the external API id. Monetary roll-ups are stored numeric(18,4) for the immutable issued document and query speed; line items are the source of truth.';
COMMENT ON COLUMN invoicing.invoice.invoice_number  IS 'Human-facing document number, unique per organization among live rows. Not used as an external API identifier (that is public_id).';
COMMENT ON COLUMN invoicing.invoice.status          IS 'Lifecycle state (draft/sent/partially_paid/paid/overdue/void). overdue is derived from due_date but persisted by a batch job for query/filtering.';
COMMENT ON COLUMN invoicing.invoice.amount_due      IS 'Outstanding balance = total_amount - amount_paid - credited. Maintained by the application transactionally with allocations/credit notes.';
COMMENT ON COLUMN invoicing.invoice.hubspot_deal_id IS 'Loose correlation to a crm deal HubSpot id. NOT a FK (crm is a resyncable mirror).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_org_number_live
    ON invoicing.invoice (organization_id, invoice_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_org_status
    ON invoicing.invoice (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_customer
    ON invoicing.invoice (bill_to_customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_due_date
    ON invoicing.invoice (organization_id, due_date)
    WHERE deleted_at IS NULL AND status IN ('sent','partially_paid','overdue');

DROP TRIGGER IF EXISTS trg_invoice_set_updated_at ON invoicing.invoice;
CREATE TRIGGER trg_invoice_set_updated_at
    BEFORE UPDATE ON invoicing.invoice
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_invoice ON invoicing.invoice;
CREATE TRIGGER zzz_audit_invoice
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.invoice
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 5. INVOICE LINE ITEM
-- ---------------------------------------------------------------------
-- product lines may reference inventory.product (sibling-schema FK, allowed).
-- Snapshots description/unit_price/tax_rate_percent at billing time so editing
-- the product/tax_rate later never mutates an issued invoice.
CREATE TABLE IF NOT EXISTS invoicing.invoice_line_item (
    id               bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id  bigint        NOT NULL,                 -- denormalized for RLS
    invoice_id       bigint        NOT NULL,
    line_number      integer       NOT NULL,                 -- ordering within the invoice
    kind             invoicing.line_item_kind NOT NULL DEFAULT 'product',
    product_id       bigint        NULL,                     -- inventory.product(id), product lines only
    tax_rate_id      bigint        NULL,                     -- invoicing.tax_rate(id), rate applied
    description      text          NOT NULL,                 -- snapshot of product/line description
    quantity         numeric(18,4) NOT NULL DEFAULT 1,
    unit_price       numeric(18,4) NOT NULL DEFAULT 0,       -- price per unit (numeric, never float)
    tax_rate_percent numeric(9,6)  NOT NULL DEFAULT 0,       -- snapshot of applied rate at billing time
    discount_amount  numeric(18,4) NOT NULL DEFAULT 0,       -- line-level discount
    line_subtotal    numeric(18,4) NOT NULL DEFAULT 0,       -- quantity*unit_price - discount
    tax_amount       numeric(18,4) NOT NULL DEFAULT 0,
    line_total       numeric(18,4) NOT NULL DEFAULT 0,       -- subtotal + tax
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    created_by       uuid          NULL,
    updated_by       uuid          NULL,
    deleted_at       timestamptz   NULL,
    CONSTRAINT uq_invoice_line_item_public_id UNIQUE (public_id),
    CONSTRAINT fk_ili_org      FOREIGN KEY (organization_id) REFERENCES core.organization(id)   ON DELETE CASCADE,
    CONSTRAINT fk_ili_invoice  FOREIGN KEY (invoice_id)      REFERENCES invoicing.invoice(id)   ON DELETE CASCADE,
    CONSTRAINT fk_ili_product  FOREIGN KEY (product_id)      REFERENCES inventory.product(id)   ON DELETE RESTRICT,
    CONSTRAINT fk_ili_tax_rate FOREIGN KEY (tax_rate_id)     REFERENCES invoicing.tax_rate(id)  ON DELETE RESTRICT,
    CONSTRAINT ck_ili_qty_signed     CHECK (quantity <> 0),
    CONSTRAINT ck_ili_nonneg         CHECK (unit_price >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND tax_rate_percent >= 0),
    CONSTRAINT ck_ili_line_number    CHECK (line_number > 0),
    -- product lines may carry a product link; non-product lines must not.
    CONSTRAINT ck_ili_product_kind   CHECK (
        (kind = 'product') OR (kind <> 'product' AND product_id IS NULL)
    )
);
COMMENT ON TABLE  invoicing.invoice_line_item IS
  'Invoice line. product lines may reference inventory.product; description/unit_price/tax_rate_percent are SNAPSHOTTED at billing time so later edits to the product or tax_rate never mutate an issued invoice. organization_id denormalized for single-predicate RLS.';
COMMENT ON COLUMN invoicing.invoice_line_item.product_id       IS 'Optional inventory.product(id). Only product-kind lines link a product; ON DELETE RESTRICT so a billed product cannot be hard-deleted out from under history.';
COMMENT ON COLUMN invoicing.invoice_line_item.tax_rate_percent IS 'Snapshot of the applied tax rate percentage at billing time. numeric (never float) for exact tax math.';
COMMENT ON COLUMN invoicing.invoice_line_item.unit_price       IS 'Price per unit, numeric(18,4). NEVER float -- exact money.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_line_item_invoice_lineno_live
    ON invoicing.invoice_line_item (invoice_id, line_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_line_item_invoice
    ON invoicing.invoice_line_item (invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_line_item_product
    ON invoicing.invoice_line_item (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_invoice_line_item_org
    ON invoicing.invoice_line_item (organization_id);

DROP TRIGGER IF EXISTS trg_invoice_line_item_set_updated_at ON invoicing.invoice_line_item;
CREATE TRIGGER trg_invoice_line_item_set_updated_at
    BEFORE UPDATE ON invoicing.invoice_line_item
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_invoice_line_item ON invoicing.invoice_line_item;
CREATE TRIGGER zzz_audit_invoice_line_item
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.invoice_line_item
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 6. TAX LINE (per-invoice tax breakdown by rate, for tax reporting)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoicing.tax_line (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL,
    invoice_id      bigint        NOT NULL,
    tax_rate_id     bigint        NULL,                      -- invoicing.tax_rate(id) if from a defined rate
    tax_name        text          NOT NULL,                  -- snapshot label e.g. 'CA Sales Tax'
    rate_percent    numeric(9,6)  NOT NULL,                  -- snapshot percentage
    taxable_amount  numeric(18,4) NOT NULL DEFAULT 0,        -- base the tax applied to
    tax_amount      numeric(18,4) NOT NULL DEFAULT 0,        -- computed tax
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    deleted_at      timestamptz   NULL,
    CONSTRAINT uq_tax_line_public_id UNIQUE (public_id),
    CONSTRAINT fk_tax_line_org      FOREIGN KEY (organization_id) REFERENCES core.organization(id)  ON DELETE CASCADE,
    CONSTRAINT fk_tax_line_invoice  FOREIGN KEY (invoice_id)      REFERENCES invoicing.invoice(id)  ON DELETE CASCADE,
    CONSTRAINT fk_tax_line_tax_rate FOREIGN KEY (tax_rate_id)     REFERENCES invoicing.tax_rate(id) ON DELETE RESTRICT,
    CONSTRAINT ck_tax_line_nonneg   CHECK (rate_percent >= 0 AND taxable_amount >= 0 AND tax_amount >= 0)
);
COMMENT ON TABLE  invoicing.tax_line IS
  'Per-invoice tax breakdown aggregated by rate/jurisdiction for compliant tax reporting and display. Snapshots tax_name + rate_percent so the issued document is stable. organization_id denormalized for RLS.';
COMMENT ON COLUMN invoicing.tax_line.taxable_amount IS 'Base amount this tax line applied to. numeric(18,4).';

CREATE INDEX IF NOT EXISTS ix_tax_line_invoice
    ON invoicing.tax_line (invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tax_line_org
    ON invoicing.tax_line (organization_id);

DROP TRIGGER IF EXISTS trg_tax_line_set_updated_at ON invoicing.tax_line;
CREATE TRIGGER trg_tax_line_set_updated_at
    BEFORE UPDATE ON invoicing.tax_line
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_tax_line ON invoicing.tax_line;
CREATE TRIGGER zzz_audit_tax_line
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.tax_line
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 7. PAYMENT (TOKENIZED ONLY -- NEVER raw PAN/CVV/bank/routing numbers)
-- ---------------------------------------------------------------------
-- PCI-scope minimization: stores ONLY an external-processor token plus
-- non-sensitive descriptors (brand, last4, expiry, processor name). The token
-- is a reference held by the processor (e.g. Stripe PaymentMethod/Charge id);
-- it is NOT a PAN and is useless without the processor. There is deliberately
-- NO column for card number / CVV / full bank account / routing number.
CREATE TABLE IF NOT EXISTS invoicing.payment (
    id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint       NOT NULL,
    bill_to_customer_id bigint       NULL,                   -- payer (may be unknown for ad-hoc)
    -- External processor linkage (the ONLY representation of the instrument).
    processor           text         NOT NULL,               -- e.g. 'stripe','adyen','braintree'
    payment_token       text         NOT NULL,               -- processor token / charge id. NOT a PAN.
    processor_reference text         NULL,                   -- processor's transaction/charge id
    method_type         invoicing.payment_method_type NOT NULL DEFAULT 'card',
    -- Non-sensitive instrument descriptors (safe to store, out of PCI scope).
    card_brand          text         NULL,                   -- 'visa','mastercard',... display only
    last4               char(4)      NULL,                   -- last 4 digits ONLY (non-sensitive)
    exp_month           smallint     NULL,                   -- card expiry month, display only
    exp_year            smallint     NULL,                   -- card expiry year, display only
    bank_name           text         NULL,                   -- display only, never account number
    status              invoicing.payment_status NOT NULL DEFAULT 'pending',
    currency_code       char(3)      NOT NULL,               -- core.currency(code)
    amount              numeric(18,4) NOT NULL,              -- gross amount captured
    amount_refunded     numeric(18,4) NOT NULL DEFAULT 0,
    received_at         timestamptz  NULL,                   -- when funds confirmed
    failure_reason      text         NULL,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    CONSTRAINT uq_payment_public_id UNIQUE (public_id),
    CONSTRAINT fk_payment_org      FOREIGN KEY (organization_id)     REFERENCES core.organization(id)          ON DELETE CASCADE,
    CONSTRAINT fk_payment_customer FOREIGN KEY (bill_to_customer_id) REFERENCES invoicing.bill_to_customer(id) ON DELETE RESTRICT,
    CONSTRAINT fk_payment_currency FOREIGN KEY (currency_code)       REFERENCES core.currency(code),
    CONSTRAINT ck_payment_amount       CHECK (amount > 0),
    CONSTRAINT ck_payment_refund_bound CHECK (amount_refunded >= 0 AND amount_refunded <= amount),
    CONSTRAINT ck_payment_last4        CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
    CONSTRAINT ck_payment_exp_month    CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
    CONSTRAINT ck_payment_exp_year     CHECK (exp_year  IS NULL OR exp_year BETWEEN 2000 AND 2100)
);
COMMENT ON TABLE  invoicing.payment IS
  'TOKENIZED payments only. Stores an external-processor token + non-sensitive descriptors (brand/last4/expiry/processor). NEVER stores raw PAN, CVV, full bank account, or routing numbers -- keeps the database out of PCI-DSS scope. The token is meaningless without the processor.';
COMMENT ON COLUMN invoicing.payment.payment_token       IS 'Opaque processor token / charge id (e.g. Stripe pm_/ch_ id). NOT a card number. Treat as a secret reference -- restrict read access; redacted from audit images.';
COMMENT ON COLUMN invoicing.payment.processor_reference IS 'Processor-side transaction/charge id for reconciliation. Not cardholder data, but treated as a sensitive reference (redacted in audit).';
COMMENT ON COLUMN invoicing.payment.card_brand          IS 'Card network for display (visa/mastercard/...). Non-sensitive.';
COMMENT ON COLUMN invoicing.payment.last4               IS 'Last 4 digits of the instrument for display ONLY. Non-sensitive by PCI rules; full PAN is NEVER stored.';
COMMENT ON COLUMN invoicing.payment.amount              IS 'Gross captured amount, numeric(18,4). NEVER float.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_processor_token_live
    ON invoicing.payment (processor, payment_token) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_payment_org_status
    ON invoicing.payment (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_payment_customer
    ON invoicing.payment (bill_to_customer_id) WHERE bill_to_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_payment_set_updated_at ON invoicing.payment;
CREATE TRIGGER trg_payment_set_updated_at
    BEFORE UPDATE ON invoicing.payment
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Redact the processor token + reference from audit images (sensitive references).
DROP TRIGGER IF EXISTS zzz_audit_payment ON invoicing.payment;
CREATE TRIGGER zzz_audit_payment
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.payment
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('payment_token,processor_reference');

-- ---------------------------------------------------------------------
-- 8. PAYMENT ALLOCATION (payment -> invoice, M:N split)
-- ---------------------------------------------------------------------
-- A single payment may cover several invoices; an invoice may be paid by
-- several payments. This junction records how much of each payment is applied
-- to each invoice.
CREATE TABLE IF NOT EXISTS invoicing.payment_allocation (
    id               bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id  bigint        NOT NULL,                 -- denormalized for RLS
    payment_id       bigint        NOT NULL,
    invoice_id       bigint        NOT NULL,
    allocated_amount numeric(18,4) NOT NULL,
    allocated_at     timestamptz   NOT NULL DEFAULT now(),
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    created_by       uuid          NULL,
    updated_by       uuid          NULL,
    deleted_at       timestamptz   NULL,
    CONSTRAINT uq_payment_allocation_public_id UNIQUE (public_id),
    CONSTRAINT fk_palloc_org     FOREIGN KEY (organization_id) REFERENCES core.organization(id)  ON DELETE CASCADE,
    CONSTRAINT fk_palloc_payment FOREIGN KEY (payment_id)      REFERENCES invoicing.payment(id)  ON DELETE CASCADE,
    CONSTRAINT fk_palloc_invoice FOREIGN KEY (invoice_id)      REFERENCES invoicing.invoice(id)  ON DELETE RESTRICT,
    CONSTRAINT ck_palloc_amount  CHECK (allocated_amount > 0)
);
COMMENT ON TABLE  invoicing.payment_allocation IS
  'Allocates a (portion of a) payment to an invoice (M:N). Sum of allocations per payment must not exceed payment.amount and per invoice drives invoice.amount_paid -- enforced transactionally by the application. organization_id denormalized for RLS.';
COMMENT ON COLUMN invoicing.payment_allocation.allocated_amount IS 'Portion of the payment applied to this invoice. numeric(18,4), must be > 0.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_allocation_pair_live
    ON invoicing.payment_allocation (payment_id, invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_palloc_invoice
    ON invoicing.payment_allocation (invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_palloc_payment
    ON invoicing.payment_allocation (payment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_palloc_org
    ON invoicing.payment_allocation (organization_id);

DROP TRIGGER IF EXISTS trg_payment_allocation_set_updated_at ON invoicing.payment_allocation;
CREATE TRIGGER trg_payment_allocation_set_updated_at
    BEFORE UPDATE ON invoicing.payment_allocation
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_payment_allocation ON invoicing.payment_allocation;
CREATE TRIGGER zzz_audit_payment_allocation
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.payment_allocation
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 9. CREDIT NOTE (issued against an invoice, or standalone)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoicing.credit_note (
    id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint       NOT NULL,
    invoice_id          bigint       NULL,                   -- invoice being credited (NULL = standalone)
    bill_to_customer_id bigint       NOT NULL,
    credit_note_number  text         NOT NULL,               -- human-facing reference, unique per org
    status              invoicing.credit_note_status NOT NULL DEFAULT 'draft',
    currency_code       char(3)      NOT NULL,               -- core.currency(code)
    issue_date          date         NULL,
    reason              text         NULL,
    subtotal_amount     numeric(18,4) NOT NULL DEFAULT 0,
    tax_amount          numeric(18,4) NOT NULL DEFAULT 0,
    total_amount        numeric(18,4) NOT NULL DEFAULT 0,
    applied_amount      numeric(18,4) NOT NULL DEFAULT 0,    -- amount applied against invoice/balance
    issued_at           timestamptz  NULL,
    voided_at           timestamptz  NULL,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),
    created_by          uuid         NULL,
    updated_by          uuid         NULL,
    deleted_at          timestamptz  NULL,
    CONSTRAINT uq_credit_note_public_id UNIQUE (public_id),
    CONSTRAINT fk_credit_note_org      FOREIGN KEY (organization_id)     REFERENCES core.organization(id)          ON DELETE CASCADE,
    CONSTRAINT fk_credit_note_invoice  FOREIGN KEY (invoice_id)          REFERENCES invoicing.invoice(id)          ON DELETE RESTRICT,
    CONSTRAINT fk_credit_note_customer FOREIGN KEY (bill_to_customer_id) REFERENCES invoicing.bill_to_customer(id) ON DELETE RESTRICT,
    CONSTRAINT fk_credit_note_currency FOREIGN KEY (currency_code)       REFERENCES core.currency(code),
    CONSTRAINT ck_credit_note_nonneg   CHECK (
        subtotal_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
        AND applied_amount >= 0 AND applied_amount <= total_amount
    ),
    CONSTRAINT ck_credit_note_issued_has_date CHECK (status = 'draft' OR issue_date IS NOT NULL)
);
COMMENT ON TABLE  invoicing.credit_note IS
  'Credit note issued against an invoice (or standalone). credit_note_number is the human-facing reference (unique per org); public_id is the external API id. Money numeric(18,4). applied_amount tracks how much offsets the invoice/customer balance.';
COMMENT ON COLUMN invoicing.credit_note.invoice_id     IS 'Invoice being credited. NULL for a standalone/account-level credit. ON DELETE RESTRICT to preserve financial history.';
COMMENT ON COLUMN invoicing.credit_note.applied_amount IS 'Portion of the credit note already applied. numeric(18,4), bounded by total_amount.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_note_org_number_live
    ON invoicing.credit_note (organization_id, credit_note_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_credit_note_invoice
    ON invoicing.credit_note (invoice_id) WHERE invoice_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_credit_note_org_status
    ON invoicing.credit_note (organization_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_credit_note_customer
    ON invoicing.credit_note (bill_to_customer_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_credit_note_set_updated_at ON invoicing.credit_note;
CREATE TRIGGER trg_credit_note_set_updated_at
    BEFORE UPDATE ON invoicing.credit_note
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_credit_note ON invoicing.credit_note;
CREATE TRIGGER zzz_audit_credit_note
    AFTER INSERT OR UPDATE OR DELETE ON invoicing.credit_note
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 10. ROW-LEVEL SECURITY (tenant isolation -- every tenant-scoped table)
-- ---------------------------------------------------------------------
ALTER TABLE invoicing.bill_to_customer   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.tax_rate           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.invoice            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.invoice_line_item  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.tax_line           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.payment            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.payment_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoicing.credit_note        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_bill_to_customer_isolation ON invoicing.bill_to_customer;
CREATE POLICY rls_bill_to_customer_isolation ON invoicing.bill_to_customer
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_tax_rate_isolation ON invoicing.tax_rate;
CREATE POLICY rls_tax_rate_isolation ON invoicing.tax_rate
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_invoice_isolation ON invoicing.invoice;
CREATE POLICY rls_invoice_isolation ON invoicing.invoice
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_invoice_line_item_isolation ON invoicing.invoice_line_item;
CREATE POLICY rls_invoice_line_item_isolation ON invoicing.invoice_line_item
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_tax_line_isolation ON invoicing.tax_line;
CREATE POLICY rls_tax_line_isolation ON invoicing.tax_line
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_payment_isolation ON invoicing.payment;
CREATE POLICY rls_payment_isolation ON invoicing.payment
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_payment_allocation_isolation ON invoicing.payment_allocation;
CREATE POLICY rls_payment_allocation_isolation ON invoicing.payment_allocation
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_credit_note_isolation ON invoicing.credit_note;
CREATE POLICY rls_credit_note_isolation ON invoicing.credit_note
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- ---------------------------------------------------------------------
-- 11. GRANTS (least privilege; mirrors core's posture -- no DELETE to app roles)
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA invoicing TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA invoicing TO app_readwrite;
-- No DELETE granted -- deletions are soft (deleted_at). Hard deletes / retention
-- purges are a migrator-only operation.

-- Future tables created by the migrator inherit the same posture.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA invoicing
    GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA invoicing
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_readwrite;

-- =====================================================================
-- END INVOICING SCHEMA DDL
-- =====================================================================