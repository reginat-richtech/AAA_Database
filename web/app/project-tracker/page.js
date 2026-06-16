'use client';
import { useEffect, useState } from 'react';

const LEAF_ICON = { done: '✓', pending: '○', manual: '·' };

function dotStyle(node) {
  if (node.status === 'done') return { background: node.color, borderColor: node.color };
  if (node.status === 'current') return { borderColor: node.color, boxShadow: `0 0 0 3px ${node.color}33` };
  if (node.status === 'manual') return { borderStyle: 'dashed' };
  return {};
}

export default function ProjectTracker() {
  const [data, setData] = useState({ stages: [], projects: [], counts: {} });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    fetch('/api/project-tracker/projects').then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const projects = data.projects.filter((p) => {
    if (!q) return true;
    const hay = `${p.project_number} ${p.counterparty} ${p.salesman_name} ${p.so_number} ${p.robot_types}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  return (
    <>
      <h1>Project Tracker</h1>
      <p className="sub">Read-only workflow tree per project. Each agreement advances through 9 stages as its tech request, approval, confirmation, and travel steps complete.</p>

      <div className="legend">
        {data.stages.map((s) => (
          <span className="item" key={s.key}>
            <span className="swatch" style={{ background: s.color, opacity: s.tracked ? 1 : 0.45 }} />
            {s.label} <b style={{ color: 'var(--ink)' }}>{data.counts[s.key] || 0}</b>
          </span>
        ))}
      </div>

      <div className="toolbar">
        <input placeholder="Search client, salesman, SO#, robot…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 320 }} />
        <span className="note">{projects.length} project(s)</span>
      </div>

      {projects.length === 0 && <p className="note">No projects yet — upload an agreement in Data Upload.</p>}

      {projects.map((p) => {
        const cur = p.nodes[p.stage];
        return (
          <div className="pcard" key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <b>{p.project_number}</b> — {p.counterparty || '—'}
                <span className="note"> · {p.agreement_type}{p.robot_types ? ` · ${p.robot_types}` : ''}</span>
              </div>
              <span className="chip" style={{ background: `${cur.color}22`, color: cur.color }}>{cur.label}</span>
            </div>
            <div className="stepper">
              {p.nodes.map((n) => <span key={n.key} className="dot" title={`${n.label} — ${n.status}`} style={dotStyle(n)} />)}
            </div>
            {(p.jotform_url || p.calendar_link) && (
              <div className="note" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                {p.jotform_url && <a href={p.jotform_url} target="_blank" rel="noreferrer">JotForm</a>}
                {p.jotform_url && p.calendar_link && ' · '}
                {p.calendar_link && <a href={p.calendar_link} target="_blank" rel="noreferrer">Calendar</a>}
              </div>
            )}

            {open === p.id && (
              <div className="tree" onClick={(e) => e.stopPropagation()}>
                {p.nodes.map((n) => (
                  <div className="tnode" key={n.key}>
                    <div className="h"><span className="dot" style={dotStyle(n)} /> {n.label} <span className="note" style={{ fontWeight: 400 }}>· {n.status}</span></div>
                    {n.tasks.map((t, i) => (
                      <div className="tleaf" key={i}>
                        <span className="s">{LEAF_ICON[t.status]}</span>
                        <span>{t.label}{t.detail ? <span className="d"> — {t.detail}</span> : null}{t.url ? <> · <a href={t.url} target="_blank" rel="noreferrer">link</a></> : null}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
