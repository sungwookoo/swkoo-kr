import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const portfolioHtml = readFileSync(new URL('./public/portfolio/index.html', import.meta.url), 'utf8');
const scriptHashes = [...portfolioHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => `'sha256-${createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64')}'`).join(' ');
const staticPolicy = (scripts) => `default-src 'self'; script-src 'self' ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  poweredByHeader: false,
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
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
      ]
    }, {
      source: '/portfolio/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Content-Security-Policy', value: staticPolicy(scriptHashes) }]
    }, {
      source: '/excel-service/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Content-Security-Policy', value: staticPolicy('') }]
    }];
  }
};

export default nextConfig;
