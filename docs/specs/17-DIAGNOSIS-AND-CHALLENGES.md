# 17 — Diagnosis ("Why?") & Challenge Mode

Package: `packages/diagnosis`. A **deterministic, rule-based** insights engine. It reads a `Design` + `SimulationResult` (+ `NetworkAnalysis` + `CostReport`) and returns ranked `Insight[]` with plain-language explanations and one-click fixes. Rules are the source of truth; an optional LLM explainer only rephrases them.

## 1. Principles

1. **Every red state has an explanation.** If a node is `hot`/`overloaded`, at least one insight MUST reference it. A test enforces this.
2. **Evidence, not vibes.** Each insight cites the numbers behind it ("`db` pool 100/100 busy, 412 requests waited 5 s").
3. **Two levels**: *short* (one sentence) and *deep* (what, why, how to fix, what trade-off). Beginner-friendly vocabulary with a glossary link.
4. **Fixes are patches** the user can preview and apply (JSON Patch against `Design`, file 04). Fixes must be minimal and explain trade-offs (cost ↑, latency ↓…).
5. **Ranked by impact**: `impact = severity weight × share of traffic affected × duration fraction`.
6. **No false certainty**: use "likely" when the cause is inferred.

## 2. Rule format

```ts
export interface Rule {
  id: string;                          // "db-pool-exhausted"
  title: string;
  severity: 'info' | 'warning' | 'critical';
  appliesTo: (ctx: Ctx) => Match[];    // returns matched nodes/edges with evidence
  explain: (m: Match) => { short: string; deep: string };
  fixes: (m: Match, ctx: Ctx) => FixSuggestion[];
  lessonSlug?: string;
  requires?: ('sim' | 'network' | 'cost')[];
}
interface Ctx { design: Design; result?: SimulationResult; network?: NetworkAnalysis; cost?: CostReport; catalog: Catalog }
interface Match { nodeIds: string[]; edgeIds?: string[]; evidence: Record<string, number | string> }
```

Rules are pure functions in `packages/diagnosis/rules/*.ts`, one file per rule, each with unit tests (a design fixture that triggers it and one that doesn't).

## 3. Initial rule set

### Capacity & bottlenecks
| ID | Trigger (evidence) | Typical fixes |
|---|---|---|
| `bottleneck-node` | Node with highest utilization ≥ 0.85 and downstream nodes < 0.6 | Add instances / bigger type / cache in front |
| `cpu-saturated` | `cpuUtilization ≥ 0.9` while slots free | Scale out/up, reduce `cpuMs` (optimize code) |
| `slots-exhausted` | In-flight at limit, CPU low (I/O wait) | Raise concurrency (async runtime), speed up downstream, add instances |
| `queue-growing` | Queue depth increasing ≥ 5 s | Add capacity, shed load, rate-limit, add queue/async |
| `drops-queue-full` | `dropped_queue_full > 0` | Increase queue (trade-off: latency), scale, backpressure |
| `autoscale-too-slow` | Overload window ≈ warmup time after a spike | Lower target, increase min, pre-warm, shorter warmup |
| `idle-overprovisioned` | Avg util < 0.15 and instances > 1 or large type | Downsize, fewer instances (shows $ saved) |

### Databases & caches
| ID | Trigger | Fixes |
|---|---|---|
| `db-pool-exhausted` | Pool at max, waiters timing out | Add pooling/proxy, more replicas, cache, reduce connections per app instance |
| `db-read-heavy-no-cache` | `readRatio > 0.7`, DB util > 0.7, no cache upstream | Add cache with hit ratio target; show projected DB load |
| `cache-low-hit-ratio` | Hit ratio < 0.5 yet cache costs | Revisit keys/TTL; maybe remove cache |
| `cache-stampede` | After `cache-flush`/miss burst, DB util spikes | TTL jitter, request coalescing, warm-up |
| `serverless-db-connections` | Many concurrent functions → DB pool cap | Add proxy/pooler, reserved concurrency |
| `hot-partition` | KV node throttled with low table utilization (skew set) | Better partition key, shard, cache |
| `single-db-no-replica` | One DB instance, reads > 0.7 or HA chaos run | Read replica, multi-AZ |

### Resilience
| ID | Trigger | Fixes |
|---|---|---|
| `single-point-of-failure` | Node on critical path with 1 instance, or all instances in one AZ | Add instance in another AZ + LB |
| `retry-storm` | Retries > 20% of edge traffic during degradation | Backoff + jitter, retry budget, circuit breaker |
| `no-timeout` | Edge/node with no timeout and observed latency tail > 5× p50 | Set timeouts (≤ upstream deadline) |
| `timeout-inversion` | Child timeout ≥ parent timeout | Make child < parent; propagate deadlines |
| `zombie-work` | Wasted work after timeouts > 10% of busy time | Cancel on timeout, shorter timeouts, shed load |
| `health-check-cascade` | Instances removed by health checks then others overload | Tune thresholds, scale ahead, protect with queue |
| `no-circuit-breaker` | Downstream failing > 50% and callers keep retrying | Add circuit breaker |
| `lb-idle-timeout-mismatch` | LB idle timeout < backend p99 | Raise idle timeout or speed backend |
| `no-dlq` | Async consumer failing and no DLQ | Enable DLQ + alarms |
| `sync-where-async` | Sync call to slow service (> 1 s) on user path with fan-out | Use queue/async job + status polling |

### Serverless & AI
| ID | Trigger | Fixes |
|---|---|---|
| `serverless-throttled` | 429s at concurrency limit | Raise limit, reserved concurrency, queue in front |
| `cold-start-tail` | p99 dominated by cold starts | Provisioned/min instances, smaller package, keep-warm |
| `gateway-timeout-vs-llm` | LLM p95 > gateway timeout | Stream, async job pattern, shorter outputs |
| `llm-tpm-throttle` | TPM/RPM 429s | Queue + backoff, batch, smaller prompts/outputs, provisioned capacity, fallback model |
| `llm-on-critical-path` | LLM call on a path cacheable/precomputable | Cache, precompute, stream |
| `context-too-large` | 400 context errors | Trim/summarize prompt, chunking |

### Network & security
| ID | Trigger | Fixes |
|---|---|---|
| `edge-blocked` | Reachability says blocked | Reason-specific patch (file 13) |
| `db-public` | DB in public subnet / `0.0.0.0/0` ingress on DB port | Move to private, restrict SG |
| `wide-open-ingress` | `0.0.0.0/0` ingress on non-web ports (22, 3389, DB ports) | Restrict source |
| `no-nat-private-egress` | Private nodes call internet/SaaS with no NAT | Add NAT/endpoint |
| `cross-az-chatty` | High GB/month cross-AZ | Co-locate, zone-aware routing (note HA trade-off) |
| `cross-region-latency` | Sync calls across regions on user path | Move closer, async replication, CDN |

### Cost
| ID | Trigger | Fixes |
|---|---|---|
| `cost-dominant-line` | One line > 50% of total | Show lever: smaller type, cache, different service |
| `nat-cost-hotspot` | NAT data processing > 15% of total | Gateway endpoints/PrivateLink, move traffic |
| `egress-heavy` | Internet egress > 25% of total | CDN, compression, caching |
| `over-spec-vs-need` | Cheaper config still meets thresholds (via sweep) | Suggest cheaper config with projected p95 |

Rules MUST degrade gracefully when inputs are missing (`requires`).

## 4. Ranking & presentation

- Sort by `impact` then severity. Show top 5 in the node's **Why?** tab; all in **Insights** dock.
- Group by node; show "root cause chain" when one insight explains others (e.g. `db-pool-exhausted → slots-exhausted(app) → drops(lb)`): build a causal DAG from downstream utilization/queue edges and highlight the **root** (deepest saturated dependency).
- Each insight card: severity icon, title, evidence chips, short explanation, **"Explain more"** (deep), **fix buttons** (preview diff → apply), **"Re-run to verify"**, lesson link.
- After applying a fix and re-running, show a **before/after** mini-summary (p95, errors, cost).

## 5. Optional LLM explainer (off by default)

- Server endpoint `POST /api/explain` (file 03), `EXPLAIN_ENABLED=false` by default.
- Input is only a **summarized** JSON: node kinds/labels (no code, no env vars, no secrets, no fixture payloads), top insights with evidence, key metrics. User sees exactly what will be sent and must click to send.
- Output: friendlier rephrasing and a "what to try next" list. It never changes numbers, never applies fixes, and is labelled "AI-written explanation — rules above are the source of truth".
- Rate-limited per user; cache by hash of summary.

## 6. Challenge mode

### 6.1 Definition

```ts
export interface Challenge {
  slug: string; title: string; difficulty: 'beginner' | 'intermediate' | 'advanced';
  story: string;                        // 2–4 sentences, plain language
  learningGoals: string[];
  starterDesign: Design;                // may be intentionally broken
  allowedServices?: string[];           // or providers; empty = any
  fixedScenario: Scenario;              // traffic, chaos, seed
  constraints: {
    maxMonthlyCostUsd?: number;
    p95MsMax?: number; p99MsMax?: number; errorRateMax?: number;
    minAvailabilityUnderChaos?: number;
    requiredCapabilities?: ('multi-az' | 'cache' | 'async-queue' | 'private-db' | 'dlq' | 'autoscaling')[];
    mustBeReachable?: { from: string; to: string; port: number }[];
    forbidden?: ('public-db' | 'wide-open-ingress')[];
  };
  scoring: { weights: { latency: number; cost: number; resilience: number; security: number; simplicity: number } };
  hints: { afterAttempts: number; text: string }[];
  referenceSolutionDesign?: Design;     // hidden until solved or revealed
  published: boolean;
}
```

### 6.2 Evaluation
1. Run the **fixed scenario** with the **fixed seed** (client-side for instant feedback, server-side to verify attempts).
2. Check constraints from `SimulationResult`, `NetworkAnalysis`, `CostReport` (cost uses the synced snapshot; challenges store a **pinned price snapshot id** so scores are stable over time).
3. Score 0–100 = weighted sub-scores; pass if all hard constraints satisfied.
4. Server verification: re-run the engine in Node with the same inputs. For designs with user code, verification uses the stored **call plan** profiled client-side and validated against allowed bounds (file 12 §11).
5. Anti-cheat: designs are size-limited; `scenario`, `seed`, `constraints` are server-owned and cannot be edited by the client; scoring is computed server-side.

### 6.3 Starter challenge list
1. **First Blood** (beginner): single server falls over at 200 RPS; keep p95 < 300 ms under $100/mo.
2. **Read-Heavy Shop** (beginner): add a cache so DB stays < 70% at 2k RPS.
3. **The Midnight Spike** (intermediate): 10× traffic spike for 60 s; survive with autoscaling and no errors > 1%.
4. **Zone Down** (intermediate): survive an AZ outage with ≥ 99% availability.
5. **Retry Storm** (intermediate): fix a design that melts its own DB; add backoff/circuit breaker.
6. **Fire and Forget** (intermediate): convert a slow sync checkout to async queue + workers with DLQ.
7. **Locked Down** (intermediate): make a broken network work without opening to `0.0.0.0/0`.
8. **Budget Cloud** (advanced): serve 5k RPS at p99 < 250 ms for < $500/mo on **any** provider.
9. **LLM at Scale** (advanced): 50 req/s chatbot with TPM limit; design queue/streaming/caching so error rate < 1%.
10. **Cross-Cloud** (advanced): same requirements on AWS, then on GCP/Azure/OCI; compare cost.

Each challenge ships a hidden reference solution and a short "what this teaches" write-up shown after solving.

### 6.4 UX
- Challenges page: cards with difficulty, goals, best score, time to solve.
- In challenge: top banner showing constraints as live checkboxes (✅/❌) updated after every run; hint button unlocks after N attempts; "Reveal solution" confirmation.
- Leaderboard (optional, opt-in) by score and by cost; display names only.
- Progress and badges saved per user (`challenge_attempts`).

## 7. Tests

1. Each rule: positive fixture triggers it; negative fixture doesn't; fix patch applies cleanly and re-run improves the target metric.
2. **Coverage invariant**: for every golden scenario with any node `hot`/`overloaded`, at least one insight references that node.
3. Root-cause DAG picks the deepest saturated dependency in the retry-storm and DB-pool golden scenarios.
4. Ranking is deterministic.
5. LLM explainer payload never contains code, env vars, or fixture data (test with canary strings).
6. Challenge evaluation is deterministic and identical client vs server for the same inputs.
7. Reference solutions pass their own challenge; starter designs fail it.
