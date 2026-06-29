'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '../_components/blueprint';
import ShipmentForm from '../_components/ShipmentForm';

export default function Shipping() {
  const [data, setData] = useState({ canEdit: false, projects: [] });
  const load = () => fetch('/api/shipping').then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const { canEdit, projects = [] } = data;

  return (
    <>
      <PageHeader title="Shipping" sub="Projects whose inventory has been checked out, ready to ship. Recipient & address autofill from the agreement/proposal — add carrier, tracking and an estimate." sheet="Shipping" />

      <div className="toolbar">
        {!canEdit && <span className="note">View only — admins / inventory team can edit.</span>}
        <span className="note" style={{ marginLeft: 'auto' }}>{projects.length} to ship</span>
      </div>

      {projects.length === 0 && (
        <div className="panel"><p className="note" style={{ margin: 0 }}>Nothing to ship yet — a project appears here once its inventory is <b>checked out</b> on the Inventory page.</p></div>
      )}

      {projects.map((p) => (
        <div className="panel ship-card" key={p.id} style={{ marginBottom: 12 }}>
          <div className="ship-formhead" style={{ marginBottom: 10 }}>
            <span className="ship-pchip" style={{ fontWeight: 700, fontSize: 11, background: '#0f172a', color: '#fff', padding: '1px 8px', borderRadius: 999 }}>{p.project_number}</span>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{p.title || p.counterparty || 'Project'}</span>
          </div>
          <ShipmentForm project={p} canEdit={canEdit} onSaved={load} title="📦 Shipment" />
        </div>
      ))}
    </>
  );
}
