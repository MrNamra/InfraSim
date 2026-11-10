# 02 — Product Overview

## Vision

Help new system designers understand **low-level system design** by letting them build an architecture, put load on it, and see exactly where and why it fails — with an estimated cost — without paying for any real infrastructure.

## The problem

- Diagram tools (Eraser, draw.io) draw boxes but cannot tell you if the design survives 5,000 RPS.
- Real cloud labs cost money, take time to provision, and hide the reason for a failure inside logs.
- Beginners don't know typical response times, limits, or which misconfiguration causes "service A cannot reach service B".

## Personas

| Persona | Need |
|---|---|
| Junior backend dev | Understand why the DB melts when traffic grows; learn caches, queues, load balancers |
| Interview candidate | Practice system design with numbers; check whether the design meets a target |
| Bootcamp student | Safe place to experiment, no cloud bill |
| Tech lead / teacher | Share a design link, run a scenario live, teach bottlenecks |
| Cost-curious founder | Compare AWS vs GCP vs Azure vs OCI estimates for the same shape |

## Core user stories (with acceptance criteria)

**US-1 Design.** As a user I drag services from four clouds onto a canvas, connect them, and group them into regions, VPCs, subnets and AZs.
- AC: I can build a 3-tier app in under 2 minutes. Undo/redo works. Design autosaves.

**US-2 Tune mock services.** As a user I click any service and set its average response time (p50/p95), error rate, capacity, and mock response body.
- AC: Defaults are pre-filled from the catalog. Edits are visible on the node. "Reset to default" exists.

**US-3 Add my code.** As a user I paste a JS handler, pick a test payload, run it once, and see its return value and logs.
- AC: If my code throws, I see the error, the line, and a hint. Calls to mocked services return realistic shapes so my code does not crash on missing data.

**US-4 Load test.** As a user I set RPS, duration, and a traffic pattern (constant, ramp, spike), then run.
- AC: Requests animate along edges. Per-node utilization, queue depth, p50/p95/p99 and error rate update live.

**US-5 See stress.** As a user I see which service is overloaded and in which situation.
- AC: A node above its threshold shows a red bar; a node dropping requests shakes. Clicking "Why?" explains the cause.

**US-6 Cost.** As a user I see estimated monthly cost per node and total, by region and provider.
- AC: Prices come from synced public price lists. Missing prices show "unavailable", never a guess.

**US-7 Network debugging.** As a user I ask "why can't A reach B?" and get the exact blocking rule and a one-click fix.
- AC: Covers route tables, firewalls/security groups, ports, NAT, DNS, peering.

**US-8 Terraform.** As a user I export my canvas to Terraform, or import a Terraform plan JSON to visualize an existing design.
- AC: Round-trip of the supported resource subset is lossless.

**US-9 Logs.** As a user I see logs from my code and from the simulated platform (throttles, timeouts, drops) with filters and per-request grouping.

**US-10 Learn.** As a user I get starter templates and challenges ("handle 10k RPS under $500/month with p99 < 200 ms").

## Scope

**v1 MUST:** canvas, 4-cloud catalog, editable mock latency/response, simulation engine with red-bar/shake, cost estimate, JS sandbox with payload tester and logs, networking reachability, Terraform export, templates.

**v1 SHOULD:** Terraform import, challenges, run comparison (A/B), sharing links.

**v1 MAY:** LLM-written explanations, team workspaces, custom service marketplace.

## Non-goals

- Not a real deployment tool. Never runs `terraform apply`.
- Not a benchmark. Numbers are educational estimates and are labeled so.
- Not a monitoring product.
- No real credentials, no real LLM calls from the simulator.
- No exact emulation of each cloud API. Only enough shape fidelity that user code does not crash.

## Product principles

1. **Honest estimates.** Always show assumptions and let users change them.
2. **Explain the why.** A failure without an explanation is a bug.
3. **Fast feedback.** A small simulation (≤ 1,000 RPS, 60 s) returns results in under 2 seconds.
4. **Teach tradeoffs, not trivia.** Cache vs DB load, sync vs async, cost vs latency.
5. **Safe by default.** User code is sandboxed; nothing leaves the browser except saved designs.

## Glossary

- **RPS** — requests per second. **p50/p95/p99** — latency percentiles.
- **Utilization** — busy capacity ÷ total capacity (0–100%+).
- **Saturation** — utilization near 100% with a growing queue.
- **TTFT** — time to first token (LLM). **TPM/RPM** — tokens / requests per minute quota.
- **Cold start** — extra latency when a serverless instance is created.
- **Cascading failure** — one slow service causing upstream queues and timeouts.
- **Reachability** — whether a packet from A can reach B given routes and firewalls.

## Success metrics

- Time from sign-up to first "red bar" moment: under 5 minutes.
- % of runs where user opens a "Why?" explanation.
- % of users who edit at least one mock latency.
- Challenge completion rate.
