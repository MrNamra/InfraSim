import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@infrasim/ui-kit',
    '@infrasim/shared-types',
    '@infrasim/catalog',
    '@infrasim/sim-engine',
    '@infrasim/diagnosis',
  ],
};

export default nextConfig;
