'use client';
import { useState } from 'react';

const STATUS = ['pending', 'shipped', 'delivered'];
const STATUS_LABEL = { pending: 'Pending', shipped: 'Shipped', delivered: 'Delivered' };

function seed(project) {
  const s = project.shipment || {};
  const a = project.autofill || {};
  return {
    recipient_name: s.recipient_name ?? a.recipient_name ?? '',
    recipient_email: s.recipient_email ?? a.recipient_email ?? '',
    recipient_phone: s.recipient_phone ?? a.recipient_phone ?? '',
    address: s.address ?? a.address ?? '',
    carrier: s.carrier ?? '',
    tracking_number: s.tracking_number ?? '',
    est_cost: s.est_cost ?? '',
    est_ship_date: s.est_ship_date ? String(s.est_ship_date).slice(0, 10) : '',
    est_delivery_date: s.est_delivery_date ? String(s.est_delivery_date).slice(0, 10) : '',
    status: s.status ?? 'pending',
    notes: s.notes ?? '',
    shipping_needed: s.shipping_needed ?? true,
  };
}

// One project's shipment form. Used both on /shipping and inline on /inventory.
// `project` carries { id, shipment, autofill }; saves via PATCH /api/shipping.
export default function ShipmentForm({ project, canEdit, onSaved, title = '📦 Shipping' }) {
  const [f, setF] = useState(() => seed(project));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { text } | { err }
  const set = (k, v) => setF((m) => ({ ...m, [k]: v }));
  const st = f.status || 'pending';

  async function save() {
    setBusy(true); setMsg(null);
    const res = await fetch('/api/shipping', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, ...f }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setMsg({ text: '✓ Shipment saved' }); onSaved?.(); }
    else setMsg({ err: j.error || 'Save failed' });
  }
  function autofill() {
    const a = project.autofill || {};
    setF((m) => ({ ...m, recipient_name: a.recipient_name || '', recipient_email: a.recipient_email || '', recipient_phone: a.recipient_phone || '', address: a.address || '' }));
  }

  return (
    <div className="ship-form">
      <div className="ship-formhead">
        <span className="ship-formtitle">{title}</span>
        <span className={`ship-status s-${st}`}>{STATUS_LABEL[st]}</span>
      </div>
      {msg && <p className="note" style={{ color: msg.err ? '#dc2626' : '#16a34a', margin: '0 0 8px' }}>{msg.err || msg.text}</p>}
      <label className="ship-mode">
        <input type="checkbox" checked={!f.shipping_needed} disabled={!canEdit} onChange={(e) => set('shipping_needed', !e.target.checked)} />
        No shipping needed (on-site install / customer pickup) — no carrier or tracking
      </label>
      <div className="ship-grid">
        <label>Recipient<input value={f.recipient_name} disabled={!canEdit} onChange={(e) => set('recipient_name', e.target.value)} /></label>
        <label>Email<input value={f.recipient_email} disabled={!canEdit} onChange={(e) => set('recipient_email', e.target.value)} /></label>
        <label>Phone<input value={f.recipient_phone} disabled={!canEdit} onChange={(e) => set('recipient_phone', e.target.value)} /></label>
        <label>Status<select value={st} disabled={!canEdit} onChange={(e) => set('status', e.target.value)}>{STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
        <label className="ship-wide">{f.shipping_needed ? 'Shipping address' : 'Site / delivery address'} {canEdit && <button className="ship-auto" type="button" onClick={autofill}>↻ autofill from project</button>}<textarea rows={3} value={f.address} disabled={!canEdit} onChange={(e) => set('address', e.target.value)} /></label>
        {f.shipping_needed && <label>Carrier<input value={f.carrier} disabled={!canEdit} placeholder="UPS, FedEx…" onChange={(e) => set('carrier', e.target.value)} /></label>}
        {f.shipping_needed && <label>Tracking #<input value={f.tracking_number} disabled={!canEdit} onChange={(e) => set('tracking_number', e.target.value)} /></label>}
        {f.shipping_needed && <label>Est. cost (USD)<input type="number" step="0.01" value={f.est_cost} disabled={!canEdit} onChange={(e) => set('est_cost', e.target.value)} /></label>}
        {f.shipping_needed && <label>Ship date<input type="date" value={f.est_ship_date} disabled={!canEdit} onChange={(e) => set('est_ship_date', e.target.value)} /></label>}
        <label>Est. arrival date<input type="date" value={f.est_delivery_date} disabled={!canEdit} onChange={(e) => set('est_delivery_date', e.target.value)} /></label>
        <label className="ship-wide">Notes<textarea rows={2} value={f.notes} disabled={!canEdit} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      {canEdit && <div style={{ marginTop: 10 }}><button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save shipment'}</button></div>}
    </div>
  );
}
