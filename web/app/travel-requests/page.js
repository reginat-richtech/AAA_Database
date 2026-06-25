'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);
const STATUS_CLS = { requested: 'info', approved: 'ok', denied: 'bad', booked: 'warn', completed: 'ok' };

// A travel request's date range as a compact "Jun 3 → Jun 7" string.
function When({ start, end }) {
  const s = fmtDate(start), e = fmtDate(end);
  if (!s && !e) return <span className="note">—</span>;
  if (s && e) return <span>{s} → {e}</span>;
  return <span>{s || e}</span>;
}

export default function TravelRequests() {
  const [requests, setRequests] = useState([]);
  const [formUrl, setFormUrl] = useState(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    fetch('/api/travel-requests')
      .then((r) => r.json())
      .then((d) => { setRequests((d && d.requests) || []); setFormUrl((d && d.formUrl) || null); })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = requests.filter((t) => {
    if (!q) return true;
    const hay = `${t.traveler || ''} ${t.purpose || ''} ${t.destination || ''} ${t.status || ''} ${t.so_number || ''} ${t.project?.project_number || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  return (
    <>
      <PageHeader
        title="Travel Requests"
        sub="Start a travel request on the Travel Request Form — submissions show up here automatically. Tracked independently of the Project Tracker."
      />

      <div className="toolbar">
        <input placeholder="Search traveler, reason, destination, project…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
        <span className="note">{rows.length} request{rows.length === 1 ? '' : 's'}</span>
        <button className="secondary" onClick={load} disabled={loading} style={{ marginLeft: 'auto' }}>{loading ? 'Loading…' : 'Refresh'}</button>
        {formUrl && <a href={formUrl} target="_blank" rel="noreferrer" className="btnlink">Start a travel request ↗</a>}
      </div>

      {err && <p className="error">{err}</p>}

      <div className="panel tablewrap">
        <table className="trvreq">
          <thead><tr><th>Traveler</th><th>Reason</th><th>Destination</th><th>When</th><th>Project</th><th>Status</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="note">Loading…</td></tr>
              : rows.length ? rows.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.traveler || '—'}</b></td>
                  <td className="reason">{t.purpose || <span className="note">—</span>}</td>
                  <td>{t.destination || <span className="note">—</span>}</td>
                  <td className="nowrap"><When start={t.start_date} end={t.end_date} /></td>
                  <td>
                    {t.project
                      ? <span title={t.project.title || t.project.counterparty || ''}>{t.project.project_number || t.project.title || 'Project'}</span>
                      : t.so_number ? <span className="note">SO {t.so_number}</span>
                        : <span className="note">—</span>}
                  </td>
                  <td>
                    <span className={`chip ${STATUS_CLS[t.status] || 'info'}`}>{t.status}</span>
                    {t.jotform_url && <> · <a href={t.jotform_url} target="_blank" rel="noreferrer">↗</a></>}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={6} className="note">
                  No travel requests yet.{formUrl ? <> Use <a href={formUrl} target="_blank" rel="noreferrer">the Travel Request Form</a> to start one.</> : null}
                </td></tr>
              )}
          </tbody>
        </table>
      </div>

      <style>{`
        table.trvreq td { vertical-align:top; }
        .nowrap { white-space:nowrap; }
        .trvreq .reason { max-width:340px; }
      `}</style>
    </>
  );
}
