import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'AAA — Admin',
  description: 'Admin console for the AAA database',
};

const NAV = [
  { href: '/data-upload', label: 'Data Upload' },
  { href: '/tech-request', label: 'Tech Request' },
  { href: '/project-tracker', label: 'Project Tracker' },
];

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">AAA <span>Admin</span></div>
          <nav>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
