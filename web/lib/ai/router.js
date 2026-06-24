// Multi-model router — calls models through OpenRouter's OpenAI-compatible
// /chat/completions endpoint, so you can A/B different models by passing a
// model id. Ported from the old app's app/llm/openai_client.py (model_override
// → any OpenRouter model). Requires env OPENROUTER_API_KEY.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// The models offered in the assistant's picker. Edit freely — any id from
// https://openrouter.ai/models works (format: "provider/model").
export const MODELS = [
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku (fast)' },
];
export const DEFAULT_MODEL = MODELS[0].id;

export function aiConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

// One chat-completion call. messages/tools follow the OpenAI schema (OpenRouter
// normalizes across providers). Returns the raw JSON response.
export async function chatCompletion({ model, messages, tools, tool_choice, temperature = 0.2, max_tokens, signal }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set — add it to enable the assistant.');

  const body = { model: model || DEFAULT_MODEL, messages, temperature };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice || 'auto'; }
  if (max_tokens) body.max_tokens = max_tokens;

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter attribution headers (optional but recommended).
      'HTTP-Referer': process.env.NEXTAUTH_URL || 'http://localhost:3100',
      'X-Title': 'AAA Assistant',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Model call failed (${res.status}): ${detail.slice(0, 400)}`);
  }
  return res.json();
}

export function firstMessage(resp) {
  return resp?.choices?.[0]?.message || null;
}
