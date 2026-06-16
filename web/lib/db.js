import { Pool } from 'pg';

// Single shared pool across hot-reloads in dev.
const globalForPg = globalThis;
export const pool =
  globalForPg._aaaPool ||
  new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
if (!globalForPg._aaaPool) globalForPg._aaaPool = pool;

export async function query(text, params) {
  return pool.query(text, params);
}

// Schemas this admin tool is allowed to read in the DB browser.
export const BROWSABLE_SCHEMAS = [
  'core', 'crm', 'hr', 'inventory', 'invoicing', 'legal', 'workflow', 'audit',
];

// Confirm a schema.table really exists (guards the DB-browser against
// arbitrary identifier injection — we only interpolate names the catalog
// confirms, and only within the allow-listed schemas).
export async function resolveTable(schema, table) {
  if (!BROWSABLE_SCHEMAS.includes(schema)) return null;
  const { rows } = await query(
    `select table_schema, table_name,
            exists (select 1 from information_schema.columns c
                    where c.table_schema = t.table_schema
                      and c.table_name = t.table_name
                      and c.column_name = 'organization_id') as has_org
     from information_schema.tables t
     where t.table_schema = $1 and t.table_name = $2 and t.table_type = 'BASE TABLE'`,
    [schema, table]
  );
  return rows[0] || null;
}
