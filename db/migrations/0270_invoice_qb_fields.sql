-- =====================================================================
-- AAA_Database :: invoice — extra QuickBooks-style fields
-- Target: PostgreSQL 16+   Depends on 0240_invoice.
-- P.O. Number + payment instructions (line-level service_date + amount override
-- live in the lines jsonb). Idempotent.
-- =====================================================================
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS po_number            text;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS payment_instructions text;
