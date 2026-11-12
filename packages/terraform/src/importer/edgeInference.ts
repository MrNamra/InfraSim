import { getService } from '@infrasim/catalog';
import type { EdgeInstance, NodeInstance } from '@infrasim/shared-types';
import { snakeCaseSlug } from '../naming.js';
import type { TopologyBuildOutput } from './topology.js';
import type {
  ClassifiedResource,
  NormalizedPlanResource,
  TerraformInferredEdgeInfo,
} from './types.js';

interface EdgeSignalCandidate {
  fromNodeId: string;
  toNodeId: string;
  protocol: EdgeInstance['protocol'];
  port?: number;
  callType: 'sync' | 'async';
  tunnel?: EdgeInstance['tunnel'];
  confidence: number;
  reason: string;
}

const ASYNC_SERVICE_HINTS = [
  '.sqs',
  '.sns',
  '.kinesis',
  '.msk',
  '.eventbridge',
  '.pubsub',
  '.cloud_tasks',
  '.service_bus',
  '.event_hubs',
  '.event_grid',
  '.streaming',
  '.queue',
  '.notifications',
];

const REQUEST_HELPER_TYPES = new Set([
  'aws_lb_target_group',
  'aws_lb_listener',
  'aws_alb_listener',
  'aws_ecs_task_definition',
  'aws_launch_template',
  'aws_apigatewayv2_route',
  'aws_api_gateway_resource',
  'aws_api_gateway_method',
  'google_compute_target_http_proxy',
  'google_compute_target_https_proxy',
  'google_compute_url_map',
  'google_compute_backend_service',
  'google_compute_instance_template',
  'azurerm_service_plan',
  'oci_load_balancer_backend_set',
  'oci_load_balancer_listener',
]);

function inferProtocolFromPort(
  port: number | undefined,
  fallbackProtocol?: string,
  targetNode?: NodeInstance,
): EdgeInstance['protocol'] {
  if (port === 5432 || port === 3306 || port === 1433 || port === 1521) return 'sql';
  if (port === 6379 || port === 11211) return 'redis';
  if (port === 9092 || port === 9094) return 'kafka';
  if (port === 5672 || port === 5671) return 'amqp';
  if (port === 53) return 'dns';
  if (port === 80 || port === 8080 || port === 8000 || port === 3000 || port === 5000)
    return 'http';
  if (port === 443 || port === 8443) return 'https';

  const lowProto = fallbackProtocol?.toLowerCase() ?? '';
  if (lowProto === 'http') return 'http';
  if (lowProto === 'https') return 'https';
  if (lowProto === 'tcp' && port) return 'tcp';
  if (lowProto === 'udp') return 'udp';

  if (targetNode) {
    const svc = getService(targetNode.serviceId);
    const kind = svc?.kind;
    if (kind === 'sql') return 'sql';
    if (kind === 'cache') return 'redis';
    if (kind === 'queue' || kind === 'topic' || kind === 'bus') return 'https';
    if (kind === 'stream') return targetNode.serviceId.includes('msk') ? 'kafka' : 'https';
  }
  return 'https';
}

function defaultPortForNode(
  node: NodeInstance | undefined,
  protocol: EdgeInstance['protocol'],
): number | undefined {
  if (node) {
    const svc = getService(node.serviceId);
    if (svc?.ports && svc.ports.length > 0) {
      return svc.ports[0]!.port;
    }
  }
  switch (protocol) {
    case 'sql':
      return node?.serviceId.includes('mysql') ? 3306 : 5432;
    case 'redis':
      return 6379;
    case 'kafka':
      return 9092;
    case 'amqp':
      return 5672;
    case 'dns':
      return 53;
    case 'http':
      return 80;
    case 'https':
      return 443;
    default:
      return undefined;
  }
}

function isAsyncTargetService(serviceId: string): boolean {
  return ASYNC_SERVICE_HINTS.some((hint) => serviceId.includes(hint));
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Infers conservative directed edges solely from concrete Terraform wiring signals
 * (LB listeners/target groups, SG/NSG peer rules, runtime env refs, event subscriptions,
 * API Gateway integrations, CDN origins, DNS records, and private endpoints).
 */
export function inferTerraformEdges(
  classified: ClassifiedResource[],
  topology: TopologyBuildOutput,
): { edges: EdgeInstance[]; reportInfos: TerraformInferredEdgeInfo[] } {
  const candidates: EdgeSignalCandidate[] = [];

  const nodeForClassified = (c: ClassifiedResource): NodeInstance | undefined => {
    const id = topology.addressToEntityId.get(c.resource.address);
    return id ? topology.nodesById.get(id) : undefined;
  };

  const resolveDirectOrHelperNodes = (
    res: NormalizedPlanResource,
    attrNames?: string[],
    maxDepth = 4,
  ): NodeInstance[] => {
    const visited = new Set<string>([res.address]);
    const queue: { item: NormalizedPlanResource; depth: number; first: boolean }[] = [
      { item: res, depth: 0, first: true },
    ];
    const found = new Map<string, NodeInstance>();

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const targets = topology.resolveRefTargets(
        cur.item,
        cur.first && attrNames && attrNames.length > 0 ? attrNames : undefined,
      );
      for (const target of targets) {
        const node = nodeForClassified(target);
        if (node) {
          found.set(node.id, node);
          continue;
        }
        if (
          cur.depth < maxDepth &&
          !visited.has(target.resource.address) &&
          REQUEST_HELPER_TYPES.has(target.resource.type)
        ) {
          visited.add(target.resource.address);
          queue.push({ item: target.resource, depth: cur.depth + 1, first: false });
        }
      }
    }
    return [...found.values()];
  };

  // 1a. AWS LB Listener -> Target Group -> Attachment / ASG / ECS
  const lbByTgAddr = new Map<string, { lbNode: NodeInstance; port?: number; proto?: string }[]>();

  for (const listener of classified.filter((c) => c.edgeRole === 'lb_listener')) {
    const listenerRefs = topology.resolveRefTargets(listener.resource);
    const lbNodes = listenerRefs
      .map(nodeForClassified)
      .filter((n): n is NodeInstance =>
        Boolean(
          n &&
          (n.serviceId === 'aws.alb' || n.serviceId === 'aws.nlb' || n.serviceId === 'aws.gwlb'),
        ),
      );
    const tgs = listenerRefs.filter((r) => r.edgeRole === 'lb_target_group');
    const port = asNumber(listener.resource.values.port);
    const proto = asString(listener.resource.values.protocol);

    for (const tg of tgs) {
      for (const lbNode of lbNodes) {
        const list = lbByTgAddr.get(tg.resource.address) ?? [];
        list.push({ lbNode, ...(port !== undefined ? { port } : {}), ...(proto ? { proto } : {}) });
        lbByTgAddr.set(tg.resource.address, list);
      }
    }
  }

  // Fallback if listener isn't explicitly present, check TG references directly against LB / compute
  for (const att of classified.filter((c) => c.edgeRole === 'lb_target_attachment')) {
    const refs = topology.resolveRefTargets(att.resource);
    const tgs = refs.filter((r) => r.edgeRole === 'lb_target_group');
    const targets = refs
      .map(nodeForClassified)
      .filter((n): n is NodeInstance =>
        Boolean(n && n.serviceId !== 'aws.alb' && n.serviceId !== 'aws.nlb'),
      );
    const overridePort = asNumber(att.resource.values.port);
    for (const tg of tgs) {
      const tgPort = overridePort ?? asNumber(tg.resource.values.port);
      const tgProto = asString(tg.resource.values.protocol);
      for (const entry of lbByTgAddr.get(tg.resource.address) ?? []) {
        for (const targetNode of targets) {
          const effPort = entry.port ?? tgPort;
          const protocol = inferProtocolFromPort(effPort, entry.proto ?? tgProto, targetNode);
          candidates.push({
            fromNodeId: entry.lbNode.id,
            toNodeId: targetNode.id,
            protocol,
            ...(effPort !== undefined ? { port: effPort } : {}),
            callType: 'sync',
            confidence: 0.96,
            reason: `Load balancer listener routes to ${targetNode.label} via target group attachment`,
          });
        }
      }
    }
  }

  // ASG & ECS references to Target Groups
  for (const item of classified.filter(
    (c) => c.resource.type === 'aws_autoscaling_group' || c.resource.type === 'aws_ecs_service',
  )) {
    const targetNode = nodeForClassified(item);
    if (!targetNode) continue;
    const refs = topology.resolveRefTargets(item.resource);
    for (const tg of refs.filter((r) => r.edgeRole === 'lb_target_group')) {
      const tgPort = asNumber(tg.resource.values.port);
      const tgProto = asString(tg.resource.values.protocol);
      for (const entry of lbByTgAddr.get(tg.resource.address) ?? []) {
        const effPort = tgPort ?? entry.port;
        candidates.push({
          fromNodeId: entry.lbNode.id,
          toNodeId: targetNode.id,
          protocol: inferProtocolFromPort(effPort, tgProto ?? entry.proto, targetNode),
          ...(effPort !== undefined ? { port: effPort } : {}),
          callType: 'sync',
          confidence: 0.95,
          reason: `Load balancer forwards requests to ${targetNode.label} target group`,
        });
      }
    }
  }

  // 1b. GCP Forwarding Rule -> Proxy -> URL Map -> Backend Service -> Compute / Cloud Run
  for (const item of classified.filter(
    (c) =>
      c.resource.type === 'google_compute_global_forwarding_rule' ||
      c.resource.type === 'google_compute_forwarding_rule',
  )) {
    const lbNode = nodeForClassified(item);
    if (!lbNode) continue;
    const backends = resolveDirectOrHelperNodes(item.resource, ['target', 'backend_service'], 5);
    const portRange = asString(item.resource.values.port_range);
    const port = portRange ? asNumber(portRange.split('-')[0]) : 443;
    for (const targetNode of backends) {
      if (targetNode.id === lbNode.id) continue;
      candidates.push({
        fromNodeId: lbNode.id,
        toNodeId: targetNode.id,
        protocol: inferProtocolFromPort(port, undefined, targetNode),
        ...(port !== undefined ? { port } : {}),
        callType: 'sync',
        confidence: 0.93,
        reason: `GCP forwarding rule backend chain points to ${targetNode.label}`,
      });
    }
  }

  // 1c. OCI Load Balancer Listener / Backend Set -> Compute
  for (const item of classified.filter(
    (c) =>
      c.resource.type === 'oci_load_balancer_listener' ||
      c.resource.type === 'oci_load_balancer_backend' ||
      c.resource.type === 'oci_load_balancer_backend_set',
  )) {
    const refs = topology.resolveRefTargets(item.resource);
    const lbNodes = refs
      .map(nodeForClassified)
      .filter((n): n is NodeInstance =>
        Boolean(n && (n.serviceId === 'oci.load_balancer' || n.serviceId === 'oci.network_lb')),
      );
    const backendNodes = resolveDirectOrHelperNodes(item.resource, undefined, 3).filter(
      (n) => n.serviceId !== 'oci.load_balancer' && n.serviceId !== 'oci.network_lb',
    );
    const port = asNumber(item.resource.values.port);
    for (const lbNode of lbNodes) {
      for (const targetNode of backendNodes) {
        candidates.push({
          fromNodeId: lbNode.id,
          toNodeId: targetNode.id,
          protocol: inferProtocolFromPort(port, undefined, targetNode),
          ...(port !== undefined ? { port } : {}),
          callType: 'sync',
          confidence: 0.93,
          reason: `OCI load balancer backend configuration targets ${targetNode.label}`,
        });
      }
    }
  }

  // 2. Firewall Rules referencing Peer Firewalls or Tags (AWS SG, OCI NSG, GCP FW tags)
  const nodeIdsByTag = new Map<string, Set<string>>();
  for (const att of topology.network.attachments) {
    for (const tag of att.tags ?? []) {
      const set = nodeIdsByTag.get(tag) ?? new Set<string>();
      set.add(att.nodeId);
      nodeIdsByTag.set(tag, set);
    }
  }

  for (const fw of topology.network.firewalls) {
    const dstNodeIds = topology.firewallIdToNodeIds.get(fw.id) ?? [];
    if (dstNodeIds.length === 0) continue;

    for (const rule of fw.rules) {
      if (rule.direction !== 'ingress' || rule.action !== 'allow') continue;

      let srcNodeIds: string[] = [];
      let signalDesc = '';

      if (rule.source && 'firewallId' in rule.source && rule.source.firewallId) {
        srcNodeIds = topology.firewallIdToNodeIds.get(rule.source.firewallId) ?? [];
        signalDesc = `Firewall ${fw.id} ingress rule allows peer group ${rule.source.firewallId}`;
      } else if (rule.source && 'tag' in rule.source && rule.source.tag) {
        srcNodeIds = [...(nodeIdsByTag.get(rule.source.tag) ?? [])];
        signalDesc = `GCP firewall allows source tag "${rule.source.tag}"`;
      }

      for (const srcId of srcNodeIds) {
        for (const dstId of dstNodeIds) {
          if (srcId === dstId) continue;
          const dstNode = topology.nodesById.get(dstId);
          const protocol = inferProtocolFromPort(rule.portFrom, rule.protocol, dstNode);
          const port = rule.portFrom ?? defaultPortForNode(dstNode, protocol);
          candidates.push({
            fromNodeId: srcId,
            toNodeId: dstId,
            protocol,
            ...(port !== undefined ? { port } : {}),
            callType: 'sync',
            confidence: 0.9,
            reason: port ? `${signalDesc} on port ${port}` : signalDesc,
          });
        }
      }
    }
  }

  // 3. Lambda / Container / App Service Environment Variable References
  for (const item of classified.filter((c) => c.classification === 'node')) {
    const callerNode = nodeForClassified(item);
    if (!callerNode) continue;

    const refSources: NormalizedPlanResource[] = [item.resource];
    if (item.resource.type === 'aws_ecs_service') {
      for (const t of topology.resolveRefTargets(item.resource, ['task_definition'])) {
        if (t.resource.type === 'aws_ecs_task_definition') {
          refSources.push(t.resource);
        }
      }
    }

    for (const refSrc of refSources) {
      for (const [attrPath, refs] of Object.entries(refSrc.referencesByAttr)) {
        const lower = attrPath.toLowerCase();
        const isEnvAttr =
          lower.includes('environment') ||
          lower.includes('app_settings') ||
          lower.includes('container_definitions') ||
          lower.endsWith('.env') ||
          lower.includes('.env.');
        if (!isEnvAttr) continue;

        for (const rawRef of refs) {
          // Only look at attributes matching this env entry directly
          for (const target of topology.resolveRefTargets(
            {
              ...refSrc,
              referencesByAttr: { _hit: [rawRef] },
              allReferences: [rawRef],
            },
            ['_hit'],
          )) {
            const targetNode = nodeForClassified(target);
            if (!targetNode || targetNode.id === callerNode.id) continue;
            const asyncCall = isAsyncTargetService(targetNode.serviceId);
            const protocol = inferProtocolFromPort(undefined, undefined, targetNode);
            const port = defaultPortForNode(targetNode, protocol);
            candidates.push({
              fromNodeId: callerNode.id,
              toNodeId: targetNode.id,
              protocol,
              ...(port !== undefined ? { port } : {}),
              callType: asyncCall ? 'async' : 'sync',
              confidence: 0.88,
              reason: `Environment variable on ${callerNode.label} references ${targetNode.label}`,
            });
          }
        }
      }
    }
  }

  // 4. Async Event Source Mappings / Subscriptions / Bucket Notifications / PubSub
  for (const item of classified.filter((c) => c.edgeRole === 'event_source_mapping')) {
    const srcNodes = resolveDirectOrHelperNodes(item.resource, ['event_source_arn'], 1);
    const fnNodes = resolveDirectOrHelperNodes(item.resource, ['function_name'], 1);
    for (const src of srcNodes) {
      for (const fn of fnNodes) {
        if (src.id === fn.id) continue;
        candidates.push({
          fromNodeId: src.id,
          toNodeId: fn.id,
          protocol: 'https',
          port: 443,
          callType: 'async',
          confidence: 0.96,
          reason: `Lambda event source mapping triggers ${fn.label} from ${src.label}`,
        });
      }
    }
  }

  for (const item of classified.filter((c) => c.edgeRole === 'sns_subscription')) {
    const topicNodes = resolveDirectOrHelperNodes(item.resource, ['topic_arn'], 1);
    const subNodes = resolveDirectOrHelperNodes(item.resource, ['endpoint'], 1);
    for (const topic of topicNodes) {
      for (const sub of subNodes) {
        if (topic.id === sub.id) continue;
        candidates.push({
          fromNodeId: topic.id,
          toNodeId: sub.id,
          protocol: 'https',
          port: 443,
          callType: 'async',
          confidence: 0.96,
          reason: `SNS subscription pushes messages from ${topic.label} to ${sub.label}`,
        });
      }
    }
  }

  for (const item of classified.filter((c) => c.edgeRole === 's3_notification')) {
    const bucketNodes = resolveDirectOrHelperNodes(item.resource, ['bucket'], 1);
    const allTargets = resolveDirectOrHelperNodes(item.resource, undefined, 1);
    const bucketIds = new Set(bucketNodes.map((b) => b.id));
    for (const bucket of bucketNodes) {
      for (const dest of allTargets) {
        if (bucketIds.has(dest.id)) continue;
        candidates.push({
          fromNodeId: bucket.id,
          toNodeId: dest.id,
          protocol: 'https',
          port: 443,
          callType: 'async',
          confidence: 0.95,
          reason: `S3 bucket notification delivers events from ${bucket.label} to ${dest.label}`,
        });
      }
    }
  }

  for (const item of classified.filter((c) => c.edgeRole === 'pubsub_subscription')) {
    const topicNodes = resolveDirectOrHelperNodes(item.resource, ['topic'], 1);
    const allTargets = resolveDirectOrHelperNodes(item.resource, undefined, 2);
    const topicIds = new Set(topicNodes.map((t) => t.id));
    for (const topic of topicNodes) {
      for (const dest of allTargets) {
        if (topicIds.has(dest.id)) continue;
        candidates.push({
          fromNodeId: topic.id,
          toNodeId: dest.id,
          protocol: 'https',
          port: 443,
          callType: 'async',
          confidence: 0.94,
          reason: `Pub/Sub subscription delivers messages from ${topic.label} to ${dest.label}`,
        });
      }
    }
  }

  // 5. API Gateway Integration -> Lambda / LB
  for (const item of classified.filter((c) => c.edgeRole === 'apigw_integration')) {
    const apiNodes = resolveDirectOrHelperNodes(item.resource, ['api_id', 'rest_api_id'], 1);
    const integrationTargets = resolveDirectOrHelperNodes(
      item.resource,
      ['integration_uri', 'uri', 'connection_id'],
      2,
    );
    // If integration references an LB listener, resolve its parent LB node
    for (const refRes of topology.resolveRefTargets(item.resource, ['integration_uri', 'uri'])) {
      if (refRes.edgeRole === 'lb_listener') {
        for (const lTarget of topology.resolveRefTargets(refRes.resource, ['load_balancer_arn'])) {
          const lbNode = nodeForClassified(lTarget);
          if (lbNode && !integrationTargets.some((n) => n.id === lbNode.id)) {
            integrationTargets.push(lbNode);
          }
        }
      }
    }
    const apiIds = new Set(apiNodes.map((a) => a.id));
    for (const api of apiNodes) {
      for (const target of integrationTargets) {
        if (apiIds.has(target.id)) continue;
        const protocol = inferProtocolFromPort(443, undefined, target);
        candidates.push({
          fromNodeId: api.id,
          toNodeId: target.id,
          protocol,
          port: defaultPortForNode(target, protocol) ?? 443,
          callType: 'sync',
          confidence: 0.95,
          reason: `API Gateway integration routes requests to ${target.label}`,
        });
      }
    }
  }

  // 6. CloudFront / Front Door Origins
  for (const item of classified.filter(
    (c) =>
      c.resource.type === 'aws_cloudfront_distribution' ||
      c.resource.type === 'azurerm_cdn_frontdoor_profile' ||
      c.resource.type === 'azurerm_cdn_frontdoor_origin',
  )) {
    const cdnNode =
      item.resource.type === 'azurerm_cdn_frontdoor_origin'
        ? resolveDirectOrHelperNodes(
            item.resource,
            ['cdn_frontdoor_origin_group_id', 'cdn_frontdoor_profile_id'],
            2,
          ).find((n) => n.serviceId === 'azure.front_door')
        : nodeForClassified(item);
    if (!cdnNode) continue;

    const originRefs = Object.entries(item.resource.referencesByAttr)
      .filter(([k]) => k.includes('origin') || k.includes('host_name') || k.includes('domain_name'))
      .flatMap(([, list]) => list);
    const refsToInspect = originRefs.length > 0 ? originRefs : item.resource.allReferences;
    const originTargets = topology.resolveRefTargets(
      {
        ...item.resource,
        referencesByAttr: { _origin: refsToInspect },
        allReferences: refsToInspect,
      },
      ['_origin'],
    );

    for (const t of originTargets) {
      const originNode = nodeForClassified(t);
      if (!originNode || originNode.id === cdnNode.id) continue;
      candidates.push({
        fromNodeId: cdnNode.id,
        toNodeId: originNode.id,
        protocol: 'https',
        port: 443,
        callType: 'sync',
        confidence: 0.94,
        reason: `CDN origin configuration points to ${originNode.label}`,
      });
    }
  }

  // 7. DNS Records Alias Target -> DNS -> Target
  for (const item of classified.filter((c) => c.edgeRole === 'dns_record')) {
    const zoneNodes = resolveDirectOrHelperNodes(item.resource, ['zone_id', 'managed_zone'], 1);
    const allTargets = resolveDirectOrHelperNodes(item.resource, undefined, 1);
    const zoneIds = new Set(zoneNodes.map((z) => z.id));
    for (const dnsNode of zoneNodes) {
      for (const target of allTargets) {
        if (zoneIds.has(target.id)) continue;
        candidates.push({
          fromNodeId: dnsNode.id,
          toNodeId: target.id,
          protocol: 'https',
          port: 443,
          callType: 'sync',
          confidence: 0.94,
          reason: `DNS record routes queries to ${target.label}`,
        });
      }
    }
  }

  // 8. Private Endpoints (consumer subnet -> concrete referenced service target)
  for (const item of classified.filter((c) => c.networkRole === 'endpoint')) {
    const epTargets = resolveDirectOrHelperNodes(
      item.resource,
      ['private_service_connection', 'private_connection_resource_id'],
      2,
    );
    const allRefNodes = resolveDirectOrHelperNodes(item.resource, undefined, 2);
    const targetServiceNodes = epTargets.length > 0 ? epTargets : allRefNodes;
    if (targetServiceNodes.length === 0) {
      // Check if an explicit AWS service name matches a bucket/service node AND consumer exists in endpoint subnet
      const svcName = asString(item.resource.values.service_name) ?? '';
      if (svcName.endsWith('.s3')) {
        targetServiceNodes.push(...topology.nodes.filter((n) => n.serviceId === 'aws.s3'));
      } else if (svcName.endsWith('.dynamodb')) {
        targetServiceNodes.push(...topology.nodes.filter((n) => n.serviceId === 'aws.dynamodb'));
      }
    }
    if (targetServiceNodes.length === 0) continue;

    const epRefs = topology.resolveRefTargets(item.resource, ['subnet_ids', 'subnet_id']);
    const epSubnetIds = new Set(
      epRefs
        .map((r) => topology.addressToEntityId.get(r.resource.address))
        .filter((id): id is string => Boolean(id)),
    );
    const consumerNodes = topology.nodes.filter(
      (n) => n.parentGroupId && epSubnetIds.has(n.parentGroupId),
    );
    for (const consumer of consumerNodes) {
      for (const target of targetServiceNodes) {
        if (consumer.id === target.id) continue;
        candidates.push({
          fromNodeId: consumer.id,
          toNodeId: target.id,
          protocol: 'https',
          port: 443,
          callType: 'sync',
          tunnel: 'privatelink',
          confidence: 0.85,
          reason: `Private endpoint connects consumer subnet to ${target.label}`,
        });
      }
    }
  }

  // Deduplicate by (fromNodeId, toNodeId) keeping highest confidence
  const deduped = new Map<string, EdgeSignalCandidate>();
  for (const cand of candidates) {
    const key = `${cand.fromNodeId}::${cand.toNodeId}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, cand);
    } else {
      const winner = cand.confidence >= existing.confidence ? cand : existing;
      deduped.set(key, {
        ...winner,
        ...(existing.tunnel || cand.tunnel ? { tunnel: cand.tunnel ?? existing.tunnel } : {}),
        ...(existing.port !== undefined || cand.port !== undefined
          ? { port: winner.port ?? existing.port ?? cand.port }
          : {}),
      });
    }
  }

  const sortedCandidates = [...deduped.values()].sort((a, b) => {
    const c1 = a.fromNodeId.localeCompare(b.fromNodeId);
    return c1 !== 0 ? c1 : a.toNodeId.localeCompare(b.toNodeId);
  });

  const usedEdgeIds = new Set<string>();
  const edges: EdgeInstance[] = [];
  const reportInfos: TerraformInferredEdgeInfo[] = [];

  for (const cand of sortedCandidates) {
    const fromNode = topology.nodesById.get(cand.fromNodeId);
    const toNode = topology.nodesById.get(cand.toNodeId);
    if (!fromNode || !toNode) continue;

    const baseId = `edge-${snakeCaseSlug(fromNode.label, 'src')}_to_${snakeCaseSlug(toNode.label, 'dst')}`;
    let edgeId = baseId;
    let suffix = 2;
    while (usedEdgeIds.has(edgeId)) {
      edgeId = `${baseId}_${suffix}`;
      suffix++;
    }
    usedEdgeIds.add(edgeId);

    const edge: EdgeInstance = {
      id: edgeId,
      from: cand.fromNodeId,
      to: cand.toNodeId,
      callType: cand.callType,
      protocol: cand.protocol,
      ...(cand.port !== undefined ? { port: cand.port } : {}),
      weight: 1,
      ...(cand.tunnel ? { tunnel: cand.tunnel } : {}),
      inferred: true,
      confidence: Number(cand.confidence.toFixed(2)),
      reason: cand.reason,
    };
    edges.push(edge);
    reportInfos.push({
      edgeId,
      fromNodeId: cand.fromNodeId,
      toNodeId: cand.toNodeId,
      fromLabel: fromNode.label,
      toLabel: toNode.label,
      protocol: cand.protocol,
      ...(cand.port !== undefined ? { port: cand.port } : {}),
      callType: cand.callType,
      confidence: edge.confidence!,
      reason: cand.reason,
    });
  }

  return { edges, reportInfos };
}
