-- =====================================================================
-- AAA_Database :: invoice Project Manager (QuickBooks custom field)
-- Target: PostgreSQL 16+   Depends on 0240_invoice. Idempotent.
-- Stores the selected Project Manager name (from the QuickBooks custom-field list).
-- =====================================================================
ALTER TABLE ops.invoice ADD COLUMN IF NOT EXISTS project_manager text;
