# 05 — Simulation Engine

Package: `packages/sim-engine`. Pure TypeScript. No DOM, no `Date`, no `Math.random`, no Node-only APIs.

## 1. Principles

1. **Discrete-event simulation (DES)** on a **virtual clock** (float64 milliseconds).
2. **Deterministic**: same `Design + Scenario + seed` → byte-identical `SimulationResult`.
3. **Stable under unrelated edits**: each random stream is derived from `hash(seed, nodeId, purpose)` (e.g. `"latency"`, `"error"`, `"lb"`). Editing node A must not change node B's random numbers. Use xoshiro128** or mulberry32.
4. **Educational fidelity over exactness**: model the behaviors that teach (queues, timeouts, retries, pools, throttles, cascades), not every provider detail.
5. **Fast**: binary-heap event queue, pooled request objects, typed arrays for metrics.

## 2. Core model

Every node is a **station** with resources:

| Resource | Meaning | Source |
|---|---|---|
| `slots` (in-flight) | Max concurrent requests being handled (threads, workers, connections, concurrency limit) | `instances × maxInFlightPerInstance` |
| `cores` | CPU capacity consumed only during CPU segments | `instances × vcpu` |
| `queue` | Waiting line when slots are full | `queue.maxLength`, policy |
| `rateLimit` | Token bucket (rps/burst, rpm/tpm) | node config / catalog |
| `pool` | Connection pool (DB, proxy) | `connections.max` |

### Compute nodes use two constraints (important for teaching)

A request holds an **in-flight slot** for its whole life, but only holds a **core** while doing CPU work. Waiting on a downstream call holds the slot but not the core.

```
acquire slot (queue if none) → CPU segment (acquire core, cpuMs) → call downstream (hold slot, free core) → CPU segment → release slot
```

Consequences the UI must be able to explain:
- I/O-heavy API (Node): CPU low, slots fill because downstream is slow (Little's law: `inFlight = rps × wallTime`).
- CPU-heavy API: cores saturate first.
- PHP-FPM style with few workers: slots exhaust quickly while CPU is idle.

**Runtime presets** (editable) set `maxInFlightPerInstance`, effective cores:

| Preset | maxInFlight / instance | Effective cores / instance |
|---|---|---|
| `node` (single process) | 1000 | 1 (set `cluster: true` for vcpu) |
| `php-fpm` | `pm.max_children` default 20 | vcpu |
| `java-threads` | 200 | vcpu |
| `python-gunicorn` | workers × threads (default 4×2) | vcpu |
| `go` | 10000 | vcpu |
| `custom` | user value | user value |

Throughput ceiling per compute node = `min( cores×1000/cpuMs , slots / wallTimeSeconds )`. Show this as a "theoretical max RPS" label in the inspector.

### Service time and latency sampling

For each service call: `latency = sample(LatencyModel)`. Log-normal fit from percentiles:

```
mu    = ln(p50)
sigma = (ln(p95) - ln(p50)) / 1.6449     // z(0.95)
x     = exp(mu + sigma * N(0,1))
```
If `p95 <= p50` use fixed. `bimodal`: with probability `mode2.weight` sample mode 2 (cache miss, cold start, slow disk). Clamp to `[0.01 ms, 10 min]`.

### Edge (network) latency

`edgeLatency = base(placement) + payloadBytes / bandwidth`, where base comes from the placement matrix in file 06 §Network defaults (same host, same AZ, cross-AZ, cross-region, client↔edge). Override with `EdgeInstance.networkLatency`. Edges blocked by the network analyzer (file 13) produce connection errors instead (see §6.9).

## 3. Request lifecycle

Events: `ARRIVE`, `START_SERVICE`, `END_CPU`, `END_SERVICE`, `CALL_RETURN`, `TIMEOUT`, `RETRY`, `DROP`, `COMPLETE`, `SCALE_CHECK`, `HEALTH_CHECK`, `CHAOS_START`, `CHAOS_END`, `SAMPLE_FRAME`.

```
Client generates request R (from TrafficProfile + flows)
→ ARRIVE at entry node
   rate limiter? → throttled (429) immediately
   slot free?    → START_SERVICE
   queue space?  → enqueue (wait time accrues)
   else          → DROP (dropped_queue_full)
→ node behavior (by kind, §6) produces downstream calls (from edges or call plan)
→ for each sync call: schedule ARRIVE at target after edge latency; set TIMEOUT timer
→ on CALL_RETURN: continue plan; on error: retry / fail per config
→ END_SERVICE: release slot, pull next from queue
→ COMPLETE: record latency, status, spans (if sampled for trace)
```

### Routing downstream

1. If the node has a **call plan** (from user code, file 12) → execute its steps (sequential / parallel groups / branches). Each call's target is resolved to a node connected by an outgoing edge whose target `serviceId` matches the call; if several match, pick by edge `weight`. If none → error `not_reachable` + insight "Your code calls X but no edge connects to it".
2. Otherwise use **edge weights**: each outgoing edge is a call; edges in the same `callType` group are alternatives chosen by `weight` unless `fanOut` marks all-of. Default: pick **one** edge by weight among sync edges; call **all** async edges.

### Timeouts and wasted work

Each call has a timeout = `min(edge/node timeoutMs, remainingDeadline)`. On timeout the **caller** stops waiting (error `timeout`) but the **callee keeps working** unless `cancelOnTimeout=true` (default false). This "zombie work" is what makes timeouts amplify overload. Record `wastedWorkMs`.

### Retries

`retry: {max, backoffMs, jitter}`. Backoff = `backoffMs × 2^attempt` (+ full jitter if enabled). Each retry is a new `ARRIVE` at the target. Count retries per edge (needed for retry-storm insight).

### Circuit breaker

States closed → open (failures ≥ threshold in window) → half-open (after `openMs`, allow probe) → closed/open. Open state fails instantly with `circuit_open`.

## 4. Queues, drops and overload

- Queue discipline FIFO. `queue.policy = reject` → new arrival gets `dropped_queue_full`; `drop-oldest` evicts the head.
- Default `queue.maxLength`: LB 10,000; compute 1,000; DB pool wait 500 (+ connection-wait timeout 5,000 ms); serverless depends on `onLimit` (§6.3).
- Utilization window = last 1 s: `util = busySlotSeconds / (slots × 1s)`. CPU utilization separately. Report `max(util, cpuUtil)` as `utilization` and keep both.
- Little's law invariant check in tests: `avgInFlight ≈ throughput × avgLatency` (±5%).

## 5. Autoscaling

Every `checkIntervalS`: `desired = ceil(current × metric / target)`, clamped to `[min,max]`. Scale-out respects `scaleOutCooldownS`; new instances start serving after `warmupS` (default from catalog "scale-out lag"). Scale-in is slower (cooldown, step of 1). Show `instancesActive` vs `instancesTotal`. Spikes faster than warmup must visibly overload — this is a core lesson.

## 6. Behaviors by kind

### 6.1 Load balancer (`lb`)
Algorithm: round-robin, least-conn, random. Targets = healthy instances of downstream nodes (or healthy downstream nodes). **Health checks**: every `intervalS`, an instance fails a check if it is down, or its current queue wait exceeds `healthCheck.timeoutMs`. After `unhealthyThreshold` failures it is removed; after `healthyThreshold` passes it returns. This reproduces the classic cascade: one instance overloads → fails checks → removed → others overload.
`idleTimeoutMs`: if backend response takes longer, LB returns 504.

### 6.2 Cache (`cache`)
Hit with probability `cacheHitRatio` (default 0.8). Hit → cache latency, done. Miss → call downstream (edge), then optional set. Chaos `cache-flush {nodeId, warmupS}`: hit ratio → 0, then linear recovery over `warmupS` (stampede demo). Cache node memory limits are v2.

### 6.3 Serverless (`fn`)
Environments = concurrent execution units. Each in-flight request needs one. Idle environments stay warm for `idleTtlS` (default 600). A request with no idle warm environment triggers a **cold start** (sample `coldStart` latency) if `current < concurrencyLimit`. At the limit: `onLimit = 'throttle'` → 429 immediately (Lambda-like) or `'queue'` → enqueue with timeout (Cloud Run-like). Billing counters: requests, GB-seconds.

### 6.4 Database (`sql`, `kv`, `doc`, …)
- `connections.max` pool. Each query holds a connection for its service time. Wait for a connection up to `connectionWaitMs`, else error `timeout`.
- Read/write mix: `readRatio` (default 0.8). Writes use `writeLatencyMultiplier` (default 2.5). Read replicas: if `instances > 1`, reads spread across replicas, writes go to primary.
- Query class operations override latency (e.g. `Query` vs `HeavyQuery`).
- `kv` (DynamoDB/Cosmos/Bigtable-style): capacity in read/write units; exceeding → `throttled`. Hot-partition option: `skew` (0..1) concentrates traffic on one partition with a per-partition limit (v2).

### 6.5 Queue / stream / topic (`queue`, `topic`, `stream`, `bus`) — **async**
Producer call returns after enqueue latency. Messages wait in a backlog. Consumers (`consumer.concurrency`, `batchSize`, `pollMs`) pull and invoke the downstream handler. Failed messages retry up to `maxRetries`, then DLQ (if enabled) or are lost. Metrics: backlog depth, oldest-message age, consumer lag. Async paths report **time-to-processed** separately from API latency.

### 6.6 Gateway / WAF / CDN (`gw`, `cdn`)
Fixed overhead latency; `rateLimit` supported (API Gateway account/stage limits → 429). CDN: hit ratio → served at edge; miss → origin call.

### 6.7 LLM / ML / AI (`llm`, `ml`, `vision`, `speech`, …)
See file 11. Engine support: token-based latency (`TTFT + tokens/tps`), TPM/RPM token buckets, streaming spans, inference endpoint slots.

### 6.8 Pass-through / network (`net`)
NAT, IGW, peering, firewall, DNS: add small latency; NAT and others carry bandwidth/connection limits (NAT port exhaustion = v2). They matter chiefly for **cost counters** (bytes through NAT) and reachability.

### 6.9 Network failures
If the analyzer says an edge is blocked:
- Firewall/route **drop** → caller waits `connectTimeoutMs` (default 3,000) then error `conn_timeout`.
- Port closed / nothing listening → fast `conn_refused` (≈ 1 RTT).
- DNS failure → error after `dnsTimeoutMs` (default 2,000).
Log each with a platform log line (file 12) and emit an insight linking to the Reachability panel.

## 7. Chaos events

`kill-instances`, `az-outage`, `add-latency`, `error-rate`, `throttle`, `cache-flush` (add to `ChaosEvent` in shared-types). Active between `atS` and `atS+durationS`. AZ outage marks all instances in that AZ down and removes them from LB pools after health-check delay.

## 8. Scale and performance strategy

1. **Estimate events**: `estimatedEvents ≈ totalRequests × avgSpansPerRequest × 3`.
2. If `estimatedEvents ≤ 2,000,000` → full DES.
3. Else **scaled DES** with factor `k = ceil(estimatedEvents / 2,000,000)`:
   - Arrival rate ÷ k; slots, cores, rate limits, pools, queue lengths ÷ k (rounded up, min 1).
   - Service times and latencies are **not** scaled.
   - Nodes where rounding changes capacity by > 10% are flagged `approximate`.
   - Result carries `scaled: {factor: k}`; counters are multiplied back by k for cost. UI shows a "Scaled ×k" badge with explanation.
4. **Analytic cross-check** (steady state, per node) shown as a dotted "theory" line: Erlang C for `c` servers, offered load `a = λ/μ`, `ρ = a/c`:
   `C(c,a) = [a^c/c! · 1/(1−ρ)] / [Σ_{k=0}^{c−1} a^k/k! + a^c/c! · 1/(1−ρ)]`, mean wait `Wq = C / (cμ − λ)`.
   If DES and theory disagree by > 25% in steady state, the diagnosis package logs a warning (helps catch engine bugs).
5. Metrics buckets: 1 s. Percentiles via a log-bucket histogram (≈ 2% relative error, base 1.02) per node per bucket; merge for summaries. No per-request arrays.
6. Traces: reservoir-sample ≤ 200 completed requests (bias: keep all error traces up to 50). Particles: sample ≤ 300 in-flight requests for animation.

## 9. Health states (drive the UI)

Computed per node per 1 s bucket on smoothed utilization (EMA α=0.5):

| State | Condition | UI |
|---|---|---|
| `ok` | util < 0.60 and no drops | green bar |
| `warm` | 0.60 ≤ util < 0.80 | yellow bar |
| `hot` | 0.80 ≤ util < 0.95 | orange/red bar |
| `overloaded` | util ≥ 0.95, **or** drops > 0, **or** queue depth growing for ≥ 5 s, **or** throttled > 1% | **red bar + shake** |
| `down` | 0 active instances | grey, struck through |

Hysteresis: enter `overloaded` after 2 consecutive buckets; leave after 3 consecutive buckets below 0.90. Thresholds are constants in one config file and unit-tested.

## 10. Public API

```ts
export interface RunInput {
  design: Design; scenarioId: string; seed?: number;
  callPlans?: Record<string /*scriptId*/, CallPlan>;
  network: NetworkAnalysis;            // precomputed reachability per edge (file 13)
  options?: { frameIntervalMs?: number; maxEvents?: number; liveCode?: boolean };
}
export function runSimulation(
  input: RunInput,
  onFrame: (f: SimFrame) => void,
  signal?: AbortSignal
): Promise<SimulationResult>;
```

Frames emitted every `frameIntervalMs` of **virtual** time (default 100 ms); the UI may play them faster/slower than real time (1×, 5×, 20×, max). Pause/resume is a UI concern (buffered frames); abort via `AbortSignal` must stop within 200 ms real time.

### Call plan (from sandbox, file 12)

```ts
export interface CallPlan {
  scriptId: string;
  cpuMs: LatencyModel;                 // measured/profiled or user override
  throwProbability: number;            // observed
  steps: PlanStep[];
}
export type PlanStep =
  | { kind: 'cpu'; ms: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'call'; serviceId: string; op: string; count: number; payloadBytes?: number; parallelGroup?: string; probability?: number; alias?: string }
  | { kind: 'branch'; probability: number; then: PlanStep[]; else: PlanStep[] };
```
`parallelGroup` steps with the same group id run concurrently (Promise.all semantics); the step finishes when the slowest returns.

**Live code mode** (optional, ≤ 50 RPS): instead of a plan, execute the real handler per request in the sandbox with virtual-time host calls. Same semantics, much slower; used for "run with my real code" validation.

## 11. Core loop (pseudocode)

```ts
while (heap.nonEmpty() && now < endTime) {
  const ev = heap.pop(); now = ev.t;
  switch (ev.type) {
    case 'ARRIVE':        onArrive(ev.req, ev.node); break;
    case 'START_SERVICE': startService(ev.req, ev.node); break;
    case 'END_CPU':       releaseCore(ev.node); advancePlan(ev.req); break;
    case 'CALL_RETURN':   onCallReturn(ev.req, ev.result); break;
    case 'TIMEOUT':       if (!ev.req.settled) failCall(ev.req, 'timeout'); break;
    case 'SCALE_CHECK':   evaluateAutoscaling(ev.node); break;
    case 'HEALTH_CHECK':  evaluateHealth(ev.node); break;
    case 'SAMPLE_FRAME':  emitFrame(now); break;
    // ...
  }
  if (now - lastYield > 8 /*real ms*/) await yieldToEventLoop(); // keep worker responsive
}
```

## 12. Required invariants (property tests)

1. **Conservation**: `arrivals = completions + errors + drops + inFlight` for every node at every bucket.
2. **Determinism**: two runs with same inputs deep-equal.
3. **Isolation**: changing node B's config does not change node A's random stream outcomes when A is not downstream of B.
4. **Monotonic time**: event times never decrease.
5. **Capacity**: `inFlight ≤ slots`; `busyCores ≤ cores`.
6. **Little's law** within 5% for stable (non-saturated) runs ≥ 30 s.
7. **No NaN/Infinity** in any output; percentiles ordered p50 ≤ p95 ≤ p99.

## 13. Golden scenarios (snapshot tests)

1. 1 client → 1 app (1 vCPU, 10 ms CPU) at 50 / 90 / 120 RPS: util ≈ 0.5 / 0.9 / saturation, drops appear above ~100 RPS.
2. App → DB with pool 10, query 50 ms: max ≈ 200 qps; above that queue + timeout errors.
3. LB + 2 apps, kill one at t=30 s: remaining instance overloads; recovery after chaos ends.
4. Retry storm: DB slowdown + 3 retries, no backoff → traffic multiplies ≥ 3×.
5. Lambda-like: concurrency 100, 500 RPS × 200 ms → throttling ≈ 0 until `rps × 0.2 > 100`.
6. Autoscaling with 60 s warmup under spike → overload window ≈ warmup.
7. Queue: producer 100 msg/s, consumers drain 60 msg/s → backlog grows 40/s.
