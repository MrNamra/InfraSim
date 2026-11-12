import { createEmptyDesign, type ScriptAsset } from '@infrasim/shared-types';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DRY_RUN_LIMITS,
  bundleUserScript,
  createMockCallResolver,
  executeInSandbox,
  stopSandboxBundler,
} from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeScript(source: string, overrides: Partial<ScriptAsset> = {}): ScriptAsset {
  return {
    id: overrides.id ?? 'sec-script',
    name: overrides.name ?? 'handler.ts',
    kind: overrides.kind ?? 'handler',
    language: overrides.language ?? 'typescript',
    entry: overrides.entry ?? 'handler',
    source,
    memoryMb: overrides.memoryMb ?? 128,
    timeoutMs: overrides.timeoutMs ?? 3_000,
    env: overrides.env ?? {},
  };
}

describe('T3.12 Sandbox security, resource isolation & Spec 12 invariants', () => {
  it('isolates prototype pollution across guest -> host and guest -> next invocation', async () => {
    const pollute = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          (Object.prototype as any).infrasimPolluted = 'pwned';
          (Array.prototype as any).evilHelper = () => 'pwned';
          const payload = JSON.parse('{"__proto__": {"polluted": true}}');
          Object.assign({}, payload);
          return { selfCheck: ({} as any).infrasimPolluted };
        }
      `),
    });
    expect(pollute.ok).toBe(true);
    expect((pollute.result as { selfCheck?: unknown }).selfCheck).toBe('pwned');

    // Host Object.prototype & Array.prototype remain untouched
    expect('infrasimPolluted' in ({} as Record<string, unknown>)).toBe(false);
    expect('evilHelper' in ([] as unknown as Record<string, unknown>)).toBe(false);

    // Next sandbox invocation starts with a fresh QuickJS context and clean prototypes
    const clean = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          return {
            hasPolluted: 'infrasimPolluted' in {},
            hasEvil: 'evilHelper' in [],
          };
        }
      `),
    });
    expect(clean.ok).toBe(true);
    expect(clean.result).toEqual({ hasPolluted: false, hasEvil: false });
  });

  it('prevents host closure/process escapes via Function constructor, globalThis, and constructor chains', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          const proc: any = (globalThis as any).process;
          const requireType = typeof (globalThis as any).require;
          const hostBindingType = typeof proc?.binding;
          const hostDlopenType = typeof proc?.dlopen;
          const hostMainModuleType = typeof proc?.mainModule;
          const hasHostHomeEnv = typeof proc?.env?.HOME === 'string';
          const cwd = typeof proc?.cwd === 'function' ? proc.cwd() : null;
          let exitBlocked = false;
          try {
            proc?.exit?.(1);
          } catch (e: any) {
            exitBlocked = String(e?.message || '').includes('not available');
          }
          let fnEscapeRequire = 'none';
          try {
            fnEscapeRequire = Function('return typeof require')();
          } catch {
            fnEscapeRequire = 'blocked';
          }
          return {
            requireType,
            hostBindingType,
            hostDlopenType,
            hostMainModuleType,
            hasHostHomeEnv,
            cwd,
            exitBlocked,
            fnEscapeRequire,
          };
        }
      `),
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      requireType: 'undefined',
      hostBindingType: 'undefined',
      hostDlopenType: 'undefined',
      hostMainModuleType: 'undefined',
      hasHostHomeEnv: false,
      cwd: '/tmp',
      exitBlocked: true,
      fnEscapeRequire: 'undefined',
    });
  });

  it('blocks real network calls (fetch to example.com -> 502 MockNotConfigured) with host fetch untouched (Spec 12 #8)', async () => {
    const hostFetchSpy = vi.fn(() => {
      throw new Error('REAL NETWORK MUST NEVER BE CALLED');
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = hostFetchSpy as unknown as typeof fetch;

    try {
      const res = await executeInSandbox({
        script: makeScript(`
          export async function handler() {
            const resp = await fetch('https://example.com/api');
            return { status: resp.status };
          }
        `),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.category).toBe('MockNotConfigured');
      expect(res.error?.statusCode).toBe(502);
      expect(hostFetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('rejects non-allowlisted packages at bundle time and blocks restricted Node builtins at runtime', async () => {
    for (const pkg of ['evil-pkg', 'sqlite3', 'puppeteer', 'fs-extra']) {
      const bundled = await bundleUserScript({
        entryScript: makeScript(`import x from '${pkg}'; export const handler = () => x;`),
      });
      expect(bundled.ok).toBe(false);
      expect(bundled.errors?.[0]?.category).toBe('UnsupportedModule');
    }

    for (const [mod, callExpr] of [
      ['child_process', 'mod.execSync("whoami")'],
      ['node:net', 'mod.connect(80, "example.com")'],
      ['http', 'mod.request("http://example.com")'],
      ['https', 'mod.request("https://example.com")'],
      ['os', 'mod.hostname()'],
      ['dns', 'mod.lookup("example.com")'],
    ] as const) {
      const res = await executeInSandbox({
        script: makeScript(`
          import mod from '${mod}';
          export function handler() {
            return ${callExpr};
          }
        `),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toMatch(/not available in the simulator/i);
    }
  });

  it('stops infinite loops (< 3s real wall clock) with CpuBudgetExceeded and recovers worker cleanly (Spec 12 #7)', async () => {
    const startWall = performance.now();
    const res = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          while (true) {}
        }
      `),
      limits: { cpuBudgetMs: 120 },
    });
    const wallMs = performance.now() - startWall;

    expect(res.ok).toBe(false);
    expect(res.error?.category).toBe('CpuBudgetExceeded');
    expect(wallMs).toBeLessThan(3_000);

    // Subsequent call must still execute normally
    const after = await executeInSandbox({
      script: makeScript(`export async function handler() { return { recovered: true }; }`),
    });
    expect(after.ok).toBe(true);
    expect(after.result).toEqual({ recovered: true });
  });

  it('terminates memory bombs (OutOfMemory) and deep recursion without crashing WASM', async () => {
    const bomb = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          const store: any[] = [];
          while (true) {
            store.push(new Uint8Array(512 * 1024));
          }
        }
      `),
      limits: { memoryMb: 16 },
    });
    expect(bomb.ok).toBe(false);
    expect(bomb.error?.category).toBe('OutOfMemory');

    const recurse = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          const dive = (n: number): number => dive(n + 1) + 1;
          return dive(0);
        }
      `),
    });
    expect(recurse.ok).toBe(false);
    expect(recurse.error?.category).toBe('UserCodeError');

    // Clean recovery after both failures
    const recovery = await executeInSandbox({
      script: makeScript(`export function handler() { return 'ok'; }`),
    });
    expect(recovery.ok).toBe(true);
    expect(recovery.result).toBe('ok');
  });

  it('enforces /tmp quota, blocks path traversal outside /tmp, and caps source/design sizes', async () => {
    const fsTest = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          let travErr = '';
          try { __infrasimFs.readFileSync('/tmp/../etc/passwd', 'utf8'); } catch (e: any) { travErr = e.message; }
          let rootErr = '';
          try { __infrasimFs.writeFileSync('/root/key.txt', 'x'); } catch (e: any) { rootErr = e.message; }
          let spaceErr = '';
          try { __infrasimFs.writeFileSync('/tmp/overflow.bin', new Uint8Array(4096)); } catch (e: any) { spaceErr = e.message; }
          return { travErr, rootErr, spaceErr };
        }
      `),
      limits: { tmpFsMaxBytes: 1024 },
    });
    expect(fsTest.ok).toBe(true);
    const out = fsTest.result as { travErr: string; rootErr: string; spaceErr: string };
    expect(out.travErr).toMatch(/\/tmp/);
    expect(out.rootErr).toMatch(/\/tmp/);
    expect(out.spaceErr).toMatch(/ENOSPC|quota|limit|\/tmp/i);

    const singleOversize = await executeInSandbox({
      script: makeScript(
        'export const s = "' +
          'a'.repeat(DEFAULT_DRY_RUN_LIMITS.maxSourceBytes + 10) +
          '"; export function handler() {}',
      ),
    });
    expect(singleOversize.ok).toBe(false);
    expect(singleOversize.error?.message).toMatch(/200 KB/);

    const bigHelper = makeScript('export const big = "' + 'b'.repeat(900_000) + '";', {
      id: 'big-helper',
      name: 'big.ts',
    });
    const entrySmall = makeScript(
      'import { big } from "./big"; export function handler() { return big.length; }',
    );
    const designOversize = await executeInSandbox({
      script: entrySmall,
      designScripts: [bigHelper],
      limits: { maxDesignSourceBytes: 512 * 1024 },
    });
    expect(designOversize.ok).toBe(false);
    expect(designOversize.error?.message).toMatch(/design source|limit/i);
  });

  it('runs unmodified S3Client + GetObjectCommand, injects 429 throttle, and enforces virtual 1s timeout in <100ms wall time (Spec 12 #5, #6, #11)', async () => {
    const design = createEmptyDesign('sec-sdk', 'SDK Test');
    design.nodes = [
      {
        id: 'fn-1',
        serviceId: 'aws.lambda',
        label: 'Fn',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 's3-1',
        serviceId: 'aws.s3',
        label: 'Bucket',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          operations: {
            GetObject: {
              responseTemplate: '{"Body":"hello-s3-unmodified"}',
            },
          },
        },
      },
    ];
    design.edges = [
      {
        id: 'e1',
        from: 'fn-1',
        to: 's3-1',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
    ];

    const okRun = await executeInSandbox({
      script: makeScript(`
        import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
        export async function handler() {
          const client = new S3Client({ region: 'us-east-1' });
          const res = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k.txt' }));
          return await res.Body.transformToString();
        }
      `),
      mockResolver: createMockCallResolver({ design, node: design.nodes[0], seed: 11 }),
    });
    expect(okRun.ok).toBe(true);
    expect(okRun.result).toBe('hello-s3-unmodified');

    // Throttle injection errorRate=1 errorKind=throttle -> $metadata.httpStatusCode === 429
    design.nodes[1]!.config.operations.GetObject = {
      errorRate: 1,
      errorKind: 'throttle',
    };
    const throttledRun = await executeInSandbox({
      script: makeScript(`
        import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
        export async function handler() {
          const client = new S3Client({ region: 'us-east-1' });
          try {
            await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k.txt' }));
            return { caught: false };
          } catch (err: any) {
            return { caught: true, status: err?.$metadata?.httpStatusCode, name: err?.name };
          }
        }
      `),
      mockResolver: createMockCallResolver({ design, node: design.nodes[0], seed: 11 }),
    });
    expect(throttledRun.ok).toBe(true);
    expect(throttledRun.result).toEqual({
      caught: true,
      status: 429,
      name: 'ThrottlingException',
    });

    // Virtual 1,000 ms timeout against 3,000 ms mock completes well under 500 ms wall clock
    const t0 = performance.now();
    const timedOut = await executeInSandbox({
      script: makeScript(
        `export async function handler() { return await cloud.call('aws.s3', 'GetObject', {}); }`,
        { timeoutMs: 1_000 },
      ),
      mockResolver: () => ({
        ok: true,
        latencyMs: 3_000,
        serviceId: 'aws.s3',
        op: 'GetObject',
        output: { Body: 'slow' },
      }),
    });
    const elapsedWall = performance.now() - t0;
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error?.category).toBe('Timeout');
    expect(timedOut.virtualDurationMs).toBe(1_000);
    expect(elapsedWall).toBeLessThan(500);
  });
});
