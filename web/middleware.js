// Gate the whole app behind Google sign-in. Unauthenticated page requests are
// redirected to /signin; unauthenticated API calls get 401 JSON. The Auth.js
// endpoints, the sign-in page, and external JotForm webhooks stay public.
import { auth } from './auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  const { pathname, search, origin } = req.nextUrl;

  const isPublic =
    pathname.startsWith('/api/auth') ||        // Auth.js sign-in/callback/session
    pathname.startsWith('/api/webhooks') ||    // external JotForm stage callbacks
    pathname.startsWith('/api/admin/sync') ||  // dual-auth (admin session OR cron secret) — enforced in the route
    pathname === '/signin';
  if (isPublic) return NextResponse.next();

  if (!req.auth) {
    if (pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    }
    const url = new URL('/signin', origin);
    url.searchParams.set('callbackUrl', pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  // Everything except Next internals and static asset files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|woff2?)$).*)'],
};
