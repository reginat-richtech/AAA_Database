-- =====================================================================
-- AAA_Database :: inventory allocation "consumed" marker
-- Target: PostgreSQL 16+   Depends on inventory.project_allocation.
--
-- When a project's inventory cart is "checked out", each allocation line consumes
-- stock (inventory.cn_sku.quantity is decremented). `consumed_at` records that a
-- line's stock was taken, so checkout is idempotent and "reopen" can add the exact
-- amounts back. NULL = still in the cart (not yet consumed). Self-contained + idempotent.
-- =====================================================================
ALTER TABLE inventory.project_allocation ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
