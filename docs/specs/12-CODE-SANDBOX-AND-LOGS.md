# 12 — Code Sandbox, Test Payloads, Mock SDK and Logs

Package: `packages/sandbox`. Runs user JavaScript/TypeScript safely in the browser, wires it to **mocked cloud services**, helps users craft **test payloads so their code does not throw**, and shows **logs**.

## 1. Goals

1. User pastes a handler (even code written for the real AWS/GCP/Azure/OCI SDKs) and it runs against mocks with no edits.
2. User picks or edits a **test payload** (event) and runs the handler once to see: result, logs, errors, detected service calls, virtual duration.
3. When code crashes because a mocked response lacks a field, the tool tells the user exactly which field and offers a one-click fix (**auto-fill mock from my code**).
4. User writes a **traffic script** (k6-style) to describe user journeys and thresholds.
5. Everything is deterministic and isolated. No real network, no real cloud, no host access.

## 2. Script kinds

| Kind | Purpose | Entry |
|---|---|---|
| `handler` | Code that runs on a compute/serverless node | `handler(event, context)` or `fetch(request, env)` or `(req, res)` |
| `scenario` | Traffic generator at a Client node | `export default function () {}` + optional `options` |

Languages: JavaScript and TypeScript (types stripped with `esbuild-wasm`; no type checking required, but Monaco shows TS diagnostics). Other languages: users type `cpuMsPerRequest` and per-call latencies manually (the node has no script).

## 3. Runtime architecture

- **Where:** a dedicated Web Worker (`sandbox.worker`) hosting **QuickJS compiled to WASM** (`quickjs-emscripten`). User code never touches the main thread, DOM, or real `fetch`.
- **Virtual time:** the host owns a virtual clock. In the guest, `Date.now()`, `new Date()`, `performance.now()`, `setTimeout/setInterval/setImmediate`, and `await sleep()` use virtual time. The host runs a mini event loop:
  1. Execute all pending guest jobs (microtasks).
  2. If idle and timers/mock-calls are pending, **advance virtual time to the earliest one** and resolve it.
  3. Repeat until the handler's promise settles, the function timeout is exceeded (virtual), or the CPU budget is exceeded (real).
  This makes `Promise.all([...])` cost `max(latencies)` and sequential awaits cost `sum(latencies)` automatically, with no real waiting.
- **Seeded randomness:** `Math.random()` and `crypto.randomUUID()` are seeded (labelled "not secure" in docs).
- **Module system:** user code is bundled with `esbuild-wasm` into one script. Imports resolve only to the **allow-list** (§5) or to relative files in the design's script set. Anything else → `UnsupportedModule` error listing available modules.
- **Environment:** `process.env` = node's `mockEnv` + defaults (`AWS_REGION`, `GCP_PROJECT`, etc. derived from the node's region). `process.exit`, `child_process`, `fs` (except in-memory `/tmp`, 64 MB), `net`, `http` are stubs that throw a clear "not available in the simulator" error.

## 4. Handler contracts

**Lambda-style (default)**
```js
export async function handler(event, context) {
  console.log("event", event);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
```
`context`: `awsRequestId`, `functionName`, `memoryLimitInMB`, `invokedFunctionArn` (mock), `getRemainingTimeInMillis()` (virtual), `logGroupName`, `callbackWaitsForEmptyEventLoop`.

**Web-fetch style** (Cloud Run / Workers / Azure-like): `export default { async fetch(request, env, ctx) { return new Response("ok") } }` with minimal `Request`/`Response`/`Headers`/`URL` implementations.

**Express-like**: `(req, res) => { res.status(200).json({...}) }` with minimal `req.body/headers/query/params` and `res.status/json/send/set`.

An adapter turns the node's trigger into the right input (e.g. ALB/API Gateway event vs HTTP request), using fixture templates (§7).

## 5. Mock SDK

### 5.1 Universal API (always available)
```js
const res = await cloud.call("aws.s3", "GetObject", { Bucket: "b", Key: "k" });
// cloud.call(serviceId, operation, input, { region?, alias? }) → response body (provider-shaped)
```
Resolution: the call targets a node reachable by an outgoing edge from the handler node whose `serviceId` matches (file 05 §3). In standalone dry runs (no design context) the catalog default mock is used.

### 5.2 Drop-in SDK shims (paste real code)
Import specifiers are mapped to shims that translate to `cloud.call`:

| Import | Shim behavior |
|---|---|
| `@aws-sdk/client-*` (generic) | `new XClient(cfg)`; `client.send(new YCommand(input))` → `cloud.call("aws.<x>", "Y", input)` (service resolved from package name via alias table) |
| `@aws-sdk/lib-dynamodb` | `DynamoDBDocumentClient.from(client)` + `GetCommand/PutCommand/QueryCommand/UpdateCommand/DeleteCommand` → `aws.dynamodb` ops |
| `@aws-sdk/client-bedrock-runtime` | `InvokeModelCommand`, `ConverseCommand`, `ConverseStreamCommand` → `aws.bedrock` |
| `@google-cloud/storage`, `@google-cloud/pubsub`, `@google-cloud/firestore`, `@google-cloud/secret-manager`, `@google-cloud/vertexai` | Class-based shims → `gcp.*` ops |
| `@azure/storage-blob`, `@azure/cosmos`, `@azure/service-bus`, `@azure/keyvault-secrets`, `openai` (Azure config) | Shims → `azure.*` ops |
| `oci-objectstorage`, `oci-generativeaiinference`, `oci-queue` (names to verify) | Shims → `oci.*` ops |
| `axios`, `node-fetch`, global `fetch` | Routed through the **HTTP interceptor** (§5.3) |
| `uuid`, `lodash`, `dayjs`, `zod`, `ajv` | Bundled pure-JS allow-list modules |

Unknown SDK package or service not in the catalog → `UnsupportedModule` / `MockNotConfigured` with the exact message: *"No mock for X. Add a service or edge to enable it."* Never fall through to the real network.

### 5.3 HTTP interceptor
`fetch("https://...")` is matched to mock services by host patterns (`*.amazonaws.com`, `storage.googleapis.com`, `*.blob.core.windows.net`, `*.oraclecloud.com`, …) or by **alias** (user can map `https://payments.internal/*` to a custom service). Unmatched URLs → `MockNotConfigured` (listing how to add an alias). Response = service operation mock; status/headers/body from the template; latency from config.

### 5.4 What a mocked call does
1. Validate input against the operation's `inputSchema` (if any) → on failure throws provider-shaped `ValidationException` (helps users learn required fields).
2. Check rate limit/quota (token buckets) → maybe throw throttle error.
3. Roll `errorRate` → maybe throw server error (seeded).
4. Sample latency (operation → service → default) and advance **virtual** time.
5. Render response template; wrap in the SDK-appropriate shape.
6. Record the call in the invocation's **call log** (service, op, input, output, latency, error).

### 5.5 Error objects thrown to user code
Match common SDK conventions so `catch` blocks work:
```js
{ name: "ThrottlingException", message: "...", code: "ThrottlingException",
  $metadata: { httpStatusCode: 429, requestId: "..." }, $retryable: { throttling: true }, statusCode: 429 }
```
Each provider shim adds its own conventions (`error.code`, `error.details`, `RestError.statusCode`, etc.).

## 6. "Don't throw" tooling for test payloads

### 6.1 Payload Tester panel
Flow: **choose handler → choose fixture → Run**. Panel sections:

| Section | Content |
|---|---|
| Result | Return value (pretty JSON), HTTP status if applicable, virtual duration, billed duration, memory estimate |
| Status banner | ✅ Success / ❌ Error (category + one-line cause) / ⏱ Timeout / 🚫 Throttled |
| Logs | Console + platform logs for this invocation (§9) |
| Detected calls | Table of every mock call: #, service, operation, input (collapsible), latency, outcome, **[Edit mock]** |
| Diagnostics | Payload Doctor messages (§6.3) |

Buttons: **Run**, **Run again (new seed)**, **Run all fixtures**, **Auto-fill mocks from my code**, **Save as fixture**.

### 6.2 Auto-fill mocks from my code
Problem: handler reads `res.Item.userId` but the mock returned `{}` → `TypeError`.

Algorithm ("path discovery run"):
1. Run the handler once in **discovery mode**: every mock response is returned as an auto-vivifying **guest Proxy** that records every property path read (`Item.userId`, `Items[0].price`, `Body`, `choices[0].message.content`) and tolerates reads of missing fields (returns another Proxy; coerces to `""`/`0`/`false` as needed).
2. Collect accessed paths per `(service, operation)`.
3. Generate a response template that contains those paths with seeded fake values chosen by name heuristics:

| Path name matches | Value |
|---|---|
| `id`, `*Id`, `*_id`, `uuid` | `{{faker.uuid}}` |
| `email` | `{{faker.email}}` |
| `name`, `title` | `{{faker.name}}` |
| `count`, `total`, `quantity`, `size`, `age` | `{{faker.int(1,100)}}` |
| `price`, `amount`, `score` | number with 2 decimals |
| `is*`, `has*`, `enabled`, `*Flag` | `true` |
| `*At`, `*Date`, `timestamp`, `created`, `updated` | `{{now.iso}}` |
| `Items`, `items`, `records`, `results`, `rows`, `data` (iterated) | array of 3 objects built from sub-paths |
| anything else | string `"sample"` |

4. Show a **diff preview** (current mock vs generated) → user clicks **Apply** (writes to the operation's `responseTemplate` on the node).
5. Re-run in normal mode to confirm no error.

### 6.3 Payload Doctor (rule-based hints)
When an invocation fails, map the error + stack + event shape to hints. Examples (each rule has id, trigger, message, optional patch):

| Rule | Trigger | Message / fix |
|---|---|---|
| `apigw-body-string` | `JSON.parse` not called; error reading property of string `event.body` | "In API Gateway proxy events `body` is a **string**. Use `JSON.parse(event.body)`." |
| `null-query-params` | `Object.keys(null)` / reading from `event.queryStringParameters` | "`queryStringParameters` is `null` when no query string is sent. Use `event.queryStringParameters ?? {}`." |
| `v2-http-method` | reading `event.httpMethod` on v2 payload | "HTTP API v2 uses `event.requestContext.http.method`." |
| `sqs-body-string` | reading `Records[0].body.x` | "SQS record `body` is a string; parse it." |
| `s3-key-encoded` | key mismatch with spaces | "S3 event keys are URL-encoded; use `decodeURIComponent(key.replace(/\+/g,' '))`." |
| `base64-body` | `isBase64Encoded: true` | "Decode with `Buffer.from(body,'base64')`." |
| `headers-case` | `event.headers['Content-Type']` undefined | "v2/ALB lowercase header names are common; read case-insensitively." |
| `missing-mock-field` | TypeError on mock response path | "The mock for `aws.dynamodb.GetItem` has no `Item`. [Auto-fill mock]" |
| `missing-env` | `undefined` env used in URL/client | "Set `TABLE_NAME` in node environment." |
| `timeout-short` | virtual time exceeded `timeoutMs` while awaiting mock | "Task timed out after N s because `<service>` took M ms. Increase timeout or reduce latency." |
| `unhandled-rejection` | rejection without catch | "Add `try/catch` or `.catch()`; AWS reports this as a failed invocation." |
| `module-unavailable` | `UnsupportedModule` | "X isn't available in the simulator; available: …" |

Hints are data (JSON rules) so they can grow without code changes.

### 6.4 Fixtures (test payloads)
- Library of **event templates** (editable JSON): `aws.apigw.proxy.v1`, `aws.apigw.proxy.v2`, `aws.alb.target`, `aws.sqs`, `aws.sns`, `aws.s3.notification`, `aws.dynamodb.stream`, `aws.eventbridge`, `aws.kinesis`, `gcp.http.request`, `gcp.pubsub.push`, `gcp.storage.event`, `azure.http.trigger`, `azure.queue.trigger`, `azure.eventgrid`, `oci.functions.http`, `generic.json`.
- Each fixture: name, event JSON, optional context, optional JSON Schema, optional `expectedStatus`, **weight** (for load profiling).
- JSON editor with schema validation; "Generate from schema" button (seeded fake data).
- **Test suite mode**: run all fixtures and show pass/fail vs `expectedStatus` (and "no exception").
- Fixtures persist with the design and can be saved to the user's library (`fixtures` table).

## 7. Error categories

| Category | Cause | Display |
|---|---|---|
| `UserCodeError` | Uncaught exception in user code | Message, stack mapped to editor lines via source maps; Monaco marker |
| `UnhandledRejection` | Promise rejected, no handler | Same as above |
| `Timeout` | Virtual time > `timeoutMs` | Provider-style message, e.g. "Task timed out after 3.00 seconds" |
| `OutOfMemory` | Guest heap > `memoryMb` limit | "Memory limit exceeded (N MB)" |
| `CpuBudgetExceeded` | Real CPU budget (default 2 s per invocation, 20 s per profile run) | "Possible infinite loop — stopped" |
| `MockNotConfigured` | Call to service/URL without a mock | Actionable message + "Add edge/service" button |
| `MockServiceError` | Injected throttle/server/validation error | Provider-shaped error; shows which config caused it |
| `ValidationError` | Payload fails JSON Schema | List of paths |
| `UnsupportedModule` | Import not in allow-list | Available modules list |

## 8. Profiling → call plan (how code feeds the load test)

Running real code for every simulated request does not scale. Instead:

1. **Profile**: run the handler `N` times (default 50, max 500) over fixtures (by weight) with different seeds in the sandbox.
2. Per invocation record: guest CPU time (interpreter ticks → ms), the **call tree** (service, op, payload bytes), **parallel groups** (calls started in the same synchronous turn before any await settles), thrown errors, logs.
3. **Aggregate** into a `CallPlan` (file 05 §10):
   - Group invocations by call-sequence signature → branch probabilities (`branch` steps).
   - CPU distribution → `LatencyModel` (lognormal fit).
   - `throwProbability` = fraction that threw.
4. **CPU time honesty:** QuickJS is an interpreter, much slower than Node's JIT. `cpuMs = clamp(measuredGuestMs × cpuScale, 0.2, ∞)` with `cpuScale` default `0.1`. UI shows "Measured (interpreter): X ms → using Y ms (estimate). Edit." **Manual override always wins** and is encouraged. Document this in the UI help.
5. Plan is cached by `hash(source, fixtures, mock config, seed)`; re-profiled when any change.
6. **Live code mode** (optional, ≤ 50 RPS): run the real handler per simulated request for exact logs/behavior (slow; for validation).

## 9. Logs

### 9.1 Sources
| Source | Examples |
|---|---|
| `user` | `console.log/info/warn/error/debug` from user code (with call-site line:col from stack) |
| `platform` | Provider-style runtime lines (below), throttles, retries, timeouts, cold starts |
| `engine` | Drops, queue full, circuit open, autoscale events, health-check failures, unreachable edges |

### 9.2 Provider-style platform lines (approximate, for authenticity)
```
AWS Lambda:   START RequestId: <id> Version: $LATEST
              END RequestId: <id>
              REPORT RequestId: <id> Duration: 42.10 ms Billed Duration: 43 ms Memory Size: 512 MB Max Memory Used: 88 MB Init Duration: 231.5 ms
GCP Cloud Run: structured JSON request log {"httpRequest":{"requestMethod":"GET","status":200,"latency":"0.042s"},"severity":"INFO"}
Azure Funcs:   Executing 'Functions.api' (Reason='This function was programmatically called via the host APIs.', Id=<id>)
               Executed 'Functions.api' (Succeeded, Id=<id>, Duration=42ms)
OCI Functions: plain stdout/stderr lines with request id prefix
```
`Init Duration` appears only on cold starts. Memory numbers are estimates.

### 9.3 Log panel features
- Columns: virtual time (`mm:ss.mmm`), level icon+color, source badge, node, request id, message.
- Click a row → JSON viewer for `data`; **Jump to trace** (opens the request's waterfall); **Jump to code** (user logs, via source map).
- Filters: level, source, node, request id, free text, regex; saved filters.
- **Group by request** toggle (collapsible per request id, shows status and duration).
- Follow tail / pause / clear; copy row; **download `.jsonl`** of current filter.
- Highlight rows that explain failures (throttle, timeout, drop) with a "Why?" link (file 17).
- Virtualized list (≥ 50k rows smooth).

### 9.4 Volume control (load runs)
- Ring buffer of 50,000 entries.
- User code isn't executed per request in plan-replay mode, so **user logs in load runs are replayed**: for each *sampled* request (default 1%, max 200 requests), the engine attaches the log lines recorded from a randomly chosen profiling invocation, labelled `replayed from profile`. For exact logs use Dry run or Live code mode.
- Platform and engine logs are emitted for **all** errors (capped at 2,000 per run, with a "N more suppressed" line) and for 1% sampled successes.
- `console.debug` is dropped in load runs unless "verbose" is enabled.

## 10. Traffic scenario scripts (k6-style)

```js
export const options = {
  scenarios: { browse: { rps: 500, durationS: 60, rampUpS: 10 } },
  thresholds: {
    http_req_duration: ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const r = http.get("/products");
  check(r, { "status is 200": (res) => res.status === 200 });
  sleep(1);
  if (Math.random() < 0.2) http.post("/checkout", { cart: 3 });
}
```

- API: `http.get/post/put/del/patch(url, body?, params?)`, `check`, `sleep`, `group`, `__VU`, `__ITER`, `Math.random` (seeded).
- The script is executed in the sandbox to **extract flows**: sequence of steps with think times and branch probabilities → `UserFlow[]` (file 04). Responses inside the script come from a stub (`status 200`, empty body) during extraction; real responses during load are simulated by the engine, and `check` pass/fail are evaluated from simulated status codes.
- `thresholds` use k6 syntax subset; results show as ✅/❌ badges after a run and feed challenge scoring (file 17).

## 11. Limits & security

| Limit | Default |
|---|---|
| Guest memory | `memoryMb` (default 128; hard cap 512) |
| Guest stack | 1 MB |
| CPU budget per invocation (real) | 2 s dry run; 20 s per profile run |
| Max source size | 200 KB per script; 1 MB per design |
| Max mock calls per invocation | 500 |
| Max log line | 8 KB; max 1,000 lines per invocation |
| Max response template output | 1 MB |
| `/tmp` | 64 MB in memory |
| Worker watchdog | Terminate worker if no heartbeat for 10 s |

Rules:
- All host functions validate argument types/sizes and exchange data by structured copy (JSON). **No host objects/closures leak into the guest.**
- No network, no filesystem, no timers other than virtual ones.
- A crash/timeout of the sandbox never affects the sim engine or UI (error boundary + worker restart).
- Never execute user code on the server. Challenge verification (file 17) uses stored **call plans** recorded client-side plus server re-verification of plans against allowed bounds, or re-profiles inside a server-side QuickJS WASM instance with the same limits (decision to log in `DECISIONS.md`).

## 12. Acceptance tests

1. Handler returning JSON runs; logs appear; duration equals sum of sequential mock latencies.
2. `Promise.all` of 3 calls (50/80/120 ms) → virtual duration ≈ 120 ms; sequential → ≈ 250 ms.
3. `event.body` string misuse produces the `apigw-body-string` hint.
4. Handler reading `res.Item.userId` against an empty mock: Auto-fill generates `Item.userId` (uuid) and the re-run succeeds.
5. Pasted AWS SDK v3 code (`S3Client` + `GetObjectCommand`) runs unmodified.
6. Throttle injection (rate 1.0) throws an error with `$metadata.httpStatusCode === 429`.
7. `while(true){}` is stopped with `CpuBudgetExceeded` in < 3 s and the worker stays usable.
8. `fetch("https://example.com")` fails with `MockNotConfigured` and never touches the network (verified by test with network blocked).
9. Same seed → identical logs and results.
10. Profiling a handler with an `if (Math.random() < 0.3)` branch yields a plan with branch probability ≈ 0.3 (±0.1 at N=200).
11. Timeout: function timeout 1 s with a 3 s mock → `Timeout` with provider-style message.
12. Log panel renders 50k rows at ≥ 50 fps scrolling.
