'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();

export default function TravelAI() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    fetch(`/api/ai/travel?days=${days}`)
      .then((r) => r.json())
      .then((d) => { setData(d); if (d && d.ok === false) setErr(d.error || 'Unavailable'); })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const s = data && data.ok !== false ? data.summary : null;

  return (
    <>
      <PageHeader title="Travel AI" sub="Navan bookings — flagged trips, traveler spend, and budget compliance." sheet="Travel AI" />
      <div className="split">
        <section className="panel">
          <div className="panel-title">
            <h2>Travel Expense Review{data?.count != null && <span className="chip bad" style={{ marginLeft: 8 }}>{data.count}</span>}</h2>
            <button className="secondary" onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
          </div>

          <div className="seg">
            <button className={days === 7 ? 'on' : ''} onClick={() => setDays(7)}>Last 7 Days</button>
            <button className={days === 30 ? 'on' : ''} onClick={() => setDays(30)}>Last 30 Days</button>
          </div>

          {loading && <p className="note">Loading…</p>}
          {!loading && err && <p className="error">{err}</p>}
          {!loading && !err && s && (
            <>
              <h3 style={{ marginBottom: 4 }}>Executive brief</h3>
              <p className="note" style={{ marginTop: 0 }}>
                In the last {data.days} days there were <b>{s.trips} trips</b> totaling <b>{money(s.totalSpend)}</b>.
                {' '}{s.flights.count} flights (avg {money(s.flights.avg)}) and {s.hotels.count} hotel stays (avg {money(s.hotels.avgPerNight)}/night).
                {' '}{s.overBudget} over budget, {s.weekend} over a weekend.
              </p>

              <div className="flag-head">
                {s.flaggedCount} flagged trip{s.flaggedCount === 1 ? '' : 's'} need review
                <span className="note"> · {money(s.flaggedSpend)} · Last {data.days} Days</span>
              </div>

              {data.travelers.length === 0 && <p className="note">No bookings in this window.</p>}
              <div className="travelers">
                {data.travelers.map((t, i) => (
                  <div className="trow" key={i}>
                    <span className="tname">{t.name}</span>
                    <span className="tflags">
                      {t.flights > 0 && <span className="tflag" title="flights">✈ {t.flights}</span>}
                      {t.hotels > 0 && <span className="tflag" title="hotel stays">🏨 {t.hotels}</span>}
                      {t.flagged > 0 && <span className="tflag bad" title="flagged bookings">⚑ {t.flagged}</span>}
                    </span>
                    <span className="tamt">{money(t.spend)}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 13, color: 'var(--muted)' }}>
                  <span><span aria-hidden="true">✈</span> flights</span>
                  <span><span aria-hidden="true">🏨</span> hotel stays</span>
                  <span style={{ color: 'var(--bad)' }}><span aria-hidden="true">⚑</span> flagged — needs review</span>
                </div>
                <p className="note" style={{ margin: '6px 0 0' }}>
                  <b>Flagged</b> = over budget <i>or</i> weekend travel. Budget limits: flights <b>$500</b> round-trip / <b>$250</b> one-way · hotels <b>$200</b>/night.
                </p>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-title"><h2>AI chat</h2><span className="meta">Bookings · per-diem · spend</span></div>
          <div className="chat-soon note">
            💬 The Travel AI conversational agent is the next phase.<br />
            The review on the left is <b>live data</b> from Navan.
          </div>
        </section>
      </div>
    </>
  );
}
