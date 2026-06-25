// Best-effort inventory-package extractor for the PROJECT PROPOSAL FORM.
// Two sources, in priority order:
//   1. extractPackageListFromFile() — reads the uploaded "Packing List" file
//      (image or PDF) with a multimodal model and TRANSLATES it to English.
//   2. extractPackageList() — falls back to pulling items out of the free-text
//      "Project Information" when no usable file is attached.
// Both are purely additive: they NEVER throw and NEVER block the webhook — on any
// miss they return [] / null and the proposal is still captured. Reuses the shared
// OpenRouter router (lib/ai/router.js); DEFAULT_MODEL is multimodal.
import { chatCompletion, firstMessage, aiConfigured, DEFAULT_MODEL } from './router';

const SYSTEM = [
  'You extract a hardware/inventory package list from a free-text project description.',
  'Return ONLY a JSON array (no prose, no markdown fences). Each element is',
  '{"item": string, "quantity": number, "notes": string}. "item" is a robot model',
  'or equipment name; "quantity" defaults to 1 if unstated; "notes" is "" if none.',
  'If nothing identifiable is mentioned, return [].',
].join(' ');

const FILE_SYSTEM = [
  'You read a packing list / equipment list from an uploaded document or photo.',
  'Extract EVERY line item. TRANSLATE any non-English text (e.g. Chinese) into English.',
  'Return ONLY a JSON array (no prose, no markdown fences). Each element is',
  '{"item": string, "quantity": number, "notes": string}. "item" is the product or',
  'equipment name in English; "quantity" is the count (default 1 if unstated); "notes"',
  'is "" if none — use it for a model/SKU code or the original-language name worth keeping.',
  'If the file is unreadable or lists no items, return [].',
].join(' ');

// Strip ```json fences / stray prose and parse the first JSON array we find.
function parseArray(content) {
  if (!content || typeof content !== 'string') return [];
  let s = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const direct = JSON.parse(s);
    if (Array.isArray(direct)) return direct;
  } catch {
    // fall through to bracket extraction
  }
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch { /* give up */ }
  }
  return [];
}

// Normalize each entry to {item, quantity, notes} and drop empty ones.
function normalize(arr) {
  return arr
    .map((e) => {
      if (!e) return null;
      const item = String(e.item || e.name || '').trim();
      if (!item) return null;
      const qRaw = e.quantity ?? e.qty ?? 1;
      const quantity = Number.isFinite(Number(qRaw)) && Number(qRaw) > 0 ? Number(qRaw) : 1;
      return { item, quantity, notes: String(e.notes || '').trim() };
    })
    .filter(Boolean);
}

export async function extractPackageList(projectInfoText) {
  const text = String(projectInfoText || '').trim();
  if (!text || !aiConfigured()) return [];
  try {
    const resp = await chatCompletion({
      model: DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
    });
    return normalize(parseArray(firstMessage(resp)?.content || ''));
  } catch {
    return []; // never block the webhook on an AI hiccup
  }
}

// Map a file URL's extension to a mime type (JotForm sometimes serves a generic
// content-type, so the extension is the more reliable signal).
function mimeFromUrl(url) {
  const m = String(url).toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif',
  }[m ? m[1] : ''] || '';
}

// Download a JotForm-uploaded file and return { mime, dataUrl }, or null on any
// problem (not found, empty, or too large to inline). JotForm upload URLs need the
// API key appended for non-public forms.
async function fetchFileAsDataUrl(url) {
  const key = process.env.JOTFORM_API_KEY;
  const u = key ? `${url}${url.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(key)}` : url;
  const r = await fetch(u);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 12 * 1024 * 1024) return null; // skip empty / >12MB
  const mime = mimeFromUrl(url) || (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mime) return null;
  return { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

// Build the multimodal content part for the model. Images go as image_url; PDFs go
// as a file part (OpenRouter routes it to the model's document parser). Other types
// are unsupported → null.
function contentPart(file, filename) {
  if (file.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: file.dataUrl } };
  if (file.mime === 'application/pdf') {
    return { type: 'file', file: { filename: filename || 'packing-list.pdf', file_data: file.dataUrl } };
  }
  return null;
}

// Read the uploaded Packing List file and return a translated, structured package
// list. Returns null when there is no usable file (so the caller can fall back to
// free-text extraction); returns [] when the file was read but held no items.
export async function extractPackageListFromFile(fileUrl) {
  const url = String(fileUrl || '').trim();
  if (!url || !aiConfigured()) return null;
  try {
    const file = await fetchFileAsDataUrl(url);
    if (!file) return null;
    const part = contentPart(file, url.split('/').pop());
    if (!part) return null; // unsupported file type
    const resp = await chatCompletion({
      model: DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: FILE_SYSTEM },
        { role: 'user', content: [{ type: 'text', text: 'Extract and translate this packing list.' }, part] },
      ],
    });
    return normalize(parseArray(firstMessage(resp)?.content || ''));
  } catch {
    return null; // never block the webhook on an AI/network hiccup
  }
}
