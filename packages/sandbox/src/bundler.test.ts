import { afterAll, describe, expect, it } from 'vitest';
import type { ScriptAsset } from '@infrasim/shared-types';
import {
  bundleUserScript,
  executeInSandbox,
  isAllowedModuleSpecifier,
  stopSandboxBundler,
} from './index.js';

function makeScript(
  source: string,
  overrides: { id?: string; name?: string; language?: 'javascript' | 'typescript' } = {},
): ScriptAsset {
  return {
    id: overrides.id ?? 'entry',
    name: overrides.name ?? 'handler.ts',
    kind: 'handler',
    language: overrides.language ?? 'typescript',
    entry: 'handler',
    source,
    memoryMb: 128,
    timeoutMs: 3000,
    env: {},
  };
}

describe('T3.2 esbuild-wasm bundler, allow-list modules, TS stripping, source maps', () => {
  afterAll(async () => {
    await stopSandboxBundler();
  });

  it('strips TypeScript types, bundles relative scripts, and maps runtime error sites via Source Map v3', async () => {
    const utilScript = makeScript(
      `
export interface LineItem { price: number; qty: number; }

export function computeTotal(items: LineItem[]): number {
  return items.reduce((acc, item) => acc + item.price * item.qty, 0);
}
      `,
      { id: 'u1', name: 'utils.ts', language: 'typescript' },
    );

    const entryOk = makeScript(
      `
import { computeTotal, type LineItem } from './utils';

export async function handler(event: { items: LineItem[] }) {
  const total = computeTotal(event.items);
  return { statusCode: 200, body: JSON.stringify({ total }) };
}
      `,
      { id: 'main', name: 'handler.ts', language: 'typescript' },
    );

    const okRes = await executeInSandbox({
      script: entryOk,
      designScripts: [utilScript],
      event: {
        items: [
          { price: 12.5, qty: 2 },
          { price: 5, qty: 1 },
        ],
      },
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.result).toEqual({ statusCode: 200, body: '{"total":30}' });

    const entryFail = makeScript(
      [
        '// line 1 comment',
        'interface Payload { name?: string }',
        'function nestedCrash(p: Payload): string {',
        '  const x = (p as { missing: { deep: string } }).missing.deep;',
        '  return x;',
        '}',
        'export async function handler(event: Payload) {',
        '  return nestedCrash(event);',
        '}',
      ].join('\n'),
      { id: 'fail', name: 'crash.ts', language: 'typescript' },
    );

    const failRes = await executeInSandbox({ script: entryFail, event: {} });
    expect(failRes.ok).toBe(false);
    expect(failRes.error?.category).toBe('UnhandledRejection');
    expect(failRes.error?.site?.file).toBe('crash.ts');
    expect(failRes.error?.site?.line).toBe(4);
    expect(failRes.error?.stack).toContain('crash.ts:4:');
  });

  it('bundles allow-listed pure-JS utilities (uuid, lodash, dayjs, zod, ajv) deterministically in virtual time', async () => {
    const script = makeScript(
      `
import { v4 as uuidv4 } from 'uuid';
import _ from 'lodash';
import dayjs from 'dayjs';
import { z } from 'zod';
import Ajv from 'ajv';

const Schema = z.object({ user: z.string().min(2), count: z.number().int().positive() });

export async function handler(event: unknown) {
  const parsed = Schema.parse(event);
  const ajv = new Ajv();
  const valid = ajv.compile({ type: 'object', required: ['user'] })(parsed);
  await sleep(1500);
  const ts = dayjs().format('YYYY-MM-DDTHH:mm:ss.SSSZ');
  const grouped = _.groupBy([{ k: 'a', v: 1 }, { k: 'a', v: 2 }], 'k');
  return {
    id: uuidv4(),
    valid,
    ts,
    aLen: grouped.a.length,
    count: parsed.count,
  };
}
      `,
      { name: 'libs.ts' },
    );

    const a = await executeInSandbox({ script, seed: 55, event: { user: 'ada', count: 3 } });
    const b = await executeInSandbox({ script, seed: 55, event: { user: 'ada', count: 3 } });
    expect(a.ok).toBe(true);
    expect(a.result).toEqual(b.result);
    const body = a.result as { id: string; valid: boolean; ts: string; aLen: number };
    expect(body.valid).toBe(true);
    expect(body.aLen).toBe(2);
    expect(body.ts).toMatch(/^2023-11-14T22:13:21\.500Z$/);

    const bad = await executeInSandbox({ script, event: { user: 'a', count: -1 } });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('Min length 2');
  });

  it('rejects non-allow-listed bare imports with UnsupportedModule and blocks restricted builtins at runtime', async () => {
    expect(isAllowedModuleSpecifier('uuid')).toBe(true);
    expect(isAllowedModuleSpecifier('@aws-sdk/client-s3')).toBe(true);
    expect(isAllowedModuleSpecifier('totally-unknown-pkg')).toBe(false);

    const disallowed = await bundleUserScript({
      entryScript: makeScript(`
import { leftPad } from 'totally-unknown-pkg';
export function handler() { return leftPad('a', 3); }
      `),
    });
    expect(disallowed.ok).toBe(false);
    expect(disallowed.errors?.[0]?.category).toBe('UnsupportedModule');
    expect(disallowed.errors?.[0]?.message).toContain('totally-unknown-pkg');
    expect(disallowed.errors?.[0]?.message).toContain('@aws-sdk/client-*');

    const childProc = await executeInSandbox({
      script: makeScript(`
import { execSync } from 'child_process';
export function handler() { return execSync('whoami'); }
      `),
    });
    expect(childProc.ok).toBe(false);
    expect(childProc.error?.message).toContain('child_process is not available in the simulator');

    const fsTmp = await executeInSandbox({
      script: makeScript(`
import fs from 'node:fs';
export function handler() {
  fs.writeFileSync('/tmp/note.txt', 'ok');
  return fs.readFileSync('/tmp/note.txt', 'utf8');
}
      `),
    });
    expect(fsTmp.ok).toBe(true);
    expect(fsTmp.result).toBe('ok');
  });
});
