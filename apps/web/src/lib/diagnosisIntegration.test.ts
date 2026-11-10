import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { applyJsonPatch, diagnose } from '@infrasim/diagnosis';
import { runSimulation } from '@infrasim/sim-engine';

describe('sim-engine + diagnosis integration (spec 17 coverage & fix verification)', () => {
  it('explains overloaded node in Why? and fixing it via patch eliminates overload on re-run', async () => {
    const d: Design = createEmptyDesign('e2e-diag', 'Diag Fix E2E');
    d.settings.seed = 42;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'generic.service',
        label: 'API Tier',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          vcpu: 1,
          cluster: false,
          cpuMsPerRequest: 10,
          maxInFlightPerInstance: 20,
          queue: { maxLength: 40, policy: 'reject' },
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'Overload 140 RPS',
        durationS: 10,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 140 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res1 = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const insights = diagnose({ design: d, result: res1 });

    // Coverage invariant: hot/overloaded API node MUST appear in insights
    expect(res1.perNode.api!.drops).toBeGreaterThan(0);
    const apiInsights = insights.filter((i) => i.nodeIds.includes('api'));
    expect(apiInsights.length).toBeGreaterThan(0);

    // Apply first suggested fix patch and re-run cleanly
    const patch = apiInsights.find((i) => i.fixes.length > 0)!.fixes[0]!.patch;
    const fixedDesign = applyJsonPatch(d, patch);
    const res2 = await runSimulation({ design: fixedDesign, scenarioId: 's1' }, () => {});

    expect(res2.perNode.api!.drops).toBeLessThan(res1.perNode.api!.drops);
    expect(res2.perNode.api!.p95).toBeLessThanOrEqual(res1.perNode.api!.p95);
  });
});
