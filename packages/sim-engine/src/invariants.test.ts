import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { runSimulation } from './index.js';

function makeRandomChainDesign(seed: number, rps: number, p50Ms: number, conc: number): Design {
  const d = createEmptyDesign(`prop-${seed}`, 'Property Chain');
  d.settings.seed = seed;
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'app',
      serviceId: 'generic.service',
      label: 'App',
      position: { x: 180, y: 0 },
      config: {
        instances: 1,
        vcpu: 2,
        cluster: true,
        cpuMsPerRequest: 2,
        maxInFlightPerInstance: conc,
        queue: { maxLength: 50, policy: 'reject' },
        latency: { distribution: 'lognormal', p50: p50Ms, p95: p50Ms * 2 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'generic.db',
      label: 'DB',
      position: { x: 360, y: 0 },
      config: {
        instances: 1,
        connections: { max: Math.max(5, Math.round(conc / 2)) },
        connectionWaitMs: 300,
        latency: { distribution: 'lognormal', p50: p50Ms, p95: p50Ms * 2.5 },
        operations: {},
      },
    },
  ];
  d.edges = [
    { id: 'e1', from: 'client', to: 'app', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'app', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];
  d.scenarios = [
    {
      id: 's1',
      name: 'Random test',
      durationS: 6,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps },
      flows: [{ id: 'f1', name: 'Read', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
      chaos: [],
    },
  ];
  return d;
}

function assertFiniteEverywhere(obj: unknown, path = 'root'): void {
  if (typeof obj === 'number') {
    expect(Number.isFinite(obj), `Expected finite number at ${path}, got ${obj}`).toBe(true);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertFiniteEverywhere(obj[i], `${path}[${i}]`);
    }
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      assertFiniteEverywhere(v, `${path}.${k}`);
    }
  }
}

describe('@infrasim/sim-engine T1.8 property-based invariants (spec 05 §12)', () => {
  it('enforces conservation, monotonic time, capacity bounds, zero NaN and ordered percentiles across random topologies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 10, max: 220 }),
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 4, max: 60 }),
        async (seed, rps, p50Ms, conc) => {
          const design = makeRandomChainDesign(seed, rps, p50Ms, conc);
          const frames: number[] = [];

          const res = await runSimulation({ design, scenarioId: 's1' }, (f) => {
            frames.push(f.tVirtualMs);
            for (const [nodeId, nf] of Object.entries(f.nodes)) {
              const slots =
                nodeId === 'app'
                  ? conc
                  : nodeId === 'db'
                    ? Math.max(5, Math.round(conc / 2))
                    : 10000;
              expect(nf.inFlight).toBeLessThanOrEqual(slots);
              expect(nf.latency.p50).toBeLessThanOrEqual(nf.latency.p95);
              expect(nf.latency.p95).toBeLessThanOrEqual(nf.latency.p99);
            }
          });

          assertFiniteEverywhere(res);

          // Monotonic frame times and bucket index ordering
          for (let i = 1; i < frames.length; i++) {
            expect(frames[i]!).toBeGreaterThanOrEqual(frames[i - 1]!);
          }
          expect(res.series.buckets.length).toBe(design.scenarios[0]!.durationS);
          for (let i = 0; i < res.series.buckets.length; i++) {
            expect(res.series.buckets[i]!.tS).toBe(i + 1);
          }

          // Percentile ordering everywhere
          expect(res.summary.p50).toBeLessThanOrEqual(res.summary.p95);
          expect(res.summary.p95).toBeLessThanOrEqual(res.summary.p99);

          // Per-node conservation at end of run and across bucket cumulative sums
          const lastBucket = res.series.buckets[res.series.buckets.length - 1]!;
          for (const node of design.nodes) {
            const ns = res.perNode[node.id]!;
            expect(ns.p50).toBeLessThanOrEqual(ns.p95);
            expect(ns.p95).toBeLessThanOrEqual(ns.p99);

            const errSum = Object.values(ns.errors).reduce<number>((a, b) => a + (b ?? 0), 0);
            const endNodeState = lastBucket.perNode[node.id]!;
            const accounted =
              ns.success + errSum + ns.drops + endNodeState.inFlight + endNodeState.queueDepth;
            expect(ns.requests).toBe(accounted);

            // Check running cumulative bucket conservation at every single second
            let cumIn = 0;
            let cumOut = 0;
            let cumErr = 0;
            let cumDrop = 0;
            for (const b of res.series.buckets) {
              const nb = b.perNode[node.id]!;
              cumIn += nb.rpsIn;
              cumOut += nb.rpsOut;
              cumErr += nb.errors;
              cumDrop += nb.drops;
              expect(cumIn).toBe(cumOut + cumErr + cumDrop + nb.inFlight + nb.queueDepth);
            }
          }
        },
      ),
      { numRuns: 12 },
    );
  });

  it('is 100% deterministic for identical design + scenario + seed', async () => {
    const design = makeRandomChainDesign(1234, 90, 12, 30);
    const a = await runSimulation({ design, scenarioId: 's1' }, () => {});
    const b = await runSimulation({ design, scenarioId: 's1' }, () => {});
    expect(a).toEqual(b);
  });

  it('isolates per-node RNG streams so mutating disconnected node B does not affect node A', async () => {
    const build = (bLatencyP50: number) => {
      const d = createEmptyDesign('iso-test', 'Isolation');
      d.settings.seed = 777;
      d.nodes = [
        {
          id: 'client',
          serviceId: 'generic.client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 'nodeA',
          serviceId: 'generic.service',
          label: 'Service A',
          position: { x: 200, y: -60 },
          config: {
            instances: 1,
            latency: { distribution: 'lognormal', p50: 15, p95: 45 },
            errorRate: 0.05,
            operations: {},
          },
        },
        {
          id: 'nodeB',
          serviceId: 'generic.service',
          label: 'Disconnected B',
          position: { x: 200, y: 60 },
          config: {
            instances: 1,
            latency: { distribution: 'lognormal', p50: bLatencyP50, p95: bLatencyP50 * 4 },
            errorRate: 0.5,
            operations: {},
          },
        },
      ];
      d.edges = [
        { id: 'e1', from: 'client', to: 'nodeA', protocol: 'https', callType: 'sync', weight: 1 },
      ];
      d.scenarios = [
        {
          id: 's1',
          name: 'Iso check',
          durationS: 8,
          entryNodeId: 'client',
          profile: { kind: 'constant', rps: 80 },
          flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
          chaos: [],
        },
      ];
      return d;
    };

    const r1 = await runSimulation({ design: build(5), scenarioId: 's1' }, () => {});
    const r2 = await runSimulation({ design: build(500), scenarioId: 's1' }, () => {});
    expect(r1.perNode.nodeA).toEqual(r2.perNode.nodeA);
    expect(r1.traces).toEqual(r2.traces);
  });

  it("satisfies Little's Law (L ≈ λ × W within 5%) on a stable non-saturated 40s run", async () => {
    const d = createEmptyDesign('littles-law', 'Littles Law');
    d.settings.seed = 4242;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'app',
        serviceId: 'generic.service',
        label: 'Worker',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          vcpu: 4,
          cluster: true,
          cpuMsPerRequest: 0,
          maxInFlightPerInstance: 25,
          latency: { distribution: 'lognormal', p50: 40, p95: 80 },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'app', protocol: 'https', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'Stable load',
        durationS: 40,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 150 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    let sumBucketUtil = 0;
    for (const b of res.series.buckets) {
      sumBucketUtil += b.perNode.app!.utilization;
    }

    // With cpuMsPerRequest=0 and non-saturated pool, utilization equals slot occupancy / 25
    const avgInFlightObserved = (sumBucketUtil / res.series.buckets.length) * 25;
    const lambdaPerSec = res.perNode.app!.success / 40;
    // Exact lognormal mean E[W] for p50=40, p95=80: exp(mu + sigma^2/2)
    const sigma = (Math.log(80) - Math.log(40)) / 1.6448536269514722;
    const meanServiceMs = 40 * Math.exp((sigma * sigma) / 2);
    const littlesPredictedL = lambdaPerSec * (meanServiceMs / 1000);

    const relDiff =
      Math.abs(avgInFlightObserved - littlesPredictedL) / Math.max(1e-6, littlesPredictedL);
    expect(relDiff).toBeLessThan(0.05);
  });
});
