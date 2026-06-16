'use client';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader, StageTimeline, Donut, STAGES, ROBOT_PALETTE } from './_components/blueprint';

// ===========================================================================
// PLACEHOLDER DATA — the ONLY values on this page without a real source yet.
// Everything else is computed from /api/project-tracker/projects and
// /api/data-upload. Swap these for a real metrics source when one exists.
// ===========================================================================
const PLACEHOLDER = {
  // KPI trend indicators — no historical snapshots are stored today.
  trends: {
    agreements: { dir: 'up', text: '▲ trending up' },
    active: { dir: 'flat', text: '— steady' },
    awaiting: { dir: 'warn', text: '● needs review' },
    robots: { dir: 'up', text: '▲ trending up' },
  },
};
// ===========================================================================

const SEV_COLOR = { fail: 'var(--bad)', warn: 'var(--warn)', info: 'var(--info)' };

// Normalize a robot_types token to a Richtech model label for the donut.
function modelLabel(token) {
  const s = token.toLowerCase();
  if (s.includes('adam')) return 'ADAM';
  if (s.includes('matradee')) return 'Matradee L';
  if (s.includes('titan')) return 'Titan 300';
  if (s.includes('dust')) return 'DUST-E S';
  if (s.includes('scorpion')) return 'Scorpion';
  if (s.includes('ascend') || s.includes('medbot')) return 'Ascend/MedBot';
  return token.length > 14 ? token.slice(0, 14) + '…' : token;
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export default function Dashboard() {
  const [pt, setPt] = useState({ stages: [], projects: [], counts: {} });
  const [agreements, setAgreements] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch('/api/project-tracker/projects')
      .then((r) => r.json()).then((d) => setPt(d || {}))
      .catch(() => setErr('Could not load project data.'));
    fetch('/api/data-upload')
      .then((r) => r.json()).then((d) => setAgreements(d.agreements || []))
      .catch(() => {});
  }, []);

  const projects = pt.projects || [];
  const counts = pt.counts || {};

  const activeProjects = useMemo(() => projects.filter((p) => p.stage_key !== 'closure'), [projects]);
  const robotsActive = useMemo(() => activeProjects.reduce((s, p) => s + (Number(p.robot_count) || 0), 0), [activeProjects]);
  const awaiting = counts.request || 0;

  // Group projects by their current stage so each timeline node can pin them.
  const projectsByStage = useMemo(() => {
    const m = {};
    for (const p of projects) (m[p.stage_key] = m[p.stage_key] || []).push(p);
    return m;
  }, [projects]);

  // Robots by model — derived from robot_types/robot_count of active projects.
  const robotData = useMemo(() => {
    const acc = {};
    for (const p of activeProjects) {
      const types = String(p.robot_types || '').split(/[,/]/).map((t) => t.trim()).filter(Boolean);
      if (!types.length) continue;
      const per = (Number(p.robot_count) || types.length) / types.length;
      for (const t of types) {
        const k = modelLabel(t);
        acc[k] = (acc[k] || 0) + per;
      }
    }
    let arr = Object.entries(acc)
      .map(([label, value]) => ({ label, value: Math.round(value) }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    if (arr.length > ROBOT_PALETTE.length) {
      const head = arr.slice(0, ROBOT_PALETTE.length - 1);
      const rest = arr.slice(ROBOT_PALETTE.length - 1).reduce((s, d) => s + d.value, 0);
      arr = [...head, { label: 'Other', value: rest }];
    }
    return arr;
  }, [activeProjects]);

  // Needs attention — real signals from extraction status + approval queue.
  const attention = useMemo(() => {
    const out = [];
    for (const a of agreements) {
      if (a.status === 'error') out.push({ sev: 'fail', title: `Extraction failed · ${a.project_number}`, detail: a.error || a.counterparty || 'AI extraction error' });
    }
    for (const a of agreements) {
      if (a.status && a.status !== 'ready' && a.status !== 'error') out.push({ sev: 'warn', title: `Awaiting extraction · ${a.project_number}`, detail: a.counterparty || a.title || '' });
    }
    for (const p of projectsByStage.request || []) out.push({ sev: 'info', title: `Needs manager approval · ${p.project_number}`, detail: p.counterparty || '' });
    return out.slice(0, 8);
  }, [agreements, projectsByStage]);

  // Recent activity — real: most recent agreement uploads.
  const activity = useMemo(() => (
    [...agreements]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 7)
      .map((a) => ({
        icon: a.status === 'ready' ? '📄' : a.status === 'error' ? '⚠️' : '⏳',
        text: `${a.project_number} — ${a.counterparty || a.title || 'agreement'} uploaded`,
        ts: a.created_at,
      }))
  ), [agreements]);

  const maxCount = Math.max(1, ...STAGES.map((s) => counts[s.key] || 0));

  const kpis = [
    { l: 'Agreements uploaded', n: agreements.length, color: '#1d4ed8', tr: PLACEHOLDER.trends.agreements },
    { l: 'Active projects', n: activeProjects.length, color: '#06b6d4', tr: PLACEHOLDER.trends.active },
    { l: 'Awaiting approval', n: awaiting, color: '#f59e0b', tr: PLACEHOLDER.trends.awaiting },
    { l: 'Robots in active deals', n: robotsActive, color: '#10b981', tr: PLACEHOLDER.trends.robots },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        sub="Operational overview — agreements, the deployment pipeline, and robots in active deals."
        sheet="Dashboard"
      />
      {err && <p className="error">{err}</p>}

      {/* 2 — KPI row */}
      <div className="kpis">
        {kpis.map((k) => (
          <div className="kpi" key={k.l} style={{ borderLeftColor: k.color }}>
            <div className="l">{k.l}</div>
            <div className="n">{k.n}</div>
            <div className={'trend ' + k.tr.dir}>{k.tr.text}</div>
          </div>
        ))}
      </div>

      {/* 3 — Process tracker (vertical timeline) */}
      <section className="panel">
        <div className="panel-title"><h2>Project process tracker</h2><span className="meta">9 stages · red → blue</span></div>
        <StageTimeline stages={STAGES} counts={counts} projectsByStage={projectsByStage} />
      </section>

      {/* 4 — Pipeline + robots */}
      <div className="split">
        <section className="panel">
          <div className="panel-title"><h2>Pipeline by stage</h2><span className="meta">current count</span></div>
          <div className="sched">
            {STAGES.map((s) => {
              const v = counts[s.key] || 0;
              return (
                <div className={'sched-row' + (s.tracked ? '' : ' dim')} key={s.key}>
                  <span className="tick" style={{ background: s.color }} />
                  <span className="name">{s.label}</span>
                  <span className="barwrap"><span className="bar" style={{ width: `${(v / maxCount) * 100}%`, background: s.color }} /></span>
                  <span className="cnt">{v}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title"><h2>Robots in active deals</h2><span className="meta">by model</span></div>
          <Donut data={robotData} palette={ROBOT_PALETTE} />
        </section>
      </div>

      {/* 5 — Attention + activity */}
      <div className="split">
        <section className="panel">
          <div className="panel-title"><h2>Needs attention</h2><span className="meta">{attention.length} item(s)</span></div>
          {attention.length ? (
            <div className="attn">
              {attention.map((a, i) => (
                <div className="attn-row" key={i}>
                  <span className="attn-bar" style={{ background: SEV_COLOR[a.sev] }} />
                  <div className="attn-bd">
                    <div className="attn-t">{a.title}</div>
                    {a.detail ? <div className="attn-d">{a.detail}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="note">All clear — nothing needs attention.</p>}
        </section>
        <section className="panel">
          <div className="panel-title"><h2>Recent activity</h2></div>
          {activity.length ? (
            <div className="feed">
              {activity.map((a, i) => (
                <div className="feed-row" key={i}>
                  <span className="feed-ic" aria-hidden="true">{a.icon}</span>
                  <span className="feed-tx">{a.text}</span>
                  <span className="feed-ts">{relTime(a.ts)}</span>
                </div>
              ))}
            </div>
          ) : <p className="note">No recent activity.</p>}
        </section>
      </div>

      {/* 6 — Active projects */}
      <section className="panel">
        <div className="panel-title"><h2>Active projects</h2><span className="meta">{activeProjects.length} open</span></div>
        {activeProjects.length ? (
          <div className="proj-grid">
            {activeProjects.map((p) => {
              const stage = STAGES[p.stage] || STAGES[0];
              const pct = Math.round(((p.stage + 1) / STAGES.length) * 100);
              return (
                <div className="proj-card" key={p.id}>
                  <span className="accent" style={{ background: stage.color }} />
                  <div className="proj-id">{p.project_number}</div>
                  <div className="proj-client">{p.counterparty || '—'}</div>
                  <div className="proj-meta">{p.agreement_type || '—'}{p.robot_types ? ` · ${p.robot_types}` : ''}</div>
                  <div className="proj-stage">
                    <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>
                    <span className="step">step {p.stage + 1}/{STAGES.length}</span>
                  </div>
                  <div className="proj-prog"><span className="fill" style={{ width: `${pct}%`, background: stage.color }} /></div>
                  <div className="proj-foot"><span>SO {p.so_number || '—'}</span><span>{p.salesman_name || 'unassigned'}</span></div>
                </div>
              );
            })}
          </div>
        ) : <p className="note">No active projects.</p>}
      </section>
    </>
  );
}
