/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true
  },
  output: 'standalone',
  async rewrites() {
    return [{ source: '/portfolio', destination: '/portfolio/index.html' }];
  },
  async headers() {
    return [{
      source: '/portfolio/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]
    }];
  }
};

export default nextConfig;
