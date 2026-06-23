'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { prefetchAi } from '../../lib/aiCache';

const WORKFLOW = [
  { href: '/project-tracker', label: 'Project Tracker', icon: 'list' },
  { href: '/tasks', label: 'Task Tracking', icon: 'check' },
  { href: '/inventory', label: 'Inventory', icon: 'box' },
  { href: '/social', label: 'Social Media', icon: 'share' },
  // Data Upload and Tech Request are intentionally hidden from the nav — their
  // pages still work: /data-upload directly, and /tech-request is opened per
  // project from the Project Tracker ("Tech Request ↗").
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
    case 'shield': return (<svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>);
    case 'share': return (<svg {...p}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>);
    case 'check': return (<svg {...p}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>);
    case 'box': return (<svg {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>);
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
    // Warm the AI tab caches so opening any tab or alert detail is instant.
    prefetchAi(['/api/ai/hubspot', '/api/ai/travel?days=7', '/api/ai/finance']);
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
          {renderLink({ href: '/users', label: 'Users', icon: 'shield' })}
          <div className="nav-sep"><span className="nav-lbl">AI Agents</span></div>
          {AI.map(renderLink)}
        </>
      )}
    </nav>
  );
}
