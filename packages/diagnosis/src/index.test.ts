import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design, type SimulationResult } from '@infrasim/shared-types';
import {
  PHASE1_RULES,
  applyJsonPatch,
  autoscaleTooSlowRule,
  bottleneckNodeRule,
  cpuSaturatedRule,
  dbPoolExhaustedRule,
  dbReadHeavyNoCacheRule,
  diagnose,
  dropsQueueFullRule,
  idleOverprovisionedRule,
  queueGrowingRule,
  serverlessThrottledRule,
  slotsExhaustedRule,
} from './index.js';

function fixtureDesignAndResult(
  overrides: {
    nodeService?: string;
    config?: Partial<Design['nodes'][0]['config']>;
    summary?: Partial<SimulationResult['perNode'][string]>;
    bucketQueueSeries?: number[];
    bucketUtil?: number;
    withCacheUpstream?: boolean;
  } = {},
): { design: Design; result: SimulationResult } {
  const d = createEmptyDesign('diag-fix', 'Diag Test');
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    ...(overrides.withCacheUpstream
      ? [
          {
            id: 'cache',
            serviceId: 'generic.cache',
            label: 'Redis',
            position: { x: 100, y: 0 },
            config: { instances: 1, cacheHitRatio: 0.8, operations: {} },
          },
        ]
      : []),
    {
      id: 'target',
      serviceId: overrides.nodeService ?? 'generic.service',
      label: 'Target',
      position: { x: 200, y: 0 },
      config: {
        instances: 1,
        vcpu: 2,
        cluster: false,
        runtimePreset: 'node',
        operations: {},
        ...overrides.config,
      },
    },
  ];
  d.edges = overrides.withCacheUpstream
    ? [{ id: 'e1', from: 'cache', to: 'target', protocol: 'sql', callType: 'sync', weight: 1 }]
    : [{ id: 'e1', from: 'client', to: 'target', protocol: 'https', callType: 'sync', weight: 1 }];

  const qSeries = overrides.bucketQueueSeries ?? [0, 0, 0, 0, 0, 0];
  const util = overrides.bucketUtil ?? overrides.summary?.avgUtilization ?? 0.3;

  const result: SimulationResult = {
    runId: 'run-test',
    seed: 42,
    durationS: qSeries.length,
    scaled: null,
    summary: {
      totalRequests: 1000,
      success: 900,
      errors: {},
      p50: 15,
      p95: 80,
      p99: 150,
      throughputRps: 150,
    },
    perNode: {
      target: {
        requests: 1000,
        success: 950,
        errors: {},
        drops: 0,
        p50: 15,
        p95: 80,
        p99: 150,
        avgUtilization: 0.4,
        peakUtilization: 0.5,
        avgCpuUtilization: 0.3,
        peakQueueDepth: Math.max(...qSeries),
        theoreticalMaxRps: 500,
        ...overrides.summary,
      },
    },
    series: {
      bucketSizeS: 1,
      buckets: qSeries.map((q, idx) => ({
        tS: idx + 1,
        rpsIn: 100,
        throughputRps: 90,
        errorRate: 0,
        p50: 15,
        p95: 80,
        p99: 150,
        perNode: {
          target: {
            rpsIn: 100,
            rpsOut: 95,
            errors: 0,
            drops: overrides.summary?.drops && idx === 0 ? overrides.summary.drops : 0,
            utilization: util,
            cpuUtilization: overrides.summary?.avgCpuUtilization ?? 0.3,
            queueDepth: q,
            inFlight: 5,
            instancesActive: 1,
            p50: 15,
            p95: 80,
            p99: 150,
          },
        },
      })),
    },
    traces: [],
    counters: { perNode: {}, perEdge: {} },
    insights: [],
  };

  return { design: d, result };
}

describe('@infrasim/diagnosis T1.8 rules, patches and coverage invariants', () => {
  it('applies RFC 6902 patches immutably including missing intermediate config objects', () => {
    const { design } = fixtureDesignAndResult();
    const patched = applyJsonPatch(design, [
      { op: 'add', path: '/nodes/1/config/instances', value: 4 },
      { op: 'add', path: '/nodes/1/config/connections', value: { max: 200 } },
    ]);
    expect(patched.nodes[1]!.config.instances).toBe(4);
    expect(patched.nodes[1]!.config.connections?.max).toBe(200);
    expect(design.nodes[1]!.config.instances).toBe(1);
    expect(design.nodes[1]!.config.connections).toBeUndefined();
  });

  it('triggers each rule positively and stays silent on negative fixtures with valid fix patches', () => {
    const cpuPos = fixtureDesignAndResult({
      summary: { avgCpuUtilization: 0.94, avgUtilization: 0.92, peakUtilization: 0.99 },
    });
    expect(diagnose(cpuPos, [cpuSaturatedRule])).toHaveLength(1);
    const cpuFix = diagnose(cpuPos, [cpuSaturatedRule])[0]!.fixes[0]!;
    expect(applyJsonPatch(cpuPos.design, cpuFix.patch).nodes[1]!.config.cluster).toBe(true);
    const cpuNeg = fixtureDesignAndResult({ summary: { avgCpuUtilization: 0.25 } });
    expect(diagnose(cpuNeg, [cpuSaturatedRule])).toHaveLength(0);

    const slotsPos = fixtureDesignAndResult({
      summary: { avgUtilization: 0.88, peakUtilization: 0.96, avgCpuUtilization: 0.2 },
    });
    expect(diagnose(slotsPos, [slotsExhaustedRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [slotsExhaustedRule])).toHaveLength(0);

    const dropsPos = fixtureDesignAndResult({ summary: { drops: 45, peakQueueDepth: 100 } });
    expect(diagnose(dropsPos, [dropsQueueFullRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [dropsQueueFullRule])).toHaveLength(0);

    const qPos = fixtureDesignAndResult({ bucketQueueSeries: [5, 10, 15, 20, 25, 30] });
    expect(diagnose(qPos, [queueGrowingRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [queueGrowingRule])).toHaveLength(0);

    const asPos = fixtureDesignAndResult({
      config: {
        autoscaling: {
          min: 1,
          max: 5,
          metric: 'cpu',
          target: 0.6,
          scaleOutCooldownS: 30,
          scaleInCooldownS: 60,
          warmupS: 20,
          checkIntervalS: 5,
        },
      },
      summary: { peakUtilization: 0.97 },
    });
    expect(diagnose(asPos, [autoscaleTooSlowRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [autoscaleTooSlowRule])).toHaveLength(0);

    const dbPos = fixtureDesignAndResult({
      nodeService: 'generic.db',
      config: { connections: { max: 10 }, readRatio: 0.9 },
      summary: { peakUtilization: 0.99, errors: { timeout: 30 } },
    });
    expect(diagnose(dbPos, [dbPoolExhaustedRule])).toHaveLength(1);
    expect(diagnose(dbPos, [dbReadHeavyNoCacheRule])).toHaveLength(1);
    const dbCached = fixtureDesignAndResult({
      nodeService: 'generic.db',
      config: { connections: { max: 10 }, readRatio: 0.9 },
      summary: { peakUtilization: 0.7 },
      withCacheUpstream: true,
    });
    expect(diagnose(dbCached, [dbReadHeavyNoCacheRule])).toHaveLength(0);

    const thPos = fixtureDesignAndResult({
      nodeService: 'aws.lambda',
      summary: { errors: { throttled: 120 } },
    });
    expect(diagnose(thPos, [serverlessThrottledRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [serverlessThrottledRule])).toHaveLength(0);

    const idlePos = fixtureDesignAndResult({
      config: { instances: 4 },
      summary: { peakUtilization: 0.08, requests: 200 },
    });
    expect(diagnose(idlePos, [idleOverprovisionedRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [idleOverprovisionedRule])).toHaveLength(0);

    const bnPos = fixtureDesignAndResult({ summary: { peakUtilization: 0.85 } });
    expect(diagnose(bnPos, [bottleneckNodeRule])).toHaveLength(1);
    expect(diagnose(cpuNeg, [bottleneckNodeRule])).toHaveLength(0);
  });

  it('produces deterministic ordering and guarantees every hot/overloaded node is explained', () => {
    const hotGeneric = fixtureDesignAndResult({
      summary: { avgUtilization: 0.82, peakUtilization: 0.86, avgCpuUtilization: 0.71 },
      bucketUtil: 0.83,
    });
    const insightsA = diagnose(hotGeneric, PHASE1_RULES);
    const insightsB = diagnose(hotGeneric, PHASE1_RULES);
    expect(insightsA).toEqual(insightsB);
    expect(insightsA.some((i) => i.nodeIds.includes('target'))).toBe(true);
  });
});
