'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';

const SOURCES = [
  { key: 'navan', label: 'Navan bookings' },
  { key: 'jotform', label: 'JotForm submissions' },
  { key: 'quickbooks', label: 'QuickBooks invoices' },
];

function relTime(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); return `${d}d ago`;
}
function fmtDuration(start, end) {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function DataSync() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  // Parse defensively: an empty body (gateway timeout) or HTML error page won't
  // throw "Unexpected end of JSON input" — we surface a readable message instead.
  async function parseRes(r) {
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: r.status, data, text };
  }

  const load = useCallback(() => {
    fetch('/api/admin/sync').then(parseRes).then((p) => { if (p.data && !p.data.error) setStatus(p.data); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // While a sync is running, poll the status so the "running…" row and timings update.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [busy, load]);

  async function sync(source) {
    setBusy(source); setMsg(null);
    const t0 = Date.now();
    try {
      const r = await fetch(`/api/admin/sync?source=${source}`, { method: 'POST' });
      const p = await parseRes(r);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (p.data?.results) {
        const detail = p.data.results
          .map((x) => `${x.source}: ${x.skipped ? 'skipped' : x.ok ? x.rows + ' rows' : 'error'}`)
          .join(' · ');
        setMsg({ ok: `${detail} · finished in ${secs}s` });
      } else if (p.data?.error) {
        setMsg({ err: p.data.error });
      } else {
        setMsg({ err: `Server returned ${p.status || 'no'} with no JSON. A large "Sync all" can exceed the gateway timeout — it may still be running; wait and hit Refresh, or sync one source at a time.` });
      }
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
        <button className="secondary" onClick={load} disabled={!!busy}>Refresh</button>
        {msg?.ok && <span className="ok-msg">{msg.ok}</span>}
        {msg?.err && <span className="error">{msg.err}</span>}
      </div>

      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Source</th><th>Rows stored</th><th>Last run</th><th>Duration</th><th>Last result</th><th></th></tr></thead>
          <tbody>
            {SOURCES.map((s) => {
              const l = lastBy[s.key];
              const running = busy === s.key || busy === 'all';
              const inflight = l && l.started_at && !l.finished_at;
              return (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td className="mono">{totals[s.key] ?? 0}</td>
                  <td title={l?.finished_at ? new Date(l.finished_at).toLocaleString() : (l?.started_at ? `started ${new Date(l.started_at).toLocaleString()}` : '')}>
                    {(running || inflight) ? <span className="chip info">running…</span>
                      : l?.finished_at ? relTime(l.finished_at)
                      : <span className="note">never</span>}
                  </td>
                  <td className="mono">{fmtDuration(l?.started_at, l?.finished_at)}</td>
                  <td>
                    {!l ? <span className="note">never run</span>
                      : !l.finished_at ? <span className="note">in progress…</span>
                      : l.error ? <span className="chip warn" title={l.error}>{l.error.length > 44 ? l.error.slice(0, 44) + '…' : l.error}</span>
                      : l.ok ? <span className="chip ok">✓ {l.rows ?? 0} rows</span>
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
        “Duration” and “Last result” come from the sync log; QuickBooks uses the credential from <b>Connect QuickBooks</b> (Finance AI) — no manual token needed.
      </p>
    </>
  );
}
