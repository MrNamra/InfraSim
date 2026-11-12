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
    ],
  };
}
