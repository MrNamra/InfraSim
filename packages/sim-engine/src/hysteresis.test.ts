import { describe, expect, it } from 'vitest';
import { createEmptyDesign } from '@infrasim/shared-types';
import {
  LogHistogram,
  computeErlangC,
  createNodeHealthTracker,
  evaluateNodeHealthStep,
  runSimulation,
} from './index.js';

describe('@infrasim/sim-engine T1.8 histograms, hysteresis and Erlang C', () => {
  it('maintains bounded logarithmic histogram error and monotonic percentiles', () => {
    const h = new LogHistogram();
    expect(h.percentiles()).toEqual({ p50: 0, p95: 0, p99: 0 });

    for (let i = 1; i <= 1000; i++) {
      h.record(i);
    }

    const pct = h.percentiles();
    expect(pct.p50).toBeGreaterThan(485);
    expect(pct.p50).toBeLessThan(515);
    expect(pct.p95).toBeGreaterThan(925);
    expect(pct.p95).toBeLessThan(975);
    expect(pct.p99).toBeGreaterThan(965);
    expect(pct.p99).toBeLessThan(1020);
    expect(pct.p50).toBeLessThanOrEqual(pct.p95);
    expect(pct.p95).toBeLessThanOrEqual(pct.p99);

    const h2 = new LogHistogram();
    h2.record(2000, 100);
    h.merge(h2);
    expect(h.totalCount).toBe(1100);
    expect(h.quantile(0.99)).toBeGreaterThan(1900);
  });

  it('enforces EMA α=0.5 smoothing and overload enter/leave hysteresis cleanly', () => {
    const t = createNodeHealthTracker();

    // 1st high bucket -> only hot until 2 consecutive qualifying buckets
    const s1 = evaluateNodeHealthStep(t, {
      rawUtil: 0.96,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 100,
      endQueueDepth: 0,
    });
    expect(s1.health).toBe('hot');

    // 2nd consecutive high bucket -> enters overloaded
    const s2 = evaluateNodeHealthStep(t, {
      rawUtil: 0.98,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 100,
      endQueueDepth: 0,
    });
    expect(s2.health).toBe('overloaded');

    // Low buckets: EMA cools down, requires 3 consecutive clean buckets < 0.90 to leave overloaded
    evaluateNodeHealthStep(t, {
      rawUtil: 0.2,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 50,
      endQueueDepth: 0,
    });
    // smoothed = 0.5*0.2 + 0.5*0.97 = 0.585 (< 0.90): recoveryStreak = 1
    expect(t.state).toBe('overloaded');

    evaluateNodeHealthStep(t, {
      rawUtil: 0.2,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 50,
      endQueueDepth: 0,
    });
    // recoveryStreak = 2 -> still overloaded!
    expect(t.state).toBe('overloaded');

    const s5 = evaluateNodeHealthStep(t, {
      rawUtil: 0.2,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 50,
      endQueueDepth: 0,
    });
    // recoveryStreak = 3 -> leaves overloaded -> 'ok'
    expect(s5.health).toBe('ok');

    // Queue growth >= 5 consecutive buckets triggers overload after 2 qualifying buckets (6 total)
    const qt = createNodeHealthTracker();
    for (let i = 1; i <= 5; i++) {
      evaluateNodeHealthStep(qt, {
        rawUtil: 0.5,
        instancesActive: 1,
        dropsCount: 0,
        throttledCount: 0,
        arrivalsCount: 10,
        endQueueDepth: i * 10,
      });
    }
    const q6 = evaluateNodeHealthStep(qt, {
      rawUtil: 0.5,
      instancesActive: 1,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 10,
      endQueueDepth: 60,
    });
    expect(q6.health).toBe('overloaded');

    // Zero active instances immediately becomes 'down'
    const down = evaluateNodeHealthStep(qt, {
      rawUtil: 0,
      instancesActive: 0,
      dropsCount: 0,
      throttledCount: 0,
      arrivalsCount: 0,
      endQueueDepth: 0,
    });
    expect(down.health).toBe('down');
  });

  it('matches Erlang C theoretical latency/utilization and avoids overflow at large c', async () => {
    // Large server pool sanity check (no NaN/Infinity for c=500)
    const huge = computeErlangC(500, 15000, 20); // rho = 300/500 = 0.6
    expect(huge.utilizationRho).toBeCloseTo(0.6, 5);
    expect(Number.isFinite(huge.blockingProb)).toBe(true);
    expect(Number.isFinite(huge.expectedTotalMs)).toBe(true);
    expect(huge.expectedTotalMs).toBeGreaterThanOrEqual(20);

    // Compare simulated M/D/c vs analytical Erlang C utilization at steady load
    const d = createEmptyDesign('erlang-check', 'Erlang Check');
    d.settings.seed = 99;
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
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          vcpu: 1,
          cluster: false,
          cpuMsPerRequest: 10,
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
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
        name: '70 RPS steady',
        durationS: 30,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 70 },
        flows: [{ id: 'f1', name: 'Req', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const theory = computeErlangC(1, 70, 10);
    expect(res.perNode.app!.avgCpuUtilization ?? 0).toBeCloseTo(theory.utilizationRho, 1);
  });
});
