# InfraSim

**Deterministic Cloud Infrastructure Design & Discrete-Event Simulation Workbench**

InfraSim is a local-first engineering workbench for designing, simulating, and validating cloud architectures before deploying real infrastructure. Build topologies across AWS, GCP, Azure, and OCI, simulate hundreds of seconds of realistic traffic, observe queue saturation and cascading failures in real time, and diagnose bottlenecks with one-click architectural fixes.

---

## Key Capabilities

- **Interactive Architecture Canvas:** Drag-and-drop cloud service nodes, wire sync/async traffic paths, and organize resources into hierarchical regions, VPCs, and Availability Zones.
- **Deterministic Discrete-Event Simulation:** In-browser simulation engine executing up to 1,000+ requests/second in virtual time without network calls. Model queue buffers, concurrency limits, Little's Law queuing, and cold starts.
- **Why? Automated Diagnostics:** Root-cause DAG analysis ranks bottlenecks, queue drops, and cascading retries, generating actionable one-click JSON patches.
- **Multi-Cloud Catalog (243+ Services):** Pre-modeled latency distributions and verified quotas for AWS, GCP, Azure, and OCI, with support for custom services.
- **WASM QuickJS Code Sandbox:** Execute real user-authored TypeScript/JavaScript handler functions inside an isolated WebAssembly sandbox with zero server-side code execution.
- **Hop-by-Hop Network Reachability:** Formal reachability DAG analyzer inspecting Security Groups, NACLs, route tables, and NAT gateways.
- **Bi-Directional Terraform:** Export live architectures directly to clean Terraform HCL or import existing Terraform plans and state files.
- **Architecture Challenges:** Interactive troubleshooting scenarios with automatic client-side and server-side verification.
- **Local-First & Private:** Fully functional offline via IndexedDB, with optional cloud sync, version history, and revocable read-only share links.

---

## Monorepo Layout

```
├── apps/
│   ├── web/                    # Next.js 15 workbench UI, React Flow canvas, Monaco editor
│   └── api/                    # Laravel 11 REST API (designs, auth, challenges, prices)
├── packages/
│   ├── catalog/                # 243+ cloud services, pricing schemas, and verification log
│   ├── cost-engine/            # Multi-cloud cost calculator, breakdown, and sweep curves
│   ├── diagnosis/              # Automated root-cause diagnosis rules and fix patches
│   ├── network-analyzer/       # Reachability graph validator and packet routing engine
│   ├── sandbox/                # QuickJS WebAssembly code sandbox for user handlers
│   ├── shared-types/           # Canonical Design and Scenario schemas & Ajv validator
│   ├── sim-engine/             # Discrete-event simulation (DES) core and worker pool
│   ├── terraform/              # Terraform HCL generator and JSON state importer
│   └── ui-kit/                 # Graphite design tokens, accessible components, and themes
├── docs/                       # Architecture specifications and contribution guides
└── e2e/                        # Playwright end-to-end test suites
```

---

## Getting Started

### Prerequisites

- **Node.js:** v20+ (v22 recommended)
- **pnpm:** v9+
- **PHP:** 8.2+ and Composer (for backend API)
- **SQLite:** (default local API database)

### Installation

```bash
# Clone the repository
git clone https://github.com/MrNamra/InfraSim.git
cd InfraSim

# Install workspace dependencies
pnpm install

# Build catalog constants and copy sandbox WASM
pnpm catalog:build
pnpm prebuild
```

### Running the Workbench

```bash
# Start the web workbench (Next.js) on http://localhost:3000
pnpm --filter @infrasim/web dev
```

To run the optional Laravel API backend for cloud saving and challenge verification:

```bash
cd apps/api
composer install
php artisan migrate
php artisan serve
```

---

## Testing & Quality Budgets

InfraSim enforces strict performance, accessibility, and correctness budgets:

```bash
# Run unit and integration tests across all packages
pnpm test

# Verify catalog integrity
pnpm catalog:check

# Run lint and TypeScript typechecks
pnpm lint
pnpm typecheck

# Run Playwright E2E suites
pnpm exec playwright test
```

- **Bundle Budget:** Web homepage initial load JS `< 400 kB` (currently `~351 kB`).
- **Accessibility:** Zero critical or serious axe-core violations; full keyboard canvas controls.
- **Simulation Speed:** 1,000 req/s &times; 60 s simulated in `< 2 seconds`.

---

## Documentation & Contributing

- [Architecture Guide & Simulator Mechanics](apps/web/src/app/docs/page.tsx) (`/docs`)
- [Privacy Policy & Data Commitments](apps/web/src/app/privacy/page.tsx) (`/privacy`)
- [Catalog Contribution Guide](docs/CONTRIBUTING-CATALOG.md)
- [Catalog Sources & Verification Log](packages/catalog/SOURCES.md)
- [Technical Decision Records](docs/DECISIONS.md)

---

## License

MIT © InfraSim Contributors.
