# 04 — Data Model

All types live in `packages/shared-types`. Designs are plain JSON, versioned with `schemaVersion`.

## Design document

```ts
export interface Design {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  nodes: NodeInstance[];
  edges: EdgeInstance[];
  groups: GroupInstance[];          // region, vpc, subnet, az, cluster
  network: NetworkConfig;           // see file 13
  scenarios: Scenario[];
  scripts: ScriptAsset[];
  fixtures: PayloadFixture[];
  settings: DesignSettings;
}

export interface DesignSettings {
  seed: number;                     // default 42
  primaryProvider?: Provider;
  currency: 'USD' | 'INR' | 'EUR' | 'GBP';
  fxRateToUSD?: number;             // user-entered, no live FX in v1
  includeFreeTier: boolean;
}

export type Provider = 'aws' | 'gcp' | 'azure' | 'oci' | 'custom' | 'generic';
```

## Nodes and edges

```ts
export interface NodeInstance {
  id: string;
  serviceId: string;                // e.g. "aws.s3" or "custom.my_service"
  label: string;
  position: { x: number; y: number };
  parentGroupId?: string;
  region?: string;                  // provider-native region code
  az?: string;
  config: NodeConfig;
}

export interface NodeConfig {
  // Capacity
  instances: number;                // default 1
  instanceType?: string;            // e.g. "t3.medium" (from price data attributes)
  vcpu?: number;
  memoryGb?: number;
  maxInFlightPerInstance?: number;  // concurrency limit per instance
  cpuMsPerRequest?: number;         // overrides measured/profile value
  queue?: { maxLength: number; policy: 'reject' | 'drop-oldest' };
  autoscaling?: AutoscalingConfig;

  // Latency & errors (overrides catalog defaults)
  latency?: LatencyModel;
  errorRate?: number;               // 0..1 random 5xx
  rateLimit?: { rps?: number; burst?: number; tpm?: number; rpm?: number };
  timeoutMs?: number;
  coldStart?: { enabled: boolean; probabilityModel: 'idle-based' | 'fixed'; p50: number; p95: number };

  // Behavior knobs by kind
  cacheHitRatio?: number;           // cache nodes
  readRatio?: number;               // DB nodes
  connections?: { max: number };    // DB / proxy nodes
  lb?: { algorithm: 'round-robin' | 'least-conn' | 'random'; healthCheck?: HealthCheck; idleTimeoutMs?: number };
  consumer?: { concurrency: number; batchSize: number; pollMs: number; maxRetries: number; dlq: boolean };

  // Mock behavior
  operations: Record<string, OperationOverride>; // key = operation name, e.g. "GetObject"
  mockEnv?: Record<string, string>;
  scriptId?: string;                // attaches user code to a compute node

  // Pricing
  pricing?: { skuKey?: string; manualUnitPrice?: number; manualUnit?: string };
}

export interface LatencyModel {
  distribution: 'lognormal' | 'fixed' | 'normal' | 'bimodal';
  p50: number;
  p95: number;
  // bimodal: second mode (e.g. cache miss / cold start)
  mode2?: { weight: number; p50: number; p95: number };
}

export interface OperationOverride {
  latency?: LatencyModel;
  statusCode?: number;
  headers?: Record<string, string>;
  responseTemplate?: string;        // template syntax in file 06
  responseSizeBytes?: number;
  errorRate?: number;
  errorKind?: 'throttle' | 'timeout' | 'server' | 'not_found' | 'access_denied' | 'validation';
  inputSchema?: object;             // JSON Schema for request validation
}

export interface EdgeInstance {
  id: string;
  from: string;
  to: string;
  protocol: 'http' | 'https' | 'grpc' | 'tcp' | 'udp' | 'amqp' | 'kafka' | 'sql' | 'redis' | 'dns' | 'internal';
  port?: number;
  callType: 'sync' | 'async';
  weight: number;                   // routing probability among sibling edges, default 1
  fanOut?: number;                  // calls per request, default 1
  payloadBytes?: number;
  networkLatency?: LatencyModel;    // overrides computed latency
  retry?: { max: number; backoffMs: number; jitter: boolean };
  circuitBreaker?: { failureThreshold: number; windowMs: number; openMs: number };
  label?: string;
}

export interface GroupInstance {
  id: string;
  kind: 'region' | 'vpc' | 'subnet' | 'az' | 'cluster' | 'zone' | 'custom';
  label: string;
  provider?: Provider;
  region?: string;
  cidr?: string;
  parentGroupId?: string;
  public?: boolean;                 // subnet hint; real value derived from routes
}

export interface AutoscalingConfig {
  min: number; max: number;
  metric: 'cpu' | 'inflight' | 'rps' | 'queue';
  target: number;                   // e.g. 0.6 for 60% cpu
  scaleOutCooldownS: number; scaleInCooldownS: number;
  warmupS: number;                  // scale-out lag before new instance serves
  checkIntervalS: number;
}
export interface HealthCheck { intervalS: number; unhealthyThreshold: number; healthyThreshold: number; timeoutMs: number }
```

## Scenarios (traffic)

```ts
export interface Scenario {
  id: string; name: string;
  durationS: number;
  entryNodeId: string;              // a Client / Load Generator node
  profile: TrafficProfile;
  flows: UserFlow[];                // weighted user journeys
  scriptId?: string;                // k6-style scenario script (file 12)
  chaos: ChaosEvent[];
  seedOverride?: number;
}

export type TrafficProfile =
  | { kind: 'constant'; rps: number }
  | { kind: 'ramp'; fromRps: number; toRps: number }
  | { kind: 'spike'; baseRps: number; peakRps: number; atS: number; widthS: number }
  | { kind: 'steps'; steps: { atS: number; rps: number }[] }
  | { kind: 'diurnal'; meanRps: number; amplitude: number; periodS: number }
  | { kind: 'custom'; points: { tS: number; rps: number }[] };

export interface UserFlow {
  id: string; name: string; weight: number;
  steps: { method: string; path: string; bodyBytes?: number; thinkTimeMs?: number; targetNodeId?: string }[];
}

export type ChaosEvent =
  | { atS: number; durationS: number; kind: 'kill-instances'; nodeId: string; count: number }
  | { atS: number; durationS: number; kind: 'az-outage'; az: string }
  | { atS: number; durationS: number; kind: 'add-latency'; nodeId: string; extraMs: number }
  | { atS: number; durationS: number; kind: 'error-rate'; nodeId: string; rate: number }
  | { atS: number; durationS: number; kind: 'throttle'; nodeId: string; rps: number };
```

## Scripts and fixtures

```ts
export interface ScriptAsset {
  id: string; name: string;
  kind: 'handler' | 'scenario';
  language: 'javascript';
  source: string;
  entry: string;                    // "handler" for handlers; "default" for scenarios
  memoryMb: number;                 // simulated memory size
  timeoutMs: number;
  env: Record<string, string>;
}

export interface PayloadFixture {
  id: string; name: string;
  template?: FixtureTemplateId;     // e.g. "aws.apigw.proxy.v2"
  event: unknown;                   // JSON event passed to handler
  context?: Record<string, unknown>;
  schema?: object;                  // optional JSON Schema
  expectedStatus?: number;
}
```

## Simulation output

```ts
export interface SimFrame {
  runId: string; tVirtualMs: number;
  nodes: Record<string, NodeFrame>;
  edges: Record<string, EdgeFrame>;
  particles: Particle[];            // sampled requests for animation (≤ 300)
  newLogs: LogEntry[];              // new since previous frame
}

export interface NodeFrame {
  utilization: number;              // 0..>1  (busy / capacity)
  cpuUtilization?: number;
  inFlight: number; queueDepth: number;
  rpsIn: number; rpsOut: number;
  errorsPerSec: Record<ErrorKind, number>;
  dropsPerSec: number;
  latency: { p50: number; p95: number; p99: number };
  instancesActive: number; instancesTotal: number;
  health: 'ok' | 'warm' | 'hot' | 'overloaded' | 'down';  // thresholds in file 05 §9
  throttle?: { limit: number; used: number };
}

export type ErrorKind = 'timeout' | 'throttled' | 'server' | 'conn_refused' | 'conn_timeout'
  | 'dropped_queue_full' | 'circuit_open' | 'user_code' | 'not_reachable';

export interface EdgeFrame { rps: number; errorRate: number; avgLatencyMs: number }
export interface Particle { id: string; edgeId: string; progress: number; status: 'ok' | 'slow' | 'error'; traceId: string }

export interface SimulationResult {
  runId: string; seed: number; scaled: { factor: number } | null;
  summary: { totalRequests: number; success: number; errors: Record<ErrorKind, number>; p50: number; p95: number; p99: number; throughputRps: number };
  perNode: Record<string, NodeSummary>;
  series: TimeSeries;               // 1 s buckets
  bottleneckNodeId?: string;
  traces: Trace[];                  // reservoir-sampled, ≤ 200
  counters: UsageCounters;          // feeds cost engine
  insights: Insight[];              // from diagnosis package
}

export interface Trace { traceId: string; flowId?: string; startMs: number; totalMs: number; status: 'ok' | 'error'; spans: Span[] }
export interface Span { spanId: string; parentId?: string; nodeId: string; operation?: string; startMs: number; waitMs: number; serviceMs: number; status: 'ok' | ErrorKind; attrs?: Record<string, string | number> }

export interface UsageCounters {
  perNode: Record<string, {
    requests: number; instanceSeconds: number; bytesIn: number; bytesOut: number;
    tokensIn?: number; tokensOut?: number; readUnits?: number; writeUnits?: number; gbSeconds?: number;
  }>;
  perEdge: Record<string, { bytes: number; crossAz: boolean; crossRegion: boolean; viaNat: boolean }>;
}

export interface LogEntry {
  id: number;                       // monotonic
  tVirtualMs: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'user' | 'platform' | 'engine';
  nodeId?: string; requestId?: string; traceId?: string;
  message: string;
  data?: unknown;                   // structured payload
}
```

## Insight

```ts
export interface Insight {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  nodeIds: string[];
  title: string; explanation: string; // short + deep versions in explanation.short/deep
  fixes: FixSuggestion[];
  lessonSlug?: string;
}
export interface FixSuggestion { label: string; patch: JsonPatchOp[] } // applied to Design with one click
```

## Custom service (user-created)

Same shape as a catalog entry (file 06) with `id` prefixed `custom.` and `ownerId`.

## Postgres schema (Laravel migrations)

```sql
users(id, name, email unique, password, created_at, updated_at)

designs(id uuid pk, user_id fk, name, doc jsonb, schema_version int, version int default 1,
        visibility text default 'private', share_token text unique null,
        created_at, updated_at, deleted_at)
design_versions(id, design_id fk, version int, doc jsonb, created_at)

custom_services(id uuid pk, user_id fk, service_id text unique, definition jsonb, created_at, updated_at)
fixtures(id uuid pk, user_id fk, name, template text null, event jsonb, schema jsonb null, created_at, updated_at)

price_snapshots(id, provider text, fetched_at timestamptz, source_url text, raw_hash text, status text)
prices(id, snapshot_id fk, provider, service_id text, sku_key text, region text, unit text,
       unit_price numeric(20,10), currency text default 'USD', tier_min numeric null, tier_max numeric null,
       attrs jsonb)                       -- vcpu, memory_gb, os, etc.
  index (provider, service_id, region), index (sku_key)
price_sku_map(id, service_id text, provider, filter jsonb, unit_role text)  -- maps catalog service -> SKU filter

challenges(id, slug unique, title, difficulty, definition jsonb, published bool)
challenge_attempts(id, user_id fk, challenge_id fk, design_doc jsonb, seed int, score numeric, passed bool, result_summary jsonb, created_at)
```

Rules: optimistic locking on `designs.version`; soft delete; `doc` validated by JSON Schema generated from the TS types (use `ts-json-schema-generator` in CI).

## Example: tiny design (for tests and docs)

```json
{
  "schemaVersion": 1, "id": "d1", "name": "Hello 3-tier",
  "nodes": [
    {"id":"c","serviceId":"generic.client","label":"Users","position":{"x":0,"y":0},"config":{"instances":1,"operations":{}}},
    {"id":"lb","serviceId":"aws.alb","label":"ALB","position":{"x":200,"y":0},"config":{"instances":1,"operations":{}}},
    {"id":"app","serviceId":"aws.ec2","label":"API","position":{"x":400,"y":0},"config":{"instances":2,"vcpu":2,"cpuMsPerRequest":8,"operations":{}}},
    {"id":"db","serviceId":"aws.rds_postgres","label":"Postgres","position":{"x":600,"y":0},"config":{"instances":1,"connections":{"max":100},"operations":{}}}
  ],
  "edges": [
    {"id":"e1","from":"c","to":"lb","protocol":"https","port":443,"callType":"sync","weight":1},
    {"id":"e2","from":"lb","to":"app","protocol":"http","port":8080,"callType":"sync","weight":1},
    {"id":"e3","from":"app","to":"db","protocol":"sql","port":5432,"callType":"sync","weight":1}
  ],
  "groups": [], "network": {}, "scenarios": [], "scripts": [], "fixtures": [],
  "settings": {"seed":42,"currency":"USD","includeFreeTier":false}
}
```
