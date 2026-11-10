# 09 — Catalog: Microsoft Azure

> Illustrative defaults, **not benchmarks**. Every number is user-editable. Verify quotas against current Azure docs before shipping (record in `packages/catalog/SOURCES.md`). Column meanings are identical to file 07.

### Compute
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.vm | Virtual Machine (runs your code) | 20 | 80 | slots | compute | hr |
| azure.app_service | App Service | 20 | 80 | slots | compute | hr |
| azure.functions | Azure Functions (Consumption) | 15 | 60 | conc=200 | fn | fn |
| azure.functions_flex | Azure Functions (Flex Consumption) | 15 | 60 | conc=1000/queue | fn | fn |
| azure.container_apps | Container Apps | 20 | 80 | conc=1000/queue | fn | vcpu-gb-hr |
| azure.container_instances | Container Instances | 20 | 80 | slots | compute | vcpu-gb-hr |
| azure.aks | AKS pod | 20 | 80 | slots | compute | hr |
| azure.batch | Azure Batch job | 30000 | 120000 | slots | async | hr |

### Networking & Delivery
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.dns | Azure DNS | 15 | 40 | elastic | dns | req |
| azure.traffic_manager | Traffic Manager (DNS routing) | 15 | 40 | elastic | dns | req |
| azure.front_door | Front Door (CDN + global LB) | 5 | 20 | elastic | cdn | mix |
| azure.cdn | Azure CDN (cache hit) | 10 | 30 | elastic | cdn | mix |
| azure.app_gateway | Application Gateway | 3 | 12 | elastic | lb | lcu |
| azure.load_balancer | Load Balancer (L4) | 1 | 3 | elastic | lb | lcu |
| azure.apim | API Management | 10 | 40 | elastic | gw | mix |
| azure.waf | Web Application Firewall | 1 | 4 | elastic | net | req |
| azure.firewall | Azure Firewall | 1 | 5 | pass | net | mix |
| azure.nat_gateway | NAT Gateway | 1 | 3 | pass | net | mix |
| azure.vnet_peering | VNet Peering | 0.5 | 2 | pass | net | gb-xfer |
| azure.private_link | Private Link / Private Endpoint | 1 | 3 | pass | net | mix |
| azure.vpn_gateway | VPN Gateway | 10 | 30 | pass | net | mix |
| azure.expressroute | ExpressRoute | 5 | 15 | pass | net | mix |

### Storage
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.blob | Blob Storage (GET, first byte) | 25 | 90 | elastic | object | mix |
| azure.blob_archive | Blob Archive (rehydrate) | 36000000 | 54000000 | elastic | async | mix |
| azure.managed_disk | Managed Disk | 1 | 4 | units | block | gb-mo |
| azure.files | Azure Files | 3 | 12 | units | file | gb-mo |
| azure.netapp_files | Azure NetApp Files | 1 | 4 | units | file | gb-mo |

### Databases & Caches
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.sql_db | Azure SQL Database | 3 | 15 | conn | sql | hr |
| azure.sql_managed_instance | SQL Managed Instance | 3 | 15 | conn | sql | hr |
| azure.postgres_flexible | PostgreSQL Flexible Server | 3 | 15 | conn | sql | hr |
| azure.mysql_flexible | MySQL Flexible Server | 3 | 15 | conn | sql | hr |
| azure.cosmos_db | Cosmos DB (point read) | 5 | 15 | units | doc | ru |
| azure.cosmos_postgres | Cosmos DB for PostgreSQL | 4 | 20 | conn | sql | hr |
| azure.table_storage | Table Storage | 10 | 40 | elastic | kv | req |
| azure.redis_cache | Azure Cache for Redis | 0.5 | 2 | slots | cache | hr |
| azure.synapse | Synapse Analytics | 2000 | 10000 | elastic | olap | mix |
| azure.data_explorer | Data Explorer (Kusto) | 150 | 800 | slots | olap | hr |
| azure.cosmos_gremlin | Cosmos DB (Gremlin graph) | 10 | 50 | units | graph | ru |

### Messaging & Integration
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.service_bus | Service Bus | 15 | 50 | units | queue | msg |
| azure.storage_queue | Storage Queues | 10 | 30 | elastic | queue | msg |
| azure.event_hubs | Event Hubs | 10 | 40 | units | stream | mix |
| azure.event_grid | Event Grid | 30 | 100 | elastic | bus | msg |
| azure.logic_apps | Logic Apps | 100 | 400 | elastic | workflow | unit |
| azure.durable_functions | Durable Functions orchestration | 40 | 150 | elastic | workflow | fn |
| azure.signalr | SignalR Service | 5 | 20 | units | topic | mix |
| azure.communication_email | Communication Services (email) | 150 | 500 | elastic | email | msg |

### Security & Identity
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.key_vault | Key Vault (secrets) | 20 | 60 | rps=4000 | secret | req |
| azure.key_vault_keys | Key Vault (crypto ops) | 10 | 40 | rps=4000 | kms | req |
| azure.entra_b2c | Entra External ID / B2C | 80 | 300 | elastic | auth | mau |
| azure.entra_id | Entra ID (token issue) | 60 | 200 | elastic | auth | free |
| azure.managed_identity | Managed Identity (token fetch) | 5 | 20 | elastic | auth | free |

### AI & ML (mocked — see file 11)
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.openai | Azure OpenAI (chat, full response) | 3000 | 12000 | tpm | llm | tok |
| azure.ai_search | Azure AI Search | 30 | 150 | slots | search | hr |
| azure.ml_endpoint | Azure ML online endpoint | 50 | 300 | slots | ml | hr |
| azure.ai_vision | Azure AI Vision | 300 | 900 | elastic | vision | unit |
| azure.ai_speech | Azure AI Speech (short audio) | 500 | 2000 | elastic | speech | unit |
| azure.ai_translator | Azure AI Translator | 100 | 300 | elastic | text-ai | unit |
| azure.ai_language | Azure AI Language | 100 | 300 | elastic | text-ai | unit |
| azure.doc_intelligence | Azure AI Document Intelligence | 1500 | 5000 | elastic | doc-ai | unit |
| azure.bot_service | Azure Bot Service | 150 | 500 | elastic | bot | req |
| azure.content_safety | Azure AI Content Safety | 80 | 250 | elastic | text-ai | unit |

### Observability
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| azure.monitor_logs | Azure Monitor Logs (ingest) | 20 | 80 | elastic | queue | gb-xfer |
| azure.app_insights | Application Insights | 10 | 40 | elastic | queue | gb-xfer |

## Serverless & scaling extras

| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |
|---|---|---|---|---|---|---|
| azure.functions | 500 | 2500 | scales out instances; per-instance concurrency varies by trigger | 5 min default, 10 min max (verify) | 5 | Consumption plan has noticeable cold starts. |
| azure.functions_flex | 250 | 1000 | per-instance concurrency configurable | longer (verify) | 3 | Optional always-ready instances. |
| azure.container_apps | 600 | 2500 | scale rules (HTTP concurrency, queue length) | — | 5 | Can scale to zero. |
| azure.app_service | — | — | per instance | 230 s request limit at front end (verify) | 60 | Plan size sets vCPU/memory. |
| azure.vm | — | — | per VM | — | 90 | VM Scale Sets autoscale. |
| azure.aks | — | — | per pod | — | 40 | Pod + node autoscaler. |
| azure.cosmos_db | — | — | RU/s provisioned or autoscale | — | 5 | Autoscale scales between 10% and 100% of max RU/s. |

## Quotas to model (verify current values)

- **Cosmos DB**: cost/throttling by **request units (RU/s)**. A 1 KB point read ≈ 1 RU; writes cost several RU (≈ 5+, size/indexing dependent). Over provisioned RU/s → 429 with `x-ms-retry-after-ms`. Per-partition limit ≈ 10,000 RU/s and 20 GB logical partition (hot-partition lesson).
- **Azure OpenAI**: per-deployment **TPM** (and derived RPM) quota; 429 when exceeded; Standard vs Provisioned throughput deployments (file 11).
- **Service Bus**: tier (Standard vs Premium) changes throughput, message size (256 KB Standard / larger Premium — verify), and dedicated capacity.
- **Event Hubs**: throughput units / processing units; ≈ 1 MB/s ingress per TU (verify).
- **Key Vault**: transaction rate limits (≈ thousands per 10 s per vault; verify) → 429.
- **Azure SQL**: DTU/vCore tier sets CPU and worker/connection limits; throttling when workers exhausted.
- **App Service**: plan SKU sets cores/memory; shared plan across apps (noisy neighbor lesson).
- **NAT Gateway**: SNAT port limits (≈ 64k ports per public IP; verify).
- **Front Door / App Gateway**: autoscale with minimum capacity units; WAF adds latency.

## Azure-specific teaching notes

- NSGs are **stateful**, have **priorities** (lower number wins), allow/deny, and attach to subnets and/or NICs. Default rules allow VNet-to-VNet and deny inbound from the internet.
- **VNet peering is non-transitive**; hub-and-spoke needs routing through a firewall/NVA or Virtual WAN.
- **SNAT port exhaustion** is a classic outbound failure; NAT Gateway fixes it.
- PaaS services (SQL, Storage, Key Vault) are public by default; **Private Endpoints** put them in your VNet (and require private DNS zones — a classic "can't resolve" bug).
- Azure OpenAI is accessed through your own resource + deployment name; quota is per region per subscription.
