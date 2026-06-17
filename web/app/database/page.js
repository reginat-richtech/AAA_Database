'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '../_components/blueprint';

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function DatabaseBrowser() {
  const [schemas, setSchemas] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);     // { schema, table }
  const [data, setData] = useState(null);   // { columns, rows, total, limit }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch('/api/database')
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Failed to load'); return j; })
      .then((d) => setSchemas(d.schemas || []))
      .catch((e) => setErr(e.message));
  }, []);

  async function openTable(schema, table) {
    setSel({ schema, table }); setData(null); setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/database/${schema}/${table}?limit=100`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to load table');
      setData(j);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  const ql = q.trim().toLowerCase();

  return (
    <>
      <PageHeader title="Database" sub="Browse the live cloud database (read-only). Admin only." />
      {err && <p className="error">{err}</p>}

      <div className="db-wrap">
        <aside className="db-list panel">
          <input placeholder="Filter tables…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
          {schemas.map((s) => {
            const tbls = s.tables.filter((t) => !ql || `${s.schema}.${t.name}`.toLowerCase().includes(ql));
            if (!tbls.length) return null;
            return (
              <div className="db-schema" key={s.schema}>
                <div className="db-schema-h">{s.schema}</div>
                {tbls.map((t) => {
                  const active = sel && sel.schema === s.schema && sel.table === t.name;
                  return (
                    <button key={t.name} className={'db-tbtn' + (active ? ' active' : '')} onClick={() => openTable(s.schema, t.name)}>
                      <span className="db-tname">{t.name}</span>
                      <span className="db-cnt">{t.rows}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {!schemas.length && !err && <p className="note">Loading…</p>}
        </aside>

        <section className="db-main panel">
          {!sel && <p className="note">Pick a table on the left to view its rows.</p>}
          {sel && (
            <>
              <div className="panel-title">
                <h2 style={{ margin: 0 }}>{sel.schema}.{sel.table}</h2>
                <span className="meta">{loading ? 'loading…' : data ? `showing ${data.rows.length} of ${data.total} row(s)` : ''}</span>
              </div>
              {data && (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>{data.columns.map((c) => (
                        <th key={c.name}>{c.name}<div className="db-type">{c.type}</div></th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {data.rows.length ? data.rows.map((row, i) => (
                        <tr key={i}>{data.columns.map((c) => {
                          const txt = cellText(row[c.name]);
                          return <td key={c.name} title={txt}>{txt.length > 160 ? txt.slice(0, 160) + '…' : txt}</td>;
                        })}</tr>
                      )) : <tr><td colSpan={data.columns.length} className="note">No rows{` (this table is empty, or row-level security hides them from app_rw)`}.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <style>{`
        .db-wrap { display:grid; grid-template-columns:260px 1fr; gap:18px; align-items:start; }
        @media (max-width:880px){ .db-wrap{ grid-template-columns:1fr; } }
        .db-list { max-height:80vh; overflow:auto; }
        .db-schema { margin-bottom:10px; }
        .db-schema-h { font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:8px 2px 4px; }
        .db-tbtn { display:flex; justify-content:space-between; align-items:center; gap:8px; width:100%; text-align:left; background:transparent; color:var(--ink); border:0; border-radius:7px; padding:6px 9px; font-size:13px; font-weight:500; cursor:pointer; }
        .db-tbtn:hover { background:var(--chip); }
        .db-tbtn.active { background:var(--primary); color:#fff; }
        .db-tname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .db-cnt { font-family:var(--font-mono); font-size:11px; color:var(--muted); flex:0 0 auto; }
        .db-tbtn.active .db-cnt { color:#dbe7ff; }
        .db-main { min-height:320px; max-height:82vh; overflow:auto; }
        .db-type { font-family:var(--font-mono); font-size:9px; font-weight:400; color:var(--muted); text-transform:none; letter-spacing:0; }
      `}</style>
    </>
  );
}
