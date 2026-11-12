import { getService } from '@infrasim/catalog';
import {
  SCHEMA_VERSION,
  type CallPlan,
  type ChaosEvent,
  type Design,
  type EdgeFrame,
  type EdgeInstance,
  type ErrorKind,
  type HealthState,
  type LatencyModel,
  type LogEntry,
  type MockKind,
  type NetworkAnalysis,
  type NodeFrame,
  type NodeInstance,
  type NodeSummary,
  type OperationDef,
  type OperationOverride,
  type Particle,
  type PlanStep,
  type Scenario,
  type ServiceDefinition,
  type SimFrame,
  type SimulationResult,
  type Span,
  type TimeSeriesBucket,
  type Trace,
  type UsageCounters,
} from '@infrasim/shared-types';
import {
  type CircuitBreakerState,
  allowCircuitBreakerRequest,
  createCircuitBreaker,
  recordCircuitBreakerOutcome,
} from './circuitBreaker.js';
import { computeErlangC } from './erlang.js';
import {
  type NodeHealthTracker,
  createNodeHealthTracker,
  evaluateNodeHealthStep,
} from './health.js';
import { MinHeap } from './heap.js';
import { LogHistogram } from './histogram.js';
import { clampLatencyMs, sampleLatency } from './latency.js';
import {
  type InferredEdgePlacement,
  type ResolvedNodePlacement,
  inferEdgePlacement,
  resolveNodePlacement,
  sampleEdgeTransportLatency,
} from './networkLatency.js';
import { type SeededRng, createRng, hashSeed } from './prng.js';
import { type ResolvedNodeCapacities, resolveNodeCapacities } from './runtimePresets.js';
import {
  type StationState,
  type TokenBucket,
  acquireCoreOrQueue,
  advanceStationIntegrals,
  consumeStationWindowIntegrals,
  createStationState,
  createTokenBucket,
  getActiveSlotCapacity,
  releaseCoreAndDequeue,
  releaseSlotAndDequeue,
  tryAcquireOrEnqueueSlot,
  tryConsumeToken,
} from './stations.js';
import {
  createArrivalStream,
  estimateProfilePeakRps,
  estimateProfileTotalRequests,
  pickWeightedUserFlow,
  resolveScenarioEntryNode,
} from './traffic.js';

export interface LiveCodeExecutionOutput {
  ok: boolean;
  cpuMs: number;
  virtualDurationMs: number;
  errorKind?: ErrorKind;
  errorMessage?: string;
  logs: LogEntry[];
  calls: {
    serviceId: string;
    op: string;
    targetNodeId?: string;
    latencyMs: number;
    payloadBytes: number;
    responseBytes: number;
    parallelGroup?: string;
    alias?: string;
    errorKind?: ErrorKind;
    tokens?: { in: number; out: number; thinking?: number };
  }[];
}

export type LiveCodeExecutor = (params: {
  scriptId: string;
  node: NodeInstance;
  design: Design;
  seed: number;
  seq: number;
  event: unknown;
  coldStart: boolean;
  emitPlatformLogs: boolean;
  requestId: string;
  traceId?: string;
}) => Promise<LiveCodeExecutionOutput>;

export interface RunInput {
  design: Design;
  scenarioId: string;
  seed?: number;
  callPlans?: Record<string, CallPlan>;
  profileLogs?: Record<string, LogEntry[][]>;
  liveCodeExecutor?: LiveCodeExecutor;
  network?: NetworkAnalysis;
  options?: {
    frameIntervalMs?: number;
    maxEvents?: number;
    liveCode?: boolean;
    verboseLogs?: boolean;
    cpuScale?: number;
  };
}

export class SimulationAbortedError extends Error {
  constructor() {
    super('Simulation aborted');
    this.name = 'SimulationAbortedError';
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type DesEvent =
  | { t: number; seq: number; kind: 'CLIENT_ARRIVE' }
  | { t: number; seq: number; kind: 'NODE_ARRIVE'; call: CallCtx }
  | { t: number; seq: number; kind: 'END_CPU'; call: CallCtx; stage: 'pre' | 'post' | 'local' }
  | { t: number; seq: number; kind: 'END_LOCAL_WAIT'; call: CallCtx }
  | { t: number; seq: number; kind: 'CONN_WAIT_TIMEOUT'; call: CallCtx }
  | { t: number; seq: number; kind: 'ASYNC_POLL'; node: RuntimeNode }
  | { t: number; seq: number; kind: 'ASYNC_DRAIN_DONE'; node: RuntimeNode }
  | { t: number; seq: number; kind: 'CALL_TIMEOUT'; token: AttemptToken }
  | { t: number; seq: number; kind: 'RETRY_ATTEMPT'; attemptState: OutboundAttempt }
  | { t: number; seq: number; kind: 'RUN_CONTINUATION'; fn: () => void }
  | { t: number; seq: number; kind: 'COMPLETE_CALL'; call: CallCtx }
  | { t: number; seq: number; kind: 'BUCKET_TICK'; secondIdx: number }
  | { t: number; seq: number; kind: 'FRAME_TICK' }
  | { t: number; seq: number; kind: 'SCALE_CHECK'; node: RuntimeNode }
  | { t: number; seq: number; kind: 'ACTIVATE_SCALE'; node: RuntimeNode; delta: number }
  | { t: number; seq: number; kind: 'HEALTH_CHECK'; node: RuntimeNode }
  | { t: number; seq: number; kind: 'CHAOS_EVENT'; chaos: ChaosEvent; active: boolean };

interface CallOutcome {
  ok: boolean;
  errorKind?: ErrorKind;
  bytesOut: number;
}

interface AttemptToken {
  settled: boolean;
  inTimeoutHeap: boolean;
  edgeState: RuntimeEdge;
  attempt: OutboundAttempt;
  targetCall?: CallCtx;
}

interface OutboundAttempt {
  callerCall: CallCtx | null;
  edgeState: RuntimeEdge;
  targetNode: RuntimeNode;
  attemptIndex: number;
  maxRetries: number;
  backoffMs: number;
  jitter: boolean;
  attemptTimeoutMs: number;
  overallDeadlineMs: number;
  startMs: number;
  payloadBytes: number;
  opName?: string;
  onSettled: (outcome: CallOutcome) => void;
}

interface CallCtx {
  id: number;
  rootRequestId: string;
  sampledForReplayLog: boolean;
  sampledForPlatformSuccessLog: boolean;
  traceId: string;
  span?: Span;
  parentTraceSpans?: Span[];
  node: RuntimeNode;
  incomingEdge: RuntimeEdge | null;
  arrivalMs: number;
  serviceStartMs: number;
  deadlineMs: number;
  callerTimedOut: boolean;
  settledWithCaller: boolean;
  cancelOnTimeout: boolean;
  slotAcquired: boolean;
  dbConnectionHeld: boolean;
  holdingCore: boolean;
  coldStarted: boolean;
  errorOutcome: ErrorKind | null;
  pendingChildren: number;
  bytesOut: number;
  opName?: string;
  payloadBytes: number;
  downstreamStarted: boolean;
  postCpuMs: number;
  pendingPostOutcome?: CallOutcome;
  localWaitRemainingMs: number;
  queueHeadWaitDeadlineMs?: number;
  livePlan?: CallPlan;
  liveUserFailed?: boolean;
  liveCpuMs?: number;
  aiExec?: {
    ttftMs: number;
    decodeMs: number;
    tokensIn: number;
    tokensOut: number;
    isStream: boolean;
  };
  onFinish?: (outcome: CallOutcome) => void;
}

interface QueuedAsyncMsg {
  enqueuedAtMs: number;
  retriesLeft: number;
  payloadBytes: number;
  traceId: string;
  parentTraceSpans?: Span[];
}

interface RuntimeEdge {
  edge: EdgeInstance;
  fromNode: RuntimeNode;
  toNode: RuntimeNode;
  rng: SeededRng;
  circuitBreaker: CircuitBreakerState | null;
  networkBlocked: NetworkAnalysis['edges'][string] | null;
  resolvedPlacement: InferredEdgePlacement;
  // Rolling 1s frame window counters
  winCount: number;
  winErrors: number;
  winLatencySum: number;
  // Cumulative usage counters
  totalBytes: number;
  crossAz: boolean;
  crossRegion: boolean;
  viaNat: boolean;
  viaPrivateLink: boolean;
  extraNetworkLatencyMs: number;
}

interface RuntimeNode {
  node: NodeInstance;
  service?: ServiceDefinition;
  kind: MockKind;
  isClient: boolean;
  placement: ResolvedNodePlacement;
  capacities: ResolvedNodeCapacities;
  station: StationState<CallCtx, { call: CallCtx; stage: 'pre' | 'post' | 'local' }, CallCtx>;
  healthTracker: NodeHealthTracker;
  latencyRng: SeededRng;
  errorRng: SeededRng;
  routingRng: SeededRng;
  outgoingAll: RuntimeEdge[];
  outgoingSync: RuntimeEdge[];
  outgoingAsync: RuntimeEdge[];
  rrCursor: number;
  // Warm serverless instance timestamps & pre-resolved hot-path flags
  warmExpiryMs: number[];
  hasScenarioOverrides: boolean;
  hasOperationOverrides: boolean;
  resolvedColdStart: NodeInstance['config']['coldStart'] | undefined;
  // Async queue backlog & worker pool
  asyncBacklog: QueuedAsyncMsg[];
  asyncWorkersBusy: number;
  // Chaos dynamic modifiers
  killedInstances: number;
  azDown: boolean;
  chaosExtraLatencyMs: number;
  chaosErrorRateOverride: number | null;
  chaosRateBucket: TokenBucket | null;
  scenarioRateBucket: { key: string; bucket: TokenBucket } | null;
  cacheFlushStartMs: number | null;
  cacheFlushWarmupMs: number;
  // DB replica round-robin & connection waiters
  dbWaitQueue: { call: CallCtx; enqueuedAtMs: number; expired: boolean }[];
  // LB removed edge IDs + consecutive failure/success streaks per target edge
  lbEdgeUnhealthy: Set<string>;
  lbFailStreaks: Map<string, number>;
  lbPassStreaks: Map<string, number>;
  // Autoscaling & LB health tracking state
  warmingInstances: number;
  lastScaleOutMs: number;
  lastScaleInMs: number;
  lastBucketArrivals: number;
  lastBucketP95Ms: number;
  // Total counters across entire run
  totalArrivals: number;
  totalCompletions: number;
  totalErrors: Partial<Record<ErrorKind, number>>;
  totalErrorCount: number;
  totalDrops: number;
  totalWastedWorkMs: number;
  totalBytesIn: number;
  totalBytesOut: number;
  totalReadUnits: number;
  totalWriteUnits: number;
  totalGbSeconds: number;
  totalTokensIn: number;
  totalTokensOut: number;
  aiRpmBucket: TokenBucket | null;
  aiTpmBucket: TokenBucket | null;
  totalInstanceSeconds: number;
  sumUtil: number;
  sumCpuUtil: number;
  peakUtil: number;
  peakQueueDepth: number;
  totalHist: LogHistogram;
  // Current 1-second bucket accumulators
  bucketArrivals: number;
  bucketCompletions: number;
  bucketErrors: Partial<Record<ErrorKind, number>>;
  bucketErrorCount: number;
  bucketDrops: number;
  bucketThrottled: number;
  bucketHist: LogHistogram;
  // Sub-second integrated frame utilization snapshots
  lastFrameCheckMs: number;
  totalBucketedSlotAreaMs: number;
  totalBucketedCoreAreaMs: number;
  totalBucketedConnAreaMs: number;
  totalBucketedSlotCapAreaMs: number;
  totalBucketedCoreCapAreaMs: number;
  prevFrameCumSlotAreaMs: number;
  prevFrameCumCoreAreaMs: number;
  prevFrameCumConnAreaMs: number;
  prevFrameCumSlotCapAreaMs: number;
  prevFrameCumCoreCapAreaMs: number;
  lastFrameUtil: number;
  lastFrameCpuUtil: number;
  frameArrivals: number;
  frameCompletions: number;
  frameErrors: Partial<Record<ErrorKind, number>>;
  frameDrops: number;
  frameHist: LogHistogram;
  lastHealth: HealthState;
  lastSmoothedUtil: number;
  lastCpuUtil: number;
}

const DEFAULT_EDGE_BASE_RETRY_MAX = 0;

interface AiSimProfileSpec {
  ttftP50: number;
  ttftP95: number;
  tokensPerSec: number;
  prefillMsPerToken: number;
  contextWindow: number;
}

const AI_SIM_PROFILES: Record<
  'small-fast' | 'balanced' | 'large' | 'reasoning' | 'embedding',
  AiSimProfileSpec
> = {
  'small-fast': {
    ttftP50: 300,
    ttftP95: 900,
    tokensPerSec: 120,
    prefillMsPerToken: 0.02,
    contextWindow: 128_000,
  },
  balanced: {
    ttftP50: 500,
    ttftP95: 1800,
    tokensPerSec: 70,
    prefillMsPerToken: 0.03,
    contextWindow: 200_000,
  },
  large: {
    ttftP50: 800,
    ttftP95: 3000,
    tokensPerSec: 45,
    prefillMsPerToken: 0.04,
    contextWindow: 200_000,
  },
  reasoning: {
    ttftP50: 3000,
    ttftP95: 15000,
    tokensPerSec: 40,
    prefillMsPerToken: 0.04,
    contextWindow: 200_000,
  },
  embedding: {
    ttftP50: 60,
    ttftP95: 200,
    tokensPerSec: 0,
    prefillMsPerToken: 0.005,
    contextWindow: 8_000,
  },
};

function nowWallMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

function cooperativeYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function mapOperationErrorKind(kind?: OperationOverride['errorKind']): ErrorKind {
  if (kind === 'throttle') return 'throttled';
  if (kind === 'timeout') return 'timeout';
  return 'server';
}

const WRITE_OP_HINTS = [
  'PutObject',
  'PutItem',
  'Insert',
  'Exec',
  'Set',
  'SendMessage',
  'Publish',
  'PutRecord',
  'PutEvents',
  'UpdateItem',
  'Update',
];

function resolveNodeOperation(
  rn: RuntimeNode,
  opName?: string,
  isWrite = false,
): { name?: string; defOp?: OperationDef; override?: OperationOverride } {
  const ops = rn.node.config.operations ?? {};
  const defOps = rn.service?.operations ?? [];

  if (opName && ops[opName]) {
    return {
      name: opName,
      defOp: defOps.find((o) => o.name === opName),
      override: ops[opName],
    };
  }
  if (opName) {
    const exactDef = defOps.find((o) => o.name === opName);
    if (exactDef) {
      return { name: exactDef.name, defOp: exactDef, override: ops[exactDef.name] };
    }
  }

  const writeHint = isWrite || (opName ? /^(POST|PUT|PATCH|DELETE)\b/i.test(opName.trim()) : false);

  if (writeHint) {
    for (const candidate of WRITE_OP_HINTS) {
      if (ops[candidate]) {
        return {
          name: candidate,
          defOp: defOps.find((o) => o.name === candidate),
          override: ops[candidate],
        };
      }
    }
    for (const def of defOps) {
      if (WRITE_OP_HINTS.includes(def.name)) {
        return { name: def.name, defOp: def, override: ops[def.name] };
      }
    }
  }

  for (const def of defOps) {
    if (ops[def.name]) {
      return { name: def.name, defOp: def, override: ops[def.name] };
    }
  }

  const configuredKeys = Object.keys(ops);
  if (configuredKeys.length === 1) {
    const key = configuredKeys[0]!;
    return {
      name: key,
      defOp: defOps.find((o) => o.name === key),
      override: ops[key],
    };
  }

  if (defOps.length > 0) {
    return { name: opName ?? defOps[0]!.name, defOp: defOps[0] };
  }

  return { name: opName };
}

function getEffectiveScenarioOverride(node: NodeInstance, scenarioId: string, tS: number) {
  const list = node.config.scenarioOverrides;
  if (!list || list.length === 0) {
    return undefined;
  }
  for (const ov of list) {
    if (ov.scenarioId && ov.scenarioId !== scenarioId) {
      continue;
    }
    if (tS >= ov.fromS && tS < ov.toS) {
      return ov;
    }
  }
  return undefined;
}

function incrementErrorRecord(
  rec: Partial<Record<ErrorKind, number>>,
  kind: ErrorKind,
  delta = 1,
): void {
  rec[kind] = (rec[kind] ?? 0) + delta;
}

/**
 * Executes a deterministic discrete-event simulation over a `Design` + `Scenario`.
 * Emits `SimFrame` snapshots every `frameIntervalMs` virtual ms and returns aggregate `SimulationResult`.
 */
export async function runSimulation(
  input: RunInput,
  onFrame: (frame: SimFrame) => void,
  signal?: AbortSignal,
): Promise<SimulationResult> {
  const { design, scenarioId, network, options } = input;
  const scenario: Scenario | undefined =
    design.scenarios.find((s) => s.id === scenarioId) ?? design.scenarios[0];

  if (!scenario) {
    throw new Error(`Scenario "${scenarioId}" not found in design`);
  }

  const seed = input.seed ?? scenario.seedOverride ?? design.settings.seed ?? 42;
  const durationS = Math.max(1, scenario.durationS);
  const isLiveCodeMode = Boolean(options?.liveCode);
  const peakRps = estimateProfilePeakRps(scenario.profile, durationS);
  if (isLiveCodeMode && peakRps > 50) {
    throw new Error(
      `Live code mode is capped at 50 RPS (scenario peak is ${Math.round(peakRps)} RPS). Disable live code or reduce traffic below 50 RPS.`,
    );
  }
  const hasHandlerScripts = design.nodes.some((n) => {
    if (!n.config.scriptId || n.serviceId === 'generic.client' || n.serviceId === 'generic.users') {
      return false;
    }
    const script = design.scripts.find((s) => s.id === n.config.scriptId);
    return !script || script.kind === 'handler';
  });
  if (isLiveCodeMode && hasHandlerScripts && !input.liveCodeExecutor) {
    throw new Error('Live code mode requires a sandbox executor');
  }

  const endMs = durationS * 1000;
  const frameIntervalMs = Math.max(25, options?.frameIntervalMs ?? 100);
  const maxEvents = options?.maxEvents ?? 8_000_000;
  const verboseLogs = Boolean(options?.verboseLogs);
  const cpuScale = Math.max(0.01, Math.min(10, options?.cpuScale ?? 0.1));
  const runId = `run-${seed}-${durationS}-${design.id}`;

  const customServices = design.customServices ?? [];
  const serviceMap = new Map<string, ServiceDefinition>();
  for (const n of design.nodes) {
    const svc = getService(n.serviceId, customServices);
    if (svc) {
      serviceMap.set(n.serviceId, svc);
    }
  }

  // Estimate workload size for optional DES event scaling (> 2M estimated events)
  const estRequests = estimateProfileTotalRequests(scenario.profile, durationS);
  const estHops = Math.max(1.5, Math.min(8, design.nodes.length));
  const estEvents = estRequests * estHops * 3;
  const scaleFactor = estEvents > 2_000_000 ? Math.ceil(estEvents / 2_000_000) : 1;

  // Initialize runtime nodes cleanly with isolated per-node RNG streams
  const groupsById = new Map(design.groups.map((g) => [g.id, g]));
  const runtimeNodes = new Map<string, RuntimeNode>();
  const orderedNodes: RuntimeNode[] = [];

  for (const n of design.nodes) {
    const service = serviceMap.get(n.serviceId);
    const kind: MockKind = service?.kind ?? 'compute';
    const isClient = n.serviceId === 'generic.client' || n.serviceId === 'generic.users';
    const placement = resolveNodePlacement(n, groupsById);
    const capacities = resolveNodeCapacities(n, service, scaleFactor);
    const station = createStationState<
      CallCtx,
      { call: CallCtx; stage: 'pre' | 'post' | 'local' },
      CallCtx
    >(n.id, capacities, 0);

    const rt: RuntimeNode = {
      node: n,
      service,
      kind,
      isClient,
      placement,
      capacities,
      station,
      healthTracker: createNodeHealthTracker(),
      latencyRng: createRng(hashSeed(seed, n.id, 'latency')),
      errorRng: createRng(hashSeed(seed, n.id, 'error')),
      routingRng: createRng(hashSeed(seed, n.id, 'routing')),
      outgoingAll: [],
      outgoingSync: [],
      outgoingAsync: [],
      rrCursor: 0,
      warmExpiryMs: [],
      hasScenarioOverrides: Boolean(
        n.config.scenarioOverrides && n.config.scenarioOverrides.length > 0,
      ),
      hasOperationOverrides: Boolean(
        n.config.operations && Object.keys(n.config.operations).length > 0,
      ),
      resolvedColdStart:
        n.config.coldStart ??
        (kind === 'fn' && service?.coldStart
          ? {
              enabled: true,
              probabilityModel: 'idle-based',
              p50: service.coldStart.p50,
              p95: service.coldStart.p95,
              idleTtlS: service.coldStart.idleTtlS,
            }
          : undefined),
      asyncBacklog: [],
      asyncWorkersBusy: 0,
      killedInstances: 0,
      azDown: false,
      chaosExtraLatencyMs: 0,
      chaosErrorRateOverride: null,
      chaosRateBucket: null,
      scenarioRateBucket: null,
      cacheFlushStartMs: null,
      cacheFlushWarmupMs: 0,
      dbWaitQueue: [],
      lbEdgeUnhealthy: new Set(),
      lbFailStreaks: new Map(),
      lbPassStreaks: new Map(),
      warmingInstances: 0,
      lastScaleOutMs: -1e9,
      lastScaleInMs: -1e9,
      lastBucketArrivals: 0,
      lastBucketP95Ms: 0,
      totalArrivals: 0,
      totalCompletions: 0,
      totalErrors: {},
      totalErrorCount: 0,
      totalDrops: 0,
      totalWastedWorkMs: 0,
      totalBytesIn: 0,
      totalBytesOut: 0,
      totalReadUnits: 0,
      totalWriteUnits: 0,
      totalGbSeconds: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      aiRpmBucket:
        n.config.rateLimit?.rpm !== undefined && n.config.rateLimit.rpm > 0
          ? createTokenBucket(
              n.config.rateLimit.rpm / (60 * scaleFactor),
              Math.max(1, n.config.rateLimit.rpm / scaleFactor),
              0,
            )
          : null,
      aiTpmBucket:
        n.config.rateLimit?.tpm !== undefined && n.config.rateLimit.tpm > 0
          ? createTokenBucket(
              n.config.rateLimit.tpm / (60 * scaleFactor),
              Math.max(1, n.config.rateLimit.tpm / scaleFactor),
              0,
            )
          : null,
      totalInstanceSeconds: 0,
      sumUtil: 0,
      sumCpuUtil: 0,
      peakUtil: 0,
      peakQueueDepth: 0,
      totalHist: new LogHistogram(),
      bucketArrivals: 0,
      bucketCompletions: 0,
      bucketErrors: {},
      bucketErrorCount: 0,
      bucketDrops: 0,
      bucketThrottled: 0,
      bucketHist: new LogHistogram(),
      lastFrameCheckMs: 0,
      totalBucketedSlotAreaMs: 0,
      totalBucketedCoreAreaMs: 0,
      totalBucketedConnAreaMs: 0,
      totalBucketedSlotCapAreaMs: 0,
      totalBucketedCoreCapAreaMs: 0,
      prevFrameCumSlotAreaMs: 0,
      prevFrameCumCoreAreaMs: 0,
      prevFrameCumConnAreaMs: 0,
      prevFrameCumSlotCapAreaMs: 0,
      prevFrameCumCoreCapAreaMs: 0,
      lastFrameUtil: 0,
      lastFrameCpuUtil: 0,
      frameArrivals: 0,
      frameCompletions: 0,
      frameErrors: {},
      frameDrops: 0,
      frameHist: new LogHistogram(),
      lastHealth: 'ok',
      lastSmoothedUtil: 0,
      lastCpuUtil: 0,
    };

    runtimeNodes.set(n.id, rt);
    orderedNodes.push(rt);
  }

  // Wire runtime edges cleanly
  const orderedEdges: RuntimeEdge[] = [];
  for (const e of design.edges) {
    const fromNode = runtimeNodes.get(e.from);
    const toNode = runtimeNodes.get(e.to);
    if (!fromNode || !toNode) {
      continue;
    }
    const netAnalysis = network?.edges[e.id] ?? null;
    const resolvedPlacement = inferEdgePlacement(e, fromNode.node, toNode.node, {
      groupsById,
      sourceKind: fromNode.kind,
      targetKind: toNode.kind,
      sourcePlacement: fromNode.placement,
      targetPlacement: toNode.placement,
    });

    const re: RuntimeEdge = {
      edge: e,
      fromNode,
      toNode,
      rng: createRng(hashSeed(seed, e.id, 'edge')),
      circuitBreaker: e.circuitBreaker ? createCircuitBreaker(e.id, e.circuitBreaker) : null,
      networkBlocked: netAnalysis && !netAnalysis.reachable ? netAnalysis : null,
      resolvedPlacement,
      winCount: 0,
      winErrors: 0,
      winLatencySum: 0,
      totalBytes: 0,
      crossAz: resolvedPlacement.crossAz || Boolean(netAnalysis?.crossAz),
      crossRegion: resolvedPlacement.crossRegion || Boolean(netAnalysis?.crossRegion),
      viaNat: toNode.kind === 'net' || fromNode.kind === 'net' || Boolean(netAnalysis?.viaNat),
      viaPrivateLink: resolvedPlacement.viaPrivateLink || Boolean(netAnalysis?.viaEndpoint),
      extraNetworkLatencyMs: netAnalysis?.extraLatencyMs ?? 0,
    };
    orderedEdges.push(re);
    fromNode.outgoingAll.push(re);
    if (e.callType === 'async') {
      fromNode.outgoingAsync.push(re);
    } else {
      fromNode.outgoingSync.push(re);
    }
  }

  const heap = new MinHeap<DesEvent>((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    // Flush completed 1s buckets before applying chaos transitions at the exact boundary
    if (a.kind === 'BUCKET_TICK' && b.kind === 'CHAOS_EVENT') return -1;
    if (a.kind === 'CHAOS_EVENT' && b.kind === 'BUCKET_TICK') return 1;
    return a.seq - b.seq;
  });
  let seqCounter = 0;
  let callCounter = 0;
  let now = 0;
  let lastYieldWall = nowWallMs();
  let processedEvents = 0;

  // Separate timeout priority queue avoids polluting main event heap with tens of thousands of completed calls
  const timeoutHeap = new MinHeap<{ deadlineMs: number; seq: number; token: AttemptToken }>(
    (a, b) => a.deadlineMs - b.deadlineMs || a.seq - b.seq,
  );
  let activeTimeoutCount = 0;

  const schedule = (timeMs: number, partial: DistributiveOmit<DesEvent, 't' | 'seq'>) => {
    heap.push({ ...(partial as DesEvent), t: Math.max(now, timeMs), seq: ++seqCounter });
  };

  const enqueueTimeout = (deadlineMs: number, token: AttemptToken) => {
    if (deadlineMs >= endMs) {
      return;
    }
    token.inTimeoutHeap = true;
    activeTimeoutCount += 1;
    timeoutHeap.push({ deadlineMs, seq: ++seqCounter, token });
  };

  const pruneSettledTimeouts = () => {
    while (!timeoutHeap.isEmpty() && timeoutHeap.peek()!.token.settled) {
      timeoutHeap.pop();
    }
    if (timeoutHeap.size > Math.max(512, activeTimeoutCount * 8)) {
      const live: { deadlineMs: number; seq: number; token: AttemptToken }[] = [];
      while (!timeoutHeap.isEmpty()) {
        const entry = timeoutHeap.pop()!;
        if (!entry.token.settled) {
          live.push(entry);
        }
      }
      for (const entry of live) {
        timeoutHeap.push(entry);
      }
    }
  };

  // Global request metrics & reservoir-sampled traces (<= 200 total, <= 50 error bias)
  let rootTotalRequests = 0;
  let rootSuccess = 0;
  const rootErrors: Partial<Record<ErrorKind, number>> = {};
  const rootHist = new LogHistogram();
  let bucketRootArrivals = 0;
  let bucketRootSuccess = 0;
  let bucketRootErrorCount = 0;
  const bucketRootHist = new LogHistogram();
  const buckets: TimeSeriesBucket[] = [];

  const sampledTraces: Trace[] = [];
  let errorTraceCount = 0;
  const traceSampleRng = createRng(hashSeed(seed, 'global', 'traces'));
  const logSampleRng = createRng(hashSeed(seed, 'global', 'logs'));
  const MAX_TOTAL_LOGS_PER_RUN = 50_000;
  const MAX_ERROR_LOGS_PER_RUN = 2_000;
  const MAX_REPLAYED_USER_REQUESTS = 200;
  const pendingLogs: LogEntry[] = [];
  let logSeq = 0;
  let totalLogsEmitted = 0;
  let errorLogsEmitted = 0;
  let suppressedErrorLogs = 0;
  const isHandlerScript = (scriptId?: string): boolean => {
    if (!scriptId) return false;
    const script = design.scripts.find((s) => s.id === scriptId);
    return !script || script.kind === 'handler';
  };

  const replayedUserRequestIds = new Set<string>();
  let sampledPlatformSuccessCount = 0;
  const pendingLiveStarts: { call: CallCtx; coldExtraMs: number }[] = [];

  const emitLog = (
    level: LogEntry['level'],
    source: LogEntry['source'],
    message: string,
    nodeId?: string,
    traceId?: string,
    extra?: {
      requestId?: string;
      data?: unknown;
      site?: LogEntry['site'];
      replayedFromProfile?: boolean;
      tVirtualMs?: number;
    },
  ) => {
    if (level === 'debug' && !verboseLogs) {
      return;
    }
    if ((source === 'platform' || source === 'engine') && level === 'error') {
      if (errorLogsEmitted >= MAX_ERROR_LOGS_PER_RUN) {
        suppressedErrorLogs += 1;
        return;
      }
      errorLogsEmitted += 1;
    }
    if (totalLogsEmitted >= MAX_TOTAL_LOGS_PER_RUN) {
      return;
    }
    totalLogsEmitted += 1;
    pendingLogs.push({
      id: ++logSeq,
      tVirtualMs: Number((extra?.tVirtualMs ?? now).toFixed(2)),
      level,
      source,
      ...(nodeId ? { nodeId } : {}),
      ...(extra?.requestId ? { requestId: extra.requestId } : {}),
      ...(traceId ? { traceId } : {}),
      message,
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
      ...(extra?.site ? { site: extra.site } : {}),
      ...(extra?.replayedFromProfile ? { replayedFromProfile: true } : {}),
    });
  };

  const replayProfileUserLogs = (call: CallCtx, scriptId: string) => {
    if (isLiveCodeMode) {
      return;
    }
    const pool = input.profileLogs?.[scriptId];
    if (!pool || pool.length === 0) {
      return;
    }
    const alreadySampled = replayedUserRequestIds.has(call.rootRequestId);
    const shouldReplay =
      alreadySampled ||
      (replayedUserRequestIds.size < MAX_REPLAYED_USER_REQUESTS &&
        (call.sampledForReplayLog || replayedUserRequestIds.size === 0));
    if (!shouldReplay) {
      return;
    }
    replayedUserRequestIds.add(call.rootRequestId);
    const chosen = pool[Math.floor(call.node.errorRng.next() * pool.length)]!;
    for (const entry of chosen) {
      emitLog(
        entry.level,
        entry.source,
        entry.message,
        call.node.node.id,
        call.traceId || undefined,
        {
          requestId: call.rootRequestId,
          ...(entry.data !== undefined ? { data: entry.data } : {}),
          ...(entry.site ? { site: entry.site } : {}),
          replayedFromProfile: true,
        },
      );
    }
  };

  const entryNodeInst = resolveScenarioEntryNode(design, scenario);
  const entryNode = entryNodeInst ? runtimeNodes.get(entryNodeInst.id) : undefined;
  const clientRng = createRng(hashSeed(seed, 'client', 'arrivals'));
  const flowRng = createRng(hashSeed(seed, 'client', 'flows'));
  const nextClientArrivalMs = createArrivalStream(
    scenario.profile,
    durationS,
    scaleFactor,
    clientRng,
  );

  // Schedule first client arrival
  if (entryNode) {
    const firstT = nextClientArrivalMs();
    if (firstT !== null && firstT < endMs) {
      schedule(firstT, { kind: 'CLIENT_ARRIVE' });
    }
  }

  // Schedule periodic 1-second buckets and UI frames
  if (durationS >= 1) {
    schedule(1000, { kind: 'BUCKET_TICK', secondIdx: 1 });
  }
  schedule(frameIntervalMs, { kind: 'FRAME_TICK' });

  // Schedule autoscaling and health check timers cleanly
  for (const rn of orderedNodes) {
    if (rn.node.config.autoscaling) {
      const checkMs = Math.max(1, rn.node.config.autoscaling.checkIntervalS) * 1000;
      schedule(checkMs, { kind: 'SCALE_CHECK', node: rn });
    }
    const lbHc =
      rn.kind === 'lb'
        ? (rn.node.config.lb?.healthCheck ??
          (rn.outgoingSync.length > 1
            ? { intervalS: 2, unhealthyThreshold: 2, healthyThreshold: 2, timeoutMs: 2000 }
            : undefined))
        : undefined;
    if (lbHc) {
      const intervalMs = Math.max(1, lbHc.intervalS) * 1000;
      schedule(intervalMs, { kind: 'HEALTH_CHECK', node: rn });
    }
    if (
      (rn.kind === 'queue' || rn.kind === 'topic' || rn.kind === 'stream' || rn.kind === 'bus') &&
      rn.outgoingSync.length + rn.outgoingAsync.length > 0
    ) {
      const pollMs = Math.max(5, rn.node.config.consumer?.pollMs ?? 50);
      schedule(pollMs, { kind: 'ASYNC_POLL', node: rn });
    }
  }

  // Schedule Chaos start/end markers
  for (const chaos of scenario.chaos ?? []) {
    const startMs = Math.max(0, chaos.atS * 1000);
    const stopMs = startMs + Math.max(0, chaos.durationS * 1000);
    if (startMs < endMs) {
      schedule(startMs, { kind: 'CHAOS_EVENT', chaos, active: true });
    }
    if (stopMs < endMs) {
      schedule(stopMs, { kind: 'CHAOS_EVENT', chaos, active: false });
    }
  }

  // --- Helpers for edge selection, call plans, node execution, and completion ---

  const pickSyncEdgeWeighted = (rn: RuntimeNode, eligible: RuntimeEdge[]): RuntimeEdge | null => {
    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0]!;

    if (rn.kind === 'lb') {
      const alg = rn.node.config.lb?.algorithm ?? 'round-robin';
      if (alg === 'least-conn') {
        let best = eligible[0]!;
        let bestLoad = best.toNode.station.inFlight + best.toNode.station.slotQueue.length;
        for (let i = 1; i < eligible.length; i++) {
          const cand = eligible[i]!;
          const load = cand.toNode.station.inFlight + cand.toNode.station.slotQueue.length;
          if (load < bestLoad) {
            best = cand;
            bestLoad = load;
          }
        }
        return best;
      }
      if (alg === 'round-robin') {
        const picked = eligible[rn.rrCursor % eligible.length]!;
        rn.rrCursor = (rn.rrCursor + 1) % eligible.length;
        return picked;
      }
    }

    let totalWeight = 0;
    for (const edge of eligible) {
      totalWeight += Math.max(0, edge.edge.weight);
    }
    if (totalWeight <= 0) {
      return eligible[Math.floor(rn.routingRng.next() * eligible.length)]!;
    }
    let cursor = rn.routingRng.next() * totalWeight;
    for (const edge of eligible) {
      cursor -= Math.max(0, edge.edge.weight);
      if (cursor <= 0) {
        return edge;
      }
    }
    return eligible[eligible.length - 1]!;
  };

  const getEffectiveLatencyModel = (
    rn: RuntimeNode,
    opName?: string,
    isWrite = false,
  ): LatencyModel => {
    const ov = rn.hasScenarioOverrides
      ? getEffectiveScenarioOverride(rn.node, scenario.id, now / 1000)
      : undefined;
    if (ov?.latency) {
      return ov.latency;
    }
    if (rn.hasOperationOverrides) {
      const opRes = resolveNodeOperation(rn, opName, isWrite);
      if (opRes.override?.latency) {
        return opRes.override.latency;
      }
    }
    return (
      rn.node.config.latency ??
      rn.service?.latency ?? {
        distribution: 'lognormal',
        p50: 15,
        p95: 60,
      }
    );
  };

  const getEffectiveErrorOutcome = (
    rn: RuntimeNode,
    opName?: string,
    isWrite = false,
  ): { errorRate: number; errorKind: ErrorKind; opErrorTag?: string } => {
    if (rn.chaosErrorRateOverride !== null) {
      return { errorRate: rn.chaosErrorRateOverride, errorKind: 'server' };
    }
    const ov = rn.hasScenarioOverrides
      ? getEffectiveScenarioOverride(rn.node, scenario.id, now / 1000)
      : undefined;
    if (ov?.errorRate !== undefined) {
      return { errorRate: ov.errorRate, errorKind: 'server' };
    }
    if (rn.hasOperationOverrides) {
      const opRes = resolveNodeOperation(rn, opName, isWrite);
      if (opRes.override?.errorRate !== undefined) {
        return {
          errorRate: opRes.override.errorRate,
          errorKind: mapOperationErrorKind(opRes.override.errorKind),
          ...(opRes.override.errorKind ? { opErrorTag: opRes.override.errorKind } : {}),
        };
      }
    }
    return {
      errorRate: rn.node.config.errorRate ?? rn.service?.failure.errorRate ?? 0,
      errorKind: 'server',
    };
  };

  const sampleNodeServiceLatency = (rn: RuntimeNode, isWrite = false, opName?: string): number => {
    const model = getEffectiveLatencyModel(rn, opName, isWrite);
    let ms = sampleLatency(model, rn.latencyRng);
    if (isWrite && (rn.kind === 'sql' || rn.kind === 'doc' || rn.kind === 'kv')) {
      const mult = rn.node.config.writeLatencyMultiplier ?? 1.5;
      ms *= Math.max(0.1, mult);
    }
    if (rn.chaosExtraLatencyMs > 0) {
      ms += rn.chaosExtraLatencyMs;
    }
    return clampLatencyMs(ms);
  };

  const recomputeActiveInstances = (rn: RuntimeNode) => {
    advanceStationIntegrals(rn.station, now);
    const ready = Math.max(0, rn.station.instancesTotal - rn.warmingInstances);
    if (rn.azDown) {
      rn.station.instancesActive = 0;
      return;
    }
    rn.station.instancesActive = Math.max(0, ready - rn.killedInstances);
  };

  const recordNodeOutcome = (call: CallCtx, ok: boolean, errorKind?: ErrorKind) => {
    const rn = call.node;
    const totalLatencyMs = Math.max(0.01, now - call.arrivalMs);
    if (ok) {
      rn.totalCompletions += 1;
      rn.bucketCompletions += 1;
      rn.frameCompletions += 1;
      rn.totalBytesOut += call.bytesOut;
      if (
        !rn.isClient &&
        call.sampledForPlatformSuccessLog &&
        !(isLiveCodeMode && isHandlerScript(rn.node.config.scriptId))
      ) {
        const provider = rn.service?.provider;
        const msg =
          provider === 'aws' && rn.kind === 'fn'
            ? `REPORT RequestId: ${call.rootRequestId} Duration: ${totalLatencyMs.toFixed(2)} ms Billed Duration: ${Math.max(1, Math.ceil(totalLatencyMs))} ms Memory Size: ${Math.round((rn.node.config.memoryGb ?? 0.5) * 1024)} MB${call.coldStarted ? ` Init Duration: ${totalLatencyMs.toFixed(1)} ms` : ''}`
            : `${rn.node.label} 200 OK${call.opName ? ` ${call.opName}` : ''} (${totalLatencyMs.toFixed(1)} ms)`;
        emitLog('info', 'platform', msg, rn.node.id, call.traceId || undefined, {
          requestId: call.rootRequestId,
        });
      }
    } else {
      const err = errorKind ?? 'server';
      if (err === 'dropped_queue_full') {
        rn.totalDrops += 1;
        rn.bucketDrops += 1;
        rn.frameDrops += 1;
        if (!rn.isClient) {
          emitLog(
            'error',
            'engine',
            `Queue full drop on ${rn.node.label} (${call.opName ?? 'request'})`,
            rn.node.id,
            call.traceId || undefined,
            { requestId: call.rootRequestId },
          );
        }
      } else {
        rn.totalErrorCount += 1;
        rn.bucketErrorCount += 1;
        incrementErrorRecord(rn.totalErrors, err);
        incrementErrorRecord(rn.bucketErrors, err);
        incrementErrorRecord(rn.frameErrors, err);
        if (err === 'throttled') {
          rn.bucketThrottled += 1;
        }
        if (
          !rn.isClient &&
          !(isLiveCodeMode && err === 'user_code' && call.sampledForPlatformSuccessLog)
        ) {
          emitLog(
            'error',
            'platform',
            `${rn.node.label} ${err}${call.opName ? ` (${call.opName})` : ''} after ${totalLatencyMs.toFixed(1)} ms`,
            rn.node.id,
            call.traceId || undefined,
            { requestId: call.rootRequestId },
          );
        }
      }
    }

    rn.totalHist.record(totalLatencyMs);
    rn.bucketHist.record(totalLatencyMs);
    rn.frameHist.record(totalLatencyMs);

    if (call.callerTimedOut) {
      rn.totalWastedWorkMs += totalLatencyMs;
    }

    if (call.span) {
      call.span.serviceMs = Number(Math.max(0, now - call.serviceStartMs).toFixed(2));
      call.span.status = ok ? 'ok' : (errorKind ?? 'server');
      if (call.callerTimedOut) {
        call.span.attrs = {
          ...(call.span.attrs ?? {}),
          zombie: 1,
        };
      }
      if (ok && call.aiExec && call.aiExec.isStream && call.parentTraceSpans) {
        call.parentTraceSpans.push(
          {
            spanId: `${call.span.spanId}-ttft`,
            parentId: call.span.spanId,
            nodeId: rn.node.id,
            operation: `${call.opName ?? 'InvokeStream'} (ttft)`,
            startMs: Number(call.serviceStartMs.toFixed(2)),
            waitMs: call.span.waitMs,
            serviceMs: Number(call.aiExec.ttftMs.toFixed(2)),
            status: 'ok',
            attrs: { phase: 'ttft' },
          },
          {
            spanId: `${call.span.spanId}-decode`,
            parentId: call.span.spanId,
            nodeId: rn.node.id,
            operation: `${call.opName ?? 'InvokeStream'} (decode)`,
            startMs: Number((call.serviceStartMs + call.aiExec.ttftMs).toFixed(2)),
            waitMs: 0,
            serviceMs: Number(call.aiExec.decodeMs.toFixed(2)),
            status: 'ok',
            attrs: { phase: 'decode' },
          },
        );
      }
    }
    if (ok && call.aiExec) {
      rn.totalTokensIn += call.aiExec.tokensIn;
      rn.totalTokensOut += call.aiExec.tokensOut;
    }
  };

  const settleCallAndReleaseResources = (call: CallCtx, ok: boolean, errorKind?: ErrorKind) => {
    const rn = call.node;

    // Release DB connection pool if held and wake oldest non-expired waiter
    if (call.dbConnectionHeld && rn.capacities.connectionsMax !== null) {
      call.dbConnectionHeld = false;
      let promoted = false;
      while (rn.dbWaitQueue.length > 0) {
        const nextWaiter = rn.dbWaitQueue.shift()!;
        if (nextWaiter.expired) {
          continue;
        }
        nextWaiter.call.dbConnectionHeld = true;
        const serviceMs = sampleNodeServiceLatency(
          rn,
          !rn.latencyRng.chance(rn.node.config.readRatio ?? 0.8),
          nextWaiter.call.opName,
        );
        if (rn.kind === 'sql' || rn.kind === 'kv' || rn.kind === 'doc') {
          if (serviceMs > (rn.node.config.latency?.p50 ?? 15)) {
            rn.totalWriteUnits += 1;
          } else {
            rn.totalReadUnits += 1;
          }
        }
        schedule(now + serviceMs, { kind: 'COMPLETE_CALL', call: nextWaiter.call });
        promoted = true;
        break;
      }
      if (!promoted) {
        advanceStationIntegrals(rn.station, now);
        rn.station.busyConnections = Math.max(0, rn.station.busyConnections - 1);
      }
    }

    // Release slot if acquired and promote head queued caller
    if (call.slotAcquired) {
      call.slotAcquired = false;
      const promoted = releaseSlotAndDequeue(rn.station, now);
      if (promoted) {
        startServiceAtNode(promoted.req);
      }
    }

    if (rn.kind === 'fn') {
      const memGb = Math.max(0.128, rn.node.config.memoryGb ?? 0.5);
      const billedSec = Math.max(0.001, (now - call.serviceStartMs) / 1000) * memGb;
      rn.totalGbSeconds += billedSec;
      const coldCfg = rn.resolvedColdStart;
      if (coldCfg?.enabled && coldCfg.probabilityModel !== 'fixed') {
        const idleTtlMs = (coldCfg.idleTtlS ?? 600) * 1000;
        const maxWarm = Math.max(1, Math.min(2048, rn.capacities.totalSlots));
        if (rn.warmExpiryMs.length < maxWarm) {
          rn.warmExpiryMs.push(now + idleTtlMs);
        } else {
          rn.warmExpiryMs[rn.warmExpiryMs.length - 1] = now + idleTtlMs;
        }
      }
    }

    recordNodeOutcome(call, ok, errorKind);

    if (!call.settledWithCaller && call.onFinish) {
      call.settledWithCaller = true;
      call.onFinish({ ok, errorKind, bytesOut: call.bytesOut });
    }
  };

  const launchEdgeAttempt = (attemptState: OutboundAttempt) => {
    const { edgeState, targetNode } = attemptState;

    // Network block check (drop / conn_refused / dns)
    if (edgeState.networkBlocked) {
      const mode = edgeState.networkBlocked.failureMode ?? 'timeout';
      if (mode === 'refused') {
        emitLog(
          'error',
          'engine',
          `ECONNREFUSED (${edgeState.networkBlocked.reasonCode ?? 'PORT_NOT_LISTENING'}) on ${edgeState.edge.id}: ${edgeState.networkBlocked.explanation.short}`,
          targetNode.node.id,
          attemptState.callerCall?.traceId || undefined,
          { requestId: attemptState.callerCall?.rootRequestId },
        );
        schedule(now + 1, {
          kind: 'RUN_CONTINUATION',
          fn: () => {
            edgeState.winCount += 1;
            edgeState.winErrors += 1;
            attemptState.onSettled({ ok: false, errorKind: 'conn_refused', bytesOut: 0 });
          },
        });
        return;
      }
      const timeoutMs = Math.min(3000, Math.max(100, attemptState.overallDeadlineMs - now));
      const failKind: ErrorKind = mode === 'dns' ? 'not_reachable' : 'conn_timeout';
      const prefix = mode === 'dns' ? 'ENOTFOUND' : 'ETIMEDOUT';
      emitLog(
        'error',
        'engine',
        `${prefix} (${edgeState.networkBlocked.reasonCode ?? mode}) on ${edgeState.edge.id}: ${edgeState.networkBlocked.explanation.short}`,
        targetNode.node.id,
        attemptState.callerCall?.traceId || undefined,
        { requestId: attemptState.callerCall?.rootRequestId },
      );
      schedule(now + timeoutMs, {
        kind: 'RUN_CONTINUATION',
        fn: () => {
          edgeState.winCount += 1;
          edgeState.winErrors += 1;
          attemptState.onSettled({ ok: false, errorKind: failKind, bytesOut: 0 });
        },
      });
      return;
    }

    // Circuit breaker check
    if (edgeState.circuitBreaker && !allowCircuitBreakerRequest(edgeState.circuitBreaker, now)) {
      attemptState.edgeState.winCount += 1;
      attemptState.edgeState.winErrors += 1;
      emitLog(
        'warn',
        'engine',
        `Circuit breaker open on ${edgeState.edge.id} -> ${targetNode.node.label}`,
        targetNode.node.id,
        attemptState.callerCall?.traceId || undefined,
        { requestId: attemptState.callerCall?.rootRequestId },
      );
      attemptState.onSettled({ ok: false, errorKind: 'circuit_open', bytesOut: 0 });
      return;
    }

    const token: AttemptToken = {
      settled: false,
      inTimeoutHeap: false,
      edgeState,
      attempt: attemptState,
    };

    // Sample one-way transport delay (+ network hop delay for NAT / peering / TGW / VPN / endpoint)
    const { latencyMs: sampledNetMs } = sampleEdgeTransportLatency(
      edgeState.edge,
      edgeState.fromNode.node,
      targetNode.node,
      edgeState.rng,
      { resolvedPlacement: edgeState.resolvedPlacement },
    );
    const netLatencyMs = sampledNetMs + edgeState.extraNetworkLatencyMs;
    edgeState.totalBytes += attemptState.payloadBytes;

    // Schedule attempt timeout watchdog in compact active timeout heap
    const attemptDeadlineMs = Math.min(
      attemptState.overallDeadlineMs,
      now + attemptState.attemptTimeoutMs,
    );
    const timeoutAtMs = Math.max(now + 5, attemptDeadlineMs);
    enqueueTimeout(timeoutAtMs, token);

    const nextCallId = ++callCounter;
    const targetCall: CallCtx = {
      id: nextCallId,
      rootRequestId: attemptState.callerCall?.rootRequestId ?? `async-${nextCallId}`,
      sampledForReplayLog: attemptState.callerCall?.sampledForReplayLog ?? false,
      sampledForPlatformSuccessLog: attemptState.callerCall?.sampledForPlatformSuccessLog ?? false,
      traceId: attemptState.callerCall?.traceId ?? '',
      parentTraceSpans: attemptState.callerCall?.parentTraceSpans,
      node: targetNode,
      incomingEdge: edgeState,
      arrivalMs: now + netLatencyMs,
      serviceStartMs: now + netLatencyMs,
      deadlineMs: attemptDeadlineMs,
      callerTimedOut: false,
      settledWithCaller: false,
      cancelOnTimeout: Boolean(targetNode.node.config.cancelOnTimeout),
      slotAcquired: false,
      dbConnectionHeld: false,
      holdingCore: false,
      coldStarted: false,
      errorOutcome: null,
      pendingChildren: 0,
      bytesOut: attemptState.payloadBytes,
      opName: attemptState.opName,
      payloadBytes: attemptState.payloadBytes,
      downstreamStarted: false,
      postCpuMs: 0,
      localWaitRemainingMs: 0,
      onFinish: (outcome) => {
        if (token.settled) {
          return;
        }
        token.settled = true;
        if (token.inTimeoutHeap) {
          activeTimeoutCount = Math.max(0, activeTimeoutCount - 1);
        }
        while (!timeoutHeap.isEmpty() && timeoutHeap.peek()!.token.settled) {
          timeoutHeap.pop();
        }

        const latencyMeasured = Math.max(0.01, now - attemptState.startMs);
        edgeState.winCount += 1;
        edgeState.winLatencySum += latencyMeasured;
        if (!outcome.ok) {
          edgeState.winErrors += 1;
        }

        if (edgeState.circuitBreaker) {
          recordCircuitBreakerOutcome(edgeState.circuitBreaker, outcome.ok, now);
        }

        if (outcome.ok) {
          edgeState.totalBytes += outcome.bytesOut;
          attemptState.onSettled(outcome);
          return;
        }

        // Retry logic on retryable error
        const canRetry =
          attemptState.attemptIndex < attemptState.maxRetries &&
          outcome.errorKind !== 'circuit_open' &&
          now < attemptState.overallDeadlineMs - 5;

        if (canRetry) {
          const expDelay = attemptState.backoffMs * Math.pow(2, attemptState.attemptIndex);
          const delayMs = attemptState.jitter
            ? expDelay * Math.max(0.1, edgeState.rng.next())
            : expDelay;
          if (now + delayMs < attemptState.overallDeadlineMs) {
            emitLog(
              'warn',
              'platform',
              `Retrying ${targetNode.node.label} (attempt ${attemptState.attemptIndex + 2}/${attemptState.maxRetries + 1})`,
              targetNode.node.id,
              attemptState.callerCall?.traceId || undefined,
              { requestId: attemptState.callerCall?.rootRequestId },
            );
            schedule(now + delayMs, {
              kind: 'RETRY_ATTEMPT',
              attemptState: {
                ...attemptState,
                attemptIndex: attemptState.attemptIndex + 1,
                startMs: now + delayMs,
              },
            });
            return;
          }
        }

        attemptState.onSettled(outcome);
      },
    };

    if (targetCall.parentTraceSpans) {
      const spanAttrs: Record<string, string | number> = {};
      if (attemptState.attemptIndex > 0) {
        spanAttrs.attempt = attemptState.attemptIndex + 1;
        spanAttrs.retried = 1;
      }
      targetCall.span = {
        spanId: `sp-${targetCall.id}`,
        parentId: attemptState.callerCall?.span?.spanId,
        nodeId: targetNode.node.id,
        operation: attemptState.opName,
        startMs: Number((now + netLatencyMs).toFixed(2)),
        waitMs: 0,
        serviceMs: 0,
        status: 'ok',
        ...(Object.keys(spanAttrs).length > 0 ? { attrs: spanAttrs } : {}),
      };
      targetCall.parentTraceSpans.push(targetCall.span);
    }

    token.targetCall = targetCall;
    schedule(now + netLatencyMs, { kind: 'NODE_ARRIVE', call: targetCall });
  };

  const invokeEdgeWithPolicy = (
    caller: CallCtx | null,
    edgeState: RuntimeEdge,
    parentDeadlineMs: number,
    payloadBytes: number,
    onDone: (outcome: CallOutcome) => void,
    opName?: string,
  ) => {
    const nodeTimeout = caller?.node.node.config.timeoutMs ?? 30_000;
    const lbIdle =
      caller?.node.kind === 'lb' ? caller.node.node.config.lb?.idleTimeoutMs : undefined;
    const effectiveTimeout = Math.min(nodeTimeout, lbIdle ?? nodeTimeout);
    const overallDeadlineMs = Math.max(parentDeadlineMs, now + 1);
    const retryCfg = edgeState.edge.retry;

    launchEdgeAttempt({
      callerCall: caller,
      edgeState,
      targetNode: edgeState.toNode,
      attemptIndex: 0,
      maxRetries: retryCfg?.max ?? DEFAULT_EDGE_BASE_RETRY_MAX,
      backoffMs: retryCfg?.backoffMs ?? 50,
      jitter: retryCfg?.jitter ?? true,
      attemptTimeoutMs: effectiveTimeout,
      overallDeadlineMs,
      startMs: now,
      payloadBytes,
      opName,
      onSettled: onDone,
    });
  };

  const findMatchingEdgesForStep = (
    rn: RuntimeNode,
    step: Extract<PlanStep, { kind: 'call' }>,
  ): RuntimeEdge[] => {
    const byService = rn.outgoingAll.filter((e) => e.toNode.node.serviceId === step.serviceId);
    if (!step.alias) {
      return byService;
    }
    const exact = byService.filter(
      (e) =>
        e.toNode.node.id === step.alias ||
        e.toNode.node.label === step.alias ||
        e.edge.label === step.alias,
    );
    return exact;
  };

  const dispatchDownstreamFromNode = (call: CallCtx, onAllDone: (outcome: CallOutcome) => void) => {
    const rn = call.node;
    const scriptId = rn.node.config.scriptId;
    const activePlan =
      call.livePlan ??
      (scriptId && isHandlerScript(scriptId) ? input.callPlans?.[scriptId] : undefined);

    if (activePlan) {
      executePlanSteps(call, activePlan.steps, 0, (res) => {
        onAllDone({
          ok: res.ok,
          errorKind: res.errorKind,
          bytesOut: res.bytesOut > 0 ? res.bytesOut : Math.max(256, call.bytesOut),
        });
      });
      return;
    }

    // Async edges fire-and-forget alongside sync path
    for (const asyncEdge of rn.outgoingAsync) {
      invokeEdgeWithPolicy(
        call,
        asyncEdge,
        call.deadlineMs,
        call.payloadBytes,
        () => {
          // Async errors do not fail caller synchronously
        },
        call.opName,
      );
    }

    if (rn.outgoingSync.length === 0) {
      onAllDone({ ok: true, bytesOut: 256 });
      return;
    }

    // Filter out LB-unhealthy backend edges (keep all as fallback if everything marked unhealthy)
    let candidates = rn.outgoingSync;
    if (rn.kind === 'lb' && rn.lbEdgeUnhealthy.size > 0) {
      const healthy = rn.outgoingSync.filter((e) => !rn.lbEdgeUnhealthy.has(e.edge.id));
      if (healthy.length > 0) {
        candidates = healthy;
      }
    }

    const fanOutEdges = candidates.filter((e) => (e.edge.fanOut ?? 1) > 1);
    if (fanOutEdges.length > 0) {
      let pending = 0;
      let firstErr: ErrorKind | undefined;
      let bytesSum = 0;
      for (const edge of fanOutEdges) {
        const count = Math.min(10, Math.max(1, edge.edge.fanOut ?? 1));
        pending += count;
        for (let k = 0; k < count; k++) {
          invokeEdgeWithPolicy(call, edge, call.deadlineMs, call.payloadBytes, (res) => {
            pending -= 1;
            bytesSum += res.bytesOut;
            if (!res.ok && !firstErr) {
              firstErr = res.errorKind ?? 'server';
            }
            if (pending === 0) {
              onAllDone({ ok: !firstErr, errorKind: firstErr, bytesOut: bytesSum });
            }
          });
        }
      }
      return;
    }

    const chosen = pickSyncEdgeWeighted(rn, candidates);
    if (!chosen) {
      onAllDone({ ok: true, bytesOut: 256 });
      return;
    }

    invokeEdgeWithPolicy(call, chosen, call.deadlineMs, call.payloadBytes, onAllDone, call.opName);
  };

  const executePlanSteps = (
    call: CallCtx,
    steps: PlanStep[],
    idx: number,
    onAllDone: (outcome: CallOutcome) => void,
  ) => {
    if (idx >= steps.length) {
      onAllDone({ ok: true, bytesOut: 256 });
      return;
    }
    const step = steps[idx]!;
    if (step.kind === 'cpu' || step.kind === 'sleep') {
      schedule(now + Math.max(0.1, step.ms), {
        kind: 'RUN_CONTINUATION',
        fn: () => executePlanSteps(call, steps, idx + 1, onAllDone),
      });
      return;
    }
    if (step.kind === 'branch') {
      const branchSteps = call.node.routingRng.chance(step.probability) ? step.then : step.else;
      executePlanSteps(call, branchSteps, 0, (bRes) => {
        if (!bRes.ok) {
          onAllDone(bRes);
          return;
        }
        executePlanSteps(call, steps, idx + 1, (rest) => {
          onAllDone({
            ok: rest.ok,
            errorKind: rest.errorKind,
            bytesOut: bRes.bytesOut + rest.bytesOut,
          });
        });
      });
      return;
    }

    // Contiguous parallelGroup batch (Promise.all semantics)
    if (step.parallelGroup) {
      const groupId = step.parallelGroup;
      let endIdx = idx + 1;
      while (endIdx < steps.length) {
        const cand = steps[endIdx]!;
        if (cand.kind === 'call' && cand.parallelGroup === groupId) {
          endIdx += 1;
        } else {
          break;
        }
      }

      const activeCalls: {
        step: Extract<PlanStep, { kind: 'call' }>;
        edge: RuntimeEdge;
        count: number;
      }[] = [];

      for (let i = idx; i < endIdx; i++) {
        const s = steps[i] as Extract<PlanStep, { kind: 'call' }>;
        if (s.probability !== undefined && !call.node.routingRng.chance(s.probability)) {
          continue;
        }
        const matching = findMatchingEdgesForStep(call.node, s);
        if (matching.length === 0) {
          emitLog(
            'error',
            'engine',
            `Handler on ${call.node.node.label} attempted ${s.serviceId}.${s.op} but no connected matching edge was found`,
            call.node.node.id,
            call.traceId || undefined,
            { requestId: call.rootRequestId },
          );
          onAllDone({ ok: false, errorKind: 'not_reachable', bytesOut: 0 });
          return;
        }
        const edge = pickSyncEdgeWeighted(call.node, matching)!;
        activeCalls.push({ step: s, edge, count: Math.max(1, s.count) });
      }

      if (activeCalls.length === 0) {
        executePlanSteps(call, steps, endIdx, onAllDone);
        return;
      }

      let remaining = activeCalls.reduce((sum, item) => sum + item.count, 0);
      let firstErr: ErrorKind | undefined;
      let bytesSum = 0;

      for (const item of activeCalls) {
        for (let k = 0; k < item.count; k++) {
          invokeEdgeWithPolicy(
            call,
            item.edge,
            call.deadlineMs,
            item.step.payloadBytes ?? call.payloadBytes,
            (res) => {
              remaining -= 1;
              bytesSum += res.bytesOut;
              if (!res.ok && !firstErr) {
                firstErr = res.errorKind ?? 'server';
              }
              if (remaining === 0) {
                if (firstErr) {
                  onAllDone({ ok: false, errorKind: firstErr, bytesOut: bytesSum });
                } else {
                  executePlanSteps(call, steps, endIdx, (rest) => {
                    onAllDone({
                      ok: rest.ok,
                      errorKind: rest.errorKind,
                      bytesOut: bytesSum + rest.bytesOut,
                    });
                  });
                }
              }
            },
            item.step.op,
          );
        }
      }
      return;
    }

    // Sequential call step
    if (step.probability !== undefined && !call.node.routingRng.chance(step.probability)) {
      executePlanSteps(call, steps, idx + 1, onAllDone);
      return;
    }
    const matching = findMatchingEdgesForStep(call.node, step);
    if (matching.length === 0) {
      emitLog(
        'error',
        'engine',
        `Handler on ${call.node.node.label} attempted ${step.serviceId}.${step.op} but no connected matching edge was found`,
        call.node.node.id,
        call.traceId || undefined,
        { requestId: call.rootRequestId },
      );
      onAllDone({ ok: false, errorKind: 'not_reachable', bytesOut: 0 });
      return;
    }
    const edge = pickSyncEdgeWeighted(call.node, matching)!;
    let remaining = Math.max(1, step.count);
    let firstErr: ErrorKind | undefined;
    let bytesSum = 0;
    for (let k = 0; k < remaining; k++) {
      invokeEdgeWithPolicy(
        call,
        edge,
        call.deadlineMs,
        step.payloadBytes ?? call.payloadBytes,
        (res) => {
          remaining -= 1;
          bytesSum += res.bytesOut;
          if (!res.ok && !firstErr) {
            firstErr = res.errorKind ?? 'server';
          }
          if (remaining === 0) {
            if (firstErr) {
              onAllDone({ ok: false, errorKind: firstErr, bytesOut: bytesSum });
            } else {
              executePlanSteps(call, steps, idx + 1, (rest) => {
                onAllDone({
                  ok: rest.ok,
                  errorKind: rest.errorKind,
                  bytesOut: bytesSum + rest.bytesOut,
                });
              });
            }
          }
        },
        step.op,
      );
    }
  };

  const finishNodeAfterLocalWork = (call: CallCtx) => {
    const rn = call.node;
    if (call.liveUserFailed) {
      settleCallAndReleaseResources(call, false, 'user_code');
      return;
    }

    const scriptId = rn.node.config.scriptId;
    const activePlan =
      call.livePlan ??
      (scriptId && isHandlerScript(scriptId) ? input.callPlans?.[scriptId] : undefined);
    if (
      !isLiveCodeMode &&
      activePlan &&
      activePlan.throwProbability > 0 &&
      rn.errorRng.chance(activePlan.throwProbability)
    ) {
      emitLog(
        'error',
        'user',
        `Uncaught handler exception on ${rn.node.label}`,
        rn.node.id,
        call.traceId || undefined,
        { requestId: call.rootRequestId },
      );
      settleCallAndReleaseResources(call, false, 'user_code');
      return;
    }

    // Probabilistic service error injection (supports scenario & operation error overrides)
    const errSpec = getEffectiveErrorOutcome(rn, call.opName);
    if (errSpec.errorRate > 0 && rn.errorRng.chance(errSpec.errorRate)) {
      if (call.span && errSpec.opErrorTag) {
        call.span.attrs = { ...(call.span.attrs ?? {}), opErrorKind: errSpec.opErrorTag };
      }
      settleCallAndReleaseResources(call, false, errSpec.errorKind);
      return;
    }

    if (rn.kind === 'cache' || rn.kind === 'cdn') {
      let effectiveHitRatio = rn.node.config.cacheHitRatio ?? (rn.kind === 'cdn' ? 0.9 : 0.85);
      if (rn.cacheFlushStartMs !== null) {
        const elapsed = now - rn.cacheFlushStartMs;
        if (elapsed >= rn.cacheFlushWarmupMs || rn.cacheFlushWarmupMs <= 0) {
          rn.cacheFlushStartMs = null;
        } else {
          effectiveHitRatio *= Math.max(0, elapsed / rn.cacheFlushWarmupMs);
        }
      }
      const isHit = rn.routingRng.chance(effectiveHitRatio);
      if (isHit || rn.outgoingSync.length === 0) {
        settleCallAndReleaseResources(call, true);
        return;
      }
      // Cache miss -> call origin downstream
      const completeAfterDownstream = (res: CallOutcome) => {
        if (call.postCpuMs > 0 && rn.station.coresCapacity > 0 && !call.settledWithCaller) {
          call.pendingPostOutcome = res;
          const postRes = acquireCoreOrQueue(
            rn.station,
            { call, stage: 'post' },
            call.postCpuMs,
            now,
          );
          if (postRes.acquired) {
            call.holdingCore = true;
            schedule(now + postRes.effectiveCpuMs, { kind: 'END_CPU', call, stage: 'post' });
          }
          return;
        }
        settleCallAndReleaseResources(call, res.ok, res.errorKind);
      };

      dispatchDownstreamFromNode(call, completeAfterDownstream);
      return;
    }

    if (
      (rn.outgoingAll.length > 0 || Boolean(activePlan)) &&
      rn.kind !== 'sql' &&
      rn.kind !== 'doc' &&
      rn.kind !== 'kv'
    ) {
      dispatchDownstreamFromNode(call, (res) => {
        if (call.postCpuMs > 0 && rn.station.coresCapacity > 0 && !call.settledWithCaller) {
          call.pendingPostOutcome = res;
          const postRes = acquireCoreOrQueue(
            rn.station,
            { call, stage: 'post' },
            call.postCpuMs,
            now,
          );
          if (postRes.acquired) {
            call.holdingCore = true;
            schedule(now + postRes.effectiveCpuMs, { kind: 'END_CPU', call, stage: 'post' });
          }
          return;
        }
        settleCallAndReleaseResources(call, res.ok, res.errorKind);
      });
      return;
    }

    settleCallAndReleaseResources(call, true);
  };

  const triggerQueueWorkers = (rn: RuntimeNode) => {
    const conc = Math.max(1, rn.node.config.consumer?.concurrency ?? 10);
    const batchSize = Math.max(1, rn.node.config.consumer?.batchSize ?? 1);
    while (
      rn.asyncWorkersBusy < conc &&
      rn.asyncBacklog.length > 0 &&
      rn.station.instancesActive > 0
    ) {
      const batch: QueuedAsyncMsg[] = [];
      while (batch.length < batchSize && rn.asyncBacklog.length > 0) {
        batch.push(rn.asyncBacklog.shift()!);
      }
      if (batch.length === 0) {
        break;
      }

      if (rn.outgoingAll.length === 0) {
        // No downstream consumers attached; drain at consumer capacity latency without polluting producer completions
        rn.asyncWorkersBusy += 1;
        const procMs = sampleNodeServiceLatency(rn);
        schedule(now + procMs, { kind: 'ASYNC_DRAIN_DONE', node: rn });
        continue;
      }

      const edge = pickSyncEdgeWeighted(rn, rn.outgoingAll)!;
      rn.asyncWorkersBusy += 1;
      const batchBytes = batch.reduce((acc, item) => acc + item.payloadBytes, 0);
      const leadMsg = batch[0]!;

      invokeEdgeWithPolicy(
        null,
        edge,
        now + (rn.node.config.timeoutMs ?? 30_000),
        batchBytes,
        (outcome) => {
          rn.asyncWorkersBusy = Math.max(0, rn.asyncWorkersBusy - 1);
          if (!outcome.ok) {
            for (const msg of batch) {
              if (msg.retriesLeft > 0) {
                rn.asyncBacklog.push({ ...msg, retriesLeft: msg.retriesLeft - 1 });
              } else if (!rn.node.config.consumer?.dlq) {
                emitLog(
                  'warn',
                  'platform',
                  `Consumer failed without DLQ on ${rn.node.id}: ${outcome.errorKind ?? 'server'}`,
                  rn.node.id,
                  msg.traceId || undefined,
                );
              }
            }
          }
          triggerQueueWorkers(rn);
        },
        undefined,
      );
      void leadMsg;
    }
  };

  function startServiceAtNode(call: CallCtx) {
    const rn = call.node;
    call.slotAcquired = true;
    call.serviceStartMs = now;
    const isDbWrite =
      (rn.kind === 'sql' || rn.kind === 'doc' || rn.kind === 'graph') &&
      rn.capacities.connectionsMax !== null
        ? rn.routingRng.chance(1 - (rn.node.config.readRatio ?? 0.8))
        : false;
    const resolvedOp = resolveNodeOperation(rn, call.opName, isDbWrite);
    if (resolvedOp.name) {
      call.opName = resolvedOp.name;
    }
    if (resolvedOp.override?.responseSizeBytes !== undefined) {
      call.bytesOut = resolvedOp.override.responseSizeBytes;
    } else if (resolvedOp.defOp?.defaultResponse.sizeBytes !== undefined) {
      call.bytesOut = resolvedOp.defOp.defaultResponse.sizeBytes;
    }
    if (call.span) {
      call.span.waitMs = Number(Math.max(0, now - call.arrivalMs).toFixed(2));
      if (resolvedOp.name) {
        call.span.operation = resolvedOp.name;
      }
    }
    if (call.cancelOnTimeout && call.callerTimedOut) {
      settleCallAndReleaseResources(call, false, 'timeout');
      return;
    }

    // Async queue / topic / stream / bus: enqueue message and immediately ack producer
    if (rn.kind === 'queue' || rn.kind === 'topic' || rn.kind === 'stream' || rn.kind === 'bus') {
      const ackMs = sampleNodeServiceLatency(rn, false, call.opName);
      if (
        rn.asyncBacklog.length >= rn.capacities.queueMaxLength &&
        rn.capacities.queueMaxLength > 0
      ) {
        settleCallAndReleaseResources(call, false, 'dropped_queue_full');
        return;
      }
      rn.asyncBacklog.push({
        enqueuedAtMs: now,
        retriesLeft: rn.node.config.consumer?.maxRetries ?? 3,
        payloadBytes: call.payloadBytes,
        traceId: call.traceId,
        parentTraceSpans: call.parentTraceSpans,
      });
      triggerQueueWorkers(rn);
      schedule(now + ackMs, { kind: 'COMPLETE_CALL', call });
      return;
    }

    // Database pool acquisition (`sql`, `doc`, `graph`, etc.)
    if (
      (rn.kind === 'sql' || rn.kind === 'doc' || rn.kind === 'graph') &&
      rn.capacities.connectionsMax !== null
    ) {
      const isWrite = isDbWrite;

      if (rn.station.busyConnections < rn.capacities.connectionsMax) {
        advanceStationIntegrals(rn.station, now);
        rn.station.busyConnections += 1;
        call.dbConnectionHeld = true;
        const queryMs = sampleNodeServiceLatency(rn, isWrite, call.opName);
        if (isWrite) rn.totalWriteUnits += 1;
        else rn.totalReadUnits += 1;
        schedule(now + queryMs, { kind: 'COMPLETE_CALL', call });
        return;
      }

      const waiter = { call, enqueuedAtMs: now, expired: false };
      rn.dbWaitQueue.push(waiter);
      schedule(now + rn.capacities.connectionWaitMs, { kind: 'CONN_WAIT_TIMEOUT', call });
      return;
    }

    // Serverless or scale-to-zero ML cold-start overhead if no warm container available
    let coldExtraMs = 0;
    const coldCfg = rn.kind === 'fn' || rn.kind === 'ml' ? rn.resolvedColdStart : undefined;
    if ((rn.kind === 'fn' || rn.kind === 'ml') && coldCfg?.enabled) {
      while (rn.warmExpiryMs.length > 0 && rn.warmExpiryMs[0]! <= now) {
        rn.warmExpiryMs.shift();
      }
      let isCold = false;
      if (coldCfg.probabilityModel === 'fixed') {
        isCold = rn.warmExpiryMs.length === 0 || rn.latencyRng.chance(0.05);
      } else if (rn.warmExpiryMs.length > 0) {
        rn.warmExpiryMs.pop();
      } else {
        isCold = true;
      }
      if (isCold) {
        call.coldStarted = true;
        if (call.span) {
          call.span.attrs = {
            ...(call.span.attrs ?? {}),
            coldStart: 1,
          };
        }
        coldExtraMs = sampleLatency(
          {
            distribution: 'lognormal',
            p50: coldCfg.p50,
            p95: coldCfg.p95,
          },
          rn.latencyRng,
        );
      }
    }

    // Compute two-constraint lifecycle (cores for CPU segments + slots held over downstream I/O)
    if (rn.kind === 'compute' || rn.kind === 'fn') {
      const scriptId = rn.node.config.scriptId;
      if (isLiveCodeMode && scriptId && isHandlerScript(scriptId)) {
        pendingLiveStarts.push({ call, coldExtraMs });
        return;
      }
      resumeComputeAfterLiveCode(call, coldExtraMs);
      return;
    }

    // AI / LLM token-profiled timing & two-span streaming
    if (rn.kind === 'llm' && call.aiExec) {
      const totalAiMs = clampLatencyMs(
        call.aiExec.ttftMs + call.aiExec.decodeMs + rn.chaosExtraLatencyMs,
      );
      schedule(now + totalAiMs, { kind: 'END_LOCAL_WAIT', call });
      return;
    }

    // Cache / CDN / GW / LB / KV / DNS / Net / other AI local overhead
    let serviceMs = sampleNodeServiceLatency(rn, false, call.opName) + coldExtraMs;
    if (rn.kind === 'ml') {
      serviceMs += (call.payloadBytes / (10 * 1024 * 1024)) * 1000;
    } else if (rn.kind === 'vision') {
      const imageMb = Math.max(0.1, call.payloadBytes / (1024 * 1024));
      serviceMs += 40 * imageMb;
    } else if (rn.kind === 'doc-ai') {
      serviceMs += 400;
    } else if (rn.kind === 'text-ai') {
      serviceMs += 0.02 * Math.max(64, call.payloadBytes);
    } else if (rn.kind === 'speech' && call.opName !== 'Start' && call.opName !== 'GetStatus') {
      serviceMs = Math.max(serviceMs, 0.3 * 5 * 1000);
    } else if (rn.kind === 'async' && call.opName !== 'Start' && call.opName !== 'GetStatus') {
      serviceMs = Math.max(serviceMs, 25);
    }
    schedule(now + clampLatencyMs(serviceMs), { kind: 'END_LOCAL_WAIT', call });
  }

  function resumeComputeAfterLiveCode(call: CallCtx, coldExtraMs: number) {
    const rn = call.node;
    const scriptId = rn.node.config.scriptId;
    if (scriptId && isHandlerScript(scriptId)) {
      replayProfileUserLogs(call, scriptId);
    }

    const activePlan =
      call.livePlan ??
      (scriptId && isHandlerScript(scriptId) ? input.callPlans?.[scriptId] : undefined);
    const cpuMs =
      rn.node.config.cpuMsPerRequest ??
      call.liveCpuMs ??
      (activePlan ? sampleLatency(activePlan.cpuMs, rn.latencyRng) : 4);
    const localServiceSampleMs = activePlan
      ? cpuMs + rn.chaosExtraLatencyMs
      : sampleNodeServiceLatency(rn, false, call.opName);
    const preCpuMs = cpuMs > 0 ? Math.max(0.01, cpuMs * (rn.outgoingSync.length > 0 ? 0.7 : 1)) : 0;
    const postCpuMs = cpuMs > 0 && rn.outgoingSync.length > 0 ? Math.max(0.01, cpuMs * 0.3) : 0;
    call.postCpuMs = postCpuMs;

    // Any local simulated think/processing time above CPU work holds the concurrency slot cleanly
    call.localWaitRemainingMs =
      Math.max(0, localServiceSampleMs - (preCpuMs + postCpuMs)) + coldExtraMs;

    if (preCpuMs > 0 && rn.station.coresCapacity > 0) {
      const res = acquireCoreOrQueue(rn.station, { call, stage: 'local' }, preCpuMs, now);
      if (res.acquired) {
        call.holdingCore = true;
        schedule(now + res.effectiveCpuMs, { kind: 'END_CPU', call, stage: 'local' });
      }
      return;
    }

    if (call.localWaitRemainingMs > 0) {
      schedule(now + call.localWaitRemainingMs, { kind: 'END_LOCAL_WAIT', call });
    } else {
      finishNodeAfterLocalWork(call);
    }
  }

  const pickFixtureEventForNode = (call: CallCtx): unknown => {
    const candidates = design.fixtures ?? [];
    if (candidates.length > 0) {
      let total = 0;
      for (const f of candidates) total += Math.max(0, f.weight ?? 1);
      if (total <= 0) {
        return candidates[Math.floor(call.node.routingRng.next() * candidates.length)]!.event;
      }
      let cursor = call.node.routingRng.next() * total;
      for (const f of candidates) {
        cursor -= Math.max(0, f.weight ?? 1);
        if (cursor <= 0) return f.event;
      }
      return candidates[candidates.length - 1]!.event;
    }
    return {
      httpMethod: call.opName?.split(' ')[0] ?? 'POST',
      path: call.opName?.split(' ')[1] ?? '/',
      headers: { 'x-request-id': call.rootRequestId },
      requestContext: { requestId: call.rootRequestId },
      body: '{}',
    };
  };

  const processLiveInvocation = async (item: { call: CallCtx; coldExtraMs: number }) => {
    const { call, coldExtraMs } = item;
    const rn = call.node;
    const scriptId = rn.node.config.scriptId;
    if (!scriptId || !input.liveCodeExecutor) {
      resumeComputeAfterLiveCode(call, coldExtraMs);
      return;
    }

    const event = pickFixtureEventForNode(call);
    const out = await input.liveCodeExecutor({
      scriptId,
      node: rn.node,
      design,
      seed,
      seq: call.id,
      event,
      coldStart: call.coldStarted,
      emitPlatformLogs: call.sampledForPlatformSuccessLog,
      requestId: call.rootRequestId,
      ...(call.traceId ? { traceId: call.traceId } : {}),
    });

    for (const entry of out.logs) {
      if (
        entry.source === 'platform' &&
        !call.sampledForPlatformSuccessLog &&
        entry.level === 'info'
      ) {
        continue;
      }
      emitLog(entry.level, entry.source, entry.message, rn.node.id, call.traceId || undefined, {
        requestId: call.rootRequestId,
        ...(entry.data !== undefined ? { data: entry.data } : {}),
        ...(entry.site ? { site: entry.site } : {}),
        tVirtualMs: Number(Math.max(now, now + entry.tVirtualMs).toFixed(2)),
      });
    }

    const scaledCpuMs = Number(Math.max(0.2, out.cpuMs * cpuScale).toFixed(3));
    call.liveCpuMs = scaledCpuMs;

    const svcCounts = new Map<string, number>();
    for (const e of rn.outgoingAll) {
      svcCounts.set(e.toNode.node.serviceId, (svcCounts.get(e.toNode.node.serviceId) ?? 0) + 1);
    }
    const steps: PlanStep[] = out.calls.map((c) => {
      if (c.tokens && c.targetNodeId) {
        const tgt = runtimeNodes.get(c.targetNodeId);
        if (tgt) {
          tgt.totalTokensIn += c.tokens.in;
          tgt.totalTokensOut += c.tokens.out;
        }
      }
      const sameCount = svcCounts.get(c.serviceId) ?? 0;
      const pinAlias = c.alias ?? (sameCount > 1 && c.targetNodeId ? c.targetNodeId : undefined);
      return {
        kind: 'call',
        serviceId: c.serviceId,
        op: c.op,
        count: 1,
        ...(c.payloadBytes > 0 ? { payloadBytes: c.payloadBytes } : {}),
        ...(c.parallelGroup ? { parallelGroup: c.parallelGroup } : {}),
        ...(pinAlias ? { alias: pinAlias } : {}),
      };
    });

    call.livePlan = {
      scriptId,
      cpuMs: { distribution: 'fixed', p50: scaledCpuMs, p95: scaledCpuMs },
      throwProbability: 0,
      steps,
    };
    call.liveUserFailed = !out.ok;
    resumeComputeAfterLiveCode(call, coldExtraMs);
  };

  const handleNodeArrive = (call: CallCtx) => {
    const rn = call.node;
    if (call.cancelOnTimeout && call.callerTimedOut) {
      return;
    }

    rn.totalArrivals += 1;
    rn.bucketArrivals += 1;
    rn.frameArrivals += 1;
    rn.totalBytesIn += call.payloadBytes;

    // Rate limiter / chaos throttle / time-boxed scenario throttle check
    if (rn.chaosRateBucket && !tryConsumeToken(rn.chaosRateBucket, now, 1)) {
      recordNodeOutcome(call, false, 'throttled');
      call.settledWithCaller = true;
      call.onFinish?.({ ok: false, errorKind: 'throttled', bytesOut: 0 });
      return;
    }
    const activeScenarioOv = rn.hasScenarioOverrides
      ? getEffectiveScenarioOverride(rn.node, scenario.id, now / 1000)
      : undefined;
    if (activeScenarioOv?.rateLimitRps !== undefined) {
      const key = `${activeScenarioOv.scenarioId ?? '*'}:${activeScenarioOv.fromS}:${activeScenarioOv.toS}:${activeScenarioOv.rateLimitRps}`;
      if (rn.scenarioRateBucket?.key !== key) {
        const rpsScaled = Math.max(0.01, activeScenarioOv.rateLimitRps / scaleFactor);
        rn.scenarioRateBucket = {
          key,
          bucket: createTokenBucket(rpsScaled, Math.max(1, rpsScaled), now),
        };
      }
      if (!tryConsumeToken(rn.scenarioRateBucket.bucket, now, 1)) {
        recordNodeOutcome(call, false, 'throttled');
        call.settledWithCaller = true;
        call.onFinish?.({ ok: false, errorKind: 'throttled', bytesOut: 0 });
        return;
      }
    } else {
      rn.scenarioRateBucket = null;
    }
    if (rn.station.rateBucket && !tryConsumeToken(rn.station.rateBucket, now, 1)) {
      recordNodeOutcome(call, false, 'throttled');
      call.settledWithCaller = true;
      call.onFinish?.({ ok: false, errorKind: 'throttled', bytesOut: 0 });
      return;
    }

    // AI RPM / TPM / context-window quotas & LLM timing pre-calculation
    if (rn.aiRpmBucket && !tryConsumeToken(rn.aiRpmBucket, now, 1)) {
      recordNodeOutcome(call, false, 'throttled');
      call.settledWithCaller = true;
      call.onFinish?.({ ok: false, errorKind: 'throttled', bytesOut: 0 });
      return;
    }
    if (rn.kind === 'llm' || rn.aiTpmBucket) {
      const isEmbed =
        call.opName === 'Embed' ||
        rn.node.serviceId === 'oci.genai_embed' ||
        rn.node.config.ai?.profile === 'embedding';
      const profKey = isEmbed ? 'embedding' : (rn.node.config.ai?.profile ?? 'balanced');
      const prof = AI_SIM_PROFILES[profKey] ?? AI_SIM_PROFILES.balanced;
      const tokensIn = Math.max(1, Math.ceil(call.payloadBytes / 4));
      let tokensOut = 0;
      let thinkingToks = 0;
      if (!isEmbed) {
        const outModel = rn.node.config.ai?.outputTokens ?? {
          distribution: 'lognormal',
          p50: 180,
          p95: 420,
        };
        tokensOut = Math.max(1, Math.round(sampleLatency(outModel, rn.latencyRng)));
        const maxOutCap = rn.node.config.rateLimit?.maxOutputTokens;
        if (maxOutCap !== undefined && maxOutCap > 0) {
          tokensOut = Math.min(tokensOut, maxOutCap);
        }
        if (profKey === 'reasoning') {
          thinkingToks = Math.max(
            32,
            Math.round(
              sampleLatency({ distribution: 'lognormal', p50: 400, p95: 1400 }, rn.latencyRng),
            ),
          );
        }
      }

      const maxContext = rn.node.config.rateLimit?.maxContextTokens ?? prof.contextWindow;
      const reserveOut = isEmbed ? 0 : (rn.node.config.rateLimit?.maxOutputTokens ?? tokensOut);
      if (tokensIn + reserveOut > maxContext) {
        if (call.span) {
          call.span.attrs = { ...(call.span.attrs ?? {}), errorCode: 'context_length_exceeded' };
        }
        recordNodeOutcome(call, false, 'server');
        call.settledWithCaller = true;
        call.onFinish?.({ ok: false, errorKind: 'server', bytesOut: 0 });
        return;
      }

      const countUpfront = Boolean(
        rn.node.config.rateLimit?.countMaxTokensUpfront ?? rn.node.config.ai?.countMaxTokensUpfront,
      );
      const tpmNeeded =
        (countUpfront ? tokensIn + reserveOut : tokensIn + tokensOut + thinkingToks) / scaleFactor;
      if (rn.aiTpmBucket && !tryConsumeToken(rn.aiTpmBucket, now, Math.max(1, tpmNeeded))) {
        recordNodeOutcome(call, false, 'throttled');
        call.settledWithCaller = true;
        call.onFinish?.({ ok: false, errorKind: 'throttled', bytesOut: 0 });
        return;
      }

      if (rn.kind === 'llm') {
        const customLat = rn.node.config.ai?.profile ? undefined : rn.node.config.latency;
        const ttftModel = customLat ?? {
          distribution: 'lognormal' as const,
          p50: prof.ttftP50,
          p95: prof.ttftP95,
        };
        let ttftMs = sampleLatency(ttftModel, rn.latencyRng) + tokensIn * prof.prefillMsPerToken;
        let effectiveTps = prof.tokensPerSec > 0 ? prof.tokensPerSec : 70;
        if (rn.node.config.ai?.capacityMode === 'provisioned') {
          const units = Math.max(1, rn.node.config.ai.provisionedUnits ?? 1);
          const tpsPerUnit = Math.max(1, rn.node.config.ai.tokensPerSecPerUnit ?? effectiveTps);
          const activeStreams = rn.station.inFlight + 1;
          effectiveTps = activeStreams > units ? (units * tpsPerUnit) / activeStreams : tpsPerUnit;
        } else {
          const slowdownProb = Math.max(0, Math.min(1, rn.node.config.ai?.slowdownProb ?? 0.02));
          if (slowdownProb > 0 && rn.latencyRng.chance(slowdownProb)) {
            const mult = 2 + rn.latencyRng.next() * 2;
            ttftMs *= mult;
            effectiveTps /= mult;
          }
        }
        const decodeMs = isEmbed
          ? 0.5
          : ((tokensOut + thinkingToks) / Math.max(1, effectiveTps)) * 1000;
        call.aiExec = {
          ttftMs,
          decodeMs,
          tokensIn,
          tokensOut: tokensOut + thinkingToks,
          isStream: call.opName === 'InvokeStream',
        };
      }
    }

    const slotRes = tryAcquireOrEnqueueSlot(rn.station, call, now);
    if (slotRes.status === 'down') {
      recordNodeOutcome(call, false, 'server');
      call.settledWithCaller = true;
      call.onFinish?.({ ok: false, errorKind: 'server', bytesOut: 0 });
      return;
    }
    if (slotRes.status === 'rejected') {
      const errKind: ErrorKind =
        rn.kind === 'fn' && rn.capacities.fnOnLimit === 'throttle'
          ? 'throttled'
          : 'dropped_queue_full';
      recordNodeOutcome(call, false, errKind);
      call.settledWithCaller = true;
      call.onFinish?.({ ok: false, errorKind: errKind, bytesOut: 0 });
      return;
    }
    if (slotRes.status === 'queued') {
      if (slotRes.evicted) {
        const evicted = slotRes.evicted.req;
        recordNodeOutcome(evicted, false, 'dropped_queue_full');
        if (!evicted.settledWithCaller && evicted.onFinish) {
          evicted.settledWithCaller = true;
          evicted.onFinish({ ok: false, errorKind: 'dropped_queue_full', bytesOut: 0 });
        }
      }
      return;
    }

    startServiceAtNode(call);
  };

  // --- Frame & 1-second bucket flushers ---

  const flushBucket = (secondIdx: number) => {
    const bucketEndMs = secondIdx * 1000;
    const bucketStartMs = Math.max(0, bucketEndMs - 1000);
    const windowMs = Math.max(1, bucketEndMs - bucketStartMs);

    const perNodeBucket: TimeSeriesBucket['perNode'] = {};
    for (const rn of orderedNodes) {
      advanceStationIntegrals(rn.station, bucketEndMs);
      rn.totalBucketedSlotAreaMs += rn.station.slotBusyAreaMs;
      rn.totalBucketedCoreAreaMs += rn.station.coreBusyAreaMs;
      rn.totalBucketedConnAreaMs += rn.station.connBusyAreaMs;
      rn.totalBucketedSlotCapAreaMs += rn.station.slotCapAreaMs;
      rn.totalBucketedCoreCapAreaMs += rn.station.coreCapAreaMs;
      const integrals = consumeStationWindowIntegrals(rn.station, bucketEndMs, windowMs);
      const rawUtil = Math.max(integrals.slotUtil, integrals.cpuUtil, integrals.connUtil);
      const activeWaiters = rn.dbWaitQueue.reduce((acc, w) => (w.expired ? acc : acc + 1), 0);
      const { health, smoothedUtil } = evaluateNodeHealthStep(rn.healthTracker, {
        rawUtil,
        instancesActive: rn.station.instancesActive,
        dropsCount: rn.bucketDrops,
        throttledCount: rn.bucketThrottled,
        arrivalsCount: rn.bucketArrivals,
        endQueueDepth:
          rn.station.slotQueue.length +
          rn.station.coreQueue.length +
          rn.asyncBacklog.length +
          activeWaiters,
      });

      rn.lastHealth = health;
      rn.lastSmoothedUtil = smoothedUtil;
      rn.lastCpuUtil = integrals.cpuUtil;
      rn.sumUtil += smoothedUtil;
      rn.sumCpuUtil += integrals.cpuUtil;
      rn.peakUtil = Math.max(rn.peakUtil, smoothedUtil);
      const qDepth = rn.station.slotQueue.length + rn.asyncBacklog.length;
      rn.peakQueueDepth = Math.max(rn.peakQueueDepth, qDepth);
      rn.totalInstanceSeconds += rn.station.instancesActive * (windowMs / 1000);

      const pct = rn.bucketHist.percentiles();
      rn.lastBucketArrivals = rn.bucketArrivals;
      rn.lastBucketP95Ms = pct.p95;
      perNodeBucket[rn.node.id] = {
        rpsIn: rn.bucketArrivals * scaleFactor,
        rpsOut: rn.bucketCompletions * scaleFactor,
        errors: rn.bucketErrorCount * scaleFactor,
        drops: rn.bucketDrops * scaleFactor,
        utilization: Number(smoothedUtil.toFixed(4)),
        cpuUtilization: Number(integrals.cpuUtil.toFixed(4)),
        queueDepth: qDepth * scaleFactor,
        inFlight: rn.station.inFlight * scaleFactor,
        instancesActive: rn.station.instancesActive,
        p50: pct.p50,
        p95: pct.p95,
        p99: pct.p99,
      };

      rn.bucketArrivals = 0;
      rn.bucketCompletions = 0;
      rn.bucketErrorCount = 0;
      rn.bucketDrops = 0;
      rn.bucketThrottled = 0;
      rn.bucketErrors = {};
      rn.bucketHist.clear();
    }

    const rootPct = bucketRootHist.percentiles();
    const totalReqSec = bucketRootArrivals;
    buckets.push({
      tS: secondIdx,
      rpsIn: bucketRootArrivals * scaleFactor,
      throughputRps: bucketRootSuccess * scaleFactor,
      errorRate: totalReqSec > 0 ? bucketRootErrorCount / totalReqSec : 0,
      p50: rootPct.p50,
      p95: rootPct.p95,
      p99: rootPct.p99,
      perNode: perNodeBucket,
    });

    bucketRootArrivals = 0;
    bucketRootSuccess = 0;
    bucketRootErrorCount = 0;
    bucketRootHist.clear();
  };

  const emitSimFrame = () => {
    const dtSec = Math.max(0.025, frameIntervalMs / 1000);
    const nodeFrames: Record<string, NodeFrame> = {};
    for (const rn of orderedNodes) {
      advanceStationIntegrals(rn.station, now);

      const totalSlotNow = rn.totalBucketedSlotAreaMs + rn.station.slotBusyAreaMs;
      const totalCoreNow = rn.totalBucketedCoreAreaMs + rn.station.coreBusyAreaMs;
      const totalConnNow = rn.totalBucketedConnAreaMs + rn.station.connBusyAreaMs;
      const totalSlotCapNow = rn.totalBucketedSlotCapAreaMs + rn.station.slotCapAreaMs;
      const totalCoreCapNow = rn.totalBucketedCoreCapAreaMs + rn.station.coreCapAreaMs;

      const frameDtMs = now - rn.lastFrameCheckMs;
      let frameSlotUtil = rn.lastFrameUtil;
      let frameCpuUtil = rn.lastFrameCpuUtil;
      let frameConnUtil = 0;

      if (frameDtMs >= 1) {
        const dSlot = Math.max(0, totalSlotNow - rn.prevFrameCumSlotAreaMs);
        const dCore = Math.max(0, totalCoreNow - rn.prevFrameCumCoreAreaMs);
        const dConn = Math.max(0, totalConnNow - rn.prevFrameCumConnAreaMs);
        const dSlotCap = Math.max(0, totalSlotCapNow - rn.prevFrameCumSlotCapAreaMs);
        const dCoreCap = Math.max(0, totalCoreCapNow - rn.prevFrameCumCoreCapAreaMs);

        frameSlotUtil = dSlotCap > 0 && rn.station.instancesActive > 0 ? dSlot / dSlotCap : 0;
        frameCpuUtil = dCoreCap > 0 && rn.station.instancesActive > 0 ? dCore / dCoreCap : 0;
        frameConnUtil =
          rn.station.connectionsMax &&
          rn.station.connectionsMax > 0 &&
          rn.station.instancesActive > 0
            ? dConn / (frameDtMs * rn.station.connectionsMax)
            : 0;

        rn.lastFrameCheckMs = now;
        rn.prevFrameCumSlotAreaMs = totalSlotNow;
        rn.prevFrameCumCoreAreaMs = totalCoreNow;
        rn.prevFrameCumConnAreaMs = totalConnNow;
        rn.prevFrameCumSlotCapAreaMs = totalSlotCapNow;
        rn.prevFrameCumCoreCapAreaMs = totalCoreCapNow;
      }

      const frameRawUtil = Math.min(1, Math.max(frameSlotUtil, frameCpuUtil, frameConnUtil));
      const frameCpuClamped = Math.min(1, frameCpuUtil);
      rn.lastFrameUtil = frameRawUtil;
      rn.lastFrameCpuUtil = frameCpuClamped;

      const liveUtil =
        rn.station.instancesActive <= 0
          ? 0
          : rn.healthTracker.initialized
            ? 0.5 * rn.lastSmoothedUtil + 0.5 * frameRawUtil
            : frameRawUtil;
      const liveCpuUtil =
        rn.station.instancesActive <= 0
          ? 0
          : rn.healthTracker.initialized
            ? 0.5 * rn.lastCpuUtil + 0.5 * frameCpuClamped
            : frameCpuClamped;

      const errPerSec: Partial<Record<ErrorKind, number>> = {};
      for (const [k, cnt] of Object.entries(rn.frameErrors)) {
        if (cnt) errPerSec[k as ErrorKind] = Number(((cnt * scaleFactor) / dtSec).toFixed(2));
      }

      const pct =
        rn.frameHist.totalCount > 0 ? rn.frameHist.percentiles() : rn.totalHist.percentiles();

      nodeFrames[rn.node.id] = {
        utilization: Number(liveUtil.toFixed(4)),
        cpuUtilization: Number(liveCpuUtil.toFixed(4)),
        inFlight: rn.station.inFlight * scaleFactor,
        queueDepth: (rn.station.slotQueue.length + rn.asyncBacklog.length) * scaleFactor,
        rpsIn: Number(((rn.frameArrivals * scaleFactor) / dtSec).toFixed(1)),
        rpsOut: Number(((rn.frameCompletions * scaleFactor) / dtSec).toFixed(1)),
        errorsPerSec: errPerSec,
        dropsPerSec: Number(((rn.frameDrops * scaleFactor) / dtSec).toFixed(2)),
        latency: pct,
        instancesActive: rn.station.instancesActive,
        instancesTotal: rn.station.instancesTotal,
        health:
          rn.station.instancesActive <= 0
            ? 'down'
            : rn.lastHealth === 'overloaded' || rn.frameDrops > 0
              ? 'overloaded'
              : rn.lastHealth,
      };

      rn.frameArrivals = 0;
      rn.frameCompletions = 0;
      rn.frameDrops = 0;
      rn.frameErrors = {};
      rn.frameHist.clear();
    }

    const edgeFrames: Record<string, EdgeFrame> = {};
    const particles: Particle[] = [];
    for (const re of orderedEdges) {
      const rps = Number(((re.winCount * scaleFactor) / dtSec).toFixed(1));
      const errorRate = re.winCount > 0 ? re.winErrors / re.winCount : 0;
      const avgLatencyMs =
        re.winCount > 0 ? Number((re.winLatencySum / re.winCount).toFixed(2)) : 0;
      edgeFrames[re.edge.id] = { rps, errorRate, avgLatencyMs };

      if (re.winCount > 0 && particles.length < 300) {
        particles.push({
          id: `p-${re.edge.id}`,
          edgeId: re.edge.id,
          progress: 0.5,
          status: errorRate > 0.05 ? 'error' : avgLatencyMs > 250 ? 'slow' : 'ok',
          traceId: '',
        });
      }

      re.winCount = 0;
      re.winErrors = 0;
      re.winLatencySum = 0;
    }

    const logsOut = pendingLogs.splice(0, pendingLogs.length);
    onFrame({
      runId,
      tVirtualMs: Number(now.toFixed(1)),
      nodes: nodeFrames,
      edges: edgeFrames,
      particles,
      newLogs: logsOut,
    });
  };

  // --- Main DES Loop ---

  const handleCallTimeout = (token: AttemptToken) => {
    if (token.settled) {
      return;
    }
    token.settled = true;
    if (token.inTimeoutHeap) {
      activeTimeoutCount = Math.max(0, activeTimeoutCount - 1);
    }
    if (token.targetCall) {
      token.targetCall.callerTimedOut = true;
      token.targetCall.settledWithCaller = true;
      if (token.targetCall.span) {
        token.targetCall.span.attrs = {
          ...(token.targetCall.span.attrs ?? {}),
          timedOut: 1,
        };
        token.targetCall.span.status = 'timeout';
      }
    }
    token.attempt.edgeState.winCount += 1;
    token.attempt.edgeState.winErrors += 1;
    token.attempt.edgeState.winLatencySum += now - token.attempt.startMs;

    emitLog(
      'error',
      'platform',
      `Timeout calling ${token.attempt.targetNode.node.label} after ${Math.round(now - token.attempt.startMs)} ms`,
      token.attempt.targetNode.node.id,
      token.attempt.callerCall?.traceId || undefined,
      { requestId: token.attempt.callerCall?.rootRequestId },
    );

    if (token.attempt.edgeState.circuitBreaker) {
      recordCircuitBreakerOutcome(token.attempt.edgeState.circuitBreaker, false, now);
    }

    const retryCfg = token.attempt;
    const canRetry =
      retryCfg.attemptIndex < retryCfg.maxRetries && now < retryCfg.overallDeadlineMs - 5;
    if (canRetry) {
      const expDelay = retryCfg.backoffMs * Math.pow(2, retryCfg.attemptIndex);
      const delayMs = retryCfg.jitter
        ? expDelay * Math.max(0.1, retryCfg.edgeState.rng.next())
        : expDelay;
      if (now + delayMs < retryCfg.overallDeadlineMs) {
        emitLog(
          'warn',
          'platform',
          `Retrying ${retryCfg.targetNode.node.label} after timeout (attempt ${retryCfg.attemptIndex + 2}/${retryCfg.maxRetries + 1})`,
          retryCfg.targetNode.node.id,
          retryCfg.callerCall?.traceId || undefined,
          { requestId: retryCfg.callerCall?.rootRequestId },
        );
        schedule(now + delayMs, {
          kind: 'RETRY_ATTEMPT',
          attemptState: {
            ...retryCfg,
            attemptIndex: retryCfg.attemptIndex + 1,
            startMs: now + delayMs,
          },
        });
        return;
      }
    }
    retryCfg.onSettled({ ok: false, errorKind: 'timeout', bytesOut: 0 });
  };

  if (signal?.aborted) {
    throw new SimulationAbortedError();
  }

  while (!heap.isEmpty() || !timeoutHeap.isEmpty() || pendingLiveStarts.length > 0) {
    while (pendingLiveStarts.length > 0) {
      if (signal?.aborted) {
        throw new SimulationAbortedError();
      }
      const nextLive = pendingLiveStarts.shift()!;
      await processLiveInvocation(nextLive);
    }

    pruneSettledTimeouts();
    const topTimeout = timeoutHeap.peek();
    const topHeap = heap.peek();
    if (!topHeap && !topTimeout) {
      break;
    }
    if (processedEvents >= maxEvents) {
      break;
    }

    if (topTimeout && (!topHeap || topTimeout.deadlineMs < topHeap.t)) {
      if (topTimeout.deadlineMs >= endMs) {
        timeoutHeap.pop();
        continue;
      }
      now = topTimeout.deadlineMs;
      processedEvents += 1;
      timeoutHeap.pop();
      handleCallTimeout(topTimeout.token);
      continue;
    }

    const ev = heap.pop()!;
    if (ev.t >= endMs) {
      break;
    }
    now = ev.t;
    processedEvents += 1;

    if ((processedEvents & 1023) === 0) {
      if (signal?.aborted) {
        throw new SimulationAbortedError();
      }
      if ((processedEvents & 8191) === 0) {
        const wall = nowWallMs();
        if (wall - lastYieldWall > 8) {
          await cooperativeYield();
          if (signal?.aborted) {
            throw new SimulationAbortedError();
          }
          lastYieldWall = nowWallMs();
        }
      }
    }

    switch (ev.kind) {
      case 'CLIENT_ARRIVE': {
        // Schedule next client request arrival immediately (memory O(1))
        const nextT = nextClientArrivalMs();
        if (nextT !== null && nextT < endMs) {
          schedule(nextT, { kind: 'CLIENT_ARRIVE' });
        }

        if (!entryNode) break;
        const flow = pickWeightedUserFlow(scenario.flows, flowRng);
        const step0 = flow?.steps[0];
        const payloadBytes = step0?.bodyBytes ?? 512;

        // Reservoir sample up to 200 traces
        const reqIdx = ++rootTotalRequests;
        bucketRootArrivals += 1;
        const shouldSampleTrace = sampledTraces.length < 200 || traceSampleRng.chance(200 / reqIdx);
        const reqStartMs = now;
        const rootRequestId = `req-${reqIdx}`;
        const sampledForReplayLog = reqIdx === 1 || logSampleRng.chance(0.01);
        const sampledForPlatformSuccessLog =
          sampledPlatformSuccessCount === 0 || logSampleRng.chance(0.01);
        if (sampledForPlatformSuccessLog) {
          sampledPlatformSuccessCount += 1;
        }
        const traceId = shouldSampleTrace ? `tr-${reqIdx}` : '';
        const traceSpans: Span[] | undefined = shouldSampleTrace ? [] : undefined;

        const finishRootRequest = (ok: boolean, errorKind?: ErrorKind) => {
          const totalMs = Math.max(0.01, now - reqStartMs);
          rootHist.record(totalMs);
          bucketRootHist.record(totalMs);
          if (ok) {
            rootSuccess += 1;
            bucketRootSuccess += 1;
          } else {
            bucketRootErrorCount += 1;
            incrementErrorRecord(rootErrors, errorKind ?? 'server');
          }

          if (shouldSampleTrace && traceSpans) {
            const traceObj: Trace = {
              traceId,
              flowId: flow?.id,
              startMs: Number(reqStartMs.toFixed(2)),
              totalMs: Number(totalMs.toFixed(2)),
              status: ok ? 'ok' : 'error',
              spans: traceSpans,
            };
            if (sampledTraces.length < 200) {
              sampledTraces.push(traceObj);
              if (!ok) errorTraceCount += 1;
            } else if (!ok && errorTraceCount < 50) {
              // Replace an 'ok' trace with an error trace for debugging visibility
              const replaceIdx = sampledTraces.findIndex((t) => t.status === 'ok');
              if (replaceIdx >= 0) {
                sampledTraces[replaceIdx] = traceObj;
                errorTraceCount += 1;
              }
            } else {
              const slot = Math.floor(traceSampleRng.next() * 200);
              sampledTraces[slot] = traceObj;
            }
          }
        };

        // If entry node is pure client/users block, forward down outgoing edges to first cloud service
        if (entryNode.isClient) {
          entryNode.totalArrivals += 1;
          entryNode.bucketArrivals += 1;
          entryNode.frameArrivals += 1;
          if (entryNode.outgoingSync.length === 0) {
            entryNode.totalCompletions += 1;
            entryNode.bucketCompletions += 1;
            entryNode.frameCompletions += 1;
            finishRootRequest(true);
            break;
          }

          const firstEdge = pickSyncEdgeWeighted(entryNode, entryNode.outgoingSync)!;
          const reqCallCtx: CallCtx = {
            id: ++callCounter,
            rootRequestId,
            sampledForReplayLog,
            sampledForPlatformSuccessLog,
            traceId,
            parentTraceSpans: traceSpans,
            node: entryNode,
            incomingEdge: null,
            arrivalMs: reqStartMs,
            serviceStartMs: reqStartMs,
            deadlineMs: reqStartMs + (entryNode.node.config.timeoutMs ?? 30_000),
            callerTimedOut: false,
            settledWithCaller: false,
            cancelOnTimeout: false,
            slotAcquired: false,
            dbConnectionHeld: false,
            holdingCore: false,
            coldStarted: false,
            errorOutcome: null,
            pendingChildren: 0,
            bytesOut: payloadBytes,
            payloadBytes,
            downstreamStarted: false,
            postCpuMs: 0,
            localWaitRemainingMs: 0,
          };

          entryNode.station.inFlight += 1;
          invokeEdgeWithPolicy(
            reqCallCtx,
            firstEdge,
            reqStartMs + (entryNode.node.config.timeoutMs ?? 30_000),
            payloadBytes,
            (res) => {
              entryNode.station.inFlight = Math.max(0, entryNode.station.inFlight - 1);
              if (res.ok) {
                entryNode.totalCompletions += 1;
                entryNode.bucketCompletions += 1;
                entryNode.frameCompletions += 1;
              } else {
                entryNode.totalErrorCount += 1;
                entryNode.bucketErrorCount += 1;
                incrementErrorRecord(entryNode.totalErrors, res.errorKind ?? 'server');
                incrementErrorRecord(entryNode.frameErrors, res.errorKind ?? 'server');
              }
              finishRootRequest(res.ok, res.errorKind);
            },
            step0 ? `${step0.method} ${step0.path}` : undefined,
          );
          break;
        }

        // Direct entry into a service node (no Client node on canvas)
        const rootCall: CallCtx = {
          id: ++callCounter,
          rootRequestId,
          sampledForReplayLog,
          sampledForPlatformSuccessLog,
          traceId,
          parentTraceSpans: traceSpans,
          node: entryNode,
          incomingEdge: null,
          arrivalMs: reqStartMs,
          serviceStartMs: reqStartMs,
          deadlineMs: reqStartMs + (entryNode.node.config.timeoutMs ?? 30_000),
          callerTimedOut: false,
          settledWithCaller: false,
          cancelOnTimeout: Boolean(entryNode.node.config.cancelOnTimeout),
          slotAcquired: false,
          dbConnectionHeld: false,
          holdingCore: false,
          coldStarted: false,
          errorOutcome: null,
          pendingChildren: 0,
          bytesOut: payloadBytes,
          payloadBytes,
          downstreamStarted: false,
          postCpuMs: 0,
          localWaitRemainingMs: 0,
          onFinish: (res) => finishRootRequest(res.ok, res.errorKind),
        };
        if (traceSpans) {
          rootCall.span = {
            spanId: `sp-${rootCall.id}`,
            nodeId: entryNode.node.id,
            startMs: Number(reqStartMs.toFixed(2)),
            waitMs: 0,
            serviceMs: 0,
            status: 'ok',
          };
          traceSpans.push(rootCall.span);
        }
        handleNodeArrive(rootCall);
        break;
      }

      case 'NODE_ARRIVE': {
        handleNodeArrive(ev.call);
        break;
      }

      case 'END_CPU': {
        const { call } = ev;
        const rn = call.node;
        call.holdingCore = false;
        const nextCoreTask = releaseCoreAndDequeue(rn.station, now);
        if (nextCoreTask) {
          nextCoreTask.item.call.holdingCore = true;
          schedule(now + nextCoreTask.cpuMs, {
            kind: 'END_CPU',
            call: nextCoreTask.item.call,
            stage: nextCoreTask.item.stage,
          });
        }

        if (ev.stage === 'post') {
          const outcome = call.pendingPostOutcome;
          settleCallAndReleaseResources(call, outcome?.ok ?? true, outcome?.errorKind);
          break;
        }

        if (call.localWaitRemainingMs > 0) {
          schedule(now + call.localWaitRemainingMs, { kind: 'END_LOCAL_WAIT', call });
        } else {
          finishNodeAfterLocalWork(call);
        }
        break;
      }

      case 'END_LOCAL_WAIT': {
        finishNodeAfterLocalWork(ev.call);
        break;
      }

      case 'CONN_WAIT_TIMEOUT': {
        const { call } = ev;
        if (call.dbConnectionHeld || call.settledWithCaller) {
          break;
        }
        for (let i = 0; i < call.node.dbWaitQueue.length; i++) {
          if (call.node.dbWaitQueue[i]!.call === call) {
            call.node.dbWaitQueue[i]!.expired = true;
            call.node.dbWaitQueue.splice(i, 1);
            break;
          }
        }
        settleCallAndReleaseResources(call, false, 'timeout');
        break;
      }

      case 'COMPLETE_CALL': {
        const { call } = ev;
        const errSpec = getEffectiveErrorOutcome(call.node, call.opName);
        const fail = errSpec.errorRate > 0 && call.node.errorRng.chance(errSpec.errorRate);
        if (fail && call.span && errSpec.opErrorTag) {
          call.span.attrs = { ...(call.span.attrs ?? {}), opErrorKind: errSpec.opErrorTag };
        }
        settleCallAndReleaseResources(call, !fail, fail ? errSpec.errorKind : undefined);
        break;
      }

      case 'CALL_TIMEOUT': {
        handleCallTimeout(ev.token);
        break;
      }

      case 'RETRY_ATTEMPT': {
        launchEdgeAttempt(ev.attemptState);
        break;
      }

      case 'RUN_CONTINUATION': {
        ev.fn();
        break;
      }

      case 'ASYNC_POLL': {
        const rn = ev.node;
        triggerQueueWorkers(rn);
        const pollMs = Math.max(5, rn.node.config.consumer?.pollMs ?? 50);
        if (now + pollMs < endMs) {
          schedule(now + pollMs, { kind: 'ASYNC_POLL', node: rn });
        }
        break;
      }

      case 'ASYNC_DRAIN_DONE': {
        const rn = ev.node;
        rn.asyncWorkersBusy = Math.max(0, rn.asyncWorkersBusy - 1);
        triggerQueueWorkers(rn);
        break;
      }

      case 'BUCKET_TICK': {
        flushBucket(ev.secondIdx);
        const nextSec = ev.secondIdx + 1;
        if (nextSec <= durationS) {
          schedule(nextSec * 1000, { kind: 'BUCKET_TICK', secondIdx: nextSec });
        }
        break;
      }

      case 'FRAME_TICK': {
        emitSimFrame();
        if (now + frameIntervalMs < endMs) {
          schedule(now + frameIntervalMs, { kind: 'FRAME_TICK' });
        }
        break;
      }

      case 'SCALE_CHECK': {
        const rn = ev.node;
        const as = rn.node.config.autoscaling;
        if (!as) break;
        const metricVal =
          as.metric === 'cpu'
            ? Math.max(rn.lastCpuUtil, rn.lastFrameCpuUtil)
            : as.metric === 'queue'
              ? (rn.station.slotQueue.length + rn.asyncBacklog.length) * scaleFactor
              : as.metric === 'rps'
                ? Math.max(rn.bucketArrivals, rn.lastBucketArrivals) * scaleFactor
                : Math.max(rn.lastSmoothedUtil, rn.lastFrameUtil);
        const curTotal = rn.station.instancesTotal;
        const rawDesired = Math.ceil(
          (curTotal * Math.max(0.01, metricVal)) / Math.max(0.01, as.target),
        );
        const desired = Math.min(as.max, Math.max(as.min, rawDesired));

        if (desired > curTotal && now - rn.lastScaleOutMs >= as.scaleOutCooldownS * 1000) {
          advanceStationIntegrals(rn.station, now);
          const delta = desired - curTotal;
          rn.lastScaleOutMs = now;
          rn.station.instancesTotal = desired;
          rn.warmingInstances += delta;
          emitLog(
            'info',
            'engine',
            `Autoscaling scale-out on ${rn.node.label}: ${curTotal} -> ${desired} instances`,
            rn.node.id,
          );
          const nextCaps = resolveNodeCapacities(
            { ...rn.node, config: { ...rn.node.config, instances: desired } },
            rn.service,
            scaleFactor,
          );
          rn.station.slotsCapacity = nextCaps.totalSlots;
          rn.station.coresCapacity = nextCaps.totalCores;
          recomputeActiveInstances(rn);
          if (as.warmupS <= 0) {
            rn.warmingInstances = Math.max(0, rn.warmingInstances - delta);
            recomputeActiveInstances(rn);
            const activeSlots = getActiveSlotCapacity(rn.station);
            while (rn.station.slotQueue.length > 0 && rn.station.inFlight < activeSlots) {
              const nextQueued = rn.station.slotQueue.shift()!;
              advanceStationIntegrals(rn.station, now);
              rn.station.inFlight += 1;
              startServiceAtNode(nextQueued.req);
            }
          } else {
            schedule(now + as.warmupS * 1000, { kind: 'ACTIVATE_SCALE', node: rn, delta });
          }
        } else if (
          desired < curTotal &&
          rn.warmingInstances === 0 &&
          now - rn.lastScaleInMs >= as.scaleInCooldownS * 1000
        ) {
          advanceStationIntegrals(rn.station, now);
          const nextInstances = Math.max(as.min, curTotal - 1);
          rn.lastScaleInMs = now;
          rn.station.instancesTotal = nextInstances;
          emitLog(
            'info',
            'engine',
            `Autoscaling scale-in on ${rn.node.label}: ${curTotal} -> ${nextInstances} instances`,
            rn.node.id,
          );
          const nextCaps = resolveNodeCapacities(
            { ...rn.node, config: { ...rn.node.config, instances: nextInstances } },
            rn.service,
            scaleFactor,
          );
          rn.station.slotsCapacity = nextCaps.totalSlots;
          rn.station.coresCapacity = nextCaps.totalCores;
          recomputeActiveInstances(rn);
        }

        const nextMs = now + Math.max(1, as.checkIntervalS) * 1000;
        if (nextMs < endMs) {
          schedule(nextMs, { kind: 'SCALE_CHECK', node: rn });
        }
        break;
      }

      case 'ACTIVATE_SCALE': {
        const rn = ev.node;
        rn.warmingInstances = Math.max(0, rn.warmingInstances - ev.delta);
        recomputeActiveInstances(rn);
        const activeSlots = getActiveSlotCapacity(rn.station);
        while (rn.station.slotQueue.length > 0 && rn.station.inFlight < activeSlots) {
          const nextQueued = rn.station.slotQueue.shift()!;
          advanceStationIntegrals(rn.station, now);
          rn.station.inFlight += 1;
          startServiceAtNode(nextQueued.req);
        }
        break;
      }

      case 'HEALTH_CHECK': {
        const rn = ev.node;
        const hc =
          rn.node.config.lb?.healthCheck ??
          (rn.outgoingSync.length > 1
            ? { intervalS: 2, unhealthyThreshold: 2, healthyThreshold: 2, timeoutMs: 2000 }
            : undefined);
        if (!hc) break;
        for (const edge of rn.outgoingSync) {
          const target = edge.toNode;
          const oldestQueueWaitMs =
            target.station.slotQueue.length > 0
              ? now - target.station.slotQueue[0]!.enqueuedAtMs
              : target.station.coreQueue.length > 0
                ? now - target.station.coreQueue[0]!.enqueuedAtMs
                : 0;
          const targetP50 = target.node.config.latency?.p50 ?? target.service?.latency.p50 ?? 15;
          const activeCap = Math.max(1, getActiveSlotCapacity(target.station));
          const estQueueWaitMs =
            (target.station.slotQueue.length * Math.max(1, targetP50)) / activeCap;
          const recentProbeLatency = Math.max(
            oldestQueueWaitMs,
            estQueueWaitMs,
            target.station.slotQueue.length > 0 || target.station.inFlight >= activeCap
              ? target.lastBucketP95Ms
              : 0,
          );
          const overloadedCheck =
            target.station.instancesActive <= 0 ||
            target.lastHealth === 'down' ||
            recentProbeLatency > hc.timeoutMs;
          if (overloadedCheck) {
            const fails = (rn.lbFailStreaks.get(edge.edge.id) ?? 0) + 1;
            rn.lbFailStreaks.set(edge.edge.id, fails);
            rn.lbPassStreaks.set(edge.edge.id, 0);
            if (fails >= hc.unhealthyThreshold && !rn.lbEdgeUnhealthy.has(edge.edge.id)) {
              rn.lbEdgeUnhealthy.add(edge.edge.id);
              emitLog(
                'warn',
                'engine',
                `Health check marked ${target.node.label} unhealthy from ${rn.node.label}`,
                target.node.id,
              );
            }
          } else {
            const passes = (rn.lbPassStreaks.get(edge.edge.id) ?? 0) + 1;
            rn.lbPassStreaks.set(edge.edge.id, passes);
            rn.lbFailStreaks.set(edge.edge.id, 0);
            if (passes >= hc.healthyThreshold && rn.lbEdgeUnhealthy.has(edge.edge.id)) {
              rn.lbEdgeUnhealthy.delete(edge.edge.id);
              emitLog(
                'info',
                'engine',
                `Health check restored ${target.node.label} to healthy from ${rn.node.label}`,
                target.node.id,
              );
            }
          }
        }
        const nextMs = now + Math.max(1, hc.intervalS) * 1000;
        if (nextMs < endMs) {
          schedule(nextMs, { kind: 'HEALTH_CHECK', node: rn });
        }
        break;
      }

      case 'CHAOS_EVENT': {
        const { chaos, active } = ev;
        const chaosTargetId = 'nodeId' in chaos ? chaos.nodeId : undefined;
        emitLog(
          'warn',
          'engine',
          `Chaos ${chaos.kind} ${active ? 'started' : 'ended'}${chaosTargetId ? ` on ${runtimeNodes.get(chaosTargetId)?.node.label ?? chaosTargetId}` : ''}`,
          chaosTargetId,
        );
        if (chaos.kind === 'kill-instances') {
          const rn = runtimeNodes.get(chaos.nodeId);
          if (rn) {
            rn.killedInstances = active ? Math.min(rn.station.instancesTotal, chaos.count) : 0;
            recomputeActiveInstances(rn);
            if (!active) {
              const activeSlots = getActiveSlotCapacity(rn.station);
              while (rn.station.slotQueue.length > 0 && rn.station.inFlight < activeSlots) {
                const nextQueued = rn.station.slotQueue.shift()!;
                advanceStationIntegrals(rn.station, now);
                rn.station.inFlight += 1;
                startServiceAtNode(nextQueued.req);
              }
              if (
                rn.kind === 'queue' ||
                rn.kind === 'topic' ||
                rn.kind === 'stream' ||
                rn.kind === 'bus'
              ) {
                triggerQueueWorkers(rn);
              }
            }
          }
        } else if (chaos.kind === 'az-outage') {
          for (const rn of orderedNodes) {
            if ((rn.placement.az ?? rn.node.az) === chaos.az) {
              rn.azDown = active;
              recomputeActiveInstances(rn);
              if (!active) {
                const activeSlots = getActiveSlotCapacity(rn.station);
                while (rn.station.slotQueue.length > 0 && rn.station.inFlight < activeSlots) {
                  const nextQueued = rn.station.slotQueue.shift()!;
                  advanceStationIntegrals(rn.station, now);
                  rn.station.inFlight += 1;
                  startServiceAtNode(nextQueued.req);
                }
                if (
                  rn.kind === 'queue' ||
                  rn.kind === 'topic' ||
                  rn.kind === 'stream' ||
                  rn.kind === 'bus'
                ) {
                  triggerQueueWorkers(rn);
                }
              }
            }
          }
        } else if (chaos.kind === 'add-latency') {
          const rn = runtimeNodes.get(chaos.nodeId);
          if (rn) rn.chaosExtraLatencyMs = active ? chaos.extraMs : 0;
        } else if (chaos.kind === 'error-rate') {
          const rn = runtimeNodes.get(chaos.nodeId);
          if (rn) rn.chaosErrorRateOverride = active ? chaos.rate : null;
        } else if (chaos.kind === 'throttle') {
          const rn = runtimeNodes.get(chaos.nodeId);
          if (rn) {
            rn.chaosRateBucket = active
              ? createTokenBucket(
                  chaos.rps / scaleFactor,
                  Math.max(1, chaos.rps / scaleFactor),
                  now,
                )
              : null;
          }
        } else if (chaos.kind === 'cache-flush') {
          const rn = runtimeNodes.get(chaos.nodeId);
          if (rn && active) {
            rn.cacheFlushStartMs = now;
            rn.cacheFlushWarmupMs = chaos.warmupS * 1000;
          }
        }
        break;
      }
    }
  }

  // Finalize any trailing partial second if durationS wasn't hit cleanly by bucket ticks
  now = endMs;
  if (buckets.length < durationS) {
    for (let s = buckets.length + 1; s <= durationS; s++) {
      flushBucket(s);
    }
  }
  if (suppressedErrorLogs > 0) {
    emitLog(
      'warn',
      'engine',
      `${suppressedErrorLogs.toLocaleString()} more error logs suppressed (limit 2,000 per run reached)`,
    );
  }
  emitSimFrame();

  // Compile final SimulationResult & UsageCounters
  const perNodeSummary: Record<string, NodeSummary> = {};
  const perNodeCounters: UsageCounters['perNode'] = {};
  let bottleneckNodeId: string | undefined;
  let maxBottleneckScore = 0;

  for (const rn of orderedNodes) {
    const pct = rn.totalHist.percentiles();
    const avgUtil = buckets.length > 0 ? rn.sumUtil / buckets.length : 0;
    const avgCpuUtil = buckets.length > 0 ? rn.sumCpuUtil / buckets.length : 0;
    const bottleneckScore =
      avgUtil * 1000 +
      rn.peakUtil * 100 +
      (rn.totalDrops + rn.totalErrorCount > 0 ? 50 : 0) +
      Math.min(49, rn.peakQueueDepth / 100);
    if (!rn.isClient && rn.totalArrivals > 0 && bottleneckScore > maxBottleneckScore) {
      maxBottleneckScore = bottleneckScore;
      bottleneckNodeId = rn.node.id;
    }

    const totalErrScaled: Partial<Record<ErrorKind, number>> = {};
    for (const [k, cnt] of Object.entries(rn.totalErrors)) {
      if (cnt) totalErrScaled[k as ErrorKind] = cnt * scaleFactor;
    }

    const scriptId = rn.node.config.scriptId;
    const planCpuP50 =
      scriptId && isHandlerScript(scriptId) ? input.callPlans?.[scriptId]?.cpuMs.p50 : undefined;
    const effectiveCpuP50 = rn.node.config.cpuMsPerRequest ?? planCpuP50;
    const effLatP50 = Math.max(
      effectiveCpuP50 ?? 1,
      rn.node.config.latency?.p50 ?? rn.service?.latency.p50 ?? 15,
    );
    let theoreticalMax = (rn.capacities.totalSlots * scaleFactor * 1000) / Math.max(1, effLatP50);
    if (rn.capacities.totalCores > 0) {
      theoreticalMax = Math.min(
        theoreticalMax,
        (rn.capacities.totalCores * scaleFactor * 1000) / Math.max(0.1, effectiveCpuP50 ?? 4),
      );
    }
    if (rn.capacities.connectionsMax !== null && rn.capacities.connectionsMax > 0) {
      theoreticalMax = Math.min(
        theoreticalMax,
        (rn.capacities.connectionsMax * scaleFactor * 1000) / Math.max(1, effLatP50),
      );
    }
    if (rn.capacities.rateLimitRps !== null && rn.capacities.rateLimitRps > 0) {
      theoreticalMax = Math.min(theoreticalMax, rn.capacities.rateLimitRps * scaleFactor);
    }

    perNodeSummary[rn.node.id] = {
      requests: rn.totalArrivals * scaleFactor,
      success: rn.totalCompletions * scaleFactor,
      errors: totalErrScaled,
      drops: rn.totalDrops * scaleFactor,
      p50: pct.p50,
      p95: pct.p95,
      p99: pct.p99,
      avgUtilization: Number(avgUtil.toFixed(4)),
      peakUtilization: Number(rn.peakUtil.toFixed(4)),
      avgCpuUtilization: Number(avgCpuUtil.toFixed(4)),
      peakQueueDepth: rn.peakQueueDepth * scaleFactor,
      wastedWorkMs: Number((rn.totalWastedWorkMs * scaleFactor).toFixed(2)),
      ...(rn.capacities.approximate ? { approximate: true } : {}),
      theoreticalMaxRps: Math.round(theoreticalMax),
    };

    perNodeCounters[rn.node.id] = {
      requests: rn.totalArrivals * scaleFactor,
      instanceSeconds: Number(rn.totalInstanceSeconds.toFixed(2)),
      bytesIn: rn.totalBytesIn * scaleFactor,
      bytesOut: rn.totalBytesOut * scaleFactor,
      ...(rn.totalTokensIn > 0 ? { tokensIn: Math.round(rn.totalTokensIn * scaleFactor) } : {}),
      ...(rn.totalTokensOut > 0 ? { tokensOut: Math.round(rn.totalTokensOut * scaleFactor) } : {}),
      ...(rn.totalReadUnits > 0 ? { readUnits: rn.totalReadUnits * scaleFactor } : {}),
      ...(rn.totalWriteUnits > 0 ? { writeUnits: rn.totalWriteUnits * scaleFactor } : {}),
      ...(rn.totalGbSeconds > 0
        ? { gbSeconds: Number((rn.totalGbSeconds * scaleFactor).toFixed(3)) }
        : {}),
    };
  }

  const perEdgeCounters: UsageCounters['perEdge'] = {};
  for (const re of orderedEdges) {
    perEdgeCounters[re.edge.id] = {
      bytes: re.totalBytes * scaleFactor,
      crossAz: re.crossAz,
      crossRegion: re.crossRegion,
      viaNat: re.viaNat,
      ...(re.viaPrivateLink ? { viaPrivateLink: true } : {}),
    };
  }

  const rootPct = rootHist.percentiles();
  const rootErrorsScaled: Partial<Record<ErrorKind, number>> = {};
  for (const [k, cnt] of Object.entries(rootErrors)) {
    if (cnt) rootErrorsScaled[k as ErrorKind] = cnt * scaleFactor;
  }

  // Optional Erlang C analytical check on single-station saturation sanity (available for insights/diagnostics)
  void computeErlangC;
  void SCHEMA_VERSION;

  return {
    runId,
    seed,
    durationS,
    scaled: scaleFactor > 1 ? { factor: scaleFactor } : null,
    summary: {
      totalRequests: rootTotalRequests * scaleFactor,
      success: rootSuccess * scaleFactor,
      errors: rootErrorsScaled,
      p50: rootPct.p50,
      p95: rootPct.p95,
      p99: rootPct.p99,
      throughputRps: Number(((rootSuccess * scaleFactor) / durationS).toFixed(2)),
    },
    perNode: perNodeSummary,
    series: {
      bucketSizeS: 1,
      buckets,
    },
    ...(bottleneckNodeId ? { bottleneckNodeId } : {}),
    traces: sampledTraces,
    counters: {
      perNode: perNodeCounters,
      perEdge: perEdgeCounters,
    },
    insights: [],
  };
}
