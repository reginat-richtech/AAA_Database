'use client';
import { signOut } from 'next-auth/react';

// Signed-in identity + sign-out. In the collapsed sidebar it shrinks to a single
// avatar button (click = sign out); expanded it shows the full email + admin badge.
export default function UserMenu({ email, isAdmin, collapsed = false }) {
  const initial = (email && email[0] ? email[0] : '?').toUpperCase();

  if (collapsed) {
    return (
      <div className="usermenu">
        <button
          type="button"
          className="um-avatar um-avatar-btn"
          title={`${email} — sign out`}
          onClick={() => signOut({ callbackUrl: '/signin' })}
        >
          {initial}
        </button>
      </div>
    );
  }

  return (
    <div className="usermenu">
      <span className="um-id" title={email}>
        <span className="um-avatar" aria-hidden="true">{initial}</span>
        <span className="um-email">{email}</span>
        {isAdmin && <span className="um-badge">admin</span>}
      </span>
      <button className="um-signout" onClick={() => signOut({ callbackUrl: '/signin' })}>
        Sign out
      </button>
    </div>
  );
}
