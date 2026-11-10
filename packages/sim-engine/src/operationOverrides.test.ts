import { describe, expect, it } from 'vitest';
import type { Design } from '@infrasim/shared-types';
import { runSimulation } from './engine.js';

function createBaseDesign(overrides: Partial<Design['nodes'][1]['config']> = {}): Design {
  return {
    schemaVersion: 1,
    id: 'des-op-ov',
    name: 'Operation override test',
    nodes: [
      {
        id: 'n-client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'n-s3',
        serviceId: 'aws.s3',
        label: 'Object Store',
        position: { x: 240, y: 0 },
        config: {
          instances: 1,
          operations: {},
          ...overrides,
        },
      },
    ],
    edges: [
      {
        id: 'e-1',
        from: 'n-client',
        to: 'n-s3',
        protocol: 'https',
        callType: 'sync',
        weight: 1,
      },
    ],
    groups: [],
    network: {},
    scenarios: [
      {
        id: 'sc-1',
        name: 'Constant 25 RPS',
        durationS: 8,
        entryNodeId: 'n-client',
        profile: { kind: 'constant', rps: 25 },
        flows: [
          {
            id: 'f-1',
            name: 'Get asset',
            weight: 1,
            steps: [{ method: 'GET', path: '/asset.bin' }],
          },
        ],
        chaos: [],
      },
    ],
    scripts: [],
    fixtures: [],
    settings: {
      seed: 101,
      primaryProvider: 'aws',
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}

describe('T2.2 operation and scenario overrides in sim-engine', () => {
  it('applies operation-level latency, responseSizeBytes, and errorKind overrides', async () => {
    const baseline = await runSimulation(
      { design: createBaseDesign(), scenarioId: 'sc-1', seed: 101 },
      () => {},
    );

    const modified = await runSimulation(
      {
        design: createBaseDesign({
          operations: {
            GetObject: {
              latency: { distribution: 'fixed', p50: 140, p95: 140 },
              responseSizeBytes: 65536,
              errorRate: 0.2,
              errorKind: 'throttle',
            },
          },
        }),
        scenarioId: 'sc-1',
        seed: 101,
      },
      () => {},
    );

    const baseS3 = baseline.perNode['n-s3']!;
    const modS3 = modified.perNode['n-s3']!;
    expect(modS3.p50).toBeGreaterThan(baseS3.p50 + 80);
    expect(modS3.errors.throttled ?? 0).toBeGreaterThan(5);
    expect(modified.counters.perNode['n-s3']!.bytesOut).toBeGreaterThan(
      baseline.counters.perNode['n-s3']!.bytesOut,
    );

    const erroredTrace = modified.traces.find((t) =>
      t.spans.some((sp) => sp.nodeId === 'n-s3' && sp.status === 'throttled'),
    );
    expect(erroredTrace).toBeDefined();
    expect(erroredTrace?.spans.find((sp) => sp.nodeId === 'n-s3')?.attrs?.opErrorKind).toBe(
      'throttle',
    );
  });

  it('applies time-boxed scenarioOverrides only during [fromS, toS)', async () => {
    const design = createBaseDesign({
      latency: { distribution: 'fixed', p50: 5, p95: 5 },
      scenarioOverrides: [
        {
          scenarioId: 'sc-1',
          fromS: 3,
          toS: 6,
          latency: { distribution: 'fixed', p50: 120, p95: 120 },
          errorRate: 0.25,
        },
      ],
    });

    const result = await runSimulation({ design, scenarioId: 'sc-1', seed: 77 }, () => {});
    const before = result.series.buckets.filter((b) => b.tS <= 2);
    const during = result.series.buckets.filter((b) => b.tS >= 4 && b.tS <= 6);
    const after = result.series.buckets.filter((b) => b.tS >= 7);

    const avgP50 = (list: typeof before) =>
      list.reduce((acc, b) => acc + (b.perNode['n-s3']?.p50 ?? 0), 0) / Math.max(1, list.length);
    const sumErr = (list: typeof before) =>
      list.reduce((acc, b) => acc + (b.perNode['n-s3']?.errors ?? 0), 0);

    expect(avgP50(before)).toBeLessThan(20);
    expect(avgP50(during)).toBeGreaterThan(80);
    expect(avgP50(after)).toBeLessThan(20);
    expect(sumErr(before)).toBe(0);
    expect(sumErr(during)).toBeGreaterThan(0);
    expect(sumErr(after)).toBe(0);
  });
});
