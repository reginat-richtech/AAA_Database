-- =====================================================================
-- AAA_Database :: INVOICE  (QuickBooks Invoice stage — draft → confirm → push)
-- Target: PostgreSQL 16+   Depends on 0080_ops_features (ops) + audit.
--
-- One draft invoice per project. Seeded from the project's SKU list (the inventory
-- cart); sales fills in unit prices and confirms; then it can be pushed to
-- QuickBooks. Lines kept as JSON for easy in-place editing. Self-contained + idempotent.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.invoice (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    text UNIQUE NOT NULL,                  -- ops.legal_agreement id
    status        text NOT NULL DEFAULT 'draft',         -- draft | confirmed | pushed
    currency      text NOT NULL DEFAULT 'USD',
    lines         jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{sku, product_name, quantity, unit_price, cn_sku_id}]
    notes         text,
    confirmed_by  text,
    confirmed_at  timestamptz,
    qb_invoice_id text,                                  -- QuickBooks Invoice.Id once pushed
    qb_doc_number text,                                  -- QuickBooks DocNumber
    pushed_at     timestamptz,
    push_error    text,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_invoice_status ON ops.invoice (status);

DROP TRIGGER IF EXISTS zzz_audit_invoice ON ops.invoice;
CREATE TRIGGER zzz_audit_invoice AFTER INSERT OR UPDATE OR DELETE ON ops.invoice
  FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

GRANT SELECT                         ON ops.invoice TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.invoice TO app_readwrite;
