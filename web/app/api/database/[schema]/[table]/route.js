import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../lib/access';
import { query, resolveTable } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Returns columns + the first N rows of one browsable table (read-only).
// resolveTable() validates the identifiers against the catalog + allow-list,
// so the (quoted) names are safe to interpolate. bytea columns are returned as
// their byte length, never raw binary.
export async function GET(req, { params }) {
  const { response } = await requireAdmin();
  if (response) return response;

  const { schema, table } = await params;
  const t = await resolveTable(schema, table);
  if (!t) return NextResponse.json({ error: 'Unknown or non-browsable table.' }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);

  const { rows: cols } = await query(
    `select column_name, data_type from information_schema.columns
      where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [schema, table]
  );

  const selectList = cols
    .map((c) => (c.data_type === 'bytea'
      ? `octet_length("${c.column_name}") as "${c.column_name}"`   // size, not raw bytes
      : `"${c.column_name}"`))
    .join(', ');

  const { rows } = await query(`select ${selectList} from "${schema}"."${table}" limit ${limit}`);
  const { rows: cnt } = await query(`select count(*)::bigint as n from "${schema}"."${table}"`);

  return NextResponse.json({
    schema, table, limit,
    total: Number(cnt[0].n),
    columns: cols.map((c) => ({ name: c.column_name, type: c.data_type })),
    rows,
  });
}
