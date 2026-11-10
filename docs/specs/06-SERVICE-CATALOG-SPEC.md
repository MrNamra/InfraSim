# 06 — Service Catalog Spec

The catalog describes every service a user can drop on the canvas: what it is, how it behaves in the simulator, its default response time, its mock operations, and how it is priced. Provider tables are in files 07–10. This file defines the **format, mock behavior, user editing, and build pipeline**.

> **All latencies, quotas and capacities are illustrative defaults, not benchmarks.** The UI labels them "typical default — edit me".

## 1. Catalog entry schema

```ts
export interface ServiceDefinition {
  id: string;                         // "aws.s3", "custom.payment_gateway"
  provider: Provider;
  name: string;
  category: Category;                 // from the section header in the provider file
  kind: MockKind;                     // drives engine behavior (file 05 §6)
  description: string;                // 1 line, shown in palette tooltip
  scope: 'regional' | 'zonal' | 'global';
  latency: LatencyModel;              // default service-side latency per typical call
  capacity: CapacitySpec;
  coldStart?: { p50: number; p95: number; idleTtlS: number };
  scaleOutLagS?: number;              // time before new capacity serves (autoscaling)
  failure: { errorRate: number; kinds: ErrorKindDef[] };   // default 0.0005 5xx
  limits?: QuotaSpec[];               // soft quotas worth modeling (rate limits, concurrency)
  operations: OperationDef[];         // mock operations with default responses
  pricing: { model: PriceModel; skuKey?: string };         // file 14
  equivalents?: Partial<Record<Provider, string>>;         // cross-cloud mapping
  ports?: { protocol: string; port: number }[];           // listening ports for reachability (file 13)
  tags?: string[]; icon: string; docsUrl?: string;
}

export type CapacitySpec =
  | { type: 'elastic' }                              // scales invisibly, no practical limit
  | { type: 'slots'; fromInstanceType: true }        // derived from instances × runtime preset
  | { type: 'conc'; limit: number; onLimit: 'throttle' | 'queue' }
  | { type: 'rps'; limit: number; burst?: number }
  | { type: 'units'; read: number; write: number }   // RCU/WCU, RU/s
  | { type: 'conn'; formula?: string; default: number }
  | { type: 'tpm'; rpm?: number; tpm?: number }      // AI quotas
  | { type: 'passthrough' };

export interface OperationDef {
  name: string;                       // "GetObject"
  summary: string;
  latency?: LatencyModel;             // overrides service latency
  inputSchema?: object;               // JSON Schema (for payload validation)
  defaultResponse: { statusCode: number; headers?: Record<string, string>; bodyTemplate: string; sizeBytes?: number };
  errors: { kind: ErrorKind; statusCode: number; name: string; message: string; defaultRate: number }[];
  idempotent?: boolean;
  units?: { read?: number; write?: number };  // consumed capacity per call
}
```

## 2. Catalog tables (source of truth)

Files 07–10 contain Markdown tables with **exactly** these columns (a parser relies on them):

```
| ID | Name | p50 | p95 | Cap | Mock | Price |
```

- **Section headers (`### Category`)** set `category` for the rows beneath.
- **p50 / p95**: milliseconds, service-side latency for one typical call.
- **Cap** grammar: `elastic` · `slots` · `conc=N` · `conc=N/queue` · `rps=N` · `units` · `conn` · `tpm` · `pass`.
- **Mock** values: see §3.
- **Price** values: the full code list is in file 14 §3 (`hr`, `vcpu-gb-hr`, `req`, `fn`, `gb-mo`, `gb-xfer`, `tok`, `unit`, `ru`, `rcu-wcu`, `shard-hr`, `lcu`, `msg`, `query-tb`, `acu-hr`, `mau`, `mix`, `flat`, `free`).
- Optional per-provider "Serverless & scaling extras" table gives `coldStart`, `concurrency`, `maxTimeout`, `scaleOutLagS`.
- **Parser rule:** the extras table also starts rows with a service ID and has 7 columns, so the parser MUST decide the table type from its **header row**, never from row shape:
  - Services table header: `| ID | Name | p50 | p95 | Cap | Mock | Price |`
  - Extras table header: `| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |`
  - Any other table (e.g. quotas, notes) is ignored by the build script.
  The initial catalogs contain **243 services** (AWS 77, GCP 53, Azure 63, OCI 50); CI should assert the parsed count matches the table rows.
- Optional "Quotas to model" lists become `limits`.

### Build pipeline

`scripts/build-catalog.ts`:
1. Parse tables from files 07–10.
2. Merge defaults from `packages/catalog/defaults/<kind>.json` (operations, error kinds, response templates per kind — §3).
3. Validate against `catalog.schema.json`.
4. Write `packages/catalog/data/{aws,gcp,azure,oci}.json` + `index.json` (id → file).
5. CI fails if: duplicate IDs, p95 < p50, unknown `Mock`/`Price` code, missing `equivalents` key without `equivalents: none`, or a row has no icon mapping (use a generic icon fallback; warn only).

## 3. Mock kinds and their default operations

Each kind provides default operations, request shapes, success responses and error kinds. Provider catalogs inherit and may override.

| Kind | Meaning | Default operations | Typical errors |
|---|---|---|---|
| `compute` | Hosts user code (VM, container, pod, PaaS) | `Invoke` (HTTP request to your handler) | 500 user code, 503 overloaded, 504 timeout |
| `fn` | Serverless function | `Invoke`, `InvokeAsync` | 429 throttle, 502 handler error, 504 timeout, cold start |
| `lb` | Load balancer | `Forward` | 502, 503 no healthy targets, 504 |
| `gw` | API gateway | `Forward` | 429, 502, 504, 403 |
| `cdn` | CDN | `Get` (hit/miss) | 502, 504 |
| `dns` | DNS | `Resolve` | NXDOMAIN, SERVFAIL |
| `net` | Network pass-through (NAT, IGW, peering, VPN, firewall) | — | drops (reachability) |
| `object` | Object storage | `GetObject`, `PutObject`, `DeleteObject`, `ListObjects`, `HeadObject` | 404, 403, 503 slow down |
| `block` / `file` | Disks / file systems | `Read`, `Write` | IO throttle |
| `sql` | Relational DB | `Query`, `Exec`, `Transaction` | connection limit, timeout, deadlock (opt.) |
| `kv` | Key-value / wide-column | `GetItem`, `PutItem`, `UpdateItem`, `Query`, `Scan`, `BatchWrite` | throughput exceeded, 404, conditional check failed |
| `doc` | Document DB | `Find`, `Insert`, `Update`, `Aggregate` | RU/throttle, timeout |
| `cache` | In-memory cache | `Get`, `Set`, `Del` | timeout, eviction |
| `graph` / `ts` / `olap` | Specialized DBs / analytics | `Query` | timeout |
| `search` | Search engine | `Search`, `Index` | 429 rejected, 503 |
| `queue` | Message queue | `Send`, `Receive`, `Delete` | throttle, empty receive |
| `topic` | Pub/sub topic | `Publish` | throttle |
| `stream` | Event stream | `PutRecord`, `GetRecords` | provisioned throughput exceeded |
| `bus` | Event bus | `PutEvents` | throttle |
| `workflow` | Orchestrator | `StartExecution`, `Describe` | state timeout |
| `auth` | Identity | `Login`, `VerifyToken`, `Refresh` | 401, 429 |
| `secret` / `kms` | Secrets / keys | `GetSecret`, `Decrypt`, `Encrypt` | 403, throttle |
| `email` | Email | `Send` | throttle, bounce (opt.) |
| `async` | Long-running job | `Start`, `GetStatus` | job failed |
| `llm` | Large language model | `Invoke`, `InvokeStream`, `Embed` | 429 TPM/RPM, 400 context too long, 5xx |
| `ml` | Model inference endpoint | `Predict` | 429, 5xx, cold scale-from-zero |
| `vision` / `speech` / `text-ai` / `doc-ai` | AI APIs | `Analyze`, `Transcribe`, `Synthesize`, `Translate`, `Extract` | 429, 400 bad input |
| `bot` | Conversational AI | `Converse` | 429 |

Per-kind default bodies live in `packages/catalog/defaults/<kind>.json`. Example for `object.GetObject`:

```json
{ "statusCode": 200,
  "headers": { "content-type": "application/octet-stream", "etag": "\"{{faker.hex(32)}}\"" },
  "bodyTemplate": "{{binary(sizeBytes)}}", "sizeBytes": 20480 }
```

## 4. Response templating

Templates are strings (usually JSON) with `{{ ... }}` expressions. Evaluation MUST be pure and seeded (no real time/randomness).

| Expression | Result |
|---|---|
| `{{input.path.to.field}}` | value from the call's input (JSON path) |
| `{{env.NAME}}` | mock env var |
| `{{seq}}` | per-node monotonically increasing integer |
| `{{now}}` / `{{now.iso}}` | virtual time (ms / ISO string) |
| `{{faker.uuid}}`, `{{faker.name}}`, `{{faker.email}}`, `{{faker.int(1,100)}}`, `{{faker.hex(n)}}`, `{{faker.pick("a","b")}}` | seeded fake data |
| `{{binary(n)}}` | n bytes of placeholder data (not materialized; only size is tracked) |
| `{{repeat(n, "{...}")}}` | repeat a JSON fragment n times (arrays, e.g. 20 DB rows) |
| `{{json(input)}}` | echo input as JSON |
| `{{tokens(n)}}` | n tokens of filler text (AI, file 11) |

Invalid templates are rejected on save with a line/column error. Output size is capped at 1 MB.

## 5. User editing (the "Latency & Mock" tab)

Every catalog value is editable per node instance without changing the catalog:

1. **Service level**: p50, p95, distribution, error rate, capacity/limits, timeout, cold start.
2. **Operation level**: latency override, status code, headers, response template, response size, error rate/kind, input JSON Schema.
3. **Scenario level** (optional, per scenario): time-boxed overrides, e.g. "DB p95 = 800 ms from t=30 s to t=60 s".
4. **Reset to default** per field and per node. **Save as preset** → stored as a user preset (`custom_presets`) and appears in the node's "Presets" menu.
5. **Validation**: p95 ≥ p50; rates in [0,1]; templates parse; schema valid. Show inline errors, never silently clamp.
6. Edited fields show a dot indicator and "edited" tooltip showing the default.

## 6. Custom services ("add any service")

Users can create `custom.*` services:
- Choose a **base kind** (e.g. `kv`, `queue`, `llm`, `compute`, `generic http`), name, icon, and color.
- Set latency, capacity, error rate, ports, price (manual unit price + unit, so cost works without a sync).
- Define operations with request schema and response template.
- Optionally copy from an existing catalog service ("Duplicate and edit").
- Stored in `custom_services` (file 04). Shareable with a design (embedded in `design.doc` as `customServices` so shared links work).
- A catalog row for a third-party SaaS (Stripe, Twilio, an external REST API) is simply a custom `compute`/`generic http` service.

## 7. Network & placement latency defaults

Used for edges (editable per edge; see file 05 §2):

| Placement | p50 (ms) | p95 (ms) |
|---|---|---|
| Same host / same pod | 0.1 | 0.3 |
| Same AZ | 0.4 | 1.2 |
| Cross-AZ, same region | 1.2 | 3.0 |
| Cross-region, same continent | 30 | 80 |
| Cross-region, intercontinental | 120 | 250 |
| Client ↔ nearest edge/CDN POP | 20 | 80 |
| Client ↔ origin region (no CDN), same continent | 50 | 150 |
| Client ↔ origin region, intercontinental | 150 | 350 |
| Private link / peering extra | +0.3 | +0.8 |
| Over VPN | +10 | +30 |

Cross-AZ and cross-region traffic also set cost-counter flags (file 14). Default bandwidth for transfer-time calculation: 1 Gbps (editable).

## 8. Cross-cloud equivalents (starter set; extend in tables)

Used for the "Switch provider" feature (keep topology, swap services) and for cost comparison.

| Role | AWS | GCP | Azure | OCI |
|---|---|---|---|---|
| VM | `aws.ec2` | `gcp.compute_engine` | `azure.vm` | `oci.compute` |
| Serverless fn | `aws.lambda` | `gcp.cloud_functions` | `azure.functions` | `oci.functions` |
| Container (serverless) | `aws.fargate` | `gcp.cloud_run` | `azure.container_apps` | `oci.container_instances` |
| Kubernetes | `aws.eks` | `gcp.gke` | `azure.aks` | `oci.oke` |
| L7 LB | `aws.alb` | `gcp.lb_https` | `azure.app_gateway` | `oci.load_balancer` |
| L4 LB | `aws.nlb` | `gcp.lb_network` | `azure.load_balancer` | `oci.network_lb` |
| CDN | `aws.cloudfront` | `gcp.cloud_cdn` | `azure.front_door` | none (use a `custom.cdn` service) |
| API gateway | `aws.apigw_http` | `gcp.api_gateway` | `azure.apim` | `oci.api_gateway` |
| Object storage | `aws.s3` | `gcp.cloud_storage` | `azure.blob` | `oci.object_storage` |
| Relational DB | `aws.rds_postgres` | `gcp.cloud_sql_postgres` | `azure.postgres_flexible` | `oci.mysql_heatwave` (closest) |
| KV/NoSQL | `aws.dynamodb` | `gcp.firestore` / `gcp.bigtable` | `azure.cosmos_db` | `oci.nosql` |
| Redis cache | `aws.elasticache_redis` | `gcp.memorystore_redis` | `azure.redis_cache` | `oci.cache_redis` |
| Queue | `aws.sqs` | `gcp.cloud_tasks` | `azure.service_bus` | `oci.queue` |
| Pub/sub | `aws.sns` | `gcp.pubsub` | `azure.event_grid` | `oci.notifications` |
| Stream | `aws.kinesis` | `gcp.pubsub` | `azure.event_hubs` | `oci.streaming` |
| Secrets | `aws.secrets_manager` | `gcp.secret_manager` | `azure.key_vault` | `oci.vault_secrets` |
| LLM | `aws.bedrock` | `gcp.vertex_gemini` | `azure.openai` | `oci.genai` |
| Search | `aws.opensearch` | `gcp.vertex_search` | `azure.ai_search` | `oci.opensearch` |
| Auth | `aws.cognito` | `gcp.identity_platform` | `azure.entra_b2c` | `oci.identity_domains` |

Equivalence is approximate. When swapping, the UI shows a diff of behavior differences (e.g. "S3 has per-prefix limits; Cloud Storage scales differently").

## 9. Catalog quality rules

- Every service MUST have at least one operation (use `Forward`/`Invoke` for pass-through kinds).
- Every row MUST map to a kind that exists in §3.
- Prefer one row per **behavioral** unit (e.g. "RDS PostgreSQL" and "Aurora PostgreSQL" are separate because latency/capacity differ).
- Quotas: values in provider files are starting points. The agent MUST verify against current provider docs before shipping and record the date and source in `packages/catalog/SOURCES.md`.
