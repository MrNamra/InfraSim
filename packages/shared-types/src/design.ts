import type { CustomPreset, CustomServiceDefinition, LatencyModel } from './catalog.js';
import type { NetworkConfig, Provider } from './network.js';

/** Top-level InfraSim design document stored as JSON. */
export interface Design {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  nodes: NodeInstance[];
  edges: EdgeInstance[];
  groups: GroupInstance[];
  network: NetworkConfig;
  scenarios: Scenario[];
  scripts: ScriptAsset[];
  fixtures: PayloadFixture[];
  settings: DesignSettings;
  customServices?: CustomServiceDefinition[];
  presets?: CustomPreset[];
}

/** Global simulation and pricing preferences for a design. */
export interface DesignSettings {
  seed: number;
  primaryProvider?: Provider;
  currency: 'USD' | 'INR' | 'EUR' | 'GBP';
  fxRateToUSD?: number;
  includeFreeTier: boolean;
}

/** Runtime concurrency preset for compute nodes. */
export type RuntimePreset =
  'node' | 'php-fpm' | 'java-threads' | 'python-gunicorn' | 'go' | 'custom';

/** Time-boxed scenario override applied to a node during a simulation window. */
export interface ScenarioOverride {
  scenarioId?: string;
  fromS: number;
  toS: number;
  latency?: LatencyModel;
  errorRate?: number;
  rateLimitRps?: number;
}

/** Service node placed on the canvas. */
export interface NodeInstance {
  id: string;
  serviceId: string;
  label: string;
  position: { x: number; y: number };
  parentGroupId?: string;
  region?: string;
  az?: string;
  config: NodeConfig;
  importedAttrs?: Record<string, unknown>;
}

/** Editable behavioral, capacity, mock, and pricing configuration for a node. */
export interface NodeConfig {
  instances: number;
  instanceType?: string;
  vcpu?: number;
  memoryGb?: number;
  runtimePreset?: RuntimePreset;
  cluster?: boolean;
  maxInFlightPerInstance?: number;
  cpuMsPerRequest?: number;
  queue?: { maxLength: number; policy: 'reject' | 'drop-oldest' };
  autoscaling?: AutoscalingConfig;

  latency?: LatencyModel;
  errorRate?: number;
  rateLimit?: {
    rps?: number;
    burst?: number;
    tpm?: number;
    rpm?: number;
    concurrency?: number;
    countMaxTokensUpfront?: boolean;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  };
  timeoutMs?: number;
  cancelOnTimeout?: boolean;
  coldStart?: {
    enabled: boolean;
    probabilityModel: 'idle-based' | 'fixed';
    p50: number;
    p95: number;
    idleTtlS?: number;
    onLimit?: 'throttle' | 'queue';
    concurrencyLimit?: number;
  };

  cacheHitRatio?: number;
  readRatio?: number;
  writeLatencyMultiplier?: number;
  connectionWaitMs?: number;
  connections?: { max: number };
  prefixes?: number;
  lb?: {
    algorithm: 'round-robin' | 'least-conn' | 'random';
    healthCheck?: HealthCheck;
    idleTimeoutMs?: number;
  };
  consumer?: {
    concurrency: number;
    batchSize: number;
    pollMs: number;
    maxRetries: number;
    dlq: boolean;
  };
  ai?: {
    modelLabel?: string;
    profile?: 'small-fast' | 'balanced' | 'large' | 'reasoning' | 'embedding';
    capacityMode?: 'on-demand' | 'provisioned';
    provisionedUnits?: number;
    tokensPerSecPerUnit?: number;
    slowdownProb?: number;
    contentFilterRate?: number;
    countMaxTokensUpfront?: boolean;
    outputTokens?: LatencyModel;
    responseShape?: 'provider' | 'normalized';
    responseMode?: 'fixed' | 'template' | 'echo' | 'json-fill' | 'tool-call' | 'sequence';
    sequenceResponses?: string[];
    jsonSchema?: Record<string, unknown>;
    jobDurationMs?: number;
    chunkTokens?: number;
    dimensions?: number;
    topK?: number;
    passages?: { id: string; text: string; score: number }[];
  };
  httpAliases?: Record<string, string>;
  storageGb?: number;
  scannedBytes?: number;

  operations: Record<string, OperationOverride>;
  mockEnv?: Record<string, string>;
  scriptId?: string;
  scenarioOverrides?: ScenarioOverride[];

  pricing?: {
    skuKey?: string;
    manualUnitPrice?: number;
    manualUnit?: string;
    manualInputPricePer1M?: number;
    manualOutputPricePer1M?: number;
  };
  notes?: string;
}

/** Override parameters for a single operation on a node. */
export interface OperationOverride {
  latency?: LatencyModel;
  statusCode?: number;
  headers?: Record<string, string>;
  responseTemplate?: string;
  responseSizeBytes?: number;
  errorRate?: number;
  errorKind?: 'throttle' | 'timeout' | 'server' | 'not_found' | 'access_denied' | 'validation';
  inputSchema?: Record<string, unknown>;
}

/** Directed connection between two nodes on the canvas. */
export interface EdgeInstance {
  id: string;
  from: string;
  to: string;
  protocol:
    | 'http'
    | 'https'
    | 'grpc'
    | 'tcp'
    | 'udp'
    | 'amqp'
    | 'kafka'
    | 'sql'
    | 'redis'
    | 'dns'
    | 'internal';
  port?: number;
  callType: 'sync' | 'async';
  weight: number;
  fanOut?: number;
  payloadBytes?: number;
  bandwidthGbps?: number;
  tunnel?: 'none' | 'privatelink' | 'vpn';
  networkLatency?: LatencyModel;
  retry?: { max: number; backoffMs: number; jitter: boolean };
  circuitBreaker?: { failureThreshold: number; windowMs: number; openMs: number };
  label?: string;
  inferred?: boolean;
  confidence?: number;
  reason?: string;
}

/** Hierarchical container group (Region, VPC, Subnet, AZ, Cluster, Compartment). */
export interface GroupInstance {
  id: string;
  kind: 'region' | 'vpc' | 'subnet' | 'az' | 'cluster' | 'zone' | 'compartment' | 'custom';
  label: string;
  provider?: Provider;
  region?: string;
  cidr?: string;
  parentGroupId?: string;
  public?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/** Autoscaling rule configuration for compute/container/database nodes. */
export interface AutoscalingConfig {
  min: number;
  max: number;
  metric: 'cpu' | 'inflight' | 'rps' | 'queue';
  target: number;
  scaleOutCooldownS: number;
  scaleInCooldownS: number;
  warmupS: number;
  checkIntervalS: number;
}

/** Load balancer target health check configuration. */
export interface HealthCheck {
  intervalS: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
  timeoutMs: number;
}

/** Load test scenario combining traffic shape, user flows, and chaos events. */
export interface Scenario {
  id: string;
  name: string;
  durationS: number;
  entryNodeId: string;
  profile: TrafficProfile;
  flows: UserFlow[];
  scriptId?: string;
  thresholds?: Record<string, string[]>;
  chaos: ChaosEvent[];
  seedOverride?: number;
}

/** Arrival rate curve over scenario duration. */
export type TrafficProfile =
  | { kind: 'constant'; rps: number }
  | { kind: 'ramp'; fromRps: number; toRps: number }
  | { kind: 'spike'; baseRps: number; peakRps: number; atS: number; widthS: number }
  | { kind: 'steps'; steps: { atS: number; rps: number }[] }
  | { kind: 'diurnal'; meanRps: number; amplitude: number; periodS: number }
  | { kind: 'custom'; points: { tS: number; rps: number }[] };

/** Weighted user journey executed by simulated clients. */
export interface UserFlow {
  id: string;
  name: string;
  weight: number;
  steps: {
    method: string;
    path: string;
    bodyBytes?: number;
    thinkTimeMs?: number;
    targetNodeId?: string;
  }[];
}

/** Fault or degradation injection event active between atS and atS + durationS. */
export type ChaosEvent =
  | { atS: number; durationS: number; kind: 'kill-instances'; nodeId: string; count: number }
  | { atS: number; durationS: number; kind: 'az-outage'; az: string }
  | { atS: number; durationS: number; kind: 'add-latency'; nodeId: string; extraMs: number }
  | { atS: number; durationS: number; kind: 'error-rate'; nodeId: string; rate: number }
  | { atS: number; durationS: number; kind: 'throttle'; nodeId: string; rps: number }
  | { atS: number; durationS: number; kind: 'cache-flush'; nodeId: string; warmupS: number };

/** User-authored JS or TS handler or k6-style traffic script. */
export interface ScriptAsset {
  id: string;
  name: string;
  kind: 'handler' | 'scenario';
  language: 'javascript' | 'typescript';
  source: string;
  entry: string;
  memoryMb: number;
  timeoutMs: number;
  env: Record<string, string>;
}

/** Known event template identifiers for the payload fixture library. */
export type FixtureTemplateId =
  | 'aws.apigw.proxy.v1'
  | 'aws.apigw.proxy.v2'
  | 'aws.alb.target'
  | 'aws.sqs'
  | 'aws.sns'
  | 'aws.s3.notification'
  | 'aws.dynamodb.stream'
  | 'aws.eventbridge'
  | 'aws.kinesis'
  | 'gcp.http.request'
  | 'gcp.pubsub.push'
  | 'gcp.storage.event'
  | 'azure.http.trigger'
  | 'azure.queue.trigger'
  | 'azure.eventgrid'
  | 'oci.functions.http'
  | 'generic.json';

/** Test payload fixture passed to user handler code in dry-runs and profiling. */
export interface PayloadFixture {
  id: string;
  name: string;
  template?: FixtureTemplateId;
  event: unknown;
  context?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  expectedStatus?: number;
  weight?: number;
}
