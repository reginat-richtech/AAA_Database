'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { PageHeader } from '../../_components/blueprint';
import { isValidSku, normalizeSku, SKU_HINT } from '../../../lib/inventory';

const OFFER_LABEL = { finished_goods: 'Finished Goods', raas: 'RaaS', event_rental: 'Event Rental' };
const OFFER_ORDER = ['finished_goods', 'raas', 'event_rental'];
const ITEM_CLASS = ['finished_goods', 'part', 'accessory'];
const ITEM_CLASS_LABEL = { finished_goods: 'Finished Goods', part: 'Raw Materials / Parts', accessory: 'Accessory' };
const EMPTY_ADD = { product_name: '', sku: '', quantity: '', location: '' };

export default function InventoryDetail() {
  const [data, setData] = useState({ period: null, periods: [], categories: [], productLines: [], itemClasses: [], catalog: [], projects: [], allocations: [], canEdit: false, rows: [] });
  const [q, setQ] = useState('');
  const [line, setLine] = useState('all');
  const [cat, setCat] = useState('all');
  const [cls, setCls] = useState('all');
  const [showZero, setShowZero] = useState(false);   // default: hide 0-qty items
  const [busy, setBusy] = useState(false);
  const [addForm, setAddForm] = useState(null);       // add-item modal
  const [manage, setManage] = useState(null);         // item being managed (load/remove/adjust/delete)
  const [amt, setAmt] = useState('');                 // load/remove amount
  const [setVal, setSetVal] = useState('');           // set-exact quantity
  const [mloc, setMloc] = useState('');               // location edit

  const load = (period) => {
    const url = period ? `/api/inventory?period=${encodeURIComponent(period)}` : '/api/inventory';
    fetch(url).then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const allocByItem = useMemo(() => {
    const m = {};
    for (const a of data.allocations || []) (m[a.cn_sku_id] = m[a.cn_sku_id] || []).push(a);
    return m;
  }, [data.allocations]);

  const rows = useMemo(() => data.rows.filter((r) => {
    if (!showZero && (Number(r.quantity) || 0) === 0) return false;
    if (line !== 'all' && (r.product_line || 'Other') !== line) return false;
    if (cat !== 'all' && (r.category || 'Other') !== cat) return false;
    if (cls !== 'all' && (r.item_class || '') !== cls) return false;
    if (!q) return true;
    const hay = `${r.product_name || ''} ${r.sku || ''} ${r.location || ''} ${r.category || ''} ${r.product_line || ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  }), [data.rows, q, line, cat, cls, showZero]);

  const totalQty = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const hiddenZero = data.rows.filter((r) => (Number(r.quantity) || 0) === 0).length;

  const offerings = useMemo(() => {
    if (line === 'all') return null;
    const items = (data.catalog || []).filter((c) => (c.product_line || '') === line);
    if (!items.length) return null;
    const byType = {};
    for (const c of items) (byType[c.offering_type] = byType[c.offering_type] || []).push(c.name);
    return byType;
  }, [data.catalog, line]);

  async function addItem() {
    setBusy(true);
    const r = await fetch('/api/inventory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(addForm) });
    setBusy(false);
    if (r.ok) { setAddForm(null); load(data.period); }
    else { const j = await r.json().catch(() => ({})); alert(j.error || 'Add failed'); }
  }
  function openManage(item) { setManage(item); setAmt(''); setSetVal(''); setMloc(item.location || ''); }

  // Apply a change to the managed item, then refresh the list + the open modal.
  async function patchItem(body) {
    setBusy(true);
    const r = await fetch(`/api/inventory/${manage.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (r.ok) { const updated = await r.json(); setManage(updated); setAmt(''); setSetVal(''); load(data.period); }
    else { const j = await r.json().catch(() => ({})); alert(j.error || 'Update failed'); }
  }
  const doDelta = (n) => patchItem({ delta: n });

  async function deleteItem() {
    if (!confirm(`Delete "${manage.product_name || manage.sku || 'item'}"? This cannot be undone.`)) return;
    setBusy(true);
    const r = await fetch(`/api/inventory/${manage.id}`, { method: 'DELETE' });
    setBusy(false);
    if (r.ok) { setManage(null); load(data.period); }
    else { const j = await r.json().catch(() => ({})); alert(j.error || 'Delete failed'); }
  }

  const canEdit = data.canEdit;
  const cols = 8;

  // Add-item form validation — every field is required, and the SKU must match
  // the SOURCE-CATEGORY-CODE format.
  const af = addForm || {};
  const skuValid = isValidSku(af.sku);
  const qtyValid = af.quantity !== '' && af.quantity != null && Number.isFinite(Number(af.quantity)) && Number(af.quantity) >= 0;
  const addValid = !!(af.product_name?.trim() && skuValid && qtyValid && af.location?.trim());

  return (
    <>
      <PageHeader title="Inventory detail" sub={`Full stock list${data.period ? ` · ${data.period}` : ''}. 0-quantity items hidden by default. Search by product, SKU, location, or category.`} sheet="Inventory" />

      <div className="toolbar"><Link href="/inventory" className="secondary">← Back to Inventory</Link></div>

      <div className="inv-cats">
        <button className={'inv-cat' + (line === 'all' ? ' on' : '')} onClick={() => { setLine('all'); setCat('all'); }}>All lines</button>
        {data.productLines.map((l) => (
          <button key={l.line} className={'inv-cat' + (line === l.line ? ' on' : '')} onClick={() => { setLine(l.line); setCat('all'); }}>
            {l.line} <span className="inv-n">{l.count}</span>
          </button>
        ))}
      </div>

      {offerings && (
        <div className="panel inv-offer">
          <span><b>{line}</b> is sold as —</span>
          {OFFER_ORDER.filter((t) => offerings[t]).map((t) => (
            <span key={t} className="inv-offer-grp"><span className="chip ok">{OFFER_LABEL[t]}</span> {offerings[t].join(', ')}</span>
          ))}
        </div>
      )}

      <div className="toolbar">
        {canEdit && <button onClick={() => setAddForm({ ...EMPTY_ADD })}>+ Add item</button>}
        <input placeholder="Search product, SKU, location…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {data.categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.count})</option>)}
        </select>
        <select value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="all">All classes</option>
          {ITEM_CLASS.map((c) => <option key={c} value={c}>{ITEM_CLASS_LABEL[c]}</option>)}
        </select>
        <label className="inv-chk" title={`${hiddenZero} item(s) have 0 quantity`}>
          <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} /> Show 0-qty ({hiddenZero})
        </label>
        {data.periods.length > 1 && (
          <select value={data.period || ''} onChange={(e) => { setLine('all'); setCat('all'); load(e.target.value); }}>
            {data.periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <span className="note" style={{ marginLeft: 'auto' }}>{rows.length} item(s) · total qty {totalQty}</span>
      </div>

      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Product</th><th>SKU</th><th>Line</th><th>Class</th><th>Category</th><th>Qty</th><th>Location</th><th></th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r) => {
              const allocs = allocByItem[r.id] || [];
              return (
                <tr key={r.id}>
                  <td>{r.product_name || '—'}</td>
                  <td><code>{r.sku || '—'}</code></td>
                  <td>{r.product_line ? <span className="chip ok">{r.product_line}</span> : <span className="note">—</span>}</td>
                  <td>{r.item_class ? <span className="chip">{ITEM_CLASS_LABEL[r.item_class]}</span> : <span className="note">—</span>}</td>
                  <td><span className="chip">{r.category || 'Other'}</span></td>
                  <td>{r.quantity ?? ''}</td>
                  <td className="note">{r.location || ''}</td>
                  <td className="inv-act">
                    {allocs.length > 0 && (
                      <span className="inv-alloc" title={allocs.map((a) => `${a.project_number || a.project_id}${a.quantity ? ` ×${a.quantity}` : ''}`).join('\n')}>
                        📦 {allocs.length}
                      </span>
                    )}
                    {canEdit && <button className="inv-mng" onClick={() => openManage(r)}>Manage</button>}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={cols} className="note">No items match your search.</td></tr>}
          </tbody>
        </table>
      </div>

      {addForm && (
        <div className="inv-overlay" onClick={() => setAddForm(null)}>
          <div className="inv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="inv-mhead"><b>Add inventory item</b><button className="secondary" onClick={() => setAddForm(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <p className="note" style={{ margin: '0 0 2px' }}>All fields are required.</p>
            <label className="inv-f">Product name <span className="inv-req">*</span><input value={addForm.product_name} onChange={(e) => setAddForm({ ...addForm, product_name: e.target.value })} placeholder="e.g. ADAM 7-core control cable" /></label>
            <label className="inv-f">SKU <span className="inv-req">*</span>
              <input
                value={addForm.sku}
                onChange={(e) => setAddForm({ ...addForm, sku: normalizeSku(e.target.value) })}
                placeholder="e.g. SE-ADAM-EC2X"
                aria-invalid={addForm.sku && !skuValid ? 'true' : 'false'}
                className={addForm.sku && !skuValid ? 'inv-bad' : ''}
              />
            </label>
            <p className={'note' + (addForm.sku && !skuValid ? ' inv-errtext' : '')} style={{ margin: '2px 0 0' }}>
              {addForm.sku && !skuValid ? `Doesn’t match — ${SKU_HINT}` : `${SKU_HINT} · category & line auto-derive`}
            </p>
            <div className="inv-frow">
              <label className="inv-f">Quantity <span className="inv-req">*</span><input type="number" min="0" value={addForm.quantity} onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })} placeholder="0" /></label>
              <label className="inv-f">Location <span className="inv-req">*</span><input value={addForm.location} onChange={(e) => setAddForm({ ...addForm, location: e.target.value })} placeholder="e.g. Warehouse A" /></label>
            </div>
            <div className="inv-actions">
              <button onClick={addItem} disabled={busy || !addValid}>Add item</button>
              <button className="secondary" onClick={() => setAddForm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {manage && (
        <div className="inv-overlay" onClick={() => setManage(null)}>
          <div className="inv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="inv-mhead"><b>Manage stock</b><button className="secondary" onClick={() => setManage(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <div className="mg-name">{manage.product_name || manage.sku || 'Item'} {manage.sku && <code>{manage.sku}</code>}</div>
            <div className="mg-onhand">On hand: <b>{manage.quantity ?? 0}</b></div>

            <div className="mg-sec">
              <label className="inv-f">Load / remove amount<input type="number" min="1" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="e.g. 10" /></label>
              <div className="mg-btns">
                <button onClick={() => doDelta(Math.abs(Number(amt)))} disabled={busy || !(Number(amt) > 0)}>＋ Load</button>
                <button className="secondary" onClick={() => doDelta(-Math.abs(Number(amt)))} disabled={busy || !(Number(amt) > 0)}>－ Remove</button>
              </div>
            </div>

            <div className="mg-sec">
              <label className="inv-f">Set exact quantity (stock count)<input type="number" min="0" value={setVal} onChange={(e) => setSetVal(e.target.value)} placeholder={String(manage.quantity ?? 0)} /></label>
              <button className="secondary" onClick={() => patchItem({ quantity: Number(setVal) })} disabled={busy || setVal === ''}>Set</button>
            </div>

            <div className="mg-sec">
              <label className="inv-f">Location<input value={mloc} onChange={(e) => setMloc(e.target.value)} placeholder="e.g. Warehouse A" /></label>
              <button className="secondary" onClick={() => patchItem({ location: mloc })} disabled={busy || mloc === (manage.location || '')}>Save</button>
            </div>

            <div className="mg-danger"><button className="mg-del" onClick={deleteItem} disabled={busy}>Delete item</button></div>
          </div>
        </div>
      )}

      <style>{`
        .inv-cats { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
        .inv-mng { font-size:11px; padding:3px 10px; margin-left:8px; }
        .mg-name { font-size:14px; font-weight:600; margin-top:6px; } .mg-name code { font-size:12px; margin-left:6px; }
        .mg-onhand { font-size:13px; color:var(--muted); margin:2px 0 4px; }
        .mg-sec { display:flex; align-items:flex-end; gap:8px; padding:10px 0; border-bottom:1px solid var(--line); }
        .mg-sec .inv-f { flex:1 1 auto; margin-top:0; }
        .mg-btns { display:flex; gap:6px; flex:0 0 auto; }
        .mg-danger { margin-top:14px; }
        .mg-del { background:var(--bad,#dc2626); color:#fff; }
        .mg-del:hover { filter:brightness(1.08); }
        .inv-cat { font-size:12px; padding:4px 12px; border:1px solid var(--line); border-radius:999px; background:var(--surface); color:var(--ink); cursor:pointer; }
        .inv-cat:hover { border-color:var(--primary); }
        .inv-cat.on { background:var(--primary); color:#fff; border-color:var(--primary); }
        .inv-n { opacity:.6; margin-left:2px; }
        .inv-chk { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
        .inv-offer { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; font-size:13px; margin-bottom:12px; }
        .inv-offer-grp { display:inline-flex; align-items:center; gap:6px; }
        table code { font-size:12px; }
        .inv-act { white-space:nowrap; text-align:right; }
        .inv-alloc { font-size:11px; color:var(--muted); margin-right:8px; }
        .inv-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:48px 16px; }
        .inv-modal { width:460px; max-width:96vw; background:var(--surface); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.3); padding:18px; }
        .inv-mhead { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:6px; border-bottom:1px solid var(--line); }
        .inv-f { display:grid; gap:4px; font-size:13px; color:var(--muted); margin-top:10px; }
        .inv-f input, .inv-f select { width:100%; }
        .inv-frow { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .inv-actions { display:flex; gap:8px; margin-top:18px; }
        .inv-req { color:var(--bad,#dc2626); font-weight:700; }
        .inv-errtext { color:var(--bad,#dc2626); }
        .inv-bad { border-color:var(--bad,#dc2626) !important; }
      `}</style>
    </>
  );
}
