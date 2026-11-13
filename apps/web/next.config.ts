import type { NextConfig } from 'next';

/** Creates phase-isolated Next.js config so `next dev` never shares `.next` with `next build`. */
export default function createNextConfig(phase: string): NextConfig {
  const isDevServer = phase === 'phase-development-server';
  return {
    distDir: isDevServer ? '.next-dev' : '.next',
    experimental: {
      devtoolSegmentExplorer: false,
    },
    transpilePackages: [
      '@infrasim/ui-kit',
      '@infrasim/shared-types',
      '@infrasim/catalog',
      '@infrasim/cost-engine',
      '@infrasim/sim-engine',
      '@infrasim/diagnosis',
      '@infrasim/network-analyzer',
      '@infrasim/sandbox',
      '@infrasim/terraform',
    ],
    async headers() {
      return [
        {
          source: '/(.*)',
          headers: [
            {
              key: 'Content-Security-Policy',
              value: [
                "default-src 'self'",
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
                "worker-src 'self' blob:",
                "style-src 'self' 'unsafe-inline'",
                "font-src 'self' data:",
                "img-src 'self' data: blob: https:",
                "connect-src 'self' http://localhost:* http://127.0.0.1:* https://* ws://* wss://*",
                "frame-ancestors 'none'",
                "object-src 'none'",
                "base-uri 'self'",
              ].join('; '),
            },
            {
              key: 'X-Content-Type-Options',
              value: 'nosniff',
            },
            {
              key: 'X-Frame-Options',
              value: 'DENY',
            },
            {
              key: 'Referrer-Policy',
              value: 'strict-origin-when-cross-origin',
            },
          ],
        },
      ];
    },
  };
}
