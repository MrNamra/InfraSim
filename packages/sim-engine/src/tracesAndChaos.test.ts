import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { runSimulation } from './engine.js';

function makeRetryChaosDesign(options: {
  upstreamTimeoutMs?: number;
  downstreamP50?: number;
  maxRetries?: number;
  chaos?: Design['scenarios'][number]['chaos'];
}): Design {
  const d = createEmptyDesign('d-traces', 'Traces & Chaos Test');
  d.settings.seed = 42;
  d.nodes = [
    {
      id: 'n-client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 40, y: 100 },
      config: {
        instances: 1,
        timeoutMs: options.upstreamTimeoutMs ?? 5000,
        operations: {},
      },
    },
    {
      id: 'n-api',
      serviceId: 'aws.ec2',
      label: 'API',
      az: 'az-a',
      position: { x: 240, y: 100 },
      config: {
        instances: 2,
        instanceType: 't3.medium',
        maxInFlightPerInstance: 20,
        timeoutMs: options.upstreamTimeoutMs ?? 5000,
        cancelOnTimeout: false,
        latency: {
          distribution: 'fixed',
          p50: options.downstreamP50 ?? 10,
          p95: options.downstreamP50 ?? 10,
        },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-c-api',
      from: 'n-client',
      to: 'n-api',
      protocol: 'http',
      callType: 'sync',
      weight: 1,
      retry: {
        max: options.maxRetries ?? 0,
        backoffMs: 10,
        jitter: false,
      },
    },
  ];
  d.scenarios = [
    {
      id: 'sc-1',
      name: 'Test',
      durationS: 10,
      entryNodeId: 'n-client',
      profile: { kind: 'constant', rps: 5 },
      flows: [{ id: 'f1', name: 'Req', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
      chaos: options.chaos ?? [],
    },
  ];
  return d;
}

describe('trace span attrs & chaos injection', () => {
  it('records retried attempt attrs on retry spans', async () => {
    const design = makeRetryChaosDesign({
      maxRetries: 2,
      chaos: [{ atS: 0, durationS: 10, kind: 'error-rate', nodeId: 'n-api', rate: 0.7 }],
    });
    const res = await runSimulation({ design, scenarioId: 'sc-1', seed: 42 }, () => {});
    const allSpans = res.traces.flatMap((t) => t.spans);
    const retriedSpans = allSpans.filter((s) => s.attrs?.retried === 1);
    expect(retriedSpans.length).toBeGreaterThan(0);
    expect(retriedSpans.some((s) => Number(s.attrs?.attempt ?? 0) >= 2)).toBe(true);
  });

  it('records timedOut and zombie work span attrs when caller times out without cancelOnTimeout', async () => {
    const design = makeRetryChaosDesign({
      upstreamTimeoutMs: 25,
      downstreamP50: 120,
      maxRetries: 0,
    });
    const res = await runSimulation({ design, scenarioId: 'sc-1', seed: 42 }, () => {});
    const apiSummary = res.perNode['n-api']!;
    expect(apiSummary.wastedWorkMs ?? 0).toBeGreaterThan(0);

    const apiSpans = res.traces.flatMap((t) => t.spans).filter((s) => s.nodeId === 'n-api');
    expect(apiSpans.some((s) => s.attrs?.timedOut === 1)).toBe(true);
    expect(apiSpans.some((s) => s.attrs?.zombie === 1)).toBe(true);
  });

  it('injects deterministic add-latency chaos during window only', async () => {
    const base = makeRetryChaosDesign({ downstreamP50: 10 });
    const withChaos = makeRetryChaosDesign({
      downstreamP50: 10,
      chaos: [{ atS: 2, durationS: 4, kind: 'add-latency', nodeId: 'n-api', extraMs: 200 }],
    });

    const baseRes = await runSimulation({ design: base, scenarioId: 'sc-1', seed: 42 }, () => {});
    const chaosRes = await runSimulation(
      { design: withChaos, scenarioId: 'sc-1', seed: 42 },
      () => {},
    );
    const chaosAgain = await runSimulation(
      { design: withChaos, scenarioId: 'sc-1', seed: 42 },
      () => {},
    );

    expect(chaosRes.summary).toEqual(chaosAgain.summary);
    expect(chaosRes.series.buckets[3]!.p95).toBeGreaterThan(baseRes.series.buckets[3]!.p95 + 150);
    expect(chaosRes.series.buckets[8]!.p95).toBeLessThan(baseRes.series.buckets[8]!.p95 + 40);
  });
});
