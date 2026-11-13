# Contributing to the InfraSim Service Catalog

InfraSim provides a data-driven catalog of 243+ cloud services across Amazon Web Services (AWS), Google Cloud Platform (GCP), Microsoft Azure, and Oracle Cloud Infrastructure (OCI).

This guide explains how to add, update, or verify cloud services and pricing models in the catalog.

---

## 1. Directory Structure

- Catalog JSON source files:
  - `packages/catalog/data/aws.json`
  - `packages/catalog/data/gcp.json`
  - `packages/catalog/data/azure.json`
  - `packages/catalog/data/oci.json`
  - `packages/catalog/data/generic.json`
- Verification log:
  - `packages/catalog/SOURCES.md`
- Code generation script:
  - `scripts/build-catalog.ts`
- Generated TypeScript data:
  - `packages/catalog/src/generated/catalogData.ts`

---

## 2. Adding or Editing a Service

Every service row in `packages/catalog/data/<provider>.json` adheres to `ServiceDefinition` schema:

```json
{
  "id": "aws.lambda",
  "provider": "aws",
  "name": "AWS Lambda",
  "category": "Compute",
  "kind": "fn",
  "description": "AWS Lambda — Serverless function compute executing handlers per request.",
  "scope": "regional",
  "latency": {
    "distribution": "lognormal",
    "p50": 15,
    "p95": 45
  },
  "pricing": {
    "model": "requests",
    "currency": "USD",
    "unit": "requests",
    "ratePerUnit": 0.0000002
  },
  "tags": ["serverless", "faas", "compute"],
  "icon": "fn",
  "notes": "Typical default — edit me."
}
```

### Required Fields
- `id`: `<provider>.<service_slug>` (e.g. `aws.sqs`, `gcp.cloud_run`, `azure.cosmos_db`, `oci.functions`).
- `provider`: `"aws"` | `"gcp"` | `"azure"` | `"oci"` | `"generic"`.
- `name`: Human-readable service name.
- `category`: Palette grouping category (`"Compute"`, `"Databases & Caches"`, `"Networking & Delivery"`, `"Storage"`, `"Queues & Streaming"`, `"AI & ML"`, etc.).
- `kind`: Behavior simulator kind (`"compute"`, `"fn"`, `"db"`, `"cache"`, `"queue"`, `"stream"`, `"lb"`, `"gw"`, `"dns"`, `"storage"`, `"ai"`, `"net"`).
- `scope`: Geographic failure domain (`"regional"` | `"zonal"` | `"global"`).
- `latency`: Default latency distribution (`"lognormal"` | `"normal"` | `"fixed"`). Note: Latencies are illustrative starting defaults, not hardware guarantees.

---

## 3. Verification & Sourcing Rules

Whenever adding or adjusting a service's concurrency limits, timeout, partition ceilings, or pricing:
1. **Never guess quotas or leave unresolved verification notes.**
2. Look up the official cloud vendor documentation (AWS Developer Guide, GCP Docs, Microsoft Learn, or OCI Documentation).
3. If a property is dependent on user instance size or configuration, label it clearly (e.g., `"Scales with instance memory — typical default"`).
4. Record the verified URL, date, and quota in `packages/catalog/SOURCES.md`.

---

## 4. Building and Checking

Whenever modifying JSON files in `packages/catalog/data/`:

```bash
# 1. Compile JSON files into generated TypeScript constants
pnpm catalog:build

# 2. Verify schema compliance, unique IDs, and valid references
pnpm catalog:check

# 3. Run catalog unit tests
pnpm --filter @infrasim/catalog test
```

Both `pnpm catalog:check` and CI validate that `packages/catalog/src/generated/catalogData.ts` matches the underlying JSON data files.
