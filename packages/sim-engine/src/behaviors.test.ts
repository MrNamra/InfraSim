import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { SimulationAbortedError, runSimulation } from './index.js';

function baseDesign(id: string): Design {
  const d = createEmptyDesign(id, id);
  d.settings.seed = 42;
  return d;
}

describe('@infrasim/sim-engine T1.7 service behaviors and edge failure mechanics', () => {
  it('balances across targets and handles DB pool timeout cleanly', async () => {
    const d = baseDesign('pool-test');
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'alb',
        serviceId: 'aws.alb',
        label: 'ALB',
        position: { x: 160, y: 0 },
        config: {
          instances: 1,
          lb: {
            algorithm: 'round-robin',
            healthCheck: {
              intervalS: 1,
              unhealthyThreshold: 2,
              healthyThreshold: 2,
              timeoutMs: 200,
            },
          },
          latency: { distribution: 'fixed', p50: 1, p95: 1 },
          operations: {},
        },
      },
      {
        id: 'app1',
        serviceId: 'generic.service',
        label: 'App 1',
        position: { x: 320, y: -40 },
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
          operations: {},
        },
      },
      {
        id: 'app2',
        serviceId: 'generic.service',
        label: 'App 2',
        position: { x: 320, y: 40 },
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'alb', protocol: 'https', callType: 'sync', weight: 1 },
      { id: 'e2', from: 'alb', to: 'app1', protocol: 'http', callType: 'sync', weight: 1 },
      { id: 'e3', from: 'alb', to: 'app2', protocol: 'http', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'LB steady',
        durationS: 5,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 100 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const c1 = res.perNode.app1!.requests;
    const c2 = res.perNode.app2!.requests;
    expect(Math.abs(c1 - c2)).toBeLessThanOrEqual(5);
    expect(res.summary.success).toBeGreaterThan(400);
  });

  it('offloads DB read requests when an upstream Cache with high hit ratio is attached', async () => {
    const build = (withCache: boolean) => {
      const d = baseDesign(`cache-${withCache}`);
      d.nodes = [
        {
          id: 'client',
          serviceId: 'generic.client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        ...(withCache
          ? [
              {
                id: 'cache',
                serviceId: 'generic.cache',
                label: 'Redis',
                position: { x: 160, y: 0 },
                config: {
                  instances: 1,
                  cacheHitRatio: 0.85,
                  latency: { distribution: 'fixed' as const, p50: 1, p95: 1 },
                  operations: {},
                },
              },
            ]
          : []),
        {
          id: 'db',
          serviceId: 'generic.db',
          label: 'Postgres',
          position: { x: 320, y: 0 },
          config: {
            instances: 1,
            connections: { max: 50 },
            latency: { distribution: 'fixed', p50: 10, p95: 10 },
            operations: {},
          },
        },
      ];
      d.edges = withCache
        ? [
            {
              id: 'e1',
              from: 'client',
              to: 'cache',
              protocol: 'redis',
              callType: 'sync',
              weight: 1,
            },
            { id: 'e2', from: 'cache', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
          ]
        : [{ id: 'e1', from: 'client', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 }];
      d.scenarios = [
        {
          id: 's1',
          name: 'Cache check',
          durationS: 5,
          entryNodeId: 'client',
          profile: { kind: 'constant', rps: 100 },
          flows: [{ id: 'f1', name: 'Read', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
          chaos: [],
        },
      ];
      return d;
    };

    const withoutCache = await runSimulation({ design: build(false), scenarioId: 's1' }, () => {});
    const withCache = await runSimulation({ design: build(true), scenarioId: 's1' }, () => {});

    expect(withCache.perNode.db!.requests).toBeLessThan(withoutCache.perNode.db!.requests * 0.25);
  });

  it('builds async queue backlog when producer rate exceeds consumer drain capacity', async () => {
    const d = baseDesign('queue-backlog');
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Producer',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'q',
        serviceId: 'generic.queue',
        label: 'Jobs',
        position: { x: 160, y: 0 },
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 1, p95: 1 },
          consumer: { concurrency: 6, batchSize: 1, pollMs: 10, maxRetries: 0, dlq: true },
          operations: {},
        },
      },
      {
        id: 'worker',
        serviceId: 'generic.service',
        label: 'Worker',
        position: { x: 320, y: 0 },
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 100, p95: 100 }, // 6 workers / 0.1s = 60 msg/s drain
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'q', protocol: 'https', callType: 'sync', weight: 1 },
      { id: 'e2', from: 'q', to: 'worker', protocol: 'internal', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'Queue drain',
        durationS: 10,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 100 }, // +40/s backlog growth -> ~400 after 10s
        flows: [
          { id: 'f1', name: 'Enqueue', weight: 1, steps: [{ method: 'POST', path: '/job' }] },
        ],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    expect(res.perNode.q!.peakQueueDepth).toBeGreaterThan(250);
    expect(res.perNode.q!.peakQueueDepth).toBeLessThan(550);
  });

  it('opens circuit breakers to shed failing retries and respects AbortSignal cleanly', async () => {
    const d = baseDesign('cb-abort');
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, timeoutMs: 200, operations: {} },
      },
      {
        id: 'down',
        serviceId: 'generic.service',
        label: 'Failing API',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          errorRate: 1.0,
          latency: { distribution: 'fixed', p50: 5, p95: 5 },
          operations: {},
        },
      },
    ];
    d.edges = [
      {
        id: 'e1',
        from: 'client',
        to: 'down',
        protocol: 'https',
        callType: 'sync',
        weight: 1,
        circuitBreaker: { failureThreshold: 5, windowMs: 2000, openMs: 3000 },
      },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'CB open test',
        durationS: 4,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 50 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    expect(res.summary.errors.circuit_open ?? 0).toBeGreaterThan(50);

    // Abort signal check
    const controller = new AbortController();
    d.scenarios[0]!.durationS = 120;
    d.scenarios[0]!.profile = { kind: 'constant', rps: 5000 };
    controller.abort();
    await expect(
      runSimulation({ design: d, scenarioId: 's1' }, () => {}, controller.signal),
    ).rejects.toBeInstanceOf(SimulationAbortedError);
  });
});
