-- =====================================================================
-- AAA_Database :: invoice tags + class (QuickBooks-style)
-- Target: PostgreSQL 16+   Depends on 0240_invoice. Idempotent.
-- =====================================================================
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS tags       jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS class_name text;
