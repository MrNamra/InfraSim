# 16 — UI/UX Spec

App: `apps/web` (Next.js) using `packages/ui-kit`. Desktop-first (≥ 1280 px). Tablet: usable. Mobile: **read-only viewer** for shared designs.

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Top bar: [Logo] Design name ▾ · Provider ▾ · Region ▾ · Scenario ▾ · ▶ Run ⏸ ⟲ · Speed ▾ │
│          Cost chip ($X/mo ⓘ) · Share · Terraform ▾ · Undo/Redo · Account                  │
├───────────┬──────────────────────────────────────────────────────────┬───────────────────┤
│ Palette   │                         Canvas                           │ Inspector         │
│ (search,  │   groups: Region ▸ VPC ▸ AZ ▸ Subnet, nodes, edges       │ Tabs: Config ·    │
│ providers,│   animated request dots, red bars, shake, badges         │ Latency & Mock ·  │
│ categories│                                                          │ Code · Network ·  │
│ favorites,│   Mini-map · zoom · fit · grid snap · auto-layout        │ Cost · Why?       │
│ custom)   │                                                          │                   │
├───────────┴──────────────────────────────────────────────────────────┴───────────────────┤
│ Bottom dock tabs: Metrics · Logs · Traces · Reachability · Terraform · Cost · Insights   │
│ + time scrubber (virtual time) with run markers (chaos events, scale events)             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
Panels are resizable and collapsible; layout persisted per user. Keyboard-first: `Cmd/Ctrl+K` command palette (add node, run, open panel, switch provider).

## 2. Palette

- Search across all providers (name, tags, aliases like "queue", "cache", "LLM").
- Provider tabs: **All · AWS · GCP · Azure · OCI · Generic · Custom**. Categories collapsible (file 07–10 headers).
- Each item: icon, name, provider badge, default latency chip (e.g. `~15 ms`), hover card with description and kind.
- Drag to canvas; double-click to add at viewport center; "Favorites" and "Recently used".
- **Generic** section: Client / Load Generator, Internet, Users, Load Balancer, Cache, DB, Queue, Service (provider-neutral blocks for people who want to design first and pick a provider later).
- **Custom services**: "＋ New service" opens the custom service editor (file 06 §6).

## 3. Canvas

- React Flow. Nodes show: icon, label, provider color stripe, **health bar** (utilization), **badges** (instances ×N, errors/s, queue depth), and small `~p50ms` chip.
- **Groups**: Region, VPC/VNet/VCN, AZ/zone, Subnet, Cluster, Compartment (OCI). Nesting supported; dragging a node into a group sets `parentGroupId` and attaches network defaults. Group header shows CIDR and public/private tag (derived from routes).
- **Edges**: label shows `protocol:port`, weight, and live RPS during a run. Styles: solid (sync), dashed (async), red dashed with ✖ (blocked by network), amber (risky). Click edge → side popover: latency, retry/timeout/circuit-breaker settings, payload size, reachability status.
- Snap to grid (16 px), alignment guides, multi-select, copy/paste, duplicate (⌘D), undo/redo (≥ 100 steps), auto-layout (ELK) button, "Fit view".
- **Provider switch**: "Switch all to AWS/GCP/Azure/OCI" maps nodes via `equivalents` with a preview diff and list of behavior differences.
- Context menu on node: Edit latency, Add code, Duplicate, Set instances, Check reachability from here, Why is this slow?, Delete.

## 4. Visual states (core feature)

Driven by `NodeFrame.health` and `utilization` (file 05 §9). **Never color-only**: each state also has an icon and text label (screen-reader text).

| State | Bar | Node chrome | Icon/label |
|---|---|---|---|
| `ok` (< 60%) | green bar | normal | ● "Healthy" |
| `warm` (60–80%) | yellow | subtle yellow outline | ◐ "Warming up" |
| `hot` (80–95%) | orange→red | orange outline, bar pulses slowly | ▲ "Under stress" |
| `overloaded` | **red bar, full** | **shake animation** + red glow + count badge of drops/errors | ⚠ "Overloaded" |
| `down` | grey | struck-through label, desaturated | ✖ "Down" |

### Red bar
- Horizontal bar under the node title (or a vertical bar at the node's right edge in compact mode). Fill = `min(utilization, 1.2)`; segments at 60/80/95%. Over 100% shows an overflow cap "+".
- Tooltip: utilization %, CPU %, in-flight / slots, queue depth, throughput, p50/p95/p99, errors/s by kind, **top reason** ("slots exhausted waiting on `db`").
- Optional second thin bar for **CPU** vs **slots** (compute nodes) so users see *which* resource is saturated.

### Shake
- CSS keyframes, ~80 ms period, `translateX(±2px)`, intensity scales with drop rate (cap at ±3px). Runs only while state is `overloaded`.
- Respect `prefers-reduced-motion: reduce` → replace shake with a pulsing red outline and a static "⚠" badge. Provide a settings toggle "Reduce motion".
- Never animate more than 30 shaking nodes at once (cap for perf; others show static red glow).

### Edges and particles
- Request dots flow along edges (SVG `animateMotion` or canvas overlay). Cap 300 dots. Color: green ok, yellow slow (> 2× p50), red error (✖ shape too). Dot density ∝ rps (sampled).
- Error bursts: small "✖" pops near the failing node with the error kind.
- Queue indicator: a small stack icon near the node that fills with queue depth.

## 5. Inspector

**Config**: label, region/AZ, instances, instance type (searchable list from price data), vCPU/memory, runtime preset, max in-flight, queue, autoscaling, timeouts, retries (on outgoing edges).
Show **"Theoretical max RPS"** computed from capacity (file 05 §2) with an explanation tooltip.

**Latency & Mock** (the tab users asked for):
```
Service latency        p50 [ 15 ] ms   p95 [ 60 ] ms   distribution [lognormal ▾]   ⟲ default
Error rate             [ 0.05 ] %      Throttle limit [ 1000 ] rps / burst [ 200 ]
Cold start             [x] enabled     p50 [ 250 ] p95 [ 900 ] idle TTL [ 600 ] s
─ Operations ─────────────────────────────────────────────────────────────────────────────
 GetObject  ▸  latency [inherit ▾]  status [200]  response size [20 KB]  error rate [0 %]
               Response template  ┌─────────────────────────────────────────────┐ [Preview ▶]
                                  │ { "Body": "{{binary(20480)}}", ... }         │
                                  └─────────────────────────────────────────────┘
               Input schema (JSON Schema) [Edit]      Errors: [+ Add error: 503 SlowDown 1 %]
 PutObject  ▸ ...
[Save as preset]  [Reset node to defaults]                          ● edited fields marked
```
- Inline validation (p95 ≥ p50, template syntax) with precise messages.
- "Preview" renders the template with a sample input and seed.
- Scenario-level overrides: "Add time-boxed override" (e.g. DB p95 800 ms from 30–60 s).

**Code** (compute/serverless nodes): Monaco editor (JS/TS), file tabs, run config (memory, timeout, env vars), fixture selector, **Run** and **Profile** buttons, **Payload Tester** panel (below) — see file 12. Console + Detected calls inline. Diagnostics from Payload Doctor appear as editor markers and a hint list with **Apply fix** buttons.

**Network**: attachments (subnet, private/public IP, firewalls, tags), listening ports, mini route table view, "Check reachability" quick form.

**Cost**: lines for this node with unit prices, source chip (synced / manual / unavailable), manual price override field.

**Why?**: when a node is selected during/after a run, shows insights for that node (file 17) with short + deep explanation and fix buttons.

## 6. Bottom dock

| Tab | Content |
|---|---|
| **Metrics** | Time-series charts (stacked/small multiples): RPS in/out, latency p50/p95/p99, errors by kind, utilization, queue depth, in-flight, instances. Click a series point → sets scrubber time. Dotted "theory" line (Erlang C) toggle. Per-node selector + "Compare to previous run" overlay. |
| **Logs** | File 12 §9.3. |
| **Traces** | List of sampled requests (status, duration, flow). Click → **waterfall**: spans per node (wait vs service time, colored), retries, timeouts, "zombie work" markers; click span → node and logs. |
| **Reachability** | File 13 §7: query form, hop list with ✔/✘, fixes with **Apply** and diff. "Check all edges" table. |
| **Terraform** | Live HCL preview + Export/Import (file 15). |
| **Cost** | Breakdown table + donut by category + warnings; compare providers/regions; sweep chart. |
| **Insights** | All diagnosis results sorted by severity with fix buttons (file 17). |

## 7. Run controls

- **Run** → scenario picker (traffic profile editor: constant/ramp/spike/steps/diurnal/custom curve with a small chart), duration, seed (default 42, "randomize"), scaled-mode notice if used.
- Playback speed: 1×, 5×, 20×, max. Pause/step. **Scrubber** to replay frames; chaos and autoscale events as markers.
- **Chaos** menu: kill instance(s), AZ outage, add latency, error rate, throttle, flush cache — click node → "Inject…" or add to scenario timeline.
- **Compare runs**: pin Run A, change design, run B → side-by-side summary (p95, errors, cost) and chart overlay.
- Result summary card after run: throughput, error %, p50/p95/p99, bottleneck node (clickable), cost/mo, thresholds ✅/❌ (from scenario script).
- Cancel within 200 ms; progress bar with virtual time.

## 8. Templates & onboarding

Gallery on empty state (each is a complete design with scenario, code, and a short lesson):
1. Simple 3-tier web app (ALB → app → Postgres).
2. Add a cache (read-heavy API).
3. Serverless API (API Gateway → Lambda/Functions → DynamoDB/Cosmos).
4. Event-driven order pipeline (API → queue → workers → DB, DLQ).
5. Multi-AZ HA with AZ outage chaos.
6. Retry storm and circuit breaker.
7. LLM chatbot with RAG and TPM throttling.
8. Networking puzzles (file 13 §9).
9. Multi-region latency and cost.
10. Same design on AWS vs GCP vs Azure vs OCI (cost comparison).

First-run guided tour (5 steps: drag service → connect → set latency → Run → open "Why?"). Skippable, replayable from Help.

## 9. Empty, loading and error states

- Empty canvas: template gallery + "Start from scratch".
- Run with no client/entry node: inline prompt "Add a Load Generator" with one-click add.
- Missing prices: grey `$?` chip with tooltip.
- Sandbox error: error card in Code tab; run can still proceed with manual cpu/latency.
- Worker crash: toast + "Restart simulator"; design never lost (autosave).
- Offline: editor works (IndexedDB); sync/price refresh show "offline".

## 10. Accessibility & i18n

- WCAG 2.2 AA contrast; focus rings; full keyboard operation of canvas (arrow keys move, Enter edit, `E` connect mode).
- Screen-reader summaries: "api: overloaded, 97% utilization, 12 errors per second".
- Color-blind safe palette; states differ by icon and pattern, not color only.
- `prefers-reduced-motion` honored (§4). Text scaling to 200%.
- i18n-ready strings (English first). Number/currency formatting via `Intl`.

## 11. Performance rules

- Canvas nodes memoized; per-frame updates applied through a store selector per node (no whole-graph re-render).
- Frame updates throttled to ≤ 10/s; particles drawn on a single overlay layer.
- Charts decimate points (LTTB) to ≤ 500 per series.
- Virtualize logs and trace lists.
- Lazy-load Monaco, sandbox WASM, Terraform package, and chart panels.

## 12. Visual design

- Neutral dark and light themes; provider color stripes (AWS orange, GCP blue, Azure cyan, OCI red — as subtle accents, not brand-exact); state colors independent of provider colors.
- Icons: use generic, own-drawn icons per kind (compute, db, cache, queue, storage, lb, gateway, ai, network) with a small provider badge. **Do not embed official cloud vendor logo/icon sets** unless their usage terms are reviewed and allow it (decision to log).
- Motion: 150–200 ms transitions; no motion when idle.

## 13. Acceptance criteria (UI)

1. A new user builds the 3-tier template, runs it, and sees a node go red and shake within 2 minutes using the provided spike scenario.
2. Editing p50/p95 on a service changes the next run's latency distribution (verified in Traces).
3. Reduced-motion mode shows no shaking; states still distinguishable without color.
4. Selecting an overloaded node shows a "Why?" explanation within 300 ms.
5. 200-node design stays ≥ 30 fps while animating.
6. All primary actions available from the keyboard/command palette.
