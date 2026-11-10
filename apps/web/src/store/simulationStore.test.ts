import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyDesign,
  type Design,
  type SimFrame,
  type SimulationResult,
} from '@infrasim/shared-types';
import { runSimulationBatchWithDiagnosis } from '../lib/simWorkerCore';
import { formatVirtualTime } from '../lib/timeFormat';
import {
  hasLoadGeneratorNode,
  pickLandingFrameIndex,
  setSimRunnerForTests,
  useSimulationStore,
} from './simulationStore';

function makeMinimal3TierDesign(peakRps = 180): Design {
  const d = createEmptyDesign('test-3t', 'Test 3-Tier');
  d.settings.seed = 42;
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 40, y: 140 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'generic.service',
      label: 'API',
      position: { x: 320, y: 140 },
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
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];
  d.scenarios = [
    {
      id: 's1',
      name: 'Spike',
      durationS: 8,
      entryNodeId: 'client',
      profile: { kind: 'spike', baseRps: 20, peakRps, atS: 2, widthS: 6 },
      flows: [{ id: 'f1', name: 'Get', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
      chaos: [],
    },
  ];
  return d;
}

describe('T1.9 simulation worker core & Zustand simulationStore', () => {
  beforeEach(() => {
    useSimulationStore.getState().resetSimulation(true);
    useSimulationStore.setState({ speed: 'max' });
  });

  afterEach(() => {
    setSimRunnerForTests(null);
  });

  it('batches frames within <= 10/s throttle window and attaches Why? insights', async () => {
    const d = makeMinimal3TierDesign(180);
    const batches: SimFrame[][] = [];
    const result = await runSimulationBatchWithDiagnosis(
      { design: d, scenarioId: 's1', options: { frameIntervalMs: 100 } },
      (b) => batches.push(b),
      undefined,
      100,
    );

    const flatFrames = batches.flat();
    expect(flatFrames.length).toBeGreaterThanOrEqual(70);
    expect(batches.length).toBeLessThanOrEqual(flatFrames.length);
    expect(result.perNode.api!.drops).toBeGreaterThan(0);
    expect(result.insights.length).toBeGreaterThan(0);
    expect(result.insights.some((ins) => ins.nodeIds.includes('api'))).toBe(true);
  });

  it('stops cleanly via AbortController signal', async () => {
    const d = makeMinimal3TierDesign(200);
    const ac = new AbortController();
    ac.abort();

    await expect(
      runSimulationBatchWithDiagnosis({ design: d, scenarioId: 's1' }, () => {}, ac.signal),
    ).rejects.toThrow(/abort/i);
  });

  it('prompts when no Load Generator exists unless allowMissingClient is set', async () => {
    const d = createEmptyDesign('no-client', 'No Client');
    d.nodes = [
      {
        id: 'api',
        serviceId: 'generic.service',
        label: 'API',
        position: { x: 100, y: 100 },
        config: { instances: 1, operations: {} },
      },
    ];
    expect(hasLoadGeneratorNode(d)).toBe(false);

    const out = await useSimulationStore.getState().runSimulation(d, 'scenario-default');
    expect(out.started).toBe(false);
    expect(out.reason).toBe('no-client');
    expect(useSimulationStore.getState().missingClientPromptOpen).toBe(true);
  });

  it('streams batches, selects peak overload frame on completion, and supports scrubbing/playback', async () => {
    const frame0: SimFrame = {
      runId: 'r1',
      tVirtualMs: 0,
      nodes: {
        api: {
          utilization: 0.2,
          inFlight: 2,
          queueDepth: 0,
          rpsIn: 20,
          rpsOut: 20,
          errorsPerSec: {},
          dropsPerSec: 0,
          latency: { p50: 10, p95: 12, p99: 15 },
          instancesActive: 1,
          instancesTotal: 1,
          health: 'ok',
        },
      },
      edges: {},
      particles: [],
      newLogs: [],
    };
    const frame1: SimFrame = {
      ...frame0,
      tVirtualMs: 2500,
      nodes: {
        api: {
          ...frame0.nodes.api!,
          utilization: 1.0,
          dropsPerSec: 40,
          health: 'overloaded',
        },
      },
    };
    const frame2: SimFrame = { ...frame0, tVirtualMs: 5000 };

    const mockResult: SimulationResult = {
      runId: 'r1',
      seed: 42,
      durationS: 5,
      scaled: null,
      summary: {
        totalRequests: 250,
        success: 210,
        errors: { dropped_queue_full: 40 },
        p50: 12,
        p95: 80,
        p99: 110,
        throughputRps: 42,
      },
      perNode: {},
      series: { bucketSizeS: 1, buckets: [] },
      bottleneckNodeId: 'api',
      traces: [],
      counters: { perNode: {}, perEdge: {} },
      insights: [],
    };

    const runMock = vi.fn(async (_input, onBatch: (batch: SimFrame[]) => void) => {
      onBatch([frame0, frame1]);
      onBatch([frame2]);
      return mockResult;
    });
    setSimRunnerForTests({
      run: runMock,
      cancel: vi.fn(),
      terminate: vi.fn(),
    });

    const design = makeMinimal3TierDesign(180);
    await useSimulationStore.getState().runSimulation(design, 's1');

    const st = useSimulationStore.getState();
    expect(st.status).toBe('completed');
    expect(st.frames).toHaveLength(3);
    // Landing heuristic selects peak overload frame (index 1) because frame2 cooled back to ok
    expect(st.playbackIdx).toBe(1);

    st.seekToTimeS(4.9);
    expect(useSimulationStore.getState().playbackIdx).toBe(2);

    st.scrubTo(0);
    st.setSpeed('5');
    useSimulationStore.setState({ playing: true });
    useSimulationStore.getState().advancePlayback(600); // 600ms * 5 = 3000ms virtual -> index 1
    expect(useSimulationStore.getState().playbackIdx).toBe(1);
    expect(useSimulationStore.getState().playing).toBe(true);

    useSimulationStore.getState().advancePlayback(600); // -> 6000ms -> hits end frame2 and pauses
    expect(useSimulationStore.getState().playbackIdx).toBe(2);
    expect(useSimulationStore.getState().playing).toBe(false);
  });

  it('pickLandingFrameIndex picks last frame when healthy or ending overloaded', () => {
    const okFrame: SimFrame = {
      runId: 'r',
      tVirtualMs: 1000,
      nodes: {
        a: {
          utilization: 0.3,
          inFlight: 1,
          queueDepth: 0,
          rpsIn: 10,
          rpsOut: 10,
          errorsPerSec: {},
          dropsPerSec: 0,
          latency: { p50: 5, p95: 8, p99: 10 },
          instancesActive: 1,
          instancesTotal: 1,
          health: 'ok',
        },
      },
      edges: {},
      particles: [],
      newLogs: [],
    };
    const redFrame: SimFrame = {
      ...okFrame,
      tVirtualMs: 2000,
      nodes: { a: { ...okFrame.nodes.a!, utilization: 1.0, health: 'overloaded' } },
    };

    expect(pickLandingFrameIndex([okFrame, { ...okFrame, tVirtualMs: 2000 }])).toBe(1);
    expect(pickLandingFrameIndex([okFrame, redFrame])).toBe(1);
    expect(pickLandingFrameIndex([okFrame, redFrame, { ...okFrame, tVirtualMs: 3000 }])).toBe(1);
  });

  it('formats virtual time cleanly as MM:SS.d', () => {
    expect(formatVirtualTime(0)).toBe('00:00.0');
    expect(formatVirtualTime(12_340)).toBe('00:12.3');
    expect(formatVirtualTime(65_000)).toBe('01:05.0');
  });
});
