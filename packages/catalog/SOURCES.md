# Service Catalog Sources & Verification Log

> **Important:** All `p50`/`p95` latencies and default capacity sizing values in the catalog are **illustrative starting defaults** ("typical default — edit me"), not hardware benchmarks or SLAs. Users can override any parameter per node or operation in the Inspector.

Last updated: **2026-11-10** (Phase 2 baseline verification — see `docs/specs/18-TESTING-AND-ROADMAP.md` `T7.4` for full pre-release audit across all 243 services).

## Verified Cloud Provider Quotas & Limits

### AWS (`docs/specs/07-CATALOG-AWS.md`)

| Service                            | Verified Property              | Value / Rule                                                                                                                  | Source                                                                            | Verified On |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------- |
| `aws.lambda`                       | Default account concurrency    | 1,000 concurrent executions per region (soft limit); synchronous overflow returns HTTP 429 (`TooManyRequestsException`)       | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html           | 2026-11-10  |
| `aws.apigw_rest`, `aws.apigw_http` | Default account throttle       | 10,000 req/s steady-state with 5,000 burst (token bucket per region), 429 when exceeded                                       | https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html          | 2026-11-10  |
| `aws.s3`                           | Prefix request rate guidelines | 5,500 GET/HEAD per sec and 3,500 PUT/COPY/POST/DELETE per sec per partitioned prefix; exceeding returns HTTP 503 (`SlowDown`) | https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html | 2026-11-10  |
| `aws.*` public pricing             | Bulk Price List API            | `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json` + per-region JSON (`OnDemand` terms)                     | https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html   | 2026-11-10  |

### Google Cloud (`docs/specs/08-CATALOG-GCP.md`)

| Service                | Verified Property             | Value / Rule                                                                                                                            | Source                                                                                                                    | Verified On |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `gcp.cloud_run`        | Concurrency & request timeout | Console default concurrency 80/instance (max 1,000); default timeout 5 min, max 60 min (HTTP 504 on exceed)                             | https://cloud.google.com/run/docs/configuring/concurrency & https://cloud.google.com/run/docs/configuring/request-timeout | 2026-11-10  |
| `gcp.*` public pricing | Cloud Billing Catalog API     | `https://cloudbilling.googleapis.com/v1/services` and `.../skus` (`tieredRates[]` in `units` + `nanos`; requires `GCP_BILLING_API_KEY`) | https://cloud.google.com/billing/docs/reference/rest                                                                      | 2026-11-10  |

### Microsoft Azure (`docs/specs/09-CATALOG-AZURE.md`)

| Service                                   | Verified Property          | Value / Rule                                                                                            | Source                                                                                       | Verified On |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| `azure.cosmos_db`, `azure.cosmos_gremlin` | Logical partition ceilings | 20 GB storage per logical partition; 10,000 RU/s throughput per logical/physical partition              | https://learn.microsoft.com/en-us/azure/cosmos-db/partitioning-overview                      | 2026-11-10  |
| `azure.functions`                         | Consumption plan timeout   | Default 5 min, max 10 min (`functionTimeout`); HTTP triggers capped at 230 s by Azure Load Balancer     | https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale#timeout              | 2026-11-10  |
| `azure.*` public pricing                  | Retail Prices API          | `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview` (`NextPageLink` pagination) | https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices | 2026-11-10  |

### Oracle Cloud Infrastructure (`docs/specs/10-CATALOG-OCI.md`)

| Service                       | Verified Property              | Value / Rule                                                                                                        | Source                                                                              | Verified On |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| `oci.functions`               | Timeout & memory tiers         | Sync default 30 s, max 300 s (detached up to 60 min); memory tiers 128–3072 MB; regional `total-concurrency-mb` cap | https://docs.oracle.com/en-us/iaas/Content/Functions/Tasks/functionsconfiguring.htm | 2026-11-10  |
| OCI CDN (`equivalents: none`) | First-party general CDN status | OCI has no general-purpose first-party CDN (integrates with Akamai/Cloudflare or OCI Edge for Media Streams)        | https://docs.oracle.com/en-us/iaas/Content/MediaFlow/Concepts/mediastreams.htm      | 2026-11-10  |
| `oci.*` public pricing        | Cost Estimator API             | `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/` (unauthenticated JSON list prices)                  | https://www.oracle.com/cloud/costestimator.html                                     | 2026-11-10  |

## Remaining Catalog Quotas & Latencies

- Other service rows across files 07–10 currently retain illustrative baseline defaults from the specification tables and carry visible `"Typical default — edit me"` disclosures in the Palette hover card, Canvas node tooltips, Edge popover, and Inspector tabs pending full release verification in `T7.4`.
