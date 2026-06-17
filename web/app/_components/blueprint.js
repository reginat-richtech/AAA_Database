// Shared "Blueprint Schematic" presentational components + stage model.
// Pure/presentational (no hooks) so they can be used from any page.
import { PROJECT_STAGES } from '../../lib/projectStages';

// Stage color ramp, order 1→9. Overrides the raw colors in projectStages.js
// while names + tracked flags stay sourced from projectStages.js (single source).
export const STAGE_RAMP = ['#f97316', '#f59e0b', '#65a30d', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#1d4ed8', '#2563eb'];

// Final stage model: names + tracked from the source of truth, colors from the ramp.
export const STAGES = PROJECT_STAGES.map((s, i) => ({ ...s, color: STAGE_RAMP[i] }));

// Append an alpha channel to a 6-digit hex color.
export function hexA(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return hex + a;
}

// Page header: title + sub.
export function PageHeader({ title, sub }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="sub" style={{ marginBottom: 0 }}>{sub}</p> : null}
      </div>
    </div>
  );
}

// Horizontal stage rail (Project Tracker overview): nodes connected left-to-right
// by a colored line, with stage number / name / count beneath each node.
export function StageRail({ stages, counts = {} }) {
  return (
    <div className="rail">
      {stages.map((s, i) => {
        const n = counts[s.key] || 0;
        const occupied = n > 0;
        const isFirst = i === 0;
        const isLast = i === stages.length - 1;
        const nodeStyle = s.tracked
          ? { background: s.color, borderColor: s.color }
          : { background: '#fff', borderColor: s.color };
        if (occupied) nodeStyle.boxShadow = `0 0 0 4px ${hexA(s.color, 0.22)}`;
        return (
          <div className="rail-col" key={s.key}>
            <div className="rail-track">
              <span className="rail-line" style={{ background: isFirst ? 'transparent' : hexA(stages[i - 1].color, 0.55) }} />
              <span className="rail-node" style={nodeStyle} />
              <span className="rail-line" style={{ background: isLast ? 'transparent' : hexA(s.color, 0.55) }} />
            </div>
            <div className="rail-meta">
              <span className="rail-step" style={{ color: s.color }}>{String(i + 1).padStart(2, '0')}</span>
              <span className="rail-name">{s.label}</span>
              {!s.tracked && <span className="pill-ref">ref</span>}
              <span className="rail-cnt" style={{ color: occupied ? s.color : 'var(--muted)' }}>{n}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Per-project horizontal rail: connected dots with the stage number + name UNDER
// each dot, colored by that project's node status. `stage` drives the line fill.
export function ProjectRail({ nodes }) {
  // Furthest completed tracked stage drives how far the line is colored; the
  // first still-pending tracked stage is the "next action" (ringed node).
  const doneMax = nodes.reduce((m, n, i) => (n.status === 'done' ? i : m), -1);
  const activeIdx = nodes.findIndex((n) => n.tracked && n.status === 'pending');
  return (
    <div className="rail">
      {nodes.map((n, i) => {
        const c = STAGE_RAMP[i];
        const isFirst = i === 0;
        const isLast = i === nodes.length - 1;
        const isDone = n.status === 'done';
        const isActive = i === activeIdx;
        let nodeStyle;
        if (isDone) nodeStyle = { background: c, borderColor: c };
        else if (isActive) nodeStyle = { background: '#fff', borderColor: c, boxShadow: `0 0 0 4px ${hexA(c, 0.2)}` };
        else if (n.status === 'manual') nodeStyle = { background: '#fff', borderColor: 'var(--line)', borderStyle: 'dashed' };
        else nodeStyle = { background: '#fff', borderColor: 'var(--line)' };
        const leftColored = !isFirst && i - 1 < doneMax;
        const rightColored = !isLast && i < doneMax;
        const lit = isDone || isActive;
        const nameStyle = lit ? { color: c, fontWeight: isActive ? 700 : 600 } : { color: 'var(--muted)' };
        return (
          <div className="rail-col" key={n.key} title={`${n.label} — ${n.status}`}>
            <div className="rail-track">
              <span className="rail-line" style={{ background: isFirst ? 'transparent' : (leftColored ? hexA(STAGE_RAMP[i - 1], 0.85) : 'var(--line)') }} />
              <span className="rail-node" style={nodeStyle} />
              <span className="rail-line" style={{ background: isLast ? 'transparent' : (rightColored ? hexA(c, 0.85) : 'var(--line)') }} />
            </div>
            <div className="rail-meta">
              <span className="rail-name" style={nameStyle}>{i + 1}. {n.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
