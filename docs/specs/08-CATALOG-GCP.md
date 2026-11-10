# 08 — Catalog: Google Cloud (GCP)

> Illustrative defaults, **not benchmarks**. Every number is user-editable. Verify quotas against current GCP docs before shipping (record in `packages/catalog/SOURCES.md`). Column meanings are identical to file 07.

### Compute
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.compute_engine | Compute Engine VM (runs your code) | 20 | 80 | slots | compute | hr |
| gcp.cloud_run | Cloud Run | 20 | 80 | conc=8000/queue | fn | vcpu-gb-hr |
| gcp.cloud_functions | Cloud Functions (2nd gen) | 15 | 60 | conc=1000/queue | fn | fn |
| gcp.gke | GKE pod | 20 | 80 | slots | compute | hr |
| gcp.app_engine | App Engine | 20 | 80 | slots | compute | hr |
| gcp.batch | Cloud Batch job | 30000 | 120000 | slots | async | hr |

### Networking & Delivery
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.cloud_dns | Cloud DNS | 15 | 40 | elastic | dns | req |
| gcp.cloud_cdn | Cloud CDN (cache hit) | 10 | 30 | elastic | cdn | mix |
| gcp.lb_https | External Application Load Balancer | 2 | 8 | elastic | lb | lcu |
| gcp.lb_network | Network Load Balancer | 1 | 3 | elastic | lb | lcu |
| gcp.lb_internal | Internal Load Balancer | 1 | 4 | elastic | lb | lcu |
| gcp.api_gateway | API Gateway | 12 | 40 | elastic | gw | req |
| gcp.apigee | Apigee | 15 | 60 | elastic | gw | mix |
| gcp.cloud_armor | Cloud Armor (WAF) | 1 | 4 | elastic | net | req |
| gcp.cloud_nat | Cloud NAT | 1 | 3 | pass | net | mix |
| gcp.vpc_peering | VPC Network Peering | 0.5 | 2 | pass | net | gb-xfer |
| gcp.psc | Private Service Connect | 1 | 3 | pass | net | mix |
| gcp.vpn | Cloud VPN | 10 | 30 | pass | net | mix |
| gcp.interconnect | Cloud Interconnect | 5 | 15 | pass | net | mix |

### Storage
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.cloud_storage | Cloud Storage (GET, first byte) | 30 | 100 | elastic | object | mix |
| gcp.cloud_storage_archive | Cloud Storage Archive | 50 | 200 | elastic | object | mix |
| gcp.persistent_disk | Persistent Disk | 1 | 4 | units | block | gb-mo |
| gcp.filestore | Filestore | 3 | 10 | units | file | gb-mo |

### Databases & Caches
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.cloud_sql_postgres | Cloud SQL for PostgreSQL | 3 | 15 | conn | sql | hr |
| gcp.cloud_sql_mysql | Cloud SQL for MySQL | 3 | 15 | conn | sql | hr |
| gcp.alloydb | AlloyDB for PostgreSQL | 3 | 12 | conn | sql | hr |
| gcp.spanner | Spanner (single-region) | 6 | 20 | units | sql | hr |
| gcp.firestore | Firestore | 10 | 40 | units | doc | mix |
| gcp.bigtable | Bigtable | 6 | 15 | units | kv | hr |
| gcp.memorystore_redis | Memorystore for Redis | 0.5 | 2 | slots | cache | hr |
| gcp.memorystore_memcached | Memorystore for Memcached | 0.5 | 2 | slots | cache | hr |
| gcp.bigquery | BigQuery | 1500 | 8000 | elastic | olap | query-tb |

### Messaging & Integration
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.pubsub | Pub/Sub (publish) | 20 | 70 | elastic | topic | gb-xfer |
| gcp.cloud_tasks | Cloud Tasks | 25 | 90 | elastic | queue | msg |
| gcp.eventarc | Eventarc | 40 | 150 | elastic | bus | msg |
| gcp.workflows | Workflows | 50 | 200 | elastic | workflow | unit |
| gcp.managed_kafka | Managed Service for Apache Kafka | 5 | 20 | slots | stream | hr |

### Security & Identity
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.secret_manager | Secret Manager | 20 | 60 | elastic | secret | mix |
| gcp.kms | Cloud KMS | 10 | 30 | elastic | kms | req |
| gcp.identity_platform | Identity Platform | 80 | 300 | elastic | auth | mau |
| gcp.firebase_auth | Firebase Authentication | 80 | 300 | elastic | auth | mau |

### AI & ML (mocked — see file 11)
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.vertex_gemini | Vertex AI — Gemini (full response) | 3000 | 12000 | tpm | llm | tok |
| gcp.vertex_endpoint | Vertex AI online prediction endpoint | 50 | 300 | slots | ml | hr |
| gcp.vertex_search | Vertex AI Search | 300 | 1000 | elastic | search | req |
| gcp.vision | Cloud Vision API | 300 | 900 | elastic | vision | unit |
| gcp.speech_to_text | Speech-to-Text (sync) | 500 | 2000 | elastic | speech | unit |
| gcp.text_to_speech | Text-to-Speech | 150 | 400 | elastic | speech | unit |
| gcp.translation | Cloud Translation | 100 | 300 | elastic | text-ai | unit |
| gcp.natural_language | Natural Language API | 100 | 300 | elastic | text-ai | unit |
| gcp.document_ai | Document AI | 1500 | 5000 | elastic | doc-ai | unit |
| gcp.dialogflow | Dialogflow | 150 | 500 | elastic | bot | req |
| gcp.video_intelligence | Video Intelligence | 60000 | 240000 | elastic | async | unit |

### Observability
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| gcp.cloud_logging | Cloud Logging (ingest) | 20 | 80 | elastic | queue | gb-xfer |

## Serverless & scaling extras

| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |
|---|---|---|---|---|---|---|
| gcp.cloud_run | 300 | 1200 | 80 / instance (max 1000); max instances default ≈ 100 (verify) | 60 min | 2 | `onLimit = queue` then 429/503. Billing depends on CPU allocation mode (always vs during request). |
| gcp.cloud_functions | 300 | 1200 | per-instance concurrency configurable (2nd gen) | 60 min (HTTP) | 2 | 2nd gen runs on Cloud Run. |
| gcp.compute_engine | — | — | per VM | — | 60 | Managed instance group autoscaler. |
| gcp.gke | — | — | per pod | — | 40 | Pod scheduling + image pull; node autoscaling adds more. |
| gcp.app_engine | 800 | 3000 | per instance | 10 min (standard) | 10 | Standard env scales to zero. |
| gcp.spanner | — | — | processing units | — | 5 | Scale by adding processing units (1 node = 1,000 PUs). |

## Quotas to model (verify current values)

- **Cloud Run**: request timeout default 5 min (max 60 min); per-instance concurrency default 80; instances scale to max-instances.
- **Pub/Sub**: ack deadline default ≈ 10 s; ordering keys serialize delivery per key; subscriber lag is the key metric.
- **Spanner**: recommended max CPU ≈ 65% for single-region instances (≈ 45% multi-region) — over that, latency climbs. Use as the `hot` threshold for this node.
- **Bigtable**: ≈ 10,000 simple reads/writes per second per SSD node (rule of thumb); hot row keys defeat scaling.
- **Firestore**: "500/50/5" ramp rule for new workloads (start ≈ 500 ops/s, increase ≈ 50% every 5 min); hotspotting on sequential keys.
- **Cloud SQL / AlloyDB**: `max_connections` depends on memory tier (verify per engine).
- **Cloud NAT**: minimum ports per VM (default ≈ 64); each port supports connections to one unique destination tuple → port exhaustion (v2 model).
- **BigQuery**: on-demand slot cap per project (verify); interactive queries typically seconds, not ms.
- **Vertex AI / Gemini**: per-model, per-region RPM/TPM quotas; dynamic shared quota vs provisioned throughput (file 11).

## GCP-specific teaching notes

- **VPC is global; subnets are regional** (unlike AWS VPC which is regional). Model groups accordingly (file 13).
- Firewall rules are **stateful** with priorities and allow/deny; targets are **network tags / service accounts**. Default: deny ingress, allow egress (implied rules).
- VMs without external IP need **Cloud NAT** for outbound internet, or **Private Google Access** to reach Google APIs.
- Cloud Run reaching private resources (Cloud SQL private IP, Memorystore) needs **Direct VPC egress** or a Serverless VPC Access connector.
- Global external Application LB uses anycast; no pre-warming; cross-region backends add latency.
