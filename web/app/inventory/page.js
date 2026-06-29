'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { PageHeader } from '../_components/blueprint';

// Stock-status chip for a recommended item.
const REC_CHIP = { in_stock: 'ok', short: 'warn', out: 'bad', no_match: 'bad' };
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

  const load = () => fetch('/api/inventory/cart').then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
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

  // Inventory sign-off — marks the project's "Shipping preparation" prep step done
  // (inventory manager / admin only); shared with the Project Tracker.
  async function confirmInventory(p, done) {
    setBusy(true); setMsg('');
    const res = await fetch('/api/project-tracker/prep', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: p.id, prep_key: 'shipping', done }),
    });
    setBusy(false);
    if (res.ok) { setMsg(done ? '✓ Inventory confirmed' : 'Confirmation undone'); load(); }
    else { const j = await res.json().catch(() => ({})); setMsg(j.error || 'Confirm failed'); }
  }

  const modalCart = addModal ? (cartByProject[addModal.project_id] || []) : [];

  return (
    <>
      <PageHeader title="Inventory" sub="Every project is a card with its inventory cart. Open a card, then search inventory and add what it needs." sheet="Inventory" />

      <div className="toolbar">
        <Link href="/inventory/detail" className="invbtn">📦 Full inventory detail (stock list) →</Link>
        {!canEdit && <span className="note">View only — admins / inventory team can add.</span>}
        {msg && !addModal && <span className="note" style={{ color: msg.startsWith('✓') ? '#16a34a' : 'inherit' }}>{msg}</span>}
        <span className="note" style={{ marginLeft: 'auto' }}>{projects.length} project(s)</span>
      </div>

      {projects.map((p) => {
        const cart = cartFor(p);
        const open = isOpen(p.id, cart.length > 0);
        return (
          <div className="panel inv-block" key={p.id}>
            <div className="inv-bhead" onClick={() => toggle(p.id, cart.length > 0)}>
              <span className="inv-caret">{open ? '▾' : '▸'}</span>
              <span className="inv-pchip">{p.project_number}</span>
              <span className="inv-ptitle">{p.title || p.counterparty || 'Project'}</span>
              {p.is_proposal && <span className="inv-proposal" title="Proposal stage — no agreement yet">Proposal</span>}
              {p.robot_types && <span className="note">🤖 {p.robot_types}{p.robot_count != null ? ` · ${p.robot_count}` : ''}</span>}
              {p.inventory_confirmed && (
                <span className="inv-confirmed" title={`Confirmed${p.confirmed_by_name ? ` by ${p.confirmed_by_name}` : ''}${p.confirmed_at ? ` · ${new Date(p.confirmed_at).toLocaleDateString()}` : ''}`}>✓ Inventory ready</span>
              )}
              <span className="note" style={{ marginLeft: 'auto' }}>🛒 {cart.length} item(s)</span>
            </div>
            {open && (
              <div className="inv-bbody" onClick={(e) => e.stopPropagation()}>
                {p.recommendations?.length > 0 && (
                  <div className="rec-block">
                    <div className="rec-head">📋 Recommended from proposal <span className="note">· {p.recommendations.length} item(s) · match to stock</span></div>
                    <ul className="rec-list">
                      {p.recommendations.map((r, i) => (
                        <li className="rec-row" key={i}>
                          <span className="rec-need"><b>{r.needed}×</b> {r.item}</span>
                          {r.match
                            ? <span className="rec-to">→ {r.match.product_name || r.match.sku}{r.match.sku && <code> {r.match.sku}</code>}</span>
                            : <span className="rec-to note">→ no matching SKU — search & add manually</span>}
                          <span className={`chip ${REC_CHIP[r.status]}`}>{recLabel(r)}</span>
                          {canEdit && r.match && <button className="rec-add" onClick={() => addRecommended(p.id, r)} disabled={busy}>Add</button>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {cart.length ? (
                  <ul className="cart-list">
                    {cart.map((c) => (
                      <li key={c.id}>
                        <span className="cl-main"><b>{c.quantity ? `${c.quantity}× ` : ''}</b>{c.product_name || c.sku}</span>
                        {c.sku && <code className="cl-sku">{c.sku}</code>}
                        {c.note && <span className="note"> · {c.note}</span>}
                        {canEdit && <button className="cl-rm" title="Remove" onClick={() => removeLine(c.id)} disabled={busy}>✕</button>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="note" style={{ margin: '4px 0' }}>No items in this project’s cart yet.</p>}
                {canEdit && <button className="secondary" onClick={() => { setAddModal({ project_id: p.id, label: p.project_number }); setInvSearch(''); setMsg(''); }}>+ Add inventory</button>}

                {/* Inventory sign-off (manager/admin) — shared with the tracker's Shipping prep step */}
                <div className="inv-confirm-row">
                  {p.inventory_confirmed ? (
                    <span className="inv-confirm-note">✓ Inventory confirmed{p.confirmed_by_name ? ` by ${p.confirmed_by_name}` : ''}{p.confirmed_at ? ` · ${new Date(p.confirmed_at).toLocaleDateString()}` : ''}
                      {p.can_confirm && <button className="inv-undo" onClick={() => confirmInventory(p, false)} disabled={busy}>Undo</button>}
                    </span>
                  ) : p.can_confirm ? (
                    <button className="inv-confirm-btn" onClick={() => confirmInventory(p, true)} disabled={busy}>✓ Confirm inventory ready</button>
                  ) : !p.is_proposal ? (
                    <span className="note">Inventory not yet confirmed.</span>
                  ) : null}
                </div>
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
              {invResults.length ? invResults.map((it) => (
                <div className="inv-rrow" key={it.id}>
                  <div className="inv-rname">{it.product_name || it.sku || 'item'}<div className="inv-rmeta">{it.sku ? <code>{it.sku}</code> : null} {it.product_line ? <span className="chip ok">{it.product_line}</span> : null} <span className="note">stock {it.quantity ?? '—'}</span></div></div>
                  <input type="number" min="1" value={qtys[it.id] ?? 1} onChange={(e) => setQtys((s) => ({ ...s, [it.id]: e.target.value }))} className="inv-rqty" disabled={busy} />
                  <button onClick={() => addItem(it)} disabled={busy}>Add</button>
                </div>
              )) : <p className="note">No inventory matches.</p>}
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
        .rec-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
        .rec-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; }
        .rec-need { font-weight:500; flex:0 0 auto; }
        .rec-to { color:var(--muted); min-width:0; } .rec-to code { font-size:11px; }
        .rec-add { font-size:11px; padding:2px 12px; margin-left:auto; flex:0 0 auto; }
        .cart-list { list-style:none; margin:0 0 10px; padding:0; display:flex; flex-direction:column; gap:6px; }
        .cart-list li { position:relative; font-size:13px; padding-right:22px; }
        .cl-sku { font-size:11px; margin-left:6px; }
        .cl-rm { position:absolute; top:0; right:0; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:12px; }
        .cl-rm:hover { color:var(--bad); }
        .inv-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow:auto; }
        .inv-modal { width:560px; max-width:96vw; background:var(--surface); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.3); padding:18px; }
        .inv-mhead { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:8px; border-bottom:1px solid var(--line); }
        .inv-msearch { width:100%; }
        .inv-msg { color:#16a34a; margin:8px 0 0; }
        .inv-results { margin-top:10px; max-height:380px; overflow:auto; display:flex; flex-direction:column; gap:6px; }
        .inv-rrow { display:flex; align-items:center; gap:8px; padding:6px 4px; border-bottom:1px solid var(--line); }
        .inv-rname { flex:1 1 auto; font-size:13px; font-weight:500; min-width:0; }
        .inv-rmeta { font-size:11px; display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; font-weight:400; } .inv-rmeta code { font-size:11px; }
        .inv-rqty { width:54px; flex:0 0 auto; }
        .inv-confirmed { font-size:11px; font-weight:700; color:#15803d; background:rgba(22,163,74,.12); border:1px solid rgba(22,163,74,.4); padding:1px 8px; border-radius:999px; }
        .inv-confirm-row { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
        .inv-confirm-btn { background:#16a34a; }
        .inv-confirm-btn:hover { background:#15803d; }
        .inv-confirm-note { font-size:13px; color:#15803d; font-weight:600; display:inline-flex; align-items:center; gap:10px; }
        .inv-undo { font-size:11px; padding:2px 10px; background:var(--chip); color:var(--ink); border:1px solid var(--line); }
        .inv-undo:hover { background:#e2ecf9; }
      `}</style>
    </>
  );
}
