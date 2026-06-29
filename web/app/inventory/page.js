'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { PageHeader } from '../_components/blueprint';
import ShipmentForm from '../_components/ShipmentForm';

// Stock-status chip for a recommended item.
const REC_CHIP = { in_stock: 'ok', short: 'warn', out: 'bad', no_match: 'warn' };
const recLabel = (r) =>
  r.status === 'in_stock' ? `in stock · ${r.onHand}`
    : r.status === 'short' ? `short by ${r.shortfall} · ${r.onHand} on hand`
      : r.status === 'out' ? 'out of stock'
        : 'no SKU match';

export default function Inventory() {
  const [data, setData] = useState({ canEdit: false, projects: [], carts: [], inventory: [] });
  const [collapsed, setCollapsed] = useState({});
  const [addModal, setAddModal] = useState(null);  // { project_id, label }
  const [invSearch, setInvSearch] = useState('');  // search inventory inside the add modal
  const [qtys, setQtys] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [skipped, setSkipped] = useState({}); // "<projectId>::<item>" → true (dismissed recommendation, session-only)

  const [ship, setShip] = useState({}); // project_id → shipping project (shipment + autofill)
  const load = () => {
    fetch('/api/inventory/cart').then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
    fetch('/api/shipping').then((r) => r.json()).then((d) => {
      if (d && !d.error) { const m = {}; for (const p of d.projects || []) m[p.id] = p; setShip(m); }
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const cartByProject = useMemo(() => {
    const m = {};
    for (const c of data.carts || []) (m[c.project_id] = m[c.project_id] || []).push(c);
    return m;
  }, [data.carts]);
  // A card shows its own cart plus any items allocated while it was still a proposal
  // (so prep done pre-agreement stays visible once the agreement lands).
  const cartFor = (p) => {
    const own = cartByProject[p.id] || [];
    return p.proposal_id && p.proposal_id !== p.id ? [...own, ...(cartByProject[p.proposal_id] || [])] : own;
  };

  // Every project shows as a card.
  const projects = data.projects || [];

  const isOpen = (pid, hasCart) => (collapsed[pid] === undefined ? hasCart : !collapsed[pid]);
  const toggle = (pid, hasCart) => { const open = isOpen(pid, hasCart); setCollapsed((m) => ({ ...m, [pid]: open })); };

  const canEdit = data.canEdit;
  const invResults = useMemo(() => {
    const inv = data.inventory || [];
    if (!invSearch) return inv.slice(0, 60);
    const s = invSearch.toLowerCase();
    return inv.filter((it) => `${it.product_name || ''} ${it.sku || ''} ${it.category || ''} ${it.product_line || ''}`.toLowerCase().includes(s)).slice(0, 60);
  }, [data.inventory, invSearch]);

  async function addItem(item) {
    setBusy(true); setMsg('');
    const quantity = Number(qtys[item.id]) || 1;
    const res = await fetch(`/api/inventory/${item.id}/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: addModal.project_id, quantity }),
    });
    setBusy(false);
    if (res.ok) { setMsg(`Added ${item.sku || item.product_name}`); load(); }
    else { const j = await res.json().catch(() => ({})); setMsg(j.error || 'Add failed'); }
  }
  async function removeLine(id) {
    setBusy(true);
    await fetch(`/api/inventory/cart?id=${id}`, { method: 'DELETE' }).catch(() => {});
    setBusy(false); load();
  }
  // Add a recommended (matched) item straight into the project's cart.
  async function addRecommended(projectId, rec) {
    if (!rec.match) return;
    setBusy(true); setMsg('');
    const res = await fetch(`/api/inventory/${rec.match.id}/allocate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, quantity: rec.needed, note: `from proposal: ${rec.item}`.slice(0, 500) }),
    });
    setBusy(false);
    if (res.ok) { setMsg(`Added ${rec.match.sku || rec.match.product_name}`); load(); }
    else { const j = await res.json().catch(() => ({})); setMsg(j.error || 'Add failed'); }
  }

  // Check out a project's cart (consume stock + lock) or reopen it (restore stock).
  // Inventory manager / admin only; shared with the Project Tracker's Shipping step.
  async function checkout(p, doCheckout) {
    setBusy(true); setMsg('');
    const res = await fetch('/api/inventory/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: p.id, proposal_id: p.proposal_id || null, reopen: !doCheckout }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg(doCheckout ? '✓ Checked out — stock updated, cart locked' : 'Reopened — stock restored'); load(); }
    else if (j.short) { setMsg('✗ Not enough stock: ' + j.short.map((s) => `${s.product_name} needs ${s.needed}, ${s.available} on hand`).join('; ')); }
    else { setMsg(j.error || 'Checkout failed'); }
  }

  const modalCart = addModal ? (cartByProject[addModal.project_id] || []) : [];

  return (
    <>
      <PageHeader title="Inventory" sub="Every project is a card with its inventory cart. Open a card, then search inventory and add what it needs." sheet="Inventory" />

      <div className="toolbar">
        <Link href="/inventory/detail" className="invbtn">📦 Full inventory detail (stock list) →</Link>
        {!canEdit && <span className="note">View only — admins / inventory team can add.</span>}
        {msg && !addModal && <span className="note" style={{ color: msg.startsWith('✓') ? '#16a34a' : msg.startsWith('✗') ? '#dc2626' : 'inherit' }}>{msg}</span>}
        <span className="note" style={{ marginLeft: 'auto' }}>{projects.length} project(s)</span>
      </div>

      {projects.map((p) => {
        const cart = cartFor(p);
        const open = isOpen(p.id, cart.length > 0);
        const locked = p.inventory_confirmed; // ended → cart is locked
        const recs = p.recommendations || [];
        const skipKey = (r) => `${p.id}::${r.item}`;
        const visibleRecs = recs.filter((r) => !skipped[skipKey(r)]);
        const skippedRecs = recs.filter((r) => skipped[skipKey(r)]);
        return (
          <div className="panel inv-block" key={p.id}>
            <div className="inv-bhead" onClick={() => toggle(p.id, cart.length > 0)}>
              <span className="inv-caret">{open ? '▾' : '▸'}</span>
              <span className="inv-pchip">{p.project_number}</span>
              <span className="inv-ptitle">{p.title || p.counterparty || 'Project'}</span>
              {p.is_proposal && <span className="inv-proposal" title="Proposal stage — no agreement yet">Proposal</span>}
              {p.robot_types && <span className="note">🤖 {p.robot_types}{p.robot_count != null ? ` · ${p.robot_count}` : ''}</span>}
              {locked && (
                <span className="inv-confirmed" title={`Checked out${p.confirmed_by_name ? ` by ${p.confirmed_by_name}` : ''}${p.confirmed_at ? ` · ${new Date(p.confirmed_at).toLocaleDateString()}` : ''}`}>🔒 Checked out</span>
              )}
              <span className="note" style={{ marginLeft: 'auto' }}>🛒 {cart.length} item(s)</span>
            </div>
            {open && (
              <div className="inv-bbody" onClick={(e) => e.stopPropagation()}>
                {recs.length > 0 && (
                  <div className="rec-block">
                    <div className="rec-head">📋 Recommended from proposal <span className="note">· {recs.length} item(s) · match to stock</span></div>
                    <table className="rec-table">
                      <tbody>
                        {visibleRecs.map((r, i) => (
                          <tr className="rec-row" key={i}>
                            <td className="rec-tag"><span className={`chip ${REC_CHIP[r.status]}`}>{recLabel(r)}</span></td>
                            <td className="rec-need"><b>{r.needed}×</b> {r.item}</td>
                            <td className="rec-to">{r.match ? <>{r.match.product_name || r.match.sku}{r.match.sku && <code> {r.match.sku}</code>}</> : null}</td>
                            <td className="rec-act">
                              {canEdit && !locked && r.match && <button className="rec-add" onClick={() => addRecommended(p.id, r)} disabled={busy}>Add</button>}
                              {canEdit && !locked && <button className="rec-search" title={`Search inventory for "${r.item}"`} onClick={() => { setAddModal({ project_id: p.id, label: p.project_number }); setInvSearch(r.item); setMsg(''); }} disabled={busy}>🔍 Search &amp; add</button>}
                              {canEdit && !locked && <button className="rec-skip" onClick={() => setSkipped((s) => ({ ...s, [skipKey(r)]: true }))} disabled={busy}>Skip</button>}
                            </td>
                          </tr>
                        ))}
                        {!visibleRecs.length && <tr><td colSpan={4} className="note rec-allskipped">All recommendations skipped — restore below.</td></tr>}
                      </tbody>
                    </table>
                    {skippedRecs.length > 0 && (
                      <div className="rec-skipped">
                        <span className="note">Skipped ({skippedRecs.length}):</span>
                        {skippedRecs.map((r, i) => (
                          <span className="rec-skchip" key={i}>{r.item}
                            <button className="rec-unskip" title="Restore to list" onClick={() => setSkipped((s) => { const n = { ...s }; delete n[skipKey(r)]; return n; })} disabled={busy}>↩</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {cart.length ? (
                  <ul className="cart-list">
                    {cart.map((c) => (
                      <li key={c.id}>
                        <span className="cl-main"><b>{c.quantity ? `${c.quantity}× ` : ''}</b>{c.product_name || c.sku}</span>
                        {c.sku && <code className="cl-sku">{c.sku}</code>}
                        {c.note && <span className="note"> · {c.note}</span>}
                        {canEdit && !locked && <button className="cl-rm" title="Remove" onClick={() => removeLine(c.id)} disabled={busy}>✕</button>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="note" style={{ margin: '4px 0' }}>No items in this project’s cart yet.</p>}
                {canEdit && !locked && <button className="secondary" onClick={() => { setAddModal({ project_id: p.id, label: p.project_number }); setInvSearch(''); setMsg(''); }}>+ Add inventory</button>}

                {/* Confirm & end inventory (manager/admin) — locks the cart; shared with the tracker's Shipping prep step */}
                <div className="inv-confirm-row">
                  {locked ? (
                    <span className="inv-confirm-note">🔒 Checked out{p.confirmed_by_name ? ` by ${p.confirmed_by_name}` : ''}{p.confirmed_at ? ` · ${new Date(p.confirmed_at).toLocaleDateString()}` : ''} — stock consumed, cart locked.
                      {p.can_confirm && <button className="inv-undo" onClick={() => checkout(p, false)} disabled={busy}>Reopen</button>}
                    </span>
                  ) : p.can_confirm ? (
                    <button className="inv-confirm-btn" onClick={() => checkout(p, true)} disabled={busy}>🛒 Check out &amp; consume stock</button>
                  ) : !p.is_proposal ? (
                    <span className="note">Not checked out yet.</span>
                  ) : null}
                </div>

                {/* Inline shipping — appears once the project is checked out */}
                {locked && ship[p.id] && (
                  <div className="inv-ship">
                    <ShipmentForm project={ship[p.id]} canEdit={canEdit} onSaved={load} title="📦 Shipping" />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {projects.length === 0 && (
        <div className="panel"><p className="note" style={{ margin: 0 }}>No projects yet.</p></div>
      )}

      {/* Search-and-add inventory modal (scoped to one project) */}
      {addModal && (
        <div className="inv-overlay" onClick={() => setAddModal(null)}>
          <div className="inv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="inv-mhead"><b>Add inventory to {addModal.label}</b><button className="secondary" onClick={() => setAddModal(null)} style={{ marginLeft: 'auto' }}>Done</button></div>
            {modalCart.length > 0 && <p className="note" style={{ marginTop: 0 }}>In cart: {modalCart.length} item(s)</p>}
            <input autoFocus className="inv-msearch" placeholder="Search inventory — product, SKU, line…" value={invSearch} onChange={(e) => setInvSearch(e.target.value)} />
            {msg && <p className="note inv-msg">{msg}</p>}
            <div className="inv-results">
              {invResults.length ? (
                <table className="inv-table">
                  <thead>
                    <tr><th>Product</th><th>SKU</th><th>Line</th><th className="r">Stock</th><th className="r">Qty</th><th></th></tr>
                  </thead>
                  <tbody>
                    {invResults.map((it) => (
                      <tr key={it.id}>
                        <td className="it-name">{it.product_name || it.sku || 'item'}</td>
                        <td>{it.sku ? <code>{it.sku}</code> : <span className="note">—</span>}</td>
                        <td>{it.product_line ? <span className="chip ok">{it.product_line}</span> : <span className="note">—</span>}</td>
                        <td className="r it-stock">{it.quantity ?? '—'}</td>
                        <td className="r"><input type="number" min="1" value={qtys[it.id] ?? 1} onChange={(e) => setQtys((s) => ({ ...s, [it.id]: e.target.value }))} className="inv-rqty" disabled={busy} /></td>
                        <td className="r"><button className="it-add" onClick={() => addItem(it)} disabled={busy}>Add</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="note">No inventory matches.</p>}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .invbtn { display:inline-flex; align-items:center; background:var(--primary); color:#fff; padding:8px 16px; border-radius:8px; font-weight:600; font-size:13px; }
        .invbtn:hover { filter:brightness(1.08); }
        .inv-block { padding:0; overflow:hidden; margin-bottom:10px; }
        .inv-bhead { display:flex; align-items:center; gap:10px; padding:11px 14px; cursor:pointer; }
        .inv-bhead:hover { background:rgba(0,0,0,.02); }
        .inv-caret { color:var(--muted); width:12px; }
        .inv-pchip { font-weight:700; font-size:11px; background:#0f172a; color:#fff; padding:1px 8px; border-radius:999px; }
        .inv-proposal { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#6366f1; background:rgba(99,102,241,.12); border:1px solid rgba(99,102,241,.35); padding:1px 7px; border-radius:999px; }
        .inv-ptitle { font-weight:600; font-size:14px; }
        .inv-bbody { border-top:1px solid var(--line); padding:12px 14px; }
        .rec-block { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:12px; background:rgba(99,102,241,.05); }
        .rec-head { font-size:12px; font-weight:700; margin-bottom:6px; }
        .rec-table { width:100%; border-collapse:collapse; font-size:13px; }
        .rec-table td { padding:6px 8px; border-bottom:1px solid rgba(99,102,241,.18); vertical-align:middle; }
        .rec-table tr:last-child td { border-bottom:0; }
        /* 2-color (zebra) rows */
        .rec-table tbody tr:nth-child(odd) td { background:rgba(255,255,255,.55); }
        .rec-table tbody tr:nth-child(even) td { background:rgba(99,102,241,.10); }
        .rec-tag { width:1%; white-space:nowrap; }
        .rec-need { font-weight:500; }
        .rec-to { color:var(--muted); } .rec-to code { font-size:11px; }
        .rec-act { width:1%; white-space:nowrap; text-align:right; }
        .rec-add { font-size:11px; padding:2px 12px; }
        .rec-search { font-size:11px; padding:2px 10px; margin-left:6px; background:var(--chip); color:var(--primary); border:1px solid var(--line); white-space:nowrap; }
        .rec-search:hover { background:#dbe8fb; }
        .rec-skip { font-size:11px; padding:2px 10px; margin-left:6px; background:var(--chip); color:var(--muted); border:1px solid var(--line); }
        .rec-skip:hover { color:var(--ink); background:#e2ecf9; }
        .rec-allskipped { text-align:center; padding:8px; }
        .rec-skipped { margin-top:8px; padding-top:8px; border-top:1px dashed rgba(99,102,241,.25); display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:12px; }
        .rec-skchip { display:inline-flex; align-items:center; gap:2px; background:var(--chip); border:1px solid var(--line); border-radius:999px; padding:1px 3px 1px 10px; color:var(--muted); text-decoration:line-through; }
        .rec-unskip { border:0; background:transparent; cursor:pointer; color:var(--primary); font-size:13px; line-height:1; padding:1px 5px; border-radius:999px; }
        .rec-unskip:hover { background:#dbe8fb; }
        .cart-list { list-style:none; margin:0 0 10px; padding:0; }
        .cart-list li { position:relative; font-size:13px; padding:5px 22px 5px 8px; border-radius:6px; }
        .cart-list li:nth-child(even) { background:rgba(29,78,216,.05); }
        .cl-sku { font-size:11px; margin-left:6px; }
        .cl-rm { position:absolute; top:0; right:0; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:12px; }
        .cl-rm:hover { color:var(--bad); }
        .inv-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow:auto; }
        .inv-modal { width:680px; max-width:96vw; background:var(--surface); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.3); padding:18px; }
        .inv-mhead { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:8px; border-bottom:1px solid var(--line); }
        .inv-msearch { width:100%; }
        .inv-msg { color:#16a34a; margin:8px 0 0; }
        .inv-results { margin-top:10px; max-height:440px; overflow:auto; border:1px solid var(--line); border-radius:8px; }
        .inv-table { width:100%; border-collapse:collapse; font-size:13px; }
        .inv-table th { position:sticky; top:0; z-index:1; background:var(--chip); text-align:left; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:700; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
        .inv-table th.r, .inv-table td.r { text-align:right; }
        .inv-table td { padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
        .inv-table tbody tr:last-child td { border-bottom:0; }
        .inv-table tbody tr:nth-child(even) td { background:rgba(29,78,216,.04); }
        .inv-table tbody tr:hover td { background:rgba(29,78,216,.09); }
        .inv-table .it-name { font-weight:500; }
        .inv-table .it-stock { color:var(--muted); font-variant-numeric:tabular-nums; }
        .inv-table code { font-size:11px; }
        .inv-rqty { width:58px; }
        .inv-table .it-add { font-size:12px; padding:4px 14px; }
        .inv-confirmed { font-size:11px; font-weight:700; color:#15803d; background:rgba(22,163,74,.12); border:1px solid rgba(22,163,74,.4); padding:1px 8px; border-radius:999px; }
        .inv-confirm-row { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
        .inv-confirm-btn { background:#16a34a; }
        .inv-confirm-btn:hover { background:#15803d; }
        .inv-confirm-note { font-size:13px; color:#15803d; font-weight:600; display:inline-flex; align-items:center; gap:10px; }
        .inv-undo { font-size:11px; padding:2px 10px; background:var(--chip); color:var(--ink); border:1px solid var(--line); }
        .inv-undo:hover { background:#e2ecf9; }
        .inv-ship { margin-top:12px; padding-top:12px; border-top:1px dashed var(--line); }
      `}</style>
    </>
  );
}
