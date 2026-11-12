import { afterAll, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type Design,
  type PayloadFixture,
  type PlanStep,
  type ScriptAsset,
} from '@infrasim/shared-types';
import {
  computeProfileCacheKey,
  countPlanBranches,
  profileHandlerScript,
  stopSandboxBundler,
  type MockCallResolver,
} from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeScript(id: string, source: string): ScriptAsset {
  return {
    id,
    name: `${id}.ts`,
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 128,
    timeoutMs: 3000,
    env: {},
  };
}

function makeDesign(script: ScriptAsset): Design {
  return {
    id: 'des-prof',
    schemaVersion: SCHEMA_VERSION,
    name: 'Profiler Design',
    groups: [],
    network: {},
    nodes: [
      {
        id: 'api',
        serviceId: 'aws.lambda',
        label: 'API Lambda',
        position: { x: 0, y: 0 },
        config: {
          instances: 1,
          operations: {},
          latency: { distribution: 'lognormal', p50: 15, p95: 60 },
          errorRate: 0,
          scriptId: script.id,
        },
      },
      {
        id: 'db',
        serviceId: 'aws.dynamodb',
        label: 'Orders',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          operations: {},
          latency: { distribution: 'lognormal', p50: 10, p95: 30 },
          errorRate: 0,
        },
      },
      {
        id: 'bucket',
        serviceId: 'aws.s3',
        label: 'Assets',
        position: { x: 200, y: 120 },
        config: {
          instances: 1,
          operations: {},
          latency: { distribution: 'lognormal', p50: 12, p95: 40 },
          errorRate: 0,
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'api', to: 'db', protocol: 'https', callType: 'sync', weight: 1 },
      { id: 'e2', from: 'api', to: 'bucket', protocol: 'https', callType: 'sync', weight: 1 },
    ],
    scenarios: [],
    scripts: [script],
    fixtures: [],
    settings: {
      seed: 42,
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}

describe('T3.9 CallPlan profiler and cache key', () => {
  it('extracts branch probability within 0.3 +/- 0.1 at N=200 (Acceptance #10)', async () => {
    const script = makeScript(
      'branch-30',
      `
      export async function handler() {
        await cloud.call('aws.dynamodb', 'GetItem', { TableName: 'Orders' });
        if (Math.random() < 0.3) {
          await cloud.call('aws.s3', 'GetObject', { Bucket: 'Assets', Key: 'a.json' });
        }
        return { statusCode: 200 };
      }
      `,
    );

    const resolver: MockCallResolver = (inv) => ({
      ok: true,
      latencyMs: 12,
      serviceId: inv.serviceId ?? 'aws.dynamodb',
      op: inv.op ?? 'Call',
      output: { ok: true },
    });

    const summary = await profileHandlerScript({
      script,
      iterations: 200,
      seed: 7,
      mockResolver: resolver,
    });

    expect(summary.error).toBeUndefined();
    expect(summary.sampleCount).toBe(200);
    expect(countPlanBranches(summary.callPlan.steps)).toBeGreaterThanOrEqual(1);
    const branchStep = summary.callPlan.steps.find((s: PlanStep) => s.kind === 'branch');
    expect(branchStep).toBeDefined();
    if (branchStep?.kind === 'branch') {
      const p = branchStep.then.length > 0 ? branchStep.probability : 1 - branchStep.probability;
      expect(p).toBeGreaterThanOrEqual(0.2);
      expect(p).toBeLessThanOrEqual(0.4);
    }
  });

  it('preserves parallelGroup across Promise.all turns and respects weighted fixtures', async () => {
    const script = makeScript(
      'parallel-handler',
      `
      export async function handler(event: { fast?: boolean }) {
        console.log('hit handler', event);
        await Promise.all([
          cloud.call('aws.dynamodb', 'GetItem', { Key: { id: '1' } }),
          cloud.call('aws.s3', 'GetObject', { Key: 'doc.txt' }),
        ]);
        if (!event.fast) {
          await cloud.call('aws.dynamodb', 'PutItem', { Item: { id: '1' } });
        }
        return { statusCode: 200 };
      }
      `,
    );
    const fixtures: PayloadFixture[] = [
      { id: 'f-fast', name: 'fast', event: { fast: true }, weight: 3 },
      { id: 'f-slow', name: 'slow', event: { fast: false }, weight: 1 },
    ];
    const resolver: MockCallResolver = (inv) => ({
      ok: true,
      latencyMs: 10,
      serviceId: inv.serviceId ?? 'aws.dynamodb',
      op: inv.op ?? 'Call',
      output: { ok: true },
    });

    const summary = await profileHandlerScript({
      script,
      fixtures,
      iterations: 40,
      cpuScale: 0.1,
      seed: 99,
      mockResolver: resolver,
    });

    expect(summary.error).toBeUndefined();
    expect(summary.sampleCount).toBe(40);
    expect(summary.sampledLogs.length).toBeGreaterThan(0);

    const parallelCalls = summary.callPlan.steps.filter(
      (s: PlanStep): s is Extract<PlanStep, { kind: 'call' }> =>
        s.kind === 'call' && Boolean(s.parallelGroup),
    );
    expect(parallelCalls.length).toBe(2);
    expect(parallelCalls[0]!.parallelGroup).toBe(parallelCalls[1]!.parallelGroup);

    expect(summary.scaledCpuMs.p50).toBeLessThanOrEqual(summary.measuredGuestCpuMs.p50 + 0.05);
  });

  it('invalidates cacheKey on script, fixture, or mock changes while ignoring cpuMsPerRequest and layout', () => {
    const script = makeScript(
      's1',
      'export async function handler() { return { statusCode: 200 }; }',
    );
    const design = makeDesign(script);
    const node = design.nodes[0]!;
    const fixtures: PayloadFixture[] = [{ id: 'f1', name: 'base', event: { a: 1 }, weight: 1 }];

    const keyBase = computeProfileCacheKey({ script, design, node, fixtures, iterations: 200 });

    const layoutMoved = structuredClone(design);
    layoutMoved.nodes[0]!.position = { x: 999, y: 777 };
    layoutMoved.nodes[0]!.config.cpuMsPerRequest = 12;
    expect(
      computeProfileCacheKey({
        script,
        design: layoutMoved,
        node: layoutMoved.nodes[0]!,
        fixtures,
        iterations: 200,
      }),
    ).toBe(keyBase);

    const scriptEdited = { ...script, source: 'export async function handler() { return 1; }' };
    expect(
      computeProfileCacheKey({
        script: scriptEdited,
        designScripts: [scriptEdited],
        design,
        node,
        fixtures,
        iterations: 200,
      }),
    ).not.toBe(keyBase);

    const mockEdited = structuredClone(design);
    mockEdited.nodes[1]!.config.errorRate = 0.25;
    expect(
      computeProfileCacheKey({
        script,
        design: mockEdited,
        node: mockEdited.nodes[0]!,
        fixtures,
        iterations: 200,
      }),
    ).not.toBe(keyBase);

    expect(
      computeProfileCacheKey({
        script,
        design,
        node,
        fixtures: [{ id: 'f1', name: 'base', event: { a: 2 }, weight: 1 }],
        iterations: 200,
      }),
    ).not.toBe(keyBase);
  });
});
