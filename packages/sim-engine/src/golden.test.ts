import { describe, expect, it } from 'vitest';
import { createEmptyDesign } from '@infrasim/shared-types';
import { runSimulation } from './index.js';

describe('@infrasim/sim-engine T1.8 golden scenarios 1-2 and performance budget', () => {
  it('Golden Scenario 1: 1 client -> 1 app (1 vCPU, 10 ms CPU) at 50 / 90 / 120 RPS', async () => {
    const buildSingleApp = (rps: number) => {
      const d = createEmptyDesign(`golden-1-${rps}`, 'Golden 1');
      d.settings.seed = 42;
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
          label: 'API',
          position: { x: 200, y: 0 },
          config: {
            instances: 1,
            vcpu: 1,
            cluster: false,
            cpuMsPerRequest: 10,
            maxInFlightPerInstance: 20,
            queue: { maxLength: 60, policy: 'reject' },
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
          name: `${rps} RPS`,
          durationS: 20,
          entryNodeId: 'client',
          profile: { kind: 'constant', rps },
          flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
          chaos: [],
        },
      ];
      return d;
    };

    const at50 = await runSimulation({ design: buildSingleApp(50), scenarioId: 's1' }, () => {});
    expect(at50.perNode.app!.avgCpuUtilization ?? 0).toBeCloseTo(0.5, 1);
    expect(at50.perNode.app!.drops).toBe(0);

    const at90 = await runSimulation({ design: buildSingleApp(90), scenarioId: 's1' }, () => {});
    expect(at90.perNode.app!.avgCpuUtilization ?? 0).toBeGreaterThan(0.8);
    expect(at90.perNode.app!.avgCpuUtilization ?? 0).toBeLessThan(0.98);

    const at120 = await runSimulation({ design: buildSingleApp(120), scenarioId: 's1' }, () => {});
    expect(at120.perNode.app!.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(at120.perNode.app!.drops).toBeGreaterThan(50);
    expect(at120.bottleneckNodeId).toBe('app');
  });

  it('Golden Scenario 2: App -> DB (pool 10, query 50 ms) saturates above ~200 QPS with timeouts', async () => {
    const buildAppDb = (rps: number) => {
      const d = createEmptyDesign(`golden-2-${rps}`, 'Golden 2');
      d.settings.seed = 101;
      d.nodes = [
        {
          id: 'client',
          serviceId: 'generic.client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { instances: 1, timeoutMs: 10_000, operations: {} },
        },
        {
          id: 'app',
          serviceId: 'generic.service',
          label: 'API',
          position: { x: 180, y: 0 },
          config: {
            instances: 4,
            vcpu: 4,
            cluster: true,
            cpuMsPerRequest: 1,
            maxInFlightPerInstance: 500,
            timeoutMs: 10_000,
            latency: { distribution: 'fixed', p50: 1, p95: 1 },
            operations: {},
          },
        },
        {
          id: 'db',
          serviceId: 'generic.db',
          label: 'Postgres',
          position: { x: 360, y: 0 },
          config: {
            instances: 1,
            connections: { max: 10 },
            connectionWaitMs: 300,
            maxInFlightPerInstance: 500,
            queue: { maxLength: 500, policy: 'reject' },
            readRatio: 1.0,
            latency: { distribution: 'fixed', p50: 50, p95: 50 },
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
          name: `${rps} RPS`,
          durationS: 15,
          entryNodeId: 'client',
          profile: { kind: 'constant', rps },
          flows: [
            { id: 'f1', name: 'Read', weight: 1, steps: [{ method: 'GET', path: '/items' }] },
          ],
          chaos: [],
        },
      ];
      return d;
    };

    const below = await runSimulation({ design: buildAppDb(140), scenarioId: 's1' }, () => {});
    expect(below.perNode.db!.avgUtilization).toBeCloseTo(0.7, 1);
    expect(below.perNode.db!.errors.timeout ?? 0).toBeLessThan(15);

    const above = await runSimulation({ design: buildAppDb(280), scenarioId: 's1' }, () => {});
    expect(above.perNode.db!.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(above.perNode.db!.errors.timeout ?? 0).toBeGreaterThan(200);
    expect(above.bottleneckNodeId).toBe('db');
  });

  it('meets performance budget: 3-tier web app at 1,000 RPS x 60s completes in under 2,000 ms wall time', async () => {
    const d = createEmptyDesign('perf-1k', '3-Tier Perf');
    d.settings.seed = 42;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'lb',
        serviceId: 'aws.alb',
        label: 'ALB',
        position: { x: 160, y: 0 },
        config: {
          instances: 1,
          latency: { distribution: 'lognormal', p50: 2, p95: 5 },
          operations: {},
        },
      },
      {
        id: 'api',
        serviceId: 'generic.service',
        label: 'API Tier',
        position: { x: 320, y: 0 },
        config: {
          instances: 4,
          vcpu: 4,
          cluster: true,
          cpuMsPerRequest: 2,
          latency: { distribution: 'lognormal', p50: 8, p95: 25 },
          operations: {},
        },
      },
      {
        id: 'db',
        serviceId: 'generic.db',
        label: 'Postgres',
        position: { x: 480, y: 0 },
        config: {
          instances: 1,
          connections: { max: 100 },
          latency: { distribution: 'lognormal', p50: 6, p95: 20 },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'lb', protocol: 'https', callType: 'sync', weight: 1 },
      { id: 'e2', from: 'lb', to: 'api', protocol: 'http', callType: 'sync', weight: 1 },
      { id: 'e3', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: '1k RPS x 60s',
        durationS: 60,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 1000 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const t0 = performance.now();
    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const elapsedMs = performance.now() - t0;

    expect(res.summary.totalRequests).toBeGreaterThan(58_000);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
