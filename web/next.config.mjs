/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the native 'pg' driver out of the server bundle (it must run on Node).
  serverExternalPackages: ['pg', 'pdf-parse'],
};

export default nextConfig;
