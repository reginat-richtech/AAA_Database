// Minimal JotForm client — submit a finalized form. Degrades gracefully when
// JOTFORM_API_KEY is not set (returns { ok:false, skipped }).
export async function createJotformSubmission(formId, payload) {
  const key = process.env.JOTFORM_API_KEY;
  if (!key) return { ok: false, form_id: formId, skipped: 'JOTFORM_API_KEY not configured' };
  try {
    const body = new URLSearchParams(payload);
    const r = await fetch(
      `https://api.jotform.com/form/${formId}/submissions?apiKey=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, form_id: formId, error: j.message || `JotForm HTTP ${r.status}` };
    const content = j.content || {};
    return { ok: true, form_id: formId, submission_id: content.submissionID || null, url: content.URL || null };
  } catch (e) {
    return { ok: false, form_id: formId, error: String(e?.message || e) };
  }
}
