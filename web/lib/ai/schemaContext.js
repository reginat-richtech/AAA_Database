// Builds the schema description fed to the model so it can write correct SQL.
// Auto-introspected from information_schema (so it self-updates as ensureExtSchema
// adds columns) — the new-app equivalent of the old app's hand-written
// app/sql_engine/schema.py, with the old per-domain scoping (sql_engine/schema._DOMAIN_SCHEMAS).
import { query } from '../db';

export const ASSISTANT_SCHEMAS = ['ext', 'ops', 'inventory'];

// Per-tab scoping: each AI tab's assistant only sees its domain's tables, so the
// model isn't distracted by unrelated schema. Omit a domain → the full set above.
const DOMAIN_TABLES = {
  hubspot: ['ext.hubspot_deal', 'ext.hubspot_engagement', 'ext.hubspot_owner', 'ext.hubspot_pipeline'],
  finance: ['ext.quickbooks_invoice', 'ext.hubspot_deal'],
  travel: ['ext.navan_booking'],
};

const _cache = new Map();

export async function getSchemaContext(domain) {
  const key = domain && DOMAIN_TABLES[domain] ? domain : '_all';
  if (_cache.has(key)) return _cache.get(key);

  const scoped = DOMAIN_TABLES[domain];
  const { rows } = scoped
    ? await query(
        `select table_schema, table_name, column_name, data_type
           from information_schema.columns
          where table_schema || '.' || table_name = any($1)
          order by table_schema, table_name, ordinal_position`,
        [scoped],
      )
    : await query(
        `select table_schema, table_name, column_name, data_type
           from information_schema.columns
          where table_schema = any($1)
          order by table_schema, table_name, ordinal_position`,
        [ASSISTANT_SCHEMAS],
      );

  const tables = new Map();
  for (const r of rows) {
    const k = `${r.table_schema}.${r.table_name}`;
    if (!tables.has(k)) tables.set(k, []);
    tables.get(k).push(`${r.column_name} ${r.data_type}`);
  }
  const lines = [];
  for (const [tbl, cols] of tables) lines.push(`${tbl}(${cols.join(', ')})`);
  const ctx = lines.join('\n');
  _cache.set(key, ctx);
  return ctx;
}

export function clearSchemaCache() { _cache.clear(); }
