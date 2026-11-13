# Service Catalog Sources & Verification Log

> **Important:** All `p50`/`p95` latencies and default capacity sizing values in the catalog are **illustrative starting defaults** ("typical default — edit me"), not hardware benchmarks or SLAs. Users can override any parameter per node or operation in the Inspector.

Last updated: **2026-11-13** (Full pre-release verification audit across all 243 services per `T7.4`).

---

## Verified Cloud Provider Quotas, Sizing Rules & Official Documentation

### 1. Amazon Web Services (AWS) — `docs/specs/07-CATALOG-AWS.md`

| Service                             | Parameter / Quota            | Verified Value / Rule                                                                                                                   | Official Documentation Source                                                                                             | Verified On |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `aws.lambda`                        | Regional Concurrency         | 1,000 concurrent executions per region (default soft limit); synchronous bursts trigger HTTP 429 (`TooManyRequestsException`).          | [AWS Lambda Limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)                              | 2026-11-13  |
| `aws.lambda`                        | Invocation Timeout & Payload | Maximum 900 s (15 min); synchronous payload limit 6 MB, async 256 KB.                                                                   | [AWS Lambda Quotas](https://docs.aws.amazon.com/general/latest/gr/lambda-service.html)                                    | 2026-11-13  |
| `aws.apigw_rest`, `aws.apigw_http`  | Throttling & Burst           | 10,000 req/s steady-state token bucket with 5,000 burst capacity per account/region; integration timeout max 29 s default.              | [API Gateway Quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)                            | 2026-11-13  |
| `aws.s3`                            | Prefix Request Guidelines    | 5,500 GET/HEAD req/s and 3,500 PUT/POST/DELETE req/s per partitioned prefix. Exceeding triggers HTTP 503 (`SlowDown`).                  | [S3 Optimizing Performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)            | 2026-11-13  |
| `aws.dynamodb`                      | Partition Limits & Item Size | 3,000 RCU (4 KB reads) and 1,000 WCU (1 KB writes) per physical partition; max item size 400 KB; hot partition saturation triggers 429. | [DynamoDB Service Quotas](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html)            | 2026-11-13  |
| `aws.sqs`                           | Standard vs FIFO Throughput  | Standard: nearly unlimited API actions; FIFO: 300 msg/s standard, up to 3,000 msg/s with high-throughput batching; max msg size 256 KB. | [Amazon SQS Quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-quotas.html)           | 2026-11-13  |
| `aws.kinesis`                       | Data Shard Throughput        | 1 MB/s or 1,000 records/s ingress per shard; 2 MB/s egress per shard.                                                                   | [Kinesis Data Streams Quotas](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)               | 2026-11-13  |
| `aws.rds_postgres`, `aws.rds_mysql` | Default `max_connections`    | Parameter formula derived from RAM: PostgreSQL `LEAST(DBInstanceClassMemory/9531392, 5000)`; MySQL `DBInstanceClassMemory/12582880`.    | [RDS DB Parameter Groups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithParamGroups.html)        | 2026-11-13  |
| `aws.nat_gw`                        | Throughput & Connections     | Autoscales to 100 Gbps; up to 55,000 simultaneous connections per destination IP/port before SNAT exhaustion.                           | [AWS NAT Gateway Limits](https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html#vpc-limits-nat-gateways) | 2026-11-13  |
| `aws.bedrock`                       | Foundation Model Quotas      | Dynamic per-model RPM / TPM token bucket quotas per account/region; returns HTTP 429 (`ThrottlingException`).                           | [Amazon Bedrock Quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)                                 | 2026-11-13  |
| `aws.*` public pricing              | Price List Bulk Index        | `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json` (`OnDemand` terms, per-region endpoints).                          | [AWS Price List API Guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)               | 2026-11-13  |

---

### 2. Google Cloud Platform (GCP) — `docs/specs/08-CATALOG-GCP.md`

| Service                                         | Parameter / Quota         | Verified Value / Rule                                                                                           | Official Documentation Source                                                              | Verified On |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `gcp.cloud_run`                                 | Concurrency & Timeout     | Concurrency default 80 (up to 1,000 per instance); default timeout 5 min, max 60 min (HTTP 504 on timeout).     | [Cloud Run Concurrency](https://cloud.google.com/run/docs/configuring/concurrency)         | 2026-11-13  |
| `gcp.cloud_run`                                 | Maximum Instances         | Default maximum 100 instances per region (configurable via quota request up to 1,000+).                         | [Cloud Run Resource Limits](https://cloud.google.com/run/docs/about-instance-autoscaling)  | 2026-11-13  |
| `gcp.pubsub`                                    | Throughput & Message Size | 10 MB maximum payload per message; 100 MB/s publisher throughput per region default quota.                      | [Cloud Pub/Sub Quotas](https://cloud.google.com/pubsub/quotas)                             | 2026-11-13  |
| `gcp.cloud_sql_postgres`, `gcp.cloud_sql_mysql` | Maximum Connections       | Scales with RAM: 100 for 1–4 vCPU small instances, up to 4,000 for high-memory configurations.                  | [Cloud SQL Quotas](https://cloud.google.com/sql/docs/quotas)                               | 2026-11-13  |
| `gcp.bigquery`                                  | On-demand Slot Quota      | 2,000 dynamic slots default on-demand per project; queries scale elastically across slot pool.                  | [BigQuery Quotas & Limits](https://cloud.google.com/bigquery/docs/quotas)                  | 2026-11-13  |
| `gcp.spanner`                                   | Utilization Headroom      | Target recommended maximum CPU ≤ 65% for single-region and ≤ 45% for multi-region to avoid tail latency spikes. | [Spanner CPU Utilization](https://cloud.google.com/spanner/docs/cpu-utilization)           | 2026-11-13  |
| `gcp.cloud_nat`                                 | Port Allocation           | Default 64 ports per VM instance; each port maps to 1 unique destination IP:port tuple.                         | [Cloud NAT Overview](https://cloud.google.com/nat/docs/overview)                           | 2026-11-13  |
| `gcp.*` public pricing                          | Cloud Billing Catalog API | `https://cloudbilling.googleapis.com/v1/services` and `.../skus` (`tieredRates` in `units` + `nanos`).          | [Google Cloud Billing API Reference](https://cloud.google.com/billing/docs/reference/rest) | 2026-11-13  |

---

### 3. Microsoft Azure — `docs/specs/09-CATALOG-AZURE.md`

| Service                  | Parameter / Quota         | Verified Value / Rule                                                                                                            | Official Documentation Source                                                                                           | Verified On |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| `azure.cosmos_db`        | Partition & RU Limits     | 20 GB storage and 10,000 RU/s limit per physical partition; exceeding throughput returns HTTP 429 with retry delay.              | [Azure Cosmos DB Partitioning](https://learn.microsoft.com/en-us/azure/cosmos-db/partitioning-overview)                 | 2026-11-13  |
| `azure.functions`        | Execution Timeout         | Consumption plan default 5 min, max 10 min; HTTP triggers capped at 230 s by Azure Load Balancer. Flex Consumption up to 30 min. | [Azure Functions Scale & Hosting](https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale)              | 2026-11-13  |
| `azure.app_service`      | Frontend Idle Timeout     | 230 seconds frontend load balancer request timeout; long-running jobs require WebJobs or async queues.                           | [App Service Architecture](https://learn.microsoft.com/en-us/azure/app-service/overview)                                | 2026-11-13  |
| `azure.service_bus`      | Tier Throughput & Payload | Standard tier payload ≤ 256 KB; Premium tier payload up to 100 MB with dedicated Messaging Units (MU).                           | [Service Bus Quotas](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-quotas)                  | 2026-11-13  |
| `azure.event_hubs`       | Throughput Units (TU)     | 1 MB/s (or 1,000 events/s) ingress and 2 MB/s egress per provisioned Throughput Unit.                                            | [Event Hubs Quotas](https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-quotas)                               | 2026-11-13  |
| `azure.key_vault`        | Operation Limits          | 2,000 GET secret transactions per 10 s window per vault; excess requests receive HTTP 429.                                       | [Key Vault Service Limits](https://learn.microsoft.com/en-us/azure/key-vault/general/service-limits)                    | 2026-11-13  |
| `azure.nat_gateway`      | SNAT Port Capacity        | 64,512 SNAT ports per assigned public IP address; up to 16 public IPs per gateway resource.                                      | [Virtual Network NAT Gateway](https://learn.microsoft.com/en-us/azure/virtual-network/nat-gateway/nat-gateway-resource) | 2026-11-13  |
| `azure.*` public pricing | Azure Retail Prices API   | `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview` (open unauthenticated REST API).                     | [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) | 2026-11-13  |

---

### 4. Oracle Cloud Infrastructure (OCI) — `docs/specs/10-CATALOG-OCI.md`

| Service                | Parameter / Quota           | Verified Value / Rule                                                                                                         | Official Documentation Source                                                                                                        | Verified On |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `oci.functions`        | Memory & Timeout Tiers      | Memory selectable from 128 MB to 2048 MB in 1 MB increments (up to 10240 MB on Gen 2 shapes); max sync timeout 300 s (5 min). | [OCI Functions Configuration](https://docs.oracle.com/en-us/iaas/Content/Functions/Tasks/functionsconfiguring.htm)                   | 2026-11-13  |
| `oci.load_balancer`    | Flexible Bandwidth Shape    | Minimum 10 Mbps to maximum 8,000 Mbps (8 Gbps); traffic exceeding max bandwidth is throttled/dropped.                         | [OCI Load Balancer Shapes](https://docs.oracle.com/en-us/iaas/Content/Balance/Concepts/balanceoverview.htm)                          | 2026-11-13  |
| `oci.streaming`        | Partition Bandwidth         | 1 MB/s write (up to 1,000 msgs/s) and 2 MB/s read per partition; scaling requires adding partitions.                          | [OCI Streaming Limits](https://docs.oracle.com/en-us/iaas/Content/Streaming/Concepts/streamingoverview.htm)                          | 2026-11-13  |
| `oci.autonomous_atp`   | CPU Auto Scaling            | Automatically expands compute capacity up to 3x base provisioned CPU/ECPU allocation based on real-time load.                 | [Autonomous Database Auto Scaling](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-auto-scale.html) | 2026-11-13  |
| `oci.object_storage`   | Tenancy Request Quotas      | Unmetered standard requests with HTTP 429 throttling under severe account concurrency bursts; no per-prefix rate limits.      | [OCI Object Storage Limits](https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/objectstorageoverview.htm)                    | 2026-11-13  |
| `oci.cdn`              | First-party Delivery Status | OCI does not offer a standalone general-purpose first-party CDN; integrates with partner CDNs or OCI Media Streams.           | [OCI Media Streams Delivery](https://docs.oracle.com/en-us/iaas/Content/MediaFlow/Concepts/mediastreams.htm)                         | 2026-11-13  |
| `oci.*` public pricing | Cost Estimator API          | `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/` (open public list price catalog).                             | [Oracle Cost Estimator](https://www.oracle.com/cloud/costestimator.html)                                                             | 2026-11-13  |

---

## Audit Verification Invariant

1. **Zero Unverified Markers:** Every quota, limit, and sizing parameter in the 243 catalog services has either been verified against the official cloud documentation above or explicitly designated as `"approximate — edit me"` for user configuration.
2. **Deterministic Defaults:** All catalog items continue to pass `pnpm catalog:check`, schema validation, and simulation determinism suites.
