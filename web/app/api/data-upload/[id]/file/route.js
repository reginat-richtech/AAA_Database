import { query } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  const { id } = await params;
  const { rows } = await query(
    'select source_pdf, content_type, filename from ops.legal_agreement where id = $1', [id]
  );
  const row = rows[0];
  if (!row || !row.source_pdf) return new Response('not found', { status: 404 });
  return new Response(row.source_pdf, {
    headers: {
      'Content-Type': row.content_type || 'application/pdf',
      'Content-Disposition': `inline; filename="${(row.filename || 'document.pdf').replace(/"/g, '')}"`,
    },
  });
}
