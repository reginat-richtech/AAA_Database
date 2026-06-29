/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → a small, self-contained server bundle for the container image.
  output: 'standalone',
  // Keep these out of the server bundle: native 'pg' driver, and 'unpdf' (its
  // bundled pdf.js shouldn't be re-bundled/mangled by webpack).
  serverExternalPackages: ['pg', 'unpdf'],
  // DEV ONLY: disable webpack's filesystem cache. Its atomic rename of
  // .next/cache/webpack/*.pack.gz races and corrupts .next, which surfaces as
  // unstyled pages or /api/auth/session 500s after a hot-reload. Guarded by `dev`,
  // so the production build (`next build`, dev === false) is unaffected.
  webpack: (config, { dev }) => {
    if (dev) config.cache = false;
    return config;
  },
};

export default nextConfig;
