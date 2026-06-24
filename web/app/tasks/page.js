'use client';
import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../_components/blueprint';
import { DEPARTMENTS, DEPARTMENT_LABEL } from '../../lib/orgRoles';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PCOLOR = { low: '#94a3b8', medium: '#0ea5e9', high: '#f59e0b', urgent: '#dc2626' };
const who = (e) => (e ? String(e).split('@')[0] : '');
const ymd = (d) => (d ? String(d).slice(0, 10) : '');
const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'col');

export default function Tasks() {
  const [data, setData] = useState({ me: null, workspaces: [], selectedId: null, role: null, sheets: [], tasks: [], members: [], people: [] });
  const [wsId, setWsId] = useState(null);
  const [sheetId, setSheetId] = useState(null);
  const [view, setView] = useState('board');
  const [busy, setBusy] = useState(false);
  const [addText, setAddText] = useState({});         // per-column "add task" input
  const [edit, setEdit] = useState(null);             // task editor modal
  const [modal, setModal] = useState(null);           // 'ws' | 'sheet' | 'members' | 'columns'
  const [draft, setDraft] = useState('');             // generic name input for ws/sheet modals
  const [wsDept, setWsDept] = useState('');           // department for the new-workspace modal
  const [memberDraft, setMemberDraft] = useState({ email: '', role: 'member' });
  const [colDraft, setColDraft] = useState([]);        // columns editor working copy
  const [confirmDone, setConfirmDone] = useState(null); // { id, name, to } — prep done confirm (admin)
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const load = useCallback((ws) => {
    const url = ws ? `/api/pm?workspace=${encodeURIComponent(ws)}` : '/api/pm';
    fetch(url).then((r) => r.json()).then((d) => {
      if (!d || d.error) return;
      setData(d); setWsId(d.selectedId);
      setSheetId((prev) => ((d.sheets || []).some((s) => s.id === prev) ? prev : (d.sheets[0]?.id || null)));
    }).catch(() => {});
  }, []);
  useEffect(() => { load(null); }, [load]);

  const role = data.role;
  const canWrite = !!role && role !== 'viewer';
  const canManage = role === 'owner' || role === 'admin';
  const canConfirm = !!data.me && (data.me.isAdmin || data.me.title === 'manager');   // who can confirm a prep task done
  const ws = data.workspaces.find((w) => w.id === wsId) || null;
  const sheet = data.sheets.find((s) => s.id === sheetId) || null;
  const columns = sheet?.columns || [];
  const sheetTasks = data.tasks.filter((t) => t.sheet_id === sheetId);

  async function api(url, method, body) {
    setBusy(true);
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    setBusy(false);
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || `${method} failed`); return null; }
    return r.json().catch(() => ({}));
  }

  // Workspaces
  // Departments the user may assign a new workspace to (non-admins: own dept only).
  const deptChoices = data.me?.isAdmin ? DEPARTMENTS : (data.me?.department ? [data.me.department] : []);
  function openWorkspaceModal() {
    setDraft('');
    setWsDept(data.me?.isAdmin ? '' : (data.me?.department || ''));
    setModal('ws');
  }
  async function createWorkspace() {
    const name = draft.trim(); if (!name) return;
    const w = await api('/api/pm/workspaces', 'POST', { name, department: wsDept || null });
    setModal(null); setDraft(''); setWsDept(''); if (w?.id) load(w.id);
  }
  async function deleteWorkspace() {
    if (!ws || !window.confirm(`Delete workspace "${ws.name}" and all its sheets/tasks?`)) return;
    await api(`/api/pm/workspaces/${ws.id}`, 'DELETE'); load(null);
  }
  // Sheets
  async function createSheet() {
    const name = draft.trim(); if (!name || !wsId) return;
    const s = await api('/api/pm/sheets', 'POST', { workspace_id: wsId, name });
    setModal(null); setDraft(''); load(wsId); if (s?.id) setSheetId(s.id);
  }
  async function deleteSheet() {
    if (!sheet || !window.confirm(`Delete sheet "${sheet.name}" and its tasks?`)) return;
    await api(`/api/pm/sheets/${sheet.id}`, 'DELETE'); load(wsId);
  }
  async function toggleSheetDone(id, done) {
    await api(`/api/pm/sheets/${id}`, 'PATCH', { done });
    load(wsId);
  }
  async function saveColumns() {
    const cols = colDraft.filter((c) => c.name.trim()).map((c) => ({ id: c.id || slug(c.name), name: c.name.trim(), color: c.color || '#94a3b8' }));
    if (!cols.length) return;
    await api(`/api/pm/sheets/${sheet.id}`, 'PATCH', { columns: cols });
    setModal(null); load(wsId);
  }
  // Tasks
  async function createTask(column_id) {
    const title = (addText[column_id] || '').trim(); if (!title) return;
    await api('/api/pm/tasks', 'POST', { sheet_id: sheetId, column_id, title });
    setAddText((s) => ({ ...s, [column_id]: '' })); load(wsId);
  }
  async function saveTask() {
    const { id, ...fields } = edit;
    if (id) await api(`/api/pm/tasks/${id}`, 'PATCH', fields);
    setEdit(null); load(wsId);
  }
  async function deleteTask(id) {
    if (!window.confirm('Delete this task?')) return;
    await api(`/api/pm/tasks/${id}`, 'DELETE'); setEdit(null); load(wsId);
  }
  async function reorderDrop(colId, beforeId) {
    if (!dragId) return;
    const ordered = sheetTasks.filter((t) => t.column_id === colId)
      .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
      .map((t) => t.id).filter((x) => x !== dragId);
    let idx = beforeId ? ordered.indexOf(beforeId) : ordered.length;
    if (idx < 0) idx = ordered.length;
    ordered.splice(idx, 0, dragId);
    setDragId(null); setDragOver(null);
    await api('/api/pm/tasks/reorder', 'POST', { sheet_id: sheetId, column_id: colId, ordered_ids: ordered });
    load(wsId);
  }
  // Members
  async function addMember() {
    const email = memberDraft.email.trim(); if (!email) return;
    await api(`/api/pm/workspaces/${wsId}/members`, 'POST', { email, role: memberDraft.role });
    setMemberDraft({ email: '', role: 'member' }); load(wsId);
  }
  async function removeMember(email) {
    await api(`/api/pm/workspaces/${wsId}/members?email=${encodeURIComponent(email)}`, 'DELETE'); load(wsId);
  }

  const assigneeOptions = (data.people || []).map((p) => ({ email: p.email, name: p.name || who(p.email) }));

  return (
    <>
      <PageHeader title="Task Tracking" sub="PM workspaces → sheets → tasks. Custom Kanban columns, drag-and-drop, and members — ported from the old PM tracker." sheet="Task Tracking" />

      {/* Workspace bar */}
      <div className="toolbar">
        <select value={wsId || ''} onChange={(e) => load(e.target.value)} style={{ minWidth: 220 }}>
          {data.workspaces.length === 0 && <option value="">No workspaces</option>}
          {data.workspaces.map((w) => <option key={w.id} value={w.id}>{w.icon} {w.name}</option>)}
        </select>
        <button onClick={openWorkspaceModal}>+ Workspace</button>
        {ws && canManage && !ws.department && <button className="secondary" onClick={() => setModal('members')}>Members ({data.members.length})</button>}
        {ws && canManage && <button className="secondary" onClick={deleteWorkspace}>Delete workspace</button>}
        {ws?.department && <span className="chip">👥 {DEPARTMENT_LABEL[ws.department] || ws.department} team</span>}
        {ws && <span className="note" style={{ marginLeft: 'auto' }}>your role: {role}</span>}
      </div>

      {data.workspaces.length === 0 ? (
        <div className="panel"><p className="note" style={{ margin: 0 }}>No workspaces yet — create one to start tracking tasks across sheets.</p></div>
      ) : (
        <>
          {/* Sheet tabs */}
          <div className="pm-tabs">
            {data.sheets.map((s) => (
              <button key={s.id} className={'pm-tab' + (s.id === sheetId ? ' on' : '') + (s.done ? ' done' : '')} onClick={() => setSheetId(s.id)}>
                {s.done && s.stage_key ? '✓ ' : ''}{s.name}
              </button>
            ))}
            {canWrite && <button className="pm-tab pm-tab-add" onClick={() => { setDraft(''); setModal('sheet'); }}>+ Sheet</button>}
          </div>

          {!sheet ? (
            <div className="panel"><p className="note" style={{ margin: 0 }}>No sheets yet — add one with “+ Sheet”.</p></div>
          ) : (
            <>
              <div className="toolbar">
                <div className="tk-viewtoggle">
                  <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
                  <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
                </div>
                {canWrite && <button className="secondary" onClick={() => { setColDraft(columns.map((c) => ({ ...c }))); setModal('columns'); }}>Edit columns</button>}
                {canWrite && <button className="secondary" onClick={deleteSheet}>Delete sheet</button>}
                <span className="note" style={{ marginLeft: 'auto' }}>{sheetTasks.length} task(s)</span>
                {sheet.stage_key && (
                  <button className={'pm-donebtn' + (sheet.done ? ' on' : '')} disabled={!canConfirm}
                    title={canConfirm ? 'Confirm this prep task as done' : 'Only an admin or manager can confirm'}
                    onClick={() => setConfirmDone({ id: sheet.id, name: sheet.name, to: !sheet.done })}>
                    {sheet.done ? '✓ Done' : 'Mark done'}
                  </button>
                )}
              </div>

              {view === 'board' && (
                <div className="pmk-board">
                  {columns.map((col) => {
                    const colTasks = sheetTasks.filter((t) => t.column_id === col.id).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
                    return (
                      <div key={col.id} className={'pmk-col' + (dragOver === col.id ? ' drag-over' : '')}
                        onDragOver={(e) => { e.preventDefault(); if (dragOver !== col.id) setDragOver(col.id); }}
                        onDragLeave={() => setDragOver((c) => (c === col.id ? null : c))}
                        onDrop={() => reorderDrop(col.id, null)}>
                        <div className="pmk-colhd"><span className="pmk-dot" style={{ background: col.color }} /> {col.name} <span className="note">{colTasks.length}</span></div>
                        <div className="pmk-cards">
                          {colTasks.map((t) => (
                            <div key={t.id} className="pmk-card" draggable={canWrite}
                              onDragStart={() => setDragId(t.id)} onDragEnd={() => { setDragId(null); setDragOver(null); }}
                              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); reorderDrop(col.id, t.id); }}
                              onClick={() => setEdit({ id: t.id, title: t.title, description: t.description || '', column_id: t.column_id, priority: t.priority, assignee_email: t.assignee_email || '', due_date: ymd(t.due_date) })}>
                              <div className="pmk-title">{t.title}</div>
                              <div className="pmk-meta">
                                <span className="pmk-pri" style={{ color: PCOLOR[t.priority] }}>● {t.priority}</span>
                                {t.assignee_email && <span className="note">{who(t.assignee_email)}</span>}
                                {t.due_date && <span className="note">📅 {ymd(t.due_date)}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                        {canWrite && (
                          <div className="pmk-add">
                            <input placeholder="+ Add task" value={addText[col.id] || ''} onChange={(e) => setAddText((s) => ({ ...s, [col.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') createTask(col.id); }} disabled={busy} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {view === 'table' && (
                <div className="panel tablewrap">
                  <table>
                    <thead><tr><th>Task</th><th>Column</th><th>Priority</th><th>Assignee</th><th>Due</th></tr></thead>
                    <tbody>
                      {sheetTasks.length ? sheetTasks.map((t) => {
                        const col = columns.find((c) => c.id === t.column_id);
                        return (
                          <tr key={t.id} className="pm-trow" onClick={() => setEdit({ id: t.id, title: t.title, description: t.description || '', column_id: t.column_id, priority: t.priority, assignee_email: t.assignee_email || '', due_date: ymd(t.due_date) })}>
                            <td>{t.title}</td>
                            <td><span className="chip" style={{ background: (col?.color || '#94a3b8') + '22', color: col?.color || '#64748b' }}>{col?.name || t.column_id}</span></td>
                            <td style={{ color: PCOLOR[t.priority] }}>● {t.priority}</td>
                            <td className="note">{who(t.assignee_email)}</td>
                            <td className="note">{ymd(t.due_date)}</td>
                          </tr>
                        );
                      }) : <tr><td colSpan={5} className="note">No tasks yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Task editor */}
      {edit && (
        <div className="pm-overlay" onClick={() => setEdit(null)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pm-mhead"><b>Edit task</b><button className="secondary" onClick={() => setEdit(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <label className="pm-f">Title<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} disabled={!canWrite} /></label>
            <div className="pm-frow">
              <label className="pm-f">Column<select value={edit.column_id} onChange={(e) => setEdit({ ...edit, column_id: e.target.value })} disabled={!canWrite}>
                {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
              <label className="pm-f">Priority<select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} disabled={!canWrite}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select></label>
            </div>
            <div className="pm-frow">
              <label className="pm-f">Assignee<select value={edit.assignee_email} onChange={(e) => setEdit({ ...edit, assignee_email: e.target.value })} disabled={!canWrite}>
                <option value="">Unassigned</option>
                {assigneeOptions.map((m) => <option key={m.email} value={m.email}>{m.name}</option>)}
                {edit.assignee_email && !assigneeOptions.some((m) => m.email === edit.assignee_email) && <option value={edit.assignee_email}>{who(edit.assignee_email)}</option>}
              </select></label>
              <label className="pm-f">Due date<input type="date" value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} disabled={!canWrite} /></label>
            </div>
            <label className="pm-f">Description<textarea rows={4} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} disabled={!canWrite} /></label>
            <div className="pm-mactions">
              {canWrite && <button onClick={saveTask} disabled={busy || !edit.title.trim()}>Save</button>}
              {canWrite && <button className="secondary" onClick={() => deleteTask(edit.id)} disabled={busy} style={{ marginLeft: 'auto' }}>Delete</button>}
              <button className="secondary" onClick={() => setEdit(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm prep-done (admin only) */}
      {confirmDone && (
        <div className="pm-overlay" onClick={() => setConfirmDone(null)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="pm-mhead"><b>{confirmDone.to ? 'Mark prep task done?' : 'Reopen prep task?'}</b></div>
            <p className="note" style={{ marginTop: 0 }}>“{confirmDone.name}” — this updates the Team Preparation step on the Project Tracker.</p>
            <div className="pm-mactions">
              <button onClick={async () => { await toggleSheetDone(confirmDone.id, confirmDone.to); setConfirmDone(null); }} disabled={busy}>Confirm</button>
              <button className="secondary" onClick={() => setConfirmDone(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* New workspace / sheet modal */}
      {(modal === 'ws' || modal === 'sheet') && (
        <div className="pm-overlay" onClick={() => setModal(null)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pm-mhead"><b>{modal === 'ws' ? 'New workspace' : 'New sheet'}</b><button className="secondary" onClick={() => setModal(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <label className="pm-f">Name<input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (modal === 'ws' ? createWorkspace() : createSheet()); }} placeholder={modal === 'ws' ? 'e.g. Q3 Installs' : 'e.g. Backlog'} /></label>
            {modal === 'ws' && (
              <label className="pm-f">Department
                <select value={wsDept} onChange={(e) => setWsDept(e.target.value)}>
                  <option value="">No department (private workspace)</option>
                  {deptChoices.map((d) => <option key={d} value={d}>{DEPARTMENT_LABEL[d] || d}</option>)}
                </select>
              </label>
            )}
            {modal === 'ws' && (
              <p className="note" style={{ margin: '2px 0 0' }}>{wsDept ? `Only the ${DEPARTMENT_LABEL[wsDept] || wsDept} team can access this workspace.` : 'Private to the members you add.'}</p>
            )}
            <div className="pm-mactions"><button onClick={modal === 'ws' ? createWorkspace : createSheet} disabled={busy || !draft.trim()}>Create</button><button className="secondary" onClick={() => setModal(null)}>Cancel</button></div>
          </div>
        </div>
      )}

      {/* Members modal */}
      {modal === 'members' && (
        <div className="pm-overlay" onClick={() => setModal(null)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pm-mhead"><b>Members — {ws?.name}</b><button className="secondary" onClick={() => setModal(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <ul className="pm-members">
              {data.members.map((m) => (
                <li key={m.id}><span>{m.user_email}</span><span className="chip">{m.role}</span>
                  {canManage && m.role !== 'owner' && <button className="pm-rm" onClick={() => removeMember(m.user_email)} disabled={busy}>✕</button>}
                </li>
              ))}
            </ul>
            {canManage && (
              <div className="pm-frow" style={{ alignItems: 'end' }}>
                <label className="pm-f">Email<input value={memberDraft.email} onChange={(e) => setMemberDraft({ ...memberDraft, email: e.target.value })} placeholder="name@richtechsystem.com" /></label>
                <label className="pm-f">Role<select value={memberDraft.role} onChange={(e) => setMemberDraft({ ...memberDraft, role: e.target.value })}>
                  <option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option>
                </select></label>
                <button onClick={addMember} disabled={busy || !memberDraft.email.trim()}>Add</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Columns editor */}
      {modal === 'columns' && (
        <div className="pm-overlay" onClick={() => setModal(null)}>
          <div className="pm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pm-mhead"><b>Columns — {sheet?.name}</b><button className="secondary" onClick={() => setModal(null)} style={{ marginLeft: 'auto' }}>✕</button></div>
            <p className="note" style={{ marginTop: 0 }}>Rename, recolor, add or remove Kanban columns. Tasks in a removed column move to the first column.</p>
            {colDraft.map((c, i) => (
              <div key={i} className="pm-colrow">
                <input type="color" value={c.color || '#94a3b8'} onChange={(e) => setColDraft((d) => d.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
                <input value={c.name} onChange={(e) => setColDraft((d) => d.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Column name" />
                <button className="pm-rm" onClick={() => setColDraft((d) => d.filter((_, j) => j !== i))} title="Remove">✕</button>
              </div>
            ))}
            <button className="secondary" onClick={() => setColDraft((d) => [...d, { id: '', name: '', color: '#94a3b8' }])} style={{ marginTop: 6 }}>+ Add column</button>
            <div className="pm-mactions"><button onClick={saveColumns} disabled={busy}>Save columns</button><button className="secondary" onClick={() => setModal(null)}>Cancel</button></div>
          </div>
        </div>
      )}

      <style>{`
        .pm-tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; border-bottom:1px solid var(--line); padding-bottom:8px; }
        .pm-tab { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); background:var(--surface); border-radius:8px 8px 0 0; padding:7px 14px; font:inherit; cursor:pointer; color:var(--muted); }
        .pm-tab.on { background:var(--primary); color:#fff; border-color:var(--primary); font-weight:600; }
        .pm-tab.done:not(.on) { border-color:#16a34a; color:#16a34a; }
        .pm-tab-add { color:var(--primary); }
        .pm-donebtn { border:1px solid var(--line); background:var(--surface); border-radius:8px; padding:6px 14px; font:inherit; cursor:pointer; color:var(--muted); }
        .pm-donebtn:hover:not(:disabled) { border-color:var(--primary); }
        .pm-donebtn:disabled { opacity:.5; cursor:not-allowed; }
        .pm-donebtn.on { background:#16a34a; color:#fff; border-color:#16a34a; font-weight:600; }
        .tk-viewtoggle { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
        .tk-viewtoggle button { border:0; background:var(--surface); padding:6px 14px; font:inherit; cursor:pointer; color:var(--muted); }
        .tk-viewtoggle button + button { border-left:1px solid var(--line); }
        .tk-viewtoggle button.on { background:var(--primary); color:#fff; }
        .pmk-board { display:flex; gap:12px; overflow-x:auto; align-items:flex-start; padding-bottom:10px; }
        .pmk-col { flex:1 1 0; min-width:240px; background:#f1f1ef; border:1px solid var(--line); border-radius:10px; display:flex; flex-direction:column; }
        .pmk-col.drag-over { background:#e6effb; box-shadow:inset 0 0 0 2px rgba(37,99,235,.25); }
        .pmk-colhd { display:flex; align-items:center; gap:8px; padding:10px 12px; font-size:12px; font-weight:600; }
        .pmk-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
        .pmk-cards { padding:4px 8px; display:flex; flex-direction:column; gap:6px; min-height:24px; }
        .pmk-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:9px 11px; cursor:pointer; box-shadow:var(--shadow); }
        .pmk-card:hover { box-shadow:0 6px 18px rgba(0,0,0,.08); transform:translateY(-1px); }
        .pmk-title { font-size:13px; font-weight:600; margin-bottom:5px; word-break:break-word; }
        .pmk-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:11px; }
        .pmk-pri { font-weight:600; text-transform:capitalize; }
        .pmk-add { padding:6px 8px 10px; } .pmk-add input { width:100%; font-size:12px; padding:5px 8px; }
        .pm-trow { cursor:pointer; } .pm-trow:hover td { background:rgba(37,99,235,.035); }
        .pm-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:48px 16px; overflow:auto; }
        .pm-modal { width:520px; max-width:96vw; background:var(--surface); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.3); padding:18px; }
        .pm-mhead { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:6px; border-bottom:1px solid var(--line); }
        .pm-f { display:grid; gap:4px; font-size:13px; color:var(--muted); margin-top:10px; }
        .pm-f input, .pm-f select, .pm-f textarea { width:100%; }
        .pm-frow { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .pm-mactions { display:flex; gap:8px; margin-top:18px; }
        .pm-members { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
        .pm-members li { display:flex; align-items:center; gap:8px; font-size:13px; }
        .pm-rm { border:0; background:transparent; color:var(--muted); cursor:pointer; }
        .pm-rm:hover { color:var(--bad); }
        .pm-colrow { display:flex; align-items:center; gap:8px; margin-top:8px; }
        .pm-colrow input[type=color] { width:34px; height:30px; padding:0; border:1px solid var(--line); border-radius:6px; }
        .pm-colrow input:not([type=color]) { flex:1; }
      `}</style>
    </>
  );
}
