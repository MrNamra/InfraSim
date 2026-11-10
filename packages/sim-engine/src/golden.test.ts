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

describe('@infrasim/sim-engine T2.4 golden scenarios 3-7 (spec 05 §13)', () => {
  it('Golden Scenario 3: LB + 2 apps, kill one at t=30s -> remaining overloads, then recovers after chaos ends', async () => {
    const d = createEmptyDesign('golden-3', 'Golden 3 LB Failover');
    d.settings.seed = 42;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, timeoutMs: 10_000, operations: {} },
      },
      {
        id: 'alb',
        serviceId: 'aws.alb',
        label: 'ALB',
        position: { x: 180, y: 0 },
        config: {
          instances: 1,
          lb: {
            algorithm: 'round-robin',
            healthCheck: {
              intervalS: 2,
              unhealthyThreshold: 1,
              healthyThreshold: 2,
              timeoutMs: 1500,
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
        position: { x: 360, y: -60 },
        config: {
          instances: 1,
          vcpu: 1,
          cluster: false,
          cpuMsPerRequest: 10,
          maxInFlightPerInstance: 20,
          queue: { maxLength: 40, policy: 'reject' },
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
          operations: {},
        },
      },
      {
        id: 'app2',
        serviceId: 'generic.service',
        label: 'App 2',
        position: { x: 360, y: 60 },
        config: {
          instances: 1,
          vcpu: 1,
          cluster: false,
          cpuMsPerRequest: 10,
          maxInFlightPerInstance: 20,
          queue: { maxLength: 40, policy: 'reject' },
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
        name: 'Kill 1 app at t=30s',
        durationS: 90,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 140 },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [{ atS: 30, durationS: 25, kind: 'kill-instances', nodeId: 'app2', count: 1 }],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const preChaosApp1Drops = res.series.buckets
      .slice(5, 29)
      .reduce((sum, b) => sum + (b.perNode.app1?.drops ?? 0), 0);
    const duringChaosBuckets = res.series.buckets.slice(33, 54);
    const duringChaosApp1Drops = duringChaosBuckets.reduce(
      (sum, b) => sum + (b.perNode.app1?.drops ?? 0),
      0,
    );
    const duringChaosApp1PeakUtil = Math.max(
      ...duringChaosBuckets.map((b) => b.perNode.app1?.utilization ?? 0),
    );
    const duringChaosApp2Active = duringChaosBuckets.every(
      (b) => (b.perNode.app2?.instancesActive ?? 1) === 0,
    );
    const postRecoveryBuckets = res.series.buckets.slice(68, 90);
    const postRecoveryApp1Drops = postRecoveryBuckets.reduce(
      (sum, b) => sum + (b.perNode.app1?.drops ?? 0),
      0,
    );
    const postRecoveryApp2Reqs = postRecoveryBuckets.reduce(
      (sum, b) => sum + (b.perNode.app2?.rpsIn ?? 0),
      0,
    );

    expect(preChaosApp1Drops).toBe(0);
    expect(duringChaosApp2Active).toBe(true);
    expect(duringChaosApp1PeakUtil).toBeGreaterThanOrEqual(0.95);
    expect(duringChaosApp1Drops).toBeGreaterThan(200);
    expect(postRecoveryApp2Reqs).toBeGreaterThan(500);
    expect(postRecoveryApp1Drops).toBe(0);
  });

  it('Golden Scenario 4: Retry storm (DB slowdown + 3 retries, no backoff) multiplies traffic >= 3x', async () => {
    const d = createEmptyDesign('golden-4', 'Golden 4 Retry Storm');
    d.settings.seed = 42;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, timeoutMs: 10_000, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'generic.service',
        label: 'API',
        position: { x: 180, y: 0 },
        config: {
          instances: 4,
          vcpu: 4,
          cluster: true,
          cpuMsPerRequest: 1,
          maxInFlightPerInstance: 500,
          timeoutMs: 40,
          latency: { distribution: 'fixed', p50: 1, p95: 1 },
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
          connections: { max: 200 },
          connectionWaitMs: 500,
          maxInFlightPerInstance: 1000,
          queue: { maxLength: 1000, policy: 'reject' },
          readRatio: 1.0,
          latency: { distribution: 'fixed', p50: 5, p95: 5 },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
      {
        id: 'e2',
        from: 'api',
        to: 'db',
        protocol: 'sql',
        callType: 'sync',
        weight: 1,
        retry: { max: 3, backoffMs: 0, jitter: false },
      },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'Retry storm',
        durationS: 20,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 80 },
        flows: [{ id: 'f1', name: 'Read', weight: 1, steps: [{ method: 'GET', path: '/items' }] }],
        chaos: [{ atS: 5, durationS: 10, kind: 'add-latency', nodeId: 'db', extraMs: 250 }],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const baselineDbArrivals =
      res.series.buckets.slice(1, 4).reduce((s, b) => s + (b.perNode.db?.rpsIn ?? 0), 0) / 3;
    const stormDbArrivals =
      res.series.buckets.slice(7, 13).reduce((s, b) => s + (b.perNode.db?.rpsIn ?? 0), 0) / 6;

    expect(baselineDbArrivals).toBeGreaterThan(60);
    expect(stormDbArrivals).toBeGreaterThanOrEqual(baselineDbArrivals * 3);
  });

  it('Golden Scenario 5: Lambda-like (conc 100, 200 ms) has ~0 throttling below capacity and throttles above 500 RPS', async () => {
    const buildLambdaDesign = (rps: number, onLimit: 'throttle' | 'queue') => {
      const d = createEmptyDesign(`golden-5-${rps}-${onLimit}`, 'Golden 5 Serverless');
      d.settings.seed = 42;
      d.nodes = [
        {
          id: 'client',
          serviceId: 'generic.client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { instances: 1, timeoutMs: 10_000, operations: {} },
        },
        {
          id: 'fn',
          serviceId: 'aws.lambda',
          label: 'Lambda',
          position: { x: 200, y: 0 },
          config: {
            instances: 1,
            memoryGb: 0.5,
            cpuMsPerRequest: 2,
            timeoutMs: 10_000,
            coldStart: {
              enabled: false,
              probabilityModel: 'idle-based',
              p50: 0,
              p95: 0,
              idleTtlS: 600,
              concurrencyLimit: 100,
              onLimit,
            },
            latency: { distribution: 'fixed', p50: 200, p95: 200 },
            operations: {},
          },
        },
      ];
      d.edges = [
        { id: 'e1', from: 'client', to: 'fn', protocol: 'https', callType: 'sync', weight: 1 },
      ];
      d.scenarios = [
        {
          id: 's1',
          name: `${rps} RPS`,
          durationS: 10,
          entryNodeId: 'client',
          profile: { kind: 'constant', rps },
          flows: [{ id: 'f1', name: 'Invoke', weight: 1, steps: [{ method: 'POST', path: '/' }] }],
          chaos: [],
        },
      ];
      return d;
    };

    const underCap = await runSimulation(
      { design: buildLambdaDesign(300, 'throttle'), scenarioId: 's1' },
      () => {},
    );
    expect(underCap.perNode.fn!.errors.throttled ?? 0).toBe(0);

    const safeLoad = await runSimulation(
      { design: buildLambdaDesign(400, 'throttle'), scenarioId: 's1' },
      () => {},
    );
    const safeThrottleRate =
      (safeLoad.perNode.fn!.errors.throttled ?? 0) / Math.max(1, safeLoad.perNode.fn!.requests);
    expect(safeThrottleRate).toBeLessThan(0.01);
    expect(safeLoad.perNode.fn!.success).toBeGreaterThan(3800);
    expect(safeLoad.counters.perNode.fn!.gbSeconds ?? 0).toBeGreaterThan(300);

    const overLimit = await runSimulation(
      { design: buildLambdaDesign(700, 'throttle'), scenarioId: 's1' },
      () => {},
    );
    const overThrottleRate =
      (overLimit.perNode.fn!.errors.throttled ?? 0) / Math.max(1, overLimit.perNode.fn!.requests);
    expect(overThrottleRate).toBeGreaterThan(0.15);
    expect(overLimit.perNode.fn!.errors.throttled ?? 0).toBeGreaterThan(1000);
    expect(overLimit.perNode.fn!.drops).toBe(0);

    const queuedMode = await runSimulation(
      { design: buildLambdaDesign(600, 'queue'), scenarioId: 's1' },
      () => {},
    );
    expect(queuedMode.perNode.fn!.errors.throttled ?? 0).toBe(0);
    expect(queuedMode.perNode.fn!.peakQueueDepth).toBeGreaterThan(20);
  });

  it('Golden Scenario 6: Autoscaling with 60s warmup under spike shows overload window ~ warmup then recovers', async () => {
    const d = createEmptyDesign('golden-6', 'Golden 6 Autoscale Warmup');
    d.settings.seed = 42;
    d.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, timeoutMs: 10_000, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'aws.ec2',
        label: 'API ASG',
        position: { x: 200, y: 0 },
        config: {
          instances: 1,
          vcpu: 1,
          cluster: false,
          runtimePreset: 'node',
          cpuMsPerRequest: 10,
          maxInFlightPerInstance: 30,
          queue: { maxLength: 30, policy: 'reject' },
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
          autoscaling: {
            min: 1,
            max: 6,
            metric: 'cpu',
            target: 0.5,
            scaleOutCooldownS: 30,
            scaleInCooldownS: 60,
            warmupS: 60,
            checkIntervalS: 5,
          },
          operations: {},
        },
      },
    ];
    d.edges = [
      { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'Spike 40 -> 160 RPS',
        durationS: 110,
        entryNodeId: 'client',
        profile: {
          kind: 'steps',
          steps: [
            { atS: 0, rps: 40 },
            { atS: 10, rps: 160 },
          ],
        },
        flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const overloadedSeconds = res.series.buckets.filter(
      (b) => (b.perNode.api?.utilization ?? 0) >= 0.9 || (b.perNode.api?.drops ?? 0) > 0,
    );

    // Spike starts at t=10s, scale check triggers at t=15s with 60s warmup -> active at t=75s
    expect(overloadedSeconds.length).toBeGreaterThanOrEqual(50);
    expect(overloadedSeconds.length).toBeLessThanOrEqual(72);

    const postWarmupBuckets = res.series.buckets.slice(80, 110);
    const postDrops = postWarmupBuckets.reduce((s, b) => s + (b.perNode.api?.drops ?? 0), 0);
    const postActive = postWarmupBuckets[0]!.perNode.api!.instancesActive;
    expect(postActive).toBeGreaterThanOrEqual(2);
    expect(postDrops).toBe(0);
  });

  it('Golden Scenario 7: Queue producer 100 msg/s and consumer drain 60 msg/s grows backlog ~40 msg/s', async () => {
    const d = createEmptyDesign('golden-7', 'Golden 7 Queue Slope');
    d.settings.seed = 42;
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
        label: 'SQS Queue',
        position: { x: 180, y: 0 },
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
        position: { x: 360, y: 0 },
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 100, p95: 100 },
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
        name: 'Steady 100 vs 60',
        durationS: 15,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 100 },
        flows: [{ id: 'f1', name: 'Push', weight: 1, steps: [{ method: 'POST', path: '/job' }] }],
        chaos: [],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});
    const depthAt5s = res.series.buckets[4]!.perNode.q!.queueDepth;
    const depthAt10s = res.series.buckets[9]!.perNode.q!.queueDepth;
    const depthAt15s = res.series.buckets[14]!.perNode.q!.queueDepth;

    expect(depthAt5s).toBeGreaterThan(120);
    expect(depthAt5s).toBeLessThan(280);
    expect(depthAt10s).toBeGreaterThan(280);
    expect(depthAt10s).toBeLessThan(520);
    expect(depthAt15s).toBeGreaterThan(450);
    expect(depthAt15s).toBeLessThan(750);
    const slopePerSec = (depthAt15s - depthAt5s) / 10;
    expect(slopePerSec).toBeGreaterThan(25);
    expect(slopePerSec).toBeLessThan(55);
  });
});
