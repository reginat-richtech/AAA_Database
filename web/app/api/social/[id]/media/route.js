import { NextResponse } from 'next/server';
import { requireUser } from '../../../../../lib/access';
import { query, mutateAs } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMAGE = 10 * 1024 * 1024;  // 10 MB
const MAX_VIDEO = 50 * 1024 * 1024;  // 50 MB

async function loadPost(id) {
  const { rows } = await query('select id, author_email, status from ext.social_post where id = $1', [id]);
  return rows[0] || null;
}

// Attach one or more image/video files to a post (stored as bytea).
export async function POST(req, { params }) {
  const { user, response } = await requireUser();
  if (response) return response;
  const { id } = await params;
  const post = await loadPost(id);
  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  const owner = (post.author_email || '').toLowerCase() === user.email;
  if (!user.isAdmin && !owner) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  if (post.status === 'published') return NextResponse.json({ error: 'Post is already published' }, { status: 409 });

  let fd;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 }); }
  const files = fd.getAll('file').filter((f) => f && typeof f.arrayBuffer === 'function');
  if (!files.length) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });

  const out = [];
  for (const f of files) {
    const ct = f.type || 'application/octet-stream';
    const kind = ct.startsWith('video/') ? 'video' : ct.startsWith('image/') ? 'image' : null;
    if (!kind) return NextResponse.json({ error: `Unsupported file type: ${ct} (images or video only)` }, { status: 415 });
    const limit = kind === 'video' ? MAX_VIDEO : MAX_IMAGE;
    if (f.size > limit) return NextResponse.json({ error: `${f.name || 'file'} is too large — max ${Math.round(limit / 1048576)}MB for ${kind}` }, { status: 413 });
    const buf = Buffer.from(await f.arrayBuffer());
    const mid = crypto.randomUUID();
    await mutateAs(user.email, (q) => q(
      `insert into ext.social_media (id, post_id, kind, content_type, filename, bytes, size) values ($1,$2,$3,$4,$5,$6,$7)`,
      [mid, id, kind, ct, f.name || null, buf, buf.length],
    ));
    out.push({ id: mid, kind, content_type: ct, filename: f.name || null });
  }
  return NextResponse.json({ ok: true, media: out });
}
