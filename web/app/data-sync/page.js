'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';

const SOURCES = [
  { key: 'navan', label: 'Navan bookings' },
  { key: 'jotform', label: 'JotForm submissions' },
  { key: 'quickbooks', label: 'QuickBooks invoices' },
];

export default function DataSync() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    fetch('/api/admin/sync').then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sync(source) {
    setBusy(source); setMsg(null);
    try {
      const r = await fetch(`/api/admin/sync?source=${source}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) setMsg({ err: j.error || 'Sync failed' });
      else setMsg({ ok: (j.results || []).map((x) => `${x.source}: ${x.skipped ? 'skipped' : x.ok ? x.rows + ' rows' : 'error'}`).join(' · ') });
    } catch (e) { setMsg({ err: String(e?.message || e) }); }
    setBusy(null);
    load();
  }

  const lastBy = Object.fromEntries((status?.last || []).map((l) => [l.source, l]));
  const totals = status?.totals || {};

  return (
    <>
      <PageHeader title="Data Sync" sub="Pull full external datasets into the cloud database. Runs daily on a schedule and on demand here." sheet="Data Sync" />

      <div className="toolbar">
        <button onClick={() => sync('all')} disabled={!!busy}>{busy === 'all' ? 'Syncing…' : '↻ Sync all now'}</button>
        {msg?.ok && <span className="ok-msg">{msg.ok}</span>}
        {msg?.err && <span className="error">{msg.err}</span>}
      </div>

      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Source</th><th>Rows stored</th><th>Last sync</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {SOURCES.map((s) => {
              const l = lastBy[s.key];
              return (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td className="mono">{totals[s.key] ?? 0}</td>
                  <td>{l?.finished_at ? new Date(l.finished_at).toLocaleString() : '—'}</td>
                  <td>
                    {!l ? <span className="note">never</span>
                      : l.error ? <span className="chip warn" title={l.error}>skipped/err</span>
                      : l.ok ? <span className="chip ok">ok</span>
                      : <span className="chip">—</span>}
                  </td>
                  <td><button className="secondary" onClick={() => sync(s.key)} disabled={!!busy}>{busy === s.key ? '…' : 'Sync'}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="note">
        Each row keeps the complete API record as JSON plus key columns (schema <span className="mono">ext.*</span>).
        QuickBooks stays “skipped” until its refresh token + realm ID are added.
      </p>
    </>
  );
}
