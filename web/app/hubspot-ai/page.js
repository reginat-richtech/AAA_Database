'use client';
import AiTab from '../_components/AiTab';

const SEV = { fail: 'var(--bad)', warn: 'var(--warn)', info: 'var(--info)' };

function renderLeft(data) {
  const b = data.brief;
  const ctx = b ? (
    <p className="note" style={{ marginTop: 0 }}>
      {b.openDeals} open deals · {b.recentlyOverdue} overdue (last {b.overdueWindowDays}d) · {b.closingSoon} closing this week
      {b.totalOverdue > b.recentlyOverdue ? ` · ${b.totalOverdue} overdue all-time (older deals not flagged)` : ''}
    </p>
  ) : null;
  if (!data.alerts || !data.alerts.length) {
    return <>{ctx}<p className="note">No deals need attention right now 🎉</p></>;
  }
  return (
    <>
      {ctx}
      <div className="attn">
        {data.alerts.map((a, i) => (
          <div className="attn-row" key={i}>
            <div className="attn-bar" style={{ background: SEV[a.sev] }} />
            <div className="attn-bd">
              <div className="attn-t">{a.title} — {a.deal}{a.amount != null ? ` · $${a.amount.toLocaleString()}` : ''}</div>
              <div className="attn-d">{a.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default function HubSpotAI() {
  return (
    <AiTab
      title="HubSpot AI"
      sub="Deal intelligence — overdue, closing-soon, and stalled deals from your live HubSpot pipeline."
      sheet="HubSpot AI"
      endpoint="/api/ai/hubspot"
      chatScope="Deals · pipeline · CRM"
      renderLeft={renderLeft}
    />
  );
}
