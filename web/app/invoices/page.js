'use client';
import { useEffect, useState, useRef } from 'react';
import { PageHeader } from '../_components/blueprint';
import ComboSearch from '../_components/ComboSearch';

const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TERMS = ['', 'Due on receipt', 'Net 15', 'Net 30', 'Net 60'];
const today = () => new Date().toISOString().slice(0, 10);
const blankLine = () => ({ service_date: '', product_name: '', description: '', quantity: 1, unit_price: 0, amount: 0, taxable: true, sku: null, cn_sku_id: null, qb_item_id: null });

// Default text pre-filled into "Payment instructions" on every NEW invoice (editable;
// existing invoices keep their saved value). Plain text — it becomes the QuickBooks memo.
const DEFAULT_PAYMENT_INSTRUCTIONS = `Please make checks payable to: Richtech Robotics Inc.

Wiring Instructions:
Bank of America
Account Number: 501028165183
ACH Routing #: 122400724
Wires Routing #: 026009593`;

const blankForm = () => ({ id: null, project_id: '', customer_name: '', customer_email: '', billing_address: '', shipping_address: '', invoice_number: '', po_number: '', so_number: '', project_manager: '', invoice_date: today(), due_date: '', terms: '', class_name: '', tags: [], customer_message: '', payment_instructions: DEFAULT_PAYMENT_INSTRUCTIONS, notes: '', discount_type: 'amount', discount_value: '', tax_rate: '', currency: 'USD', lines: [blankLine()], status: 'draft' });

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
  // SO #: prefer the project's own sales-order number; if none was captured, fall back
  // to the QuickBooks number (QB numbers pushed invoices as "SO####", e.g. SO7706).
  so_number: iv.so_number || iv.qb_doc_number || '',
  discount_type: iv.discount_type || 'amount', discount_value: iv.discount_value ?? '', tax_rate: iv.tax_rate ?? '',
  invoice_date: iv.invoice_date ? String(iv.invoice_date).slice(0, 10) : '', due_date: iv.due_date ? String(iv.due_date).slice(0, 10) : '',
  customer_message: iv.customer_message || '', notes: iv.notes || '',
  lines: iv.lines?.length ? iv.lines : [blankLine()],
});

export default function Invoices() {
  const [data, setData] = useState({ invoices: [], projects: [], qb: {}, canEdit: false });
  const [loaded, setLoaded] = useState(false); // first /api/invoices fetch done → QB status is known (avoids a false "not connected" flash)
  const [form, setForm] = useState(null);   // null = list view; object = editing
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [qbCust, setQbCust] = useState([]); // live QuickBooks customer-search results
  const [suggest, setSuggest] = useState(null); // per-field source suggestions from the linked project
  const [lineInfo, setLineInfo] = useState(null); // {fixed, count} — inventory lines autofilled from the project
  const custTimer = useRef(null);
  const savedRef = useRef(null); // JSON snapshot of the last saved/loaded form → detects unsaved edits

  // Debounced server-side QuickBooks customer search (2000+ customers → not preloaded).
  function searchCustomers(qstr) {
    clearTimeout(custTimer.current);
    if (!qstr || qstr.trim().length < 2) { setQbCust([]); return; }
    custTimer.current = setTimeout(async () => {
      const j = await fetch(`/api/invoices?customer_search=${encodeURIComponent(qstr)}`).then((r) => r.json()).catch(() => ({}));
      setQbCust(j.customers || []);
    }, 300);
  }

  const load = () => fetch('/api/invoices').then((r) => r.json()).then((d) => { if (d?.error) setErr(d.error); else setData(d); }).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  // Open/replace the editor form and snapshot it as the saved baseline, so `dirty`
  // (unsaved edits) starts false. Pass null to return to the list view.
  const openForm = (f) => { savedRef.current = f ? JSON.stringify(f) : null; setForm(f); };

  // Deep link (runs once the invoice list has loaded):
  //   /invoices?invoice=<id>   → open that specific existing invoice.
  //   /invoices?project=<id>   → if the project ALREADY has an invoice, open its most
  //                              recent one (so its number/details are right there);
  //                              otherwise seed a NEW invoice linked to the project.
  // Waiting for `loaded` matters: otherwise we'd always fall through to "new" before
  // the existing invoices arrived. Used by the Project Tracker's invoice-stage links.
  const seededFromUrl = useRef(false);
  useEffect(() => {
    if (seededFromUrl.current || !loaded) return;
    const params = new URLSearchParams(window.location.search);
    const openId = params.get('invoice');
    const pid = params.get('project');
    if (!openId && !pid) { seededFromUrl.current = true; return; }
    seededFromUrl.current = true;
    setSuggest(null); setLineInfo(null); setMsg(null);
    const invs = data.invoices || [];
    const target = openId
      ? invs.find((iv) => String(iv.id) === String(openId))
      : invs.filter((iv) => String(iv.project_id) === String(pid))
             .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
    if (target) {
      openForm(toForm(target));
      if (pid) setMsg({ text: 'Opened this project’s existing invoice. To add another, use “+ New invoice” from the list.' });
    } else if (pid) {
      openForm(blankForm());
      linkProject(pid);
    }
  }, [loaded]);

  // Deep link: /invoices?id=<invoiceId> → open that existing invoice's detail once
  // the list has loaded. Lets links elsewhere (e.g. the Project Tracker's Invoice
  // stage) point people straight to an invoice's detail.
  const openedFromUrl = useRef(false);
  useEffect(() => {
    if (openedFromUrl.current || !data.invoices.length) return;
    const iid = new URLSearchParams(window.location.search).get('id');
    if (!iid) { openedFromUrl.current = true; return; }
    const iv = data.invoices.find((x) => String(x.id) === String(iid));
    if (iv) { openForm(toForm(iv)); setSuggest(null); setLineInfo(null); setMsg(null); }
    openedFromUrl.current = true;
  }, [data.invoices]);

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
  const classNames = [...new Set([...((data.qbClasses || []).map((c) => c.name)), ...existingClasses])].filter(Boolean);
  const classOptions = classNames.map((n, i) => ({ key: `cl-${i}`, label: n, sub: '', data: n }));
  function addTag(raw) { const t = String(raw || '').trim(); if (!t) return; setForm((f) => (f.tags?.includes(t) ? f : { ...f, tags: [...(f.tags || []), t] })); setTagInput(''); }
  const removeTag = (t) => setForm((f) => ({ ...f, tags: (f.tags || []).filter((x) => x !== t) }));
  // Customer options = local (agreement/proposal) customers + live QuickBooks matches, deduped by name.
  const customerOptions = (() => {
    const seen = new Set();
    const out = [];
    for (const c of (data.customers || [])) { const k = String(c.name || '').toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push({ key: `l-${k}`, label: c.name, sub: c.email || '', data: c }); } }
    for (const c of qbCust) { const k = String(c.name || '').toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push({ key: `q-${c.id}`, label: c.name, sub: [c.email, 'QuickBooks'].filter(Boolean).join(' · '), data: c }); } }
    return out;
  })();
  // Project Manager options = QB custom-field names + QB employees, deduped.
  const pmNames = [...new Set([...(data.qbProjectManagers || []), ...((data.qbEmployees || []).map((e) => e.name))])].filter(Boolean);
  const pmOptions = pmNames.map((n, i) => ({ key: `pm-${i}`, label: n, sub: '', data: n }));

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
  // In-row product search: each line's Product/Service and SKU boxes are type-to-search
  // fields (native <datalist>). Picking a suggestion sets the exact name/SKU, which we
  // match back to a product here and use to fill the whole line — including the QB rate.
  function fillLineFromProduct(i, p) {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, j) => {
        if (j !== i) return l;
        const price = p.unit_price != null ? p.unit_price : (Number(l.unit_price) || 0); // QB item → its price; inventory item → keep
        const qty = Number(l.quantity) || 0;
        return { ...l, product_name: p.name, sku: p.sku ?? l.sku, unit_price: price, amount: qty * price, qb_item_id: p.qb_item_id ?? null, cn_sku_id: p.cn_sku_id ?? null };
      }),
    }));
  }
  // The Product/Service and SKU boxes are FREE TEXT while typing (onChange just sets
  // the field), so editing and deleting are never interrupted. We only auto-fill the
  // line from a matching product when the box is COMMITTED (onBlur) with a non-empty
  // value that exactly matches. This fixes two bugs: (a) you couldn't delete the SKU
  // because emptying it matched a product that has no SKU (via `p.sku || ''`), and
  // (b) mid-edit keystrokes hijacked the line whenever they happened to match a product.
  function onProductCommit(i, v) {
    const s = v.trim(); if (!s) return;
    const m = productOptions.find((p) => (p.name || '').toLowerCase() === s.toLowerCase());
    if (m) fillLineFromProduct(i, m);
  }
  function onSkuCommit(i, v) {
    const s = v.trim(); if (!s) return;
    const m = productOptions.find((p) => (p.sku || '').toLowerCase() === s.toLowerCase());
    if (m) fillLineFromProduct(i, m);
  }

  async function linkProject(pid) {
    set('project_id', pid);
    if (!pid) { setSuggest(null); setLineInfo(null); return; }
    const j = await fetch(`/api/invoices?seed=${encodeURIComponent(pid)}`).then((r) => r.json()).catch(() => ({}));
    if (j?.seed) {
      // keep suggestions + the inventory status flags out of the saved invoice
      const { suggest: sg, inventory_fixed, inventory_count, ...seed } = j.seed;
      setSuggest(sg || null);
      setLineInfo(inventory_count ? { fixed: !!inventory_fixed, count: inventory_count } : null);
      setForm((f) => ({ ...f, ...seed, project_id: pid, lines: seed.lines?.length ? seed.lines : f.lines }));
    }
  }

  async function act(action) {
    setBusy(true); setMsg(null);
    const res = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...form }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ err: j.error || 'Failed' }); return; }
    if (action === 'delete') { openForm(null); load(); return; }
    openForm(toForm(j));
    setMsg({ text: action === 'confirm' ? '✓ Confirmed' : action === 'push' ? '✓ Pushed to QuickBooks' : action === 'reopen' ? 'Reopened' : '✓ Saved' });
    load();
  }

  if (err) return (<><PageHeader title="Invoices" sheet="Invoices" /><div className="panel"><p className="note">{err}</p></div></>);

  // QuickBooks connection status line — three states so it no longer flashes a false
  // "not connected" while the first fetch is in flight. `full` = the detailed
  // form-view message; otherwise the compact list-view note.
  const qbBanner = (full) => {
    const Tag = full ? 'p' : 'span';
    if (!loaded) return <Tag className="note" style={{ color: 'var(--muted)' }}>⏳ Checking QuickBooks connection…</Tag>;
    if (data.qb?.connected) return <Tag className="note" style={{ color: '#15803d' }}>✓ QuickBooks connected{data.qb?.company ? ` · ${data.qb.company}` : ''} — invoices can be pushed.</Tag>;
    return full
      ? <p className="note" style={{ color: '#a16207' }}>⚠ QuickBooks not connected — drafting & confirming work; to <b>push</b>, an admin must <a href="/api/quickbooks/connect">Connect QuickBooks ↗</a> first (this is separate from a Data Sync).</p>
      : <span className="note" style={{ color: '#a16207' }}>QuickBooks not connected — drafting works; to push, <a href="/api/quickbooks/connect">Connect QuickBooks ↗</a>.</span>;
  };

  // ── LIST VIEW ──
  if (!form) {
    return (
      <>
        <PageHeader title="Invoices" sub="Create a QuickBooks-style invoice — pick a customer (or link a project to autofill), add line items, confirm, then push to QuickBooks." sheet="Invoices" />
        <div className="toolbar">
          <button onClick={() => { openForm(blankForm()); setSuggest(null); setLineInfo(null); setMsg(null); }}>+ New invoice</button>
          {qbBanner(false)}
          <span className="note" style={{ marginLeft: 'auto' }}>{data.invoices.length} invoice(s)</span>
        </div>
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="inv-list">
            <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>
              {data.invoices.map((iv) => {
                const t = calc(iv);
                return (
                  <tr key={iv.id} onClick={() => { openForm(toForm(iv)); setSuggest(null); setLineInfo(null); setMsg(null); }} style={{ cursor: 'pointer' }}>
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
  // Unsaved edits vs the last saved snapshot. Push sends the SAVED row (the server
  // pushes the DB record, not the posted form), so block Push until edits are saved
  // — otherwise QuickBooks would silently receive the old, pre-edit invoice.
  const dirty = savedRef.current !== null && JSON.stringify(form) !== savedRef.current;
  // One-click source suggestions under a field (only when sources actually differ).
  // The Final Proposal Form is the default; HubSpot / Agreement are alternatives.
  const recRow = (field) => {
    const list = suggest?.[field];
    if (!list || list.length < 2) return null;
    return (
      <span className="inv-recs">
        <span className="inv-recs-lbl">from</span>
        {list.map((r) => {
          const on = (form[field] || '') === r.value;
          const short = r.value.length > 46 ? `${r.value.slice(0, 46)}…` : r.value;
          return (
            <button type="button" key={r.source} className={`inv-rec${on ? ' on' : ''}`} disabled={!editable}
              title={`${r.label}: ${r.value}`} onClick={() => set(field, r.value)}>
              <b>{r.label}{r.source === 'proposal' ? ' · default' : ''}</b>{short}
            </button>
          );
        })}
      </span>
    );
  };
  return (
    <>
      <PageHeader title="Invoices" sheet="Invoices" />
      <div className="toolbar">
        <button className="secondary" onClick={() => { openForm(null); load(); }}>← All invoices</button>
        <span className={`inv-st s-${status}`}>{status}</span>
        {form.qb_doc_number && <span className="note">QB invoice #{form.qb_doc_number}</span>}
        {form.confirmed_by && status !== 'draft' && <span className="note">confirmed by {form.confirmed_by}</span>}
        {form.project_id && <a href={`/project-tracker?open=${encodeURIComponent(form.project_id)}`} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>📋 Open in Project Tracker ↗</a>}
      </div>
      {msg && <p className="note" style={{ color: msg.err ? '#dc2626' : '#16a34a' }}>{msg.err || msg.text}</p>}
      {qbBanner(true)}

      <div className="panel inv-form">
        <div className="inv-row">
          <label className="inv-grow">Customer<ComboSearch selectOnly value={form.customer_name} disabled={!editable} placeholder="Search and pick a QuickBooks customer…" options={customerOptions} onSearch={searchCustomers} onPick={pickCustomer} onClear={() => set('customer_name', '')} />{recRow('customer_name')}</label>
          <label className="inv-grow">Customer email<input value={form.customer_email} disabled={!editable} onChange={(e) => set('customer_email', e.target.value)} />{recRow('customer_email')}</label>
          <label>Link project (autofill)<select value={form.project_id} disabled={!editable} onChange={(e) => linkProject(e.target.value)}><option value="">— none —</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.project_number} · {p.counterparty || p.title}</option>)}</select></label>
        </div>
        <div className="inv-row">
          <label className="inv-grow">Billing address<textarea rows={3} value={form.billing_address} disabled={!editable} onChange={(e) => set('billing_address', e.target.value)} />{recRow('billing_address')}</label>
          <label className="inv-grow">Shipping address<textarea rows={3} value={form.shipping_address} disabled={!editable} onChange={(e) => set('shipping_address', e.target.value)} />{recRow('shipping_address')}</label>
        </div>
        <div className="inv-row">
          <label>Invoice #<input value={form.invoice_number || ''} disabled={!editable} placeholder="Auto INV-#### if blank — or type e.g. TEST-001" onChange={(e) => set('invoice_number', e.target.value)} /></label>
          <label>Invoice date<input type="date" value={form.invoice_date} disabled={!editable} onChange={(e) => set('invoice_date', e.target.value)} /></label>
          <label>Due date<input type="date" value={form.due_date} disabled={!editable} onChange={(e) => set('due_date', e.target.value)} /></label>
          <label>Terms<select value={form.terms} disabled={!editable} onChange={(e) => set('terms', e.target.value)}>{TERMS.map((x) => <option key={x} value={x}>{x || '—'}</option>)}</select></label>
          <label>P.O. Number<input value={form.po_number || ''} disabled={!editable} onChange={(e) => set('po_number', e.target.value)} /></label>
          <label>SO #<input value={form.so_number || ''} disabled={!editable} placeholder="Autofilled from linked project" onChange={(e) => set('so_number', e.target.value)} /></label>
          <label className="inv-grow" style={{ maxWidth: 280 }}>Project Manager{pmOptions.length ? <span className="note" style={{ fontWeight: 400 }}> · from QuickBooks</span> : null}
            <ComboSearch value={form.project_manager || ''} disabled={!editable} placeholder={pmOptions.length ? 'Pick or type a name…' : 'Type a name…'} options={pmOptions} onChange={(v) => set('project_manager', v)} onPick={(o) => set('project_manager', o.data)} />
          </label>
        </div>
        <div className="inv-row">
          <label style={{ minWidth: 200 }}>Class{(data.qbClasses?.length) ? <span className="note" style={{ fontWeight: 400 }}> · from QuickBooks</span> : null}
            <ComboSearch selectOnly value={form.class_name || ''} disabled={!editable} placeholder="Pick a class…" options={classOptions} onPick={(o) => set('class_name', o.data)} onClear={() => set('class_name', '')} />
          </label>
          <label className="inv-grow">Tags
            <div className="inv-tags">
              {(form.tags || []).map((t) => <span key={t} className="inv-tag">{t}{editable && <button type="button" onClick={() => removeTag(t)}>✕</button>}</span>)}
              {editable && <input list="inv-tagsugg" className="inv-taginput" value={tagInput} placeholder="Start typing to add a tag…" onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); } }} onBlur={() => addTag(tagInput)} />}
            </div>
          </label>
          <datalist id="inv-tagsugg">{existingTags.map((t, i) => <option key={i} value={t} />)}</datalist>
        </div>

        {lineInfo && (
          <p className={`inv-linenote${lineInfo.fixed ? ' fixed' : ''}`}>
            {lineInfo.fixed
              ? `🔒 ${lineInfo.count} line${lineInfo.count === 1 ? '' : 's'} autofilled from this project's checked-out inventory list.`
              : `📦 ${lineInfo.count} line${lineInfo.count === 1 ? '' : 's'} autofilled from this project's inventory pick-list — not yet checked out, so quantities may still change.`}
            {' '}Set rates below{!data.qb?.connected ? '' : ' (or pick a product to pull its QuickBooks price)'}.
          </p>
        )}
        {editable && (
          <p className="note" style={{ margin: '2px 0 6px' }}>🔍 Type in a line’s <b>Product / Service</b> or <b>SKU</b> box to search products — pick a suggestion to fill the line{qbPriced ? ' and pull its QuickBooks price' : ''}. Use <b>+ Add line</b> for more.</p>
        )}
        <datalist id="inv-prodsugg">
          {productOptions.map((p) => <option key={p.key} value={p.name} label={[p.sku, p.unit_price != null ? money(p.unit_price) : null].filter(Boolean).join(' · ')} />)}
        </datalist>
        <datalist id="inv-skusugg">
          {productOptions.filter((p) => p.sku).map((p) => <option key={p.key} value={p.sku} label={[p.name, p.unit_price != null ? money(p.unit_price) : null].filter(Boolean).join(' · ')} />)}
        </datalist>
        <div style={{ overflowX: 'auto' }}>
          <table className="inv-lines">
            <thead><tr><th>Service date</th><th>Product / Service</th><th>SKU</th><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Tax</th>{editable && <th />}</tr></thead>
            <tbody>
              {form.lines.map((l, i) => (
                <tr key={i}>
                  <td><input type="date" className="inv-sdate" value={l.service_date || ''} disabled={!editable} onChange={(e) => setLine(i, 'service_date', e.target.value)} /></td>
                  <td><input list="inv-prodsugg" autoComplete="off" placeholder="Search product…" value={l.product_name || ''} disabled={!editable} onChange={(e) => setLine(i, 'product_name', e.target.value)} onBlur={(e) => onProductCommit(i, e.target.value)} /></td>
                  <td><input list="inv-skusugg" autoComplete="off" placeholder="Search SKU…" className="inv-sku" value={l.sku || ''} disabled={!editable} onChange={(e) => setLine(i, 'sku', e.target.value)} onBlur={(e) => onSkuCommit(i, e.target.value)} /></td>
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
          {status === 'confirmed' && dirty && <span className="note" style={{ color: '#a16207' }}>Unsaved edits — Save draft, then Confirm & Push.</span>}
          {status === 'confirmed' && <button onClick={() => act('push')} disabled={busy || !data.qb?.connected || dirty} title={!data.qb?.connected ? 'Connect QuickBooks first' : dirty ? 'Save your changes first — QuickBooks receives the saved invoice, not unsaved edits' : ''}>Push to QuickBooks ↗</button>}
        </div>
      </div>
    </>
  );
}
