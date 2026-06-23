'use client';
import { useEffect, useState, useMemo } from 'react';
import { PageHeader } from '../_components/blueprint';

export default function Inventory() {
  const [data, setData] = useState({ period: null, periods: [], categories: [], rows: [] });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');

  const load = (period) => {
    const url = period ? `/api/inventory?period=${encodeURIComponent(period)}` : '/api/inventory';
    fetch(url).then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => data.rows.filter((r) => {
    if (cat !== 'all' && (r.category || 'Other') !== cat) return false;
    if (!q) return true;
    const hay = `${r.product_name || ''} ${r.sku || ''} ${r.location || ''} ${r.category || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [data.rows, q, cat]);

  const totalQty = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

  return (
    <>
      <PageHeader title="Inventory" sub={`China SKU list${data.period ? ` · ${data.period}` : ''}. Search by product, SKU, location, or category.`} sheet="Inventory" />

      <div className="toolbar">
        <input placeholder="Search product, SKU, location…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories ({data.rows.length})</option>
          {data.categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.count})</option>)}
        </select>
        {data.periods.length > 1 && (
          <select value={data.period || ''} onChange={(e) => { setCat('all'); load(e.target.value); }}>
            {data.periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <span className="note" style={{ marginLeft: 'auto' }}>{rows.length} item(s) · total qty {totalQty}</span>
      </div>

      {/* Category chips for quick filtering */}
      <div className="inv-cats">
        <button className={'inv-cat' + (cat === 'all' ? ' on' : '')} onClick={() => setCat('all')}>All</button>
        {data.categories.map((c) => (
          <button key={c.category} className={'inv-cat' + (cat === c.category ? ' on' : '')} onClick={() => setCat(c.category)}>
            {c.category} <span className="inv-n">{c.count}</span>
          </button>
        ))}
      </div>

      <div className="panel tablewrap">
        <table>
          <thead><tr><th>SKU</th><th>Category</th><th>Product</th><th>Type</th><th>Qty</th><th>Location</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r, i) => (
              <tr key={(r.sku || 'x') + '-' + i}>
                <td><code>{r.sku || '—'}</code></td>
                <td><span className="chip">{r.category || 'Other'}</span></td>
                <td>{r.product_name || '—'}</td>
                <td className="note">{r.type || ''}</td>
                <td>{r.quantity ?? ''}</td>
                <td className="note">{r.location || ''}</td>
              </tr>
            )) : <tr><td colSpan={6} className="note">No items match your search.</td></tr>}
          </tbody>
        </table>
      </div>

      <style>{`
        .inv-cats { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
        .inv-cat { font-size:12px; padding:3px 10px; border:1px solid var(--line); border-radius:999px; background:var(--surface); color:var(--ink); cursor:pointer; }
        .inv-cat:hover { border-color:var(--primary); }
        .inv-cat.on { background:var(--primary); color:#fff; border-color:var(--primary); }
        .inv-n { opacity:.6; margin-left:2px; }
        table code { font-size:12px; }
      `}</style>
    </>
  );
}
