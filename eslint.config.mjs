import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-dev/**',
      '**/coverage/**',
      'apps/api/**',
      'apps/web/next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: [
      'packages/sim-engine/src/**/*.ts',
      'packages/network-analyzer/src/**/*.ts',
      'packages/cost-engine/src/**/*.ts',
      'packages/diagnosis/src/**/*.ts',
      'packages/terraform/src/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['react', 'react-*', 'next', 'next/*', 'node:*'],
          paths: ['fs', 'path', 'http', 'https', 'net', 'child_process', 'crypto', 'os'],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage'],
    },
  },
  {
    files: ['packages/sim-engine/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded PRNG inside packages/sim-engine instead of Math.random().',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Use virtual simulation clock inside packages/sim-engine instead of Date.now().',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Do not construct Date inside packages/sim-engine; use virtual time.',
        },
      ],
    },
  },
  prettierConfig,
);
