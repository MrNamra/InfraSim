# 18 — Testing Strategy & Roadmap

Task IDs (`T<phase>.<n>`) are referenced by the agent prompt (file 01). Build **one phase at a time**; a phase is done only when all its acceptance criteria pass.

## 1. Test strategy

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Pure functions: samplers, queue logic, cost formulas, rules, parsers |
| Property-based | fast-check | Engine invariants (file 05 §12), network analyzer, template evaluator |
| Golden/snapshot | Vitest snapshots | Sim golden scenarios (file 05 §13), Terraform export, network cases |
| Contract | JSON Schema + Zod | Catalog data, design documents, API payloads |
| Backend | Pest/PHPUnit | Laravel API, price sync jobs (with recorded fixtures), auth, optimistic locking |
| E2E | Playwright | Build design → run → see red/shake → Why? → apply fix; payload tester; export Terraform |
| Performance | Vitest bench + Playwright traces | Budgets in file 03 |
| Security | Custom tests | Sandbox escape attempts, network-block tests, secret sanitizer, CSP |
| Accessibility | axe + manual | Reduced motion, keyboard, contrast |
| Visual regression | Playwright screenshots | Node states (ok/warm/hot/overloaded/down) in light/dark |

CI gates: lint, typecheck, unit + property tests, catalog build/validate, price-coverage check, backend tests, e2e smoke, bundle-size budget.

**Determinism rule:** any test depending on randomness passes an explicit seed.

## 2. Definition of Done (task)

Code + tests pass; types clean; docs/comments updated; `.env.example` updated; decisions logged in `docs/DECISIONS.md`; no secrets; spec file updated if behavior differs.

## 3. Phases

### Phase 0 — Bootstrap
| ID | Task |
|---|---|
| T0.1 | pnpm monorepo, TS strict, ESLint/Prettier, Vitest, Playwright skeletons (file 03 layout) |
| T0.2 | `shared-types` from file 04 + JSON Schema generation in CI |
| T0.3 | Docker compose (Postgres, Redis, Laravel API); Laravel app with auth (Sanctum) |
| T0.4 | Next.js app shell, theming, layout panels (empty), command palette stub |
| T0.5 | CI pipeline + `docs/DECISIONS.md` |

**Accept:** `pnpm test` and CI green; app boots; user can register/login; empty editor shell renders.

### Phase 1 — Canvas + core simulation (MVP)
| ID | Task |
|---|---|
| T1.1 | Catalog build script: parse files 07–10 tables → JSON, schema validation, CI checks (file 06 §2) |
| T1.2 | Palette with search/providers/categories; drag to canvas |
| T1.3 | React Flow canvas: nodes, edges, groups (region/VPC/AZ/subnet), undo/redo, autosave (IndexedDB) |
| T1.4 | Inspector: Config + "Latency & Mock" tab (service-level p50/p95/error rate/capacity, reset, presets) |
| T1.5 | Sim engine core: seeded RNG, event heap, lognormal sampler, stations (slots, cores, queue), compute two-constraint model |
| T1.6 | Traffic profiles (constant/ramp/spike/steps) + Client/Load Generator node |
| T1.7 | Behaviors: LB, DB pool, cache, queue/async, gateway; timeouts, retries, circuit breaker |
| T1.8 | Metrics buckets, log-histogram percentiles, health states + hysteresis (file 05 §9) |
| T1.9 | Run controls, frames → UI; **red bar + shake + reduced-motion fallback**; request particles |
| T1.10 | Metrics dock charts; result summary card; theoretical-max-RPS label |
| T1.11 | Starter templates 1–2 (3-tier, add cache) |

**Accept:** build 3-tier, run 1k RPS × 60 s in < 2 s; overload at spike shows red bar + shake; golden scenarios 1–2 and invariants pass; determinism test passes.

### Phase 2 — Full catalog, mock editing, cost
| ID | Task |
|---|---|
| T2.1 | Full catalogs for AWS/GCP/Azure/OCI loaded from tables; "typical default" labeling; icons |
| T2.2 | Operation-level mock editor: templates, status, headers, errors, schema; preview; template engine (file 06 §4) |
| T2.3 | Custom services editor + `custom_services` API + embed in shared designs |
| T2.4 | Serverless model (cold starts, concurrency, throttle/queue), autoscaling, health-check cascade |
| T2.5 | Network placement latency (AZ/region matrix) on edges |
| T2.6 | Backend price sync (AWS, Azure first), normalized schema, `price_sku_map`, coverage report |
| T2.7 | Price sync for GCP and OCI; region mapping; instance specs curated file |
| T2.8 | Cost engine: formulas, tiers, transfer categories, warnings, canvas chips, Cost dock |
| T2.9 | Provider switch via `equivalents` + cost comparison; region comparison |
| T2.10 | Chaos events + scenario timeline editor; traces + waterfall |

**Accept:** every catalog row renders and runs; editing p50/p95 changes next run; costs show synced prices or "unavailable" (never invented); coverage report generated; golden scenarios 3–7 pass.

### Phase 3 — Code sandbox, payloads, logs, AI mocks
| ID | Task |
|---|---|
| T3.1 | QuickJS-WASM worker, virtual time loop, resource limits, watchdog (file 12 §3, §11) |
| T3.2 | Bundler (esbuild-wasm), allow-list modules, TS stripping, source maps |
| T3.3 | Mock SDK universal `cloud.call` + HTTP interceptor + error objects |
| T3.4 | SDK shims: AWS v3 generic + DynamoDB doc client + Bedrock; GCP/Azure/OCI starter shims |
| T3.5 | Fixture library (event templates), JSON editor + schema validation |
| T3.6 | Payload Tester panel, detected calls table, per-call mock editing |
| T3.7 | **Auto-fill mocks** (discovery run with Proxy) + Payload Doctor rules |
| T3.8 | Log capture, platform log lines, Log panel (filters, group by request, download) |
| T3.9 | Profiling → CallPlan; engine executes plans; replayed logs; live-code mode ≤ 50 RPS |
| T3.10 | k6-style scenario scripts → flows + thresholds |
| T3.11 | AI mocks: token latency model, TPM/RPM buckets, streaming, provider shapes, async jobs, `json-fill` (file 11) |
| T3.12 | Sandbox security test suite (infinite loop, memory bomb, network block, prototype pollution) |

**Accept:** file 12 acceptance tests 1–12 and file 11 tests 1–6 pass; pasted AWS SDK code runs unmodified against mocks; a deliberate `TypeError` from an empty mock is fixed by Auto-fill in one click; logs visible per invocation and for sampled load requests.

### Phase 4 — Networking & reachability
| ID | Task |
|---|---|
| T4.1 | Network data model, attachments, defaults per provider when placing nodes in groups |
| T4.2 | Analyzer: routing, SG/NACL/NSG/GCP/OCI evaluators, listeners, DNS, peering, endpoints |
| T4.3 | Failure modes → engine (timeout vs refused vs dns) |
| T4.4 | Reachability dock, edge states, "check all edges", explanations (short/deep templates) |
| T4.5 | Fix patches with diff preview + apply |
| T4.6 | Network lessons/templates (file 13 §9) |

**Accept:** golden tests 1–14 pass; a blocked edge shows reason and fix; applying the fix makes traffic flow in the next run; connection timeout vs refused visible in logs.

### Phase 5 — Terraform
| ID | Task |
|---|---|
| T5.1 | HCL builder + export for AWS subset, ZIP download, preview tab |
| T5.2 | Export for GCP, Azure, OCI subsets |
| T5.3 | Import: plan JSON parser, sanitizer, module flattening, classification |
| T5.4 | Containment + references + network object import; ELK auto-layout |
| T5.5 | Edge inference + import report UI |
| T5.6 | Round-trip and fixture tests; secret-sanitizer tests |

**Accept:** snapshot tests stable; round-trip lossless for supported subset; no secret value ever stored; imported design runs in the simulator.

### Phase 6 — Insights, challenges, sharing
| ID | Task |
|---|---|
| T6.1 | Diagnosis engine + rule framework + first 20 rules |
| T6.2 | Root-cause DAG, ranking, Why? tab, Insights dock, fix apply + re-run compare |
| T6.3 | Remaining rules (file 17 §3) |
| T6.4 | Challenge engine, server verification, pinned price snapshot, scoring |
| T6.5 | Challenge UI + 10 starter challenges + hidden reference solutions |
| T6.6 | Share links (read-only), mobile viewer, design versions |
| T6.7 | Optional LLM explainer behind flag (summarized payload preview) |
| T6.8 | Run comparison (A/B) + cost-vs-latency sweep |

**Accept:** coverage invariant (every hot node has an insight) holds; challenges deterministic client vs server; shared link renders on mobile read-only.

### Phase 7 — Polish & launch
| ID | Task |
|---|---|
| T7.1 | Performance pass to budgets (file 03); bundle splitting |
| T7.2 | Accessibility pass; reduced motion; keyboard completeness |
| T7.3 | Onboarding tour, template gallery (all 10), empty/error states |
| T7.4 | Quota verification pass across all catalog rows; fill `packages/catalog/SOURCES.md` with sources and dates |
| T7.5 | Observability, rate limits, abuse protection, backups, privacy policy page |
| T7.6 | Docs site: "how the simulator works", "what's estimated vs real", glossary |

**Accept:** budgets met; axe has no serious issues; every quota/number flagged "verify" has a source or is relabelled as approximate.

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Users treat numbers as real benchmarks | "Typical default — edit me" labels, assumptions panel, docs page, estimate chips |
| Price sources change/break | Loud failure, keep last snapshot, coverage CI, staleness warning |
| QuickJS CPU time ≠ Node | Manual override first-class; `cpuScale` explained; relative cost shown |
| Sandbox escape / abuse | WASM isolation, limits, no network, watchdog, tests; never run user code server-side |
| Scope explosion (hundreds of services) | Behavior kinds + data-driven catalog; add services by editing tables, not code |
| Large-scale sim performance | Scaled DES, histograms, sampling, worker, budgets |
| Vendor icon/trademark issues | Own icons + provider badge; review terms before any vendor art |
| Terraform provider drift | Mapping tables are data; verification step; unsupported → gray node |
| Misleading "fix" suggestions | Fixes are minimal, previewed, re-run to verify, trade-offs stated |

## 5. Release checklist (v1)

- [ ] All phase acceptance criteria green
- [ ] Catalog quotas verified; `SOURCES.md` complete
- [ ] Price coverage report ≥ agreed threshold; unavailable list reviewed
- [ ] Security tests pass; CSP verified; dependency audit clean
- [ ] Performance budgets met on a mid-range laptop
- [ ] Accessibility checks pass
- [ ] Privacy: no design/code content in analytics/error reports
- [ ] Docs: README, user guide, "estimates vs reality", contributing guide for catalog edits
