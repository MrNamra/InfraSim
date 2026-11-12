import { getService } from '@infrasim/catalog';
import { getInstanceSpec } from '@infrasim/cost-engine';
import type { AutoscalingConfig, NodeConfig, ServiceDefinition } from '@infrasim/shared-types';
import type { CloudProviderId } from '../mappings/types.js';
import { isSecretKeyName } from '../naming.js';
import { normalizeTerraformProviderName } from './sanitizer.js';
import type { ClassifiedResource, NormalizedPlanResource } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function extractLabel(res: NormalizedPlanResource): string {
  const vals = res.values;
  const tags = isPlainObject(vals.tags) ? vals.tags : undefined;
  const tagName = tags ? asString(tags.Name) : undefined;
  if (tagName) return tagName;
  const direct =
    asString(vals.display_name) ??
    asString(vals.function_name) ??
    asString(vals.cluster_name) ??
    asString(vals.db_name) ??
    asString(vals.bucket) ??
    asString(vals.name);
  if (direct && !direct.startsWith('${')) {
    return direct;
  }
  return res.name.replace(/_/g, ' ');
}

function extractRegion(res: NormalizedPlanResource): string | undefined {
  const vals = res.values;
  return (
    asString(vals.region) ??
    asString(vals.location) ??
    asString(vals.location_id) ??
    (asString(vals.availability_zone)?.replace(/[a-z]$/, '') || undefined)
  );
}

function extractCidr(res: NormalizedPlanResource): string | undefined {
  const vals = res.values;
  const direct = asString(vals.cidr_block) ?? asString(vals.ip_cidr_range);
  if (direct) return direct;
  if (Array.isArray(vals.cidr_blocks) && typeof vals.cidr_blocks[0] === 'string') {
    return vals.cidr_blocks[0];
  }
  if (Array.isArray(vals.address_space) && typeof vals.address_space[0] === 'string') {
    return vals.address_space[0];
  }
  if (Array.isArray(vals.address_prefixes) && typeof vals.address_prefixes[0] === 'string') {
    return vals.address_prefixes[0];
  }
  return undefined;
}

function extractStringRecordEnv(envContainer: unknown): Record<string, string> | undefined {
  if (!isPlainObject(envContainer)) return undefined;
  const sourceMap = isPlainObject(envContainer.variables) ? envContainer.variables : envContainer;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sourceMap)) {
    if (isSecretKeyName(k)) continue;
    if (typeof v === 'string') {
      out[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractEnvArray(items: unknown): Record<string, string> | undefined {
  if (!Array.isArray(items)) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const name = asString(item.name);
    if (!name || isSecretKeyName(name)) continue;
    const val = asString(item.value);
    if (val !== undefined) out[name] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeImportedAttrs(
  values: Record<string, unknown>,
  consumedKeys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (consumedKeys.has(k) || isSecretKeyName(k) || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (isPlainObject(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

function defaultNodeConfigFromService(service: ServiceDefinition | undefined): NodeConfig {
  const cap = service?.capacity;
  const kind = service?.kind;
  const cfg: NodeConfig = {
    instances: 1,
    operations: {},
  };
  if (service?.latency) {
    cfg.latency = { ...service.latency };
  }
  if (kind === 'compute') {
    cfg.vcpu = 2;
    cfg.memoryGb = 4;
    cfg.runtimePreset = 'custom';
    cfg.maxInFlightPerInstance = 100;
  } else if (kind === 'fn') {
    cfg.memoryGb = 0.5;
    cfg.runtimePreset = 'custom';
    cfg.maxInFlightPerInstance = cap?.type === 'conc' ? cap.limit : 100;
  } else if (kind === 'cache') {
    cfg.cacheHitRatio = 0.85;
    cfg.maxInFlightPerInstance = 500;
  } else if (
    kind === 'sql' ||
    kind === 'doc' ||
    kind === 'kv' ||
    kind === 'graph' ||
    kind === 'olap'
  ) {
    cfg.readRatio = 0.8;
    if (cap?.type === 'conn') {
      cfg.connections = { max: cap.default };
      cfg.maxInFlightPerInstance = cap.default;
    }
  } else if (cap?.type === 'conc') {
    cfg.maxInFlightPerInstance = cap.limit;
  }
  return cfg;
}

const STATIC_GROUP_TYPES = new Map<string, { provider: CloudProviderId; kind: 'vpc' | 'subnet' }>([
  ['aws_vpc', { provider: 'aws', kind: 'vpc' }],
  ['aws_subnet', { provider: 'aws', kind: 'subnet' }],
  ['google_compute_network', { provider: 'gcp', kind: 'vpc' }],
  ['google_compute_subnetwork', { provider: 'gcp', kind: 'subnet' }],
  ['azurerm_virtual_network', { provider: 'azure', kind: 'vpc' }],
  ['azurerm_subnet', { provider: 'azure', kind: 'subnet' }],
  ['oci_core_vcn', { provider: 'oci', kind: 'vpc' }],
  ['oci_core_subnet', { provider: 'oci', kind: 'subnet' }],
]);

const NETWORK_OBJECT_ROLES = new Map<string, { provider: CloudProviderId; role: string }>([
  ['aws_internet_gateway', { provider: 'aws', role: 'igw' }],
  ['aws_eip', { provider: 'aws', role: 'eip' }],
  ['aws_route_table', { provider: 'aws', role: 'route_table' }],
  ['aws_route', { provider: 'aws', role: 'route' }],
  ['aws_route_table_association', { provider: 'aws', role: 'route_assoc' }],
  ['aws_security_group', { provider: 'aws', role: 'sg' }],
  ['aws_vpc_security_group_ingress_rule', { provider: 'aws', role: 'sg_ingress' }],
  ['aws_vpc_security_group_egress_rule', { provider: 'aws', role: 'sg_egress' }],
  ['aws_network_acl', { provider: 'aws', role: 'nacl' }],
  ['aws_network_acl_rule', { provider: 'aws', role: 'nacl_rule' }],
  ['aws_vpc_peering_connection', { provider: 'aws', role: 'peering' }],
  ['aws_vpc_endpoint', { provider: 'aws', role: 'endpoint' }],
  ['google_compute_firewall', { provider: 'gcp', role: 'firewall' }],
  ['google_compute_router', { provider: 'gcp', role: 'router' }],
  ['google_compute_network_peering', { provider: 'gcp', role: 'peering' }],
  ['google_compute_security_policy', { provider: 'gcp', role: 'waf' }],
  ['azurerm_network_security_group', { provider: 'azure', role: 'nsg' }],
  ['azurerm_network_security_rule', { provider: 'azure', role: 'nsg_rule' }],
  ['azurerm_subnet_network_security_group_association', { provider: 'azure', role: 'nsg_assoc' }],
  ['azurerm_subnet_route_table_association', { provider: 'azure', role: 'route_assoc' }],
  ['azurerm_route_table', { provider: 'azure', role: 'route_table' }],
  ['azurerm_virtual_network_peering', { provider: 'azure', role: 'peering' }],
  ['azurerm_private_endpoint', { provider: 'azure', role: 'endpoint' }],
  ['oci_core_internet_gateway', { provider: 'oci', role: 'igw' }],
  ['oci_core_service_gateway', { provider: 'oci', role: 'service_gw' }],
  ['oci_core_security_list', { provider: 'oci', role: 'security_list' }],
  ['oci_core_network_security_group', { provider: 'oci', role: 'nsg' }],
  ['oci_core_network_security_group_security_rule', { provider: 'oci', role: 'nsg_rule' }],
  ['oci_core_route_table', { provider: 'oci', role: 'route_table' }],
]);

const EDGE_SOURCE_ROLES = new Map<string, string>([
  ['aws_lb_target_group', 'lb_target_group'],
  ['aws_lb_listener', 'lb_listener'],
  ['aws_alb_listener', 'lb_listener'],
  ['aws_lb_target_group_attachment', 'lb_target_attachment'],
  ['aws_lambda_event_source_mapping', 'event_source_mapping'],
  ['aws_sns_topic_subscription', 'sns_subscription'],
  ['aws_apigatewayv2_integration', 'apigw_integration'],
  ['aws_apigatewayv2_route', 'apigw_route'],
  ['aws_api_gateway_integration', 'apigw_integration'],
  ['aws_s3_bucket_notification', 's3_notification'],
  ['aws_route53_record', 'dns_record'],
  ['google_pubsub_subscription', 'pubsub_subscription'],
  ['google_dns_record_set', 'dns_record'],
]);

const IGNORED_RESOURCE_TYPES = new Map<string, string>([
  ['aws_iam_role', 'Auxiliary IAM execution/service role'],
  ['aws_iam_role_policy', 'Auxiliary inline IAM policy'],
  ['aws_iam_role_policy_attachment', 'Auxiliary IAM policy attachment'],
  ['aws_iam_policy', 'Auxiliary IAM policy'],
  ['aws_db_subnet_group', 'RDS subnet placement helper'],
  ['aws_cloudwatch_log_group', 'Logging configuration'],
  ['aws_launch_template', 'VM template bound to Auto Scaling Group'],
  ['aws_ecs_cluster', 'ECS cluster container (service mapped instead)'],
  ['aws_ecs_task_definition', 'ECS task specification consumed by ECS service'],
  ['aws_eks_node_group', 'EKS worker pool attached to EKS cluster'],
  ['aws_rds_cluster_instance', 'Aurora cluster member instance'],
  ['aws_apigatewayv2_stage', 'API Gateway stage wrapper'],
  ['aws_api_gateway_resource', 'API Gateway path wrapper'],
  ['aws_api_gateway_method', 'API Gateway method wrapper'],
  ['aws_api_gateway_deployment', 'API Gateway deployment wrapper'],
  ['aws_wafv2_web_acl_association', 'WAF ACL attachment'],
  ['google_compute_instance_template', 'VM template consumed by Managed Instance Group'],
  ['google_compute_health_check', 'Load balancer health check helper'],
  ['google_compute_backend_service', 'Load balancer backend service helper'],
  ['google_compute_url_map', 'Load balancer URL map helper'],
  ['google_compute_target_http_proxy', 'Load balancer HTTP proxy helper'],
  ['google_compute_target_https_proxy', 'Load balancer HTTPS proxy helper'],
  ['google_sql_database', 'Logical database schema inside Cloud SQL instance'],
  ['google_container_node_pool', 'GKE node pool attached to GKE cluster'],
  ['azurerm_resource_group', 'Azure Resource Group organizational container'],
  ['azurerm_network_interface', 'NIC attached to Azure VM'],
  ['azurerm_public_ip', 'Public IP allocation attached to LB/Gateway'],
  ['azurerm_service_plan', 'App Service / Functions hosting plan'],
  ['azurerm_container_app_environment', 'Container Apps environment wrapper'],
  ['azurerm_mssql_server', 'Logical SQL server hosting Azure SQL database'],
  ['azurerm_storage_container', 'Blob container inside Azure Storage Account'],
  ['azurerm_servicebus_namespace', 'Service Bus namespace hosting queue'],
  ['azurerm_eventhub_namespace', 'Event Hubs namespace hosting hub'],
  ['azurerm_cognitive_account', 'Cognitive Services account hosting OpenAI deployment'],
  ['oci_load_balancer_backend_set', 'OCI load balancer backend set helper'],
  ['oci_load_balancer_listener', 'OCI load balancer listener helper'],
  ['oci_functions_application', 'OCI Functions application wrapper'],
  ['oci_containerengine_node_pool', 'OKE node pool attached to cluster'],
  ['oci_core_instance_configuration', 'OCI instance configuration consumed by instance pool'],
  ['oci_generative_ai_dedicated_ai_cluster', 'OCI GenAI cluster hosting endpoint'],
]);

function inferProviderFromTypeOrName(res: NormalizedPlanResource): CloudProviderId | undefined {
  const norm = normalizeTerraformProviderName(res.providerName);
  if (norm.cloudProvider) return norm.cloudProvider;
  if (res.type.startsWith('aws_')) return 'aws';
  if (res.type.startsWith('google_')) return 'gcp';
  if (res.type.startsWith('azurerm_')) return 'azure';
  if (res.type.startsWith('oci_')) return 'oci';
  return undefined;
}

function mapResourceTypeToServiceId(
  res: NormalizedPlanResource,
): { serviceId: string; provider: CloudProviderId } | undefined {
  const v = res.values;
  switch (res.type) {
    // AWS
    case 'aws_instance':
    case 'aws_autoscaling_group':
      return { provider: 'aws', serviceId: 'aws.ec2' };
    case 'aws_lb':
    case 'aws_alb': {
      const lbType = asString(v.load_balancer_type);
      if (lbType === 'network') return { provider: 'aws', serviceId: 'aws.nlb' };
      if (lbType === 'gateway') return { provider: 'aws', serviceId: 'aws.gwlb' };
      return { provider: 'aws', serviceId: 'aws.alb' };
    }
    case 'aws_lambda_function':
      return { provider: 'aws', serviceId: 'aws.lambda' };
    case 'aws_apigatewayv2_api':
      return { provider: 'aws', serviceId: 'aws.apigw_http' };
    case 'aws_api_gateway_rest_api':
      return { provider: 'aws', serviceId: 'aws.apigw_rest' };
    case 'aws_ecs_service':
      return {
        provider: 'aws',
        serviceId: asString(v.launch_type) === 'EC2' ? 'aws.ecs_ec2' : 'aws.fargate',
      };
    case 'aws_eks_cluster':
      return { provider: 'aws', serviceId: 'aws.eks' };
    case 'aws_apprunner_service':
      return { provider: 'aws', serviceId: 'aws.apprunner' };
    case 'aws_cloudfront_distribution':
      return { provider: 'aws', serviceId: 'aws.cloudfront' };
    case 'aws_wafv2_web_acl':
      return { provider: 'aws', serviceId: 'aws.waf' };
    case 'aws_nat_gateway':
      return { provider: 'aws', serviceId: 'aws.nat_gw' };
    case 'aws_ec2_transit_gateway':
      return { provider: 'aws', serviceId: 'aws.tgw' };
    case 'aws_db_instance': {
      const engine = (asString(v.engine) ?? '').toLowerCase();
      return {
        provider: 'aws',
        serviceId:
          engine.includes('mysql') || engine.includes('mariadb')
            ? 'aws.rds_mysql'
            : 'aws.rds_postgres',
      };
    }
    case 'aws_rds_cluster': {
      const engine = (asString(v.engine) ?? '').toLowerCase();
      const mode = (asString(v.engine_mode) ?? '').toLowerCase();
      if (mode === 'serverless' || Array.isArray(v.serverlessv2_scaling_configuration)) {
        return { provider: 'aws', serviceId: 'aws.aurora_serverless' };
      }
      return {
        provider: 'aws',
        serviceId: engine.includes('mysql') ? 'aws.aurora_mysql' : 'aws.aurora_pg',
      };
    }
    case 'aws_db_proxy':
      return { provider: 'aws', serviceId: 'aws.rds_proxy' };
    case 'aws_dynamodb_table':
      return { provider: 'aws', serviceId: 'aws.dynamodb' };
    case 'aws_elasticache_replication_group':
    case 'aws_elasticache_cluster': {
      const engine = (asString(v.engine) ?? '').toLowerCase();
      return {
        provider: 'aws',
        serviceId: engine.includes('memcached')
          ? 'aws.elasticache_memcached'
          : 'aws.elasticache_redis',
      };
    }
    case 'aws_s3_bucket':
      return { provider: 'aws', serviceId: 'aws.s3' };
    case 'aws_ebs_volume':
      return { provider: 'aws', serviceId: 'aws.ebs' };
    case 'aws_efs_file_system':
      return { provider: 'aws', serviceId: 'aws.efs' };
    case 'aws_sqs_queue':
      return { provider: 'aws', serviceId: 'aws.sqs' };
    case 'aws_sns_topic':
      return { provider: 'aws', serviceId: 'aws.sns' };
    case 'aws_kinesis_stream':
      return { provider: 'aws', serviceId: 'aws.kinesis' };
    case 'aws_msk_cluster':
      return { provider: 'aws', serviceId: 'aws.msk' };
    case 'aws_cloudwatch_event_bus':
      return { provider: 'aws', serviceId: 'aws.eventbridge' };
    case 'aws_secretsmanager_secret':
      return { provider: 'aws', serviceId: 'aws.secrets_manager' };
    case 'aws_ssm_parameter':
      return { provider: 'aws', serviceId: 'aws.ssm_parameter' };
    case 'aws_kms_key':
      return { provider: 'aws', serviceId: 'aws.kms' };
    case 'aws_route53_zone':
      return { provider: 'aws', serviceId: 'aws.route53' };
    case 'aws_sagemaker_endpoint':
      return { provider: 'aws', serviceId: 'aws.sagemaker_endpoint' };

    // GCP
    case 'google_compute_instance':
    case 'google_compute_instance_group_manager':
      return { provider: 'gcp', serviceId: 'gcp.compute_engine' };
    case 'google_compute_global_forwarding_rule':
    case 'google_compute_forwarding_rule':
      return { provider: 'gcp', serviceId: 'gcp.lb_https' };
    case 'google_compute_router_nat':
      return { provider: 'gcp', serviceId: 'gcp.cloud_nat' };
    case 'google_cloud_run_v2_service':
    case 'google_cloud_run_service':
      return { provider: 'gcp', serviceId: 'gcp.cloud_run' };
    case 'google_cloudfunctions2_function':
    case 'google_cloudfunctions_function':
      return { provider: 'gcp', serviceId: 'gcp.cloud_functions' };
    case 'google_container_cluster':
      return { provider: 'gcp', serviceId: 'gcp.gke' };
    case 'google_sql_database_instance': {
      const dbVer = (asString(v.database_version) ?? '').toUpperCase();
      return {
        provider: 'gcp',
        serviceId: dbVer.includes('MYSQL') ? 'gcp.cloud_sql_mysql' : 'gcp.cloud_sql_postgres',
      };
    }
    case 'google_spanner_instance':
      return { provider: 'gcp', serviceId: 'gcp.spanner' };
    case 'google_bigtable_instance':
      return { provider: 'gcp', serviceId: 'gcp.bigtable' };
    case 'google_firestore_database':
      return { provider: 'gcp', serviceId: 'gcp.firestore' };
    case 'google_redis_instance':
      return { provider: 'gcp', serviceId: 'gcp.memorystore_redis' };
    case 'google_memcache_instance':
      return { provider: 'gcp', serviceId: 'gcp.memorystore_memcached' };
    case 'google_storage_bucket':
      return { provider: 'gcp', serviceId: 'gcp.cloud_storage' };
    case 'google_pubsub_topic':
      return { provider: 'gcp', serviceId: 'gcp.pubsub' };
    case 'google_cloud_tasks_queue':
      return { provider: 'gcp', serviceId: 'gcp.cloud_tasks' };
    case 'google_secret_manager_secret':
      return { provider: 'gcp', serviceId: 'gcp.secret_manager' };
    case 'google_bigquery_dataset':
      return { provider: 'gcp', serviceId: 'gcp.bigquery' };
    case 'google_dns_managed_zone':
      return { provider: 'gcp', serviceId: 'gcp.cloud_dns' };
    case 'google_vertex_ai_endpoint':
      return { provider: 'gcp', serviceId: 'gcp.vertex_endpoint' };

    // Azure
    case 'azurerm_linux_virtual_machine':
    case 'azurerm_windows_virtual_machine':
    case 'azurerm_linux_virtual_machine_scale_set':
      return { provider: 'azure', serviceId: 'azure.vm' };
    case 'azurerm_lb':
      return { provider: 'azure', serviceId: 'azure.load_balancer' };
    case 'azurerm_application_gateway':
      return { provider: 'azure', serviceId: 'azure.app_gateway' };
    case 'azurerm_nat_gateway':
      return { provider: 'azure', serviceId: 'azure.nat_gateway' };
    case 'azurerm_linux_web_app':
    case 'azurerm_app_service':
      return { provider: 'azure', serviceId: 'azure.app_service' };
    case 'azurerm_linux_function_app':
    case 'azurerm_function_app':
      return { provider: 'azure', serviceId: 'azure.functions' };
    case 'azurerm_container_app':
      return { provider: 'azure', serviceId: 'azure.container_apps' };
    case 'azurerm_kubernetes_cluster':
      return { provider: 'azure', serviceId: 'azure.aks' };
    case 'azurerm_cdn_frontdoor_profile':
    case 'azurerm_cdn_frontdoor_endpoint':
      return { provider: 'azure', serviceId: 'azure.front_door' };
    case 'azurerm_mssql_database':
    case 'azurerm_sql_database':
      return { provider: 'azure', serviceId: 'azure.sql_db' };
    case 'azurerm_postgresql_flexible_server':
      return { provider: 'azure', serviceId: 'azure.postgres_flexible' };
    case 'azurerm_mysql_flexible_server':
      return { provider: 'azure', serviceId: 'azure.mysql_flexible' };
    case 'azurerm_cosmosdb_account':
      return { provider: 'azure', serviceId: 'azure.cosmos_db' };
    case 'azurerm_redis_cache':
      return { provider: 'azure', serviceId: 'azure.redis_cache' };
    case 'azurerm_storage_account':
      return { provider: 'azure', serviceId: 'azure.blob' };
    case 'azurerm_servicebus_queue':
      return { provider: 'azure', serviceId: 'azure.service_bus' };
    case 'azurerm_eventhub':
      return { provider: 'azure', serviceId: 'azure.event_hubs' };
    case 'azurerm_eventgrid_topic':
      return { provider: 'azure', serviceId: 'azure.event_grid' };
    case 'azurerm_key_vault':
      return { provider: 'azure', serviceId: 'azure.key_vault' };
    case 'azurerm_api_management':
      return { provider: 'azure', serviceId: 'azure.apim' };
    case 'azurerm_dns_zone':
      return { provider: 'azure', serviceId: 'azure.dns' };
    case 'azurerm_cognitive_deployment':
      return { provider: 'azure', serviceId: 'azure.openai' };
    case 'azurerm_search_service':
      return { provider: 'azure', serviceId: 'azure.ai_search' };

    // OCI
    case 'oci_core_instance':
    case 'oci_core_instance_pool':
      return { provider: 'oci', serviceId: 'oci.compute' };
    case 'oci_load_balancer_load_balancer':
      return { provider: 'oci', serviceId: 'oci.load_balancer' };
    case 'oci_network_load_balancer_network_load_balancer':
      return { provider: 'oci', serviceId: 'oci.network_lb' };
    case 'oci_core_nat_gateway':
      return { provider: 'oci', serviceId: 'oci.nat_gw' };
    case 'oci_core_drg':
      return { provider: 'oci', serviceId: 'oci.drg' };
    case 'oci_functions_function':
      return { provider: 'oci', serviceId: 'oci.functions' };
    case 'oci_containerengine_cluster':
      return { provider: 'oci', serviceId: 'oci.oke' };
    case 'oci_apigateway_gateway':
      return { provider: 'oci', serviceId: 'oci.api_gateway' };
    case 'oci_objectstorage_bucket':
      return { provider: 'oci', serviceId: 'oci.object_storage' };
    case 'oci_core_volume':
      return { provider: 'oci', serviceId: 'oci.block_volume' };
    case 'oci_database_autonomous_database': {
      const workload = (asString(v.db_workload) ?? '').toUpperCase();
      return {
        provider: 'oci',
        serviceId: workload === 'DW' ? 'oci.autonomous_adw' : 'oci.autonomous_atp',
      };
    }
    case 'oci_mysql_mysql_db_system':
      return { provider: 'oci', serviceId: 'oci.mysql_heatwave' };
    case 'oci_psql_db_system':
      return { provider: 'oci', serviceId: 'oci.postgres' };
    case 'oci_nosql_table':
      return { provider: 'oci', serviceId: 'oci.nosql' };
    case 'oci_streaming_stream':
      return { provider: 'oci', serviceId: 'oci.streaming' };
    case 'oci_queue_queue':
      return { provider: 'oci', serviceId: 'oci.queue' };
    case 'oci_ons_notification_topic':
      return { provider: 'oci', serviceId: 'oci.notifications' };
    case 'oci_vault_secret':
      return { provider: 'oci', serviceId: 'oci.vault_secrets' };
    case 'oci_dns_zone':
      return { provider: 'oci', serviceId: 'oci.dns' };
    case 'oci_generative_ai_endpoint':
      return { provider: 'oci', serviceId: 'oci.genai' };

    default:
      return undefined;
  }
}

function buildNodeConfig(
  res: NormalizedPlanResource,
  serviceId: string,
  provider: CloudProviderId,
  label: string,
): {
  config: NodeConfig;
  consumedKeys: Set<string>;
  unknownInstanceType?: {
    instanceType: string;
    serviceId: string;
    provider: CloudProviderId;
    nodeLabel: string;
  };
} {
  const service = getService(serviceId);
  const config = defaultNodeConfigFromService(service);
  const consumed = new Set<string>();
  const v = res.values;

  // Instance count / scaling
  const desired =
    asNumber(v.desired_capacity) ??
    asNumber(v.desired_count) ??
    asNumber(v.target_size) ??
    asNumber(v.size) ??
    asNumber(v.instances) ??
    asNumber(v.num_nodes) ??
    asNumber(v.num_cache_nodes) ??
    asNumber(v.num_cache_clusters) ??
    asNumber(v.partitions) ??
    asNumber(v.shard_count);
  if (desired !== undefined && desired > 0) {
    config.instances = Math.max(1, Math.round(desired));
    consumed.add('desired_capacity');
    consumed.add('desired_count');
    consumed.add('target_size');
    consumed.add('size');
    consumed.add('instances');
  } else if (asBool(v.multi_az) === true) {
    config.instances = 2;
    consumed.add('multi_az');
  }

  if (
    res.type === 'aws_autoscaling_group' ||
    res.type === 'google_compute_instance_group_manager' ||
    res.type === 'azurerm_linux_virtual_machine_scale_set' ||
    res.type === 'oci_core_instance_pool'
  ) {
    const minVal =
      asNumber(v.min_size) ?? asNumber(v.target_size) ?? asNumber(v.size) ?? config.instances;
    const maxVal = asNumber(v.max_size) ?? Math.max(minVal, config.instances * 2);
    const asConfig: AutoscalingConfig = {
      min: Math.max(1, Math.round(minVal)),
      max: Math.max(1, Math.round(maxVal)),
      metric: 'cpu',
      target: 70,
      scaleOutCooldownS: 60,
      scaleInCooldownS: 120,
      warmupS: 30,
      checkIntervalS: 15,
    };
    config.autoscaling = asConfig;
    config.cluster = true;
  }

  // Instance type / machine shape
  let instanceType =
    asString(v.instance_type) ??
    asString(v.instance_class) ??
    asString(v.node_type) ??
    asString(v.machine_type) ??
    asString(v.vm_size) ??
    asString(v.sku_name) ??
    asString(v.shape_name);
  if (!instanceType && res.type === 'azurerm_linux_virtual_machine') {
    instanceType = asString(v.size);
  } else if (!instanceType && res.type === 'azurerm_linux_virtual_machine_scale_set') {
    instanceType = asString(v.sku);
  } else if (
    !instanceType &&
    (res.type === 'oci_core_instance' || res.type === 'oci_psql_db_system')
  ) {
    instanceType = asString(v.shape);
  } else if (!instanceType && isPlainObject(v.settings)) {
    instanceType = asString(v.settings.tier);
  }

  if (instanceType) {
    config.instanceType = instanceType;
    consumed.add('instance_type');
    consumed.add('instance_class');
    consumed.add('node_type');
    consumed.add('machine_type');
    consumed.add('vm_size');
    consumed.add('shape');
    consumed.add('shape_name');
  }

  // OCI flex shape_config / explicit vcpu & memory
  let resolvedSpecsFromResource = false;
  if (Array.isArray(v.shape_config) && isPlainObject(v.shape_config[0])) {
    const sc = v.shape_config[0];
    const ocpus = asNumber(sc.ocpus);
    const mem = asNumber(sc.memory_in_gbs);
    if (ocpus !== undefined && ocpus > 0) {
      config.vcpu = ocpus * 2;
      resolvedSpecsFromResource = true;
    }
    if (mem !== undefined && mem > 0) {
      config.memoryGb = mem;
      resolvedSpecsFromResource = true;
    }
  } else if (res.type === 'oci_psql_db_system') {
    const ocpus = asNumber(v.instance_ocpu_count);
    const mem = asNumber(v.instance_memory_size_in_gbs);
    if (ocpus) {
      config.vcpu = ocpus * 2;
      resolvedSpecsFromResource = true;
    }
    if (mem) {
      config.memoryGb = mem;
      resolvedSpecsFromResource = true;
    }
  }

  // Serverless / container memory & timeouts
  const lambdaMemMb = asNumber(v.memory_size) ?? asNumber(v.memory_in_mbs);
  if (lambdaMemMb !== undefined && lambdaMemMb > 0) {
    config.memoryGb = Number((lambdaMemMb / 1024).toFixed(3));
    consumed.add('memory_size');
    consumed.add('memory_in_mbs');
    resolvedSpecsFromResource = true;
  }
  const timeoutS = asNumber(v.timeout) ?? asNumber(v.timeout_seconds);
  if (timeoutS !== undefined && timeoutS > 0) {
    config.timeoutMs = Math.round(timeoutS * 1000);
    consumed.add('timeout');
    consumed.add('timeout_seconds');
  }

  // Storage
  const isStorageOrDb =
    service?.kind === 'sql' ||
    service?.kind === 'doc' ||
    service?.kind === 'kv' ||
    service?.kind === 'block' ||
    service?.kind === 'file' ||
    service?.kind === 'object';
  const allocatedStorage =
    asNumber(v.allocated_storage) ?? asNumber(v.size_in_gbs) ?? asNumber(v.size);
  if (allocatedStorage !== undefined && isStorageOrDb) {
    config.storageGb = allocatedStorage;
    consumed.add('allocated_storage');
    consumed.add('size_in_gbs');
  } else {
    const storageMb = asNumber(v.storage_mb);
    if (storageMb !== undefined && storageMb > 0) {
      config.storageGb = Math.round(storageMb / 1024);
      consumed.add('storage_mb');
    }
  }

  const redisMemGb = asNumber(v.memory_size_gb);
  if (redisMemGb !== undefined && redisMemGb > 0) {
    config.memoryGb = redisMemGb;
    consumed.add('memory_size_gb');
  }

  // Resolve curated instance specs -> vcpu / memoryGb when instanceType is specified
  let unknownInstanceType:
    | { instanceType: string; serviceId: string; provider: CloudProviderId; nodeLabel: string }
    | undefined;
  const hasInstanceDimensions =
    service?.kind === 'compute' ||
    service?.kind === 'sql' ||
    service?.kind === 'cache' ||
    service?.kind === 'olap';
  if (instanceType && hasInstanceDimensions) {
    const spec = getInstanceSpec(provider, instanceType);
    if (spec) {
      if (!resolvedSpecsFromResource) {
        config.vcpu = spec.vcpu;
        config.memoryGb = spec.memoryGb;
      }
      resolvedSpecsFromResource = true;
    } else if (!resolvedSpecsFromResource && service?.kind === 'compute') {
      unknownInstanceType = {
        instanceType,
        serviceId,
        provider,
        nodeLabel: label,
      };
    }
  }

  // Environment variables (already sanitized)
  let mockEnv: Record<string, string> | undefined;
  if (Array.isArray(v.environment) && v.environment.length > 0) {
    mockEnv = extractStringRecordEnv(v.environment[0]);
    consumed.add('environment');
  } else if (isPlainObject(v.app_settings)) {
    mockEnv = extractStringRecordEnv(v.app_settings);
    consumed.add('app_settings');
  } else if (Array.isArray(v.template) && isPlainObject(v.template[0])) {
    const tpl = v.template[0];
    if (Array.isArray(tpl.containers) && isPlainObject(tpl.containers[0])) {
      mockEnv = extractEnvArray(tpl.containers[0].env);
    } else if (Array.isArray(tpl.container) && isPlainObject(tpl.container[0])) {
      mockEnv = extractEnvArray(tpl.container[0].env);
    }
  }
  if (mockEnv) {
    config.mockEnv = mockEnv;
  }

  // AI settings
  if (
    service?.kind === 'llm' ||
    service?.kind === 'ml' ||
    service?.kind === 'text-ai' ||
    service?.kind === 'doc-ai'
  ) {
    const modelLabel =
      asString(v.model_id) ??
      (res.type === 'azurerm_cognitive_deployment' ? asString(v.name) : undefined);
    if (modelLabel) {
      config.ai = { ...(config.ai ?? {}), modelLabel };
    }
  }

  return {
    config,
    consumedKeys: consumed,
    ...(unknownInstanceType ? { unknownInstanceType } : {}),
  };
}

/** Classifies every flattened Terraform resource into group, node, networkObject, edgeSource, ignored, or unsupported. */
export function classifyTerraformResources(
  resources: NormalizedPlanResource[],
): ClassifiedResource[] {
  // Context-aware filtering: e.g. azurerm_cdn_frontdoor_endpoint is folded if profile already exists
  const resourceTypesPresent = new Set(resources.map((r) => r.type));

  return resources.map((res): ClassifiedResource => {
    const label = extractLabel(res);
    const region = extractRegion(res);
    const az = asString(res.values.availability_zone) ?? asString(res.values.zone);
    const provider = inferProviderFromTypeOrName(res);

    // Data sources are auxiliary lookups (e.g. al2023 AMI SSM parameter) unless explicitly treated otherwise
    if (res.mode === 'data') {
      return {
        resource: res,
        classification: 'ignored',
        ...(provider ? { provider } : {}),
        label,
        importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
        ignoreReason: `Data source (${res.type}) used for lookup during plan`,
      };
    }

    // 1. Groups (VPC / VNet / VCN and Subnet)
    const groupSpec = STATIC_GROUP_TYPES.get(res.type);
    if (groupSpec) {
      const cidr = extractCidr(res);
      const isPublicSubnet =
        groupSpec.kind === 'subnet'
          ? res.type === 'aws_subnet'
            ? asBool(res.values.map_public_ip_on_launch) === true
            : res.type === 'oci_core_subnet'
              ? asBool(res.values.prohibit_public_ip_on_vnic) === false
              : undefined
          : undefined;
      return {
        resource: res,
        classification: 'group',
        provider: groupSpec.provider,
        groupKind: groupSpec.kind,
        label,
        ...(region ? { region } : {}),
        ...(az ? { az } : {}),
        ...(cidr ? { cidr } : {}),
        ...(isPublicSubnet !== undefined ? { isPublicSubnet } : {}),
        importedAttrs: sanitizeImportedAttrs(res.values, new Set(['cidr_block', 'tags'])),
      };
    }

    // 2. NetworkConfig objects
    const netSpec = NETWORK_OBJECT_ROLES.get(res.type);
    if (netSpec) {
      return {
        resource: res,
        classification: 'networkObject',
        provider: netSpec.provider,
        networkRole: netSpec.role,
        label,
        ...(region ? { region } : {}),
        importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
      };
    }

    // 3. Edge inference auxiliary sources
    const edgeRole = EDGE_SOURCE_ROLES.get(res.type);
    if (edgeRole) {
      return {
        resource: res,
        classification: 'edgeSource',
        ...(provider ? { provider } : {}),
        edgeRole,
        label,
        importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
      };
    }

    // Avoid duplicating Azure Front Door profile + endpoint into two nodes
    if (
      res.type === 'azurerm_cdn_frontdoor_endpoint' &&
      resourceTypesPresent.has('azurerm_cdn_frontdoor_profile')
    ) {
      return {
        resource: res,
        classification: 'ignored',
        provider: 'azure',
        label,
        importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
        ignoreReason: 'Merged with azurerm_cdn_frontdoor_profile canvas node',
      };
    }

    // 4. Known auxiliary / ignored resources
    const ignoreReason = IGNORED_RESOURCE_TYPES.get(res.type);
    if (ignoreReason) {
      return {
        resource: res,
        classification: 'ignored',
        ...(provider ? { provider } : {}),
        label,
        importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
        ignoreReason,
      };
    }

    // 5. Mapped catalog service nodes
    const mapped = mapResourceTypeToServiceId(res);
    if (mapped) {
      const built = buildNodeConfig(res, mapped.serviceId, mapped.provider, label);
      return {
        resource: res,
        classification: 'node',
        provider: mapped.provider,
        serviceId: mapped.serviceId,
        label,
        ...(region ? { region } : {}),
        ...(az ? { az } : {}),
        nodeConfig: built.config,
        importedAttrs: sanitizeImportedAttrs(res.values, built.consumedKeys),
        ...(built.unknownInstanceType ? { unknownInstanceType: built.unknownInstanceType } : {}),
      };
    }

    // 6. Unknown / unsupported resource -> retained as neutral gray node
    return {
      resource: res,
      classification: 'unsupported',
      ...(provider ? { provider } : {}),
      serviceId: `custom.tf_${res.type}`,
      label: `${label} (${res.type})`,
      ...(region ? { region } : {}),
      ...(az ? { az } : {}),
      nodeConfig: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        operations: {},
      },
      importedAttrs: sanitizeImportedAttrs(res.values, new Set()),
    };
  });
}
