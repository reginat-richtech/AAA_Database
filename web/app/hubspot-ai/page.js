'use client';
import Link from 'next/link';
import AiTab from '../_components/AiTab';

function renderLeft(data) {
  const cards = data.cards || [];
  const b = data.brief;
  const ea = data.email_activity;
  const reps = ea ? [
    ...(ea.top || []).map((p) => ({ ...p, rank: 'top' })),
    ...(ea.bottom || []).map((p) => ({ ...p, rank: 'low' })),
  ] : [];

  return (
    <>
      {b && (
        <p className="note" style={{ marginTop: 0 }}>
          {b.newDeals} new this week · {b.stageMoves} stage move{b.stageMoves === 1 ? '' : 's'} · {b.overdue} overdue
        </p>
      )}

      {cards.length ? (
        <div className="alert-list">
          {cards.map((c) => (
            <Link href={`/hubspot-ai/${c.id}`} className={`alert-row sev-${c.sev}`} key={c.id}>
              <span className="act-ic" aria-hidden="true">{c.icon}</span>
              <span className="alert-title">{c.title}</span>
              <span className="alert-go" aria-hidden="true">›</span>
            </Link>
          ))}
        </div>
      ) : <p className="note">No HubSpot deal activity to review right now 🎉</p>}

      {reps.length > 0 && (
        <>
          <h3 className="email-h">
            Email activity — yesterday{' '}
            <span className="note" style={{ fontWeight: 400 }}>({ea.total_emails_yesterday} sent · {ea.total_pms_active} rep{ea.total_pms_active === 1 ? '' : 's'})</span>
          </h3>
          <div className="alert-list">
            {reps.map((pm) => (
              <Link href={`/hubspot-ai/rep_${pm.owner_id}`} className={`alert-row sev-${pm.rank === 'top' ? 'ok' : 'warn'}`} key={pm.owner_id}>
                <span className="act-ic" aria-hidden="true">{pm.rank === 'top' ? '📈' : '📉'}</span>
                <span className="alert-title">{pm.owner_name}</span>
                <span className="chip">{pm.count} sent</span>
                <span className="alert-go" aria-hidden="true">›</span>
              </Link>
            ))}
          </div>
        </>
      )}

      <style>{`
        .alert-list { display: flex; flex-direction: column; gap: 8px; }
        .alert-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-left-width: 4px; border-radius: 9px; background: var(--surface); color: var(--ink); text-decoration: none; }
        .alert-row:hover { border-color: var(--primary); background: var(--chip); text-decoration: none; }
        .alert-row.sev-fail { border-left-color: var(--bad); }
        .alert-row.sev-warn { border-left-color: var(--warn); }
        .alert-row.sev-info { border-left-color: var(--info); }
        .alert-row.sev-ok   { border-left-color: var(--ok); }
        .alert-row .act-ic { font-size: 16px; flex: 0 0 auto; }
        .alert-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .alert-go { color: var(--muted); font-size: 18px; flex: 0 0 auto; }
        .email-h { margin: 18px 0 10px; border-top: 1px dashed var(--line); padding-top: 14px; }
      `}</style>
    </>
  );
}

export default function HubSpotAI() {
  return (
    <AiTab
      title="HubSpot AI"
      sub="Activity alerts — click any alert for the full detail."
      sheet="HubSpot AI"
      endpoint="/api/ai/hubspot"
      chatScope="Deals · pipeline · CRM · email"
      renderLeft={renderLeft}
    />
  );
}
