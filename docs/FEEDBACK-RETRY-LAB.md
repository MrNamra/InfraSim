# Audit Findings: Retry Amplification & Resilience Lab

**Date:** 2026-11-15  
**Context:** Specification audit for the Reddit commenter's retry amplification failure scenario (300 RPS API, DB 20 ms → 800 ms from t=30s to 90s, 1s client timeout, 2 retries, 100-connection DB pool).

---

## 1. Executive Summary & Audit Matrix

| Area | Current Implementation in InfraSim | Gaps & Missing Capabilities |
| :--- | :--- | :--- |
| **Timeouts** | `NodeConfig.timeoutMs`, `lb.idleTimeoutMs`, watchdog in `packages/sim-engine/src/engine.ts` (`enqueueTimeout`, `timeoutHeap`). Sets `token.targetCall.callerTimedOut = true`. | Client deadline is not separated from hop timeout; does not discern **goodput** (success $\le$ client deadline) from **late completions**; late completions count as success in node throughput. |
| **Retries (Backoff & Jitter)** | `EdgeInstance.retry?: { max, backoffMs, jitter }`. Exponential backoff `backoffMs * 2^attempt`. Jitter scales `expDelay * [0.1..1.0]`. | Full jitter formula (`random(0, min(cap, base * 2^attempt))`) missing. No **retry budget** (token bucket or % of requests) to prevent retry amplification under persistent degradation. No tracking of total attempt RPS vs offered RPS. |
| **Circuit Breaker** | `packages/sim-engine/src/circuitBreaker.ts`: 3-state machine (`closed`, `open`, `half-open`) with probe request. Configured on `EdgeInstance.circuitBreaker`. | Edge-only; not exposed in multi-variant comparison. |
| **Queue Drop Policy** | `NodeConfig.queue: { maxLength, policy: 'reject' \| 'drop-oldest' }`. Rejects on full queue with `dropped_queue_full`. | No **load shedding** based on queue wait time (`maxQueueWaitMs`) or in-flight saturation fast-failing with 503 (`shed`). |
| **Rate Limiting** | `NodeConfig.rateLimit: { rps, burst, concurrency }`. Token bucket fast-fails with `throttled`. | Static token bucket; does not adapt to downstream queue / connection pool exhaustion. |
| **Zombie Work** | Callee checks `cancelOnTimeout && callerTimedOut`. If false, callee completes work, logs `totalWastedWorkMs`, and flags span `zombie: 1`. | `totalWastedWorkMs` is aggregated globally, but **lateCompletionsPerSec** is not tracked per 1-second bucket in time series; cancellation does not cascade to downstream hops. |
| **Retry-Storm Golden Scenario** | `tpl-retry-storm` in `apps/web/src/lib/templates.ts` (Storefront API → Payment Svc → DB; 30s run, 120ms latency spike at 8s). | Does not match requested benchmark: 300 RPS constant, 180s duration, DB 20ms → 800ms from t=30s to 90s, 100-connection DB pool, 1s client timeout, 5 comparison variants (A–E). |
| **Metrics Series** | `TimeSeriesBucket` tracks `rpsIn`, `throughputRps`, `errorRate`, `p50`, `p95`, `p99`, per-node `inFlight`, `queueDepth`. | Missing: `offeredRps`, `attemptRps`, `amplificationRatio` (`attemptRps / offeredRps`), `goodputRps`, `lateCompletionsPerSec`, error breakdown by kind (`timeout`, `shed`, `circuit_open`, `throttled`), recovery time, and "did not recover" indicator. |
| **A/B Run Comparison** | Single `pinnedRun` in `MetricsDockTab.tsx` with delta summary (p95, error %, RPS, cost) and single dotted overlay. | No multi-variant (A through E) comparison table with peak amplification, min goodput, peak queue depth, fault p95/error rate, and recovery time. |
| **Seed & Assumptions Display** | Seed in `design.settings.seed` and scenario `seedOverride`; shown in traffic profile editor. | No prominent top-of-workbench editable Assumptions card for the Lab with fixed seed, parameters, and benchmark disclaimer. |

---

## 2. Detailed Technical Audit by Area

### 2.1 Timeouts & Client Deadlines
- **Existing (`packages/sim-engine/src/engine.ts#L1379-L1415`, `L2660-L2718`):**
  Each edge invocation derives `attemptDeadlineMs = Math.min(attemptState.overallDeadlineMs, now + attemptState.attemptTimeoutMs)`. A priority-queue watchdog fires if the target does not finish in time. On timeout, `callerTimedOut = true` and `settledWithCaller = true` are set on the target call context.
- **Identified Gaps:**
  1. The client-observed deadline is not strictly partitioned from intermediate hop timeouts. When an intermediate retry completes at $t=1.4\text{ s}$ for a client with a $1.0\text{ s}$ deadline, the engine currently counts it as a success in `rpsOut` / `throughputRps`.
  2. To measure true goodput, the engine must distinguish between `goodputRps` (requests that completed within client deadline) and `lateCompletionsPerSec` (requests that completed after the client already timed out).

### 2.2 Retries, Backoff, Jitter, and Retry Budget
- **Existing (`packages/sim-engine/src/engine.ts#L1445-L1474`, `L2690-L2716`):**
  Retries trigger on error or timeout if `attemptIndex < maxRetries` and `now < overallDeadlineMs - 5`.
  Backoff calculation: `expDelay = attemptState.backoffMs * Math.pow(2, attemptState.attemptIndex)`.
  Jitter calculation: `delayMs = attemptState.jitter ? expDelay * Math.max(0.1, edgeState.rng.next()) : expDelay`.
- **Identified Gaps:**
  1. **Full Jitter:** True full jitter is `rng.next() * Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attemptIndex))`. The current implementation clamps to `[0.1, 1.0] * expDelay`.
  2. **Retry Budget:** Missing entirely. Standard production clients (e.g. Finagle, gRPC, Envoy) enforce a retry budget where retries cannot exceed a fixed ratio (e.g. 10%–20%) of total request tokens. Without this, persistent outages cause 100% of failed requests to retry, generating $3\times$ amplification.
  3. **Offered vs Attempted Tracking:** No global or edge-level metric distinguishes new client-originated requests (`offeredRps`) from retry attempts (`attemptRps`), preventing direct measurement of the amplification factor ($A = \text{attempts} / \text{offered}$).

### 2.3 Circuit Breaker
- **Existing (`packages/sim-engine/src/circuitBreaker.ts`):**
  Standard closed $\to$ open $\to$ half-open state machine. Tracks sliding window of failures (`failureThreshold`, `windowMs`, `openMs`), allows a single probe in half-open state, and records success/failure outcomes.
- **Identified Gaps:**
  The breaker exists on edges, but lacks integration with the multi-variant lab runner and one-click diagnostic fixes that directly parameterize failure threshold and recovery probe intervals.

### 2.4 Queue Drop Policy & Load Shedding
- **Existing (`packages/sim-engine/src/engine.ts#L2000-L2008`, `packages/shared-types/src/design.ts#L68`):**
  `queue: { maxLength: number; policy: 'reject' | 'drop-oldest' }`. Triggers when queue count reaches `maxLength`.
- **Identified Gaps:**
  1. **Latency/Wait-time Load Shedding:** Under retry storms, requests enter an already deep queue where they are guaranteed to time out while waiting. Modern systems (e.g. Netflix, Meta, AWS) shed load when estimated queue wait exceeds client deadline or a configured threshold (`maxQueueWaitMs`).
  2. **Concurrency Load Shedding:** Fast-failing with HTTP 503 (`shed`) when in-flight reaches a strict limit, rather than queueing up hundreds of doomed requests.
  3. `'shed'` is missing from `ErrorKind`.

### 2.5 Rate Limiting & Concurrency Throttling
- **Existing (`packages/sim-engine/src/engine.ts#L2271-L2278`):**
  Token bucket rate limiter on nodes (`rateLimit: { rps, burst, concurrency }`), emitting `throttled`.
- **Identified Gaps:**
  Static rate limits do not provide adaptive protection against downstream latency degradation (e.g. DB connection pool starvation).

### 2.6 Zombie Work & Deadline Propagation
- **Existing (`packages/sim-engine/src/engine.ts#L1184-L1196`, `L1994`, `L2262`):**
  When a caller times out, `call.callerTimedOut = true`. If `call.cancelOnTimeout` is true, the callee drops the request early. If false (default), the callee continues execution and accumulates `rn.totalWastedWorkMs`.
- **Identified Gaps:**
  `rn.totalWastedWorkMs` is an end-of-run total; the engine does not track per-second `lateCompletionsPerSec`. Furthermore, cancellation is not propagated down multiple levels of a call hierarchy.

### 2.7 Golden Scenarios & Lab Template
- **Existing (`apps/web/src/lib/templates.ts#L920-L1010`):**
  `tpl-retry-storm` runs 30s with a 120ms latency injection.
- **Identified Gaps:**
  Missing the requested **Retry Amplification Lab** benchmark template:
  - 300 RPS constant load over 180 seconds with fixed seed.
  - API tier sized to ~30% utilization when healthy.
  - DB with 100-connection pool.
  - Normal DB service time: 20 ms; fault service time: 800 ms between $t=30\text{ s}$ and $t=90\text{ s}$ (60-second fault window).
  - Client timeout: 1000 ms.
  - 5 variants:
    - **Variant A (Baseline):** 2 immediate retries (no backoff, no jitter).
    - **Variant B (Bounded + Backoff + Jitter):** 2 retries, exponential backoff with full jitter.
    - **Variant C (Circuit Breaker):** Circuit breaker trips during fault.
    - **Variant D (Load Shedding):** Fast-fail 503 when queue wait exceeds threshold or in-flight exceeds pool limit.
    - **Variant E (Comprehensive Defense):** Retry budget + circuit breaker + load shedding.
  - "Run all variants" execution pipeline with comparison table and overlay chart.

### 2.8 Metrics Dock Series & Visualizations
- **Existing (`apps/web/src/components/dock/MetricsDockTab.tsx`):**
  LTTB-downsampled SVG chart for RPS, Latency, Utilization, Queue Depth. Single-run pin comparison.
- **Identified Gaps:**
  1. Chart mode for **Offered vs Attempted vs Goodput** on a shared time axis with in-flight and queue depth.
  2. Fault window shading (visual highlight between $t=30\text{ s}$ and $t=90\text{ s}$).
  3. Recovery time calculation: seconds from fault end until goodput $\ge 95\%$ of offered and queue is near zero.
  4. "Did not recover" badge for runs that stay in perpetual retry storm overload.

### 2.9 Diagnosis Rules
- **Existing (`packages/diagnosis/src/rules/resilience.ts#L85-L177`, `L412-L460`):**
  `retry-storm` and `no-circuit-breaker` rules detect retry activity and lack of breakers.
- **Identified Gaps:**
  Rules do not cite the exact **measured amplification factor** (e.g. "$2.8\times$ amplification; 840 attempts/s for 300 offered req/s") and do not provide specific one-click fixes for each mitigation strategy (backoff + jitter, retry budget, circuit breaker, load shedding).

---

## 3. Implementation Plan by Step

1. **Step 1 — Metrics Series & Recovery Detection**
   - Update `packages/shared-types` with `TimeSeriesBucket` fields: `offeredRps`, `attemptRps`, `amplification`, `goodputRps`, `lateCompletionsPerSec`, errors by kind (`timeout`, `shed`, `circuit_open`, `throttled`).
   - Update `packages/sim-engine/src/engine.ts` to accumulate and record these per second.
   - Update `MetricsDockTab.tsx` with the offered-vs-attempted-vs-goodput chart, fault window shading, and recovery time / "did not recover" badge.

2. **Step 2 — Mitigations Engine Support**
   - Add full jitter support (`rng.next() * Math.min(maxBackoff, backoff * 2^attempt)`).
   - Add **Retry Budget** (`retryBudget: { percent: number; minRps: number }` token bucket).
   - Add **Load Shedding** (`loadShed: { maxQueueWaitMs?: number; maxInFlight?: number }`) that fast-fails with 503 (`shed`).
   - Add `'shed'` to `ErrorKind`.
   - Wire UI inputs in `EdgePopover.tsx` and `ConfigTab.tsx`.

3. **Step 3 — Retry Amplification Lab Template & Multi-Variant Runner**
   - Add `tpl-retry-amplification-lab` starter template in `apps/web/src/lib/templates.ts`.
   - Add editable Assumptions Card at the top of the workbench.
   - Add "Run all variants" button in the lab template that evaluates Variants A through E with the same seed, rendering a comparison table and multi-run overlay chart.

4. **Step 4 — Diagnosis Rules Update**
   - Update `retry-storm` and `no-circuit-breaker` rules in `packages/diagnosis/src/rules/resilience.ts` to report measured amplification factor and offer specific mitigation patches.

5. **Step 5 — Deterministic Tests**
   - Add unit and invariant tests for amplification factor, goodput bounds, baseline queue saturation vs mitigation recovery, and zero NaN/Infinity.

6. **Step 6 — Documentation & Decisions**
   - Update `docs/specs/05-SIMULATION-ENGINE.md`, `README.md`, and log all architectural choices in `docs/DECISIONS.md`.
