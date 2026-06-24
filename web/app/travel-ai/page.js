'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';
import ChatAssistant from '../_components/ChatAssistant';
import { getAi, peekAi, setAi } from '../../lib/aiCache';

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const typeIcon = (t) => (t === 'FLIGHT + HOTEL' ? '✈️🏨' : t === 'HOTEL' ? '🏨' : t === 'FLIGHT' ? '✈️' : '•');
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function TripFlags({ f }) {
  return (
    <>
      {f.overBudget && <span className="tf" title="Over budget">🔴</span>}
      {f.weekend && <span className="tf" title="Weekend travel">🚩</span>}
      {f.earlyLate && <span className="tf" title="Early / late flight vs TRF">⏰</span>}
      {f.matchedTRF && <span className="tf" title="Matched TRF">✅</span>}
      {f.noTRF && <span className="tf" title="No TRF match">❌</span>}
    </>
  );
}

export default function TravelAI() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState({});       // traveler name -> expanded?
  const [detail, setDetail] = useState(null); // trip selected for the modal

  const endpoint = `/api/ai/travel?days=${days}`;
  const load = useCallback((force = false) => {
    setErr(null);
    if (force) {
      // Option B: re-pull from Navan into the DB, then recompute.
      setLoading(true);
      fetch(endpoint + '&sync=1')
        .then((r) => r.json())
        .then((d) => { setData(d); setAi(endpoint, d); if (d && d.ok === false) setErr(d.error || 'Unavailable'); })
        .catch((e) => setErr(String(e?.message || e)))
        .finally(() => setLoading(false));
      return;
    }
    const cached = peekAi(endpoint);
    if (cached != null) { setData(cached); setLoading(false); } else { setLoading(true); }
    getAi(endpoint)
      .then((d) => { setData(d); if (d && d.ok === false) setErr(d.error || 'Unavailable'); })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [endpoint]);
  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const s = data && data.ok !== false ? data.summary : null;
  const travelers = (data && data.travelers) || [];
  const today = new Date().toISOString().slice(0, 10); // trips with start_date ≤ today = past (green), else future (blue)

  return (
    <>
      <PageHeader title="Travel AI" sub="Navan bookings — flagged trips, traveler spend, and budget/TRF compliance." sheet="Travel AI" />
      <div className="split">
        <section className="panel">
          <div className="panel-title">
            <h2>Travel Expense Review{data?.count != null && <span className="chip bad" style={{ marginLeft: 8 }}>{data.count}</span>}</h2>
            <button className="secondary" onClick={() => load(true)} disabled={loading} title="Pull fresh from Navan, then recompute">{loading ? '…' : '↻'}</button>
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
                {' '}{s.overBudget} over budget, {s.weekend} over a weekend
                {data.trfConnected ? <>, <b>{s.noTRF}</b> with no matching Travel Request Form.</> : '.'}
              </p>

              <div className="flag-head">
                {s.flaggedCount} trip{s.flaggedCount === 1 ? '' : 's'} need review
                <span className="note"> · {money(s.flaggedSpend)} · Last {data.days} Days</span>
              </div>

              {travelers.length === 0 && <p className="note">Nothing needs review in this window 🎉</p>}

              <div className="trv-list">
                {travelers.map((t) => {
                  const isOpen = !!open[t.name];
                  return (
                    <div className="trv-person" key={t.name}>
                      <button className="trv-person-row" onClick={() => setOpen((o) => ({ ...o, [t.name]: !o[t.name] }))} aria-expanded={isOpen}>
                        <span className="trv-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="trv-name">{t.name}</span>
                        <span className="trv-chips">
                          {t.counts.over > 0 && <span className="pf">🔴 {t.counts.over}</span>}
                          {t.counts.weekend > 0 && <span className="pf">🚩 {t.counts.weekend}</span>}
                          {t.counts.early > 0 && <span className="pf">⏰ {t.counts.early}</span>}
                          {t.counts.noTRF > 0 && <span className="pf">❌ {t.counts.noTRF}</span>}
                        </span>
                        <span className="trv-total">{money(t.total)}</span>
                      </button>
                      {isOpen && (
                        <div className="trv-trips">
                          {t.trips.map((tr) => (
                            <button className={`trv-trip ${tr.startDate ? (tr.startDate <= today ? 'past' : 'future') : ''}`} key={tr.id} onClick={() => setDetail(tr)} title={tr.startDate && tr.startDate > today ? 'Upcoming trip' : 'Already traveled'}>
                              <span className="trv-type">{typeIcon(tr.type)}</span>
                              <span className="trv-route">
                                <span className="trv-dest">{tr.route}</span>
                                <span className="trv-tripflags"><TripFlags f={tr.flags} /></span>
                              </span>
                              <span className="trv-amt">{money(tr.amount)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="trv-legend">
                <div className="tlg"><span className="tlg-h">Type</span>
                  <span className="tlg-i">✈️ Flight</span><span className="tlg-i">🏨 Hotel</span><span className="tlg-i">✈️🏨 Flight + Hotel</span>
                </div>
                <div className="tlg"><span className="tlg-h">Flags</span>
                  <span className="tlg-i">🔴 Over budget</span>
                  <span className="tlg-i">🚩 Weekend travel</span>
                  <span className="tlg-i">✅ Matched TRF</span>
                  <span className="tlg-i">⏰ Early / late flight</span>
                  <span className="tlg-i">❌ No TRF match</span>
                </div>
                <div className="tlg"><span className="tlg-h">Timing</span>
                  <span className="tlg-i"><b style={{ color: 'var(--ok)' }}>● green</b> = already traveled</span>
                  <span className="tlg-i"><b style={{ color: 'var(--info)' }}>● blue</b> = upcoming</span>
                </div>
                <p className="note" style={{ margin: '2px 0 0', fontSize: 11.5 }}>
                  Flight &gt; $500 round-trip / $250 one-way · Hotel &gt; $200/night · TRF = Travel Request Form (JotForm){data.trfConnected ? '' : ' — not connected, so ✅/⏰/❌ are hidden'}
                </p>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-title"><h2>AI chat</h2><span className="meta">Bookings · per-diem · spend</span></div>
          <ChatAssistant domain="travel" scope="Bookings · per-diem · spend" />
        </section>
      </div>

      {detail && (
        <div className="trv-modal-bg" onClick={() => setDetail(null)}>
          <div className="trv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trv-modal-head">
              <span style={{ fontSize: 20 }}>{typeIcon(detail.type)}</span>
              <div style={{ minWidth: 0 }}>
                <div className="trv-modal-name">{detail.traveler}</div>
                <div className="note" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail.route}</div>
              </div>
              <button className="trv-modal-x" onClick={() => setDetail(null)} aria-label="Close">×</button>
            </div>
            <div className="trv-modal-grid">
              <div><span className="k">Type</span><span className="v">{detail.type}</span></div>
              <div><span className="k">Amount</span><span className="v" style={{ color: 'var(--primary)' }}>{money(detail.amount)}</span></div>
              <div><span className="k">Start</span><span className="v">{fmtDate(detail.startDate)}</span></div>
              <div><span className="k">End</span><span className="v">{fmtDate(detail.endDate)}</span></div>
              {detail.vendor && <div><span className="k">Vendor</span><span className="v">{detail.vendor}</span></div>}
              {detail.tripType && <div><span className="k">Trip type</span><span className="v">{detail.tripType.replace('_', ' ')}</span></div>}
              {detail.dailyRate != null && <div><span className="k">Hotel / night</span><span className="v">{money(detail.dailyRate)}</span></div>}
              {detail.type === 'FLIGHT + HOTEL' && <div><span className="k">Flight / Hotel</span><span className="v">{money(detail.flightAmount)} / {money(detail.hotelAmount)}</span></div>}
            </div>
            <div className="trv-modal-flags">
              {detail.flags.overBudget && <span className="cf">🔴 Over budget{detail.type === 'FLIGHT' ? ` (> ${detail.tripType === 'ONE_WAY' ? '$250 OW' : '$500 RT'})` : detail.type === 'HOTEL' ? ' (> $200/night)' : ''}</span>}
              {detail.flags.weekend && <span className="cf">🚩 Weekend travel</span>}
              {detail.flags.earlyLate && <span className="cf">⏰ {detail.matchNote || 'Early / late flight'}</span>}
              {detail.flags.matchedTRF && <span className="cf">✅ Matched TRF</span>}
              {detail.flags.noTRF && <span className="cf">❌ No TRF match</span>}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .seg { display:inline-flex; gap:4px; background:var(--chip); border:1px solid var(--line); border-radius:8px; padding:3px; margin-bottom:10px; }
        .seg button { background:transparent; color:var(--muted); border:0; padding:5px 12px; border-radius:6px; font-size:13px; font-weight:600; }
        .seg button.on { background:var(--primary); color:#fff; }
        .flag-head { color:var(--bad); font-weight:700; font-size:13.5px; margin:16px 0 8px; border-top:1px dashed var(--line); padding-top:12px; }
        .flag-head .note { font-weight:400; }
        .trv-list { display:flex; flex-direction:column; gap:8px; }
        .trv-person { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--surface); }
        .trv-person-row { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; background:none; border:0; cursor:pointer; text-align:left; color:var(--ink); font:inherit; }
        .trv-person-row:hover { background:var(--chip); }
        .trv-caret { font-size:11px; color:var(--muted); flex:0 0 auto; width:10px; }
        .trv-name { font-weight:700; font-size:13.5px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .trv-chips { display:flex; gap:5px; flex:0 0 auto; flex-wrap:wrap; justify-content:flex-end; }
        .pf { font-family:var(--font-mono); font-size:11px; font-weight:700; padding:1px 6px; border-radius:6px; border:1px solid var(--line); background:var(--chip); white-space:nowrap; }
        .trv-total { font-family:var(--font-mono); font-weight:700; font-size:13px; color:var(--primary); min-width:72px; text-align:right; flex:0 0 auto; }
        .trv-trips { border-top:1px solid var(--line); padding:6px; display:flex; flex-direction:column; gap:5px; background:var(--bg); }
        .trv-trip { display:flex; align-items:center; gap:10px; width:100%; padding:8px 10px; border:1px solid var(--line); border-left:3px solid var(--line); border-radius:8px; background:var(--surface); cursor:pointer; text-align:left; color:var(--ink); font:inherit; }
        .trv-trip.past   { border-left-color:var(--ok);   background:#f0fdf4; }   /* already traveled → green */
        .trv-trip.past:hover { background:#dcfce7; }
        .trv-trip.future { border-left-color:var(--info); background:#eff6ff; }   /* upcoming → blue */
        .trv-trip.future:hover { background:#dbeafe; }
        .trv-trip:hover { border-top-color:var(--primary); border-right-color:var(--primary); border-bottom-color:var(--primary); }
        .trv-type { font-size:14px; flex:0 0 auto; }
        .trv-route { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
        .trv-dest { font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .trv-tripflags { display:flex; gap:3px; }
        .trv-tripflags .tf { font-size:11px; }
        .trv-amt { font-family:var(--font-mono); font-weight:700; font-size:12.5px; color:var(--primary); flex:0 0 auto; }
        .trv-legend { margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); display:flex; flex-direction:column; gap:8px; }
        .tlg { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; }
        .tlg-h { font-family:var(--font-mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-right:4px; }
        .tlg-i { font-size:12.5px; color:var(--ink); }
        .trv-modal-bg { position:fixed; inset:0; background:rgba(16,40,70,.45); display:flex; align-items:center; justify-content:center; z-index:100; padding:20px; }
        .trv-modal { background:var(--surface); border-radius:14px; box-shadow:var(--shadow); width:100%; max-width:440px; padding:18px 20px; }
        .trv-modal-head { display:flex; align-items:flex-start; gap:12px; margin-bottom:14px; }
        .trv-modal-name { font-family:var(--font-head); font-weight:700; font-size:16px; }
        .trv-modal-x { margin-left:auto; display:flex; align-items:center; justify-content:center; background:transparent; border:1px solid var(--line); border-radius:7px; width:28px; height:28px; cursor:pointer; color:var(--muted); font-size:20px; line-height:1; flex:0 0 auto; }
        .trv-modal-x:hover { background:var(--chip); color:var(--ink); }
        .trv-modal-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; }
        .trv-modal-grid > div { display:flex; flex-direction:column; }
        .trv-modal-grid .k { font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
        .trv-modal-grid .v { font-size:13.5px; font-weight:600; }
        .trv-modal-flags { display:flex; flex-wrap:wrap; gap:6px; margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
        .trv-modal-flags .cf { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); background:var(--chip); }
      `}</style>
    </>
  );
}
