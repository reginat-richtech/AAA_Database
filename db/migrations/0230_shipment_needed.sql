-- =====================================================================
-- AAA_Database :: shipment "shipping needed?" flag
-- Target: PostgreSQL 16+   Depends on 0220_shipment.
--
-- Some projects need no carrier shipment (on-site install / customer pickup /
-- hand delivery). `shipping_needed=false` → no carrier/tracking/ship-cost; the
-- address + estimated arrival date are still recorded. Idempotent.
-- =====================================================================
ALTER TABLE ops.shipment ADD COLUMN IF NOT EXISTS shipping_needed boolean NOT NULL DEFAULT true;
