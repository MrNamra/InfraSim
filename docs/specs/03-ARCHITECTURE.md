# 03 — Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router), React, TypeScript | Familiar, SSR for share pages |
| Canvas | React Flow (`@xyflow/react`) | Custom nodes/edges, nested groups, fast |
| State | Zustand + Immer | Simple, undo/redo friendly |
| Code editor | Monaco | TypeScript-aware, markers for errors |
| Charts | Recharts or visx | Time series, histograms |
| Sim engine | Pure TypeScript package | Runs in Web Worker and on server |
| Worker RPC | Comlink | Typed calls to workers |
| Sandbox | QuickJS-WASM (`quickjs-emscripten`) in a Web Worker | Isolation, deterministic time control |
| Backend | Laravel 11+ (PHP 8.3), Sanctum | Auth, saved designs, sharing, price sync jobs |
| DB | PostgreSQL | JSONB for designs |
| Cache/queue | Redis | Price cache, queue for sync jobs |
| Layout | ELK.js or dagre | Auto-layout for Terraform import |
| Local persistence | IndexedDB (Dexie) | Guest mode without login |
| Tests | Vitest, fast-check, Playwright | See file 18 |

## Monorepo layout

```
infra-sim/
├─ apps/
│  ├─ web/                  # Next.js app
│  └─ api/                  # Laravel app
├─ packages/
│  ├─ shared-types/         # TS types from file 04 (single source)
│  ├─ catalog/              # JSON catalog + JSON Schema + loader
│  ├─ sim-engine/           # Discrete-event engine (no DOM, no Date, no Math.random)
│  ├─ sandbox/              # QuickJS runtime, mock SDK, fixtures, log capture
│  ├─ network-analyzer/     # Reachability evaluation
│  ├─ cost-engine/          # Cost formulas (consumes price snapshots)
│  ├─ terraform/            # HCL export + plan.json import
│  ├─ diagnosis/            # Rule engine for "Why?" insights
│  └─ ui-kit/               # Shared React components (node shells, bars, badges)
├─ scripts/
│  ├─ build-catalog.ts      # Markdown tables -> catalog JSON
│  └─ seed-prices.ts        # Calls backend sync, writes seed snapshot
├─ docs/specs/              # This spec pack
├─ docs/DECISIONS.md        # Agent decision log
└─ docker-compose.yml
```

Dependency rule: `sim-engine`, `network-analyzer`, `cost-engine`, `diagnosis`, `terraform` depend only on `shared-types` and `catalog`. They MUST NOT import React, DOM APIs, or Node-only APIs, so they run in browser workers and on the server.

## Runtime data flow

```
 Canvas edits ──► Design JSON (Zustand) ──► autosave (IndexedDB / API)
                       │
        ┌──────────────┼───────────────────────────────┐
        ▼              ▼                               ▼
 network-analyzer   cost-engine                   sim-engine (Web Worker)
 (on every edit,    (on edit + after run;          ▲        │ frames every 100 ms virtual
  debounced)         uses price snapshot)          │        ▼
        │              │                     call plans   UI store ──► canvas animation,
        ▼              ▼                     from sandbox   charts, logs, traces
  reachability     cost report                  ▲
  results          per node/total               │
                                        sandbox (QuickJS Web Worker):
                                        dry run / profile user code
```

## Web Worker protocol

Two dedicated workers: `sim.worker` and `sandbox.worker`.

```ts
// sim.worker (Comlink-exposed)
interface SimWorkerApi {
  run(input: RunInput, onFrame: (f: SimFrame) => void): Promise<SimulationResult>;
  cancel(runId: string): void;
}
// sandbox.worker
interface SandboxWorkerApi {
  dryRun(input: DryRunInput): Promise<DryRunResult>;        // one execution, full logs
  profile(input: ProfileInput): Promise<CallPlan>;          // N executions -> call plan
  validate(code: string): Promise<Diagnostic[]>;            // syntax/lint
}
```

Frames are throttled to ≤ 10 per real second. A run MUST be cancellable within 200 ms.

## Backend API (Laravel, JSON, Sanctum token or session)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Auth |
| GET | `/api/designs` | List my designs (paginated) |
| POST | `/api/designs` | Create design `{name, doc}` |
| GET | `/api/designs/{id}` | Get design |
| PUT | `/api/designs/{id}` | Update; body includes `base_version` for optimistic locking |
| DELETE | `/api/designs/{id}` | Delete |
| GET | `/api/designs/{id}/versions` | Version history |
| POST | `/api/designs/{id}/share` | Create/rotate share token `{visibility}` |
| GET | `/api/shared/{token}` | Read-only design (no auth) |
| GET | `/api/catalog/custom` | My custom services |
| POST/PUT/DELETE | `/api/catalog/custom[/{id}]` | CRUD custom services |
| GET | `/api/fixtures` / POST / PUT / DELETE | Saved test payloads |
| GET | `/api/prices/snapshot?providers=aws,gcp&regions=...` | Latest normalized prices (cached, ETag) |
| GET | `/api/prices/status` | Last sync time per provider |
| GET | `/api/challenges`, GET `/api/challenges/{slug}` | Challenge definitions |
| POST | `/api/challenges/{slug}/attempts` | Submit attempt `{design_doc, seed}`; server re-runs sim for verification |
| POST | `/api/explain` (optional, off by default) | LLM explanation from summarized result JSON (no user code) |

Rules: validate with JSON Schema; max design size 2 MB; rate limit 60 req/min per user; all list endpoints paginated.

## Scheduled jobs (Laravel scheduler)

- `prices:sync` nightly per provider (see file 14). Idempotent. Stores raw + normalized. Alerts if > 20% of SKUs change price in one run.
- `designs:prune-versions` weekly: keep last 50 versions per design.

## Server-side simulation

The same `sim-engine` package runs in Node for challenge verification (anti-cheat). Node runner is a small worker process (BullMQ or Laravel queue calling a Node CLI). Max run duration 60 s wall, 256 MB memory.

## Security

- User code only in QuickJS-WASM inside a Web Worker (file 12). Never `eval`/`new Function` in the main thread or on the server.
- CSP: no inline scripts except nonce'd; `worker-src 'self' blob:`.
- Share pages are read-only and render design JSON as data, never as HTML.
- Terraform/plan JSON input is parsed as data only; size limit 5 MB; secrets (`sensitive` values) are dropped on import.
- No third-party analytics receive design contents or code.
- Rate limit sandbox runs per session on the client (soft) and challenge verification on the server (hard).

## Performance budgets

| Item | Budget |
|---|---|
| Canvas | 200 nodes, 400 edges at 60 fps while idle; ≥ 30 fps while animating |
| Particles | Max 300 animated request dots at once |
| Sim 1k RPS × 60 s | < 2 s |
| Sim 10k RPS × 60 s | < 8 s using scaled sampling (file 05 §8) |
| Memory | < 300 MB in browser for a 10k RPS run |
| Log ring buffer | 50,000 entries |
| First load JS | < 400 KB gzip for the editor shell (lazy-load Monaco, sandbox WASM, Terraform) |

## Environments & config

`.env.example` MUST include: `APP_URL`, `DB_*`, `REDIS_*`, `SANCTUM_*`, `PRICE_SYNC_ENABLED`, `AWS_PRICING_*` (none needed for public bulk files), `GCP_BILLING_API_KEY`, `EXPLAIN_ENABLED=false`, `EXPLAIN_PROVIDER_KEY` (server only).

## Observability

Structured JSON logs on the backend, request IDs, Sentry (or equivalent) with **no** design/code payloads attached. Client error boundary around canvas, sandbox and engine panels so one failure does not blank the app.

## Decisions to log

Worker vs server execution thresholds; QuickJS vs isolated-vm; chart library; auto-layout library. Record in `docs/DECISIONS.md`.
