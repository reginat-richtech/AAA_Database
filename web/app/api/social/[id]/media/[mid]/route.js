import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../../lib/access';
import { query, mutateAs } from '../../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadMedia(id, mid) {
  const { rows } = await query(
    `select m.id, m.content_type, m.filename, m.bytes, p.author_email
       from ext.social_media m join ext.social_post p on p.id = m.post_id
      where m.id = $1 and m.post_id = $2`,
    [mid, id],
  );
  return rows[0] || null;
}
const visible = (user, m) => user.isAdmin || (m.author_email || '').toLowerCase() === user.email;

export async function GET(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  const { id, mid } = await params;
  const m = await loadMedia(id, mid);
  if (!m || !visible(user, m)) return new Response('not found', { status: 404 });
  return new Response(m.bytes, {
    headers: {
      'Content-Type': m.content_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(m.filename || 'media').replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}

export async function DELETE(_req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  const { id, mid } = await params;
  const m = await loadMedia(id, mid);
  if (!m) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!visible(user, m)) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  await mutateAs(user.email, (q) => q('delete from ext.social_media where id = $1', [mid]));
  return NextResponse.json({ ok: true });
}
