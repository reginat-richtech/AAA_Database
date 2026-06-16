// Shared "Blueprint Schematic" presentational components + stage model.
// Pure/presentational (no hooks) so they can be used from any page.
import { PROJECT_STAGES } from '../../lib/projectStages';

// Timeline color ramp, stage order 1→9 (RED→BLUE). Overrides the raw colors in
// projectStages.js for the Dashboard timeline while names + tracked flags below
// stay sourced from projectStages.js (the single source of truth).
export const STAGE_RAMP = ['#f97316', '#f59e0b', '#65a30d', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#1d4ed8', '#2563eb'];

// Separate palette for the robots-by-model donut.
export const ROBOT_PALETTE = ['#1d4ed8', '#0ea5e9', '#06b6d4', '#14b8a6', '#f59e0b', '#f97316'];

// One-line description per stage (keyed by stage key from projectStages.js).
const STAGE_DESC = {
  proposal: 'Signed proposal received — deal terms locked in.',
  agreement: 'Master agreement countersigned and on file.',
  invoice: 'Invoice issued in QuickBooks; awaiting payment.',
  request: 'Field deployment requested — needs a manager.',
  review: 'Scope reviewed; install window being scheduled.',
  prep: 'Crew, robots & parts assigned to the job.',
  confirmation: 'Assigned technician confirms availability.',
  travel: 'Travel & logistics submitted to finance.',
  closure: 'On-site install complete; project closed out.',
};

// Final stage model used across the Dashboard: names + tracked from the source
// of truth, colors from the ramp, plus the descriptions above.
export const STAGES = PROJECT_STAGES.map((s, i) => ({ ...s, color: STAGE_RAMP[i], desc: STAGE_DESC[s.key] || '' }));

// Append an alpha channel to a 6-digit hex color.
export function hexA(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return hex + a;
}

// Drawing title block: Project / Sheet / Rev cells.
export function TitleBlock({ sheet, rev = '2026.06', project = 'Richtech Systems' }) {
  return (
    <div className="titleblock" aria-hidden="true">
      <div className="cell"><div className="k">Project</div><div className="v">{project}</div></div>
      <div className="cell"><div className="k">Sheet</div><div className="v">{sheet}</div></div>
      <div className="cell"><div className="k">Rev</div><div className="v">{rev}</div></div>
    </div>
  );
}

// Page header: title + sub on the left, drawing title block on the right.
export function PageHeader({ title, sub, sheet }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="sub" style={{ marginBottom: 0 }}>{sub}</p> : null}
      </div>
      <TitleBlock sheet={sheet} />
    </div>
  );
}

// Vertical stage timeline: connector rail with a colored node per stage and a
// comment card to its right. Active projects at a stage are pinned as pills and
// give that node a colored ring.
export function StageTimeline({ stages, counts = {}, projectsByStage = {} }) {
  return (
    <div className="timeline">
      {stages.map((s, i) => {
        const pinned = projectsByStage[s.key] || [];
        const isLast = i === stages.length - 1;
        const nodeStyle = s.tracked
          ? { background: s.color, borderColor: s.color }
          : { background: '#fff', borderColor: s.color };
        if (pinned.length) nodeStyle.boxShadow = `0 0 0 4px ${hexA(s.color, 0.25)}`;
        return (
          <div className="tl-row" key={s.key}>
            <div className="tl-rail">
              <span className="tl-node" style={nodeStyle} />
              {!isLast && <span className="tl-seg" style={{ background: hexA(s.color, 0.55) }} />}
            </div>
            <div className="tl-card" style={{ borderLeftColor: s.color }}>
              <div className="tl-head">
                <span className="tl-step" style={{ color: s.color }}>{String(i + 1).padStart(2, '0')}</span>
                <span className="tl-name">{s.label}</span>
                {!s.tracked && <span className="pill-ref">reference</span>}
                <span className="tl-count">{counts[s.key] || 0}</span>
              </div>
              <div className="tl-desc">{s.desc}</div>
              {pinned.length > 0 && (
                <div className="tl-pins">
                  {pinned.map((p) => (
                    <span className="pin" key={p.id} style={{ borderColor: s.color, color: s.color }}>{p.project_number}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Horizontal sibling of StageTimeline: nodes connected left-to-right by a
// colored line, with stage number / name / count beneath each node. Same color
// ramp and tracked/reference styling as the vertical timeline.
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

// Per-project horizontal rail: connected dots with the stage number + name
// UNDER each dot, colored by that project's node status. Compact — replaces a
// stacked stage list. `stage` is the current stage index (drives line fill).
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

// SVG donut chart with a legend. data = [{ label, value }].
export function Donut({ data, palette, size = 168, thickness = 24 }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Robots by model">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={thickness} />
          {total > 0 && data.map((d, i) => {
            const len = (d.value / total) * circ;
            const seg = (
              <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={palette[i % palette.length]} strokeWidth={thickness}
                strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset} />
            );
            offset += len;
            return seg;
          })}
        </g>
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="central" className="donut-center">{total}</text>
        <text x="50%" y="60%" textAnchor="middle" dominantBaseline="central"
          style={{ fontSize: 10, fill: 'var(--muted)', fontFamily: 'var(--font-mono)', letterSpacing: '.08em' }}>ROBOTS</text>
      </svg>
      <div className="dlegend">
        {data.length ? data.map((d, i) => (
          <div className="it" key={i}>
            <span className="sw" style={{ background: palette[i % palette.length] }} />
            <span className="nm">{d.label}</span>
            <span className="v">{d.value}</span>
          </div>
        )) : <span className="note">No robot data yet.</span>}
      </div>
    </div>
  );
}
