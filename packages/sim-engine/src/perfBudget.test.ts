import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { runSimulation } from './engine.js';

function buildStandardThreeTier(rps: number, durationS: number): Design {
  const d = createEmptyDesign('perf-3tier', 'Perf benchmark 3-tier');
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
      position: { x: 240, y: 0 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 8 },
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      position: { x: 480, y: 0 },
      config: {
        instances: Math.max(10, Math.ceil(rps / 120)),
        vcpu: 2,
        memoryGb: 4,
        cluster: false,
        runtimePreset: 'node',
        cpuMsPerRequest: 6,
        maxInFlightPerInstance: 32,
        queue: { maxLength: 100, policy: 'reject' },
        timeoutMs: 3000,
        latency: { distribution: 'lognormal', p50: 10, p95: 35 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Postgres',
      position: { x: 720, y: 0 },
      config: {
        instances: 1,
        connections: { max: 200 },
        readRatio: 0.8,
        latency: { distribution: 'lognormal', p50: 5, p95: 18 },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e1',
      from: 'client',
      to: 'alb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    { id: 'e2', from: 'alb', to: 'api', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'e3', from: 'api', to: 'db', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
  ];
  d.scenarios = [
    {
      id: 's-perf',
      name: 'Perf',
      durationS,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps },
      flows: [
        {
          id: 'flow-main',
          name: 'GET /items',
          weight: 1,
          steps: [{ method: 'GET', path: '/items' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

describe('File 03 performance budgets (T7.1)', () => {
  it('completes 1,000 RPS x 60 s in under 2,000 ms', async () => {
    const design = buildStandardThreeTier(1_000, 60);
    const t0 = performance.now();
    const res = await runSimulation({ design, scenarioId: 's-perf' }, () => {});
    const elapsedMs = performance.now() - t0;

    expect(res.summary.totalRequests).toBeGreaterThanOrEqual(55_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('completes 10,000 RPS x 60 s using scaled mode in under 8,000 ms and well under 300 MB heap growth', async () => {
    const design = buildStandardThreeTier(10_000, 60);
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const res = await runSimulation({ design, scenarioId: 's-perf' }, () => {});
    const elapsedMs = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMb = (heapAfter - heapBefore) / (1024 * 1024);

    expect(res.scaled).toBeDefined();
    expect(res.summary.totalRequests).toBeGreaterThanOrEqual(550_000);
    expect(elapsedMs).toBeLessThan(8_000);
    expect(heapGrowthMb).toBeLessThan(300);
  });

  it('handles a 200-node / 399-edge topology cleanly within simulation budget', async () => {
    const d = createEmptyDesign('perf-200-nodes', 'Large 200-node mesh');
    d.nodes.push({
      id: 'n-0',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    });
    for (let i = 1; i < 200; i++) {
      d.nodes.push({
        id: `n-${i}`,
        serviceId: i % 5 === 0 ? 'aws.rds_postgres' : 'aws.ec2',
        label: `Svc ${i}`,
        position: { x: (i % 10) * 240, y: Math.floor(i / 10) * 140 },
        config: {
          instances: 2,
          latency: { distribution: 'lognormal', p50: 4, p95: 12 },
          operations: {},
        },
      });
    }
    // Wire breadth-first tree + bounded secondary fanout (398 edges, acyclic so no infinite loops)
    let edgeSeq = 0;
    for (let i = 1; i < 200; i++) {
      const parent = Math.floor((i - 1) / 3);
      d.edges.push({
        id: `e-${++edgeSeq}`,
        from: `n-${parent}`,
        to: `n-${i}`,
        protocol: 'http',
        port: 8080,
        callType: 'sync',
        weight: 1,
      });
      if (i + 1 < 200 && i > 3) {
        d.edges.push({
          id: `e-${++edgeSeq}`,
          from: `n-${parent}`,
          to: `n-${i + 1}`,
          protocol: 'http',
          port: 8080,
          callType: 'async',
          weight: 0.2,
        });
      }
    }
    d.scenarios = [
      {
        id: 's-large',
        name: 'Mesh baseline',
        durationS: 10,
        entryNodeId: 'n-0',
        profile: { kind: 'constant', rps: 100 },
        flows: [
          {
            id: 'flow-mesh',
            name: 'Root call',
            weight: 1,
            steps: [{ method: 'GET', path: '/mesh' }],
          },
        ],
        chaos: [],
      },
    ];

    const t0 = performance.now();
    const res = await runSimulation({ design: d, scenarioId: 's-large' }, () => {});
    const elapsedMs = performance.now() - t0;

    expect(Object.keys(res.perNode).length).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(8_000);
  });
});
