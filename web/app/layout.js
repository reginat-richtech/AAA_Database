import './globals.css';
import Sidebar from './_components/Sidebar';
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
          {email ? (
            <div className="shell">
              <Sidebar email={email} isAdmin={isAdminEmail(email)} />
              <main className="container">{children}</main>
            </div>
          ) : (
            <main className="container">{children}</main>
          )}
        </Providers>
      </body>
    </html>
  );
}
