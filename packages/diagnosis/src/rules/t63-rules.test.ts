import { describe, expect, it } from 'vitest';
import {
  createEmptyDesign,
  type CostReport,
  type Design,
  type NetworkAnalysis,
  type NodeInstance,
  type SimulationResult,
} from '@infrasim/shared-types';
import {
  ALL_DIAGNOSIS_RULES,
  applyJsonPatch,
  coldStartTailRule,
  contextTooLargeRule,
  costDominantLineRule,
  crossAzChattyRule,
  crossRegionLatencyRule,
  dbPublicRule,
  diagnose,
  egressHeavyRule,
  gatewayTimeoutVsLlmRule,
  lbIdleTimeoutMismatchRule,
  llmOnCriticalPathRule,
  llmTpmThrottleRule,
  natCostHotspotRule,
  noCircuitBreakerRule,
  noDlqRule,
  noNatPrivateEgressRule,
  overSpecVsNeedRule,
  syncWhereAsyncRule,
  wideOpenIngressRule,
} from '../index.js';

function makeSummary(
  overrides: Partial<SimulationResult['perNode'][string]> = {},
): SimulationResult['perNode'][string] {
  return {
    requests: 1000,
    success: 950,
    errors: {},
    drops: 0,
    p50: 25,
    p95: 70,
    p99: 110,
    avgUtilization: 0.4,
    peakUtilization: 0.5,
    avgCpuUtilization: 0.3,
    peakQueueDepth: 0,
    theoreticalMaxRps: 500,
    ...overrides,
  };
}

function makeResult(perNode: SimulationResult['perNode']): SimulationResult {
  return {
    runId: 't63-test',
    seed: 7,
    durationS: 5,
    scaled: null,
    summary: {
      totalRequests: 1000,
      success: 900,
      errors: {},
      p50: 25,
      p95: 70,
      p99: 110,
      throughputRps: 180,
    },
    perNode,
    series: {
      bucketSizeS: 1,
      buckets: Array.from({ length: 5 }, (_, idx) => ({
        tS: idx + 1,
        rpsIn: 200,
        throughputRps: 180,
        errorRate: 0,
        p50: 25,
        p95: 70,
        p99: 110,
        perNode: Object.fromEntries(
          Object.keys(perNode).map((id) => [
            id,
            {
              rpsIn: 200,
              rpsOut: 180,
              errors: 0,
              drops: 0,
              utilization: perNode[id]!.peakUtilization,
              cpuUtilization: 0.3,
              queueDepth: 0,
              inFlight: 5,
              instancesActive: 1,
              p50: perNode[id]!.p50,
              p95: perNode[id]!.p95,
              p99: perNode[id]!.p99,
            },
          ]),
        ),
      })),
    },
    traces: [],
    counters: { perNode: {}, perEdge: {} },
    insights: [],
  };
}

function baseNode(
  id: string,
  serviceId: string,
  label: string,
  config: Partial<NodeInstance['config']> = {},
): NodeInstance {
  return {
    id,
    serviceId,
    label,
    position: { x: 0, y: 0 },
    config: { instances: 2, operations: {}, ...config },
  };
}

describe('@infrasim/diagnosis T6.3 complete Spec 17 rule set coverage', () => {
  it('covers every rule ID in Spec 17 §3 and degrades gracefully when optional inputs are absent', () => {
    const ids = new Set(ALL_DIAGNOSIS_RULES.map((r) => r.id));
    const spec17Ids = [
      'bottleneck-node',
      'cpu-saturated',
      'slots-exhausted',
      'queue-growing',
      'drops-queue-full',
      'autoscale-too-slow',
      'idle-overprovisioned',
      'db-pool-exhausted',
      'db-read-heavy-no-cache',
      'cache-low-hit-ratio',
      'cache-stampede',
      'serverless-db-connections',
      'hot-partition',
      'single-db-no-replica',
      'single-point-of-failure',
      'retry-storm',
      'no-timeout',
      'timeout-inversion',
      'zombie-work',
      'health-check-cascade',
      'no-circuit-breaker',
      'lb-idle-timeout-mismatch',
      'no-dlq',
      'sync-where-async',
      'serverless-throttled',
      'cold-start-tail',
      'gateway-timeout-vs-llm',
      'llm-tpm-throttle',
      'llm-on-critical-path',
      'context-too-large',
      'network-edge-blocked',
      'db-public',
      'wide-open-ingress',
      'no-nat-private-egress',
      'cross-az-chatty',
      'cross-region-latency',
      'cost-dominant-line',
      'nat-cost-hotspot',
      'egress-heavy',
      'over-spec-vs-need',
    ];
    for (const id of spec17Ids) {
      expect(ids.has(id)).toBe(true);
    }

    const empty = createEmptyDesign('empty', 'Empty');
    expect(diagnose({ design: empty })).toEqual([]);
  });

  it('no-circuit-breaker, lb-idle-timeout-mismatch, no-dlq, sync-where-async work with fixes', () => {
    const lb = baseNode('lb', 'aws.alb', 'ALB', {
      lb: { algorithm: 'round-robin', idleTimeoutMs: 500 },
    });
    const api = baseNode('api', 'aws.ecs_ec2', 'API');
    const q = baseNode('q', 'aws.sqs', 'Jobs Queue', {
      consumer: { concurrency: 5, batchSize: 10, pollMs: 100, maxRetries: 3, dlq: false },
    });
    const slowMl = baseNode('ml', 'aws.sagemaker', 'Slow ML');
    const design: Design = {
      ...createEmptyDesign('res-63', 'Resilience'),
      nodes: [lb, api, q, slowMl],
      edges: [
        { id: 'e-lb', from: 'lb', to: 'api', protocol: 'http', callType: 'sync', weight: 1 },
        {
          id: 'e-cb',
          from: 'api',
          to: 'slowFail' in { slowFail: 1 } ? 'ml' : 'ml',
          protocol: 'http',
          callType: 'sync',
          weight: 1,
          retry: { max: 3, backoffMs: 50, jitter: true },
        },
        { id: 'e-q', from: 'api', to: 'q', protocol: 'amqp', callType: 'async', weight: 1 },
      ],
    };

    const result = makeResult({
      lb: makeSummary(),
      api: makeSummary({ p99: 1200 }),
      ml: makeSummary({ p95: 1500, errors: { server: 650 } }),
      q: makeSummary({ drops: 25 }),
    });

    const cbPos = diagnose({ design, result }, [noCircuitBreakerRule]);
    expect(cbPos).toHaveLength(1);
    const cbFixed = applyJsonPatch(design, cbPos[0]!.fixes[0]!.patch);
    expect(diagnose({ design: cbFixed, result }, [noCircuitBreakerRule])).toHaveLength(0);

    const lbPos = diagnose({ design, result }, [lbIdleTimeoutMismatchRule]);
    expect(lbPos).toHaveLength(1);
    const lbFixed = applyJsonPatch(design, lbPos[0]!.fixes[0]!.patch);
    expect(diagnose({ design: lbFixed, result }, [lbIdleTimeoutMismatchRule])).toHaveLength(0);

    const dlqPos = diagnose({ design, result }, [noDlqRule]);
    expect(dlqPos).toHaveLength(1);
    const dlqFixed = applyJsonPatch(design, dlqPos[0]!.fixes[0]!.patch);
    expect(diagnose({ design: dlqFixed, result }, [noDlqRule])).toHaveLength(0);

    const syncPos = diagnose({ design, result }, [syncWhereAsyncRule]);
    expect(syncPos).toHaveLength(1);
    const syncFixed = applyJsonPatch(design, syncPos[0]!.fixes[0]!.patch);
    expect(diagnose({ design: syncFixed, result }, [syncWhereAsyncRule])).toHaveLength(0);
  });

  it('serverless & AI rules trigger positively, pass negatives, and fix cleanly', () => {
    const fnNode = baseNode('fn', 'aws.lambda', 'EdgeFn', {
      timeoutMs: 1000,
      coldStart: { enabled: true, probabilityModel: 'fixed', p50: 120, p95: 450 },
    });
    const llmNode = baseNode('llm', 'aws.bedrock', 'Bedrock LLM', {
      rateLimit: { tpm: 60_000, maxContextTokens: 4096 },
    });
    const design: Design = {
      ...createEmptyDesign('ai-63', 'Serverless AI'),
      nodes: [fnNode, llmNode],
      edges: [
        { id: 'e-llm', from: 'fn', to: 'llm', protocol: 'https', callType: 'sync', weight: 1 },
      ],
    };
    const posResult = makeResult({
      fn: makeSummary({ p50: 30, p99: 420 }),
      llm: makeSummary({ p95: 1800, errors: { throttled: 40, server: 15 } }),
    });

    const cs = diagnose({ design, result: posResult }, [coldStartTailRule]);
    expect(cs).toHaveLength(1);
    expect(
      diagnose({ design: applyJsonPatch(design, cs[0]!.fixes[0]!.patch), result: posResult }, [
        coldStartTailRule,
      ]),
    ).toHaveLength(0);

    const gwVsLlm = diagnose({ design, result: posResult }, [gatewayTimeoutVsLlmRule]);
    expect(gwVsLlm).toHaveLength(1);
    expect(
      diagnose({ design: applyJsonPatch(design, gwVsLlm[0]!.fixes[0]!.patch), result: posResult }, [
        gatewayTimeoutVsLlmRule,
      ]),
    ).toHaveLength(0);

    const tpm = diagnose({ design, result: posResult }, [llmTpmThrottleRule]);
    expect(tpm).toHaveLength(1);
    const tpmFixed = applyJsonPatch(design, tpm[0]!.fixes[0]!.patch);
    expect(tpmFixed.nodes[1]!.config.rateLimit?.tpm).toBe(120_000);
    const noTpmErr = makeResult({ fn: posResult.perNode.fn!, llm: makeSummary({ p95: 1800 }) });
    expect(diagnose({ design: tpmFixed, result: noTpmErr }, [llmTpmThrottleRule])).toHaveLength(0);

    const crit = diagnose({ design, result: posResult }, [llmOnCriticalPathRule]);
    expect(crit).toHaveLength(1);
    expect(
      diagnose({ design: applyJsonPatch(design, crit[0]!.fixes[0]!.patch), result: posResult }, [
        llmOnCriticalPathRule,
      ]),
    ).toHaveLength(0);

    const ctxErr = diagnose({ design, result: posResult }, [contextTooLargeRule]);
    expect(ctxErr).toHaveLength(1);
    expect(
      applyJsonPatch(design, ctxErr[0]!.fixes[0]!.patch).nodes[1]!.config.rateLimit
        ?.maxContextTokens,
    ).toBe(8192);
    expect(diagnose({ design, result: noTpmErr }, [contextTooLargeRule])).toHaveLength(0);
  });

  it('network rules cover db-public, wide-open-ingress, no-nat-private-egress, cross-az-chatty, cross-region-latency', () => {
    const api = {
      ...baseNode('api', 'aws.ecs_ec2', 'API'),
      region: 'us-east-1',
      az: 'us-east-1a',
    };
    const db = {
      ...baseNode('db', 'aws.rds_postgres', 'DB'),
      region: 'eu-west-1',
      az: 'eu-west-1b',
    };
    const internet = baseNode('inet', 'generic.internet', 'Internet');
    const design: Design = {
      ...createEmptyDesign('net-63', 'Network Rules'),
      nodes: [api, db, internet],
      edges: [
        { id: 'e-db', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
        { id: 'e-inet', from: 'api', to: 'inet', protocol: 'https', callType: 'sync', weight: 1 },
      ],
    };

    const net: NetworkAnalysis = {
      edges: {
        'e-db': {
          reachable: true,
          hops: [],
          explanation: { short: 'ok', deep: 'ok' },
          fixes: [],
          crossAz: true,
          crossRegion: true,
          extraLatencyMs: 75,
        },
        'e-inet': {
          reachable: false,
          reasonCode: 'NO_NAT',
          failureMode: 'timeout',
          hops: [],
          explanation: { short: 'No NAT gateway route', deep: 'Add NAT' },
          fixes: [{ label: 'Add NAT Gateway', patch: [] }],
        },
      },
      smells: [
        {
          ruleId: 'net-smell-db-public-subnet',
          severity: 'warning',
          nodeIds: ['db'],
          edgeIds: ['e-db'],
          title: 'Public DB',
          short: 'DB in public subnet',
          deep: 'Move to private subnet',
          fixes: [{ label: 'Make subnet private', patch: [] }],
        },
        {
          ruleId: 'net-smell-ssh-open',
          severity: 'critical',
          nodeIds: ['api'],
          edgeIds: [],
          title: 'SSH 0.0.0.0/0',
          short: 'Port 22 open',
          deep: 'Restrict SG',
          fixes: [{ label: 'Restrict CIDR', patch: [] }],
        },
      ],
    };

    const result = makeResult({
      api: makeSummary(),
      db: makeSummary({ requests: 500 }),
      inet: makeSummary(),
    });

    expect(diagnose({ design, network: net, result }, [dbPublicRule])).toHaveLength(1);
    expect(diagnose({ design, network: net, result }, [wideOpenIngressRule])).toHaveLength(1);
    expect(diagnose({ design, network: net, result }, [noNatPrivateEgressRule])).toHaveLength(1);
    expect(diagnose({ design, network: net, result }, [crossAzChattyRule])).toHaveLength(1);
    const cr = diagnose({ design, network: net, result }, [crossRegionLatencyRule]);
    expect(cr).toHaveLength(1);
    const crFixed = applyJsonPatch(design, cr[0]!.fixes[0]!.patch);
    expect(crFixed.nodes[1]!.region).toBe('us-east-1');

    const cleanNet: NetworkAnalysis = { edges: {}, smells: [] };
    expect(diagnose({ design: crFixed, network: cleanNet, result }, [dbPublicRule])).toHaveLength(
      0,
    );
    expect(
      diagnose({ design: crFixed, network: cleanNet, result }, [wideOpenIngressRule]),
    ).toHaveLength(0);
    expect(
      diagnose({ design: crFixed, network: cleanNet, result }, [noNatPrivateEgressRule]),
    ).toHaveLength(0);
    expect(
      diagnose({ design: crFixed, network: cleanNet, result }, [crossAzChattyRule]),
    ).toHaveLength(0);
    expect(
      diagnose({ design: crFixed, network: cleanNet, result }, [crossRegionLatencyRule]),
    ).toHaveLength(0);
  });

  it('cost rules fire positively on hotspots & overspec and stay quiet cleanly on balanced spend', () => {
    const api = baseNode('api', 'aws.ecs_ec2', 'Heavy API', { instances: 4, vcpu: 8 });
    const nat = baseNode('nat', 'aws.nat_gw', 'NAT GW', { instances: 1 });
    const design: Design = {
      ...createEmptyDesign('cost-63', 'Cost Rules'),
      nodes: [api, nat],
      edges: [],
    };
    const result = makeResult({
      api: makeSummary({ peakUtilization: 0.12 }),
      nat: makeSummary(),
    });
    const highCost: CostReport = {
      currency: 'USD',
      asOf: '2026-11-12',
      monthlyTotal: 200,
      perNode: {
        api: {
          subtotal: 120,
          lines: [
            {
              dimension: 'Compute',
              quantity: 4,
              unit: 'hr',
              unitPrice: 0.04,
              amount: 120,
              source: 'synced',
            },
          ],
        },
        nat: {
          subtotal: 40,
          lines: [
            {
              dimension: 'NAT hour',
              quantity: 730,
              unit: 'hr',
              unitPrice: 0.045,
              amount: 40,
              source: 'synced',
            },
          ],
        },
      },
      transfer: [
        {
          dimension: 'Internet egress out',
          quantity: 800,
          unit: 'GB',
          unitPrice: 0.09,
          amount: 60,
          source: 'synced',
        },
      ],
      byCategory: { compute: 120, net: 100 },
      costPerMillionRequests: 10,
      warnings: [],
      assumptions: {
        hoursPerMonth: 730,
        traffic: { mode: 'run-average' },
        instanceCountMode: 'average',
        includeFreeTier: true,
        currency: 'USD',
      },
    };

    expect(diagnose({ design, result, cost: highCost }, [costDominantLineRule])).toHaveLength(1);
    expect(diagnose({ design, result, cost: highCost }, [natCostHotspotRule])).toHaveLength(1);
    expect(diagnose({ design, result, cost: highCost }, [egressHeavyRule])).toHaveLength(1);
    const over = diagnose({ design, result, cost: highCost }, [overSpecVsNeedRule]);
    expect(over).toHaveLength(1);
    expect(applyJsonPatch(design, over[0]!.fixes[0]!.patch).nodes[0]!.config.instances).toBe(2);

    const balancedCost: CostReport = {
      ...highCost,
      monthlyTotal: 100,
      perNode: {
        api: { subtotal: 15, lines: [] },
        nat: { subtotal: 5, lines: [] },
      },
      transfer: [],
    };
    expect(diagnose({ design, result, cost: balancedCost }, [costDominantLineRule])).toHaveLength(
      0,
    );
    expect(diagnose({ design, result, cost: balancedCost }, [natCostHotspotRule])).toHaveLength(0);
    expect(diagnose({ design, result, cost: balancedCost }, [egressHeavyRule])).toHaveLength(0);
    expect(diagnose({ design, result, cost: balancedCost }, [overSpecVsNeedRule])).toHaveLength(0);
  });
});
