import './globals.css';
import Nav from './_components/Nav';
import UserMenu from './_components/UserMenu';
import Providers from './_components/Providers';
import { auth } from '../auth';
import { isAdminEmail } from '../lib/access';

export const metadata = {
  title: 'AAA — Admin',
  description: 'Admin console for the AAA database',
};

export default async function RootLayout({ children }) {
  const session = await auth();
  const email = session?.user?.email || null;

  return (
    <html lang="en">
      <body>
        <Providers session={session}>
          {email && (
            <header className="topbar">
              <div className="brand">AAA<span>·Admin</span></div>
              <Nav />
              <UserMenu email={email} isAdmin={isAdminEmail(email)} />
            </header>
          )}
          <main className="container">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
