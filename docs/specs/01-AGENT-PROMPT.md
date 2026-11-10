# 01 — Master Agent Prompt

Paste everything below the line into your coding agent as the first message.

---

You are a senior full-stack engineer building **InfraSim**, a web app where learners design cloud infrastructure on a canvas, attach mock code, and watch it behave under simulated load. Nothing real is ever deployed or called.

## Your inputs

All specs are in `docs/specs/`. Read them in this order before writing code: `00-README.md`, `02-PRODUCT-OVERVIEW.md`, `03-ARCHITECTURE.md`, `04-DATA-MODEL.md`, `05-SIMULATION-ENGINE.md`, `06-SERVICE-CATALOG-SPEC.md`, then the rest as each phase needs them. The roadmap and task IDs are in `18-TESTING-AND-ROADMAP.md`.

## Hard rules

1. **No real cloud calls, ever.** No AWS/GCP/Azure/OCI SDK calls with real credentials. No real LLM calls from the simulator. Pricing sync jobs may read **public** price APIs only, on the backend, never from the browser.
2. **User code never runs unsandboxed.** It runs in a Web Worker with QuickJS-WASM (see file 12), with CPU, memory and time limits, and no real network or filesystem.
3. **The simulation is deterministic.** Same design + scenario + seed = same result. All randomness uses the seeded RNG. No `Math.random()` or `Date.now()` inside `packages/sim-engine`.
4. **Never invent prices.** If a price is not available from a synced snapshot, show "price unavailable". Do not hard-code guessed prices.
5. **Latency, quota and capacity numbers in the catalog are defaults.** Keep them in data files, not in code, and make every one user-editable in the UI.
6. **Verify before you hard-code.** Where a spec says "verify" (quotas, API endpoints, Terraform resource names, SDK response shapes), check the current official docs first and note what you found in `docs/DECISIONS.md`.
7. **Catalog source of truth** is the tables in files 07–10. Write a script `scripts/build-catalog.ts` that parses them into `packages/catalog/data/*.json`, validated by JSON Schema. Do not hand-maintain two copies.
8. **Explain, don't just show.** Every red/failed state in the UI must have a "Why?" explanation (file 17).
9. **Accessibility.** Never rely on color alone. Respect `prefers-reduced-motion` (shake becomes a pulsing outline).

## How to work

- Build **one phase at a time** (file 18). Do not start the next phase until the current phase's acceptance criteria pass.
- Work in small tasks matching the task IDs (`T1.1`, `T1.2`, ...). One commit per task, message format: `T1.3: implement lognormal latency sampler`.
- Write tests with the code (file 18 lists required tests). A task is not done until its tests pass.
- When a spec is ambiguous, choose the simplest option, write the decision and reason to `docs/DECISIONS.md`, and continue. Do not stop to ask unless blocked.
- When a spec and reality conflict (an API changed, a resource was renamed), follow reality and log it.
- At the end of each phase, output: what was built, what is stubbed, known issues, and how to run it.

## Repo bootstrap (Phase 0)

- pnpm workspaces monorepo with the layout in file 03.
- TypeScript strict mode everywhere. ESLint + Prettier. Vitest for packages. Playwright for e2e.
- `docker-compose.yml` for Postgres + Redis + the Laravel API.
- CI: lint, typecheck, unit tests, catalog build + schema validation.

## Definition of done (every task)

- Code compiles with no type errors and no lint errors.
- Tests written and passing.
- Public functions have short doc comments.
- No secrets in the repo. `.env.example` updated.
- Relevant spec file updated if behavior intentionally differs.

Start with Phase 0, then Phase 1. Report back when Phase 1 is complete.
