// Read-only text-to-SQL execution. Ported from the old app's
// app/sql_engine/executor.py, hardened: defense-in-depth = (1) a SELECT/WITH-only
// regex guard, (2) execution inside a BEGIN READ ONLY transaction so Postgres
// itself rejects any write/DDL even if the regex is fooled, (3) a statement
// timeout, (4) an auto LIMIT. Always rolls back (never commits).
import { pool } from '../db';

const MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 15000;
// Any of these keywords as a whole word ⇒ reject (write/DDL/admin verbs).
const BLOCKED = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|CALL|DO|COPY|VACUUM|ANALYZE|REINDEX|REFRESH|CLUSTER|LOCK|COMMENT|SET|RESET|SECURITY|EXECUTE)\b/i;

// Returns an error string if the SQL is not a safe single read-only query, else null.
export function checkSafe(sql) {
  const s = String(sql || '').trim();
  if (!s) return 'Empty query.';
  if (!/^(SELECT|WITH)\b/i.test(s)) return 'Query must start with SELECT or WITH.';
  if (BLOCKED.test(s)) return 'Only read-only SELECT queries are allowed (no writes or DDL).';
  // Disallow stacked statements: a ";" anywhere except a single trailing one.
  if (s.replace(/;\s*$/, '').includes(';')) return 'Only a single statement is allowed.';
  return null;
}

export async function runReadOnlySql(sql) {
  const err = checkSafe(sql);
  if (err) return { error: err, rows: [], columns: [], row_count: 0 };

  let q = String(sql).trim().replace(/;\s*$/, '');
  if (!/\bLIMIT\s+\d+/i.test(q)) q = `${q}\nLIMIT ${MAX_ROWS}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const res = await client.query(q);
    await client.query('ROLLBACK');
    const columns = (res.fields || []).map((f) => f.name);
    return {
      rows: res.rows,
      columns,
      row_count: res.rows.length,
      truncated: res.rows.length >= MAX_ROWS,
      sql_used: q,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { error: e.message, rows: [], columns: [], row_count: 0, sql_used: q };
  } finally {
    client.release();
  }
}
