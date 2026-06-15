-- =====================================================================
-- AAA_Database :: SEED 0001 :: Reference data
-- Target: PostgreSQL 16+
-- Idempotent: safe to run multiple times (ON CONFLICT / NOT EXISTS guards).
-- Run AFTER all migrations 0001..0050 have been applied.
--
-- Populates:
--   * core.country   -- ISO 3166-1 (subset of commonly used countries)
--   * core.currency  -- ISO 4217  (subset of commonly used currencies)
--   * core.role      -- platform/system application-RBAC roles (org-global)
--
-- NOTE: core.role here is the APPLICATION authorization role (who can do
-- what in the app). It is distinct from the Postgres DATABASE roles
-- (app_readwrite, app_readonly, crm_sync, app_migrator) created in
-- 0001_foundation.sql, which govern raw SQL/connection privileges.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Countries (ISO 3166-1 alpha-2 / alpha-3 / numeric)
-- ---------------------------------------------------------------------
INSERT INTO core.country (iso2, iso3, numeric_code, name) VALUES
    ('US','USA','840','United States'),
    ('CA','CAN','124','Canada'),
    ('GB','GBR','826','United Kingdom'),
    ('IE','IRL','372','Ireland'),
    ('DE','DEU','276','Germany'),
    ('FR','FRA','250','France'),
    ('ES','ESP','724','Spain'),
    ('IT','ITA','380','Italy'),
    ('NL','NLD','528','Netherlands'),
    ('SE','SWE','752','Sweden'),
    ('CH','CHE','756','Switzerland'),
    ('AU','AUS','036','Australia'),
    ('NZ','NZL','554','New Zealand'),
    ('JP','JPN','392','Japan'),
    ('CN','CHN','156','China'),
    ('IN','IND','356','India'),
    ('SG','SGP','702','Singapore'),
    ('AE','ARE','784','United Arab Emirates'),
    ('BR','BRA','076','Brazil'),
    ('MX','MEX','484','Mexico')
ON CONFLICT (iso2) DO NOTHING;

-- ---------------------------------------------------------------------
-- Currencies (ISO 4217). minor_unit drives money rounding (JPY=0, USD=2).
-- ---------------------------------------------------------------------
INSERT INTO core.currency (code, numeric_code, name, symbol, minor_unit) VALUES
    ('USD','840','US Dollar','$',2),
    ('CAD','124','Canadian Dollar','$',2),
    ('GBP','826','Pound Sterling','£',2),
    ('EUR','978','Euro','€',2),
    ('CHF','756','Swiss Franc','Fr',2),
    ('SEK','752','Swedish Krona','kr',2),
    ('AUD','036','Australian Dollar','$',2),
    ('NZD','554','New Zealand Dollar','$',2),
    ('JPY','392','Yen','¥',0),
    ('CNY','156','Renminbi','¥',2),
    ('INR','356','Indian Rupee','₹',2),
    ('SGD','702','Singapore Dollar','$',2),
    ('AED','784','UAE Dirham',NULL,2),
    ('BRL','986','Brazilian Real','R$',2),
    ('MXN','484','Mexican Peso','$',2)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- System application-RBAC roles (organization_id = NULL => global).
-- These are the named privilege bundles your application checks against.
-- ---------------------------------------------------------------------
INSERT INTO core.role (organization_id, code, name, description, is_system)
SELECT NULL, v.code, v.name, v.description, true
FROM (VALUES
    ('org_admin',          'Organization Admin',  'Full administrative access within a tenant.'),
    ('finance_manager',    'Finance Manager',     'Manage invoicing, payments, credit notes, tax.'),
    ('ar_clerk',           'AR Clerk',            'Create/send invoices and record payments (no voids/credits).'),
    ('sales_rep',          'Sales Rep',           'Read CRM contacts/companies/deals; create draft invoices.'),
    ('hr_manager',         'HR Manager',          'Manage employees, employment, compensation (sensitive HR).'),
    ('hr_specialist',      'HR Specialist',       'Manage working-time, leave, attendance; no compensation.'),
    ('inventory_manager',  'Inventory Manager',   'Manage products, warehouses, stock and movements.'),
    ('warehouse_clerk',    'Warehouse Clerk',     'Record stock movements; read product/stock levels.'),
    ('legal_counsel',      'Legal Counsel',       'Full access to legal agreements and documents.'),
    ('contracts_manager',  'Contracts Manager',   'Manage agreements, versions, signatories.'),
    ('analyst_readonly',   'Analyst (Read-only)', 'Read masked/aggregated data for reporting only.'),
    ('auditor',            'Auditor',             'Read-only access to audit history and activity logs.'),
    ('security_admin',     'Security Admin',      'Manage roles, keys, RLS context and erasure operations.')
) AS v(code, name, description)
WHERE NOT EXISTS (
    SELECT 1 FROM core.role r
    WHERE r.organization_id IS NULL AND r.code = v.code
);
