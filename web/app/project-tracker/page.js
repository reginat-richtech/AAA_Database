'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { PageHeader, StageRail, ProjectRail, STAGES, STAGE_RAMP } from '../_components/blueprint';

const LEAF_ICON = { done: '✓', pending: '○', manual: '·' };

// Node dot styling for the expanded tree. Solid fill for done/current, hollow
// for pending, dashed for reference — no translucent ring (it rendered as a
// half-cut / double circle at this small size).
function dotStyle(node, color) {
  if (node.status === 'done' || node.status === 'current') return { background: color, borderColor: color };
  if (node.status === 'manual') return { background: '#fff', borderColor: color, borderStyle: 'dashed' };
  return { background: '#fff', borderColor: 'var(--line)' };
}

export default function ProjectTracker() {
  const [data, setData] = useState({ stages: [], projects: [], counts: {} });
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'installation' | 'event'
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { pid, text, err }
  const [confirmReq, setConfirmReq] = useState(null); // { p, t } — approval awaiting confirmation
  const [dealPicker, setDealPicker] = useState(null); // proposal_id whose HubSpot deal-picker is open
  const [dealQ, setDealQ] = useState('');
  const [dealResults, setDealResults] = useState([]);
  const [invPicker, setInvPicker] = useState(null); // project id whose invoice-picker is open
  const [invQ, setInvQ] = useState('');
  const [invResults, setInvResults] = useState([]);
  const [invQbConnected, setInvQbConnected] = useState(false);
  const invTimer = useRef(null);

  const refresh = () => fetch('/api/project-tracker/projects').then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => { refresh(); }, []);

  // Deep link: /project-tracker?open=<projectId> (e.g. from an Invoice) auto-opens
  // and scrolls to that project card once data has loaded.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !data.projects.length) return;
    const id = new URLSearchParams(window.location.search).get('open');
    if (!id) { deepLinked.current = true; return; }
    setOpen(id);
    const el = document.getElementById(`proj-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    deepLinked.current = true;
  }, [data.projects.length]);

  // Mark / un-mark one Team-Preparation step (manager of that dept, or admin).
  async function markPrep(p, t) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/project-tracker/prep', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p.id, prep_key: t.prep_key, done: t.status !== 'done' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ pid: p.id, err: j.error || `Failed (HTTP ${r.status})` });
      else { await refresh(); setMsg({ pid: p.id, text: `${t.label}: ${j.step?.done ? 'marked done' : 'reopened'}.` }); }
    } finally { setBusy(false); }
  }

  // Send the Technician Confirmation form once prep is done (calendar skipped).
  async function sendConfirmation(p) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/project-tracker/confirmation-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ pid: p.id, err: j.error || `Failed (HTTP ${r.status})` }); return; }
      const n = j.notify || {};
      const note = n.sent ? `emailed to ${n.to}` : n.error ? `email error: ${n.error}`
        : n.skipped ? `email skipped (${n.skipped}) — use “open form”` : 'sent';
      setMsg({ pid: p.id, text: `Technician Confirmation form: ${note}.` });
    } finally { setBusy(false); }
  }

  // HubSpot deal picker (Step 1): search synced deals; connect/unlink pulls the
  // deal's customer from HubSpot server-side.
  async function loadDeals(qstr) {
    setDealQ(qstr);
    const r = await fetch(`/api/hubspot/deals?q=${encodeURIComponent(qstr)}`);
    const d = await r.json().catch(() => ({}));
    setDealResults(d.deals || []);
  }
  function openDealPicker(proposalId) { setDealPicker(proposalId); setDealResults([]); loadDeals(''); }
  async function connectDeal(p, dealId) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/project-tracker/connect-deal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: p.proposal_id, deal_id: dealId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ pid: p.id, err: j.error || `Failed (HTTP ${r.status})` }); return; }
      setDealPicker(null); await refresh();
      const cust = j.deal?.customer?.company?.name;
      setMsg({ pid: p.id, text: dealId ? `Linked deal "${j.deal?.name || dealId}"${cust ? ` · pulled customer ${cust}` : ''}.` : 'Deal unlinked.' });
    } finally { setBusy(false); }
  }

  // Connect an EXISTING invoice to this project (QuickBooks Invoice stage). The picker
  // lists BOTH the app's invoices AND live QuickBooks invoices; connecting a QB one
  // imports it into ops.invoice. Search hits the QB API, so it's debounced.
  async function fetchInvoices(qstr) {
    const r = await fetch(`/api/project-tracker/connect-invoice?q=${encodeURIComponent(qstr)}`);
    const d = await r.json().catch(() => ({}));
    setInvResults(d.invoices || []);
    setInvQbConnected(!!d.qb_connected);
  }
  function loadInvoices(qstr) {
    setInvQ(qstr);
    clearTimeout(invTimer.current);
    invTimer.current = setTimeout(() => fetchInvoices(qstr), 300);
  }
  function openInvPicker(projectId) { setInvPicker(projectId); setInvResults([]); setInvQ(''); fetchInvoices(''); }
  async function postConnect(p, payload, okMsg) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/project-tracker/connect-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ pid: p.id, err: j.error || `Failed (HTTP ${r.status})` }); return; }
      setInvPicker(null); await refresh();
      setMsg({ pid: p.id, text: okMsg });
    } finally { setBusy(false); }
  }
  // iv = a picker row (source 'app' | 'quickbooks').
  const connectInvoice = (p, iv) => postConnect(
    p,
    iv.source === 'quickbooks' ? { project_id: p.id, qb_invoice_id: iv.qb_invoice_id } : { project_id: p.id, invoice_id: iv.id },
    iv.source === 'quickbooks' ? `Imported ${iv.number || 'QB invoice'} from QuickBooks & connected.` : 'Invoice connected.',
  );
  const unlinkInvoice = (p, invoiceId) => postConnect(p, { project_id: null, invoice_id: invoiceId }, 'Invoice unlinked.');

  const typeOf = (p) => p.type || 'installation';
  const typeCounts = data.projects.reduce((m, p) => { const t = typeOf(p); m[t] = (m[t] || 0) + 1; return m; }, {});
  const matchesSearch = (p) => {
    if (!q) return true;
    const hay = `${p.project_number} ${p.contract_number} ${p.counterparty} ${p.salesman_name} ${p.so_number} ${p.robot_types}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  };
  const typeFiltered = data.projects.filter((p) => typeFilter === 'all' || typeOf(p) === typeFilter);
  const projects = typeFiltered.filter(matchesSearch);
  // Rail reflects the active type filter (not the search box) so the overview matches the view.
  const railCounts = {};
  for (const s of STAGES) railCounts[s.key] = 0;
  for (const p of typeFiltered) railCounts[p.stage_key] = (railCounts[p.stage_key] || 0) + 1;
  railCounts.invoice = typeFiltered.filter((p) => (p.invoices || []).length > 0).length;
  const railProposalLabel = typeFilter === 'event' ? 'Event Rental Form'
    : typeFilter === 'installation' ? 'Project Proposal Form' : 'Proposal / Event Form';
  const railStages = STAGES.map((s) => (s.key === 'proposal' ? { ...s, label: railProposalLabel } : s));
  const TYPE_TABS = [['all', 'All'], ['installation', 'Full Installation'], ['event', 'Event / Rental']];

  return (
    <>
      <PageHeader title="Project Tracker" sub="Read-only workflow tree per project. Each project starts from its entry form — Project Proposal (Full Installation) or Event Rental (Event) — then advances through 9 stages as its agreement, tech request, approval, and confirmation steps complete." sheet="Project Tracker" />

      <section className="panel">
        <div className="panel-title"><h2>Project process tracker</h2><span className="meta">9 stages</span></div>
        <StageRail stages={railStages} counts={railCounts} />
        <div className="rail-legend">
          <span><i className="done" /> done</span>
          <span><i className="next" /> next action</span>
          <span><i className="ref" /> reference stage</span>
          <span><i className="pend" /> pending</span>
          <span className="note">· nodes fill in as each stage completes</span>
        </div>
        <style>{`
          .rail-legend { display:flex; flex-wrap:wrap; align-items:center; gap:6px 16px; margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); font-size:12.5px; color:var(--muted); }
          .rail-legend i { display:inline-block; width:13px; height:13px; border-radius:50%; margin-right:6px; vertical-align:-2px; border:2px solid var(--line); background:#fff; }
          .rail-legend i.done { background:#0ea5e9; border-color:#0ea5e9; }
          .rail-legend i.next { border-color:#0ea5e9; box-shadow:0 0 0 3px rgba(14,165,233,.25); }
          .rail-legend i.ref { border-style:dashed; }
          .ship-chip { font-size:11px; font-weight:700; padding:1px 8px; border-radius:999px; border:1px solid; white-space:nowrap; }
          .ship-pending { background:var(--chip); color:var(--muted); border-color:var(--line); }
          .ship-shipped { background:#dbeafe; color:#1d4ed8; border-color:#bfdbfe; }
          .ship-delivered { background:#dcfce7; color:#15803d; border-color:#bbf7d0; }
          .deal-box { margin:8px 0 4px 22px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:rgba(5,150,105,.05); font-size:12.5px; }
          .deal-head { font-size:13px; }
          .deal-cust { margin:5px 0; display:flex; flex-direction:column; gap:2px; }
          .deal-picker { margin-top:8px; }
          .deal-picker > input { width:100%; }
          .deal-results { max-height:200px; overflow:auto; border:1px solid var(--line); border-radius:6px; margin:6px 0; }
          .deal-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px; border-bottom:1px solid var(--line); }
          .deal-row:last-child { border-bottom:0; }
          .deal-row:nth-child(even) { background:rgba(29,78,216,.04); }
          .inv-link-box { margin:8px 0 4px 22px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:rgba(5,150,105,.07); font-size:12.5px; }
          .inv-link-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; }
          .inv-qb-tag { display:inline-block; font-size:10px; font-weight:800; color:#0f7a3d; background:rgba(45,168,89,.14); border:1px solid rgba(45,168,89,.4); border-radius:4px; padding:0 4px; margin-right:6px; vertical-align:1px; }
          .type-seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
          .seg-btn { border:0; background:transparent; color:var(--muted); padding:6px 13px; font-size:12.5px; font-weight:600; cursor:pointer; border-right:1px solid var(--line); }
          .seg-btn:last-child { border-right:0; }
          .seg-btn.on { background:var(--primary); color:#fff; }
          .pc-type { display:inline-block; font-size:10px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; padding:1px 7px; border-radius:999px; margin:0 8px; vertical-align:2px; }
          .pc-type-event { background:rgba(5,150,105,.14); color:#047857; border:1px solid rgba(5,150,105,.4); }
          .pc-type-installation { background:rgba(29,78,216,.10); color:#1d4ed8; border:1px solid rgba(29,78,216,.32); }
          .pcard-installation { background:var(--surface); box-shadow:inset 4px 0 0 #1d4ed8, var(--shadow); }
          .pcard-event { background:var(--surface); box-shadow:inset 4px 0 0 #059669, var(--shadow); }
        `}</style>
      </section>

      <div className="toolbar">
        <input placeholder="Search client, salesman, SO#, robot…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 280 }} />
        <div className="type-seg">
          {TYPE_TABS.map(([k, lbl]) => (
            <button key={k} className={`seg-btn${typeFilter === k ? ' on' : ''}`} onClick={() => setTypeFilter(k)}>
              {lbl} · {k === 'all' ? data.projects.length : (typeCounts[k] || 0)}
            </button>
          ))}
        </div>
        <span className="note">{projects.length} shown</span>
      </div>

      {projects.length === 0 && <p className="note">No projects yet — a project starts when a Final Proposal Form is submitted.</p>}

      {projects.map((p) => {
        const curColor = STAGE_RAMP[p.stage];
        const cur = p.nodes[p.stage];
        const isOpen = open === p.id;
        const sh = p.shipment;
        const shLabel = sh && (sh.shipping_needed === false ? 'On-site / pickup'
          : sh.est_delivery_date ? `ETA ${new Date(sh.est_delivery_date).toLocaleDateString()}`
          : sh.est_ship_date ? `Ships ${new Date(sh.est_ship_date).toLocaleDateString()}`
          : sh.status);
        return (
          <div className={`pcard pcard-${typeOf(p)}`} id={`proj-${p.id}`} key={p.id} onClick={() => setOpen(isOpen ? null : p.id)}>
            <div className="pc-head">
              <div className="pc-title">
                <span className="pc-id">{p.project_number}</span>
                <span className={`pc-type pc-type-${typeOf(p)}`}>{typeOf(p) === 'event' ? 'Event' : 'Full Install'}</span>
                <span className="pc-name">{p.title || p.counterparty || '—'}</span>
              </div>
              <span className="pc-stage" style={{ background: curColor }}>Stage {p.stage + 1}/9</span>
            </div>

            <div className="pc-meta">
              {p.agreement_type && <span className="type-pill">{p.agreement_type}</span>}
              {p.robot_types && <span><span className="mi">🤖</span> {p.robot_types}{p.robot_count != null ? ` · ${p.robot_count} unit${p.robot_count === 1 ? '' : 's'}` : ''}</span>}
              {p.salesman_name && <span><span className="mi">👤</span> {p.salesman_name}</span>}
              {p.contract_number && <span>Contract {p.contract_number}</span>}
              {p.so_number && <span>SO {p.so_number}</span>}
              {p.created_at && <span><span className="mi">📅</span> {new Date(p.created_at).toLocaleDateString()}</span>}
              {sh && <span className={`ship-chip ship-${sh.status}`} title={[sh.est_ship_date && `Ship ${sh.est_ship_date}`, sh.est_delivery_date && `Arrive ${sh.est_delivery_date}`, sh.carrier, sh.tracking_number && `#${sh.tracking_number}`].filter(Boolean).join(' · ') || undefined}>🚚 {shLabel}{sh.shipping_needed !== false && sh.status !== 'pending' ? ` · ${sh.status}` : ''}</span>}
              <span className="pc-link" onClick={(e) => e.stopPropagation()}>
                {p.is_proposal_only
                  ? <Link href={`/data-upload?proposal=${encodeURIComponent(p.proposal_id || '')}&sales_name=${encodeURIComponent(p.salesman_name || '')}&sales_email=${encodeURIComponent(p.salesman_email || '')}&contract=${encodeURIComponent(p.contract_number || '')}`} className="btnlink">+ Upload agreement ↗</Link>
                  : <Link href={`/tech-request?agreement=${p.id}`}>Tech Request ↗</Link>}
                {p.jotform_url && <> · <a href={p.jotform_url} target="_blank" rel="noreferrer">JotForm ↗</a></>}
                {p.calendar_link && <> · <a href={p.calendar_link} target="_blank" rel="noreferrer">Calendar ↗</a></>}
              </span>
            </div>

            <ProjectRail nodes={p.nodes} />

            {isOpen && (
              <div className="tree" onClick={(e) => e.stopPropagation()}>
                {msg && msg.pid === p.id && (
                  <p className="note" style={{ color: msg.err ? 'crimson' : 'green', margin: '0 0 8px' }}>{msg.err || msg.text}</p>
                )}
                {p.nodes.map((n, i) => (
                  <div className="tnode" key={n.key}>
                    <div className="h"><span className="dot" style={dotStyle(n, STAGE_RAMP[i])} /> {i + 1}. {n.label} <span className="note" style={{ fontWeight: 400 }}>· {n.status}</span></div>
                    {n.tasks.map((t, j) => (
                      <div className="tleaf" key={j}>
                        <span className="s">{LEAF_ICON[t.status]}</span>
                        <span>{t.label}{t.detail ? <span className="d"> — {t.detail}</span> : null}{t.doc ? <> · <a href={t.doc.preview} target="_blank" rel="noreferrer" title="Preview document">{t.doc.name}</a> · <a href={t.doc.download} title="Download document">Download</a></> : t.url ? <> · <a href={t.url} target="_blank" rel="noreferrer">{String(t.url).includes('jotform') ? 'JotForm ↗' : 'link'}</a></> : null}</span>
                        {t.prep_key && (t.can_mark
                          ? <button className={`btn-sm${t.status === 'done' ? ' secondary' : ''}`} style={{ marginLeft: 8 }} disabled={busy}
                              onClick={(e) => { e.stopPropagation(); t.status === 'done' ? markPrep(p, t) : setConfirmReq({ p, t }); }}>
                              {t.status === 'done' ? 'Unmark' : 'Approve'}
                            </button>
                          : t.status !== 'done' ? <span className="note" style={{ marginLeft: 8 }}>· {t.department} manager only</span> : null)}
                      </div>
                    ))}
                    {n.key === 'proposal' && p.proposal_id && (
                      <div className="deal-box">
                        {p.deal ? (
                          <>
                            <div className="deal-head">🔗 HubSpot deal: <b>{p.deal.name || p.deal.id}</b>{p.deal.amount != null && <span className="note"> · ${Number(p.deal.amount).toLocaleString()}</span>}</div>
                            {p.deal.customer && (
                              <div className="deal-cust">
                                {p.deal.customer.company && <div>🏢 <b>{p.deal.customer.company.name || '—'}</b>{p.deal.customer.company.domain ? <span className="note"> · {p.deal.customer.company.domain}</span> : null}{p.deal.customer.company.phone ? <span className="note"> · {p.deal.customer.company.phone}</span> : null}{p.deal.customer.company.address ? <span className="note"> · {p.deal.customer.company.address}</span> : null}</div>}
                                {p.deal.customer.contact && <div>👤 {p.deal.customer.contact.name || '—'}{p.deal.customer.contact.email ? <span className="note"> · {p.deal.customer.contact.email}</span> : null}{p.deal.customer.contact.jobtitle ? <span className="note"> · {p.deal.customer.contact.jobtitle}</span> : null}</div>}
                              </div>
                            )}
                            <div style={{ marginTop: 4 }}>
                              <button className="btn-sm secondary" disabled={busy} onClick={(e) => { e.stopPropagation(); openDealPicker(p.proposal_id); }}>Change</button>
                              <button className="btn-sm secondary" style={{ marginLeft: 6 }} disabled={busy} onClick={(e) => { e.stopPropagation(); connectDeal(p, null); }}>Unlink</button>
                            </div>
                          </>
                        ) : (dealPicker !== p.proposal_id && (
                          <button className="btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); openDealPicker(p.proposal_id); }}>🔗 Connect HubSpot deal</button>
                        ))}
                        {dealPicker === p.proposal_id && (
                          <div className="deal-picker" onClick={(e) => e.stopPropagation()}>
                            <input autoFocus placeholder="Search HubSpot deals…" value={dealQ} onChange={(e) => loadDeals(e.target.value)} />
                            <div className="deal-results">
                              {dealResults.length ? dealResults.map((d) => (
                                <div className="deal-row" key={d.id}>
                                  <span>{d.name || d.id}{d.amount != null && <span className="note"> · ${Number(d.amount).toLocaleString()}</span>}</span>
                                  <button className="btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); connectDeal(p, d.id); }}>Use</button>
                                </div>
                              )) : <p className="note" style={{ margin: '4px 0' }}>No deals match.</p>}
                            </div>
                            <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); setDealPicker(null); }}>Cancel</button>
                          </div>
                        )}
                      </div>
                    )}
                    {n.key === 'invoice' && (
                      <div className="inv-link-box">
                        {(p.invoices || []).length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            {p.invoices.map((iv) => (
                              <div className="inv-link-row" key={iv.id}>
                                <span>🧾 <b>{iv.number || '(draft)'}</b>
                                  {iv.customer_name ? <span className="note"> · {iv.customer_name}</span> : null}
                                  {iv.total ? <span className="note"> · ${Number(iv.total).toLocaleString()}</span> : null}
                                  <span className="note"> · {iv.status}</span></span>
                                <button className="btn-sm secondary" disabled={busy} onClick={(e) => { e.stopPropagation(); unlinkInvoice(p, iv.id); }}>Unlink</button>
                              </div>
                            ))}
                          </div>
                        )}
                        {invPicker !== p.id ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <button className="btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); openInvPicker(p.id); }}>🔗 Connect existing invoice</button>
                            <a href={`/invoices?project=${encodeURIComponent(p.id)}`} target="_blank" rel="noreferrer">+ New invoice for this project ↗</a>
                          </div>
                        ) : (
                          <div className="deal-picker" onClick={(e) => e.stopPropagation()}>
                            <input autoFocus placeholder={invQbConnected ? 'Search app + QuickBooks invoices by #, customer…' : 'Search invoices by #, customer…'} value={invQ} onChange={(e) => loadInvoices(e.target.value)} />
                            <div className="deal-results">
                              {invResults.length ? invResults.map((iv) => {
                                const qbSrc = iv.source === 'quickbooks';
                                const here = iv.source === 'app' && iv.project_id === p.id;
                                return (
                                  <div className="deal-row" key={iv.id || `qb-${iv.qb_invoice_id}`}>
                                    <span>{qbSrc ? <span className="inv-qb-tag">QB</span> : null}{iv.number || '(draft)'}
                                      {iv.customer_name ? <span className="note"> · {iv.customer_name}</span> : null}
                                      {iv.total ? <span className="note"> · ${Number(iv.total).toLocaleString()}</span> : null}
                                      {iv.source === 'app' && iv.project_id && !here ? <span className="note"> · ⚠ linked to {iv.project_number || 'another project'}</span> : null}</span>
                                    <button className="btn-sm" disabled={busy || here} onClick={(e) => { e.stopPropagation(); connectInvoice(p, iv); }}>{here ? 'Linked' : qbSrc ? 'Import & use' : (iv.project_id ? 'Move here' : 'Use')}</button>
                                  </div>
                                );
                              }) : <p className="note" style={{ margin: '4px 0' }}>{invQ ? 'No matching invoices.' : 'No invoices yet.'} <a href={`/invoices?project=${encodeURIComponent(p.id)}`} target="_blank" rel="noreferrer">create one for this project ↗</a></p>}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span className="note">{invQbConnected ? 'Listing app + live QuickBooks invoices' : 'QuickBooks not connected — app invoices only'}</span>
                              <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); setInvPicker(null); }}>Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {n.key === 'prep' && p.prep_all_done && !p.confirmation_done && (
                      <div className="tleaf" style={{ marginTop: 6 }}>
                        <button className="btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); sendConfirmation(p); }}>Send form ↗</button>
                        <a href="https://form.jotform.com/261615438877065" target="_blank" rel="noreferrer" style={{ marginLeft: 10 }}>open form</a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {confirmReq && (
        <div className="pt-backdrop" onClick={() => setConfirmReq(null)}>
          <div className="pt-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Ready to move to the next step?</h3>
            <p className="note" style={{ margin: '0 0 6px' }}>Please confirm your team has finished this preparation step. Once every team confirms its part, the project can move on to the next step together. We’ll record this under your name and the current time.</p>
            <ul className="pt-info">
              <li><span>Step</span><b>{confirmReq.t.label}</b></li>
              <li><span>Department</span><b>{confirmReq.t.department}</b></li>
              <li><span>Project</span><b>{confirmReq.p.project_number}</b></li>
              <li><span>Customer</span><b>{confirmReq.p.counterparty || confirmReq.p.title || '—'}</b></li>
            </ul>
            <div className="pt-actions">
              <button className="secondary btn-sm" disabled={busy} onClick={() => setConfirmReq(null)}>Not yet</button>
              <button className="btn-sm" disabled={busy} onClick={async () => { const { p, t } = confirmReq; setConfirmReq(null); await markPrep(p, t); }}>Yes, we’re done</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .btn-sm { padding:3px 10px; font-size:12px; border-radius:6px; }
        .pt-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.45); display:flex; align-items:center; justify-content:center; z-index:50; padding:16px; }
        .pt-modal { background:#fff; border-radius:12px; padding:20px 22px; max-width:440px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,.28); }
        .pt-modal h3 { margin:0 0 8px; font-size:16px; }
        .pt-info { list-style:none; margin:14px 0 0; padding:0; border-top:1px dashed var(--line); }
        .pt-info li { display:flex; justify-content:space-between; gap:18px; padding:8px 0; border-bottom:1px dashed var(--line); font-size:13px; }
        .pt-info li span { color:var(--muted); }
        .pt-info li b { text-align:right; }
        .pt-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
      `}</style>
    </>
  );
}
