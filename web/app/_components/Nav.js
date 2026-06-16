'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/data-upload', label: 'Data Upload' },
  { href: '/tech-request', label: 'Tech Request' },
  { href: '/project-tracker', label: 'Project Tracker' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav>
      {NAV.map((n) => {
        const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
