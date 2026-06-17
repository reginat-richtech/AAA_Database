'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '../../_components/blueprint';

function DealsTable({ deals }) {
  if (!deals?.length) return <p className="note">No deals.</p>;
  const hasStage = deals.some((d) => d.stage);
  const hasCreated = deals.some((d) => d.created);
  const hasOverdue = deals.some((d) => d.daysOverdue != null);
  return (
    <div className="tablewrap">
      <table>
        <thead><tr>
          <th>Deal</th><th>Amount</th>
          {hasStage && <th>Stage</th>}
          <th>Close date</th>
          {hasCreated && <th>Created</th>}
          {hasOverdue && <th>Days overdue</th>}
        </tr></thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.amount}</td>
              {hasStage && <td>{d.stage || '—'}</td>}
              <td>{d.close || '—'}</td>
              {hasCreated && <td>{d.created || '—'}</td>}
              {hasOverdue && <td>{d.daysOverdue != null ? `${d.daysOverdue}d` : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoveDetail({ deal }) {
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{deal.name}</div>
      <div>Stage move: <b>{deal.from}</b> → <b>{deal.to}</b></div>
      <div className="note">Amount: {deal.amount}</div>
      {deal.close && <div className="note">Close date: {deal.close}</div>}
      {deal.movedAt && <div className="note">Moved at: {deal.movedAt}</div>}
    </div>
  );
}

function RepDetail({ rep }) {
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>{rep.count} email{rep.count === 1 ? '' : 's'} sent yesterday.</p>
      {rep.ai_summary && <p>{rep.ai_summary}</p>}
      <div className="tablewrap">
        <table>
          <thead><tr><th>Subject</th><th>To</th><th>Summary</th></tr></thead>
          <tbody>
            {(rep.emails || []).map((e, i) => (
              <tr key={i}>
                <td>{e.subject}</td>
                <td>{(e.to || []).join(', ') || '—'}</td>
                <td>{e.summary || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function HubSpotAlertDetail() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id || ''));
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/ai/hubspot')
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Failed to load'); return j; })
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  let title = 'Alert detail';
  let body = null;
  if (data && data.ok !== false) {
    if (id.startsWith('rep_')) {
      const oid = id.slice(4);
      const reps = [...(data.email_activity?.top || []), ...(data.email_activity?.bottom || [])];
      const rep = reps.find((r) => String(r.owner_id) === oid);
      if (rep) { title = `${rep.owner_name} — email activity`; body = <RepDetail rep={rep} />; }
    } else {
      const card = (data.cards || []).find((c) => c.id === id);
      if (card) {
        title = card.title;
        const det = card.detail;
        if (det?.kind === 'move') body = <MoveDetail deal={det.deal} />;
        else if (det?.kind === 'deals') body = <DealsTable deals={det.deals} />;
        else body = <p className="note">{card.msg}</p>;
      }
    }
  }

  return (
    <>
      <PageHeader title="HubSpot AI" sub="Alert detail" sheet="HubSpot AI" />
      <div className="panel">
        <Link href="/hubspot-ai" className="note">← Back to alerts</Link>
        <h2 style={{ marginTop: 10 }}>{title}</h2>
        {loading && <p className="note">Loading…</p>}
        {!loading && err && <p className="error">{err}</p>}
        {!loading && !err && !body && (
          <p className="note">Alert not found — it may have changed since you opened it. <Link href="/hubspot-ai">Back to alerts</Link>.</p>
        )}
        {body}
      </div>
    </>
  );
}
