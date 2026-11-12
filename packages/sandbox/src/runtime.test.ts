import { describe, expect, it, vi } from 'vitest';
import type { ScriptAsset } from '@infrasim/shared-types';
import { DEFAULT_DRY_RUN_LIMITS, executeInSandbox, type MockCallResolver } from './index.js';

function makeScript(
  source: string,
  overrides: { timeoutMs?: number; memoryMb?: number } = {},
): ScriptAsset {
  return {
    id: 'script-1',
    name: 'handler.js',
    kind: 'handler',
    language: 'javascript',
    entry: 'handler',
    source,
    memoryMb: overrides.memoryMb ?? 128,
    timeoutMs: overrides.timeoutMs ?? 3000,
    env: {},
  };
}

describe('T3.1 QuickJS-WASM sandbox runtime & virtual time loop', () => {
  it('runs a handler returning JSON, captures console logs, and sums sequential latencies (Acceptance #1)', async () => {
    const resolver: MockCallResolver = (inv) => ({
      ok: true,
      latencyMs: inv.op === 'First' ? 40 : 65,
      serviceId: inv.serviceId ?? 'aws.dynamodb',
      op: inv.op ?? 'Call',
      output: { ok: true },
    });

    const res = await executeInSandbox({
      script: makeScript(`
        export async function handler(event, ctx) {
          console.info('handling request', { reqId: ctx.awsRequestId });
          await cloud.call('aws.dynamodb', 'First', { id: event.id });
          await cloud.call('aws.s3', 'Second', { bucket: 'b' });
          return { statusCode: 200, body: JSON.stringify({ id: event.id }) };
        }
      `),
      event: { id: 'ord-42' },
      seed: 123,
      mockResolver: resolver,
    });

    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.result).toEqual({ statusCode: 200, body: '{"id":"ord-42"}' });
    expect(res.virtualDurationMs).toBe(105);
    expect(res.billedDurationMs).toBe(105);
    expect(res.calls).toHaveLength(2);
    expect(
      res.logs.some((l) => l.source === 'user' && l.message.includes('handling request')),
    ).toBe(true);
  });

  it('costs max latency for Promise.all and sum latency for sequential awaits (Acceptance #2)', async () => {
    const latencies: Record<string, number> = { A: 50, B: 80, C: 120 };
    const resolver: MockCallResolver = (inv) => ({
      ok: true,
      latencyMs: latencies[inv.op ?? 'A'] ?? 10,
      serviceId: inv.serviceId ?? 'aws.dynamodb',
      op: inv.op ?? 'A',
      output: { op: inv.op },
    });

    const parallelRes = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          await Promise.all([
            cloud.call('aws.dynamodb', 'A', {}),
            cloud.call('aws.dynamodb', 'B', {}),
            cloud.call('aws.dynamodb', 'C', {}),
          ]);
          return { ok: true };
        }
      `),
      mockResolver: resolver,
    });

    const seqRes = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          await cloud.call('aws.dynamodb', 'A', {});
          await cloud.call('aws.dynamodb', 'B', {});
          await cloud.call('aws.dynamodb', 'C', {});
          return { ok: true };
        }
      `),
      mockResolver: resolver,
    });

    expect(parallelRes.ok).toBe(true);
    expect(parallelRes.virtualDurationMs).toBeCloseTo(120, 1);
    expect(seqRes.ok).toBe(true);
    expect(seqRes.virtualDurationMs).toBeCloseTo(250, 1);
  });

  it('guarantees determinism: same seed yields identical logs, timestamps, UUIDs, and results (Acceptance #9)', async () => {
    const script = makeScript(`
      export async function handler() {
        const id = crypto.randomUUID();
        const roll = Math.random();
        await sleep(25);
        const now = Date.now();
        console.log('deterministic', { id, roll, now });
        return { id, roll, now };
      }
    `);

    const a = await executeInSandbox({ script, seed: 999, seq: 7 });
    const b = await executeInSandbox({ script, seed: 999, seq: 7 });
    const c = await executeInSandbox({ script, seed: 1000, seq: 7 });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
    expect(a.logs.map((l) => l.message)).toEqual(b.logs.map((l) => l.message));
    expect(a.result).not.toEqual(c.result);
  });

  it('kills infinite loop with CpuBudgetExceeded well under 3s and recovers for subsequent runs (Acceptance #7)', async () => {
    const start = Date.now();
    const stuck = await executeInSandbox({
      script: makeScript(`export async function handler() { while (true) {} }`),
      limits: { cpuBudgetMs: 120 },
    });
    const wallMs = Date.now() - start;

    expect(stuck.ok).toBe(false);
    expect(stuck.error?.category).toBe('CpuBudgetExceeded');
    expect(stuck.error?.message).toContain('Possible infinite loop');
    expect(wallMs).toBeLessThan(3_000);

    // Worker / WASM module stays healthy after abort
    const nextRun = await executeInSandbox({
      script: makeScript(`export async function handler() { return { healthy: true }; }`),
    });
    expect(nextRun.ok).toBe(true);
    expect(nextRun.result).toEqual({ healthy: true });
  });

  it('enforces function timeout in virtual time with provider-style Timeout error (Acceptance #11)', async () => {
    const resolver: MockCallResolver = () => ({
      ok: true,
      latencyMs: 3_000,
      serviceId: 'aws.rds',
      op: 'Query',
      output: {},
    });

    const res = await executeInSandbox({
      script: makeScript(
        `export async function handler() { return await cloud.call('aws.rds', 'Query', {}); }`,
        { timeoutMs: 1_000 },
      ),
      mockResolver: resolver,
    });

    expect(res.ok).toBe(false);
    expect(res.error?.category).toBe('Timeout');
    expect(res.error?.message).toBe('Task timed out after 1.00 seconds');
    expect(res.virtualDurationMs).toBe(1_000);
  });

  it('enforces guest memory limit, stack overflow guard, /tmp 64 MB quota, call cap, and log caps', async () => {
    const oom = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          const chunks = [];
          for (let i = 0; i < 500_000; i++) chunks.push({ i, payload: 'memory-bomb-item' });
          return chunks.length;
        }
      `),
      limits: { memoryMb: 16 },
    });
    expect(oom.ok).toBe(false);
    expect(oom.error?.category).toBe('OutOfMemory');

    const typedOom = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          const chunks = [];
          for (let i = 0; i < 64; i++) chunks.push(new Uint8Array(1024 * 1024));
          return chunks.length;
        }
      `),
      limits: { memoryMb: 16 },
    });
    expect(typedOom.ok).toBe(false);
    expect(typedOom.error?.category).toBe('OutOfMemory');

    const stack = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          function recurse(n) { return recurse(n + 1); }
          return recurse(0);
        }
      `),
    });
    expect(stack.ok).toBe(false);
    expect(stack.error?.category).toBe('UserCodeError');

    const tmpOut = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          __infrasimFs.writeFileSync('/tmp/a.txt', 'hello-sim');
          const txt = __infrasimFs.readFileSync('/tmp/a.txt', 'utf8');
          let outsideRejected = false;
          try { __infrasimFs.readFileSync('/etc/passwd', 'utf8'); } catch { outsideRejected = true; }
          let overLimit = false;
          try { __infrasimFs.writeFileSync('/tmp/huge.bin', new Uint8Array(1024)); } catch { overLimit = true; }
          return { txt, outsideRejected, overLimit };
        }
      `),
      limits: { tmpFsMaxBytes: 1024 },
    });
    expect(tmpOut.ok).toBe(true);
    expect(tmpOut.result).toEqual({ txt: 'hello-sim', outsideRejected: true, overLimit: true });

    const tmpExceeded = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          __infrasimFs.writeFileSync('/tmp/huge.bin', new Uint8Array(2048));
        }
      `),
      limits: { tmpFsMaxBytes: 1024 },
    });
    expect(tmpExceeded.ok).toBe(false);
    expect(tmpExceeded.error?.message).toContain('/tmp');

    const logBomb = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          const big = 'x'.repeat(20_000);
          for (let i = 0; i < 50; i++) console.log(big);
          return 'done';
        }
      `),
      limits: { maxLogLines: 10, maxLogLineBytes: 512 },
    });
    expect(logBomb.ok).toBe(true);
    expect(logBomb.logs.length).toBe(11);
    expect(logBomb.logs[0]!.message).toContain('[truncated]');
    expect(Buffer.byteLength(logBomb.logs[0]!.message, 'utf8')).toBeLessThanOrEqual(512);

    const tooManyCalls = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          for (let i = 0; i < 5; i++) await cloud.call('aws.s3', 'GetObject', {});
        }
      `),
      limits: { maxMockCalls: 3 },
    });
    expect(tooManyCalls.ok).toBe(false);
    expect(tooManyCalls.error?.category).toBe('MockServiceError');
    expect(tooManyCalls.error?.message).toContain('Max mock calls');

    const oversized = await executeInSandbox({
      script: makeScript('a'.repeat(DEFAULT_DRY_RUN_LIMITS.maxSourceBytes + 10)),
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.error?.message).toContain('exceeds 200 KB limit');
  });

  it('supports Web-Fetch (Cloud Run / Edge) and Express (req, res) handler adapters', async () => {
    const fetchRes = await executeInSandbox({
      script: makeScript(`
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            return Response.json({ path: url.pathname, region: env.AWS_REGION }, { status: 201 });
          }
        }
      `),
      event: { method: 'GET', path: '/items/99' },
    });
    expect(fetchRes.ok).toBe(true);
    expect(fetchRes.httpStatus).toBe(201);
    expect(JSON.parse((fetchRes.result as { body: string }).body)).toEqual({
      path: '/items/99',
      region: 'us-east-1',
    });

    const expressRes = await executeInSandbox({
      script: makeScript(`
        export function handler(req, res) {
          return res.status(202).set('X-Sim', 'yes').json({ accepted: req.userId });
        }
      `),
      event: { userId: 'u-7' },
    });
    expect(expressRes.ok).toBe(true);
    expect(expressRes.httpStatus).toBe(202);
    expect(expressRes.result).toEqual({
      statusCode: 202,
      headers: { 'content-type': 'application/json', 'x-sim': 'yes' },
      body: '{"accepted":"u-7"}',
    });
  });

  it('checks unhandled rejection cleanup and repeats cleanly across invocations', async () => {
    const spy = vi.fn();
    for (let i = 0; i < 3; i++) {
      const rej = await executeInSandbox({
        script: makeScript(`
          export async function handler() {
            throw new TypeError('boom-' + ${i});
          }
        `),
      });
      expect(rej.ok).toBe(false);
      expect(rej.error?.category).toBe('UnhandledRejection');
      expect(rej.error?.message).toBe(`boom-${i}`);
      spy();
    }
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
