# 07 — Catalog: AWS

> Illustrative defaults, **not benchmarks**. Every number is user-editable in the UI. Quotas must be verified against current AWS docs before shipping (record in `packages/catalog/SOURCES.md`).

**Columns:** `p50`/`p95` = typical service-side latency of one call in ms. `Cap`: `elastic` · `slots` · `conc=N` · `rps=N` · `units` · `conn` · `tpm` · `pass`. `Mock` = kind (file 06 §3). `Price` = pricing model code (file 14 §3). For `compute` rows p50/p95 is a **placeholder for your app's service time**; user code profiling overrides it.

### Compute
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.ec2 | EC2 instance (runs your code) | 20 | 80 | slots | compute | hr |
| aws.lambda | Lambda | 15 | 60 | conc=1000 | fn | fn |
| aws.fargate | ECS on Fargate | 20 | 80 | slots | compute | vcpu-gb-hr |
| aws.ecs_ec2 | ECS on EC2 | 20 | 80 | slots | compute | hr |
| aws.eks | EKS pod | 20 | 80 | slots | compute | hr |
| aws.app_runner | App Runner | 20 | 80 | conc=100 | compute | vcpu-gb-hr |
| aws.beanstalk | Elastic Beanstalk | 20 | 80 | slots | compute | hr |
| aws.lightsail | Lightsail instance | 25 | 100 | slots | compute | flat |
| aws.batch | AWS Batch job | 30000 | 120000 | slots | async | hr |

### Networking & Delivery
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.route53 | Route 53 | 15 | 40 | elastic | dns | req |
| aws.cloudfront | CloudFront (cache hit) | 10 | 30 | elastic | cdn | mix |
| aws.alb | Application Load Balancer | 2 | 8 | elastic | lb | lcu |
| aws.nlb | Network Load Balancer | 1 | 3 | elastic | lb | lcu |
| aws.gwlb | Gateway Load Balancer | 1 | 4 | elastic | lb | lcu |
| aws.apigw_rest | API Gateway (REST) | 12 | 40 | rps=10000 | gw | req |
| aws.apigw_http | API Gateway (HTTP API) | 6 | 20 | rps=10000 | gw | req |
| aws.appsync | AppSync (GraphQL) | 20 | 80 | elastic | gw | req |
| aws.global_accelerator | Global Accelerator | 5 | 15 | elastic | net | mix |
| aws.waf | WAF | 1 | 4 | elastic | net | req |
| aws.nat_gw | NAT Gateway | 1 | 3 | pass | net | mix |
| aws.igw | Internet Gateway | 0 | 0 | pass | net | free |
| aws.vpc_peering | VPC Peering | 0.5 | 2 | pass | net | gb-xfer |
| aws.tgw | Transit Gateway | 1 | 3 | pass | net | mix |
| aws.privatelink | PrivateLink / VPC Endpoint | 1 | 3 | pass | net | mix |
| aws.direct_connect | Direct Connect | 5 | 15 | pass | net | mix |
| aws.vpn | Site-to-Site VPN | 10 | 30 | pass | net | mix |

### Storage
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.s3 | S3 (GET, first byte) | 25 | 90 | elastic | object | mix |
| aws.ebs | EBS volume | 1 | 3 | units | block | gb-mo |
| aws.efs | EFS | 4 | 15 | elastic | file | gb-mo |
| aws.fsx | FSx | 3 | 10 | units | file | gb-mo |
| aws.glacier | S3 Glacier (standard retrieval) | 10800000 | 18000000 | elastic | async | mix |

### Databases & Caches
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.rds_postgres | RDS PostgreSQL (simple query) | 3 | 15 | conn | sql | hr |
| aws.rds_mysql | RDS MySQL (simple query) | 3 | 15 | conn | sql | hr |
| aws.rds_proxy | RDS Proxy | 1 | 3 | conn | net | hr |
| aws.aurora_pg | Aurora PostgreSQL | 3 | 12 | conn | sql | hr |
| aws.aurora_mysql | Aurora MySQL | 3 | 12 | conn | sql | hr |
| aws.aurora_serverless | Aurora Serverless v2 | 4 | 18 | conn | sql | acu-hr |
| aws.dynamodb | DynamoDB | 5 | 15 | units | kv | rcu-wcu |
| aws.dax | DynamoDB Accelerator (DAX) | 0.4 | 1.5 | slots | cache | hr |
| aws.elasticache_redis | ElastiCache (Redis/Valkey) | 0.5 | 2 | slots | cache | hr |
| aws.elasticache_memcached | ElastiCache (Memcached) | 0.5 | 2 | slots | cache | hr |
| aws.memorydb | MemoryDB | 1 | 4 | slots | cache | hr |
| aws.documentdb | DocumentDB | 5 | 20 | conn | doc | hr |
| aws.neptune | Neptune | 10 | 50 | conn | graph | hr |
| aws.keyspaces | Keyspaces (Cassandra) | 5 | 20 | units | kv | rcu-wcu |
| aws.timestream | Timestream | 15 | 80 | elastic | ts | mix |
| aws.redshift | Redshift | 800 | 6000 | conn | olap | hr |
| aws.athena | Athena | 2500 | 15000 | elastic | olap | query-tb |
| aws.opensearch | OpenSearch Service | 15 | 80 | slots | search | hr |

### Messaging & Integration
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.sqs | SQS | 10 | 30 | elastic | queue | msg |
| aws.sns | SNS | 15 | 40 | elastic | topic | msg |
| aws.eventbridge | EventBridge | 30 | 100 | elastic | bus | msg |
| aws.kinesis | Kinesis Data Streams | 20 | 70 | units | stream | shard-hr |
| aws.msk | MSK (Kafka) | 5 | 20 | slots | stream | hr |
| aws.mq | Amazon MQ | 8 | 30 | slots | queue | hr |
| aws.stepfunctions_std | Step Functions (Standard) | 50 | 200 | elastic | workflow | unit |
| aws.stepfunctions_express | Step Functions (Express) | 20 | 80 | elastic | workflow | req |
| aws.ses | SES (email) | 100 | 300 | rps=14 | email | msg |

### Security & Identity
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.cognito | Cognito | 80 | 300 | elastic | auth | mau |
| aws.sts | IAM / STS | 50 | 150 | elastic | auth | free |
| aws.secrets_manager | Secrets Manager | 20 | 60 | elastic | secret | mix |
| aws.ssm_parameter | SSM Parameter Store | 10 | 40 | elastic | secret | free |
| aws.kms | KMS | 5 | 20 | elastic | kms | req |

### AI & ML (mocked — see file 11)
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.bedrock | Bedrock (LLM, full response) | 3000 | 12000 | tpm | llm | tok |
| aws.bedrock_kb | Bedrock Knowledge Bases (retrieve) | 300 | 900 | elastic | search | mix |
| aws.sagemaker_endpoint | SageMaker real-time endpoint | 50 | 300 | slots | ml | hr |
| aws.rekognition | Rekognition | 300 | 900 | elastic | vision | unit |
| aws.textract | Textract (sync) | 1500 | 5000 | elastic | doc-ai | unit |
| aws.comprehend | Comprehend | 100 | 300 | elastic | text-ai | unit |
| aws.transcribe | Transcribe (batch) | 60000 | 240000 | elastic | speech | unit |
| aws.polly | Polly | 150 | 400 | elastic | speech | unit |
| aws.translate | Translate | 100 | 300 | elastic | text-ai | unit |
| aws.lex | Lex | 150 | 500 | elastic | bot | req |
| aws.kendra | Kendra | 300 | 1000 | elastic | search | hr |
| aws.personalize | Personalize (real-time recs) | 50 | 150 | elastic | ml | req |

### Observability
| ID | Name | p50 | p95 | Cap | Mock | Price |
|---|---|---|---|---|---|---|
| aws.cloudwatch_logs | CloudWatch Logs (ingest) | 20 | 80 | elastic | queue | gb-xfer |
| aws.xray | X-Ray | 10 | 40 | elastic | queue | req |

## Serverless & scaling extras

| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |
|---|---|---|---|---|---|---|
| aws.lambda | 250 | 900 | 1000 / region | 900 s | 0 (cold start instead) | Java/.NET cold starts are longer; CPU scales with memory (≈ 1 vCPU at 1,769 MB). `onLimit = throttle` (429). |
| aws.fargate | — | — | per task | — | 45 | New tasks take tens of seconds to serve. |
| aws.ec2 | — | — | per instance | — | 90 | Launch + warmup via Auto Scaling. T-family burstable CPU credits are a v2 model. |
| aws.eks | — | — | per pod | — | 40 | Pod scheduling + image pull; node scale adds more. |
| aws.app_runner | 800 | 2500 | 100 / instance | 120 s | 15 | Scales on concurrency. |
| aws.aurora_serverless | — | — | ACU-based | — | 10 | Scales capacity in ACUs; brief pauses possible when scaling. |

## Quotas to model (verify current values)

- **Lambda**: account concurrency 1,000/region (soft); sync payload 6 MB; timeout ≤ 15 min; new concurrent executions scale at a bounded rate per function.
- **API Gateway**: account throttle ≈ 10,000 rps steady with burst ≈ 5,000; integration timeout ≈ 29 s default.
- **S3**: ≈ 3,500 PUT/COPY/POST/DELETE and ≈ 5,500 GET/HEAD per second **per prefix**. Add node setting `prefixes` (default 1) → limit = value × prefixes. Over limit → 503 SlowDown.
- **DynamoDB**: per-partition ≈ 3,000 RCU and ≈ 1,000 WCU; item ≤ 400 KB; hot keys throttle even when table capacity looks fine.
- **SQS**: Standard ≈ nearly unlimited; FIFO has per-queue throughput limits (verify current numbers and high-throughput mode); visibility timeout default 30 s; message ≤ 256 KB.
- **Kinesis**: per shard ≈ 1 MB/s or 1,000 records/s write, ≈ 2 MB/s read.
- **RDS `max_connections`** is derived from instance memory (default parameter formulas, e.g. MySQL `DBInstanceClassMemory/12582880`, PostgreSQL `LEAST(DBInstanceClassMemory/9531392, 5000)` — verify). Expose as `conn.formula` with instance memory input.
- **ALB**: idle timeout 60 s default; scales automatically but not instantly under extreme spikes.
- **NAT Gateway**: bandwidth scales to ~100 Gbps; ≈ 55,000 simultaneous connections per unique destination (port exhaustion = v2). Data processing charge per GB is a key cost driver.
- **Bedrock**: per-model, per-region RPM and TPM quotas; throttling returns `ThrottlingException` (429).
- **SES**: new accounts start with low sending rates (sandbox).

## AWS-specific teaching notes (feed the diagnosis rules, file 17)

- DB in a public subnet; app in private subnet without NAT cannot call the internet or SaaS APIs.
- Lambda inside a VPC without NAT/endpoints cannot reach AWS public APIs.
- Cross-AZ traffic is billed; chatty services across AZs raise cost.
- RDS connection exhaustion from many Lambda concurrent executions → use RDS Proxy.
- ALB health check failing on overloaded targets → traffic shifts → cascade.
