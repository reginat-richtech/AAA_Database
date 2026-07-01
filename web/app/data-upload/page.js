'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '../_components/blueprint';

const EMPTY_ROBOT = { name: '', robot_type: '', service_type: '', quantity: 1, unit_price: null };

export default function DataUpload() {
  const router = useRouter();
  const [meta, setMeta] = useState({ models: [], service_types: [], agreement_types: [] });
  const [list, setList] = useState([]);
  const [up, setUp] = useState({ salesman_name: '', salesman_email: '', contract: '', proposal: '', file: null });
  const [editable, setEditable] = useState(true);   // false → finalized, admin-only
  const [cur, setCur] = useState(null);          // loaded agreement (with .extracted)
  const [fields, setFields] = useState(null);    // editable headline fields
  const [robots, setRobots] = useState([]);      // editable robots
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch('/api/data-upload/robot-models').then((r) => r.json()).then(setMeta).catch(() => {});
    loadList();
    // Prefill from a proposal's "Upload agreement" link. `proposal` (the proposal
    // id) is the deterministic link that attaches this agreement to that exact
    // proposal in the tracker; sales_name/email/contract just prefill fields.
    const sp = new URLSearchParams(window.location.search);
    const sName = sp.get('sales_name') || '';
    const sEmail = sp.get('sales_email') || '';
    const contract = sp.get('contract') || '';
    const proposal = sp.get('proposal') || '';
    if (sName || sEmail || contract || proposal) {
      setUp((s) => ({ ...s, salesman_name: sName || s.salesman_name, salesman_email: sEmail || s.salesman_email, contract: contract || s.contract, proposal: proposal || s.proposal }));
    }
  }, []);
  function loadList() {
    fetch('/api/data-upload').then((r) => r.json()).then((d) => setList(d.agreements || [])).catch(() => {});
  }

  function loadAgreement(a) {
    setCur(a);
    setFields({
      agreement_type: a.agreement_type || 'Other', title: a.title || '', counterparty: a.counterparty || '',
      governing_law: a.governing_law || '', effective_date: a.effective_date?.slice(0, 10) || '',
      execution_date: a.execution_date?.slice(0, 10) || '', expiration_date: a.expiration_date?.slice(0, 10) || '',
      auto_renewal: a.auto_renewal === true ? 'yes' : a.auto_renewal === false ? 'no' : '',
      contract_value: a.contract_value ?? '', currency: a.currency || 'USD',
      termination_notice_days: a.termination_notice_days ?? '', summary: a.summary || '',
      salesman_name: a.salesman_name || '', salesman_email: a.salesman_email || '', deal_id: a.deal_id || '',
    });
    setRobots(Array.isArray(a.extracted?.robots) ? a.extracted.robots.map((r) => ({ ...EMPTY_ROBOT, ...r })) : []);
    setEditable(a.editable !== false);   // finalized + non-admin → read-only
  }

  async function analyze(e) {
    e.preventDefault(); setMsg(null);
    if (!up.file) { setMsg({ err: 'Choose a PDF first.' }); return; }
    setBusy(true);
    const fd = new FormData();
    fd.append('file', up.file);
    fd.append('salesman_name', up.salesman_name);
    fd.append('salesman_email', up.salesman_email);
    fd.append('contract', up.contract);
    fd.append('proposal_id', up.proposal);
    const r = await fetch('/api/data-upload', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (!r.ok) { setMsg({ err: j.error || `Upload failed (HTTP ${r.status})` }); return; }
    loadList();
    const n = j.notify || {};
    const notifyNote = n.sent ? ` ✉️ Tech Request link emailed to ${n.to}.`
      : n.error ? ` ⚠️ Couldn't email the salesperson (${n.error}).`
      : n.skipped ? ` (Salesperson not emailed: ${n.skipped}.)` : '';
    if (j.status === 'error') setMsg({ err: `Saved, but extraction failed: ${j.error}.${notifyNote}` });
    else setMsg({ ok: `Extracted ${j.project_number}. Review and save below.${notifyNote}` });
    // fetch full detail (with extracted) for editing
    const detail = await (await fetch(`/api/data-upload/${j.id}`)).json().catch(() => null);
    if (detail) loadAgreement(detail);
  }

  const setF = (k, v) => setFields((s) => ({ ...s, [k]: v }));
  const setR = (i, k, v) => setRobots((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/data-upload/${cur.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, robots }),
    });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (!r.ok) { setMsg({ err: j.error || `Save failed (HTTP ${r.status})` }); return; }
    setMsg({ ok: 'Saved to database.' }); loadList(); loadAgreement(j);
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button type="button" className="secondary" onClick={() => router.back()}>← Back</button>
      </div>
      <PageHeader title="Data Upload" sub="Upload an agreement PDF → AI extracts the fields → review & edit → save." sheet="Data Upload" />

      <div className="split">
        <div>
          <div className="panel">
            <form className="form" onSubmit={analyze}>
              <label>Agreement PDF *
                <input type="file" accept="application/pdf" required
                  onChange={(e) => setUp((s) => ({ ...s, file: e.target.files?.[0] || null }))} />
              </label>
              <div className="row2">
                <label>Salesman name *<input value={up.salesman_name} required onChange={(e) => setUp((s) => ({ ...s, salesman_name: e.target.value }))} /></label>
                <label>Salesman email *<input type="email" value={up.salesman_email} required onChange={(e) => setUp((s) => ({ ...s, salesman_email: e.target.value }))} /></label>
              </div>
              <div><button disabled={busy}>{busy ? 'Analyzing…' : 'Analyze document'}</button></div>
              {msg?.ok && <p className="ok-msg">{msg.ok}</p>}{msg?.err && <p className="error">{msg.err}</p>}
            </form>
          </div>

          {cur && fields && (
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>Review — {cur.project_number} <span className={'chip ' + (cur.status === 'ready' ? 'ok' : 'bad')}>{cur.status}</span></h2>
              {!editable && <p className="error">🔒 This agreement is finalized — only an admin can edit it.</p>}
              <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
              <div className="form">
                <label>Agreement type
                  <select value={fields.agreement_type} onChange={(e) => setF('agreement_type', e.target.value)}>
                    {meta.agreement_types.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </label>
                <label>Title<input value={fields.title} onChange={(e) => setF('title', e.target.value)} /></label>
                <label>Counterparty<input value={fields.counterparty} onChange={(e) => setF('counterparty', e.target.value)} /></label>
                <div className="row2">
                  <label>Effective date<input type="date" value={fields.effective_date} onChange={(e) => setF('effective_date', e.target.value)} /></label>
                  <label>Expiration date<input type="date" value={fields.expiration_date} onChange={(e) => setF('expiration_date', e.target.value)} /></label>
                </div>
                <div className="row2">
                  <label>Contract value<input type="number" step="0.01" value={fields.contract_value} onChange={(e) => setF('contract_value', e.target.value)} /></label>
                  <label>Currency<input value={fields.currency} onChange={(e) => setF('currency', e.target.value)} /></label>
                </div>
                <div className="row2">
                  <label>Governing law<input value={fields.governing_law} onChange={(e) => setF('governing_law', e.target.value)} /></label>
                  <label>Auto-renewal
                    <select value={fields.auto_renewal} onChange={(e) => setF('auto_renewal', e.target.value)}>
                      <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
                    </select>
                  </label>
                </div>
                <label>Summary<textarea rows={3} value={fields.summary} onChange={(e) => setF('summary', e.target.value)} /></label>

                <h3>Robots &amp; equipment</h3>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>Model</th><th>Service</th><th>Qty</th><th>Unit price</th><th></th></tr></thead>
                    <tbody>
                      {robots.map((r, i) => (
                        <tr key={i}>
                          <td><input list="robot-models" value={r.name} onChange={(e) => setR(i, 'name', e.target.value)} /></td>
                          <td>
                            <select value={r.service_type || ''} onChange={(e) => setR(i, 'service_type', e.target.value)}>
                              <option value="">—</option>{meta.service_types.map((s) => <option key={s}>{s}</option>)}
                            </select>
                          </td>
                          <td><input type="number" style={{ width: 64 }} value={r.quantity ?? ''} onChange={(e) => setR(i, 'quantity', e.target.value === '' ? null : Number(e.target.value))} /></td>
                          <td><input type="number" step="0.01" style={{ width: 100 }} value={r.unit_price ?? ''} onChange={(e) => setR(i, 'unit_price', e.target.value === '' ? null : Number(e.target.value))} /></td>
                          <td><button type="button" className="secondary" onClick={() => setRobots((rs) => rs.filter((_, j) => j !== i))}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <datalist id="robot-models">{meta.models.map((m) => <option key={m} value={m} />)}</datalist>
                </div>
                <div><button type="button" className="secondary" onClick={() => setRobots((rs) => [...rs, { ...EMPTY_ROBOT }])}>+ Add robot</button></div>

                {editable && <p className="note" style={{ marginTop: 8 }}>Saving finalizes this agreement; afterward only an admin can edit it.</p>}
                <div style={{ marginTop: 8 }}><button onClick={save} disabled={busy || !editable}>{busy ? 'Saving…' : 'Save to database'}</button></div>
              </div>
              </fieldset>
            </div>
          )}
        </div>

        <div>
          <div className="panel" style={{ minHeight: 380 }}>
            {cur ? (
              <iframe title="pdf" src={`/api/data-upload/${cur.id}/file`} style={{ width: '100%', height: 520, border: 0 }} />
            ) : <p className="note">The uploaded PDF will preview here.</p>}
          </div>
        </div>
      </div>

      <h2>Recent uploads</h2>
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Project</th><th>Title</th><th>Type</th><th>Counterparty</th><th>Status</th><th>Uploaded</th></tr></thead>
          <tbody>
            {list.length ? list.map((a) => (
              <tr key={a.id} style={{ cursor: 'pointer' }} onClick={async () => loadAgreement(await (await fetch(`/api/data-upload/${a.id}`)).json())}>
                <td>{a.project_number}</td><td>{a.title || '—'}</td><td>{a.agreement_type}</td><td>{a.counterparty || '—'}</td>
                <td><span className={'chip ' + (a.status === 'ready' ? 'ok' : a.status === 'error' ? 'bad' : 'warn')}>{a.status}</span></td>
                <td>{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            )) : <tr><td colSpan={6} className="note">No uploads yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
