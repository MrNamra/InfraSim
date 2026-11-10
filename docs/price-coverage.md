# Price Coverage Report

Generated from `packages/catalog/data/*.json` and `packages/cost-engine/data/price_sku_map.json` (updated `2026-11-10T00:00:00Z`).

CI fails if any non-`free` catalog service is missing from both `mappings` and `knownUnavailable` (with a reason).

## Summary

| Provider | Total | Free | Non-Free | Mapped | Known Unavailable | Missing | Transfer SKUs |
| -------- | ----: | ---: | -------: | -----: | ----------------: | ------: | ------------: |
| AWS      |    77 |    3 |       74 |     72 |                 2 |       0 |             5 |
| GCP      |    53 |    0 |       53 |     52 |                 1 |       0 |             5 |
| AZURE    |    63 |    2 |       61 |     59 |                 2 |       0 |             5 |
| OCI      |    50 |    9 |       41 |     38 |                 3 |       0 |             2 |

## AWS (77 services — 72 mapped, 2 known-unavailable, 3 free)

| Service ID                  | Price Code   | Status            | Unit Role(s) / Reason                                                                                                  |
| --------------------------- | ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `aws.ec2`                   | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.lambda`                | `fn`         | mapped            | `requests`, `gb_second`                                                                                                |
| `aws.fargate`               | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                          |
| `aws.ecs_ec2`               | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.eks`                   | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.app_runner`            | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                          |
| `aws.beanstalk`             | `hr`         | known-unavailable | AWS Elastic Beanstalk control plane is free; billing applies to underlying EC2 instances, RDS, S3, and load balancers. |
| `aws.lightsail`             | `flat`       | mapped            | `flat_month`                                                                                                           |
| `aws.batch`                 | `hr`         | known-unavailable | AWS Batch carries no separate service charge; users pay only for underlying EC2/Fargate compute and EBS storage.       |
| `aws.route53`               | `req`        | mapped            | `requests`                                                                                                             |
| `aws.cloudfront`            | `mix`        | mapped            | `data_transfer_gb`, `requests`                                                                                         |
| `aws.alb`                   | `lcu`        | mapped            | `instance_hour`, `lcu_hour`                                                                                            |
| `aws.nlb`                   | `lcu`        | mapped            | `instance_hour`, `lcu_hour`                                                                                            |
| `aws.gwlb`                  | `lcu`        | mapped            | `instance_hour`, `lcu_hour`                                                                                            |
| `aws.apigw_rest`            | `req`        | mapped            | `requests`                                                                                                             |
| `aws.apigw_http`            | `req`        | mapped            | `requests`                                                                                                             |
| `aws.appsync`               | `req`        | mapped            | `requests`                                                                                                             |
| `aws.global_accelerator`    | `mix`        | mapped            | `instance_hour`                                                                                                        |
| `aws.waf`                   | `req`        | mapped            | `requests`                                                                                                             |
| `aws.nat_gw`                | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                    |
| `aws.igw`                   | `free`       | free              | No provider charge                                                                                                     |
| `aws.vpc_peering`           | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                     |
| `aws.tgw`                   | `mix`        | mapped            | `instance_hour`                                                                                                        |
| `aws.privatelink`           | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                    |
| `aws.direct_connect`        | `mix`        | mapped            | `instance_hour`                                                                                                        |
| `aws.vpn`                   | `mix`        | mapped            | `instance_hour`                                                                                                        |
| `aws.s3`                    | `mix`        | mapped            | `storage_gb_month`, `requests`                                                                                         |
| `aws.ebs`                   | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                     |
| `aws.efs`                   | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                     |
| `aws.fsx`                   | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                     |
| `aws.glacier`               | `mix`        | mapped            | `storage_gb_month`                                                                                                     |
| `aws.rds_postgres`          | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.rds_mysql`             | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.rds_proxy`             | `hr`         | mapped            | `vcpu_hour`                                                                                                            |
| `aws.aurora_pg`             | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.aurora_mysql`          | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.aurora_serverless`     | `acu-hr`     | mapped            | `acu_hour`                                                                                                             |
| `aws.dynamodb`              | `rcu-wcu`    | mapped            | `rcu_hour`, `wcu_hour`                                                                                                 |
| `aws.dax`                   | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.elasticache_redis`     | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.elasticache_memcached` | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.memorydb`              | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.documentdb`            | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.neptune`               | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.keyspaces`             | `rcu-wcu`    | mapped            | `rcu_hour`                                                                                                             |
| `aws.timestream`            | `mix`        | mapped            | `unit`                                                                                                                 |
| `aws.redshift`              | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.athena`                | `query-tb`   | mapped            | `tb_scanned`                                                                                                           |
| `aws.opensearch`            | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.sqs`                   | `msg`        | mapped            | `messages`                                                                                                             |
| `aws.sns`                   | `msg`        | mapped            | `messages`                                                                                                             |
| `aws.eventbridge`           | `msg`        | mapped            | `messages`                                                                                                             |
| `aws.kinesis`               | `shard-hr`   | mapped            | `shard_hour`                                                                                                           |
| `aws.msk`                   | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.mq`                    | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.stepfunctions_std`     | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.stepfunctions_express` | `req`        | mapped            | `requests`                                                                                                             |
| `aws.ses`                   | `msg`        | mapped            | `messages`                                                                                                             |
| `aws.cognito`               | `mau`        | mapped            | `mau`                                                                                                                  |
| `aws.sts`                   | `free`       | free              | No provider charge                                                                                                     |
| `aws.secrets_manager`       | `mix`        | mapped            | `unit`                                                                                                                 |
| `aws.ssm_parameter`         | `free`       | free              | No provider charge                                                                                                     |
| `aws.kms`                   | `req`        | mapped            | `requests`                                                                                                             |
| `aws.bedrock`               | `tok`        | mapped            | `tokens_1m_in`, `tokens_1m_out`                                                                                        |
| `aws.bedrock_kb`            | `mix`        | mapped            | `unit`                                                                                                                 |
| `aws.sagemaker_endpoint`    | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.rekognition`           | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.textract`              | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.comprehend`            | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.transcribe`            | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.polly`                 | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.translate`             | `unit`       | mapped            | `unit`                                                                                                                 |
| `aws.lex`                   | `req`        | mapped            | `requests`                                                                                                             |
| `aws.kendra`                | `hr`         | mapped            | `instance_hour`                                                                                                        |
| `aws.personalize`           | `req`        | mapped            | `requests`                                                                                                             |
| `aws.cloudwatch_logs`       | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                     |
| `aws.xray`                  | `req`        | mapped            | `requests`                                                                                                             |

## GCP (53 services — 52 mapped, 1 known-unavailable, 0 free)

| Service ID                  | Price Code   | Status            | Unit Role(s) / Reason                                                                                                               |
| --------------------------- | ------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `gcp.compute_engine`        | `hr`         | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                       |
| `gcp.cloud_run`             | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                       |
| `gcp.cloud_functions`       | `fn`         | mapped            | `requests`, `gb_second`                                                                                                             |
| `gcp.gke`                   | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.app_engine`            | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.batch`                 | `hr`         | known-unavailable | Google Cloud Batch carries no separate orchestration charge; users pay only for underlying Compute Engine VMs and Persistent Disks. |
| `gcp.cloud_dns`             | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.cloud_cdn`             | `mix`        | mapped            | `data_transfer_gb`, `requests`                                                                                                      |
| `gcp.lb_https`              | `lcu`        | mapped            | `instance_hour`, `lcu_hour`                                                                                                         |
| `gcp.lb_network`            | `lcu`        | mapped            | `instance_hour`                                                                                                                     |
| `gcp.lb_internal`           | `lcu`        | mapped            | `instance_hour`                                                                                                                     |
| `gcp.api_gateway`           | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.apigee`                | `mix`        | mapped            | `unit`                                                                                                                              |
| `gcp.cloud_armor`           | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.cloud_nat`             | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                                 |
| `gcp.vpc_peering`           | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                                  |
| `gcp.psc`                   | `mix`        | mapped            | `instance_hour`                                                                                                                     |
| `gcp.vpn`                   | `mix`        | mapped            | `instance_hour`                                                                                                                     |
| `gcp.interconnect`          | `mix`        | mapped            | `instance_hour`                                                                                                                     |
| `gcp.cloud_storage`         | `mix`        | mapped            | `storage_gb_month`, `requests`                                                                                                      |
| `gcp.cloud_storage_archive` | `mix`        | mapped            | `storage_gb_month`                                                                                                                  |
| `gcp.persistent_disk`       | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                                  |
| `gcp.filestore`             | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                                  |
| `gcp.cloud_sql_postgres`    | `hr`         | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                       |
| `gcp.cloud_sql_mysql`       | `hr`         | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                       |
| `gcp.alloydb`               | `hr`         | mapped            | `vcpu_hour`                                                                                                                         |
| `gcp.spanner`               | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.firestore`             | `mix`        | mapped            | `rcu_hour`, `wcu_hour`                                                                                                              |
| `gcp.bigtable`              | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.memorystore_redis`     | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.memorystore_memcached` | `hr`         | mapped            | `instance_hour`                                                                                                                     |
| `gcp.bigquery`              | `query-tb`   | mapped            | `tb_scanned`                                                                                                                        |
| `gcp.pubsub`                | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                                  |
| `gcp.cloud_tasks`           | `msg`        | mapped            | `messages`                                                                                                                          |
| `gcp.eventarc`              | `msg`        | mapped            | `messages`                                                                                                                          |
| `gcp.workflows`             | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.managed_kafka`         | `hr`         | mapped            | `vcpu_hour`                                                                                                                         |
| `gcp.secret_manager`        | `mix`        | mapped            | `requests`                                                                                                                          |
| `gcp.kms`                   | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.identity_platform`     | `mau`        | mapped            | `mau`                                                                                                                               |
| `gcp.firebase_auth`         | `mau`        | mapped            | `mau`                                                                                                                               |
| `gcp.vertex_gemini`         | `tok`        | mapped            | `tokens_1m_in`, `tokens_1m_out`                                                                                                     |
| `gcp.vertex_endpoint`       | `hr`         | mapped            | `vcpu_hour`                                                                                                                         |
| `gcp.vertex_search`         | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.vision`                | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.speech_to_text`        | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.text_to_speech`        | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.translation`           | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.natural_language`      | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.document_ai`           | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.dialogflow`            | `req`        | mapped            | `requests`                                                                                                                          |
| `gcp.video_intelligence`    | `unit`       | mapped            | `unit`                                                                                                                              |
| `gcp.cloud_logging`         | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                                  |

## AZURE (63 services — 59 mapped, 2 known-unavailable, 2 free)

| Service ID                   | Price Code   | Status            | Unit Role(s) / Reason                                                                                                    |
| ---------------------------- | ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `azure.vm`                   | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.app_service`          | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.functions`            | `fn`         | mapped            | `requests`, `gb_second`                                                                                                  |
| `azure.functions_flex`       | `fn`         | mapped            | `gb_second`                                                                                                              |
| `azure.container_apps`       | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                            |
| `azure.container_instances`  | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                            |
| `azure.aks`                  | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.batch`                | `hr`         | known-unavailable | Azure Batch orchestration has no standalone Retail Prices meter; users pay only for underlying VMs and Storage.          |
| `azure.dns`                  | `req`        | mapped            | `requests`                                                                                                               |
| `azure.traffic_manager`      | `req`        | mapped            | `requests`                                                                                                               |
| `azure.front_door`           | `mix`        | mapped            | `data_transfer_gb`, `requests`                                                                                           |
| `azure.cdn`                  | `mix`        | mapped            | `data_transfer_gb`                                                                                                       |
| `azure.app_gateway`          | `lcu`        | mapped            | `instance_hour`, `lcu_hour`                                                                                              |
| `azure.load_balancer`        | `lcu`        | mapped            | `data_transfer_gb`                                                                                                       |
| `azure.apim`                 | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.waf`                  | `req`        | mapped            | `requests`                                                                                                               |
| `azure.firewall`             | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                      |
| `azure.nat_gateway`          | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                      |
| `azure.vnet_peering`         | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                       |
| `azure.private_link`         | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                      |
| `azure.vpn_gateway`          | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.expressroute`         | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.blob`                 | `mix`        | mapped            | `storage_gb_month`, `requests`                                                                                           |
| `azure.blob_archive`         | `mix`        | mapped            | `storage_gb_month`                                                                                                       |
| `azure.managed_disk`         | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                       |
| `azure.files`                | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                       |
| `azure.netapp_files`         | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                       |
| `azure.sql_db`               | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.sql_managed_instance` | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.postgres_flexible`    | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.mysql_flexible`       | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.cosmos_db`            | `ru`         | mapped            | `ru_hour`                                                                                                                |
| `azure.cosmos_postgres`      | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.table_storage`        | `req`        | mapped            | `requests`                                                                                                               |
| `azure.redis_cache`          | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.synapse`              | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.data_explorer`        | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.cosmos_gremlin`       | `ru`         | mapped            | `ru_hour`                                                                                                                |
| `azure.service_bus`          | `msg`        | mapped            | `messages`                                                                                                               |
| `azure.storage_queue`        | `msg`        | mapped            | `messages`                                                                                                               |
| `azure.event_hubs`           | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.event_grid`           | `msg`        | mapped            | `messages`                                                                                                               |
| `azure.logic_apps`           | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.durable_functions`    | `fn`         | mapped            | `requests`                                                                                                               |
| `azure.signalr`              | `mix`        | mapped            | `instance_hour`                                                                                                          |
| `azure.communication_email`  | `msg`        | known-unavailable | Azure Communication Services Email meters are not exposed under a standalone serviceName in the Azure Retail Prices API. |
| `azure.key_vault`            | `req`        | mapped            | `requests`                                                                                                               |
| `azure.key_vault_keys`       | `req`        | mapped            | `requests`                                                                                                               |
| `azure.entra_b2c`            | `mau`        | mapped            | `mau`                                                                                                                    |
| `azure.entra_id`             | `free`       | free              | No provider charge                                                                                                       |
| `azure.managed_identity`     | `free`       | free              | No provider charge                                                                                                       |
| `azure.openai`               | `tok`        | mapped            | `tokens_1m_in`, `tokens_1m_out`                                                                                          |
| `azure.ai_search`            | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.ml_endpoint`          | `hr`         | mapped            | `instance_hour`                                                                                                          |
| `azure.ai_vision`            | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.ai_speech`            | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.ai_translator`        | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.ai_language`          | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.doc_intelligence`     | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.bot_service`          | `req`        | mapped            | `requests`                                                                                                               |
| `azure.content_safety`       | `unit`       | mapped            | `unit`                                                                                                                   |
| `azure.monitor_logs`         | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                       |
| `azure.app_insights`         | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                       |

## OCI (50 services — 38 mapped, 3 known-unavailable, 9 free)

| Service ID                   | Price Code   | Status            | Unit Role(s) / Reason                                                                                                                                   |
| ---------------------------- | ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oci.compute`                | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                                           |
| `oci.functions`              | `fn`         | mapped            | `requests`, `gb_second`                                                                                                                                 |
| `oci.container_instances`    | `vcpu-gb-hr` | mapped            | `vcpu_hour`, `memory_gb_hour`                                                                                                                           |
| `oci.oke`                    | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.batch`                  | `hr`         | known-unavailable | OCI Batch orchestration (partNumber B112107) carries a $0 service rate in the Cost Estimator API; underlying Compute and Storage are billed separately. |
| `oci.dns`                    | `req`        | mapped            | `requests`                                                                                                                                              |
| `oci.load_balancer`          | `mix`        | mapped            | `instance_hour`, `lcu_hour`                                                                                                                             |
| `oci.network_lb`             | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.api_gateway`            | `req`        | mapped            | `requests`                                                                                                                                              |
| `oci.waf`                    | `req`        | mapped            | `requests`                                                                                                                                              |
| `oci.network_firewall`       | `mix`        | mapped            | `instance_hour`, `data_transfer_gb`                                                                                                                     |
| `oci.internet_gw`            | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.nat_gw`                 | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.service_gw`             | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.drg`                    | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.vcn_peering`            | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                                                      |
| `oci.fastconnect`            | `mix`        | mapped            | `instance_hour`                                                                                                                                         |
| `oci.site_vpn`               | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.object_storage`         | `mix`        | mapped            | `storage_gb_month`, `requests`                                                                                                                          |
| `oci.archive_storage`        | `mix`        | mapped            | `storage_gb_month`                                                                                                                                      |
| `oci.block_volume`           | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                                                      |
| `oci.file_storage`           | `gb-mo`      | mapped            | `storage_gb_month`                                                                                                                                      |
| `oci.autonomous_atp`         | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.autonomous_adw`         | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.base_db`                | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.mysql_heatwave`         | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.postgres`               | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.nosql`                  | `rcu-wcu`    | mapped            | `rcu_hour`, `wcu_hour`                                                                                                                                  |
| `oci.cache_redis`            | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.opensearch`             | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.queue`                  | `msg`        | mapped            | `messages`                                                                                                                                              |
| `oci.notifications`          | `msg`        | mapped            | `messages`                                                                                                                                              |
| `oci.streaming`              | `mix`        | mapped            | `data_transfer_gb`                                                                                                                                      |
| `oci.events`                 | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.connector_hub`          | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.integration`            | `hr`         | mapped            | `instance_hour`                                                                                                                                         |
| `oci.vault_secrets`          | `mix`        | known-unavailable | OCI Vault Secrets have no separate SKU in the Cost Estimator API; secret storage sits within OCI Vault free allowance or Private Vault partitions.      |
| `oci.vault_keys`             | `req`        | mapped            | `instance_hour`                                                                                                                                         |
| `oci.identity_domains`       | `mau`        | mapped            | `mau`                                                                                                                                                   |
| `oci.instance_principal`     | `free`       | free              | No provider charge                                                                                                                                      |
| `oci.genai`                  | `tok`        | mapped            | `tokens_1m_in`                                                                                                                                          |
| `oci.genai_embed`            | `tok`        | mapped            | `tokens_1m_in`                                                                                                                                          |
| `oci.datascience_deployment` | `hr`         | known-unavailable | OCI Data Science model deployments bill as underlying Compute VM OCPU and RAM shapes without a separate orchestration meter in the Cost Estimator API.  |
| `oci.language`               | `unit`       | mapped            | `unit`                                                                                                                                                  |
| `oci.vision`                 | `unit`       | mapped            | `unit`                                                                                                                                                  |
| `oci.speech`                 | `unit`       | mapped            | `unit`                                                                                                                                                  |
| `oci.document_understanding` | `unit`       | mapped            | `unit`                                                                                                                                                  |
| `oci.digital_assistant`      | `req`        | mapped            | `requests`                                                                                                                                              |
| `oci.logging`                | `gb-xfer`    | mapped            | `data_transfer_gb`                                                                                                                                      |
| `oci.monitoring`             | `req`        | mapped            | `requests`                                                                                                                                              |
