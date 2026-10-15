/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true
  },
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/portfolio', destination: '/portfolio/index.html' },
      { source: '/excel-service', destination: '/excel-service/index.html' },
      { source: '/excel-service/demo', destination: '/excel-service/demo.html' }
    ];
  },
  async headers() {
    return [{
      source: '/portfolio/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]
    }, {
      source: '/excel-service/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]
    }];
  }
};

export default nextConfig;
