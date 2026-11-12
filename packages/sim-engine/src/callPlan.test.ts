import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type CallPlan, type Design, type LogEntry } from '@infrasim/shared-types';
import { runSimulation, type LiveCodeExecutionOutput } from './index.js';

function makeHandlerDesign(opts?: {
  rps?: number;
  durationS?: number;
  throwRate?: number;
  cpuOverrideMs?: number;
  verboseScript?: boolean;
}): Design {
  return {
    id: 'des-callplan',
    schemaVersion: SCHEMA_VERSION,
    name: 'CallPlan Test Design',
    groups: [],
    network: {},
    nodes: [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'aws.lambda',
        label: 'API Lambda',
        position: { x: 200, y: 0 },
        config: {
          scriptId: 'handler-1',
          instances: 1,
          operations: {},
          maxInFlightPerInstance: 200,
          vcpu: 200,
          coldStart: { enabled: false, probabilityModel: 'fixed', p50: 0, p95: 0, idleTtlS: 60 },
          ...(opts?.cpuOverrideMs !== undefined ? { cpuMsPerRequest: opts.cpuOverrideMs } : {}),
        },
      },
      {
        id: 'db',
        serviceId: 'aws.dynamodb',
        label: 'DynamoDB',
        position: { x: 450, y: 0 },
        config: {
          instances: 1,
          operations: {},
          latency: { distribution: 'fixed', p50: 50, p95: 50 },
          errorRate: 0,
        },
      },
      {
        id: 's3',
        serviceId: 'aws.s3',
        label: 'S3 Bucket',
        position: { x: 450, y: 120 },
        config: {
          instances: 1,
          operations: {},
          latency: { distribution: 'fixed', p50: 50, p95: 50 },
          errorRate: 0,
        },
      },
    ],
    edges: [
      {
        id: 'e-c-a',
        from: 'client',
        to: 'api',
        protocol: 'https',
        callType: 'sync',
        weight: 1,
        networkLatency: { distribution: 'fixed', p50: 1, p95: 1 },
      },
      {
        id: 'e-a-db',
        from: 'api',
        to: 'db',
        protocol: 'https',
        callType: 'sync',
        weight: 1,
        networkLatency: { distribution: 'fixed', p50: 1, p95: 1 },
      },
      {
        id: 'e-a-s3',
        from: 'api',
        to: 's3',
        protocol: 'https',
        callType: 'sync',
        weight: 1,
        networkLatency: { distribution: 'fixed', p50: 1, p95: 1 },
      },
    ],
    scenarios: [
      {
        id: 'sc-1',
        name: 'Constant',
        durationS: opts?.durationS ?? 20,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: opts?.rps ?? 20 },
        flows: [{ id: 'f1', name: 'default', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [],
      },
    ],
    scripts: [
      {
        id: 'handler-1',
        name: 'handler.ts',
        kind: 'handler',
        language: 'typescript',
        entry: 'handler',
        source: 'export async function handler() { return { statusCode: 200 }; }',
        memoryMb: 128,
        timeoutMs: 3000,
        env: {},
      },
    ],
    fixtures: [],
    settings: {
      seed: 42,
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}

describe('T3.9 sim-engine CallPlan execution, log replay/caps, and live code mode', () => {
  it('executes parallelGroup batches concurrently (~50 ms) vs sequential (~100 ms)', async () => {
    const design = makeHandlerDesign({ rps: 10, durationS: 10 });

    const seqPlan: CallPlan = {
      scriptId: 'handler-1',
      cpuMs: { distribution: 'fixed', p50: 1, p95: 1 },
      throwProbability: 0,
      steps: [
        { kind: 'call', serviceId: 'aws.dynamodb', op: 'GetItem', count: 1 },
        { kind: 'call', serviceId: 'aws.s3', op: 'GetObject', count: 1 },
      ],
    };

    const parPlan: CallPlan = {
      scriptId: 'handler-1',
      cpuMs: { distribution: 'fixed', p50: 1, p95: 1 },
      throwProbability: 0,
      steps: [
        {
          kind: 'call',
          serviceId: 'aws.dynamodb',
          op: 'GetItem',
          count: 1,
          parallelGroup: 'g-1',
        },
        {
          kind: 'call',
          serviceId: 'aws.s3',
          op: 'GetObject',
          count: 1,
          parallelGroup: 'g-1',
        },
      ],
    };

    const seqRes = await runSimulation(
      { design, scenarioId: 'sc-1', seed: 42, callPlans: { 'handler-1': seqPlan } },
      () => {},
    );
    const parRes = await runSimulation(
      { design, scenarioId: 'sc-1', seed: 42, callPlans: { 'handler-1': parPlan } },
      () => {},
    );

    expect(seqRes.summary.p50).toBeGreaterThan(95);
    expect(parRes.summary.p50).toBeLessThan(70);
    expect(parRes.perNode.db?.requests).toBeGreaterThan(50);
    expect(parRes.perNode.s3?.requests).toBeGreaterThan(50);
  });

  it('respects user cpuMsPerRequest override and simulates throwProbability failures', async () => {
    const design = makeHandlerDesign({ rps: 10, durationS: 10, cpuOverrideMs: 40 });
    const plan: CallPlan = {
      scriptId: 'handler-1',
      cpuMs: { distribution: 'fixed', p50: 1, p95: 1 },
      throwProbability: 0.25,
      steps: [],
    };
    const allLogs: LogEntry[] = [];
    const res = await runSimulation(
      { design, scenarioId: 'sc-1', seed: 11, callPlans: { 'handler-1': plan } },
      (f) => allLogs.push(...f.newLogs),
    );

    expect(res.perNode.api?.p50).toBeGreaterThanOrEqual(38);
    expect(res.summary.errors.user_code ?? 0).toBeGreaterThan(5);
    expect(allLogs.some((l) => l.source === 'user' && l.level === 'error')).toBe(true);
  });

  it('caps replayed user log requests <= 200, error logs <= 2000 with suppression notice, and filters debug logs', async () => {
    const design = makeHandlerDesign({ rps: 100, durationS: 30 });
    // Force massive error volume + replay logs across 3,000 requests
    design.nodes[2]!.config.errorRate = 1;
    const plan: CallPlan = {
      scriptId: 'handler-1',
      cpuMs: { distribution: 'fixed', p50: 1, p95: 1 },
      throwProbability: 0,
      steps: [{ kind: 'call', serviceId: 'aws.dynamodb', op: 'GetItem', count: 1 }],
    };

    const profilePool: LogEntry[][] = [
      [
        { id: 1, tVirtualMs: 1, level: 'info', source: 'user', message: 'info step' },
        { id: 2, tVirtualMs: 2, level: 'debug', source: 'user', message: 'debug step' },
      ],
    ];

    const quietLogs: LogEntry[] = [];
    await runSimulation(
      {
        design,
        scenarioId: 'sc-1',
        seed: 5,
        callPlans: { 'handler-1': plan },
        profileLogs: { 'handler-1': profilePool },
        options: { verboseLogs: false },
      },
      (f) => quietLogs.push(...f.newLogs),
    );

    const replayedInfo = quietLogs.filter((l) => l.replayedFromProfile);
    expect(replayedInfo.length).toBeGreaterThan(0);
    expect(replayedInfo.length).toBeLessThanOrEqual(200);
    expect(quietLogs.some((l) => l.level === 'debug')).toBe(false);

    const errorLogs = quietLogs.filter(
      (l) => (l.source === 'platform' || l.source === 'engine') && l.level === 'error',
    );
    expect(errorLogs.length).toBeLessThanOrEqual(2000);
    expect(quietLogs.some((l) => l.message.includes('more error logs suppressed'))).toBe(true);

    const verboseLogs: LogEntry[] = [];
    await runSimulation(
      {
        design,
        scenarioId: 'sc-1',
        seed: 5,
        callPlans: { 'handler-1': plan },
        profileLogs: { 'handler-1': profilePool },
        options: { verboseLogs: true },
      },
      (f) => verboseLogs.push(...f.newLogs),
    );
    expect(verboseLogs.some((l) => l.level === 'debug')).toBe(true);
  });

  it('rejects liveCode mode above 50 RPS and executes liveCodeExecutor monotonically <= 50 RPS', async () => {
    const overDesign = makeHandlerDesign({ rps: 60, durationS: 5 });
    await expect(
      runSimulation(
        {
          design: overDesign,
          scenarioId: 'sc-1',
          liveCodeExecutor: async () => ({
            ok: true,
            cpuMs: 1,
            virtualDurationMs: 1,
            logs: [],
            calls: [],
          }),
          options: { liveCode: true },
        },
        () => {},
      ),
    ).rejects.toThrow(/50 RPS/);

    const liveDesign = makeHandlerDesign({ rps: 10, durationS: 3 });
    const logs: LogEntry[] = [];
    let liveInvocations = 0;

    const res = await runSimulation(
      {
        design: liveDesign,
        scenarioId: 'sc-1',
        seed: 77,
        options: { liveCode: true, verboseLogs: true },
        liveCodeExecutor: async ({ requestId, seq }): Promise<LiveCodeExecutionOutput> => {
          liveInvocations += 1;
          return {
            ok: seq !== 2,
            cpuMs: 5,
            virtualDurationMs: 52,
            ...(seq === 2 ? { errorKind: 'user_code', errorMessage: 'boom' } : {}),
            logs: [
              {
                id: 1,
                tVirtualMs: 1,
                level: seq === 2 ? 'error' : 'info',
                source: 'user',
                message: `live req ${requestId}`,
              },
            ],
            calls: [
              {
                serviceId: 'aws.dynamodb',
                op: 'GetItem',
                targetNodeId: 'db',
                latencyMs: 50,
                payloadBytes: 128,
                responseBytes: 256,
              },
            ],
          };
        },
      },
      (f) => logs.push(...f.newLogs),
    );

    expect(liveInvocations).toBeGreaterThan(10);
    expect(res.perNode.db?.requests).toBeGreaterThan(10);
    expect(res.summary.errors.user_code ?? 0).toBe(1);
    const userLogs = logs.filter((l) => l.source === 'user');
    expect(userLogs.length).toBe(liveInvocations);

    for (let i = 1; i < logs.length; i++) {
      expect(logs[i]!.tVirtualMs).toBeGreaterThanOrEqual(logs[i - 1]!.tVirtualMs);
    }
  });
});
