import type {
  EdgeInstance,
  GroupInstance,
  NodeInstance,
  ServiceDefinition,
} from '@infrasim/shared-types';
import {
  hclAttr,
  hclBlock,
  hclBlockStmt,
  hclCommentStmt,
  hclList,
  hclLit,
  hclRaw,
  hclRef,
} from '../hcl/ast.js';
import { isSecretKeyName, snakeCaseSlug } from '../naming.js';
import type { HclExpr } from '../types.js';
import type { TerraformExportContext } from './types.js';

const INTERNET_CALLERS = new Set(['generic.client', 'generic.users', 'gcp.cloud_cdn']);
const PUBLIC_ENTRY_GCP = new Set([
  'gcp.lb_https',
  'gcp.lb_network',
  'gcp.api_gateway',
  'gcp.cloud_armor',
]);
const VPC_HOSTED_GCP = new Set([
  'gcp.compute_engine',
  'gcp.gke',
  'gcp.lb_internal',
  'gcp.cloud_sql_postgres',
  'gcp.cloud_sql_mysql',
  'gcp.alloydb',
  'gcp.memorystore_redis',
  'gcp.memorystore_memcached',
  'gcp.cloud_nat',
  'gcp.filestore',
]);

function inferGcpEdgeTransport(
  edge: EdgeInstance,
  targetNode: NodeInstance | undefined,
  targetService: ServiceDefinition | undefined,
): { protocol: 'tcp' | 'udp'; port: number } {
  if (edge.port !== undefined && Number.isFinite(edge.port) && edge.port > 0) {
    return { protocol: edge.protocol === 'udp' ? 'udp' : 'tcp', port: Math.round(edge.port) };
  }
  if (targetService?.ports && targetService.ports.length > 0) {
    const p = targetService.ports[0]!;
    return { protocol: p.protocol === 'udp' ? 'udp' : 'tcp', port: p.port };
  }
  switch (edge.protocol) {
    case 'http':
      return { protocol: 'tcp', port: 80 };
    case 'sql':
      return { protocol: 'tcp', port: targetNode?.serviceId.includes('mysql') ? 3306 : 5432 };
    case 'redis':
      return { protocol: 'tcp', port: 6379 };
    default:
      return { protocol: 'tcp', port: 443 };
  }
}

function gcpEnvEntries(
  ctx: TerraformExportContext,
  node: NodeInstance,
  scopeSlug: string,
): Array<[string, HclExpr]> {
  const merged: Record<string, string> = {};
  const script = node.config.scriptId
    ? ctx.design.scripts.find((s) => s.id === node.config.scriptId)
    : undefined;
  if (script?.env) Object.assign(merged, script.env);
  if (node.config.mockEnv) Object.assign(merged, node.config.mockEnv);
  return Object.entries(merged)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      if (isSecretKeyName(k)) {
        const varName = ctx.addVariable({
          name: `${scopeSlug}_env_${snakeCaseSlug(k, 'secret')}`,
          type: 'string',
          sensitive: true,
          description: `Sensitive environment value for ${node.label} (${k}).`,
        });
        return [k, hclRef(`var.${varName}`)];
      }
      return [k, hclLit(v)];
    });
}

function commentIf(ctx: TerraformExportContext, lines: string[]): { comments?: string[] } {
  return ctx.includeComments ? { comments: lines } : {};
}

/** Exports the Google Cloud subset of a Design into `ctx.buckets`. */
export function mapGcpToTerraform(ctx: TerraformExportContext): void {
  const { design, allocator, network, buckets } = ctx;

  const gcpNodes = [...design.nodes]
    .filter((n) => n.serviceId.startsWith('gcp.'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const gcpNetworks = [...network.networks]
    .filter((n) => n.provider === 'gcp')
    .sort((a, b) => a.id.localeCompare(b.id));

  const gcpVpcGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'vpc' &&
        (g.provider === 'gcp' || (!g.provider && design.settings.primaryProvider === 'gcp')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const gcpSubnetGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'subnet' &&
        (g.provider === 'gcp' || (!g.provider && design.settings.primaryProvider === 'gcp')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const gcpNetworkIds = new Set(gcpNetworks.map((n) => n.id));
  const gcpSubnets = [...network.subnets]
    .filter((s) => gcpNetworkIds.has(s.networkId))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (
    gcpNodes.length === 0 &&
    gcpNetworks.length === 0 &&
    gcpVpcGroups.length === 0 &&
    gcpSubnetGroups.length === 0
  ) {
    return;
  }

  const gcpProjectVar = ctx.addVariable({
    name: 'gcp_project_id',
    type: 'string',
    description: 'TODO: GCP project ID where resources will be created.',
  });
  const gcpRegionVar = ctx.addVariable({
    name: 'gcp_region',
    type: 'string',
    defaultValue: ctx.regions.gcp,
    description: 'Default Google Cloud region.',
  });

  buckets.providers.push(
    hclBlockStmt(
      hclBlock('provider', {
        labels: ['google'],
        ...commentIf(ctx, ['Google Cloud provider (authenticate via ADC or GOOGLE_CREDENTIALS).']),
        attributes: [
          hclAttr('project', hclRef(`var.${gcpProjectVar}`)),
          hclAttr('region', hclRef(`var.${gcpRegionVar}`)),
        ],
      }),
    ),
  );

  allocator.preallocate([
    ...gcpVpcGroups.map((g) => ({
      scope: 'gcp_vpc',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'main',
    })),
    ...gcpNetworks.map((n) => ({
      scope: 'gcp_vpc',
      entityId: n.id,
      rawLabel: n.name || 'main',
      fallback: 'main',
    })),
    ...gcpSubnetGroups.map((g) => ({
      scope: 'gcp_subnet',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'subnet',
    })),
    ...gcpSubnets.map((s) => ({
      scope: 'gcp_subnet',
      entityId: s.id,
      rawLabel: s.id.replace(/^sub-/, ''),
      fallback: 'subnet',
    })),
    ...gcpNodes.map((n) => ({
      scope: 'gcp_node',
      entityId: n.id,
      rawLabel: n.label,
      fallback: snakeCaseSlug(n.serviceId.replace(/^gcp\./, ''), 'service'),
    })),
  ]);

  const vpcRefByNetworkId = new Map<string, string>();
  const vpcRefByGroupId = new Map<string, string>();
  const subnetRefByGroupId = new Map<string, string>();
  const subnetRefBySubnetId = new Map<string, string>();
  const emittedVpcs = new Set<string>();
  const emittedSubnets = new Set<string>();
  const allVpcRefs: string[] = [];
  const allSubnetRefs: string[] = [];

  for (const netObj of gcpNetworks) {
    const groupId = netObj.id.startsWith('net-') ? netObj.id.slice(4) : netObj.id;
    const matchedGroup = gcpVpcGroups.find((g) => g.id === groupId);
    const vpcName = allocator.allocate(
      'gcp_vpc',
      matchedGroup ? matchedGroup.id : netObj.id,
      netObj.name || matchedGroup?.label || 'main',
      'main',
    );
    vpcRefByNetworkId.set(netObj.id, vpcName);
    if (matchedGroup) {
      vpcRefByGroupId.set(matchedGroup.id, vpcName);
      ctx.recordAddress(matchedGroup.id, `google_compute_network.${vpcName}`);
    }
    if (!emittedVpcs.has(vpcName)) {
      emittedVpcs.add(vpcName);
      allVpcRefs.push(vpcName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['google_compute_network', vpcName],
            ...commentIf(ctx, [`Global GCP VPC Network: ${netObj.name || vpcName}`]),
            attributes: [
              hclAttr('name', hclRaw(`"\${var.name_prefix}-${vpcName}"`)),
              hclAttr('auto_create_subnetworks', hclLit(false)),
            ],
          }),
        ),
      );
    }
  }

  for (const g of gcpVpcGroups) {
    if (vpcRefByGroupId.has(g.id)) continue;
    const vpcName = allocator.allocate('gcp_vpc', g.id, g.label, 'main');
    vpcRefByGroupId.set(g.id, vpcName);
    ctx.recordAddress(g.id, `google_compute_network.${vpcName}`);
    if (!emittedVpcs.has(vpcName)) {
      emittedVpcs.add(vpcName);
      allVpcRefs.push(vpcName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['google_compute_network', vpcName],
            attributes: [
              hclAttr('name', hclRaw(`"\${var.name_prefix}-${vpcName}"`)),
              hclAttr('auto_create_subnetworks', hclLit(false)),
            ],
          }),
        ),
      );
    }
  }

  const needsImplicitVpc =
    allVpcRefs.length === 0 && gcpNodes.some((n) => VPC_HOSTED_GCP.has(n.serviceId));
  if (needsImplicitVpc) {
    const vpcName = allocator.allocate('gcp_vpc', '__implicit_gcp_vpc__', 'main', 'main');
    allVpcRefs.push(vpcName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['google_compute_network', vpcName],
          ...commentIf(ctx, [
            'Synthesized GCP VPC network for regional subnets and firewall rules.',
          ]),
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${vpcName}"`)),
            hclAttr('auto_create_subnetworks', hclLit(false)),
          ],
        }),
      ),
    );
    const subName = allocator.allocate('gcp_subnet', '__implicit_gcp_sub__', 'primary', 'primary');
    allSubnetRefs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['google_compute_subnetwork', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('ip_cidr_range', hclLit('10.10.0.0/20')),
            hclAttr('region', hclRef(`var.${gcpRegionVar}`)),
            hclAttr('network', hclRef(`google_compute_network.${vpcName}.id`)),
          ],
        }),
      ),
    );
  }

  const defaultVpcRef = allVpcRefs[0] ?? null;

  for (const sub of gcpSubnets) {
    const groupId = sub.id.startsWith('sub-') ? sub.id.slice(4) : sub.id;
    const matched = gcpSubnetGroups.find((g) => g.id === groupId);
    const subName = allocator.allocate(
      'gcp_subnet',
      matched ? matched.id : sub.id,
      matched?.label ?? sub.id.replace(/^sub-/, ''),
      'subnet',
    );
    const vpcRef = vpcRefByNetworkId.get(sub.networkId) ?? defaultVpcRef;
    subnetRefBySubnetId.set(sub.id, subName);
    if (matched) {
      subnetRefByGroupId.set(matched.id, subName);
      ctx.recordAddress(matched.id, `google_compute_subnetwork.${subName}`);
    }
    if (!vpcRef || emittedSubnets.has(subName)) continue;
    emittedSubnets.add(subName);
    allSubnetRefs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['google_compute_subnetwork', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('ip_cidr_range', hclLit(sub.cidr)),
            hclAttr('region', hclLit(matched?.region || ctx.regions.gcp)),
            hclAttr('network', hclRef(`google_compute_network.${vpcRef}.id`)),
          ],
        }),
      ),
    );
  }

  const resolveVpcForGroup = (g: GroupInstance): string | null => {
    let cur: GroupInstance | undefined = g;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === 'vpc' && vpcRefByGroupId.has(cur.id)) {
        return vpcRefByGroupId.get(cur.id)!;
      }
      cur = cur.parentGroupId ? ctx.groupsById.get(cur.parentGroupId) : undefined;
    }
    return defaultVpcRef;
  };

  for (const subGroup of gcpSubnetGroups) {
    if (subnetRefByGroupId.has(subGroup.id)) continue;
    const subName = allocator.allocate('gcp_subnet', subGroup.id, subGroup.label, 'subnet');
    subnetRefByGroupId.set(subGroup.id, subName);
    ctx.recordAddress(subGroup.id, `google_compute_subnetwork.${subName}`);
    const vpcRef = resolveVpcForGroup(subGroup);
    if (!vpcRef || emittedSubnets.has(subName)) continue;
    emittedSubnets.add(subName);
    allSubnetRefs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['google_compute_subnetwork', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('ip_cidr_range', hclLit(subGroup.cidr?.trim() || '10.10.1.0/24')),
            hclAttr('region', hclLit(subGroup.region || ctx.regions.gcp)),
            hclAttr('network', hclRef(`google_compute_network.${vpcRef}.id`)),
          ],
        }),
      ),
    );
  }

  const defaultSubRef = allSubnetRefs[0] ?? null;

  const nodeTfName = new Map<string, string>();
  const nodeTagMap = new Map<string, string>();
  const nodeSubMap = new Map<string, string>();
  const nodeVpcMap = new Map<string, string>();
  for (const node of gcpNodes) {
    const tfName = allocator.allocate(
      'gcp_node',
      node.id,
      node.label,
      snakeCaseSlug(node.serviceId.replace(/^gcp\./, ''), 'service'),
    );
    nodeTfName.set(node.id, tfName);
    nodeTagMap.set(node.id, `svc-${tfName}`);
    const anc = ctx.resolveNodeAncestry(node);
    const attachedSubId = network.attachments.find((a) => a.nodeId === node.id)?.subnetId;
    const subRef =
      (anc.subnetGroup ? subnetRefByGroupId.get(anc.subnetGroup.id) : undefined) ??
      (attachedSubId ? subnetRefBySubnetId.get(attachedSubId) : undefined) ??
      defaultSubRef;
    const vpcRef =
      (anc.vpcGroup ? vpcRefByGroupId.get(anc.vpcGroup.id) : undefined) ?? defaultVpcRef;
    if (subRef) nodeSubMap.set(node.id, subRef);
    if (vpcRef) nodeVpcMap.set(node.id, vpcRef);
  }

  // Emit GCP firewall rules driven by explicit gcp-fw objects and canvas edges
  const sortedEdges = [...design.edges].sort((a, b) => a.id.localeCompare(b.id));
  const emittedFwSigs = new Set<string>();
  for (const edge of sortedEdges) {
    const fromNode = ctx.nodesById.get(edge.from);
    const toNode = ctx.nodesById.get(edge.to);
    if (!fromNode || !toNode || !toNode.serviceId.startsWith('gcp.')) continue;
    const vpcRef = nodeVpcMap.get(toNode.id);
    if (!vpcRef || !VPC_HOSTED_GCP.has(toNode.serviceId)) continue;
    const toTag = nodeTagMap.get(toNode.id)!;
    const transport = inferGcpEdgeTransport(edge, toNode, ctx.servicesById.get(toNode.serviceId));
    const fromTag = fromNode.serviceId.startsWith('gcp.') ? nodeTagMap.get(fromNode.id) : undefined;
    const isFromInternet =
      INTERNET_CALLERS.has(fromNode.serviceId) || PUBLIC_ENTRY_GCP.has(toNode.serviceId);
    if (!fromTag && !isFromInternet) continue;

    const sig = `${vpcRef}|${toTag}|${fromTag ?? 'internet'}|${transport.protocol}|${transport.port}`;
    if (emittedFwSigs.has(sig)) continue;
    emittedFwSigs.add(sig);

    const fwName = allocator.allocate(
      'gcp_fw',
      sig,
      `${nodeTfName.get(toNode.id)}_allow_${transport.port}`,
      'fw',
    );
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['google_compute_firewall', fwName],
          ...commentIf(ctx, [
            `Least-privilege firewall rule for edge ${fromNode.label} -> ${toNode.label}`,
          ]),
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${fwName.replace(/_/g, '-')}"`)),
            hclAttr('network', hclRef(`google_compute_network.${vpcRef}.id`)),
            hclAttr('direction', hclLit('INGRESS')),
            hclAttr('target_tags', hclList([hclLit(toTag)])),
            ...(fromTag
              ? [hclAttr('source_tags', hclList([hclLit(fromTag)]))]
              : [hclAttr('source_ranges', hclList([hclLit('0.0.0.0/0')]))]),
          ],
          blocks: [
            hclBlock('allow', {
              attributes: [
                hclAttr('protocol', hclLit(transport.protocol)),
                hclAttr('ports', hclList([hclLit(String(transport.port))])),
              ],
            }),
          ],
        }),
      ),
    );
  }

  for (const fw of [...network.firewalls]
    .filter((f) => f.kind === 'gcp-fw')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const netRef = defaultVpcRef;
    if (!netRef) continue;
    fw.rules.forEach((rule, idx) => {
      if (rule.direction !== 'ingress' || !rule.source) return;
      if ('cidr' in rule.source && rule.source.cidr === '10.0.0.0/16' && emittedFwSigs.size > 0) {
        return;
      }
      const fwName = allocator.allocate('gcp_fw', `${fw.id}-${idx}`, `${fw.id}_${idx}`, 'fw');
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['google_compute_firewall', fwName],
            attributes: [
              hclAttr('name', hclRaw(`"\${var.name_prefix}-${fwName.replace(/_/g, '-')}"`)),
              hclAttr('network', hclRef(`google_compute_network.${netRef}.id`)),
              ...(fw.attachedTo?.tags && fw.attachedTo.tags.length > 0
                ? [hclAttr('target_tags', hclList(fw.attachedTo.tags.map((t) => hclLit(t))))]
                : []),
              ...('cidr' in rule.source
                ? [hclAttr('source_ranges', hclList([hclLit(rule.source.cidr)]))]
                : []),
            ],
            blocks: [
              hclBlock(rule.action === 'allow' ? 'allow' : 'deny', {
                attributes: [
                  hclAttr('protocol', hclLit(rule.protocol === 'any' ? 'all' : rule.protocol)),
                  ...(rule.portFrom !== undefined
                    ? [hclAttr('ports', hclList([hclLit(String(rule.portFrom))]))]
                    : []),
                ],
              }),
            ],
          }),
        ),
      );
    });
  }

  // Emit resources for each GCP node
  for (const node of gcpNodes) {
    const name = nodeTfName.get(node.id)!;
    const tag = nodeTagMap.get(node.id)!;
    const subRef = nodeSubMap.get(node.id);
    const vpcRef = nodeVpcMap.get(node.id);
    const region = ctx.resolveNodeRegion(node, 'gcp');
    const instances = Math.max(1, Math.round(node.config.instances || 1));
    const outEdges = sortedEdges.filter((e) => e.from === node.id);

    switch (node.serviceId) {
      case 'gcp.cloud_nat': {
        if (!vpcRef) break;
        const routerName = `${name}_router`;
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_router', routerName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${routerName}"`)),
                hclAttr('region', hclLit(region)),
                hclAttr('network', hclRef(`google_compute_network.${vpcRef}.id`)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_router_nat', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('router', hclRef(`google_compute_router.${routerName}.name`)),
                hclAttr('region', hclRef(`google_compute_router.${routerName}.region`)),
                hclAttr('nat_ip_allocate_option', hclLit('AUTO_ONLY')),
                hclAttr(
                  'source_subnetwork_ip_ranges_to_nat',
                  hclLit('ALL_SUBNETWORKS_ALL_IP_RANGES'),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_compute_router_nat.${name}`);
        break;
      }

      case 'gcp.vpc_peering': {
        if (allVpcRefs.length >= 2) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_compute_network_peering', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('network', hclRef(`google_compute_network.${allVpcRefs[0]!}.self_link`)),
                  hclAttr(
                    'peer_network',
                    hclRef(`google_compute_network.${allVpcRefs[1]!}.self_link`),
                  ),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `google_compute_network_peering.${name}`);
        } else if (vpcRef) {
          const peerVar = ctx.addVariable({
            name: `${name}_peer_network`,
            type: 'string',
            description: `TODO: self_link of peer GCP VPC network for ${node.label}.`,
          });
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_compute_network_peering', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('network', hclRef(`google_compute_network.${vpcRef}.self_link`)),
                  hclAttr('peer_network', hclRef(`var.${peerVar}`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `google_compute_network_peering.${name}`);
        }
        break;
      }

      case 'gcp.cloud_dns': {
        const domainVar = ctx.addVariable({
          name: `${name}_dns_name`,
          type: 'string',
          description: `TODO: DNS domain name with trailing dot for ${node.label} (e.g. example.com.)`,
        });
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_dns_managed_zone', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('dns_name', hclRef(`var.${domainVar}`)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_dns_record_set', `${name}_a`],
              attributes: [
                hclAttr('name', hclRef(`google_dns_managed_zone.${name}.dns_name`)),
                hclAttr('type', hclLit('A')),
                hclAttr('ttl', hclLit(300)),
                hclAttr('managed_zone', hclRef(`google_dns_managed_zone.${name}.name`)),
                hclAttr('rrdatas', hclList([hclLit('203.0.113.10')])),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_dns_managed_zone.${name}`);
        break;
      }

      case 'gcp.compute_engine': {
        const machineType = node.config.instanceType || 'e2-medium';
        if (node.config.autoscaling) {
          const tplName = `${name}_template`;
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_compute_instance_template', tplName],
                attributes: [
                  hclAttr('name_prefix', hclRaw(`"\${var.name_prefix}-${name}-"`)),
                  hclAttr('machine_type', hclLit(machineType)),
                  hclAttr('tags', hclList([hclLit(tag)])),
                ],
                blocks: [
                  hclBlock('disk', {
                    attributes: [
                      hclAttr('source_image', hclLit('debian-cloud/debian-12')),
                      hclAttr('auto_delete', hclLit(true)),
                      hclAttr('boot', hclLit(true)),
                    ],
                  }),
                  hclBlock('network_interface', {
                    attributes: [
                      ...(subRef
                        ? [hclAttr('subnetwork', hclRef(`google_compute_subnetwork.${subRef}.id`))]
                        : [hclAttr('network', hclLit('default'))]),
                    ],
                  }),
                ],
              }),
            ),
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_compute_instance_group_manager', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('base_instance_name', hclLit(name)),
                  hclAttr('zone', hclLit(`${region}-a`)),
                  hclAttr('target_size', hclLit(Math.max(node.config.autoscaling.min, instances))),
                ],
                blocks: [
                  hclBlock('version', {
                    attributes: [
                      hclAttr(
                        'instance_template',
                        hclRef(`google_compute_instance_template.${tplName}.id`),
                      ),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `google_compute_instance_group_manager.${name}`);
        } else {
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_compute_instance', name],
                attributes: [
                  ...(instances > 1 ? [hclAttr('count', hclLit(instances))] : []),
                  hclAttr(
                    'name',
                    hclRaw(
                      instances > 1
                        ? `"\${var.name_prefix}-${name}-\${count.index}"`
                        : `"\${var.name_prefix}-${name}"`,
                    ),
                  ),
                  hclAttr('machine_type', hclLit(machineType)),
                  hclAttr('zone', hclLit(`${region}-a`)),
                  hclAttr('tags', hclList([hclLit(tag)])),
                ],
                blocks: [
                  hclBlock('boot_disk', {
                    blocks: [
                      hclBlock('initialize_params', {
                        attributes: [hclAttr('image', hclLit('debian-cloud/debian-12'))],
                      }),
                    ],
                  }),
                  hclBlock('network_interface', {
                    attributes: [
                      ...(subRef
                        ? [hclAttr('subnetwork', hclRef(`google_compute_subnetwork.${subRef}.id`))]
                        : [hclAttr('network', hclLit('default'))]),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `google_compute_instance.${name}`);
        }
        break;
      }

      case 'gcp.lb_https':
      case 'gcp.lb_network':
      case 'gcp.lb_internal': {
        const hcName = `${name}_hc`;
        const backendName = `${name}_backend`;
        const urlMapName = `${name}_url_map`;
        const proxyName = `${name}_proxy`;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_health_check', hcName],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${hcName}"`))],
              blocks: [
                hclBlock('http_health_check', { attributes: [hclAttr('port', hclLit(8080))] }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_backend_service', backendName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${backendName}"`)),
                hclAttr('protocol', hclLit('HTTP')),
                hclAttr(
                  'health_checks',
                  hclList([hclRef(`google_compute_health_check.${hcName}.id`)]),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_url_map', urlMapName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${urlMapName}"`)),
                hclAttr(
                  'default_service',
                  hclRef(`google_compute_backend_service.${backendName}.id`),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_target_http_proxy', proxyName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${proxyName}"`)),
                hclAttr('url_map', hclRef(`google_compute_url_map.${urlMapName}.id`)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_global_forwarding_rule', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('target', hclRef(`google_compute_target_http_proxy.${proxyName}.id`)),
                hclAttr('port_range', hclLit('80')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_compute_global_forwarding_rule.${name}`);
        ctx.addOutput({
          name: `${name}_ip_address`,
          description: `Anycast IP for ${node.label}`,
          valueRef: `google_compute_global_forwarding_rule.${name}.ip_address`,
        });
        break;
      }

      case 'gcp.cloud_run': {
        const envs = gcpEnvEntries(ctx, node, name);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_cloud_run_v2_service', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclLit(region)),
              ],
              blocks: [
                hclBlock('template', {
                  blocks: [
                    hclBlock('containers', {
                      attributes: [
                        hclAttr('image', hclLit('us-docker.pkg.dev/cloudrun/container/hello')),
                      ],
                      blocks: envs.map(([k, v]) =>
                        hclBlock('env', {
                          attributes: [hclAttr('name', hclLit(k)), hclAttr('value', v)],
                        }),
                      ),
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_cloud_run_v2_service.${name}`);
        ctx.addOutput({
          name: `${name}_uri`,
          description: `Cloud Run URL for ${node.label}`,
          valueRef: `google_cloud_run_v2_service.${name}.uri`,
        });
        break;
      }

      case 'gcp.cloud_functions': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_cloudfunctions2_function', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclLit(region)),
              ],
              blocks: [
                hclBlock('build_config', {
                  attributes: [
                    hclAttr('runtime', hclLit('nodejs20')),
                    hclAttr('entry_point', hclLit('handler')),
                  ],
                }),
                hclBlock('service_config', {
                  attributes: [
                    hclAttr(
                      'available_memory',
                      hclLit(
                        `${Math.max(128, Math.round((node.config.memoryGb ?? 0.5) * 1024))}Mi`,
                      ),
                    ),
                    hclAttr(
                      'timeout_seconds',
                      hclLit(Math.max(1, Math.round((node.config.timeoutMs ?? 60000) / 1000))),
                    ),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_cloudfunctions2_function.${name}`);
        break;
      }

      case 'gcp.gke': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_container_cluster', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclLit(region)),
                hclAttr('remove_default_node_pool', hclLit(true)),
                hclAttr('initial_node_count', hclLit(1)),
                ...(vpcRef
                  ? [hclAttr('network', hclRef(`google_compute_network.${vpcRef}.id`))]
                  : []),
                ...(subRef
                  ? [hclAttr('subnetwork', hclRef(`google_compute_subnetwork.${subRef}.id`))]
                  : []),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_container_node_pool', `${name}_nodes`],
              attributes: [
                hclAttr('name', hclLit('default-pool')),
                hclAttr('cluster', hclRef(`google_container_cluster.${name}.id`)),
                hclAttr('node_count', hclLit(instances)),
              ],
              blocks: [
                hclBlock('node_config', {
                  attributes: [
                    hclAttr('machine_type', hclLit(node.config.instanceType || 'e2-standard-2')),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_container_cluster.${name}`);
        ctx.recordAddress(node.id, `google_container_node_pool.${name}_nodes`);
        break;
      }

      case 'gcp.cloud_sql_postgres':
      case 'gcp.cloud_sql_mysql':
      case 'gcp.alloydb': {
        const isMysql = node.serviceId === 'gcp.cloud_sql_mysql';
        const passVar = ctx.addVariable({
          name: `${name}_root_password`,
          type: 'string',
          sensitive: true,
          description: `Root database password for Cloud SQL instance ${node.label}.`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_sql_database_instance', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('database_version', hclLit(isMysql ? 'MYSQL_8_0' : 'POSTGRES_16')),
                hclAttr('region', hclLit(region)),
                hclAttr('root_password', hclRef(`var.${passVar}`)),
                hclAttr('deletion_protection', hclLit(false)),
              ],
              blocks: [
                hclBlock('settings', {
                  attributes: [
                    hclAttr('tier', hclLit(node.config.instanceType || 'db-custom-2-7680')),
                  ],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_sql_database', `${name}_db`],
              attributes: [
                hclAttr('name', hclLit('app')),
                hclAttr('instance', hclRef(`google_sql_database_instance.${name}.name`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_sql_database_instance.${name}`);
        break;
      }

      case 'gcp.spanner': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_spanner_instance', name],
              attributes: [
                hclAttr('config', hclLit(`regional-${region}`)),
                hclAttr('display_name', hclLit(node.label)),
                hclAttr('processing_units', hclLit(100)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_spanner_instance.${name}`);
        break;
      }

      case 'gcp.bigtable': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_bigtable_instance', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
              blocks: [
                hclBlock('cluster', {
                  attributes: [
                    hclAttr('cluster_id', hclLit(`${name}-c1`)),
                    hclAttr('zone', hclLit(`${region}-a`)),
                    hclAttr('num_nodes', hclLit(instances)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_bigtable_instance.${name}`);
        break;
      }

      case 'gcp.firestore': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_firestore_database', name],
              attributes: [
                hclAttr('name', hclLit('(default)')),
                hclAttr('location_id', hclLit(region)),
                hclAttr('type', hclLit('FIRESTORE_NATIVE')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_firestore_database.${name}`);
        break;
      }

      case 'gcp.memorystore_redis': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_redis_instance', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('tier', hclLit(instances > 1 ? 'STANDARD_HA' : 'BASIC')),
                hclAttr(
                  'memory_size_gb',
                  hclLit(Math.max(1, Math.round(node.config.memoryGb ?? 1))),
                ),
                hclAttr('region', hclLit(region)),
                ...(vpcRef
                  ? [hclAttr('authorized_network', hclRef(`google_compute_network.${vpcRef}.id`))]
                  : []),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_redis_instance.${name}`);
        break;
      }

      case 'gcp.memorystore_memcached': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_memcache_instance', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('region', hclLit(region)),
                hclAttr('node_count', hclLit(instances)),
                ...(vpcRef
                  ? [hclAttr('authorized_network', hclRef(`google_compute_network.${vpcRef}.id`))]
                  : []),
              ],
              blocks: [
                hclBlock('node_config', {
                  attributes: [
                    hclAttr('cpu_count', hclLit(Math.max(1, Math.round(node.config.vcpu ?? 1)))),
                    hclAttr(
                      'memory_size_mb',
                      hclLit(Math.max(1024, Math.round((node.config.memoryGb ?? 1) * 1024))),
                    ),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_memcache_instance.${name}`);
        break;
      }

      case 'gcp.cloud_armor': {
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_compute_security_policy', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
              blocks: [
                hclBlock('rule', {
                  attributes: [
                    hclAttr('action', hclLit('allow')),
                    hclAttr('priority', hclLit(2147483647)),
                  ],
                  blocks: [
                    hclBlock('match', {
                      attributes: [hclAttr('versioned_expr', hclLit('SRC_IPS_V1'))],
                      blocks: [
                        hclBlock('config', {
                          attributes: [hclAttr('src_ip_ranges', hclList([hclLit('*')]))],
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_compute_security_policy.${name}`);
        break;
      }

      case 'gcp.cloud_storage':
      case 'gcp.cloud_storage_archive': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_storage_bucket', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclLit(region)),
                hclAttr('uniform_bucket_level_access', hclLit(true)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_storage_bucket.${name}`);
        break;
      }

      case 'gcp.pubsub': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_pubsub_topic', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_pubsub_topic.${name}`);
        for (const edge of outEdges) {
          const tName = nodeTfName.get(edge.to);
          if (!tName) continue;
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['google_pubsub_subscription', `${name}_to_${tName}`],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}-${tName}"`)),
                  hclAttr('topic', hclRef(`google_pubsub_topic.${name}.id`)),
                ],
              }),
            ),
          );
        }
        break;
      }

      case 'gcp.cloud_tasks': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_cloud_tasks_queue', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclLit(region)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_cloud_tasks_queue.${name}`);
        break;
      }

      case 'gcp.secret_manager': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_secret_manager_secret', name],
              attributes: [hclAttr('secret_id', hclRaw(`"\${var.name_prefix}-${name}"`))],
              blocks: [hclBlock('replication', { blocks: [hclBlock('auto')] })],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_secret_manager_secret.${name}`);
        break;
      }

      case 'gcp.bigquery': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_bigquery_dataset', name],
              attributes: [
                hclAttr('dataset_id', hclRaw(`"\${replace(var.name_prefix, "-", "_")}_${name}"`)),
                hclAttr('location', hclLit('US')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_bigquery_dataset.${name}`);
        break;
      }

      case 'gcp.vertex_endpoint':
      case 'gcp.vertex_gemini': {
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['google_vertex_ai_endpoint', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('display_name', hclLit(node.label)),
                hclAttr('location', hclLit(region)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `google_vertex_ai_endpoint.${name}`);
        break;
      }

      default: {
        buckets.compute.push(
          hclCommentStmt(`InfraSim: no Terraform mapping for ${node.serviceId} (${node.label})`),
        );
        ctx.addUnsupported(node, `No v1 GCP Terraform resource mapping for ${node.serviceId}`);
        break;
      }
    }
  }
}
