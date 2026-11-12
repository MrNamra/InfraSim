import { describe, expect, it } from 'vitest';
import type { PriceSnapshot } from '@infrasim/cost-engine';
import { createEmptyDesign } from '@infrasim/shared-types';
import { applyJsonPatch } from './patch.js';
import { runCostLatencySweep } from './sweep.js';

const SWEEP_PRICES: PriceSnapshot = {
  generatedAt: '2026-01-01T00:00:00Z',
  prices: [
    {
      provider: 'aws',
      region: 'us-east-1',
      serviceId: 'aws.ec2',
      skuKey: 't3.medium',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0416,
      currency: 'USD',
    },
    {
      provider: 'aws',
      region: 'us-east-1',
      serviceId: 'aws.ec2',
      skuKey: 'm6i.large',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.096,
      currency: 'USD',
    },
  ],
};

function buildSweepDesign() {
  const design = createEmptyDesign('sweep-test-1', 'Sweep API');
  design.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API Server',
      region: 'us-east-1',
      position: { x: 240, y: 0 },
      config: {
        instances: 1,
        instanceType: 't3.medium',
        maxInFlightPerInstance: 30,
        latency: { distribution: 'lognormal', p50: 45, p95: 120 },
        queue: { maxLength: 60, policy: 'reject' },
        operations: {},
      },
    },
  ];
  design.edges = [
    {
      id: 'e1',
      from: 'client',
      to: 'api',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  design.scenarios = [
    {
      id: 'sc1',
      name: 'Load',
      durationS: 10,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 1800 },
      flows: [
        {
          id: 'flow-1',
          name: 'Default',
          weight: 1,
          steps: [{ method: 'GET', path: '/', targetNodeId: 'api' }],
        },
      ],
      chaos: [],
    },
  ];
  return design;
}

describe('T6.8 cost vs latency sweep', () => {
  it('deterministically sweeps instance counts and identifies Pareto-optimal configurations', async () => {
    const design = buildSweepDesign();
    const run1 = await runCostLatencySweep({
      design,
      nodeId: 'api',
      snapshot: SWEEP_PRICES,
    });
    const run2 = await runCostLatencySweep({
      design,
      nodeId: 'api',
      snapshot: SWEEP_PRICES,
    });

    expect(run1).toEqual(run2);
    expect(run1.points.length).toBeGreaterThanOrEqual(4);
    expect(run1.points.some((p) => p.isPareto)).toBe(true);

    // Higher instance counts cost more and lower p95/error rate compared to 1x overloaded baseline
    const single = run1.points.find((p) => p.instances === 1 && p.instanceType === 't3.medium');
    const scaled = run1.points.find((p) => p.instances === 8 && p.instanceType === 't3.medium');
    expect(single).toBeDefined();
    expect(scaled).toBeDefined();
    expect((scaled!.monthlyCostUsd ?? 0) > (single!.monthlyCostUsd ?? 0)).toBe(true);
    expect(scaled!.errorRate).toBeLessThanOrEqual(single!.errorRate);

    // Patch applies cleanly back to design
    const patched = applyJsonPatch(design, scaled!.patch);
    expect(patched.nodes[1]?.config.instances).toBe(8);
  });
});
