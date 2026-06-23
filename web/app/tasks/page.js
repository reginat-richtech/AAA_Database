'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';
import {
  DEPARTMENTS, DEPARTMENT_LABEL, TASK_STATUS, TASK_STATUS_LABEL, TASK_PRIORITY,
  taskPerms, createPerms,
} from '../../lib/orgRoles';

const STATUS_COLOR = { todo: '#94a3b8', in_progress: '#0ea5e9', blocked: '#dc2626', done: '#16a34a' };
const PRIORITY_COLOR = { low: '#94a3b8', normal: '#0ea5e9', high: '#dc2626' };
const ymd = (d) => (d ? String(d).slice(0, 10) : '');
const EMPTY = { id: null, title: '', description: '', project_id: '', department: '', assignee_email: '', status: 'todo', priority: 'normal', due_date: '' };

export default function Tasks() {
  const [data, setData] = useState({ me: null, tasks: [], projects: [], members: [] });
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [search, setSearch] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [openMap, setOpenMap] = useState({});   // explicit expand/collapse overrides per project

  const load = useCallback(() => {
    fetch('/api/tasks').then((r) => r.json()).then((d) => { if (d && !d.error) setData(d); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const me = data.me;
  const cp = createPerms(me);
  const isManager = !!me && (me.isAdmin || me.title === 'manager');
  const setF = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  const openNew = (projectId = '') => { setMsg(null); setForm({ ...EMPTY, project_id: projectId, department: me?.isAdmin ? '' : (me?.department || '') }); };
  const openTask = (t) => {
    setMsg(null);
    setForm({ id: t.id, title: t.title || '', description: t.description || '', project_id: t.project_id || '', department: t.department || '', assignee_email: t.assignee_email || '', status: t.status, priority: t.priority, due_date: ymd(t.due_date) });
  };
  const close = () => { setForm(null); setMsg(null); };

  async function save() {
    setBusy(true); setMsg(null);
    const payload = {
      title: form.title, description: form.description || '', project_id: form.project_id,
      department: form.department, assignee_email: form.assignee_email || '', status: form.status,
      priority: form.priority, due_date: form.due_date || null,
    };
    const r = await fetch(form.id ? `/api/tasks/${form.id}` : '/api/tasks', {
      method: form.id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(j.error || 'Save failed'); return; }
    close(); load();
  }
  async function del() {
    if (!window.confirm('Delete this task?')) return;
    setBusy(true);
    await fetch(`/api/tasks/${form.id}`, { method: 'DELETE' }).catch(() => {});
    setBusy(false); close(); load();
  }
  async function quickStatus(t, status) {
    setBusy(true);
    await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }).catch(() => {});
    setBusy(false); load();
  }
  async function toggleComplete(p) {
    setBusy(true);
    const next = p.status === 'complete' ? 'active' : 'complete';
    await fetch(`/api/tasks/projects/${p.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) }).catch(() => {});
    setBusy(false); load();
  }

  // Group visible tasks under their project.
  const visibleTasks = (data.tasks || []).filter((t) => !mineOnly || (t.assignee_email || '').toLowerCase() === me?.email);
  const tasksByProject = {};
  for (const t of visibleTasks) (tasksByProject[t.project_id] ||= []).push(t);

  const projects = (data.projects || []).filter((p) => {
    if (mineOnly && !(tasksByProject[p.id] || []).length) return false;
    if (!search) return true;
    const hay = `${p.project_number} ${p.title || ''} ${p.counterparty || ''}`.toLowerCase();
    return hay.includes(search.toLowerCase());
  });
  const isOpen = (pid, hasTasks) => (openMap[pid] !== undefined ? openMap[pid] : hasTasks);
  const toggle = (pid, hasTasks) => setOpenMap((m) => ({ ...m, [pid]: !(m[pid] !== undefined ? m[pid] : hasTasks) }));

  // Editor permissions for the open form.
  const orig = form?.id ? data.tasks.find((t) => t.id === form.id) : null;
  const tp = orig ? taskPerms(me, orig) : { canEdit: cp.canCreate, canManage: cp.canAssignOthers };
  const editing = !!form?.id;
  const canEditFields = editing ? tp.canEdit : cp.canCreate;
  const canAssign = editing ? tp.canManage : cp.canAssignOthers;
  const canDelete = editing && tp.canManage;
  const deptMembers = (data.members || []).filter((m) => !form?.department || m.department === form.department);
  const canSave = form && form.title.trim() && form.project_id && form.department;

  return (
    <>
      <PageHeader title="Task Tracking" sub="Projects appear once they reach Team Preparation. Each team adds its tasks; a manager marks the project complete (tasks stay editable after)." sheet="Task Tracking" />

      {me && !me.isAdmin && !me.department && (
        <div className="panel" style={{ borderColor: 'var(--bad)' }}>
          <p className="note" style={{ margin: 0 }}>⚠ You don’t have a department yet, so you can only see tasks assigned to you. Ask an admin to set your department on the Users page.</p>
        </div>
      )}

      <div className="toolbar">
        {cp.canCreate && <button onClick={() => openNew('')}>+ New task</button>}
        <input placeholder="Search project, client…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <label className="tk-chk"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> My tasks only</label>
        <span className="note" style={{ marginLeft: 'auto' }}>
          {me ? (me.isAdmin ? 'Admin — all departments' : (me.department ? `${DEPARTMENT_LABEL[me.department]} · ${me.title === 'manager' ? 'Manager' : 'Member'}` : 'No department')) : ''}
          {' · '}{projects.length} project(s)
        </span>
      </div>

      {projects.map((p) => {
        const groupTasks = (tasksByProject[p.id] || []).slice().sort((a, b) => TASK_STATUS.indexOf(a.status) - TASK_STATUS.indexOf(b.status));
        const complete = p.status === 'complete';
        const open = isOpen(p.id, groupTasks.length > 0);
        const doneCount = groupTasks.filter((t) => t.status === 'done').length;
        return (
          <div className={'tp-card' + (complete ? ' done' : '')} key={p.id}>
            <div className="tp-head" onClick={() => toggle(p.id, groupTasks.length > 0)}>
              <span className="tp-caret">{open ? '▾' : '▸'}</span>
              <span className="tp-proj">{p.project_number}</span>
              <span className="tp-name">{p.title || p.counterparty || 'Project'}</span>
              {complete
                ? <span className="chip ok">✓ Complete</span>
                : <span className="note">{doneCount}/{groupTasks.length} done</span>}
              {isManager && (
                <button type="button" className="secondary tp-complete" onClick={(e) => { e.stopPropagation(); toggleComplete(p); }} disabled={busy}>
                  {complete ? 'Reopen' : 'Mark complete'}
                </button>
              )}
            </div>

            {open && (
              <div className="tp-body" onClick={(e) => e.stopPropagation()}>
                {complete && p.completed_by && (
                  <p className="note tp-by">✓ Completed by {p.completed_by}{p.completed_at ? ` · ${new Date(p.completed_at).toLocaleDateString()}` : ''} — tasks remain editable.</p>
                )}
                {groupTasks.length === 0 && <p className="note">No tasks yet for your team.</p>}
                {groupTasks.map((t) => {
                  const perms = taskPerms(me, t);
                  return (
                    <div className="tk-row" key={t.id} onClick={() => openTask(t)}>
                      <span className="tk-sdot" style={{ background: STATUS_COLOR[t.status] }} title={TASK_STATUS_LABEL[t.status]} />
                      <span className="tk-rtitle">{t.title}</span>
                      <span className="tk-pri" style={{ color: PRIORITY_COLOR[t.priority] }} title={`priority: ${t.priority}`}>●</span>
                      <span className="note tk-rassignee">{t.assignee_email ? t.assignee_email.split('@')[0] : 'unassigned'}</span>
                      {me?.isAdmin && <span className="tk-deptchip">{DEPARTMENT_LABEL[t.department] || t.department}</span>}
                      {t.due_date && <span className="note">📅 {ymd(t.due_date)}</span>}
                      {perms.canEdit && (
                        <select className="tk-quick" value={t.status} onClick={(e) => e.stopPropagation()} onChange={(e) => quickStatus(t, e.target.value)} disabled={busy}>
                          {TASK_STATUS.map((x) => <option key={x} value={x}>{TASK_STATUS_LABEL[x]}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })}
                {cp.canCreate && <button type="button" className="secondary tp-add" onClick={() => openNew(p.id)}>+ Add task</button>}
              </div>
            )}
          </div>
        );
      })}
      {projects.length === 0 && <p className="note">No projects are at the Team Preparation step yet — a project shows up here once it’s approved at the Tech Department Review &amp; Approve step.</p>}

      {form && (
        <div className="tk-overlay" onClick={close}>
          <div className="tk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tk-modalhead">
              <b>{editing ? 'Edit task' : 'New task'}</b>
              {!canEditFields && <span className="note">read-only</span>}
              <button type="button" className="secondary" onClick={close} style={{ marginLeft: 'auto' }}>✕</button>
            </div>

            <label className="tk-f">Title<input value={form.title} onChange={(e) => setF('title', e.target.value)} disabled={!canEditFields} placeholder="What needs doing?" /></label>

            <label className="tk-f">Project<select value={form.project_id} onChange={(e) => setF('project_id', e.target.value)} disabled={!canEditFields}>
              <option value="">Select a project…</option>
              {(data.projects || []).map((p) => <option key={p.id} value={p.id}>{p.project_number} — {p.title || p.counterparty || 'project'}</option>)}
            </select></label>

            <div className="tk-frow">
              <label className="tk-f">Department
                {me?.isAdmin ? (
                  <select value={form.department} onChange={(e) => setF('department', e.target.value)}>
                    <option value="">Select…</option>
                    {DEPARTMENTS.map((d) => <option key={d} value={d}>{DEPARTMENT_LABEL[d]}</option>)}
                  </select>
                ) : <input value={DEPARTMENT_LABEL[form.department] || '—'} disabled />}
              </label>
              <label className="tk-f">Priority<select value={form.priority} onChange={(e) => setF('priority', e.target.value)} disabled={!canEditFields}>
                {TASK_PRIORITY.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></label>
            </div>

            <div className="tk-frow">
              <label className="tk-f">Status<select value={form.status} onChange={(e) => setF('status', e.target.value)} disabled={!canEditFields}>
                {TASK_STATUS.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
              </select></label>
              <label className="tk-f">Due date<input type="date" value={form.due_date} onChange={(e) => setF('due_date', e.target.value)} disabled={!canEditFields} /></label>
            </div>

            {canAssign ? (
              <label className="tk-f">Assignee<select value={form.assignee_email} onChange={(e) => setF('assignee_email', e.target.value)} disabled={!canEditFields}>
                <option value="">Unassigned</option>
                {deptMembers.map((m) => <option key={m.email} value={m.email}>{(m.name || m.email)}{m.title === 'manager' ? ' · mgr' : ''}</option>)}
                {form.assignee_email && !deptMembers.some((m) => m.email === form.assignee_email) && <option value={form.assignee_email}>{form.assignee_email}</option>}
              </select></label>
            ) : (
              <label className="tk-chk" style={{ marginTop: 10 }}><input type="checkbox" checked={form.assignee_email === me?.email} disabled={!canEditFields} onChange={(e) => setF('assignee_email', e.target.checked ? me.email : '')} /> Assign to me</label>
            )}

            <label className="tk-f">Notes<textarea rows={4} value={form.description} onChange={(e) => setF('description', e.target.value)} disabled={!canEditFields} placeholder="Details, links, context…" /></label>

            {msg && <p className="error">{msg}</p>}

            <div className="tk-actions">
              {canEditFields && <button onClick={save} disabled={busy || !canSave}>{editing ? 'Save' : 'Create task'}</button>}
              {canDelete && <button className="secondary" onClick={del} disabled={busy} style={{ marginLeft: 'auto' }}>Delete</button>}
              <button className="secondary" onClick={close} disabled={busy} style={canDelete ? {} : { marginLeft: 'auto' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .tk-chk { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
        .tp-card { background:var(--surface); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; box-shadow:var(--shadow); }
        .tp-card.done { border-color:#16a34a; }
        .tp-head { display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; }
        .tp-caret { color:var(--muted); width:12px; }
        .tp-proj { font-weight:700; font-size:12px; background:#0f172a; color:#fff; padding:1px 8px; border-radius:999px; }
        .tp-name { font-weight:600; font-size:14px; }
        .tp-complete { margin-left:auto; }
        .tp-body { padding:0 14px 14px; border-top:1px dashed var(--line); }
        .tp-by { margin:10px 0 4px; color:#16a34a; }
        .tk-row { display:flex; align-items:center; gap:10px; padding:8px 6px; border-bottom:1px solid var(--line); cursor:pointer; font-size:13.5px; }
        .tk-row:hover { background:rgba(0,0,0,.02); }
        .tk-sdot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
        .tk-rtitle { font-weight:500; flex:1 1 auto; min-width:0; word-break:break-word; }
        .tk-pri { font-size:10px; flex:0 0 auto; }
        .tk-rassignee { flex:0 0 auto; }
        .tk-deptchip { background:#eef2f7; padding:0 6px; border-radius:4px; font-size:11px; color:#334155; }
        .tk-quick { font-size:12px; padding:2px 6px; flex:0 0 auto; }
        .tp-add { margin-top:10px; }
        .tk-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow:auto; }
        .tk-modal { width:520px; max-width:96vw; background:var(--surface); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.3); padding:18px; }
        .tk-modalhead { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:10px; border-bottom:1px solid var(--line); }
        .tk-f { display:grid; gap:4px; font-size:13px; color:var(--muted); margin-top:10px; }
        .tk-f input, .tk-f select, .tk-f textarea { width:100%; }
        .tk-frow { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .tk-actions { display:flex; gap:8px; margin-top:18px; }
      `}</style>
    </>
  );
}
