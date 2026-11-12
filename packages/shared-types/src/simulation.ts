import type { ErrorKind, LatencyModel } from './catalog.js';
import type { Insight } from './diagnosis.js';

/** Node health states driving canvas bars and shake animations. */
export type HealthState = 'ok' | 'warm' | 'hot' | 'overloaded' | 'down';

/** Per-node snapshot emitted in each simulation frame. */
export interface NodeFrame {
  utilization: number;
  cpuUtilization?: number;
  inFlight: number;
  queueDepth: number;
  rpsIn: number;
  rpsOut: number;
  errorsPerSec: Partial<Record<ErrorKind, number>>;
  dropsPerSec: number;
  latency: { p50: number; p95: number; p99: number };
  instancesActive: number;
  instancesTotal: number;
  health: HealthState;
  throttle?: { limit: number; used: number };
}

/** Per-edge live metrics emitted in each simulation frame. */
export interface EdgeFrame {
  rps: number;
  errorRate: number;
  avgLatencyMs: number;
}

/** Animated request particle sampled for edge visualization. */
export interface Particle {
  id: string;
  edgeId: string;
  progress: number;
  status: 'ok' | 'slow' | 'error';
  traceId: string;
}

/** Structured log entry from user code, mocked cloud platform, or sim engine. */
export interface LogEntry {
  id: number;
  tVirtualMs: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'user' | 'platform' | 'engine';
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  message: string;
  data?: unknown;
  replayedFromProfile?: boolean;
  site?: { file?: string; line: number; col: number };
}

/** Real-time frame streamed from the simulation worker at virtual time intervals. */
export interface SimFrame {
  runId: string;
  tVirtualMs: number;
  nodes: Record<string, NodeFrame>;
  edges: Record<string, EdgeFrame>;
  particles: Particle[];
  newLogs: LogEntry[];
}

/** Individual operation span inside a sampled request trace. */
export interface Span {
  spanId: string;
  parentId?: string;
  nodeId: string;
  operation?: string;
  startMs: number;
  waitMs: number;
  serviceMs: number;
  status: 'ok' | ErrorKind;
  attrs?: Record<string, string | number>;
}

/** End-to-end sampled request trace. */
export interface Trace {
  traceId: string;
  flowId?: string;
  startMs: number;
  totalMs: number;
  status: 'ok' | 'error';
  spans: Span[];
}

/** Aggregated per-node summary metrics over the entire simulation run. */
export interface NodeSummary {
  requests: number;
  success: number;
  errors: Partial<Record<ErrorKind, number>>;
  drops: number;
  p50: number;
  p95: number;
  p99: number;
  avgUtilization: number;
  peakUtilization: number;
  avgCpuUtilization?: number;
  peakQueueDepth: number;
  wastedWorkMs?: number;
  approximate?: boolean;
  theoreticalMaxRps?: number;
}

/** Single 1-second bucket in the simulation time series. */
export interface TimeSeriesBucket {
  tS: number;
  rpsIn: number;
  throughputRps: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  perNode: Record<
    string,
    {
      rpsIn: number;
      rpsOut: number;
      errors: number;
      drops: number;
      utilization: number;
      cpuUtilization?: number;
      queueDepth: number;
      inFlight: number;
      instancesActive: number;
      p50: number;
      p95: number;
      p99: number;
    }
  >;
}

/** Time-series buckets across a simulation run. */
export interface TimeSeries {
  bucketSizeS: number;
  buckets: TimeSeriesBucket[];
}

/** Usage counters accumulated by the simulator for cost estimation. */
export interface UsageCounters {
  perNode: Record<
    string,
    {
      requests: number;
      instanceSeconds: number;
      bytesIn: number;
      bytesOut: number;
      tokensIn?: number;
      tokensOut?: number;
      readUnits?: number;
      writeUnits?: number;
      gbSeconds?: number;
    }
  >;
  perEdge: Record<
    string,
    {
      bytes: number;
      crossAz: boolean;
      crossRegion: boolean;
      viaNat: boolean;
      viaPrivateLink?: boolean;
    }
  >;
}

/** Final summary and artifacts returned when a simulation completes. */
export interface SimulationResult {
  runId: string;
  seed: number;
  durationS: number;
  scaled: { factor: number } | null;
  summary: {
    totalRequests: number;
    success: number;
    errors: Partial<Record<ErrorKind, number>>;
    p50: number;
    p95: number;
    p99: number;
    throughputRps: number;
  };
  perNode: Record<string, NodeSummary>;
  series: TimeSeries;
  bottleneckNodeId?: string;
  traces: Trace[];
  counters: UsageCounters;
  insights: Insight[];
}

/** Step inside a profiled user-code call plan. */
export type PlanStep =
  | { kind: 'cpu'; ms: number }
  | { kind: 'sleep'; ms: number }
  | {
      kind: 'call';
      serviceId: string;
      op: string;
      count: number;
      payloadBytes?: number;
      parallelGroup?: string;
      probability?: number;
      alias?: string;
    }
  | { kind: 'branch'; probability: number; then: PlanStep[]; else: PlanStep[] };

/** Aggregated execution plan derived from profiling a user handler script. */
export interface CallPlan {
  scriptId: string;
  cpuMs: LatencyModel;
  throwProbability: number;
  steps: PlanStep[];
}
