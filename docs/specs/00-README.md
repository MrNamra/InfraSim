# InfraSim — Spec Pack (working title)

A web app where learners **design cloud infrastructure on a canvas, attach mock code, and watch it behave under load** — without buying any real infrastructure. Everything is simulated. No real cloud account, no real API key, no real network call is ever made.

## What the product does (one paragraph)

The user drags services from AWS, GCP, Azure and OCI onto a canvas, connects them, and sets each service's average response time, capacity and mock responses. They write JavaScript handler code and a traffic script (RPS, duration, user flows). The simulator pushes virtual requests through the design, animates them, makes overloaded services **shake with a red bar**, shows logs of the user's code, estimates monthly cost from real public price lists, explains *why* two services cannot reach each other, and can import/export Terraform.

## File index

| # | File | Purpose |
|---|------|---------|
| 00 | `00-README.md` | This index, conventions, assumptions |
| 01 | `01-AGENT-PROMPT.md` | Master prompt to paste into the coding agent |
| 02 | `02-PRODUCT-OVERVIEW.md` | Vision, personas, user stories, scope, non-goals |
| 03 | `03-ARCHITECTURE.md` | Monorepo, tech stack, runtime, backend API |
| 04 | `04-DATA-MODEL.md` | TypeScript types + Postgres schema |
| 05 | `05-SIMULATION-ENGINE.md` | Discrete-event engine, queueing, failure behaviors |
| 06 | `06-SERVICE-CATALOG-SPEC.md` | Catalog schema, mock kinds, user-editable latency/responses, custom services |
| 07 | `07-CATALOG-AWS.md` | All AWS services + default response times |
| 08 | `08-CATALOG-GCP.md` | All GCP services + default response times |
| 09 | `09-CATALOG-AZURE.md` | All Azure services + default response times |
| 10 | `10-CATALOG-OCI.md` | All OCI services + default response times |
| 11 | `11-AI-SERVICES-MOCK.md` | How mocked AI services (LLM, vision, speech) behave |
| 12 | `12-CODE-SANDBOX-AND-LOGS.md` | Running user code, test payloads, mock SDK, log viewer |
| 13 | `13-NETWORKING-REACHABILITY.md` | VPC/firewall model and "why can't A reach B" |
| 14 | `14-COST-ENGINE.md` | Price sync, cost formulas, regions |
| 15 | `15-TERRAFORM.md` | Terraform export and import |
| 16 | `16-UI-UX-SPEC.md` | Screens, visual states, shake/red-bar, panels |
| 17 | `17-DIAGNOSIS-AND-CHALLENGES.md` | "Why?" insights engine, challenge mode |
| 18 | `18-TESTING-AND-ROADMAP.md` | Test strategy, phases, task checklist, definition of done |

## How to use with a coding agent

1. Create the repo and copy this folder to `docs/specs/`.
2. Paste `01-AGENT-PROMPT.md` into the agent as the first message.
3. Let it build **one phase at a time** (see file 18). Review after each phase.
4. The catalog tables in files 07–10 are the **source of truth**. The agent generates JSON from them (see file 06).

## Conventions

- **MUST / SHOULD / MAY** are used in the RFC sense.
- Service IDs are `provider.service` in snake_case: `aws.s3`, `gcp.cloud_run`, `azure.functions`, `oci.object_storage`.
- Operation IDs append a PascalCase operation: `aws.s3.GetObject`.
- All times are **milliseconds** unless stated. All simulation time is **virtual time**.
- Every latency, quota and price in these files is a **starting default**, not a benchmark. The UI MUST label them "typical default — edit me".
- Where a spec says "verify", the agent MUST check the provider's current documentation before hard-coding a number.

## Assumptions made in this pack (change if wrong)

1. "Add any service" is interpreted as: users can also **create custom services** (a new block with their own name, latency and mock responses) in addition to the built-in catalog.
2. Frontend is Next.js + React Flow. Backend is Laravel + Postgres. The simulation engine is a pure TypeScript package that runs in the browser (Web Worker).
3. User code is **JavaScript only** in v1. Other languages: user types the service time manually.
4. Pricing is **on-demand only** in v1 (no reserved/spot/savings plans).
5. No real cloud credentials are ever collected. Terraform is only generated and parsed, never executed.

## Open questions (agent: record answers in `docs/DECISIONS.md`)

- Final product name and domain.
- Free vs paid tiers and limits (designs per user, max RPS, max duration).
- Whether to allow public sharing of designs by default.
