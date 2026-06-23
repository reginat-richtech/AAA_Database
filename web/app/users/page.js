'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '../_components/blueprint';
import { DEPARTMENTS, DEPARTMENT_LABEL, TITLES } from '../../lib/orgRoles';

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [dept, setDept] = useState('');
  const [title, setTitle] = useState('member');
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    fetch('/api/admin/users')
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Failed to load'); return j; })
      .then((d) => { setUsers(d.users || []); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  // One save path — always sends role + department + title together.
  async function save(addr, fields) {
    setBusy(true); setErr(null);
    const res = await fetch('/api/admin/users', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: addr, ...fields }),
    });
    const j = await res.json(); setBusy(false);
    if (!res.ok) { setErr(j.error || 'Failed'); return; }
    load();
  }
  async function add() {
    const addr = email.trim();
    if (!addr) return;
    await save(addr, { role, department: dept, title });
    setEmail('');
  }
  async function remove(addr) {
    if (!window.confirm(`Remove ${addr}? They revert to a regular user (only their own projects).`)) return;
    setBusy(true); setErr(null);
    const res = await fetch('/api/admin/users?email=' + encodeURIComponent(addr), { method: 'DELETE' });
    const j = await res.json(); setBusy(false);
    if (!res.ok) { setErr(j.error || 'Failed'); return; }
    load();
  }

  const DeptSelect = ({ value, onChange, disabled }) => (
    <select value={value || ''} onChange={onChange} disabled={disabled}>
      <option value="">— none —</option>
      {DEPARTMENTS.map((d) => <option key={d} value={d}>{DEPARTMENT_LABEL[d]}</option>)}
    </select>
  );
  const TitleSelect = ({ value, onChange, disabled }) => (
    <select value={value || 'member'} onChange={onChange} disabled={disabled}>
      {TITLES.map((t) => <option key={t} value={t}>{t === 'manager' ? 'Manager' : 'Member'}</option>)}
    </select>
  );

  return (
    <>
      <PageHeader title="Users" sub="Everyone who has signed in. Role controls system access (Admin sees everything); Department + Title drive Task Tracking (managers run their department's tasks)." sheet="Users" />
      {err && <p className="error">{err}</p>}

      <div className="panel" style={{ maxWidth: 760 }}>
        <h3 style={{ marginTop: 0 }}>Add or update a user</h3>
        <div className="urow">
          <label>Email<input type="email" placeholder="name@richtechsystem.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Admin — sees everything</option>
              <option value="user">Member — own projects only</option>
            </select>
          </label>
          <label>Department<DeptSelect value={dept} onChange={(e) => setDept(e.target.value)} /></label>
          <label>Title<TitleSelect value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={add} disabled={busy || !email.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="note" style={{ marginBottom: 0 }}>Use the person’s exact Google sign-in email. Changes apply on their next page load.</p>
      </div>

      <h2>Users, roles &amp; departments</h2>
      <div className="panel tablewrap">
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Department</th><th>Title</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="note">Loading…</td></tr>
            ) : users.length ? users.map((u) => (
              <tr key={u.email}>
                <td>{u.email}</td>
                <td>
                  {u.source === 'builtin' ? <span className="chip ok">Admin</span> : (
                    <select value={u.role} onChange={(e) => save(u.email, { role: e.target.value, department: u.department, title: u.title })} disabled={busy}>
                      <option value="admin">Admin</option>
                      <option value="user">Member</option>
                    </select>
                  )}
                </td>
                <td><DeptSelect value={u.department} disabled={busy} onChange={(e) => save(u.email, { role: u.role, department: e.target.value, title: u.title })} /></td>
                <td><TitleSelect value={u.title} disabled={busy} onChange={(e) => save(u.email, { role: u.role, department: u.department, title: e.target.value })} /></td>
                <td className="note">{u.last_seen ? new Date(u.last_seen).toLocaleString() : '—'}</td>
                <td>{u.source === 'managed'
                  ? <button className="secondary" onClick={() => remove(u.email)} disabled={busy}>Remove</button>
                  : <span className="note">built-in</span>}</td>
              </tr>
            )) : <tr><td colSpan={6} className="note">No managed users yet — add one above.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="note">Role = system access (Admin vs Member). Department + Title = Task Tracking org model: a <b>Manager</b> runs their department's tasks; a <b>Member</b> works their own. Built-in admins (deploy config) keep the Admin role but can still be given a department/title.</p>

      <style>{`
        .urow { display:grid; grid-template-columns:2fr 1.4fr 1.2fr 1fr; gap:12px; align-items:end; }
        .urow label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
        .urow input, .urow select { width:100%; }
        @media (max-width:680px){ .urow { grid-template-columns:1fr 1fr; } }
      `}</style>
    </>
  );
}
