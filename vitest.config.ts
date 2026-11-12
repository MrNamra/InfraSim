import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const packageAliases: Record<string, string> = {
  '@infrasim/sandbox/fixtures': path.resolve(rootDir, 'packages/sandbox/src/fixtures.ts'),
  '@infrasim/sandbox/doctor': path.resolve(rootDir, 'packages/sandbox/src/doctor.ts'),
  ...[
    'shared-types',
    'catalog',
    'sim-engine',
    'sandbox',
    'network-analyzer',
    'cost-engine',
    'terraform',
    'diagnosis',
    'ui-kit',
  ].reduce<Record<string, string>>((acc, pkg) => {
    acc[`@infrasim/${pkg}`] = path.resolve(rootDir, `packages/${pkg}/src/index.ts`);
    return acc;
  }, {}),
};

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: packageAliases,
  },
  test: {
    maxWorkers: 1,
    include: [
      'apps/web/src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
  },
});
