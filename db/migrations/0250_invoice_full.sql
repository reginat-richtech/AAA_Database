-- =====================================================================
-- AAA_Database :: INVOICE → full QuickBooks-style, standalone
-- Target: PostgreSQL 16+   Depends on 0240_invoice.
--
-- Make invoices standalone (project optional, any number) and add the standard
-- QuickBooks "Create Invoice" fields. Lines (jsonb) gain description + taxable in
-- the app layer (no schema change). Self-contained + idempotent.
-- =====================================================================
-- project link is now optional + non-unique (multiple invoices, or none, per project)
ALTER TABLE ops.invoice ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE ops.invoice DROP CONSTRAINT IF EXISTS invoice_project_id_key;
CREATE INDEX IF NOT EXISTS ix_invoice_project ON ops.invoice (project_id);

-- Standard QuickBooks invoice header fields
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS customer_name     text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS customer_email    text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS billing_address   text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS shipping_address  text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS invoice_number    text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS invoice_date      date;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS due_date          date;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS terms             text;   -- Net 15/30, Due on receipt…
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS customer_message  text;   -- "Message on invoice"
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS discount_type     text;   -- percent | amount
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS discount_value    numeric;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS tax_rate          numeric; -- sales tax %
-- (existing `notes` = internal memo / "Statement memo")
