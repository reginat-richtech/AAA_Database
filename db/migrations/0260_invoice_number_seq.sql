-- =====================================================================
-- AAA_Database :: invoice number sequence
-- Target: PostgreSQL 16+   Depends on 0240_invoice.
-- Auto-assigns a human invoice number (INV-1001, INV-1002, …) when an invoice is
-- created with none. Idempotent.
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS ops.invoice_number_seq START 1001;
