'use client';
import AiTab from '../_components/AiTab';

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const BUCKET = {
  current: { label: 'Current', color: 'var(--ok)' },
  '1-30': { label: '1–30 d', color: '#f59e0b' },
  '31-60': { label: '31–60 d', color: '#f97316' },
  '61-90': { label: '61–90 d', color: '#ef4444' },
  '90+': { label: '90+ d', color: 'var(--bad)' },
};

function renderLeft(data) {
  const b = data.brief || {};
  const aging = data.aging || [];
  const cards = data.cards || [];
  if (!b.invoices) return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>No QuickBooks invoices yet. Connect your QuickBooks company, then run a sync.</p>
      <a className="btnlink" href="/api/quickbooks/connect">Connect QuickBooks</a>
    </div>
  );
  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>
        <b>{b.open}</b> open invoice{b.open === 1 ? '' : 's'} · <b>{money(b.outstanding)}</b> outstanding · <b>{b.overdue}</b> overdue (<b>{money(b.overdueAmt)}</b>).
      </p>

      <div className="ar-aging">
        {aging.map((a) => (
          <div className="ar-cell" key={a.bucket} style={{ borderTopColor: (BUCKET[a.bucket] || {}).color }}>
            <div className="ar-amt">{money(a.amount)}</div>
            <div className="ar-lbl">{(BUCKET[a.bucket] || {}).label || a.bucket} · {a.count}</div>
          </div>
        ))}
      </div>

      {cards.length ? (
        <div className="alert-list">
          {cards.map((c) => (
            <div className={`alert-row sev-${c.sev}`} key={c.id}>
              <span className="act-ic" aria-hidden="true">{c.icon}</span>
              <span className="alert-title">{c.title}<span className="alert-sub">{c.detail}</span></span>
              <span className="alert-amt">{money(c.amount)}</span>
            </div>
          ))}
        </div>
      ) : <p className="note">No overdue invoices 🎉</p>}

      <div className="sev-legend">
        <span><i className="d fail" /> Critical (60+ days)</span>
        <span><i className="d warn" /> Warning (1–60 days)</span>
        <span><i className="d info" /> Info</span>
        <span><i className="d ok" /> OK</span>
      </div>

      <style>{`
        .ar-aging { display:flex; gap:8px; flex-wrap:wrap; margin:4px 0 16px; }
        .ar-cell { flex:1; min-width:84px; border:1px solid var(--line); border-top:3px solid var(--line); border-radius:9px; padding:8px 10px; background:var(--surface); }
        .ar-amt { font-family:var(--font-mono); font-weight:700; font-size:15px; }
        .ar-lbl { font-size:11px; color:var(--muted); margin-top:2px; }
        .alert-list { display:flex; flex-direction:column; gap:8px; }
        .alert-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-left-width:4px; border-radius:9px; background:var(--surface); }
        .alert-row.sev-fail { border-left-color:var(--bad); }
        .alert-row.sev-warn { border-left-color:var(--warn); }
        .alert-row.sev-info { border-left-color:var(--info); }
        .alert-row.sev-ok   { border-left-color:var(--ok); }
        .alert-row .act-ic { font-size:16px; flex:0 0 auto; }
        .alert-title { font-weight:600; flex:1; min-width:0; }
        .alert-sub { display:block; font-weight:400; font-size:12px; color:var(--muted); }
        .alert-amt { font-family:var(--font-mono); font-weight:700; flex:0 0 auto; }
        .sev-legend { display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; margin-top:16px; padding-top:12px; border-top:1px dashed var(--line); font-size:12.5px; color:var(--muted); }
        .sev-legend .d { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:middle; }
        .sev-legend .d.fail { background:var(--bad); } .sev-legend .d.warn { background:var(--warn); } .sev-legend .d.info { background:var(--info); } .sev-legend .d.ok { background:var(--ok); }
      `}</style>
    </>
  );
}

export default function FinanceAI() {
  return (
    <AiTab
      title="Finance AI"
      sub="QuickBooks receivables — open & overdue invoices and A/R aging."
      sheet="Finance AI"
      endpoint="/api/ai/finance"
      chatScope="Invoices · expenses · P&L"
      domain="finance"
      renderLeft={renderLeft}
    />
  );
}
