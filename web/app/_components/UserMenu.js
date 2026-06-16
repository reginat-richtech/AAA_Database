'use client';
import { signOut } from 'next-auth/react';

// Signed-in identity + sign-out, shown at the right of the top bar.
export default function UserMenu({ email, isAdmin }) {
  return (
    <div className="usermenu">
      <span className="um-id" title={email}>
        {email}
        {isAdmin && <span className="um-badge">admin</span>}
      </span>
      <button className="um-signout" onClick={() => signOut({ callbackUrl: '/signin' })}>
        Sign out
      </button>
    </div>
  );
}
