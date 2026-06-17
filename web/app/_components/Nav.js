'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const WORKFLOW = [
  { href: '/project-tracker', label: 'Project Tracker', icon: 'list' },
  { href: '/data-upload', label: 'Data Upload', icon: 'upload' },
  { href: '/tech-request', label: 'Tech Request', icon: 'tool' },
];
// AI intelligence tabs — admin-only (company-wide CRM / finance / travel data).
const AI = [
  { href: '/hubspot-ai', label: 'HubSpot AI', icon: 'users', key: 'hubspot' },
  { href: '/finance-ai', label: 'Finance AI', icon: 'dollar', key: 'finance' },
  { href: '/travel-ai', label: 'Travel AI', icon: 'plane', key: 'travel' },
];

// Inline line-icons (Feather-style). stroke=currentColor so they inherit the
// sidebar text color and turn white on the active link.
function Icon({ name }) {
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'upload': return (<svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>);
    case 'tool': return (<svg {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>);
    case 'list': return (<svg {...p}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>);
    case 'users': return (<svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>);
    case 'dollar': return (<svg {...p}><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>);
    case 'plane': return (<svg {...p}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>);
    case 'database': return (<svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 5v6c0 1.66-4 3-9 3s-9-1.34-9-3V5" /><path d="M21 11v8c0 1.66-4 3-9 3s-9-1.34-9-3v-8" /></svg>);
    case 'sync': return (<svg {...p}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>);
    default: return null;
  }
}

export default function Nav({ collapsed = false, isAdmin = false }) {
  const path = usePathname();
  const [counts, setCounts] = useState({});

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    fetch('/api/ai/counts')
      .then((r) => r.json())
      .then((d) => { if (alive) setCounts(d || {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isAdmin]);

  const renderLink = (n) => {
    const active = path.startsWith(n.href);
    const badge = n.key ? counts[n.key] : null;
    return (
      <Link
        key={n.href}
        href={n.href}
        className={active ? 'active' : ''}
        aria-current={active ? 'page' : undefined}
        aria-label={n.label}
        title={collapsed ? n.label : undefined}
      >
        <span className="nav-ic" aria-hidden="true"><Icon name={n.icon} /></span>
        <span className="nav-lbl">{n.label}</span>
        {badge != null && badge > 0 && <span className="nav-badge">{badge}</span>}
      </Link>
    );
  };

  return (
    <nav>
      {WORKFLOW.map(renderLink)}
      {isAdmin && (
        <>
          <div className="nav-sep"><span className="nav-lbl">Admin</span></div>
          {renderLink({ href: '/database', label: 'Database', icon: 'database' })}
          {renderLink({ href: '/data-sync', label: 'Data Sync', icon: 'sync' })}
          <div className="nav-sep"><span className="nav-lbl">AI Agents</span></div>
          {AI.map(renderLink)}
        </>
      )}
    </nav>
  );
}
