# Architecture & Implementation Decisions

Recorded decisions where specs offered alternatives, flagged ambiguities, or interacted with host/runtime realities.

## Phase 0 — Bootstrap

### 1. TypeScript Schema Adjustments (`T0.2`)

- **`Insight.explanation` shape**: Typed as `{ short: string; deep: string }` across `packages/shared-types/src/diagnosis.ts` to align `04-DATA-MODEL.md` (which commented "short + deep versions") with `13-NETWORKING-REACHABILITY.md` and `17-DIAGNOSIS-AND-CHALLENGES.md`.
- **Optional `NetworkConfig` arrays**: Made the top-level arrays on `NetworkConfig` (`networks`, `subnets`, `routeTables`, etc.) optional so the minimal design example in `04-DATA-MODEL.md` (`"network": {}`) validates directly against `packages/shared-types/schemas/design.schema.json`. Added `createEmptyNetworkConfig()` helper for normalized access.
- **Complete union variants**: Added `'cache-flush'` to `ChaosEvent` (`05-SIMULATION-ENGINE.md` §7), `'compartment'` to `GroupInstance.kind` (`10-CATALOG-OCI.md` / `16-UI-UX-SPEC.md`), and `runtimePreset`, `ai`, `storageGb`, `scannedBytes`, `scenarioOverrides`, `prefixes`, `cancelOnTimeout`, `connectionWaitMs`, and `writeLatencyMultiplier` fields to `NodeConfig` (`05`, `06`, `07`, `11`, `14`).
- **JSON Schema generation**: `ts-json-schema-generator` omits `config.path` and reads `tsconfig.fileNames` so all `packages/shared-types/src/**/*.ts` definitions resolve without `TS6307`.

### 2. Containerized Laravel Dev Server (`T0.3`)

- **PHP built-in server in container entrypoint**: `php artisan serve` filters container environment variables through its internal `ServeCommand` whitelist and can fall back to `.env` defaults (`DB_CONNECTION=sqlite` in host files). `apps/api/docker-entrypoint.sh` therefore runs `cd /var/www/html/public && exec php -S 0.0.0.0:8000 ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php` after Postgres and Redis pass healthchecks and `php artisan migrate --force` succeeds.
- **Stateless Sanctum Bearer tokens on `/api/*`**: Disabled `$middleware->statefulApi()` so browser requests from `http://localhost:3000` / `http://127.0.0.1:3000` using `Authorization: Bearer <token>` (without cookies) never hit Laravel's `419 CSRF token mismatch` middleware on `/api/auth/register` or `/api/auth/login`.
- **SQLite `:memory:` for fast PHPUnit runs**: `apps/api/phpunit.xml` targets SQLite `:memory:` so unit/feature suites execute in <1 s offline; live Postgres 16 + Redis 7 compatibility is verified via Docker Compose and CI migrations.
- **Docker build DNS note**: Hosts running local `systemd-resolved` stubs (`127.0.0.53`) may require `docker build --network=host -t infrasim-api:local ./apps/api` prior to `docker compose up -d` unless Docker daemon DNS is configured globally.

### 3. Frontend Stack, Visual System, and Icons (`T0.4`)

- **Tailwind CSS v3.4 + CSS custom properties**: Pinned Tailwind v3.4 (`tailwindcss@3.4`, `postcss`, `autoprefixer`) paired with Graphite dark (`#0f0f10`–`#232325`) and light (`#f4f4f5`–`#ffffff`) CSS custom properties in `packages/ui-kit/src/styles.css`. Avoids Tailwind v4 config churn with monorepo workspace transpile packages while keeping theming deterministic.
- **Self-hosted offline fonts**: Bundled `@fontsource/ibm-plex-sans` and `@fontsource/jetbrains-mono` in `apps/web` instead of remote font CDNs so offline runs and Playwright tests remain deterministic and zero-latency.
- **Own-drawn & Lucide icon policy (`16-UI-UX-SPEC.md` §12)**: InfraSim uses custom geometric SVGs (`LogoMark`, kind glyphs) and `lucide-react` 16 px stroke icons alongside provider badge chips (`AWS`, `GCP`, `Azure`, `OCI`, `Generic`, `Custom`) rather than embedding official cloud vendor trademark logo sets.
- **Reduced motion exemption class**: Global `@media (prefers-reduced-motion: reduce)` excludes `.infrasim-motion-safe` so overloaded nodes replace horizontal shaking with a non-translating pulsing outline while disabling movement animations across the UI.
- **Next.js typecheck in CI**: `apps/web/package.json` runs `next typegen && tsc -p tsconfig.json --noEmit` so `pnpm typecheck` passes cleanly even before `next build`, and `eslint.config.mjs` / `.prettierignore` ignore auto-generated `apps/web/next-env.d.ts`.

### 4. Architecture & Library Choices (`03-ARCHITECTURE.md`)

- **Pure-package ESLint guardrails**: `eslint.config.mjs` enforces that `sim-engine`, `network-analyzer`, `cost-engine`, `diagnosis`, and `terraform` never import `react`, `next`, `node:*`, Node standard modules, or browser globals (`window`, `document`, `localStorage`). `sim-engine` also forbids `Math.random()`, `Date.now()`, and `new Date()` outside test files.
- **Worker communication (`Comlink`)**: Dedicated Web Workers (`sim.worker` and `sandbox.worker`) use `comlink` for typed RPC, with frame updates throttled to `<= 10` frames/s real time and `AbortSignal` / run-ID cancellation within 200 ms.
- **Sandbox runtime (`QuickJS-WASM`)**: Phase 3 executes user JS/TS inside `quickjs-emscripten` inside `sandbox.worker` (bundled with `esbuild-wasm`) rather than `isolated-vm` (requires native V8 addons on server) or host `vm`/`eval`, preserving zero-credential browser execution and deterministic virtual time.
- **Charts & auto-layout choices (logged upfront for Phase 1 / Phase 5)**:
  - **Charts**: Lightweight custom SVG time-series charts with LTTB decimation (`<= 500` points) in Phase 1 (or Recharts if complex multi-axis tooltips become needed), minimizing First Load JS within the 400 KB gzip workbench budget.
  - **Auto-layout**: `elkjs` planned for nested Region/VPC/AZ/Subnet containers and Terraform import graph layout (Phase 5), since `dagre` does not natively support compound nested groups cleanly.

## Phase 1 — Canvas + Core Simulation (MVP)

### 5. Catalog Build Pipeline & Equivalents (`T1.1`)

- **Dual build output (JSON + static TypeScript)**: `scripts/build-catalog.ts` emits normalized per-provider files in `packages/catalog/data/{aws,gcp,azure,oci,generic,index}.json` **and** `packages/catalog/src/generated/catalogData.ts` so browser bundles, Next.js client components, Vitest, and Web Workers import `@infrasim/catalog` without runtime filesystem reads or JSON import assertions. `pnpm catalog:check` verifies both artifacts match `docs/specs/07-10` and `packages/catalog/defaults/*`.
- **Category heading cleanup**: Normalized Markdown `### AI & ML (mocked — see file 11)` headings to `"AI & ML"` in the generated catalog so palette grouping stays concise and uniform across providers.
- **PostgreSQL equivalence on OCI**: Mapped PostgreSQL services (`aws.rds_postgres`, `gcp.cloud_sql_postgres`, `azure.postgres_flexible`) directly to `oci.postgres` present in `docs/specs/10-CATALOG-OCI.md` (while `aws.rds_mysql`, `gcp.cloud_sql_mysql`, and `azure.mysql_flexible` map to `oci.mysql_heatwave`), updating the earlier starter note in `06-SERVICE-CATALOG-SPEC.md` §8 which listed `oci.mysql_heatwave (closest)`.
