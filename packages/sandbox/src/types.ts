import type {
  CallPlan,
  Design,
  ErrorKind,
  LatencyModel,
  LogEntry,
  NodeInstance,
  OperationOverride,
  PayloadFixture,
  ScriptAsset,
  ServiceDefinition,
} from '@infrasim/shared-types';

/** Structured sandbox error category per docs/specs/12-CODE-SANDBOX-AND-LOGS.md §7. */
export type SandboxErrorCategory =
  | 'UserCodeError'
  | 'UnhandledRejection'
  | 'Timeout'
  | 'OutOfMemory'
  | 'CpuBudgetExceeded'
  | 'MockNotConfigured'
  | 'MockServiceError'
  | 'ValidationError'
  | 'UnsupportedModule';

/** Sandbox execution limits per docs/specs/12-CODE-SANDBOX-AND-LOGS.md §11. */
export interface SandboxLimits {
  memoryMb: number;
  stackBytes: number;
  cpuBudgetMs: number;
  timeoutMs: number;
  maxSourceBytes: number;
  maxDesignSourceBytes: number;
  maxMockCalls: number;
  maxLogLineBytes: number;
  maxLogLines: number;
  tmpFsMaxBytes: number;
}

export const DEFAULT_DRY_RUN_LIMITS: SandboxLimits = {
  memoryMb: 128,
  stackBytes: 1024 * 1024,
  cpuBudgetMs: 2_000,
  timeoutMs: 3_000,
  maxSourceBytes: 200 * 1024,
  maxDesignSourceBytes: 1024 * 1024,
  maxMockCalls: 500,
  maxLogLineBytes: 8 * 1024,
  maxLogLines: 1_000,
  tmpFsMaxBytes: 64 * 1024 * 1024,
};

export const MAX_GUEST_MEMORY_MB = 512;
export const DEFAULT_PROFILE_CPU_BUDGET_MS = 20_000;

/** Source map entry mapping bundled line/column back to original editor source. */
export interface SourceLocation {
  file?: string;
  line: number;
  column: number;
}

/** One detected outbound mock service or HTTP call during a sandbox run. */
export interface DetectedCallRecord {
  index: number;
  serviceId: string;
  op: string;
  targetNodeId?: string;
  input: unknown;
  output?: unknown;
  error?: {
    name: string;
    message: string;
    code?: string;
    statusCode?: number;
    retryAfterMs?: number;
  };
  startVirtualMs: number;
  latencyMs: number;
  payloadBytes: number;
  responseBytes: number;
  parallelGroup?: string;
  streamed?: boolean;
  spans?: { phase: 'ttft' | 'decode'; startMs: number; durationMs: number }[];
  tokens?: { in: number; out: number; thinking?: number };
  httpUrl?: string;
  alias?: string;
  site?: SourceLocation;
}

/** Normalized error report returned from sandbox compilation or execution. */
export interface SandboxErrorReport {
  category: SandboxErrorCategory;
  name: string;
  message: string;
  stack?: string;
  site?: SourceLocation;
  statusCode?: number;
  details?: Record<string, unknown>;
}

/** Input passed by mock SDK / HTTP interceptor from guest to host mock handler. */
export interface MockCallInvocation {
  kind: 'cloud' | 'http';
  serviceId?: string;
  op?: string;
  input?: unknown;
  region?: string;
  alias?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  sdkStyle?: 'universal' | 'aws-v3' | 'aws-ddb-doc' | 'bedrock' | 'gcp' | 'azure' | 'oci' | 'http';
  stream?: boolean;
  discoveryMode?: boolean;
  startVirtualMs: number;
  parallelGroup?: string;
  site?: SourceLocation;
}

/** Outcome returned by host mock handler to resolve/reject guest call. */
export interface MockCallOutcome {
  ok: boolean;
  latencyMs: number;
  serviceId: string;
  op: string;
  targetNodeId?: string;
  output?: unknown;
  statusCode?: number;
  headers?: Record<string, string>;
  streamChunks?: { delayOffsetMs: number; data: unknown }[];
  spans?: { phase: 'ttft' | 'decode'; startMs: number; durationMs: number }[];
  tokens?: { in: number; out: number; thinking?: number };
  error?: {
    category: 'MockNotConfigured' | 'MockServiceError' | 'ValidationError';
    name: string;
    message: string;
    code?: string;
    statusCode?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
}

/** Function signature used to resolve a mocked downstream call inside sandbox execution. */
export type MockCallResolver = (
  invocation: MockCallInvocation,
  context: {
    seed: number;
    seq: number;
    nowMs: number;
    env: Record<string, string>;
  },
) => MockCallOutcome | Promise<MockCallOutcome>;

/** Input options for a single deterministic dry-run invocation inside QuickJS-WASM. */
export interface DryRunInput {
  script: ScriptAsset;
  /** Optional sibling scripts in the design for relative imports (resolved during bundling). */
  designScripts?: readonly ScriptAsset[];
  /** Optional raw event payload or fixture. */
  fixture?: PayloadFixture;
  event?: unknown;
  context?: Record<string, unknown>;
  /** Optional design & node context for target resolution and platform log formatting. */
  design?: Design;
  node?: NodeInstance;
  service?: ServiceDefinition;
  customServices?: readonly ServiceDefinition[];
  seed?: number;
  seq?: number;
  env?: Record<string, string>;
  limits?: Partial<SandboxLimits>;
  /** True when executing under Auto-fill path discovery proxy mode. */
  discoveryMode?: boolean;
  /** Optional custom mock resolver override (defaults to catalog/design mock resolver). */
  mockResolver?: MockCallResolver;
  /** Optional pre-bundled source + raw v3 source map JSON (skips esbuild step if already bundled). */
  prebuiltBundle?: {
    code: string;
    sourceMapJson?: string;
  };
  /** Optional QuickJS WASM URL when running inside a browser Web Worker. */
  quickJsWasmUrl?: string;
  /** Optional esbuild WASM URL when running inside a browser Web Worker. */
  esbuildWasmUrl?: string;
}

/** Result returned by a single sandbox dry-run invocation. */
export interface DryRunResult {
  ok: boolean;
  seed: number;
  result?: unknown;
  httpStatus?: number;
  virtualDurationMs: number;
  billedDurationMs: number;
  guestCpuMs: number;
  memoryPeakBytes: number;
  logs: LogEntry[];
  calls: DetectedCallRecord[];
  /** Accessed property paths collected in `discoveryMode`, keyed by `serviceId::op`. */
  discoveredPaths?: Record<string, string[]>;
  error?: SandboxErrorReport;
}

/** Bundle output emitted by the esbuild-wasm bundler. */
export interface BundleResult {
  ok: boolean;
  code?: string;
  sourceMapJson?: string;
  errors?: SandboxErrorReport[];
  warnings?: string[];
  resolvedModules?: string[];
}

/** Payload Doctor rule definition loaded from JSON data. */
export interface PayloadDoctorRule {
  id: string;
  title: string;
  message: string;
  severity: 'error' | 'warn' | 'info';
  matchCategories?: SandboxErrorCategory[];
  errorPattern?: string;
  stackPattern?: string;
  sourcePattern?: string;
  excludeSourcePattern?: string;
  requiresTemplate?: string[];
  eventCheck?: string;
  checkMissingMockField?: boolean;
  checkMissingEnv?: boolean;
  actionLabel?: string;
  actionKind?: 'auto-fill-mock' | 'patch-source' | 'increase-timeout' | 'add-env' | 'add-edge';
  patchTemplate?: {
    find: string;
    findIsRegex?: boolean;
    replace: string;
  };
}

/** Matched diagnostic emitted by Payload Doctor for a failed/noisy invocation. */
export interface PayloadDoctorHint {
  ruleId: string;
  title: string;
  message: string;
  severity: 'error' | 'warn' | 'info';
  actionLabel?: string;
  actionKind?: PayloadDoctorRule['actionKind'];
  patchedSource?: string;
  targetServiceId?: string;
  targetOp?: string;
  envKey?: string;
}

/** Diff entry produced by Auto-fill mock path discovery. */
export interface AutoFillPatchPreview {
  serviceId: string;
  op: string;
  targetNodeId?: string;
  accessedPaths: string[];
  beforeTemplate: string;
  afterTemplate: string;
}

/** Summary report for profiling N weighted handler runs into a CallPlan. */
export interface ProfileRunSummary {
  callPlan: CallPlan;
  sampleCount: number;
  measuredGuestCpuMs: LatencyModel;
  scaledCpuMs: LatencyModel;
  cpuScale: number;
  branchCount: number;
  throwProbability: number;
  sampledLogs: LogEntry[][];
  wallDurationMs: number;
  truncatedByBudget: boolean;
}

/** k6-style traffic extraction & threshold evaluation result. */
export interface ExtractedScenarioResult {
  options: {
    rps?: number;
    durationS?: number;
    rampUpS?: number;
    stages?: { durationS: number; targetRps: number }[];
    thresholds?: Record<string, string[]>;
  };
  flows: Design['scenarios'][number]['flows'];
  checkDefinitions: { name: string; expectedStatus: number }[];
  errors: SandboxErrorReport[];
}

/** Evaluated threshold pass/fail badge derived after simulation completes. */
export interface ThresholdEvaluationResult {
  metric: string;
  expression: string;
  actualValue: number;
  thresholdValue: number;
  passed: boolean;
  label: string;
}

/** Operation-level override helper export alias for downstream modules. */
export type NodeOperationMockMap = Record<string, OperationOverride>;
export type MockErrorKind = ErrorKind;
