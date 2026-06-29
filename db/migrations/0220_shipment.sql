-- =====================================================================
-- AAA_Database :: SHIPMENT  (Shipping stage — after inventory checkout)
-- Target: PostgreSQL 16+   Depends on 0080_ops_features (ops schema) + audit.
--
-- One shipment per project. Created on the /shipping page once a project's
-- inventory is checked out (its 'shipping' prep task is done). Address + recipient
-- autofill from the agreement (extracted_json.client_*) / proposal on the page;
-- carrier / tracking / estimate are entered by the inventory team. Idempotent.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.shipment (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        text UNIQUE NOT NULL,            -- ops.legal_agreement id (one shipment per project)
    recipient_name    text,
    recipient_email   text,
    recipient_phone   text,
    address           text,
    carrier           text,
    tracking_number   text,
    est_cost          numeric,
    currency          text NOT NULL DEFAULT 'USD',
    est_ship_date     date,
    est_delivery_date date,
    status            text NOT NULL DEFAULT 'pending', -- pending | shipped | delivered
    notes             text,
    created_by        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_shipment_status ON ops.shipment (status);

-- Audit (tamper-evident hash chain), same as the other user-driven ops tables.
DROP TRIGGER IF EXISTS zzz_audit_shipment ON ops.shipment;
CREATE TRIGGER zzz_audit_shipment AFTER INSERT OR UPDATE OR DELETE ON ops.shipment
  FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

GRANT SELECT                         ON ops.shipment TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.shipment TO app_readwrite;
