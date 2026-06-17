'use client';
import { useEffect, useState } from 'react';
import Nav from './Nav';
import UserMenu from './UserMenu';

const KEY = 'aaa.sidebar.collapsed';

// Left sidebar with an expand/compress toggle. Collapsed state is remembered in
// localStorage. (Starts expanded on first render to match the server output, then
// restores the saved preference after mount — avoids a hydration mismatch.)
export default function Sidebar({ email, isAdmin }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { if (localStorage.getItem(KEY) === '1') setCollapsed(true); } catch {}
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="side-top">
        <div className="brand">AAA<span>·Admin</span></div>
        <button
          type="button"
          className="side-toggle"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      <Nav collapsed={collapsed} isAdmin={isAdmin} />
      <UserMenu email={email} isAdmin={isAdmin} collapsed={collapsed} />
    </aside>
  );
}
