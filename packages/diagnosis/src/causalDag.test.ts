import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design, type SimulationResult } from '@infrasim/shared-types';
import { applyCausalDagAndRank, diagnose } from './index.js';

function makeCascadeFixture(opts: { withRetry?: boolean } = {}): {
  design: Design;
  result: SimulationResult;
} {
  const d = createEmptyDesign('cascade-dag', 'Cascade DAG');
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Users',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'Public ALB',
      position: { x: 150, y: 0 },
      config: { instances: 2, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ecs_ec2',
      label: 'Orders API',
      position: { x: 300, y: 0 },
      config: { instances: 2, vcpu: 2, maxInFlightPerInstance: 20, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      position: { x: 450, y: 0 },
      config: { instances: 2, connections: { max: 20 }, operations: {} },
    },
  ];
  d.edges = [
    { id: 'e1', from: 'client', to: 'alb', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'alb', to: 'api', protocol: 'http', callType: 'sync', weight: 1 },
    {
      id: 'e3',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
      ...(opts.withRetry ? { retry: { max: 4, backoffMs: 5, jitter: false } } : {}),
    },
  ];

  const makePerNode = (
    requests: number,
    peakUtil: number,
    avgUtil: number,
    drops = 0,
    timeout = 0,
  ): SimulationResult['perNode'][string] => ({
    requests,
    success: Math.max(0, requests - drops - timeout),
    errors: timeout > 0 ? { timeout } : {},
    drops,
    p50: 40,
    p95: 450,
    p99: 900,
    avgUtilization: avgUtil,
    peakUtilization: peakUtil,
    avgCpuUtilization: 0.2,
    peakQueueDepth: drops > 0 ? 50 : 10,
    theoreticalMaxRps: 200,
  });

  const result: SimulationResult = {
    runId: 'dag-test',
    seed: 99,
    durationS: 5,
    scaled: null,
    summary: {
      totalRequests: 1000,
      success: 700,
      errors: { timeout: 200 },
      p50: 50,
      p95: 500,
      p99: 950,
      throughputRps: 140,
    },
    perNode: {
      alb: makePerNode(1000, 0.9, 0.85, 80, 0),
      api: makePerNode(920, 0.96, 0.9, 0, 120),
      db: makePerNode(800, 0.99, 0.94, 0, 220),
    },
    series: {
      bucketSizeS: 1,
      buckets: Array.from({ length: 5 }, (_, i) => ({
        tS: i + 1,
        rpsIn: 200,
        throughputRps: 140,
        errorRate: 0.25,
        p50: 50,
        p95: 500,
        p99: 950,
        perNode: {
          alb: {
            rpsIn: 200,
            rpsOut: 180,
            errors: 0,
            drops: 16,
            utilization: 0.9,
            cpuUtilization: 0.2,
            queueDepth: 40,
            inFlight: 15,
            instancesActive: 2,
            p50: 40,
            p95: 400,
            p99: 800,
          },
          api: {
            rpsIn: 180,
            rpsOut: 150,
            errors: 24,
            drops: 0,
            utilization: 0.96,
            cpuUtilization: 0.25,
            queueDepth: 10,
            inFlight: 20,
            instancesActive: 2,
            p50: 45,
            p95: 450,
            p99: 850,
          },
          db: {
            rpsIn: 160,
            rpsOut: 116,
            errors: 44,
            drops: 0,
            utilization: 0.99,
            cpuUtilization: 0.3,
            queueDepth: 5,
            inFlight: 20,
            instancesActive: 2,
            p50: 50,
            p95: 500,
            p99: 950,
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

describe('@infrasim/diagnosis T6.2 causal DAG root cause analysis and deterministic ranking', () => {
  it('picks deepest saturated dependency (DB) as root cause ahead of API & ALB symptoms', () => {
    const fixture = makeCascadeFixture();
    const insightsA = diagnose(fixture);
    const insightsB = diagnose(fixture);

    expect(insightsA).toEqual(insightsB);

    const dbRoot = insightsA.find((i) => i.ruleId === 'db-pool-exhausted');
    const apiSym = insightsA.find(
      (i) => i.ruleId === 'slots-exhausted' && i.nodeIds.includes('api'),
    );
    const albSym = insightsA.find(
      (i) => i.ruleId === 'drops-queue-full' && i.nodeIds.includes('alb'),
    );

    expect(dbRoot).toBeDefined();
    expect(dbRoot!.isRootCause).toBe(true);
    expect(insightsA[0]!.ruleId).toBe('db-pool-exhausted');

    expect(apiSym?.rootCauseNodeId).toBe('db');
    expect(apiSym?.causedByNodeId).toBe('db');

    expect(albSym?.rootCauseNodeId).toBe('db');
    expect(albSym?.causedByNodeId).toBe('api');
    expect(albSym?.causalChain?.map((c) => c.nodeId)).toEqual(['db', 'api', 'alb']);
  });

  it('picks deepest saturated dependency in retry-storm scenarios', () => {
    const fixture = makeCascadeFixture({ withRetry: true });
    const insights = diagnose(fixture);

    const dbRoot = insights.find((i) => i.ruleId === 'db-pool-exhausted');
    const retry = insights.find((i) => i.ruleId === 'retry-storm');

    expect(dbRoot?.isRootCause).toBe(true);
    expect(retry).toBeDefined();
    expect(retry?.rootCauseNodeId).toBe('db');
    expect(insights[0]!.nodeIds).toContain('db');
  });

  it('handles cyclic graphs gracefully without infinite recursion', () => {
    const d = createEmptyDesign('cycle', 'Cycle');
    d.nodes = [
      {
        id: 'a',
        serviceId: 'generic.service',
        label: 'A',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'b',
        serviceId: 'generic.service',
        label: 'B',
        position: { x: 100, y: 0 },
        config: { instances: 1, operations: {} },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'a', to: 'b', protocol: 'http', callType: 'sync', weight: 1 },
      { id: 'e2', from: 'b', to: 'a', protocol: 'http', callType: 'sync', weight: 1 },
    ];
    const ranked = applyCausalDagAndRank(d, [
      {
        ruleId: 'slots-exhausted',
        severity: 'critical',
        nodeIds: ['a'],
        title: 'A slots',
        explanation: { short: 'a', deep: 'a' },
        fixes: [],
        impactScore: 2,
      },
      {
        ruleId: 'cpu-saturated',
        severity: 'critical',
        nodeIds: ['b'],
        title: 'B cpu',
        explanation: { short: 'b', deep: 'b' },
        fixes: [],
        impactScore: 2,
      },
    ]);
    expect(ranked).toHaveLength(2);
  });
});
