/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → a small, self-contained server bundle for the container image.
  output: 'standalone',
  // Keep the native 'pg' driver out of the server bundle (it must run on Node).
  serverExternalPackages: ['pg', 'pdf-parse'],
};

export default nextConfig;
