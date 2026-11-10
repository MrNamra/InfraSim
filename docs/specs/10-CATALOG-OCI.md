# 10 — Catalog: Oracle Cloud Infrastructure (OCI)

> Illustrative defaults, **not benchmarks**. Every number is user-editable. Verify quotas against current OCI docs before shipping (record in `packages/catalog/SOURCES.md`). Column meanings are identical to file 07.
>
> **CPU unit note:** OCI prices compute per **OCPU** (1 OCPU = 1 physical core = 2 vCPU on x86; on Arm Ampere 1 OCPU = 1 vCPU). The simulator stores `vcpu`; the cost engine converts.
>
> **No first-party CDN row:** as far as we know OCI has no first-party CDN (verify). Users can add a **custom** CDN service (file 06 §6) or use a partner CDN placeholder.

### Compute
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.compute | Compute instance (runs your code) | 20 | 80 | slots | compute | vcpu-gb-hr |
| oci.functions | OCI Functions | 20 | 80 | elastic | fn | fn |
| oci.container_instances | Container Instances | 20 | 80 | slots | compute | vcpu-gb-hr |
| oci.oke | OKE (Kubernetes) pod | 20 | 80 | slots | compute | hr |
| oci.batch | OCI Batch job | 30000 | 120000 | slots | async | hr |

### Networking & Delivery
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.dns | OCI DNS | 15 | 40 | elastic | dns | req |
| oci.load_balancer | Load Balancer (L7, flexible shape) | 2 | 8 | elastic | lb | mix |
| oci.network_lb | Network Load Balancer (L4) | 1 | 3 | elastic | lb | free |
| oci.api_gateway | API Gateway | 10 | 35 | elastic | gw | req |
| oci.waf | Web Application Firewall | 1 | 4 | elastic | net | req |
| oci.network_firewall | Network Firewall | 1 | 5 | pass | net | mix |
| oci.internet_gw | Internet Gateway | 0 | 0 | pass | net | free |
| oci.nat_gw | NAT Gateway | 1 | 3 | pass | net | free |
| oci.service_gw | Service Gateway | 0.5 | 2 | pass | net | free |
| oci.drg | Dynamic Routing Gateway (DRG) | 1 | 3 | pass | net | free |
| oci.vcn_peering | VCN Peering (via DRG / LPG) | 0.5 | 2 | pass | net | gb-xfer |
| oci.fastconnect | FastConnect | 5 | 15 | pass | net | mix |
| oci.site_vpn | Site-to-Site VPN | 10 | 30 | pass | net | free |

### Storage
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.object_storage | Object Storage (GET, first byte) | 30 | 110 | elastic | object | mix |
| oci.archive_storage | Archive Storage (restore) | 3600000 | 5400000 | elastic | async | mix |
| oci.block_volume | Block Volume | 1 | 4 | units | block | gb-mo |
| oci.file_storage | File Storage | 3 | 12 | units | file | gb-mo |

### Databases & Caches
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.autonomous_atp | Autonomous Transaction Processing | 4 | 20 | conn | sql | hr |
| oci.autonomous_adw | Autonomous Data Warehouse | 400 | 3000 | conn | olap | hr |
| oci.base_db | Base Database Service | 4 | 20 | conn | sql | hr |
| oci.mysql_heatwave | MySQL HeatWave | 3 | 15 | conn | sql | hr |
| oci.postgres | OCI Database with PostgreSQL | 3 | 15 | conn | sql | hr |
| oci.nosql | NoSQL Database | 5 | 20 | units | kv | rcu-wcu |
| oci.cache_redis | OCI Cache (Redis) | 0.5 | 2 | slots | cache | hr |
| oci.opensearch | OpenSearch | 15 | 80 | slots | search | hr |

### Messaging & Integration
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.queue | Queue | 10 | 35 | elastic | queue | msg |
| oci.notifications | Notifications | 20 | 70 | elastic | topic | msg |
| oci.streaming | Streaming (Kafka-compatible) | 15 | 60 | units | stream | mix |
| oci.events | Events | 40 | 150 | elastic | bus | free |
| oci.connector_hub | Service Connector Hub | 60 | 250 | elastic | bus | free |
| oci.integration | Oracle Integration | 150 | 600 | elastic | workflow | hr |

### Security & Identity
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.vault_secrets | Vault (secrets) | 20 | 60 | elastic | secret | mix |
| oci.vault_keys | Vault (key management) | 10 | 30 | elastic | kms | req |
| oci.identity_domains | IAM Identity Domains (login) | 80 | 300 | elastic | auth | mau |
| oci.instance_principal | Instance / Resource Principal (token) | 5 | 20 | elastic | auth | free |

### AI & ML (mocked — see file 11)
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.genai | OCI Generative AI (chat, full response) | 3000 | 12000 | tpm | llm | tok |
| oci.genai_embed | OCI Generative AI (embeddings) | 150 | 500 | tpm | llm | tok |
| oci.datascience_deployment | Data Science model deployment | 50 | 300 | slots | ml | hr |
| oci.language | OCI Language | 100 | 300 | elastic | text-ai | unit |
| oci.vision | OCI Vision | 300 | 900 | elastic | vision | unit |
| oci.speech | OCI Speech (batch) | 60000 | 240000 | elastic | speech | unit |
| oci.document_understanding | OCI Document Understanding | 1500 | 5000 | elastic | doc-ai | unit |
| oci.digital_assistant | Digital Assistant | 150 | 500 | elastic | bot | req |

### Observability
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| oci.logging | Logging (ingest) | 20 | 80 | elastic | queue | gb-xfer |
| oci.monitoring | Monitoring (metrics ingest) | 15 | 60 | elastic | queue | req |

## Serverless & scaling extras

| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |
|---|---|---|---|---|---|---|
| oci.functions | 600 | 2500 | scales automatically; account/tenancy limits apply (verify) | ≈ 5 min (verify) | 3 | Container-based; memory selectable (verify range). |
| oci.compute | — | — | per instance | — | 90 | Instance pools + autoscaling configs. |
| oci.container_instances | — | — | per instance | — | 30 | Starts a container group; no cluster to manage. |
| oci.oke | — | — | per pod | — | 40 | Pod + node pool autoscaling. |
| oci.autonomous_atp | — | — | per service level | — | 10 | Optional auto scaling of CPU (verify multiple). |

## Quotas to model (verify current values)

- **Load Balancer**: flexible shape has min/max bandwidth (Mbps to multi-Gbps, verify); traffic above max is dropped/queued — a clean "bandwidth saturation" lesson.
- **Autonomous Database**: connection **service levels** (e.g. `TP`, `TPURGENT`, `HIGH`, `MEDIUM`, `LOW`) cap concurrency per service level; wrong service name = surprising queuing. Model as `conn` per service level.
- **Streaming**: per-partition write/read throughput limits (≈ 1 MB/s write per partition; verify); more partitions = more throughput.
- **Queue / Notifications**: per-region rate limits; 429 `TooManyRequests` style throttling.
- **Object Storage**: request throttling returns 429; no publicly documented per-prefix limit like S3's (verify).
- **OCI Generative AI**: on-demand shared capacity with rate limits vs **dedicated AI clusters** (reserved units, hourly billing) — model both (file 11).
- **Service limits (tenancy quotas)**: OCI enforces per-tenancy/compartment limits and quotas per region; show a generic "limit reached" error for provisioning.

## OCI-specific teaching notes

- **Compartments** organize resources and IAM policies; network objects live in compartments. Visualize as a group kind `compartment`.
- Regions have 1 or 3 **Availability Domains (ADs)**; each AD has 3 **Fault Domains**. Prefer **regional subnets** (span ADs).
- **Security Lists** (subnet-level) and **Network Security Groups** (VNIC-level) both apply; rules are **stateful by default** (stateless option exists). Both are allow-only; traffic must be allowed by at least one list/NSG rule.
- **Route tables** are attached per subnet. A subnet is "public" only if it allows public IPs **and** routes to an Internet Gateway.
- **Service Gateway** lets private subnets reach Oracle Services (e.g. Object Storage) without internet; forgetting its route rule is a classic bug.
- Peering across VCNs/regions goes through the **DRG**; routes must be added on both sides.
