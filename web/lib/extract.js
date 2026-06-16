// Data Upload extraction — mirrors the old app's WORKING path:
//   1) read the PDF's text locally (pdf-parse == the old app's pypdf step)
//   2) OpenAI gpt-4.1 turns that text -> structured fields (JSON schema)
// No vision/OCR API needed for text-based PDFs (which is the common case and
// exactly the old app's text-parser fallback). Scanned/image PDFs would need a
// vision step + a valid key — not wired here since the OpenRouter key is dead.
import { PDFParse } from 'pdf-parse';

const FIELDS_MODEL = process.env.EXTRACT_FIELDS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

export const AGREEMENT_TYPES = ['RaaS Agreement', 'Event Rental Agreement', 'Full Robot Sale', 'Other'];
export const SERVICE_TYPES = ['RaaS', 'Event', 'Full Robot Sale'];
export const ROBOT_MODELS = [
  'ADAM', 'ADAM System (Excluded Trailer)', 'Scorpion', 'Scorpion Single Arm Robot System Set',
  'Matradee Plus', 'Matradee L', 'Titan 300', 'Titan 440', 'TITAN 1300',
  'DUST-E S', 'DUST-E', 'Ascend/MedBot', 'ACE', 'Other',
];

const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agreement_type: { type: 'string', enum: AGREEMENT_TYPES },
    title: { type: 'string' },
    counterparty: { type: 'string' },
    client_contact_name: { type: 'string' },
    client_email: { type: 'string' },
    client_phone: { type: 'string' },
    client_address: { type: 'string' },
    effective_date: nullable('string'),
    execution_date: nullable('string'),
    expiration_date: nullable('string'),
    delivery_date: nullable('string'),
    term_description: { type: 'string' },
    auto_renewal: nullable('boolean'),
    contract_value: nullable('number'),
    currency: { type: 'string' },
    payment_terms: { type: 'string' },
    governing_law: { type: 'string' },
    termination_notice_days: nullable('integer'),
    robots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          robot_type: { type: 'string' },
          name: { type: 'string' },
          service_type: { type: 'string' },
          quantity: nullable('integer'),
          unit_price: nullable('number'),
        },
        required: ['robot_type', 'name', 'service_type', 'quantity', 'unit_price'],
      },
    },
    key_obligations: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: [
    'agreement_type', 'title', 'counterparty', 'client_contact_name', 'client_email',
    'client_phone', 'client_address', 'effective_date', 'execution_date', 'expiration_date',
    'delivery_date', 'term_description', 'auto_renewal', 'contract_value', 'currency',
    'payment_terms', 'governing_law', 'termination_notice_days', 'robots', 'key_obligations', 'summary',
  ],
};

const SYSTEM = `You extract structured data from a Richtech Robotics agreement. You are given the agreement's full text.
Rules:
- "counterparty" is the main party that is NOT Richtech (the customer/client).
- Dates must be ISO YYYY-MM-DD, or null if not stated.
- Money values are plain numbers (no symbols/commas), null if not stated.
- Expand each robot line into the "robots" array; "quantity" = unit count, "name" = canonical model name.
- agreement_type ∈ {RaaS Agreement, Event Rental Agreement, Full Robot Sale, Other}.
- Use "" for unknown text fields, null for unknown dates/numbers. Do not invent values.
- "summary" is 2-3 plain-English sentences.`;

// Stage 1 — local PDF text extraction (the old app's pypdf path).
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.text || '').replace(/\x00/g, '').trim();
  } finally {
    try { await parser.destroy?.(); } catch {}
  }
}

// Stage 2 — gpt-4.1 turns text into structured fields.
async function extractFields(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured (needed for the gpt-4.1 field step).');
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: FIELDS_MODEL,
      temperature: 0,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `AGREEMENT TEXT:\n"""\n${text.slice(0, 48000)}\n"""` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'legal_agreement', strict: true, schema: EXTRACTION_SCHEMA } },
    }),
  });
  if (!r.ok) throw new Error(`Field step (OpenAI ${FIELDS_MODEL}) HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return JSON.parse(j.choices?.[0]?.message?.content || '{}');
}

export async function extractAgreement(pdfBuffer) {
  try {
    const text = await extractPdfText(pdfBuffer);
    if (!text) {
      throw new Error('No selectable text found in the PDF. It may be a scanned image — that needs a vision/OCR step (off, no valid key).');
    }
    const extracted = await extractFields(text);
    return { ok: true, extracted, extract_method: `pdf-text + ${FIELDS_MODEL}`, error: null, source_text: text.slice(0, 48000) };
  } catch (e) {
    return { ok: false, extracted: {}, extract_method: 'pdf-text + llm', error: String(e?.message || e), source_text: null };
  }
}

// Flatten extracted JSON into the headline columns on ops.legal_agreement.
export function headlineFields(ex) {
  const robots = Array.isArray(ex.robots) ? ex.robots : [];
  const families = [...new Set(robots.map((r) => (r.robot_type || r.name || '').trim()).filter(Boolean))];
  const count = robots.reduce((n, r) => n + (Number(r.quantity) || 1), 0);
  const d = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    agreement_type: ex.agreement_type || 'Other',
    title: ex.title || null,
    counterparty: ex.counterparty || null,
    effective_date: d(ex.effective_date),
    execution_date: d(ex.execution_date),
    expiration_date: d(ex.expiration_date),
    auto_renewal: typeof ex.auto_renewal === 'boolean' ? ex.auto_renewal : null,
    contract_value: ex.contract_value ?? null,
    currency: ex.currency || 'USD',
    governing_law: ex.governing_law || null,
    termination_notice_days: ex.termination_notice_days ?? null,
    robot_types: families.join(', ') || null,
    robot_count: robots.length ? count : null,
    summary: ex.summary || null,
  };
}
