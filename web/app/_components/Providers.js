'use client';
import { SessionProvider } from 'next-auth/react';

// Makes the server-resolved session available to client components (UserMenu,
// useSession). The session is passed down from the root layout.
export default function Providers({ children, session }) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
