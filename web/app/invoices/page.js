'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '../_components/blueprint';
import ComboSearch from '../_components/ComboSearch';

const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TERMS = ['', 'Due on receipt', 'Net 15', 'Net 30', 'Net 60'];
const today = () => new Date().toISOString().slice(0, 10);
const blankLine = () => ({ service_date: '', product_name: '', description: '', quantity: 1, unit_price: 0, amount: 0, taxable: true, sku: null, cn_sku_id: null, qb_item_id: null });
const blankForm = () => ({ id: null, project_id: '', customer_name: '', customer_email: '', billing_address: '', shipping_address: '', invoice_number: '', po_number: '', invoice_date: today(), due_date: '', terms: '', class_name: '', tags: [], customer_message: '', payment_instructions: '', notes: '', discount_type: 'amount', discount_value: '', tax_rate: '', currency: 'USD', lines: [blankLine()], status: 'draft' });

// Line amount = the explicit (editable) amount if set, else qty × rate.
const lineAmount = (l) => (l.amount !== '' && l.amount != null ? Number(l.amount) : (Number(l.quantity) || 0) * (Number(l.unit_price) || 0));

function calc(f) {
  const ls = f?.lines || [];
  const sub = ls.reduce((s, l) => s + lineAmount(l), 0);
  const taxable = ls.filter((l) => l.taxable !== false).reduce((s, l) => s + lineAmount(l), 0);
  const disc = f?.discount_type === 'percent' ? sub * (Number(f.discount_value) || 0) / 100 : (Number(f?.discount_value) || 0);
  const tax = taxable * (Number(f?.tax_rate) || 0) / 100;
  return { sub, disc, tax, total: sub - disc + tax };
}
// Load an existing invoice row into a form-shaped object.
const toForm = (iv) => ({
  ...blankForm(), ...iv, project_id: iv.project_id || '',
  discount_type: iv.discount_type || 'amount', discount_value: iv.discount_value ?? '', tax_rate: iv.tax_rate ?? '',
  invoice_date: iv.invoice_date ? String(iv.invoice_date).slice(0, 10) : '', due_date: iv.due_date ? String(iv.due_date).slice(0, 10) : '',
  customer_message: iv.customer_message || '', notes: iv.notes || '',
  lines: iv.lines?.length ? iv.lines : [blankLine()],
});

export default function Invoices() {
  const [data, setData] = useState({ invoices: [], projects: [], qb: {}, canEdit: false });
  const [form, setForm] = useState(null);   // null = list view; object = editing
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [prodQ, setProdQ] = useState(''); // product search box
  const [tagInput, setTagInput] = useState('');

  const load = () => fetch('/api/invoices').then((r) => r.json()).then((d) => { if (d?.error) setErr(d.error); else setData(d); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (i, k, v) => setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  // Qty/Rate edits recompute Amount; editing Amount back-calculates Rate (QuickBooks-style).
  const editLineNum = (i, field, value) => setForm((f) => ({
    ...f,
    lines: f.lines.map((l, j) => {
      if (j !== i) return l;
      const n = { ...l, [field]: value };
      const qty = Number(n.quantity) || 0;
      if (field === 'amount') n.unit_price = qty > 0 ? (Number(value) || 0) / qty : (Number(n.unit_price) || 0);
      else n.amount = qty * (Number(n.unit_price) || 0);
      return n;
    }),
  }));

  // Product search options: prefer the QuickBooks price list (with UnitPrice + QB
  // item id) when connected, else the inventory product list (no price → $0).
  const productOptions = (data.qbItems?.length
    ? data.qbItems.map((it) => ({ key: `qb-${it.id}`, name: it.name, sku: it.sku, unit_price: it.unit_price, qb_item_id: it.id, cn_sku_id: null }))
    : (data.products || []).map((p) => ({ key: `cn-${p.id}`, name: p.product_name, sku: p.sku, unit_price: null, qb_item_id: null, cn_sku_id: p.id })));
  const qbPriced = !!data.qbItems?.length;
  const existingTags = [...new Set((data.invoices || []).flatMap((iv) => iv.tags || []))].sort();
  const existingClasses = [...new Set((data.invoices || []).map((iv) => iv.class_name).filter(Boolean))].sort();
  function addTag(raw) { const t = String(raw || '').trim(); if (!t) return; setForm((f) => (f.tags?.includes(t) ? f : { ...f, tags: [...(f.tags || []), t] })); setTagInput(''); }
  const removeTag = (t) => setForm((f) => ({ ...f, tags: (f.tags || []).filter((x) => x !== t) }));
  const customerOptions = (data.customers || []).map((c, i) => ({ key: `c-${i}`, label: c.name, sub: c.email || '', data: c }));
  const productSearchOptions = productOptions.map((p) => ({ key: p.key, label: p.name, sub: [p.sku, p.unit_price != null ? money(p.unit_price) : null].filter(Boolean).join(' · '), data: p }));

  // Pick a customer from the dropdown → fill name + (their) email/address.
  function pickCustomer(o) {
    const c = o.data || {};
    setForm((f) => ({
      ...f,
      customer_name: c.name || f.customer_name,
      customer_email: c.email || f.customer_email,
      billing_address: c.address || f.billing_address,
      shipping_address: c.address || f.shipping_address,
    }));
  }
  // Pick a product from the dropdown → add it as a line (QB price prefilled if available).
  function addProductOption(o) {
    const p = o.data; if (!p) return;
    setForm((f) => {
      const blank = (l) => !l.product_name && !l.description && !l.sku && !(Number(l.unit_price) > 0);
      const base = f.lines.length === 1 && blank(f.lines[0]) ? [] : f.lines;
      return { ...f, lines: [...base, { service_date: '', product_name: p.name, description: '', quantity: 1, unit_price: p.unit_price ?? 0, amount: (p.unit_price ?? 0), taxable: true, sku: p.sku, cn_sku_id: p.cn_sku_id, qb_item_id: p.qb_item_id }] };
    });
    setProdQ('');
  }

  async function linkProject(pid) {
    set('project_id', pid);
    if (!pid) return;
    const j = await fetch(`/api/invoices?seed=${encodeURIComponent(pid)}`).then((r) => r.json()).catch(() => ({}));
    if (j?.seed) setForm((f) => ({ ...f, ...j.seed, project_id: pid, lines: j.seed.lines?.length ? j.seed.lines : f.lines }));
  }

  async function act(action) {
    setBusy(true); setMsg(null);
    const res = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...form }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ err: j.error || 'Failed' }); return; }
    if (action === 'delete') { setForm(null); load(); return; }
    setForm(toForm(j));
    setMsg({ text: action === 'confirm' ? '✓ Confirmed' : action === 'push' ? '✓ Pushed to QuickBooks' : action === 'reopen' ? 'Reopened' : '✓ Saved' });
    load();
  }

  if (err) return (<><PageHeader title="Invoices" sheet="Invoices" /><div className="panel"><p className="note">{err}</p></div></>);

  // ── LIST VIEW ──
  if (!form) {
    return (
      <>
        <PageHeader title="Invoices" sub="Create a QuickBooks-style invoice — pick a customer (or link a project to autofill), add line items, confirm, then push to QuickBooks." sheet="Invoices" />
        <div className="toolbar">
          <button onClick={() => { setForm(blankForm()); setMsg(null); }}>+ New invoice</button>
          {!data.qb?.connected && <span className="note" style={{ color: '#a16207' }}>QuickBooks not connected — drafting works; push needs Connect QuickBooks.</span>}
          <span className="note" style={{ marginLeft: 'auto' }}>{data.invoices.length} invoice(s)</span>
        </div>
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="inv-list">
            <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>
              {data.invoices.map((iv) => {
                const t = calc(iv);
                return (
                  <tr key={iv.id} onClick={() => { setForm(toForm(iv)); setMsg(null); }} style={{ cursor: 'pointer' }}>
                    <td>{iv.invoice_number || iv.qb_doc_number || <span className="note">—</span>}</td>
                    <td>{iv.customer_name || <span className="note">—</span>}</td>
                    <td>{iv.invoice_date ? String(iv.invoice_date).slice(0, 10) : <span className="note">—</span>}</td>
                    <td><span className={`inv-st s-${iv.status}`}>{iv.status}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(t.total)}</td>
                  </tr>
                );
              })}
              {!data.invoices.length && <tr><td colSpan={5} className="note" style={{ padding: 14 }}>No invoices yet — click “+ New invoice”.</td></tr>}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  // ── FORM VIEW ──
  const t = calc(form);
  const status = form.status || 'draft';
  const editable = status !== 'pushed';
  return (
    <>
      <PageHeader title="Invoices" sheet="Invoices" />
      <div className="toolbar">
        <button className="secondary" onClick={() => { setForm(null); load(); }}>← All invoices</button>
        <span className={`inv-st s-${status}`}>{status}</span>
        {form.qb_doc_number && <span className="note">QB invoice #{form.qb_doc_number}</span>}
        {form.confirmed_by && status !== 'draft' && <span className="note">confirmed by {form.confirmed_by}</span>}
      </div>
      {msg && <p className="note" style={{ color: msg.err ? '#dc2626' : '#16a34a' }}>{msg.err || msg.text}</p>}
      {!data.qb?.connected && <p className="note" style={{ color: '#a16207' }}>⚠ QuickBooks not connected — drafting & confirming work; <b>push</b> needs an admin to Connect QuickBooks first.</p>}

      <div className="panel inv-form">
        <div className="inv-row">
          <label className="inv-grow">Customer<ComboSearch value={form.customer_name} disabled={!editable} placeholder="Search or type a customer…" options={customerOptions} onChange={(v) => set('customer_name', v)} onPick={pickCustomer} /></label>
          <label className="inv-grow">Customer email<input value={form.customer_email} disabled={!editable} onChange={(e) => set('customer_email', e.target.value)} /></label>
          <label>Link project (autofill)<select value={form.project_id} disabled={!editable} onChange={(e) => linkProject(e.target.value)}><option value="">— none —</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.project_number} · {p.counterparty || p.title}</option>)}</select></label>
        </div>
        <div className="inv-row">
          <label className="inv-grow">Billing address<textarea rows={3} value={form.billing_address} disabled={!editable} onChange={(e) => set('billing_address', e.target.value)} /></label>
          <label className="inv-grow">Shipping address<textarea rows={3} value={form.shipping_address} disabled={!editable} onChange={(e) => set('shipping_address', e.target.value)} /></label>
        </div>
        <div className="inv-row">
          <label>Invoice #<input value={form.invoice_number || ''} disabled readOnly placeholder={form.id ? '' : 'Assigned on save'} /></label>
          <label>Invoice date<input type="date" value={form.invoice_date} disabled={!editable} onChange={(e) => set('invoice_date', e.target.value)} /></label>
          <label>Due date<input type="date" value={form.due_date} disabled={!editable} onChange={(e) => set('due_date', e.target.value)} /></label>
          <label>Terms<select value={form.terms} disabled={!editable} onChange={(e) => set('terms', e.target.value)}>{TERMS.map((x) => <option key={x} value={x}>{x || '—'}</option>)}</select></label>
          <label>P.O. Number<input value={form.po_number || ''} disabled={!editable} onChange={(e) => set('po_number', e.target.value)} /></label>
        </div>
        <div className="inv-row">
          <label>Class<input list="inv-class" value={form.class_name || ''} disabled={!editable} placeholder="e.g. Robotics · West" onChange={(e) => set('class_name', e.target.value)} /></label>
          <datalist id="inv-class">{existingClasses.map((c, i) => <option key={i} value={c} />)}</datalist>
          <label className="inv-grow">Tags
            <div className="inv-tags">
              {(form.tags || []).map((t) => <span key={t} className="inv-tag">{t}{editable && <button type="button" onClick={() => removeTag(t)}>✕</button>}</span>)}
              {editable && <input list="inv-tagsugg" className="inv-taginput" value={tagInput} placeholder="Start typing to add a tag…" onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); } }} onBlur={() => addTag(tagInput)} />}
            </div>
          </label>
          <datalist id="inv-tagsugg">{existingTags.map((t, i) => <option key={i} value={t} />)}</datalist>
        </div>

        {editable && (
          <div className="inv-row">
            <label className="inv-grow" style={{ maxWidth: 460 }}>Add a product{qbPriced ? <span className="note" style={{ fontWeight: 400 }}> · prices from QuickBooks</span> : null}
              <ComboSearch value={prodQ} placeholder="🔍 Search products by name or SKU…" options={productSearchOptions} onChange={setProdQ} onPick={addProductOption} />
            </label>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="inv-lines">
            <thead><tr><th>Service date</th><th>Product / Service</th><th>SKU</th><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Tax</th>{editable && <th />}</tr></thead>
            <tbody>
              {form.lines.map((l, i) => (
                <tr key={i}>
                  <td><input type="date" className="inv-sdate" value={l.service_date || ''} disabled={!editable} onChange={(e) => setLine(i, 'service_date', e.target.value)} /></td>
                  <td><input value={l.product_name || ''} disabled={!editable} onChange={(e) => setLine(i, 'product_name', e.target.value)} /></td>
                  <td><input className="inv-sku" value={l.sku || ''} disabled={!editable} onChange={(e) => setLine(i, 'sku', e.target.value)} /></td>
                  <td><input value={l.description || ''} disabled={!editable} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                  <td><input type="number" className="inv-qty" value={l.quantity} disabled={!editable} onChange={(e) => editLineNum(i, 'quantity', e.target.value)} /></td>
                  <td><input type="number" step="0.01" className="inv-rate" value={l.unit_price} disabled={!editable} onChange={(e) => editLineNum(i, 'unit_price', e.target.value)} /></td>
                  <td><input type="number" step="0.01" className="inv-rate" value={lineAmount(l)} disabled={!editable} onChange={(e) => editLineNum(i, 'amount', e.target.value)} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={l.taxable !== false} disabled={!editable} onChange={(e) => setLine(i, 'taxable', e.target.checked)} /></td>
                  {editable && <td><button className="inv-rm" title="Remove" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>✕</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && <button className="secondary inv-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blankLine()] }))}>+ Add line</button>}

        <div className="inv-totals">
          <div className="inv-trow"><span>Subtotal</span><b>{money(t.sub)}</b></div>
          <div className="inv-trow"><span>Discount <select value={form.discount_type} disabled={!editable} onChange={(e) => set('discount_type', e.target.value)} style={{ width: 48 }}><option value="amount">$</option><option value="percent">%</option></select> <input type="number" className="inv-mini" value={form.discount_value} disabled={!editable} onChange={(e) => set('discount_value', e.target.value)} /></span><b>−{money(t.disc)}</b></div>
          <div className="inv-trow"><span>Sales tax <input type="number" className="inv-mini" value={form.tax_rate} disabled={!editable} onChange={(e) => set('tax_rate', e.target.value)} /> %</span><b>{money(t.tax)}</b></div>
          <div className="inv-trow inv-total"><span>Total</span><b>{money(t.total)}</b></div>
        </div>

        <div className="inv-row">
          <label className="inv-grow">Note to customer<textarea rows={2} value={form.customer_message} disabled={!editable} onChange={(e) => set('customer_message', e.target.value)} /></label>
          <label className="inv-grow">Memo on statement (internal)<textarea rows={2} value={form.notes} disabled={!editable} onChange={(e) => set('notes', e.target.value)} /></label>
        </div>
        <div className="inv-row">
          <label className="inv-grow">Payment instructions<textarea rows={4} value={form.payment_instructions} disabled={!editable} placeholder="Make checks payable to… · wiring instructions (bank, account #, routing #)…" onChange={(e) => set('payment_instructions', e.target.value)} /></label>
        </div>

        <div className="inv-actions">
          {form.id && <button className="secondary inv-sm" onClick={() => { if (window.confirm('Delete this invoice?')) act('delete'); }} disabled={busy}>Delete</button>}
          <span style={{ flex: 1 }} />
          {editable && <button className="secondary" onClick={() => act('save')} disabled={busy}>Save draft</button>}
          {status === 'draft' && <button onClick={() => act('confirm')} disabled={busy}>Confirm</button>}
          {status === 'confirmed' && <button className="secondary" onClick={() => act('reopen')} disabled={busy}>Reopen</button>}
          {status === 'confirmed' && <button onClick={() => act('push')} disabled={busy || !data.qb?.connected} title={data.qb?.connected ? '' : 'Connect QuickBooks first'}>Push to QuickBooks ↗</button>}
        </div>
      </div>
    </>
  );
}
