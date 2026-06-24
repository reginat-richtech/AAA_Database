import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/access';
import { chatCompletion, firstMessage, MODELS, DEFAULT_MODEL, aiConfigured } from '../../../lib/ai/router';
import { getSchemaContext } from '../../../lib/ai/schemaContext';
import { runReadOnlySql } from '../../../lib/ai/sqlTool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The single tool the assistant has: run a read-only query. The model writes the
// SQL (it sees the schema in the system prompt); the tool just executes it safely.
const QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'query_database',
    description: 'Run ONE read-only PostgreSQL SELECT/WITH query against the company database and return the rows. Use it to answer any question about the data; you may call it multiple times to refine.',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single read-only PostgreSQL SELECT or WITH query.' } },
      required: ['sql'],
    },
  },
};

const MAX_ROUNDS = 5;

// Per-tab focus line (the assistant is embedded in each AI tab, scoped by domain).
const DOMAIN_FOCUS = {
  hubspot: 'This is the HubSpot tab — focus on deals, pipeline, owners, and engagement activity.',
  finance: 'This is the Finance tab — focus on QuickBooks invoices and revenue.',
  travel: 'This is the Travel tab — focus on Navan travel bookings and spend.',
};

// Config for the picker + a "configured?" flag.
export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  return NextResponse.json({ models: MODELS, defaultModel: DEFAULT_MODEL, configured: aiConfigured() });
}

export async function POST(req) {
  const { response } = await requireAdmin();
  if (response) return response;
  if (!aiConfigured()) {
    return NextResponse.json({ error: 'Assistant not configured — set OPENROUTER_API_KEY.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const model = (body.model && String(body.model)) || DEFAULT_MODEL;
  const domain = body.domain ? String(body.domain) : null;
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!history.length) return NextResponse.json({ error: 'No message provided.' }, { status: 400 });

  const schema = await getSchemaContext(domain);
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    'You are a careful, read-only data analyst for the AAA company database (PostgreSQL).',
    DOMAIN_FOCUS[domain] || 'You can query tasks, projects, deals, invoices, travel, and inventory.',
    'Answer the user by querying the database with the query_database tool. You may call it multiple times.',
    'RULES:',
    '- Read-only SELECT/WITH only. Never attempt to write or modify data.',
    '- Use EXACT schema-qualified names from the schema below (e.g. ext.task, ops.legal_agreement, inventory.cn_sku).',
    "- Columns named `raw` are jsonb holding the full source record — read nested fields with raw->>'fieldName'. Prefer the indexed key columns when available.",
    '- Add a LIMIT when listing rows; for totals use SUM/COUNT/AVG with GROUP BY.',
    `- Use ISO date literals like '2026-01-01'::date. Today is ${today}.`,
    '- After getting data, answer in clear plain language; show key numbers and use a small markdown table when listing.',
    '- If a query errors, read the message and retry a corrected query.',
    '',
    'SCHEMA — format is schema.table(column type, ...):',
    schema,
  ].join('\n');

  const convo = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
  ];
  const sqlLog = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await chatCompletion({ model, messages: convo, tools: [QUERY_TOOL], temperature: 0.1, max_tokens: 1500 });
      const msg = firstMessage(resp);
      if (!msg) return NextResponse.json({ error: 'Empty model response.' }, { status: 502 });
      convo.push(msg);

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        return NextResponse.json({ reply: msg.content || '(no answer)', sqlLog, model: resp.model || model });
      }
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* malformed args */ }
        const result = await runReadOnlySql(args.sql || '');
        sqlLog.push({ sql: result.sql_used || args.sql || '', error: result.error || null, rows: result.row_count ?? 0 });
        const forModel = {
          error: result.error || null, columns: result.columns,
          row_count: result.row_count, truncated: result.truncated,
          rows: (result.rows || []).slice(0, 50),
        };
        convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(forModel).slice(0, 12000) });
      }
    }
    // Out of rounds: force a final answer with tools disabled.
    const final = await chatCompletion({
      model,
      messages: [...convo, { role: 'user', content: 'Give your best answer now from what you already have. Do not call any tools.' }],
      temperature: 0.2, max_tokens: 1200,
    });
    return NextResponse.json({ reply: firstMessage(final)?.content || 'I could not finish that within the step limit.', sqlLog, model });
  } catch (e) {
    return NextResponse.json({ error: e.message, sqlLog }, { status: 502 });
  }
}
