'use client';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const ERRORS = {
  AccessDenied: 'That account isn’t allowed. Sign in with your @richtechsystem.com or @richtechrobotics.com Google account.',
  Configuration: 'Sign-in is misconfigured. Contact the administrator.',
  Verification: 'The sign-in link expired. Please try again.',
};

function SignInInner() {
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') || '/';
  const error = params.get('error');

  return (
    <div className="signin-wrap">
      <div className="signin-card panel">
        <div className="signin-brand">AAA<span>·Admin</span></div>
        <p className="note">Sign in with your Richtech Google account to continue.</p>
        {error && <p className="error">{ERRORS[error] || 'Sign-in failed. Please try again.'}</p>}
        <button className="google-btn" onClick={() => signIn('google', { callbackUrl })}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          Sign in with Google
        </button>
        <p className="note signin-foot">Access is restricted to authorized company accounts.</p>
      </div>
    </div>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
