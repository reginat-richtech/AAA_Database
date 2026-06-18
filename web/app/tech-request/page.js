'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '../_components/blueprint';

const STATUS_CHIP = { none: '', saved: 'warn', finalized: 'info', approved: 'ok' };

export default function TechRequest() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);      // loaded form (sections, values, submission...)
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { loadList(); }, []);
  // Auto-open a specific agreement's form when linked from the Project Tracker
  // (e.g. /tech-request?agreement=<id>).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('agreement');
    if (id) openForm(id);
  }, []);
  function loadList() {
    fetch('/api/tech-request/agreements').then((r) => r.json()).then((d) => setList(d.agreements || [])).catch(() => {});
  }
  async function openForm(agreementId) {
    setMsg(null);
    const f = await (await fetch(`/api/tech-request/agreements/${agreementId}/form`)).json();
    if (f.error) { setMsg({ err: f.error }); return; }
    setForm(f); setVals(f.values || {});
  }

  const setVal = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const toggleMulti = (k, opt) => setVals((s) => {
    const arr = Array.isArray(s[k]) ? s[k] : [];
    return { ...s, [k]: arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt] };
  });

  async function submit(finalize) {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/tech-request/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agreement_id: form.agreement_id, answers: vals, finalize }),
    });
    const j = await r.json(); setBusy(false);
    if (!r.ok) { setMsg({ err: j.error }); return; }
    if (finalize) {
      const jf = j.jotform || {};
      setMsg({ ok: `Finalized. ${jf.ok ? 'Pushed to JotForm.' : 'JotForm: ' + (jf.skipped || jf.error || 'n/a')}` });
    } else setMsg({ ok: 'Draft saved.' });
    openForm(form.agreement_id); loadList();
  }
  // Manager approval + calendar/email scheduling are handled in JotForm, not on
  // the website. The site's job ends at "Submit (finalize)" → pushed to JotForm.

  function field(fl) {
    const v = vals[fl.key];
    const disabled = form.locked;
    const common = { value: v ?? '', disabled, onChange: (e) => setVal(fl.key, e.target.value) };
    if (fl.type === 'textarea') return <textarea rows={2} {...common} />;
    if (fl.type === 'select') return (
      <select {...common}><option value="">—</option>{fl.options.map((o) => <option key={o}>{o}</option>)}</select>
    );
    if (fl.type === 'multiselect') return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {fl.options.map((o) => (
          <label key={o} className="note" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" disabled={disabled} checked={Array.isArray(v) && v.includes(o)} onChange={() => toggleMulti(fl.key, o)} style={{ width: 'auto' }} /> {o}
          </label>
        ))}
      </div>
    );
    const type = fl.type === 'date' ? 'date' : fl.type === 'time' ? 'time' : fl.type === 'email' ? 'email' : 'text';
    return <input type={type} {...common} value={fl.type === 'date' && v ? String(v).slice(0, 10) : (v ?? '')} />;
  }

  if (!form) {
    return (
      <>
        <PageHeader title="Tech Request" sub="Pick an agreement to start its technician/event request form." sheet="Tech Request" />
        {msg?.err && <p className="error">{msg.err}</p>}
        <div className="panel tablewrap">
          <table>
            <thead><tr><th>Project</th><th>Counterparty</th><th>Type</th><th>Robots</th><th>Request</th><th></th></tr></thead>
            <tbody>
              {list.length ? list.map((a) => (
                <tr key={a.id}>
                  <td>{a.project_number}</td><td>{a.counterparty || '—'}</td><td>{a.agreement_type}</td>
                  <td>{a.robot_types || '—'}</td>
                  <td><span className={'chip ' + (STATUS_CHIP[a.request_status] || '')}>{a.request_status}</span></td>
                  <td><button className="secondary" onClick={() => openForm(a.id)}>{a.request_status === 'none' ? 'Open form →' : 'Review →'}</button></td>
                </tr>
              )) : <tr><td colSpan={6} className="note">No agreements yet. Upload one in Data Upload first.</td></tr>}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const st = form.submission?.status;
  return (
    <>
      <PageHeader title={`Tech Request — ${form.project_number}`} sub={`${form.counterparty} · ${form.jotform_form_title}`} sheet="Tech Request" />
      <div className="toolbar">
        <button className="secondary" onClick={() => { setForm(null); loadList(); }}>← Back to list</button>
        {st && <span className={'chip ' + (STATUS_CHIP[st] || '')}>{st}</span>}
      </div>

      {st === 'finalized' && <div className="panel"><p className="note">📤 Submitted to JotForm — awaiting manager approval.{form.submission.answers?._jotform?.url ? <> <a href={form.submission.answers._jotform.url} target="_blank" rel="noreferrer">View JotForm</a></> : null}</p></div>}
      {st === 'approved' && <div className="panel"><p className="ok-msg">✅ Approved &amp; scheduled.{form.submission.answers?._calendar?.html_link ? <> <a href={form.submission.answers._calendar.html_link} target="_blank" rel="noreferrer">Calendar event</a></> : null}</p></div>}

      <div className="panel">
        <div className="form" style={{ maxWidth: 680 }}>
          {form.sections.map((sec) => (
            <div key={sec.key}>
              <h3>{sec.title}</h3>
              {sec.fields.map((fl) => (
                <label key={fl.key}>{fl.label}{fl.required ? ' *' : ''}{field(fl)}</label>
              ))}
            </div>
          ))}
          {msg?.ok && <p className="ok-msg">{msg.ok}</p>}{msg?.err && <p className="error">{msg.err}</p>}
          {!form.locked && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="secondary" onClick={() => submit(false)} disabled={busy}>Save draft</button>
              <button onClick={() => submit(true)} disabled={busy}>{busy ? 'Working…' : 'Submit (finalize)'}</button>
            </div>
          )}
          {/* Approval & scheduling happen in JotForm, not here. */}
        </div>
      </div>
    </>
  );
}
