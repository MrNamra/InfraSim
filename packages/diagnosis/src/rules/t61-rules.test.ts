import { describe, expect, it } from 'vitest';
import {
  createEmptyDesign,
  type Design,
  type EdgeInstance,
  type NodeInstance,
  type SimulationResult,
} from '@infrasim/shared-types';
import {
  FIRST_20_RULES,
  applyJsonPatch,
  cacheLowHitRatioRule,
  cacheStampedeRule,
  diagnose,
  healthCheckCascadeRule,
  hotPartitionRule,
  noTimeoutRule,
  retryStormRule,
  serverlessDbConnectionsRule,
  singleDbNoReplicaRule,
  singlePointOfFailureRule,
  timeoutInversionRule,
  zombieWorkRule,
} from '../index.js';

function makeSummary(
  overrides: Partial<SimulationResult['perNode'][string]> = {},
): SimulationResult['perNode'][string] {
  return {
    requests: 1000,
    success: 950,
    errors: {},
    drops: 0,
    p50: 20,
    p95: 60,
    p99: 90,
    avgUtilization: 0.4,
    peakUtilization: 0.5,
    avgCpuUtilization: 0.3,
    peakQueueDepth: 0,
    theoreticalMaxRps: 500,
    ...overrides,
  };
}

function makeBaseResult(
  perNode: SimulationResult['perNode'],
  opts: {
    durationS?: number;
    buckets?: SimulationResult['series']['buckets'];
    traces?: SimulationResult['traces'];
    totalRequests?: number;
  } = {},
): SimulationResult {
  const durationS = opts.durationS ?? 6;
  const buckets =
    opts.buckets ??
    Array.from({ length: durationS }, (_, i) => ({
      tS: i + 1,
      rpsIn: 100,
      throughputRps: 95,
      errorRate: 0,
      p50: 20,
      p95: 60,
      p99: 90,
      perNode: Object.fromEntries(
        Object.keys(perNode).map((nid) => [
          nid,
          {
            rpsIn: 100,
            rpsOut: 95,
            errors: 0,
            drops: 0,
            utilization: perNode[nid]!.peakUtilization,
            cpuUtilization: perNode[nid]!.avgCpuUtilization,
            queueDepth: 0,
            inFlight: 5,
            instancesActive: 1,
            p50: perNode[nid]!.p50,
            p95: perNode[nid]!.p95,
            p99: perNode[nid]!.p99,
          },
        ]),
      ),
    }));

  return {
    runId: 't61-test',
    seed: 123,
    durationS,
    scaled: null,
    summary: {
      totalRequests: opts.totalRequests ?? 1000,
      success: 950,
      errors: {},
      p50: 20,
      p95: 60,
      p99: 90,
      throughputRps: 100,
    },
    perNode,
    series: {
      bucketSizeS: 1,
      buckets,
    },
    traces: opts.traces ?? [],
    counters: { perNode: {}, perEdge: {} },
    insights: [],
  };
}

function makeDesign(nodes: NodeInstance[], edges: EdgeInstance[]): Design {
  const d = createEmptyDesign('t61-design', 'T6.1 Rule Fixtures');
  d.nodes = nodes;
  d.edges = edges;
  return d;
}

describe('@infrasim/diagnosis T6.1 23-rule library (positive, negative, fix patches)', () => {
  it('exports >= 20 rules in FIRST_20_RULES and evaluates deterministically', () => {
    expect(FIRST_20_RULES.length).toBeGreaterThanOrEqual(20);
    const ids = FIRST_20_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(FIRST_20_RULES.length);
  });

  it('cache-low-hit-ratio: positive, negative, and fix restores hit ratio >= 85%', () => {
    const cacheNode: NodeInstance = {
      id: 'redis',
      serviceId: 'aws.elasticache_redis',
      label: 'Redis Cache',
      position: { x: 0, y: 0 },
      config: { instances: 1, cacheHitRatio: 0.25, operations: {} },
    };
    const posDesign = makeDesign([cacheNode], []);
    const posResult = makeBaseResult({ redis: makeSummary() });
    const pos = diagnose({ design: posDesign, result: posResult }, [cacheLowHitRatioRule]);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.ruleId).toBe('cache-low-hit-ratio');

    const fixedDesign = applyJsonPatch(posDesign, pos[0]!.fixes[0]!.patch);
    expect(fixedDesign.nodes[0]!.config.cacheHitRatio).toBeGreaterThanOrEqual(0.85);
    expect(
      diagnose({ design: fixedDesign, result: posResult }, [cacheLowHitRatioRule]),
    ).toHaveLength(0);
  });

  it('cache-stampede: positive, negative, and fix doubles DB pool', () => {
    const cache: NodeInstance = {
      id: 'cache',
      serviceId: 'aws.elasticache_redis',
      label: 'Redis',
      position: { x: 0, y: 0 },
      config: { instances: 1, cacheHitRatio: 0.4, operations: {} },
    };
    const db: NodeInstance = {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Primary DB',
      position: { x: 200, y: 0 },
      config: { instances: 1, connections: { max: 50 }, operations: {} },
    };
    const edge: EdgeInstance = {
      id: 'e1',
      from: 'cache',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
    };
    const design = makeDesign([cache, db], [edge]);
    const result = makeBaseResult({
      cache: makeSummary(),
      db: makeSummary({ peakUtilization: 0.94, drops: 12 }),
    });

    const pos = diagnose({ design, result }, [cacheStampedeRule]);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.fixes[0]).toBeDefined();
    const fixedDesign = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixedDesign.nodes[1]!.config.connections?.max).toBe(100);

    const healthyDb = makeBaseResult({
      cache: makeSummary(),
      db: makeSummary({ peakUtilization: 0.45, drops: 0 }),
    });
    expect(diagnose({ design, result: healthyDb }, [cacheStampedeRule])).toHaveLength(0);
  });

  it('serverless-db-connections: positive, negative, and fix raises DB pool ceiling', () => {
    const fnNode: NodeInstance = {
      id: 'fn',
      serviceId: 'aws.lambda',
      label: 'Order Lambda',
      position: { x: 0, y: 0 },
      config: {
        instances: 1,
        coldStart: {
          enabled: true,
          probabilityModel: 'fixed',
          p50: 50,
          p95: 150,
          concurrencyLimit: 200,
        },
        operations: {},
      },
    };
    const db: NodeInstance = {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'RDS Postgres',
      position: { x: 200, y: 0 },
      config: { instances: 1, connections: { max: 80 }, operations: {} },
    };
    const design = makeDesign(
      [fnNode, db],
      [{ id: 'e1', from: 'fn', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 }],
    );
    const posResult = makeBaseResult({
      fn: makeSummary(),
      db: makeSummary({ peakUtilization: 0.91, errors: { timeout: 14 } }),
    });

    const pos = diagnose({ design, result: posResult }, [serverlessDbConnectionsRule]);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.severity).toBe('critical');

    const patchedTwice = applyJsonPatch(
      applyJsonPatch(design, pos[0]!.fixes[0]!.patch),
      pos[0]!.fixes[0]!.patch,
    );
    patchedTwice.nodes[1]!.config.connections = { max: 300 };
    expect(
      diagnose({ design: patchedTwice, result: posResult }, [serverlessDbConnectionsRule]),
    ).toHaveLength(0);
  });

  it('hot-partition: positive, negative, and fix scales KV capacity', () => {
    const kv: NodeInstance = {
      id: 'kv',
      serviceId: 'aws.dynamodb',
      label: 'DynamoDB',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    };
    const design = makeDesign([kv], []);
    const posResult = makeBaseResult({
      kv: makeSummary({ avgUtilization: 0.35, errors: { throttled: 75 } }),
    });

    const pos = diagnose({ design, result: posResult }, [hotPartitionRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.instances).toBe(2);

    const negResult = makeBaseResult({
      kv: makeSummary({ avgUtilization: 0.35, errors: {} }),
    });
    expect(diagnose({ design, result: negResult }, [hotPartitionRule])).toHaveLength(0);
  });

  it('single-db-no-replica: positive, negative, and fix enables replica + Multi-AZ', () => {
    const db: NodeInstance = {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      position: { x: 0, y: 0 },
      config: { instances: 1, readRatio: 0.9, operations: {} },
    };
    const design = makeDesign([db], []);
    const posResult = makeBaseResult({
      db: makeSummary({ peakUtilization: 0.62 }),
    });

    const pos = diagnose({ design, result: posResult }, [singleDbNoReplicaRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.instances).toBe(2);
    expect(fixed.nodes[0]!.az).toBe('multi-az');
    expect(diagnose({ design: fixed, result: posResult }, [singleDbNoReplicaRule])).toHaveLength(0);
  });

  it('single-point-of-failure: positive, negative, and fix sets instances >= 2 and Multi-AZ', () => {
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'aws.ecs_ec2',
      label: 'API Service',
      position: { x: 0, y: 0 },
      az: 'us-east-1a',
      config: { instances: 1, operations: {} },
    };
    const design = makeDesign([api], []);
    const result = makeBaseResult({
      api: makeSummary({ requests: 900 }),
    });

    const pos = diagnose({ design, result }, [singlePointOfFailureRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.instances).toBe(2);
    expect(fixed.nodes[0]!.az).toBe('multi-az');
    expect(diagnose({ design: fixed, result }, [singlePointOfFailureRule])).toHaveLength(0);
  });

  it('retry-storm: positive, negative, and fix adds exponential backoff, jitter, and circuit breaker', () => {
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'generic.service',
      label: 'API',
      position: { x: 0, y: 0 },
      config: { instances: 2, operations: {} },
    };
    const db: NodeInstance = {
      id: 'db',
      serviceId: 'generic.db',
      label: 'DB',
      position: { x: 200, y: 0 },
      config: { instances: 1, operations: {} },
    };
    const edge: EdgeInstance = {
      id: 'e1',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
      retry: { max: 4, backoffMs: 5, jitter: false },
    };
    const design = makeDesign([api, db], [edge]);
    const result = makeBaseResult({
      api: makeSummary({ requests: 1000 }),
      db: makeSummary({ requests: 1800, peakUtilization: 0.98, errors: { timeout: 450 } }),
    });

    const pos = diagnose({ design, result }, [retryStormRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.edges[0]!.retry?.jitter).toBe(true);
    expect(fixed.edges[0]!.retry?.backoffMs).toBeGreaterThanOrEqual(100);
    expect(fixed.edges[0]!.circuitBreaker).toBeDefined();

    const calmResult = makeBaseResult({
      api: makeSummary({ requests: 1000 }),
      db: makeSummary({ requests: 1000, peakUtilization: 0.4, errors: {} }),
    });
    expect(diagnose({ design: fixed, result: calmResult }, [retryStormRule])).toHaveLength(0);
  });

  it('no-timeout: positive, negative, and fix adds an explicit timeoutMs', () => {
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'generic.service',
      label: 'API',
      position: { x: 0, y: 0 },
      config: { instances: 2, operations: {} },
    };
    const db: NodeInstance = {
      id: 'db',
      serviceId: 'generic.db',
      label: 'DB',
      position: { x: 200, y: 0 },
      config: { instances: 1, operations: {} },
    };
    const design = makeDesign(
      [api, db],
      [{ id: 'e1', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 }],
    );
    const result = makeBaseResult({
      api: makeSummary({ p50: 25, p99: 420 }),
      db: makeSummary(),
    });

    const pos = diagnose({ design, result }, [noTimeoutRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.timeoutMs).toBeGreaterThan(0);
    expect(diagnose({ design: fixed, result }, [noTimeoutRule])).toHaveLength(0);
  });

  it('timeout-inversion: positive, negative, and fix sets downstream timeout below parent', () => {
    const gw: NodeInstance = {
      id: 'gw',
      serviceId: 'generic.gateway',
      label: 'Gateway',
      position: { x: 0, y: 0 },
      config: { instances: 2, timeoutMs: 2000, operations: {} },
    };
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'generic.service',
      label: 'API',
      position: { x: 200, y: 0 },
      config: { instances: 2, timeoutMs: 5000, operations: {} },
    };
    const design = makeDesign(
      [gw, api],
      [{ id: 'e1', from: 'gw', to: 'api', protocol: 'http', callType: 'sync', weight: 1 }],
    );
    const result = makeBaseResult({
      gw: makeSummary(),
      api: makeSummary(),
    });

    const pos = diagnose({ design, result }, [timeoutInversionRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[1]!.config.timeoutMs).toBeLessThan(2000);
    expect(diagnose({ design: fixed, result }, [timeoutInversionRule])).toHaveLength(0);
  });

  it('zombie-work: positive, negative, and fix caps server deadline', () => {
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'generic.service',
      label: 'Worker API',
      position: { x: 0, y: 0 },
      config: { instances: 2, timeoutMs: 5000, operations: {} },
    };
    const design = makeDesign([api], []);
    const posResult = makeBaseResult({
      api: makeSummary({ requests: 500, p50: 20, wastedWorkMs: 2500 }),
    });

    const pos = diagnose({ design, result: posResult }, [zombieWorkRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.timeoutMs).toBe(3000);

    const cleanResult = makeBaseResult({
      api: makeSummary({ requests: 500, p50: 20, wastedWorkMs: 0 }),
    });
    expect(diagnose({ design: fixed, result: cleanResult }, [zombieWorkRule])).toHaveLength(0);
  });

  it('health-check-cascade: positive, negative, and fix adds N+1 headroom', () => {
    const api: NodeInstance = {
      id: 'api',
      serviceId: 'generic.service',
      label: 'API Pool',
      position: { x: 0, y: 0 },
      config: { instances: 2, operations: {} },
    };
    const design = makeDesign([api], []);
    const perNode = { api: makeSummary({ peakUtilization: 0.95 }) };
    const buckets: SimulationResult['series']['buckets'] = [
      {
        tS: 1,
        rpsIn: 100,
        throughputRps: 100,
        errorRate: 0,
        p50: 20,
        p95: 50,
        p99: 80,
        perNode: {
          api: {
            rpsIn: 100,
            rpsOut: 100,
            errors: 0,
            drops: 0,
            utilization: 0.5,
            cpuUtilization: 0.4,
            queueDepth: 0,
            inFlight: 5,
            instancesActive: 2,
            p50: 20,
            p95: 50,
            p99: 80,
          },
        },
      },
      {
        tS: 2,
        rpsIn: 100,
        throughputRps: 70,
        errorRate: 0.3,
        p50: 80,
        p95: 250,
        p99: 400,
        perNode: {
          api: {
            rpsIn: 100,
            rpsOut: 70,
            errors: 10,
            drops: 20,
            utilization: 0.98,
            cpuUtilization: 0.9,
            queueDepth: 20,
            inFlight: 12,
            instancesActive: 1,
            p50: 80,
            p95: 250,
            p99: 400,
          },
        },
      },
    ];
    const posResult = makeBaseResult(perNode, { durationS: 2, buckets });

    const pos = diagnose({ design, result: posResult }, [healthCheckCascadeRule]);
    expect(pos).toHaveLength(1);
    const fixed = applyJsonPatch(design, pos[0]!.fixes[0]!.patch);
    expect(fixed.nodes[0]!.config.instances).toBe(4);

    const healthyBuckets = buckets.map((b) => ({
      ...b,
      perNode: {
        api: {
          ...b.perNode.api!,
          instancesActive: 4,
          utilization: 0.4,
          drops: 0,
        },
      },
    }));
    const negResult = makeBaseResult(perNode, { durationS: 2, buckets: healthyBuckets });
    expect(diagnose({ design: fixed, result: negResult }, [healthCheckCascadeRule])).toHaveLength(
      0,
    );
  });
});
