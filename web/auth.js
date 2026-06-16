// Google sign-in via Auth.js (NextAuth v5). Single-company internal tool:
// only verified corporate Google accounts may sign in. Session is a stateless
// JWT cookie (no DB adapter needed), so this config is edge-safe for middleware.
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

// Domains allowed to sign in. Reuses the old app's ALLOWED_OAUTH_DOMAINS env;
// falls back to the two corporate domains if unset.
const ALLOWED_DOMAINS = (process.env.ALLOWED_OAUTH_DOMAINS || 'richtechsystem.com,richtechrobotics.com')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Required off-Vercel (localhost + Azure App Service sit behind a proxy).
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Always show the account chooser so users can pick the right work account.
      authorization: { params: { prompt: 'select_account' } },
    }),
  ],
  pages: { signIn: '/signin' },
  session: { strategy: 'jwt' },
  callbacks: {
    // Gate sign-in to verified emails on an allowed corporate domain.
    async signIn({ profile }) {
      const email = profile?.email;
      if (!email) return false;
      if (profile?.email_verified === false) return false;
      if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(emailDomain(email))) return false;
      return true;
    },
    async jwt({ token, profile }) {
      if (profile?.email) token.email = profile.email.toLowerCase();
      if (profile?.name) token.name = profile.name;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        if (token.email) session.user.email = token.email;
        if (token.name) session.user.name = token.name;
      }
      return session;
    },
  },
});
