# 14 — Cost Engine & Pricing

Package: `packages/cost-engine` (pure TS formulas) + Laravel jobs for price sync. Produces **estimated monthly cost** per node and in total, by provider and region, from **public list prices** and the **usage counters** of a simulation run.

## 1. Rules (non-negotiable)

1. **Never invent prices.** Every unit price comes from a synced snapshot or an explicit user-entered manual price. Otherwise show "price unavailable" and exclude it from the total with a warning chip.
2. **On-demand list prices only in v1.** No reserved instances, savings plans, committed use, spot, negotiated discounts, support plans, or taxes. State this in the UI.
3. **Show assumptions** (hours per month, traffic scaling, free tier toggle, snapshot date) next to every total.
4. **Show snapshot age.** Warn if the snapshot is older than 7 days.
5. Price sync runs on the **backend**; the browser only reads normalized snapshots.

## 2. Public price sources (verify endpoints before implementing)

| Provider | Source | Notes |
|---|---|---|
| AWS | Price List **Bulk API** — `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json` → per-service, per-region JSON (`.../{serviceCode}/current/{region}/index.json`) | Public, no auth. Large files (EC2/RDS) → stream-parse. Terms: `OnDemand`. |
| Azure | **Retail Prices API** — `https://prices.azure.com/api/retail/prices?api-version=...&$filter=...` | Public, no auth; OData filter; paged (`NextPageLink`). Fields: `serviceName`, `armRegionName`, `armSkuName`, `meterName`, `unitOfMeasure`, `retailPrice`, `tierMinimumUnits`, `priceType`. |
| GCP | **Cloud Billing Catalog API** — `https://cloudbilling.googleapis.com/v1/services` and `.../services/{id}/skus` | Needs an API key (`GCP_BILLING_API_KEY`). Prices in `pricingInfo[].pricingExpression.tieredRates[]` (`units` + `nanos`). |
| OCI | Public **Cost Estimator products API** (`https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/`) | Verify the endpoint. OCI list prices are largely **region-independent** (verify). Compute is priced per OCPU-hour + per GB-memory-hour. |

If a source disappears or changes shape, the job MUST fail loudly (alert), keep the previous snapshot, and never write partial/garbage data. Record the source URL, fetch time, and a content hash in `price_snapshots`.

## 3. Price model codes (used in catalog tables)

| Code | Meaning | Usage counter used |
|---|---|---|
| `hr` | Per resource-hour (instance, node, cluster, DB instance) | `instanceSeconds` |
| `vcpu-gb-hr` | Per vCPU-hour + per GB-memory-hour (Fargate, Cloud Run, Container Apps, OCI flex) | `instanceSeconds × vcpu/memory` |
| `req` | Per request (price usually per million) | `requests` |
| `fn` | Per request + per GB-second (serverless functions) | `requests`, `gbSeconds` |
| `gb-mo` | Per GB-month storage (+ provisioned IOPS/throughput if priced) | `storageGb` (node config) |
| `gb-xfer` | Per GB transferred or processed | `bytesIn/bytesOut`, edge flags |
| `tok` | Per 1M input / output tokens | `tokensIn`, `tokensOut` |
| `unit` | Per generic unit (characters, images, pages, minutes, state transitions) | `requests` × units per call |
| `ru` | Cosmos-style request units (provisioned RU/s-hour or per million RU) | `readUnits`, `writeUnits` |
| `rcu-wcu` | Read/write capacity (provisioned per hour, or on-demand per million units) | `readUnits`, `writeUnits` |
| `shard-hr` | Stream shard/partition hours + payload units | shards × hours, `bytesIn` |
| `lcu` | Load balancer fixed hour + capacity units (LCU/NLCU) | hours, rps/bytes/connections |
| `msg` | Per million messages/events/operations | `requests` (× 64 KB chunks where applicable) |
| `query-tb` | Per TB scanned | `scannedBytes` (node config) |
| `acu-hr` | Per capacity-unit hour (Aurora Serverless ACU) | `acuSeconds` |
| `mau` | Per monthly active user (tiered) | `activeUsers` (scenario input) |
| `mix` | Multiple dimensions defined in `price_sku_map` (e.g. CloudFront = requests + GB; NAT = hours + GB processed; S3 = storage + requests + transfer) | several |
| `flat` | Fixed monthly price | — |
| `free` | No charge | — |

## 4. Normalized schema

See `prices`, `price_snapshots`, `price_sku_map` in file 04. A **`price_sku_map`** row maps `(service_id, provider, unit_role)` to a SKU filter so the engine can pick the right price:

```json
{ "service_id": "aws.ec2", "provider": "aws", "unit_role": "instance_hour",
  "filter": { "serviceCode": "AmazonEC2", "productFamily": "Compute Instance",
              "attributes": { "operatingSystem": "Linux", "tenancy": "Shared", "preInstalledSw": "NA", "capacitystatus": "Used" },
              "term": "OnDemand", "keyBy": "instanceType+regionCode" } }
```
```json
{ "service_id": "azure.vm", "provider": "azure", "unit_role": "instance_hour",
  "filter": { "odata": "serviceName eq 'Virtual Machines' and priceType eq 'Consumption'", "keyBy": "armSkuName+armRegionName", "exclude": ["Spot", "Low Priority", "Windows"] } }
```
- **GCP VMs are priced per vCPU and per GB RAM by machine family**, not per instance. Map `machineType → (vcpu, memGb, family)` and price = `vcpu × coreRate + memGb × ramRate`.
- **OCI compute** = `ocpu × ocpuRate + memGb × gbRate` (convert `vcpu → OCPU`: x86 ÷ 2, Arm ÷ 1).
- The agent MUST create a `price_sku_map` row for **every** catalog service with a non-`free` price code, discovered by exploring each source, and keep a coverage report (`docs/price-coverage.md`: service → mapped / missing). Missing = "price unavailable" in the UI.

### Instance specs (vCPU, memory)
- AWS: from price attributes (`vcpu`, `memory`).
- GCP / Azure / OCI: a **curated** `instance_specs.json` committed with source URLs and date (Azure's public retail API lacks vCPU/memory). Do not guess; unknown types prompt the user to enter vCPU/memory manually.
- These feed `NodeConfig.vcpu/memoryGb` and the compute model (file 05).

## 5. Region mapping (nearest equivalents; verify codes)

| Place | AWS | GCP | Azure | OCI |
|---|---|---|---|---|
| N. Virginia / US East | `us-east-1` | `us-east4` | `eastus` | `us-ashburn-1` |
| US West | `us-west-2` | `us-west1` | `westus2` | `us-phoenix-1` |
| Mumbai | `ap-south-1` | `asia-south1` | `centralindia`¹ | `ap-mumbai-1` |
| India (secondary) | `ap-south-2` (Hyderabad) | `asia-south2` (Delhi) | `southindia` (Chennai) | `ap-hyderabad-1` |
| Singapore | `ap-southeast-1` | `asia-southeast1` | `southeastasia` | `ap-singapore-1` |
| Tokyo | `ap-northeast-1` | `asia-northeast1` | `japaneast` | `ap-tokyo-1` |
| Sydney | `ap-southeast-2` | `australia-southeast1` | `australiaeast` | `ap-sydney-1` |
| Frankfurt | `eu-central-1` | `europe-west3` | `germanywestcentral` | `eu-frankfurt-1` |
| London | `eu-west-2` | `europe-west2` | `uksouth` | `uk-london-1` |
| São Paulo | `sa-east-1` | `southamerica-east1` | `brazilsouth` | `sa-saopaulo-1` |

¹ Azure has Central India (Pune), South India (Chennai), West India (Mumbai); service availability differs by region. Show availability warnings when a service has no price in the chosen region.

Regions affect **price** and **inter-region latency** (file 06 §7). The region selector lives on `region` groups (file 16).

## 6. Usage → cost computation

Inputs: `SimulationResult.counters`, `Design`, `PriceSnapshot`, `CostAssumptions`.

```ts
export interface CostAssumptions {
  hoursPerMonth: 730;                           // default
  traffic: { mode: 'run-average' | 'custom-monthly-requests' | 'custom-avg-rps'; value?: number };
  instanceCountMode: 'average' | 'peak';        // autoscaled nodes: time-weighted avg vs peak
  includeFreeTier: boolean;                     // needs verified free_tiers.json; default false
  currency: 'USD' | 'INR' | 'EUR' | 'GBP'; fxRateToUSD?: number;  // user-entered; no live FX
}
export interface CostLine { dimension: string; quantity: number; unit: string; unitPrice: number | null; amount: number | null;
  skuKey?: string; source: 'synced' | 'manual' | 'unavailable'; note?: string }
export interface CostReport { currency: string; asOf: string; monthlyTotal: number; perNode: Record<string, { lines: CostLine[]; subtotal: number }>;
  transfer: CostLine[]; byCategory: Record<string, number>; costPerMillionRequests: number; warnings: string[]; assumptions: CostAssumptions }
```

Steps:
1. **Scale usage to a month.** `scale = monthSeconds / runSeconds` for request-driven counters (using `traffic.mode`). For hour-based resources use `hoursPerMonth × instanceCount` (average or peak), not scaled run seconds.
2. **Per node lines** by price code (§3): compute hours, requests, GB-seconds, storage (`storageGb` from node config), tokens, units.
3. **Tiered pricing:** price data may have tiers (`tier_min`/`tier_max`); apply progressively (first N GB at rate 1, next at rate 2).
4. **Data transfer** from `counters.perEdge`: internet egress; inter-AZ; inter-region; via NAT (processing GB); via PrivateLink/endpoint; same-AZ free. Each category looks up its own SKU; if not found → "price unavailable".
5. **Round** to cents only at display; keep full precision internally.
6. **Totals & breakdown:** per node, per category (compute, database, network, storage, AI, other), per provider (multi-cloud designs).
7. **Warnings:** missing prices, stale snapshot, service not offered in region, scaled-run approximation, burstable-credit not modeled, free tier off/on, "run shorter than 60 s — extrapolation unreliable".

## 7. Features

- **Cost on canvas:** small `$X/mo` chip on each node; hover shows lines; total in the top bar with an info popover of assumptions.
- **Biggest drivers:** top 3 cost lines with percent of total (feeds insights, file 17).
- **Compare providers:** map design to another provider using `equivalents` (file 06 §8), run cost only (no re-simulation), show side-by-side table with "approximate mapping" label and a behavior-difference list.
- **Compare regions:** same design in N regions (only price + inter-region latency effects).
- **Cost vs latency sweep:** vary one parameter (instances, instance type, cache hit ratio) over up to 12 values; run sim for each (scaled mode if needed), plot cost vs p95 and mark the knee. Cancellable; uses a worker pool.
- **What-if sliders:** change RPS, instance count; re-estimate instantly using the last run's per-request cost (cheap) — mark "estimate until re-run".
- **Currency display:** USD default; optional INR/EUR/GBP using the user's manual FX rate; always show the original USD figure on hover.
- **Export:** CSV of cost lines and a Markdown summary.

## 8. Price sync job (`prices:sync`)

- Nightly, per provider, idempotent (skip if `raw_hash` unchanged).
- Steps: fetch → validate against provider schema → normalize → map to `service_id`/`sku_key` using `price_sku_map` → upsert into a new snapshot → compare with previous → publish snapshot (atomic flag swap).
- **Alert** (log + email to admin) if > 20% of SKUs change by > 30%, if any mapped SKU disappears, or if coverage drops.
- Backoff and rate limiting; resumable for paged APIs; max runtime guard.
- `GET /api/prices/snapshot` serves a compact JSON subset (only what the client needs for the selected providers/regions) with ETag; cache in Redis.
- **Seed snapshot:** `scripts/seed-prices.ts` writes `packages/cost-engine/seed/prices.seed.json` from a real sync for offline dev. It is generated, not hand-written, and gitignored unless a release requires it.

## 9. Tests

1. **Formula tests** use **synthetic test prices defined inside test files**, clearly named `TEST_ONLY_PRICES`, never shipped.
2. Tiered pricing across tier boundaries.
3. Missing price → `unavailable` line, excluded from total, warning present.
4. `vcpu-gb-hr` conversion (OCI OCPU ÷ vCPU; GCP per-core + per-RAM).
5. Scaling: 60 s run at 100 RPS projects to the expected monthly request count.
6. Average vs peak instance count with autoscaling.
7. Cross-AZ / NAT / internet transfer categories pick distinct SKUs.
8. Sync idempotency (same hash → no new snapshot), partial-failure rollback, alert thresholds.
9. Snapshot staleness warning at > 7 days.
10. Coverage report fails CI if a catalog service with a non-free price code has no mapping **and** is not listed as `known-unavailable` with a reason.
