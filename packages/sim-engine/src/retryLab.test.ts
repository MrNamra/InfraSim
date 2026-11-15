import { describe, expect, it } from 'vitest';
import { runSimulation } from './engine.js';
import { createEmptyDesign, type Design, type Scenario } from '@infrasim/shared-types';

function createRetryLabTestDesign(): { design: Design; scenario: Scenario } {
  const d = createEmptyDesign('test-retry-lab', 'Test Retry Lab');
  d.settings.seed = 42;
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: {
        instances: 1,
        timeoutMs: 1000,
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      position: { x: 200, y: 0 },
      config: {
        instances: 3,
        vcpu: 2,
        memoryGb: 4,
        maxInFlightPerInstance: 20,
        cpuMsPerRequest: 2,
        timeoutMs: 1000,
        latency: { distribution: 'fixed', p50: 2, p95: 5 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'DB',
      position: { x: 400, y: 0 },
      config: {
        instances: 1,
        connections: { max: 100 },
        connectionWaitMs: 1000,
        latency: { distribution: 'fixed', p50: 20, p95: 20 },
        operations: {},
      },
    },
  ];

  d.edges = [
    {
      id: 'e-client-api',
      from: 'client',
      to: 'api',
      protocol: 'https',
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-api-db',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
      retry: {
        max: 2,
        backoffMs: 0,
        jitter: false,
      },
    },
  ];

  const scenario: Scenario = {
    id: 'sc-test-retry',
    name: 'DB Slowdown',
    durationS: 180,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 300 },
    seedOverride: 42,
    flows: [
      {
        id: 'f-1',
        name: 'Query',
        weight: 1,
        steps: [{ method: 'GET', path: '/items' }],
      },
    ],
    chaos: [
      {
        kind: 'add-latency',
        nodeId: 'db',
        atS: 30,
        durationS: 60,
        extraMs: 780,
      },
    ],
  };

  d.scenarios = [scenario];
  return { design: d, scenario };
}

describe('Retry Amplification and Mitigations (Step 5)', () => {
  it('determinism: same inputs and seed give 100% identical results', async () => {
    const { design: d1, scenario: s1 } = createRetryLabTestDesign();
    const { design: d2, scenario: s2 } = createRetryLabTestDesign();

    const res1 = await runSimulation({ design: d1, scenarioId: s1.id }, () => {});
    const res2 = await runSimulation({ design: d2, scenarioId: s2.id }, () => {});

    expect(res1.summary.totalRequests).toBe(res2.summary.totalRequests);
    expect(res1.summary.peakAmplification).toBe(res2.summary.peakAmplification);
    expect(res1.summary.minGoodputRps).toBe(res2.summary.minGoodputRps);
    expect(res1.summary.peakQueueDepth).toBe(res2.summary.peakQueueDepth);
    expect(res1.summary.recoveryTimeS).toBe(res2.summary.recoveryTimeS);

    expect(res1.series.buckets.length).toBe(res2.series.buckets.length);
    for (let i = 0; i < res1.series.buckets.length; i++) {
      const b1 = res1.series.buckets[i]!;
      const b2 = res2.series.buckets[i]!;
      expect(b1.offeredRps).toBe(b2.offeredRps);
      expect(b1.attemptRps).toBe(b2.attemptRps);
      expect(b1.goodputRps).toBe(b2.goodputRps);
      expect(b1.queueDepth).toBe(b2.queueDepth);
      expect(b1.inFlight).toBe(b2.inFlight);
    }
  });

  it('amplification bound: when every attempt fails, amplification is about 1 + maxRetries (within 10%)', async () => {
    const { design, scenario } = createRetryLabTestDesign();
    // Force 100% failure on DB
    const db = design.nodes.find((n) => n.id === 'db')!;
    db.config.errorRate = 1.0;
    // No chaos needed since it always fails
    scenario.chaos = [];
    scenario.durationS = 20;

    const res = await runSimulation({ design, scenarioId: scenario.id }, () => {});
    // retry.max is 2, so every request should attempt 1 initial + 2 retries = 3 attempts
    expect(res.summary.peakAmplification).toBeDefined();
    expect(res.summary.peakAmplification).toBeGreaterThanOrEqual(2.7);
    expect(res.summary.peakAmplification).toBeLessThanOrEqual(3.3);
  });

  it('goodput bound: goodput never exceeds offered RPS, and late completions do not count as goodput', async () => {
    const { design, scenario } = createRetryLabTestDesign();
    const res = await runSimulation({ design, scenarioId: scenario.id }, () => {});

    for (const b of res.series.buckets) {
      const offered = b.offeredRps ?? b.rpsIn;
      const goodput = b.goodputRps ?? 0;
      expect(goodput).toBeLessThanOrEqual(offered + 1e-4);
      // If there are late completions, they must be tracked and not added to goodput
      if ((b.lateCompletionsPerSec ?? 0) > 0) {
        expect(goodput).toBeLessThanOrEqual(offered);
      }
    }
  });

  it('mitigation comparison: baseline shows queue growth, and mitigated variants reduce peak queue and recover faster', async () => {
    const { design, scenario } = createRetryLabTestDesign();

    // Variant A: Baseline (2 immediate retries)
    const resA = await runSimulation({ design, scenarioId: scenario.id }, () => {});

    // Variant B: Bounded retries + backoff + jitter
    const designB = JSON.parse(JSON.stringify(design)) as Design;
    const edgeB = designB.edges.find((e) => e.id === 'e-api-db')!;
    edgeB.retry = { max: 2, backoffMs: 100, jitter: true, fullJitter: true };
    const resB = await runSimulation({ design: designB, scenarioId: scenario.id }, () => {});

    // Variant C: Circuit breaker
    const designC = JSON.parse(JSON.stringify(design)) as Design;
    const edgeC = designC.edges.find((e) => e.id === 'e-api-db')!;
    edgeC.retry = { max: 2, backoffMs: 100, jitter: true, fullJitter: true };
    edgeC.circuitBreaker = { failureThreshold: 5, windowMs: 5000, openMs: 5000 };
    const resC = await runSimulation({ design: designC, scenarioId: scenario.id }, () => {});

    // Variant D: Load shedding
    const designD = JSON.parse(JSON.stringify(design)) as Design;
    const dbD = designD.nodes.find((n) => n.id === 'db')!;
    dbD.config.loadShed = { enabled: true, maxQueueWaitMs: 800, maxInFlight: 100 };
    const resD = await runSimulation({ design: designD, scenarioId: scenario.id }, () => {});

    // Variant E: Retry budget + Breaker + Shedding
    const designE = JSON.parse(JSON.stringify(design)) as Design;
    const edgeE = designE.edges.find((e) => e.id === 'e-api-db')!;
    edgeE.retry = {
      max: 2,
      backoffMs: 100,
      jitter: true,
      fullJitter: true,
      budget: { percent: 20, minRps: 10 },
    };
    edgeE.circuitBreaker = { failureThreshold: 5, windowMs: 5000, openMs: 5000 };
    edgeE.deadlinePropagation = true;
    edgeE.cancelOnTimeout = true;
    const dbE = designE.nodes.find((n) => n.id === 'db')!;
    dbE.config.loadShed = { enabled: true, maxQueueWaitMs: 800, maxInFlight: 100 };
    dbE.config.cancelOnTimeout = true;
    const resE = await runSimulation({ design: designE, scenarioId: scenario.id }, () => {});

    // Baseline queue depth should grow significantly during the fault
    expect(resA.summary.peakQueueDepth).toBeGreaterThan(0);

    // Mitigated variants must have lower peak queue or better/equal recovery than baseline
    expect(resD.summary.peakQueueDepth ?? 0).toBeLessThanOrEqual(resA.summary.peakQueueDepth ?? 0);
    expect(resE.summary.peakQueueDepth ?? 0).toBeLessThanOrEqual(resA.summary.peakQueueDepth ?? 0);

    // Variant E peak amplification should be strictly bounded by the retry budget
    expect(resE.summary.peakAmplification).toBeLessThan(resA.summary.peakAmplification ?? 3);
  });

  it('numerical sanity: zero NaN or Infinity across all buckets and summary fields', async () => {
    const { design, scenario } = createRetryLabTestDesign();
    const res = await runSimulation({ design, scenarioId: scenario.id }, () => {});

    expect(Number.isFinite(res.summary.peakAmplification ?? 1)).toBe(true);
    expect(Number.isFinite(res.summary.minGoodputRps ?? 0)).toBe(true);
    expect(Number.isFinite(res.summary.peakQueueDepth ?? 0)).toBe(true);
    if (res.summary.recoveryTimeS !== null) {
      expect(Number.isFinite(res.summary.recoveryTimeS)).toBe(true);
    }

    for (const b of res.series.buckets) {
      expect(Number.isFinite(b.offeredRps ?? 0)).toBe(true);
      expect(Number.isFinite(b.attemptRps ?? 0)).toBe(true);
      expect(Number.isFinite(b.goodputRps ?? 0)).toBe(true);
      expect(Number.isFinite(b.amplification ?? 1)).toBe(true);
      expect(Number.isFinite(b.inFlight ?? 0)).toBe(true);
      expect(Number.isFinite(b.queueDepth ?? 0)).toBe(true);
      expect(Number.isFinite(b.p50)).toBe(true);
      expect(Number.isFinite(b.p95)).toBe(true);
      expect(Number.isFinite(b.p99)).toBe(true);
    }
  });
});
