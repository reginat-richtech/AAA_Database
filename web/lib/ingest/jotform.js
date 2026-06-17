// Full-history JotForm submissions → ext.jotform_submission. Pulls every
// submission across all forms (1000/page) and upserts on submission id.
import { ensureExtSchema, upsertBatch } from './schema';

const BASE = 'https://api.jotform.com';
const KEY = process.env.JOTFORM_API_KEY || '';
const COLS = ['id', 'form_id', 'form_title', 'status', 'created_at', 'updated_at', 'raw'];

async function jf(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}apiKey=${encodeURIComponent(KEY)}`);
  if (!r.ok) throw new Error(`JotForm ${r.status}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}

export async function syncJotform() {
  if (!KEY) return { source: 'jotform', ok: false, rows: 0, skipped: 'JOTFORM_API_KEY not configured' };
  await ensureExtSchema();

  // form id -> title (best effort; submissions don't carry the title)
  const titles = {};
  try {
    const f = await jf('/user/forms?limit=1000');
    for (const form of f.content || []) titles[form.id] = form.title;
  } catch { /* non-fatal */ }

  let total = 0, offset = 0;
  for (let i = 0; i < 500; i++) {
    const j = await jf(`/user/submissions?limit=1000&offset=${offset}&orderby=created_at`);
    const content = j.content || [];
    if (!content.length) break;
    const rows = content.map((s) => [
      s.id, s.form_id || null, titles[s.form_id] || null, s.status || null,
      s.created_at || null, s.updated_at || null, JSON.stringify(s),
    ]);
    total += await upsertBatch('ext.jotform_submission', COLS, 'id', rows, { jsonCols: ['raw'] });
    offset += content.length;
    if (content.length < 1000) break;
  }
  return { source: 'jotform', ok: true, rows: total };
}
