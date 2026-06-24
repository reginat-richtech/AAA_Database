// China-SKU format helpers, shared by the add-item form and the API.
//
// Canonical shape: three hyphen-separated segments — SOURCE-CATEGORY-CODE
//   e.g. SE-ADAM-EC2X · R&D-DEXW-FCPM · ONET-SCOX-DBXX · SE-ADPU-X4.0
//   • SOURCE   2–4 chars (letters/digits, "&" allowed, e.g. SE, R&D, ONET)
//   • CATEGORY 2–5 chars (letters/digits) — drives category + product line
//   • CODE     2–6 chars (letters/digits, "." allowed, e.g. X4.0)
export const SKU_RE = /^[A-Z0-9&]{2,4}-[A-Z0-9]{2,5}-[A-Z0-9.]{2,6}$/;
export const SKU_HINT = 'Format: SOURCE-CATEGORY-CODE — e.g. SE-ADAM-EC2X';

export const normalizeSku = (s) => String(s || '').trim().toUpperCase();
export const isValidSku = (s) => SKU_RE.test(normalizeSku(s));
