-- =====================================================================
-- AAA_Database :: SEED 0002 :: the single company this system serves
-- ---------------------------------------------------------------------
-- This is a single-company (single-tenant) deployment. The schema still
-- supports multiple organizations internally, but in practice there is
-- exactly one. Rename freely by editing display_name / legal_name below.
-- Idempotent.
-- =====================================================================
INSERT INTO core.organization (legal_name, display_name, slug)
SELECT 'Richtech Systems', 'Richtech', 'richtech'
WHERE NOT EXISTS (SELECT 1 FROM core.organization WHERE slug = 'richtech');
