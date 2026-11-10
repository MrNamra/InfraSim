import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@infrasim/ui-kit', '@infrasim/shared-types'],
};

export default nextConfig;
