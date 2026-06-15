-- =====================================================================
-- AAA_Database :: INVENTORY DOMAIN DDL
-- Target: PostgreSQL 16+
-- Depends on FOUNDATION DDL (schemas, core.*, audit.*, roles) loaded first.
-- Idempotent: CREATE ... IF NOT EXISTS / DROP TRIGGER IF EXISTS / guarded DO.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. ENUM TYPES (closed, code-coupled, no per-row metadata)
--   movement_type, purchase_order_status -> ENUM (state-machine coupled).
--   unit_of_measure -> LOOKUP TABLE (business-extensible, see section 1).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'movement_type' AND n.nspname = 'inventory') THEN
    CREATE TYPE inventory.movement_type AS ENUM ('in', 'out', 'transfer', 'adjustment');
  END IF;
END
$$;
COMMENT ON TYPE inventory.movement_type IS 'Stock ledger verb: in (receipt), out (issue/ship), transfer (location->location), adjustment (count/shrinkage). Closed set coupled to posting logic -- enum, not lookup.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'purchase_order_status' AND n.nspname = 'inventory') THEN
    CREATE TYPE inventory.purchase_order_status AS ENUM
      ('draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled', 'closed');
  END IF;
END
$$;
COMMENT ON TYPE inventory.purchase_order_status IS 'Purchase-order lifecycle. Closed set driving the procurement state machine -- enum, not lookup.';

-- ---------------------------------------------------------------------
-- 1. inventory.unit_of_measure -- LOOKUP (business-extensible UoMs, global)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.unit_of_measure (
    id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id     uuid         NOT NULL DEFAULT gen_random_uuid(),
    code          citext       NOT NULL,
    name          text         NOT NULL,
    symbol        text         NULL,
    dimension     text         NOT NULL DEFAULT 'count',
    is_active     boolean      NOT NULL DEFAULT true,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    created_by    uuid         NULL,
    updated_by    uuid         NULL,
    deleted_at    timestamptz  NULL,
    CONSTRAINT uq_unit_of_measure_public_id UNIQUE (public_id),
    CONSTRAINT ck_unit_of_measure_code      CHECK (code ~ '^[a-z0-9][a-z0-9_]{0,15}$'),
    CONSTRAINT ck_unit_of_measure_dimension CHECK (dimension IN ('count','mass','volume','length','area','time'))
);
COMMENT ON TABLE  inventory.unit_of_measure IS 'Business-extensible units of measure (lookup). Joined to product for display/validation. is_active disables a UoM without deletion.';
COMMENT ON COLUMN inventory.unit_of_measure.code      IS 'Stable machine code, e.g. ea/kg/l. Lowercase, unique among live rows.';
COMMENT ON COLUMN inventory.unit_of_measure.dimension IS 'Physical dimension class; prevents nonsensical conversions (mass vs volume).';
COMMENT ON COLUMN inventory.unit_of_measure.public_id IS 'Externally exposed UUID. Internal joins use id.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_of_measure_code_live
    ON inventory.unit_of_measure (code) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_unit_of_measure_set_updated_at ON inventory.unit_of_measure;
CREATE TRIGGER trg_unit_of_measure_set_updated_at
    BEFORE UPDATE ON inventory.unit_of_measure
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_unit_of_measure ON inventory.unit_of_measure;
CREATE TRIGGER zzz_audit_unit_of_measure
    AFTER INSERT OR UPDATE OR DELETE ON inventory.unit_of_measure
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 2. inventory.product_category -- tenant-scoped self-referential hierarchy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.product_category (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    parent_id       bigint       NULL,
    code            citext       NOT NULL,
    name            text         NOT NULL,
    description     text         NULL,
    sort_order      integer      NOT NULL DEFAULT 0,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_product_category_public_id UNIQUE (public_id),
    CONSTRAINT ck_product_category_code     CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    CONSTRAINT ck_product_category_no_self  CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT fk_product_category_org    FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_product_category_parent FOREIGN KEY (parent_id)
        REFERENCES inventory.product_category(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  inventory.product_category IS 'Tenant-scoped product category tree. parent_id NULL = root. RESTRICT on parent prevents orphaning children; reparent before delete.';
COMMENT ON COLUMN inventory.product_category.parent_id IS 'Self-reference to parent category (same tenant). App enforces same-org parent and cycle-free tree.';
COMMENT ON COLUMN inventory.product_category.code      IS 'Tenant-stable machine code, unique per organization among live rows.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_category_org_code_live
    ON inventory.product_category (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_product_category_org    ON inventory.product_category (organization_id);
CREATE INDEX IF NOT EXISTS ix_product_category_parent ON inventory.product_category (parent_id);

DROP TRIGGER IF EXISTS trg_product_category_set_updated_at ON inventory.product_category;
CREATE TRIGGER trg_product_category_set_updated_at
    BEFORE UPDATE ON inventory.product_category
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_product_category ON inventory.product_category;
CREATE TRIGGER zzz_audit_product_category
    AFTER INSERT OR UPDATE OR DELETE ON inventory.product_category
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 3. inventory.product -- catalog item (external link target for invoicing)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.product (
    id                  bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint        NOT NULL,
    sku                 citext        NOT NULL,
    name                text          NOT NULL,
    description         text          NULL,
    category_id         bigint        NULL,
    unit_of_measure_id  bigint        NOT NULL,
    barcode             text          NULL,
    standard_cost       numeric(18,4) NULL,
    list_price          numeric(18,4) NULL,
    currency_code       char(3)       NULL,
    default_reorder_point    numeric(18,4) NULL,
    default_reorder_quantity numeric(18,4) NULL,
    is_active           boolean       NOT NULL DEFAULT true,
    is_stock_tracked    boolean       NOT NULL DEFAULT true,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    created_by          uuid          NULL,
    updated_by          uuid          NULL,
    deleted_at          timestamptz   NULL,
    CONSTRAINT uq_product_public_id UNIQUE (public_id),
    CONSTRAINT ck_product_sku       CHECK (length(sku) BETWEEN 1 AND 64),
    CONSTRAINT ck_product_standard_cost_nonneg CHECK (standard_cost IS NULL OR standard_cost >= 0),
    CONSTRAINT ck_product_list_price_nonneg    CHECK (list_price    IS NULL OR list_price    >= 0),
    CONSTRAINT ck_product_reorder_pt_nonneg    CHECK (default_reorder_point    IS NULL OR default_reorder_point    >= 0),
    CONSTRAINT ck_product_reorder_qty_nonneg   CHECK (default_reorder_quantity IS NULL OR default_reorder_quantity >= 0),
    CONSTRAINT ck_product_money_currency CHECK (
        (standard_cost IS NULL AND list_price IS NULL) OR currency_code IS NOT NULL
    ),
    CONSTRAINT fk_product_org      FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_product_category FOREIGN KEY (category_id)
        REFERENCES inventory.product_category(id) ON DELETE RESTRICT,
    CONSTRAINT fk_product_uom      FOREIGN KEY (unit_of_measure_id)
        REFERENCES inventory.unit_of_measure(id) ON DELETE RESTRICT,
    CONSTRAINT fk_product_currency FOREIGN KEY (currency_code)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  inventory.product IS 'Catalog item. sku unique per tenant among live rows. The external link target for invoicing.invoice_line (invoicing references product.id/public_id); inventory does NOT depend on invoicing.';
COMMENT ON COLUMN inventory.product.sku              IS 'Stock keeping unit. Case-insensitive, unique per organization among live rows.';
COMMENT ON COLUMN inventory.product.standard_cost    IS 'Standard/landed unit cost (numeric, never float). Requires currency_code. Confidential margin data.';
COMMENT ON COLUMN inventory.product.list_price       IS 'Default list/selling unit price (numeric). Requires currency_code.';
COMMENT ON COLUMN inventory.product.is_stock_tracked IS 'FALSE for non-stock items (services); no stock_level/movement expected.';
COMMENT ON COLUMN inventory.product.barcode          IS 'EAN/UPC/GTIN trade identifier. Not personal data.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_org_sku_live
    ON inventory.product (organization_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_product_org      ON inventory.product (organization_id);
CREATE INDEX IF NOT EXISTS ix_product_category ON inventory.product (category_id);
CREATE INDEX IF NOT EXISTS ix_product_uom      ON inventory.product (unit_of_measure_id);
CREATE INDEX IF NOT EXISTS ix_product_org_barcode
    ON inventory.product (organization_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_product_set_updated_at ON inventory.product;
CREATE TRIGGER trg_product_set_updated_at
    BEFORE UPDATE ON inventory.product
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_product ON inventory.product;
CREATE TRIGGER zzz_audit_product
    AFTER INSERT OR UPDATE OR DELETE ON inventory.product
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('standard_cost');

-- ---------------------------------------------------------------------
-- 4. inventory.warehouse -- facility (operational address, not PII)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.warehouse (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    code            citext       NOT NULL,
    name            text         NOT NULL,
    address_line1   text         NULL,
    address_line2   text         NULL,
    city            text         NULL,
    region          text         NULL,
    postal_code     text         NULL,
    country         char(2)      NULL,
    timezone        text         NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_warehouse_public_id UNIQUE (public_id),
    CONSTRAINT ck_warehouse_code   CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
    CONSTRAINT fk_warehouse_org     FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_warehouse_country FOREIGN KEY (country)
        REFERENCES core.country(iso2)
);
COMMENT ON TABLE  inventory.warehouse IS 'Stocking facility for a tenant. Address is an operational business location, not personal data.';
COMMENT ON COLUMN inventory.warehouse.code     IS 'Tenant-stable warehouse code, unique per organization among live rows.';
COMMENT ON COLUMN inventory.warehouse.timezone IS 'IANA timezone for local operational scheduling/reporting.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_org_code_live
    ON inventory.warehouse (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_warehouse_org ON inventory.warehouse (organization_id);

DROP TRIGGER IF EXISTS trg_warehouse_set_updated_at ON inventory.warehouse;
CREATE TRIGGER trg_warehouse_set_updated_at
    BEFORE UPDATE ON inventory.warehouse
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_warehouse ON inventory.warehouse;
CREATE TRIGGER zzz_audit_warehouse
    AFTER INSERT OR UPDATE OR DELETE ON inventory.warehouse
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 5. inventory.location -- bin/zone inside a warehouse
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.location (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint       NOT NULL,
    warehouse_id    bigint       NOT NULL,
    code            citext       NOT NULL,
    name            text         NULL,
    location_type   text         NOT NULL DEFAULT 'bin',
    is_pickable     boolean      NOT NULL DEFAULT true,
    is_active       boolean      NOT NULL DEFAULT true,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    created_by      uuid         NULL,
    updated_by      uuid         NULL,
    deleted_at      timestamptz  NULL,
    CONSTRAINT uq_location_public_id UNIQUE (public_id),
    CONSTRAINT ck_location_code CHECK (length(code) BETWEEN 1 AND 40),
    CONSTRAINT ck_location_type CHECK (location_type IN ('bin','zone','dock','staging','quarantine')),
    CONSTRAINT fk_location_org       FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_location_warehouse FOREIGN KEY (warehouse_id)
        REFERENCES inventory.warehouse(id) ON DELETE CASCADE
);
COMMENT ON TABLE  inventory.location IS 'Bin/zone/slot within a warehouse. organization_id denormalized from warehouse for index-friendly single-predicate RLS.';
COMMENT ON COLUMN inventory.location.code        IS 'Location code, unique within its warehouse among live rows.';
COMMENT ON COLUMN inventory.location.is_pickable IS 'FALSE for quarantine/damage/staging slots excluded from normal picking.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_location_warehouse_code_live
    ON inventory.location (warehouse_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_location_org       ON inventory.location (organization_id);
CREATE INDEX IF NOT EXISTS ix_location_warehouse ON inventory.location (warehouse_id);

DROP TRIGGER IF EXISTS trg_location_set_updated_at ON inventory.location;
CREATE TRIGGER trg_location_set_updated_at
    BEFORE UPDATE ON inventory.location
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_location ON inventory.location;
CREATE TRIGGER zzz_audit_location
    AFTER INSERT OR UPDATE OR DELETE ON inventory.location
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 6. inventory.stock_level -- on-hand state per (product x location)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.stock_level (
    id              bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint        NOT NULL,
    product_id      bigint        NOT NULL,
    location_id     bigint        NOT NULL,
    quantity_on_hand   numeric(18,4) NOT NULL DEFAULT 0,
    quantity_reserved  numeric(18,4) NOT NULL DEFAULT 0,
    reorder_point      numeric(18,4) NULL,
    reorder_quantity   numeric(18,4) NULL,
    last_counted_at    timestamptz  NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    created_by      uuid          NULL,
    updated_by      uuid          NULL,
    deleted_at      timestamptz   NULL,
    CONSTRAINT uq_stock_level_public_id UNIQUE (public_id),
    CONSTRAINT ck_stock_level_on_hand_nonneg  CHECK (quantity_on_hand  >= 0),
    CONSTRAINT ck_stock_level_reserved_nonneg CHECK (quantity_reserved >= 0),
    CONSTRAINT ck_stock_level_reserved_le_on_hand CHECK (quantity_reserved <= quantity_on_hand),
    CONSTRAINT ck_stock_level_reorder_pt_nonneg  CHECK (reorder_point    IS NULL OR reorder_point    >= 0),
    CONSTRAINT ck_stock_level_reorder_qty_nonneg CHECK (reorder_quantity IS NULL OR reorder_quantity >= 0),
    CONSTRAINT fk_stock_level_org      FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_stock_level_product  FOREIGN KEY (product_id)
        REFERENCES inventory.product(id)  ON DELETE RESTRICT,
    CONSTRAINT fk_stock_level_location FOREIGN KEY (location_id)
        REFERENCES inventory.location(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  inventory.stock_level IS 'Current on-hand balance per (product, location). Read projection of the stock_movement ledger. CHECK (quantity_on_hand >= 0) is the hard guard against negative stock; the posting layer must apply movements transactionally (SELECT ... FOR UPDATE on the row, then update) so concurrent issues cannot drive on-hand below zero.';
COMMENT ON COLUMN inventory.stock_level.quantity_on_hand  IS 'Physically present quantity. CHECK >= 0 forbids negative stock at the storage layer.';
COMMENT ON COLUMN inventory.stock_level.quantity_reserved IS 'Quantity allocated to open orders, not yet shipped. Must be <= quantity_on_hand.';
COMMENT ON COLUMN inventory.stock_level.reorder_point     IS 'Per-location reorder threshold; overrides product.default_reorder_point when set.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_level_product_location_live
    ON inventory.stock_level (product_id, location_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_stock_level_org      ON inventory.stock_level (organization_id);
CREATE INDEX IF NOT EXISTS ix_stock_level_location ON inventory.stock_level (location_id);
CREATE INDEX IF NOT EXISTS ix_stock_level_reorder
    ON inventory.stock_level (organization_id, product_id)
    WHERE deleted_at IS NULL AND reorder_point IS NOT NULL;

DROP TRIGGER IF EXISTS trg_stock_level_set_updated_at ON inventory.stock_level;
CREATE TRIGGER trg_stock_level_set_updated_at
    BEFORE UPDATE ON inventory.stock_level
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_stock_level ON inventory.stock_level;
CREATE TRIGGER zzz_audit_stock_level
    AFTER INSERT OR UPDATE OR DELETE ON inventory.stock_level
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

-- ---------------------------------------------------------------------
-- 7. inventory.stock_movement -- append-only stock ledger (source of truth)
--   quantity always > 0; direction encoded by movement_type + from/to.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.stock_movement (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint        NOT NULL,
    product_id         bigint        NOT NULL,
    movement_type      inventory.movement_type NOT NULL,
    quantity           numeric(18,4) NOT NULL,
    from_location_id   bigint        NULL,
    to_location_id     bigint        NULL,
    reason             text          NULL,
    reference_type     text          NULL,
    reference_id       uuid          NULL,
    occurred_at        timestamptz   NOT NULL DEFAULT now(),
    unit_cost          numeric(18,4) NULL,
    currency_code      char(3)       NULL,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    created_by         uuid          NULL,
    updated_by         uuid          NULL,
    deleted_at         timestamptz   NULL,
    CONSTRAINT uq_stock_movement_public_id UNIQUE (public_id),
    CONSTRAINT ck_stock_movement_qty_pos   CHECK (quantity > 0),
    CONSTRAINT ck_stock_movement_unit_cost_nonneg CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT ck_stock_movement_unit_cost_currency CHECK (unit_cost IS NULL OR currency_code IS NOT NULL),
    CONSTRAINT ck_stock_movement_locations CHECK (
        (movement_type = 'in'         AND to_location_id IS NOT NULL AND from_location_id IS NULL)
     OR (movement_type = 'out'        AND from_location_id IS NOT NULL AND to_location_id IS NULL)
     OR (movement_type = 'transfer'   AND from_location_id IS NOT NULL AND to_location_id IS NOT NULL
                                       AND from_location_id <> to_location_id)
     OR (movement_type = 'adjustment' AND to_location_id IS NOT NULL AND from_location_id IS NULL)
    ),
    CONSTRAINT fk_stock_movement_org   FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_stock_movement_product FOREIGN KEY (product_id)
        REFERENCES inventory.product(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stock_movement_from  FOREIGN KEY (from_location_id)
        REFERENCES inventory.location(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stock_movement_to    FOREIGN KEY (to_location_id)
        REFERENCES inventory.location(id) ON DELETE RESTRICT,
    CONSTRAINT fk_stock_movement_currency FOREIGN KEY (currency_code)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  inventory.stock_movement IS 'Append-only stock ledger -- authoritative history of every quantity change. quantity always positive; direction from movement_type + from/to. reference_type/reference_id loosely link the source doc (PO, invoicing.invoice) by public_id WITHOUT a hard cross-schema FK.';
COMMENT ON COLUMN inventory.stock_movement.quantity     IS 'Positive magnitude (numeric, never float). Sign/direction comes from movement_type + from/to.';
COMMENT ON COLUMN inventory.stock_movement.reference_id IS 'public_id (uuid) of the originating document. Intentionally NOT a FK -- avoids coupling to invoicing/crm row lifecycles.';
COMMENT ON COLUMN inventory.stock_movement.unit_cost    IS 'Per-unit cost at movement time for valuation/COGS. Requires currency_code. Confidential.';
COMMENT ON COLUMN inventory.stock_movement.occurred_at  IS 'Business event time (may predate created_at for backdated entries).';

CREATE INDEX IF NOT EXISTS ix_stock_movement_org      ON inventory.stock_movement (organization_id);
CREATE INDEX IF NOT EXISTS ix_stock_movement_product  ON inventory.stock_movement (product_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_movement_from     ON inventory.stock_movement (from_location_id) WHERE from_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_stock_movement_to       ON inventory.stock_movement (to_location_id)   WHERE to_location_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_stock_movement_occurred ON inventory.stock_movement (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_movement_reference ON inventory.stock_movement (reference_type, reference_id) WHERE reference_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_stock_movement_set_updated_at ON inventory.stock_movement;
CREATE TRIGGER trg_stock_movement_set_updated_at
    BEFORE UPDATE ON inventory.stock_movement
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_stock_movement ON inventory.stock_movement;
CREATE TRIGGER zzz_audit_stock_movement
    AFTER INSERT OR UPDATE OR DELETE ON inventory.stock_movement
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('unit_cost');

-- NEGATIVE-STOCK PREVENTION NOTE (posting layer, not created here):
--   ck_stock_level_on_hand_nonneg is the backstop. Recommended: an AFTER INSERT
--   trigger on stock_movement that, in the same transaction, locks the matching
--   stock_level row(s) FOR UPDATE, subtracts at from_location_id and adds at
--   to_location_id (upserting the balance), letting the CHECK reject over-issue
--   atomically. Left to the posting layer so FIFO/AVCO valuation stays in one place.

-- ---------------------------------------------------------------------
-- 8. inventory.supplier -- vendor master (NO payment data; no FK into crm)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.supplier (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint       NOT NULL,
    code               citext       NOT NULL,
    name               text         NOT NULL,
    contact_name       text         NULL,
    contact_email      citext       NULL,
    contact_phone      text         NULL,
    address_line1      text         NULL,
    address_line2      text         NULL,
    city               text         NULL,
    region             text         NULL,
    postal_code        text         NULL,
    country            char(2)      NULL,
    default_currency   char(3)      NULL,
    tax_identifier     text         NULL,
    hubspot_company_id text         NULL,
    is_active          boolean      NOT NULL DEFAULT true,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    created_by         uuid         NULL,
    updated_by         uuid         NULL,
    deleted_at         timestamptz  NULL,
    pseudonymized_at   timestamptz  NULL,
    CONSTRAINT uq_supplier_public_id UNIQUE (public_id),
    CONSTRAINT ck_supplier_code  CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
    CONSTRAINT ck_supplier_email CHECK (contact_email IS NULL OR position('@' in contact_email) > 1),
    CONSTRAINT fk_supplier_org      FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_supplier_country  FOREIGN KEY (country)
        REFERENCES core.country(iso2),
    CONSTRAINT fk_supplier_currency FOREIGN KEY (default_currency)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  inventory.supplier IS 'Vendor master per tenant. Stores ONLY non-PCI contact/business data -- never bank/card numbers. Associated HubSpot company stored as a loose hubspot_company_id with NO FK into the crm mirror.';
COMMENT ON COLUMN inventory.supplier.contact_name       IS 'Personal data (named contact). Subject to GDPR erasure via pseudonymized_at.';
COMMENT ON COLUMN inventory.supplier.contact_email      IS 'Personal data. Pseudonymized on erasure.';
COMMENT ON COLUMN inventory.supplier.tax_identifier     IS 'Business tax id (VAT/EIN). Confidential -- restrict and redact in reporting.';
COMMENT ON COLUMN inventory.supplier.hubspot_company_id IS 'Loose reference to crm HubSpot company mirror. NOT a FK (mirror rows can vanish on resync); resolved in the application.';
COMMENT ON COLUMN inventory.supplier.pseudonymized_at   IS 'Set when GDPR/CCPA erasure has overwritten contact PII while preserving PO history.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_org_code_live
    ON inventory.supplier (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_supplier_org     ON inventory.supplier (organization_id);
CREATE INDEX IF NOT EXISTS ix_supplier_hubspot ON inventory.supplier (hubspot_company_id) WHERE hubspot_company_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_supplier_set_updated_at ON inventory.supplier;
CREATE TRIGGER trg_supplier_set_updated_at
    BEFORE UPDATE ON inventory.supplier
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_supplier ON inventory.supplier;
CREATE TRIGGER zzz_audit_supplier
    AFTER INSERT OR UPDATE OR DELETE ON inventory.supplier
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('contact_name,contact_email,contact_phone,tax_identifier');

-- ---------------------------------------------------------------------
-- 9. inventory.purchase_order (header) + inventory.purchase_order_line
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory.purchase_order (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint        NOT NULL,
    po_number          citext        NOT NULL,
    supplier_id        bigint        NOT NULL,
    ship_to_warehouse_id bigint      NULL,
    status             inventory.purchase_order_status NOT NULL DEFAULT 'draft',
    currency_code      char(3)       NOT NULL,
    order_date         date          NULL,
    expected_date      date          NULL,
    subtotal_amount    numeric(18,4) NOT NULL DEFAULT 0,
    tax_amount         numeric(18,4) NOT NULL DEFAULT 0,
    total_amount       numeric(18,4) NOT NULL DEFAULT 0,
    notes              text          NULL,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    created_by         uuid          NULL,
    updated_by         uuid          NULL,
    deleted_at         timestamptz   NULL,
    CONSTRAINT uq_purchase_order_public_id UNIQUE (public_id),
    CONSTRAINT ck_purchase_order_subtotal_nonneg CHECK (subtotal_amount >= 0),
    CONSTRAINT ck_purchase_order_tax_nonneg      CHECK (tax_amount      >= 0),
    CONSTRAINT ck_purchase_order_total_nonneg    CHECK (total_amount    >= 0),
    CONSTRAINT ck_purchase_order_dates           CHECK (expected_date IS NULL OR order_date IS NULL OR expected_date >= order_date),
    CONSTRAINT fk_purchase_order_org      FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_purchase_order_supplier FOREIGN KEY (supplier_id)
        REFERENCES inventory.supplier(id)  ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_order_warehouse FOREIGN KEY (ship_to_warehouse_id)
        REFERENCES inventory.warehouse(id) ON DELETE RESTRICT,
    CONSTRAINT fk_purchase_order_currency FOREIGN KEY (currency_code)
        REFERENCES core.currency(code)
);
COMMENT ON TABLE  inventory.purchase_order IS 'Purchase order header. Totals denormalized from purchase_order_line for fast reads and recomputed by the app on line changes. Header currency_code governs all line money.';
COMMENT ON COLUMN inventory.purchase_order.po_number    IS 'Business PO number. Unique per organization among live rows.';
COMMENT ON COLUMN inventory.purchase_order.total_amount IS 'subtotal + tax (numeric, never float). Confidential commercial figure.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_order_org_number_live
    ON inventory.purchase_order (organization_id, po_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_purchase_order_org      ON inventory.purchase_order (organization_id);
CREATE INDEX IF NOT EXISTS ix_purchase_order_supplier ON inventory.purchase_order (supplier_id);
CREATE INDEX IF NOT EXISTS ix_purchase_order_status   ON inventory.purchase_order (organization_id, status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_purchase_order_set_updated_at ON inventory.purchase_order;
CREATE TRIGGER trg_purchase_order_set_updated_at
    BEFORE UPDATE ON inventory.purchase_order
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_purchase_order ON inventory.purchase_order;
CREATE TRIGGER zzz_audit_purchase_order
    AFTER INSERT OR UPDATE OR DELETE ON inventory.purchase_order
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified();

CREATE TABLE IF NOT EXISTS inventory.purchase_order_line (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          uuid          NOT NULL DEFAULT gen_random_uuid(),
    organization_id    bigint        NOT NULL,
    purchase_order_id  bigint        NOT NULL,
    line_number        integer       NOT NULL,
    product_id         bigint        NOT NULL,
    description        text          NULL,
    quantity_ordered   numeric(18,4) NOT NULL,
    quantity_received  numeric(18,4) NOT NULL DEFAULT 0,
    unit_price         numeric(18,4) NOT NULL,
    line_amount        numeric(18,4) NOT NULL DEFAULT 0,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    created_by         uuid          NULL,
    updated_by         uuid          NULL,
    deleted_at         timestamptz   NULL,
    CONSTRAINT uq_purchase_order_line_public_id UNIQUE (public_id),
    CONSTRAINT ck_pol_qty_ordered_pos     CHECK (quantity_ordered  > 0),
    CONSTRAINT ck_pol_qty_received_nonneg CHECK (quantity_received >= 0),
    CONSTRAINT ck_pol_qty_received_le_ordered CHECK (quantity_received <= quantity_ordered),
    CONSTRAINT ck_pol_unit_price_nonneg   CHECK (unit_price  >= 0),
    CONSTRAINT ck_pol_line_amount_nonneg  CHECK (line_amount >= 0),
    CONSTRAINT ck_pol_line_number_pos     CHECK (line_number > 0),
    CONSTRAINT fk_pol_org   FOREIGN KEY (organization_id)
        REFERENCES core.organization(id) ON DELETE CASCADE,
    CONSTRAINT fk_pol_po    FOREIGN KEY (purchase_order_id)
        REFERENCES inventory.purchase_order(id) ON DELETE CASCADE,
    CONSTRAINT fk_pol_product FOREIGN KEY (product_id)
        REFERENCES inventory.product(id) ON DELETE RESTRICT
);
COMMENT ON TABLE  inventory.purchase_order_line IS 'Line items of a purchase order. organization_id denormalized for single-predicate RLS. Lines cascade-delete with their header; request-path deletes are soft.';
COMMENT ON COLUMN inventory.purchase_order_line.line_number       IS 'Position within the PO. Unique per purchase_order among live rows.';
COMMENT ON COLUMN inventory.purchase_order_line.quantity_received IS 'Cumulative received against this line; drives partially_received/received status. Must be <= quantity_ordered.';
COMMENT ON COLUMN inventory.purchase_order_line.unit_price        IS 'Per-unit purchase cost in the header currency (numeric, never float). Confidential.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pol_po_line_live
    ON inventory.purchase_order_line (purchase_order_id, line_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_pol_org     ON inventory.purchase_order_line (organization_id);
CREATE INDEX IF NOT EXISTS ix_pol_po      ON inventory.purchase_order_line (purchase_order_id);
CREATE INDEX IF NOT EXISTS ix_pol_product ON inventory.purchase_order_line (product_id);

DROP TRIGGER IF EXISTS trg_purchase_order_line_set_updated_at ON inventory.purchase_order_line;
CREATE TRIGGER trg_purchase_order_line_set_updated_at
    BEFORE UPDATE ON inventory.purchase_order_line
    FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

DROP TRIGGER IF EXISTS zzz_audit_purchase_order_line ON inventory.purchase_order_line;
CREATE TRIGGER zzz_audit_purchase_order_line
    AFTER INSERT OR UPDATE OR DELETE ON inventory.purchase_order_line
    FOR EACH ROW EXECUTE FUNCTION audit.if_modified('unit_price');

-- ---------------------------------------------------------------------
-- 10. ROW-LEVEL SECURITY (tenant isolation) -- unit_of_measure is global (no RLS)
-- ---------------------------------------------------------------------
ALTER TABLE inventory.product_category     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.product              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.warehouse            ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.location             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_level          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.stock_movement       ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_order       ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_order_line  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_product_category_isolation ON inventory.product_category;
CREATE POLICY rls_product_category_isolation ON inventory.product_category
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_product_isolation ON inventory.product;
CREATE POLICY rls_product_isolation ON inventory.product
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_warehouse_isolation ON inventory.warehouse;
CREATE POLICY rls_warehouse_isolation ON inventory.warehouse
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_location_isolation ON inventory.location;
CREATE POLICY rls_location_isolation ON inventory.location
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_stock_level_isolation ON inventory.stock_level;
CREATE POLICY rls_stock_level_isolation ON inventory.stock_level
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_stock_movement_isolation ON inventory.stock_movement;
CREATE POLICY rls_stock_movement_isolation ON inventory.stock_movement
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_supplier_isolation ON inventory.supplier;
CREATE POLICY rls_supplier_isolation ON inventory.supplier
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_purchase_order_isolation ON inventory.purchase_order;
CREATE POLICY rls_purchase_order_isolation ON inventory.purchase_order
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

DROP POLICY IF EXISTS rls_purchase_order_line_isolation ON inventory.purchase_order_line;
CREATE POLICY rls_purchase_order_line_isolation ON inventory.purchase_order_line
    USING (organization_id = core.current_organization_id())
    WITH CHECK (organization_id = core.current_organization_id());

-- ---------------------------------------------------------------------
-- 11. LEAST-PRIVILEGE GRANTS (mirror core; no DELETE to app roles)
-- ---------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA inventory TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inventory TO app_readwrite;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA inventory
    GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA inventory
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_readwrite;

-- =====================================================================
-- END INVENTORY DOMAIN DDL
-- =====================================================================