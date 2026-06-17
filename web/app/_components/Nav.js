'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const WORKFLOW = [
  { href: '/data-upload', label: 'Data Upload', icon: 'DU' },
  { href: '/tech-request', label: 'Tech Request', icon: 'TR' },
  { href: '/project-tracker', label: 'Project Tracker', icon: 'PT' },
];
// AI intelligence tabs — admin-only (company-wide CRM / finance / travel data).
const AI = [
  { href: '/hubspot-ai', label: 'HubSpot AI', icon: 'HS', key: 'hubspot' },
  { href: '/finance-ai', label: 'Finance AI', icon: 'FI', key: 'finance' },
  { href: '/travel-ai', label: 'Travel AI', icon: 'TV', key: 'travel' },
];

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
        title={collapsed ? n.label : undefined}
      >
        <span className="nav-ic" aria-hidden="true">{n.icon}</span>
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
          <div className="nav-sep"><span className="nav-lbl">AI Agents</span></div>
          {AI.map(renderLink)}
        </>
      )}
    </nav>
  );
}
