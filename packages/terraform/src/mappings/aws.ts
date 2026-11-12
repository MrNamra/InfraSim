import type {
  EdgeInstance,
  FirewallRule,
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
  hclMap,
  hclRaw,
  hclRef,
} from '../hcl/ast.js';
import { isSecretKeyName, snakeCaseSlug } from '../naming.js';
import type { HclAttribute, HclExpr, HclStatement } from '../types.js';
import type { TerraformExportContext } from './types.js';

const INTERNET_CALLER_SERVICES = new Set(['generic.client', 'generic.users', 'aws.igw']);
const PUBLIC_ENTRY_SERVICES = new Set([
  'aws.alb',
  'aws.nlb',
  'aws.gwlb',
  'aws.apigw_http',
  'aws.apigw_rest',
  'aws.cloudfront',
  'aws.waf',
  'aws.global_accelerator',
]);

const VPC_HOSTED_AWS_SERVICES = new Set([
  'aws.ec2',
  'aws.alb',
  'aws.nlb',
  'aws.gwlb',
  'aws.fargate',
  'aws.ecs_ec2',
  'aws.eks',
  'aws.rds_postgres',
  'aws.rds_mysql',
  'aws.rds_proxy',
  'aws.aurora_pg',
  'aws.aurora_mysql',
  'aws.aurora_serverless',
  'aws.elasticache_redis',
  'aws.elasticache_memcached',
  'aws.memorydb',
  'aws.documentdb',
  'aws.neptune',
  'aws.opensearch',
  'aws.msk',
  'aws.efs',
  'aws.nat_gw',
  'aws.privatelink',
]);

function envBlockEntries(
  ctx: TerraformExportContext,
  node: NodeInstance,
  scopeSlug: string,
): Array<[string, HclExpr]> {
  const mergedEnv: Record<string, string> = {};
  const script = node.config.scriptId
    ? ctx.design.scripts.find((s) => s.id === node.config.scriptId)
    : undefined;
  if (script?.env) {
    Object.assign(mergedEnv, script.env);
  }
  if (node.config.mockEnv) {
    Object.assign(mergedEnv, node.config.mockEnv);
  }

  return Object.entries(mergedEnv)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (isSecretKeyName(key)) {
        const varName = ctx.addVariable({
          name: `${scopeSlug}_env_${snakeCaseSlug(key, 'secret')}`,
          type: 'string',
          sensitive: true,
          description: `Secret value for ${node.label} environment variable ${key}`,
          comment:
            'Provide via TF_VAR_* or secrets manager; InfraSim never stores secret literals.',
        });
        return [key, hclRef(`var.${varName}`)];
      }
      return [key, hclLit(value)];
    });
}

function inferAwsEdgeTransport(
  edge: EdgeInstance,
  targetNode: NodeInstance | undefined,
  targetService: ServiceDefinition | undefined,
): { protocol: 'tcp' | 'udp' | 'icmp' | '-1'; port: number } {
  if (edge.port !== undefined && Number.isFinite(edge.port) && edge.port > 0) {
    const proto = edge.protocol === 'udp' ? 'udp' : 'tcp';
    return { protocol: proto, port: Math.round(edge.port) };
  }
  if (targetNode?.config.listeningPorts && targetNode.config.listeningPorts.length > 0) {
    const first = targetNode.config.listeningPorts[0]!;
    return {
      protocol: first.protocol === 'udp' ? 'udp' : 'tcp',
      port: first.port,
    };
  }
  if (targetService?.ports && targetService.ports.length > 0) {
    const first = targetService.ports[0]!;
    return {
      protocol: first.protocol === 'udp' ? 'udp' : 'tcp',
      port: first.port,
    };
  }
  switch (edge.protocol) {
    case 'http':
      return { protocol: 'tcp', port: 80 };
    case 'sql':
      if (targetNode?.serviceId.includes('mysql')) return { protocol: 'tcp', port: 3306 };
      return { protocol: 'tcp', port: 5432 };
    case 'redis':
      return { protocol: 'tcp', port: 6379 };
    case 'dns':
      return { protocol: 'udp', port: 53 };
    case 'kafka':
      return { protocol: 'tcp', port: 9092 };
    case 'amqp':
      return { protocol: 'tcp', port: 5672 };
    default:
      return { protocol: 'tcp', port: 443 };
  }
}

function toAwsIpProtocol(protocol: FirewallRule['protocol']): 'tcp' | 'udp' | 'icmp' | '-1' {
  switch (protocol) {
    case 'tcp':
      return 'tcp';
    case 'udp':
      return 'udp';
    case 'icmp':
      return 'icmp';
    case 'any':
      return '-1';
  }
}

function commentIf(ctx: TerraformExportContext, lines: string[]): { comments?: string[] } {
  return ctx.includeComments ? { comments: lines } : {};
}

interface AwsNetworkMapState {
  vpcRefByGroupId: Map<string, string>;
  vpcRefByNetworkId: Map<string, string>;
  subnetRefByGroupId: Map<string, string>;
  subnetRefBySubnetId: Map<string, string>;
  subnetVpcRefBySubnetTfName: Map<string, string>;
  allVpcRefs: string[];
  defaultVpcRef: string | null;
  defaultPublicSubnetRefs: string[];
  defaultPrivateSubnetRefs: string[];
  sgNameByFirewallId: Map<string, string>;
  sgNameByNodeId: Map<string, string>;
  nodeVpcRef: Map<string, string>;
  nodeSubnetRef: Map<string, string>;
}

/** Exports the AWS subset of a Design into `ctx.buckets`. */
export function mapAwsToTerraform(ctx: TerraformExportContext): void {
  const { design, allocator, network, buckets } = ctx;

  const awsNodes = [...design.nodes]
    .filter((n) => n.serviceId.startsWith('aws.'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const awsVpcGroups = [...design.groups]
    .filter((g) => g.kind === 'vpc' && (!g.provider || g.provider === 'aws'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const awsNetworks = [...network.networks]
    .filter((n) => n.provider === 'aws')
    .sort((a, b) => a.id.localeCompare(b.id));

  const awsSubnetGroups = [...design.groups]
    .filter((g) => {
      if (g.kind !== 'subnet') return false;
      if (g.provider && g.provider !== 'aws') return false;
      if (g.parentGroupId) {
        const parent = ctx.groupsById.get(g.parentGroupId);
        if (parent?.provider && parent.provider !== 'aws') return false;
      }
      return (
        design.settings.primaryProvider === 'aws' || awsNodes.length > 0 || g.provider === 'aws'
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const awsNetworkIds = new Set(awsNetworks.map((n) => n.id));
  const awsSubnets = [...network.subnets]
    .filter((s) => awsNetworkIds.has(s.networkId))
    .sort((a, b) => a.id.localeCompare(b.id));

  const needsImplicitVpc =
    awsVpcGroups.length === 0 &&
    awsNetworks.length === 0 &&
    awsNodes.some((n) => VPC_HOSTED_AWS_SERVICES.has(n.serviceId));

  if (
    awsNodes.length === 0 &&
    awsVpcGroups.length === 0 &&
    awsNetworks.length === 0 &&
    awsSubnetGroups.length === 0
  ) {
    return;
  }

  // Register AWS provider & region variable
  const awsRegionVar = ctx.addVariable({
    name: 'aws_region',
    type: 'string',
    defaultValue: ctx.regions.aws,
    description: 'AWS region where generated resources are deployed.',
  });

  buckets.providers.push(
    hclBlockStmt(
      hclBlock('provider', {
        labels: ['aws'],
        ...commentIf(ctx, [
          'AWS provider configuration (credentials remain external via env/profile).',
        ]),
        attributes: [hclAttr('region', hclRef(`var.${awsRegionVar}`))],
      }),
    ),
  );

  // Pre-allocate names in canonical order for deterministic output regardless of JSON array order
  allocator.preallocate([
    ...awsVpcGroups.map((g) => ({
      scope: 'aws_vpc',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'main',
    })),
    ...awsNetworks.map((n) => ({
      scope: 'aws_vpc',
      entityId: n.id,
      rawLabel: n.name || n.id,
      fallback: 'main',
    })),
    ...awsSubnetGroups.map((g) => ({
      scope: 'aws_subnet',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'subnet',
    })),
    ...awsSubnets.map((s) => ({
      scope: 'aws_subnet',
      entityId: s.id,
      rawLabel: s.id.replace(/^sub-/, ''),
      fallback: 'subnet',
    })),
    ...awsNodes.map((n) => ({
      scope: 'aws_node',
      entityId: n.id,
      rawLabel: n.label,
      fallback: snakeCaseSlug(n.serviceId.replace(/^aws\./, ''), 'service'),
    })),
    ...network.firewalls
      .filter((f) => f.kind === 'sg')
      .map((f) => ({
        scope: 'aws_sg',
        entityId: f.id,
        rawLabel: f.id.replace(/^sg-/, ''),
        fallback: 'sg',
      })),
  ]);

  const state: AwsNetworkMapState = {
    vpcRefByGroupId: new Map(),
    vpcRefByNetworkId: new Map(),
    subnetRefByGroupId: new Map(),
    subnetRefBySubnetId: new Map(),
    subnetVpcRefBySubnetTfName: new Map(),
    allVpcRefs: [],
    defaultVpcRef: null,
    defaultPublicSubnetRefs: [],
    defaultPrivateSubnetRefs: [],
    sgNameByFirewallId: new Map(),
    sgNameByNodeId: new Map(),
    nodeVpcRef: new Map(),
    nodeSubnetRef: new Map(),
  };

  // 1. Emit VPCs
  const emittedVpcNames = new Set<string>();
  const vpcCidrByTfName = new Map<string, string>();

  for (const netObj of awsNetworks) {
    const groupId = netObj.id.startsWith('net-') ? netObj.id.slice(4) : netObj.id;
    const matchedGroup = awsVpcGroups.find((g) => g.id === groupId);
    const tfName = allocator.allocate(
      'aws_vpc',
      matchedGroup ? matchedGroup.id : netObj.id,
      netObj.name || matchedGroup?.label || 'main',
      'main',
    );
    state.vpcRefByNetworkId.set(netObj.id, tfName);
    if (matchedGroup) {
      state.vpcRefByGroupId.set(matchedGroup.id, tfName);
      ctx.recordAddress(matchedGroup.id, `aws_vpc.${tfName}`);
    }
    if (!emittedVpcNames.has(tfName)) {
      emittedVpcNames.add(tfName);
      state.allVpcRefs.push(tfName);
      const cidr = netObj.cidrs[0] ?? '10.0.0.0/16';
      vpcCidrByTfName.set(tfName, cidr);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_vpc', tfName],
            ...commentIf(ctx, [`Virtual Private Cloud: ${netObj.name || tfName}`]),
            attributes: [
              hclAttr('cidr_block', hclLit(cidr)),
              hclAttr('enable_dns_support', hclLit(true)),
              hclAttr('enable_dns_hostnames', hclLit(true)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${tfName}"`)]])),
            ],
          }),
        ),
      );
    }
  }

  for (const vpcGroup of awsVpcGroups) {
    if (state.vpcRefByGroupId.has(vpcGroup.id)) continue;
    const tfName = allocator.allocate('aws_vpc', vpcGroup.id, vpcGroup.label, 'main');
    state.vpcRefByGroupId.set(vpcGroup.id, tfName);
    ctx.recordAddress(vpcGroup.id, `aws_vpc.${tfName}`);
    if (!emittedVpcNames.has(tfName)) {
      emittedVpcNames.add(tfName);
      state.allVpcRefs.push(tfName);
      const cidr = vpcGroup.cidr?.trim() || '10.0.0.0/16';
      vpcCidrByTfName.set(tfName, cidr);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_vpc', tfName],
            ...commentIf(ctx, [`Virtual Private Cloud from canvas container: ${vpcGroup.label}`]),
            attributes: [
              hclAttr('cidr_block', hclLit(cidr)),
              hclAttr('enable_dns_support', hclLit(true)),
              hclAttr('enable_dns_hostnames', hclLit(true)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${tfName}"`)]])),
            ],
          }),
        ),
      );
    }
  }

  if (needsImplicitVpc && state.allVpcRefs.length === 0) {
    const tfName = allocator.allocate('aws_vpc', '__implicit_main__', 'main', 'main');
    state.allVpcRefs.push(tfName);
    state.defaultVpcRef = tfName;
    vpcCidrByTfName.set(tfName, '10.0.0.0/16');
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_vpc', tfName],
          ...commentIf(ctx, [
            'Default VPC synthesized because compute/data nodes were placed without a VPC container.',
          ]),
          attributes: [
            hclAttr('cidr_block', hclLit('10.0.0.0/16')),
            hclAttr('enable_dns_support', hclLit(true)),
            hclAttr('enable_dns_hostnames', hclLit(true)),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${tfName}"`)]])),
          ],
        }),
      ),
    );

    const syntheticSubnets: Array<{
      id: string;
      name: string;
      cidr: string;
      azSuffix: string;
      isPublic: boolean;
    }> = [
      {
        id: '__implicit_pub_a__',
        name: 'public_a',
        cidr: '10.0.1.0/24',
        azSuffix: 'a',
        isPublic: true,
      },
      {
        id: '__implicit_pub_b__',
        name: 'public_b',
        cidr: '10.0.2.0/24',
        azSuffix: 'b',
        isPublic: true,
      },
      {
        id: '__implicit_priv_a__',
        name: 'private_a',
        cidr: '10.0.11.0/24',
        azSuffix: 'a',
        isPublic: false,
      },
      {
        id: '__implicit_priv_b__',
        name: 'private_b',
        cidr: '10.0.12.0/24',
        azSuffix: 'b',
        isPublic: false,
      },
    ];
    for (const s of syntheticSubnets) {
      const subName = allocator.allocate('aws_subnet', s.id, s.name, 'subnet');
      state.subnetVpcRefBySubnetTfName.set(subName, tfName);
      if (s.isPublic) {
        state.defaultPublicSubnetRefs.push(subName);
      } else {
        state.defaultPrivateSubnetRefs.push(subName);
      }
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_subnet', subName],
            attributes: [
              hclAttr('vpc_id', hclRef(`aws_vpc.${tfName}.id`)),
              hclAttr('cidr_block', hclLit(s.cidr)),
              hclAttr('availability_zone', hclRaw(`"\${var.${awsRegionVar}}${s.azSuffix}"`)),
              ...(s.isPublic ? [hclAttr('map_public_ip_on_launch', hclLit(true))] : []),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${subName}"`)]])),
            ],
          }),
        ),
      );
    }

    const igwName = allocator.allocate('aws_igw', '__implicit_igw__', 'main', 'main');
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_internet_gateway', igwName],
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${tfName}.id`)),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-igw"`)]])),
          ],
        }),
      ),
    );
    const rtName = allocator.allocate('aws_rt', '__implicit_rt_pub__', 'public', 'public');
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_route_table', rtName],
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${tfName}.id`)),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-public-rt"`)]])),
          ],
        }),
      ),
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_route', `${rtName}_default`],
          attributes: [
            hclAttr('route_table_id', hclRef(`aws_route_table.${rtName}.id`)),
            hclAttr('destination_cidr_block', hclLit('0.0.0.0/0')),
            hclAttr('gateway_id', hclRef(`aws_internet_gateway.${igwName}.id`)),
          ],
        }),
      ),
    );
    for (const pubSub of state.defaultPublicSubnetRefs) {
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_route_table_association', `${rtName}_${pubSub}`],
            attributes: [
              hclAttr('subnet_id', hclRef(`aws_subnet.${pubSub}.id`)),
              hclAttr('route_table_id', hclRef(`aws_route_table.${rtName}.id`)),
            ],
          }),
        ),
      );
    }
  } else {
    state.defaultVpcRef = state.allVpcRefs[0] ?? null;
  }

  // 2. Emit explicit subnets from network model + canvas subnet groups
  const emittedSubnets = new Set<string>();
  const resolveVpcRefForGroup = (group: GroupInstance): string | null => {
    let cur: GroupInstance | undefined = group;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === 'vpc') {
        const hit = state.vpcRefByGroupId.get(cur.id);
        if (hit) return hit;
      }
      cur = cur.parentGroupId ? ctx.groupsById.get(cur.parentGroupId) : undefined;
    }
    return state.defaultVpcRef;
  };

  for (const sub of awsSubnets) {
    const groupId = sub.id.startsWith('sub-') ? sub.id.slice(4) : sub.id;
    const matchedGroup = awsSubnetGroups.find((g) => g.id === groupId);
    const subName = allocator.allocate(
      'aws_subnet',
      matchedGroup ? matchedGroup.id : sub.id,
      matchedGroup?.label ?? sub.id.replace(/^sub-/, ''),
      'subnet',
    );
    const vpcRef = state.vpcRefByNetworkId.get(sub.networkId) ?? state.defaultVpcRef;
    state.subnetRefBySubnetId.set(sub.id, subName);
    if (matchedGroup) {
      state.subnetRefByGroupId.set(matchedGroup.id, subName);
      ctx.recordAddress(matchedGroup.id, `aws_subnet.${subName}`);
    }
    if (!vpcRef || emittedSubnets.has(subName)) continue;
    emittedSubnets.add(subName);
    state.subnetVpcRefBySubnetTfName.set(subName, vpcRef);
    const isPub = Boolean(sub.autoAssignPublicIp ?? matchedGroup?.public);
    if (isPub) state.defaultPublicSubnetRefs.push(subName);
    else state.defaultPrivateSubnetRefs.push(subName);

    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_subnet', subName],
          ...commentIf(ctx, [
            `${isPub ? 'Public' : 'Private'} subnet: ${matchedGroup?.label ?? subName} (${sub.cidr})`,
          ]),
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
            hclAttr('cidr_block', hclLit(sub.cidr)),
            ...(sub.az ? [hclAttr('availability_zone', hclLit(sub.az))] : []),
            ...(isPub ? [hclAttr('map_public_ip_on_launch', hclLit(true))] : []),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${subName}"`)]])),
          ],
        }),
      ),
    );
  }

  for (const subGroup of awsSubnetGroups) {
    if (state.subnetRefByGroupId.has(subGroup.id)) continue;
    const subName = allocator.allocate('aws_subnet', subGroup.id, subGroup.label, 'subnet');
    state.subnetRefByGroupId.set(subGroup.id, subName);
    ctx.recordAddress(subGroup.id, `aws_subnet.${subName}`);
    const vpcRef = resolveVpcRefForGroup(subGroup);
    if (!vpcRef || emittedSubnets.has(subName)) continue;
    emittedSubnets.add(subName);
    state.subnetVpcRefBySubnetTfName.set(subName, vpcRef);
    const isPub = subGroup.public !== false;
    if (isPub) state.defaultPublicSubnetRefs.push(subName);
    else state.defaultPrivateSubnetRefs.push(subName);

    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_subnet', subName],
          ...commentIf(ctx, [`Subnet from canvas container: ${subGroup.label}`]),
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
            hclAttr('cidr_block', hclLit(subGroup.cidr?.trim() || '10.0.1.0/24')),
            ...(isPub ? [hclAttr('map_public_ip_on_launch', hclLit(true))] : []),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${subName}"`)]])),
          ],
        }),
      ),
    );
  }

  // 3. Emit explicit Gateways (IGW, NAT, TGW) from network config + nodes
  const igwRefByVpc = new Map<string, string>();
  const natRefById = new Map<string, string>();
  const tgwRefById = new Map<string, string>();

  for (const gw of [...network.gateways].sort((a, b) => a.id.localeCompare(b.id))) {
    const vpcRef = gw.networkId ? state.vpcRefByNetworkId.get(gw.networkId) : state.defaultVpcRef;
    if (gw.kind === 'igw' && vpcRef && !igwRefByVpc.has(vpcRef)) {
      const igwName = allocator.allocate('aws_igw', gw.id, vpcRef, 'main');
      igwRefByVpc.set(vpcRef, igwName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_internet_gateway', igwName],
            attributes: [
              hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${igwName}"`)]])),
            ],
          }),
        ),
      );
    } else if (gw.kind === 'nat') {
      const subRef =
        (gw.subnetId ? state.subnetRefBySubnetId.get(gw.subnetId) : undefined) ??
        state.defaultPublicSubnetRefs[0];
      if (subRef) {
        const natName = allocator.allocate('aws_nat', gw.id, subRef, 'nat');
        const eipName = allocator.allocate('aws_eip', `${gw.id}-eip`, `${natName}_eip`, 'nat_eip');
        natRefById.set(gw.id, natName);
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_eip', eipName],
              attributes: [
                hclAttr('domain', hclLit('vpc')),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${eipName}"`)]])),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_nat_gateway', natName],
              attributes: [
                hclAttr('allocation_id', hclRef(`aws_eip.${eipName}.id`)),
                hclAttr('subnet_id', hclRef(`aws_subnet.${subRef}.id`)),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${natName}"`)]])),
              ],
            }),
          ),
        );
      }
    } else if (gw.kind === 'tgw') {
      const tgwName = allocator.allocate('aws_tgw', gw.id, gw.id, 'tgw');
      tgwRefById.set(gw.id, tgwName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_ec2_transit_gateway', tgwName],
            attributes: [
              hclAttr('description', hclLit(`Transit Gateway (${gw.id})`)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${tgwName}"`)]])),
            ],
          }),
        ),
      );
    }
  }

  // Also emit IGW/NAT/TGW drawn directly as canvas nodes if not already represented by network.gateways
  for (const node of awsNodes) {
    const ancestry = ctx.resolveNodeAncestry(node);
    const vpcRef = ancestry.vpcGroup
      ? (state.vpcRefByGroupId.get(ancestry.vpcGroup.id) ?? state.defaultVpcRef)
      : state.defaultVpcRef;
    const subRef =
      (ancestry.subnetGroup ? state.subnetRefByGroupId.get(ancestry.subnetGroup.id) : undefined) ??
      state.defaultPublicSubnetRefs[0] ??
      state.defaultPrivateSubnetRefs[0];

    if (node.serviceId === 'aws.igw' && vpcRef) {
      if (!igwRefByVpc.has(vpcRef)) {
        const igwName = allocator.allocate('aws_igw', node.id, node.label, 'igw');
        igwRefByVpc.set(vpcRef, igwName);
        ctx.recordAddress(node.id, `aws_internet_gateway.${igwName}`);
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_internet_gateway', igwName],
              attributes: [
                hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${igwName}"`)]])),
              ],
            }),
          ),
        );
      } else {
        ctx.recordAddress(node.id, `aws_internet_gateway.${igwRefByVpc.get(vpcRef)!}`);
      }
    } else if (node.serviceId === 'aws.nat_gw' && subRef) {
      const natName = allocator.allocate('aws_nat', node.id, node.label, 'nat');
      const eipName = allocator.allocate('aws_eip', `${node.id}-eip`, `${natName}_eip`, 'nat_eip');
      ctx.recordAddress(node.id, `aws_eip.${eipName}`);
      ctx.recordAddress(node.id, `aws_nat_gateway.${natName}`);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_eip', eipName],
            attributes: [hclAttr('domain', hclLit('vpc'))],
          }),
        ),
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_nat_gateway', natName],
            attributes: [
              hclAttr('allocation_id', hclRef(`aws_eip.${eipName}.id`)),
              hclAttr('subnet_id', hclRef(`aws_subnet.${subRef}.id`)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${natName}"`)]])),
            ],
          }),
        ),
      );
    } else if (node.serviceId === 'aws.tgw') {
      const tgwName = allocator.allocate('aws_tgw', node.id, node.label, 'tgw');
      tgwRefById.set(node.id, tgwName);
      ctx.recordAddress(node.id, `aws_ec2_transit_gateway.${tgwName}`);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_ec2_transit_gateway', tgwName],
            attributes: [
              hclAttr('description', hclLit(node.label)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${tgwName}"`)]])),
            ],
          }),
        ),
      );
    }
  }

  // 4. Route Tables, Routes, and Subnet Associations
  const peeringRefById = new Map<string, string>();
  for (const peer of [...network.peerings].sort((a, b) => a.id.localeCompare(b.id))) {
    const aRef = state.vpcRefByNetworkId.get(peer.a);
    const bRef = state.vpcRefByNetworkId.get(peer.b);
    if (!aRef || !bRef) continue;
    const peerName = allocator.allocate('aws_peering', peer.id, `${aRef}_to_${bRef}`, 'peering');
    peeringRefById.set(peer.id, peerName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_vpc_peering_connection', peerName],
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${aRef}.id`)),
            hclAttr('peer_vpc_id', hclRef(`aws_vpc.${bRef}.id`)),
            hclAttr('auto_accept', hclLit(true)),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${peerName}"`)]])),
          ],
        }),
      ),
    );
  }

  const emittedRouteTables = new Map<string, string>();
  for (const sub of awsSubnets) {
    const subTfName = state.subnetRefBySubnetId.get(sub.id);
    const vpcRef = state.vpcRefByNetworkId.get(sub.networkId) ?? state.defaultVpcRef;
    const rtObj = network.routeTables.find((r) => r.id === sub.routeTableId);
    if (!subTfName || !vpcRef || !rtObj) continue;

    let rtName = emittedRouteTables.get(rtObj.id);
    if (!rtName) {
      rtName = allocator.allocate('aws_rt', rtObj.id, rtObj.id.replace(/^rt-/, ''), 'rt');
      emittedRouteTables.set(rtObj.id, rtName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_route_table', rtName],
            attributes: [
              hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
              hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${rtName}"`)]])),
            ],
          }),
        ),
      );

      rtObj.routes.forEach((route, idx) => {
        if (route.target.kind === 'local' || route.target.kind === 'blackhole') return;
        const attrs: HclAttribute[] = [
          hclAttr('route_table_id', hclRef(`aws_route_table.${rtName}.id`)),
          hclAttr('destination_cidr_block', hclLit(route.dest)),
        ];
        if (route.target.kind === 'igw') {
          const igwName = igwRefByVpc.get(vpcRef);
          if (!igwName) return;
          attrs.push(hclAttr('gateway_id', hclRef(`aws_internet_gateway.${igwName}.id`)));
        } else if (route.target.kind === 'nat') {
          const natName = natRefById.get(route.target.gatewayId);
          if (!natName) return;
          attrs.push(hclAttr('nat_gateway_id', hclRef(`aws_nat_gateway.${natName}.id`)));
        } else if (route.target.kind === 'peering') {
          const pName = peeringRefById.get(route.target.id);
          if (!pName) return;
          attrs.push(
            hclAttr('vpc_peering_connection_id', hclRef(`aws_vpc_peering_connection.${pName}.id`)),
          );
        } else if (route.target.kind === 'tgw') {
          const tName = tgwRefById.get(route.target.id);
          if (!tName) return;
          attrs.push(hclAttr('transit_gateway_id', hclRef(`aws_ec2_transit_gateway.${tName}.id`)));
        } else {
          return;
        }
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_route', `${rtName}_r${idx + 1}`],
              attributes: attrs,
            }),
          ),
        );
      });
    }

    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_route_table_association', `${rtName}_${subTfName}`],
          attributes: [
            hclAttr('subnet_id', hclRef(`aws_subnet.${subTfName}.id`)),
            hclAttr('route_table_id', hclRef(`aws_route_table.${rtName}.id`)),
          ],
        }),
      ),
    );
  }

  // 5. Assign VPC + Subnet placement for each VPC-hosted AWS node and establish Security Groups
  for (const node of awsNodes) {
    const anc = ctx.resolveNodeAncestry(node);
    const att = network.attachments.find((a) => a.nodeId === node.id);
    const attSub = att?.subnetId ? network.subnets.find((s) => s.id === att.subnetId) : undefined;
    let subRef =
      (att?.subnetId ? state.subnetRefBySubnetId.get(att.subnetId) : undefined) ??
      (anc.subnetGroup ? state.subnetRefByGroupId.get(anc.subnetGroup.id) : undefined);

    if (!subRef && VPC_HOSTED_AWS_SERVICES.has(node.serviceId)) {
      const prefersPublic =
        node.serviceId === 'aws.alb' ||
        node.serviceId === 'aws.nlb' ||
        node.serviceId === 'aws.gwlb' ||
        node.serviceId === 'aws.nat_gw';
      subRef = prefersPublic
        ? (state.defaultPublicSubnetRefs[0] ?? state.defaultPrivateSubnetRefs[0])
        : (state.defaultPrivateSubnetRefs[0] ?? state.defaultPublicSubnetRefs[0]);
    }
    if (subRef) {
      state.nodeSubnetRef.set(node.id, subRef);
    }
    const vpcRef =
      (attSub ? state.vpcRefByNetworkId.get(attSub.networkId) : undefined) ??
      (subRef ? state.subnetVpcRefBySubnetTfName.get(subRef) : undefined) ??
      (anc.vpcGroup ? state.vpcRefByGroupId.get(anc.vpcGroup.id) : undefined) ??
      state.defaultVpcRef;
    if (vpcRef) {
      state.nodeVpcRef.set(node.id, vpcRef);
    }
  }

  // Create Security Groups for VPC-hosted AWS nodes + explicit SGs
  const sgVpcByName = new Map<string, string>();
  for (const fw of [...network.firewalls]
    .filter((f) => f.kind === 'sg')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const firstNodeId = fw.attachedTo?.nodeIds?.[0];
    const firstNode = firstNodeId ? ctx.nodesById.get(firstNodeId) : undefined;
    const vpcRef =
      (firstNodeId ? state.nodeVpcRef.get(firstNodeId) : undefined) ?? state.defaultVpcRef;
    if (!vpcRef) continue;
    const sgName = allocator.allocate(
      'aws_sg',
      fw.id,
      firstNode?.label ?? fw.id.replace(/^sg-/, ''),
      'sg',
    );
    state.sgNameByFirewallId.set(fw.id, sgName);
    sgVpcByName.set(sgName, vpcRef);
    if (firstNodeId) state.sgNameByNodeId.set(firstNodeId, sgName);
  }

  for (const node of awsNodes) {
    if (!VPC_HOSTED_AWS_SERVICES.has(node.serviceId) || node.serviceId === 'aws.nat_gw') {
      continue;
    }
    const existingFw = ctx.getNodeFirewall(node);
    if (existingFw && state.sgNameByFirewallId.has(existingFw.id)) {
      state.sgNameByNodeId.set(node.id, state.sgNameByFirewallId.get(existingFw.id)!);
      continue;
    }
    const vpcRef = state.nodeVpcRef.get(node.id);
    if (!vpcRef) continue;
    const sgName = allocator.allocate('aws_sg', `node-${node.id}`, node.label, 'sg');
    state.sgNameByNodeId.set(node.id, sgName);
    sgVpcByName.set(sgName, vpcRef);
  }

  for (const sgName of [...sgVpcByName.keys()].sort((a, b) => a.localeCompare(b))) {
    const vpcRef = sgVpcByName.get(sgName)!;
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_security_group', sgName],
          ...commentIf(ctx, [`Security group for ${sgName}`]),
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${sgName}"`)),
            hclAttr('description', hclLit(`Managed by InfraSim for ${sgName}`)),
            hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${sgName}"`)]])),
          ],
        }),
      ),
    );
  }

  // Emit least-privilege Security Group rules driven by edges + explicit non-coarse SG rules
  const emittedRuleKeys = new Set<string>();
  const addSgRule = (params: {
    direction: 'ingress' | 'egress';
    sgName: string;
    ruleName: string;
    protocol: 'tcp' | 'udp' | 'icmp' | '-1';
    fromPort?: number;
    toPort?: number;
    cidrIpv4?: string;
    referencedSg?: string;
    comment?: string;
  }) => {
    const dedupeKey = [
      params.direction,
      params.sgName,
      params.protocol,
      params.fromPort ?? '*',
      params.toPort ?? '*',
      params.referencedSg ?? params.cidrIpv4 ?? '',
    ].join('|');
    if (emittedRuleKeys.has(dedupeKey)) return;
    emittedRuleKeys.add(dedupeKey);

    const blockType =
      params.direction === 'ingress'
        ? 'aws_vpc_security_group_ingress_rule'
        : 'aws_vpc_security_group_egress_rule';
    const attrs: HclAttribute[] = [
      hclAttr('security_group_id', hclRef(`aws_security_group.${params.sgName}.id`)),
    ];
    if (params.referencedSg) {
      attrs.push(
        hclAttr(
          'referenced_security_group_id',
          hclRef(`aws_security_group.${params.referencedSg}.id`),
        ),
      );
    } else if (params.cidrIpv4) {
      attrs.push(hclAttr('cidr_ipv4', hclLit(params.cidrIpv4)));
    }
    attrs.push(hclAttr('ip_protocol', hclLit(params.protocol)));
    if (params.protocol !== '-1' && params.fromPort !== undefined) {
      attrs.push(hclAttr('from_port', hclLit(params.fromPort)));
      attrs.push(hclAttr('to_port', hclLit(params.toPort ?? params.fromPort)));
    }

    const uniqueName = allocator.allocate(
      `aws_sg_rule_${params.direction}`,
      dedupeKey,
      params.ruleName,
      'rule',
    );
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: [blockType, uniqueName],
          ...(params.comment && ctx.includeComments ? { comments: [params.comment] } : {}),
          attributes: attrs,
        }),
      ),
    );
  };

  const sortedEdges = [...design.edges].sort((a, b) => a.id.localeCompare(b.id));
  const nodesCoveredByEdgeRule = new Set<string>();
  for (const edge of sortedEdges) {
    const fromNode = ctx.nodesById.get(edge.from);
    const toNode = ctx.nodesById.get(edge.to);
    if (!fromNode || !toNode) continue;
    const toSg = state.sgNameByNodeId.get(toNode.id);
    if (!toSg) continue;
    const fromSg = state.sgNameByNodeId.get(fromNode.id);
    const targetSvc = ctx.servicesById.get(toNode.serviceId);
    const transport = inferAwsEdgeTransport(edge, toNode, targetSvc);
    nodesCoveredByEdgeRule.add(toNode.id);

    const isFromInternet =
      INTERNET_CALLER_SERVICES.has(fromNode.serviceId) ||
      fromNode.serviceId === 'aws.cloudfront' ||
      fromNode.serviceId === 'aws.route53';

    if (fromSg) {
      addSgRule({
        direction: 'ingress',
        sgName: toSg,
        ruleName: `${toSg}_from_${fromSg}_${transport.port}`,
        protocol: transport.protocol,
        fromPort: transport.port,
        toPort: transport.port,
        referencedSg: fromSg,
        comment: `Edge: ${fromNode.label} -> ${toNode.label} (${transport.protocol.toUpperCase()} ${transport.port})`,
      });
      addSgRule({
        direction: 'egress',
        sgName: fromSg,
        ruleName: `${fromSg}_to_${toSg}_${transport.port}`,
        protocol: transport.protocol,
        fromPort: transport.port,
        toPort: transport.port,
        referencedSg: toSg,
      });
    } else if (isFromInternet || PUBLIC_ENTRY_SERVICES.has(toNode.serviceId)) {
      addSgRule({
        direction: 'ingress',
        sgName: toSg,
        ruleName: `${toSg}_from_internet_${transport.port}`,
        protocol: transport.protocol,
        fromPort: transport.port,
        toPort: transport.port,
        cidrIpv4: '0.0.0.0/0',
        comment: `Public entry edge: ${fromNode.label} -> ${toNode.label} (${transport.protocol.toUpperCase()} ${transport.port})`,
      });
    }
  }

  // Emit explicit firewall rules from NetworkConfig while enforcing least privilege (avoid 0.0.0.0/0 on internal targets)
  for (const fw of [...network.firewalls]
    .filter((f) => f.kind === 'sg')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const sgName = state.sgNameByFirewallId.get(fw.id);
    if (!sgName) continue;
    const ownerNodeId = fw.attachedTo?.nodeIds?.[0];
    const ownerNode = ownerNodeId ? ctx.nodesById.get(ownerNodeId) : undefined;
    const ownerVpcRef = ownerNodeId ? state.nodeVpcRef.get(ownerNodeId) : state.defaultVpcRef;
    const vpcCidr = (ownerVpcRef ? vpcCidrByTfName.get(ownerVpcRef) : undefined) ?? '10.0.0.0/16';

    for (const rule of fw.rules) {
      if (rule.action !== 'allow') continue;
      const proto = toAwsIpProtocol(rule.protocol);
      if (rule.direction === 'ingress' && rule.source) {
        if ('firewallId' in rule.source) {
          const refSg = state.sgNameByFirewallId.get(rule.source.firewallId);
          if (!refSg) continue;
          addSgRule({
            direction: 'ingress',
            sgName,
            ruleName: `${sgName}_from_${refSg}`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            referencedSg: refSg,
          });
        } else if ('cidr' in rule.source) {
          // If SG-to-SG edge rules already cover this node and this is the Phase-4 auto VPC CIDR rule, skip duplication
          if (
            ownerNodeId &&
            nodesCoveredByEdgeRule.has(ownerNodeId) &&
            rule.source.cidr === vpcCidr
          ) {
            continue;
          }
          addSgRule({
            direction: 'ingress',
            sgName,
            ruleName: `${sgName}_in_cidr`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            cidrIpv4: rule.source.cidr,
          });
        } else if (
          'any' in rule.source &&
          ownerNode &&
          PUBLIC_ENTRY_SERVICES.has(ownerNode.serviceId)
        ) {
          addSgRule({
            direction: 'ingress',
            sgName,
            ruleName: `${sgName}_in_public`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            cidrIpv4: '0.0.0.0/0',
          });
        }
      } else if (rule.direction === 'egress' && rule.destination) {
        if ('firewallId' in rule.destination) {
          const refSg = state.sgNameByFirewallId.get(rule.destination.firewallId);
          if (!refSg) continue;
          addSgRule({
            direction: 'egress',
            sgName,
            ruleName: `${sgName}_to_${refSg}`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            referencedSg: refSg,
          });
        } else if ('cidr' in rule.destination) {
          addSgRule({
            direction: 'egress',
            sgName,
            ruleName: `${sgName}_out_cidr`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            cidrIpv4: rule.destination.cidr,
          });
        } else if ('any' in rule.destination) {
          addSgRule({
            direction: 'egress',
            sgName,
            ruleName: `${sgName}_out_all`,
            protocol: proto,
            ...(rule.portFrom !== undefined ? { fromPort: rule.portFrom } : {}),
            ...(rule.portTo !== undefined ? { toPort: rule.portTo } : {}),
            cidrIpv4: '0.0.0.0/0',
          });
        }
      }
    }
  }

  // Emit NACLs from NetworkConfig
  for (const nacl of [...network.firewalls]
    .filter((f) => f.kind === 'nacl')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const subRefs = (nacl.attachedTo?.subnetIds ?? [])
      .map((id) => state.subnetRefBySubnetId.get(id))
      .filter((v): v is string => Boolean(v));
    const vpcRef =
      (subRefs[0] ? state.subnetVpcRefBySubnetTfName.get(subRefs[0]) : undefined) ??
      state.defaultVpcRef;
    if (!vpcRef) continue;
    const naclName = allocator.allocate('aws_nacl', nacl.id, nacl.id.replace(/^nacl-/, ''), 'nacl');
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_network_acl', naclName],
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
            ...(subRefs.length > 0
              ? [hclAttr('subnet_ids', hclList(subRefs.map((s) => hclRef(`aws_subnet.${s}.id`))))]
              : []),
            hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${naclName}"`)]])),
          ],
        }),
      ),
    );
    nacl.rules.forEach((rule, idx) => {
      const proto = toAwsIpProtocol(rule.protocol);
      const cidr =
        rule.direction === 'ingress' && rule.source && 'cidr' in rule.source
          ? rule.source.cidr
          : rule.direction === 'egress' && rule.destination && 'cidr' in rule.destination
            ? rule.destination.cidr
            : '0.0.0.0/0';
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_network_acl_rule', `${naclName}_${rule.direction}_${idx + 1}`],
            attributes: [
              hclAttr('network_acl_id', hclRef(`aws_network_acl.${naclName}.id`)),
              hclAttr('rule_number', hclLit(rule.priority ?? (idx + 1) * 100)),
              hclAttr('egress', hclLit(rule.direction === 'egress')),
              hclAttr('protocol', hclLit(proto)),
              hclAttr('rule_action', hclLit(rule.action)),
              hclAttr('cidr_block', hclLit(cidr)),
              ...(proto !== '-1' && rule.portFrom !== undefined
                ? [
                    hclAttr('from_port', hclLit(rule.portFrom)),
                    hclAttr('to_port', hclLit(rule.portTo ?? rule.portFrom)),
                  ]
                : []),
            ],
          }),
        ),
      );
    });
  }

  // Emit VPC Endpoints & DNS Zones from NetworkConfig
  for (const ep of [...network.endpoints].sort((a, b) => a.id.localeCompare(b.id))) {
    const vpcRef = state.vpcRefByNetworkId.get(ep.networkId) ?? state.defaultVpcRef;
    const subRef = state.subnetRefBySubnetId.get(ep.subnetId);
    if (!vpcRef) continue;
    const epName = allocator.allocate('aws_vpce', ep.id, ep.serviceId, 'endpoint');
    const svcShort = ep.serviceId.replace(/^aws\./, '').replace(/_/g, '-');
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_vpc_endpoint', epName],
          attributes: [
            hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
            hclAttr('service_name', hclRaw(`"com.amazonaws.\${var.${awsRegionVar}}.${svcShort}"`)),
            hclAttr('vpc_endpoint_type', hclLit('Interface')),
            ...(subRef
              ? [hclAttr('subnet_ids', hclList([hclRef(`aws_subnet.${subRef}.id`)]))]
              : []),
            ...(ep.privateDns ? [hclAttr('private_dns_enabled', hclLit(true))] : []),
          ],
        }),
      ),
    );
  }

  for (const zone of [...network.dnsZones].sort((a, b) => a.id.localeCompare(b.id))) {
    const zoneName = allocator.allocate('aws_r53_zone', zone.id, zone.name, 'zone');
    const vpcRef = zone.networkIds[0] ? state.vpcRefByNetworkId.get(zone.networkIds[0]) : undefined;
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_route53_zone', zoneName],
          attributes: [hclAttr('name', hclLit(zone.name))],
          ...(zone.private && vpcRef
            ? {
                blocks: [
                  hclBlock('vpc', {
                    attributes: [hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`))],
                  }),
                ],
              }
            : {}),
        }),
      ),
    );
    zone.records.forEach((rec, idx) => {
      const recName = allocator.allocate('aws_r53_rec', `${zone.id}-${idx}`, rec.name, 'record');
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['aws_route53_record', recName],
            attributes: [
              hclAttr('zone_id', hclRef(`aws_route53_zone.${zoneName}.zone_id`)),
              hclAttr('name', hclLit(rec.name)),
              hclAttr('type', hclLit(rec.type)),
              hclAttr('ttl', hclLit(300)),
              hclAttr('records', hclList([hclLit(rec.value)])),
            ],
          }),
        ),
      );
    });
  }

  // Emit shared AL2023 AMI SSM data source if EC2 is present
  const hasEc2 = awsNodes.some((n) => n.serviceId === 'aws.ec2');
  if (hasEc2) {
    buckets.compute.push(
      hclBlockStmt(
        hclBlock('data', {
          labels: ['aws_ssm_parameter', 'al2023_ami'],
          ...commentIf(ctx, [
            'Resolve the latest Amazon Linux 2023 AMI dynamically instead of hard-coding AMI IDs.',
          ]),
          attributes: [
            hclAttr(
              'name',
              hclLit('/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'),
            ),
          ],
        }),
      ),
    );
  }

  // Pre-track names for compute/data nodes so cross-resource references (ALB -> TG -> EC2, SNS -> SQS, etc.) work cleanly
  const nodeTfName = new Map<string, string>();
  for (const node of awsNodes) {
    nodeTfName.set(
      node.id,
      allocator.allocate(
        'aws_node',
        node.id,
        node.label,
        snakeCaseSlug(node.serviceId.replace(/^aws\./, ''), 'service'),
      ),
    );
  }

  const getVpcSubnets = (vpcRef: string | undefined): string[] => {
    if (!vpcRef) return [];
    const list: string[] = [];
    for (const [subName, vRef] of state.subnetVpcRefBySubnetTfName.entries()) {
      if (vRef === vpcRef) list.push(subName);
    }
    return list;
  };

  const getDbSubnetGroup = (vpcRef: string | undefined, baseName: string): string | undefined => {
    if (!vpcRef) return undefined;
    const priv = state.defaultPrivateSubnetRefs.filter(
      (s) => state.subnetVpcRefBySubnetTfName.get(s) === vpcRef,
    );
    const allSubs = priv.length > 0 ? priv : getVpcSubnets(vpcRef);
    if (allSubs.length === 0) return undefined;
    const subGroupName = allocator.allocate('aws_db_subgrp', `${baseName}_subgrp`, baseName, 'db');
    buckets.data.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['aws_db_subnet_group', subGroupName],
          ...(allSubs.length < 2 && ctx.includeComments
            ? {
                comments: ['TODO: attach subnets across >= 2 Availability Zones for Multi-AZ RDS.'],
              }
            : {}),
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subGroupName}"`)),
            hclAttr('subnet_ids', hclList(allSubs.map((s) => hclRef(`aws_subnet.${s}.id`)))),
          ],
        }),
      ),
    );
    return subGroupName;
  };

  // Emit node resources
  for (const node of awsNodes) {
    const name = nodeTfName.get(node.id)!;
    const vpcRef = state.nodeVpcRef.get(node.id) ?? state.defaultVpcRef ?? undefined;
    const subRef = state.nodeSubnetRef.get(node.id);
    const sgName = state.sgNameByNodeId.get(node.id);
    const outEdges = sortedEdges.filter((e) => e.from === node.id);
    const inEdges = sortedEdges.filter((e) => e.to === node.id);
    const instances = Math.max(1, Math.round(node.config.instances || 1));

    switch (node.serviceId) {
      case 'aws.igw':
      case 'aws.nat_gw':
      case 'aws.tgw':
        // Already emitted in Network section
        break;

      case 'aws.vpc_peering': {
        if (state.allVpcRefs.length >= 2) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_vpc_peering_connection', name],
                attributes: [
                  hclAttr('vpc_id', hclRef(`aws_vpc.${state.allVpcRefs[0]!}.id`)),
                  hclAttr('peer_vpc_id', hclRef(`aws_vpc.${state.allVpcRefs[1]!}.id`)),
                  hclAttr('auto_accept', hclLit(true)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_vpc_peering_connection.${name}`);
        } else {
          const peerVpcVar = ctx.addVariable({
            name: `${name}_peer_vpc_id`,
            type: 'string',
            description: `TODO: peer VPC ID for peering connection ${node.label}`,
          });
          if (vpcRef) {
            buckets.network.push(
              hclBlockStmt(
                hclBlock('resource', {
                  labels: ['aws_vpc_peering_connection', name],
                  attributes: [
                    hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
                    hclAttr('peer_vpc_id', hclRef(`var.${peerVpcVar}`)),
                    hclAttr('auto_accept', hclLit(false)),
                  ],
                }),
              ),
            );
            ctx.recordAddress(node.id, `aws_vpc_peering_connection.${name}`);
          }
        }
        break;
      }

      case 'aws.privatelink': {
        if (vpcRef) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_vpc_endpoint', name],
                attributes: [
                  hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
                  hclAttr('service_name', hclRaw(`"com.amazonaws.\${var.${awsRegionVar}}.s3"`)),
                  hclAttr('vpc_endpoint_type', hclLit('Interface')),
                  ...(subRef
                    ? [hclAttr('subnet_ids', hclList([hclRef(`aws_subnet.${subRef}.id`)]))]
                    : []),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_vpc_endpoint.${name}`);
        }
        break;
      }

      case 'aws.route53': {
        const domainVar = ctx.addVariable({
          name: `${name}_domain_name`,
          type: 'string',
          description: `TODO: DNS domain name for Route 53 hosted zone (${node.label}, e.g. example.com)`,
        });
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_route53_zone', name],
              attributes: [hclAttr('name', hclRef(`var.${domainVar}`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_route53_zone.${name}`);
        for (const edge of outEdges) {
          const target = ctx.nodesById.get(edge.to);
          if (!target) continue;
          const tName = nodeTfName.get(target.id);
          if (target.serviceId === 'aws.alb' || target.serviceId === 'aws.nlb') {
            buckets.network.push(
              hclBlockStmt(
                hclBlock('resource', {
                  labels: ['aws_route53_record', `${name}_to_${tName}`],
                  attributes: [
                    hclAttr('zone_id', hclRef(`aws_route53_zone.${name}.zone_id`)),
                    hclAttr('name', hclRef(`var.${domainVar}`)),
                    hclAttr('type', hclLit('A')),
                  ],
                  blocks: [
                    hclBlock('alias', {
                      attributes: [
                        hclAttr('name', hclRef(`aws_lb.${tName}.dns_name`)),
                        hclAttr('zone_id', hclRef(`aws_lb.${tName}.zone_id`)),
                        hclAttr('evaluate_target_health', hclLit(true)),
                      ],
                    }),
                  ],
                }),
              ),
            );
          }
        }
        break;
      }

      case 'aws.waf': {
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_wafv2_web_acl', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('scope', hclLit('REGIONAL')),
              ],
              blocks: [
                hclBlock('default_action', { blocks: [hclBlock('allow')] }),
                hclBlock('visibility_config', {
                  attributes: [
                    hclAttr('cloudwatch_metrics_enabled', hclLit(true)),
                    hclAttr('metric_name', hclLit(name)),
                    hclAttr('sampled_requests_enabled', hclLit(true)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_wafv2_web_acl.${name}`);
        break;
      }

      case 'aws.ec2': {
        const instanceType = node.config.instanceType || 't3.micro';
        const keyVar = ctx.addVariable({
          name: 'ec2_key_name',
          type: 'string',
          defaultValue: '',
          description: 'TODO: optional EC2 key pair name for SSH access (leave empty to disable).',
        });

        if (node.config.autoscaling) {
          const ltName = `${name}_lt`;
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_launch_template', ltName],
                ...commentIf(ctx, [
                  `Autoscaled EC2 Launch Template for ${node.label} (${instanceType})`,
                ]),
                attributes: [
                  hclAttr('name_prefix', hclRaw(`"\${var.name_prefix}-${name}-"`)),
                  hclAttr('image_id', hclRef('data.aws_ssm_parameter.al2023_ami.value')),
                  hclAttr('instance_type', hclLit(instanceType)),
                  ...(sgName
                    ? [
                        hclAttr(
                          'vpc_security_group_ids',
                          hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                        ),
                      ]
                    : []),
                ],
              }),
            ),
          );
          const asgSubs = subRef ? [subRef] : getVpcSubnets(vpcRef);
          const upstreamAlbTgs = inEdges
            .map((e) => ctx.nodesById.get(e.from))
            .filter((n): n is NodeInstance =>
              Boolean(n && (n.serviceId === 'aws.alb' || n.serviceId === 'aws.nlb')),
            )
            .map((alb) => hclRef(`aws_lb_target_group.${nodeTfName.get(alb.id)!}_tg.arn`));

          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_autoscaling_group', name],
                attributes: [
                  hclAttr('min_size', hclLit(node.config.autoscaling.min)),
                  hclAttr('max_size', hclLit(node.config.autoscaling.max)),
                  hclAttr(
                    'desired_capacity',
                    hclLit(Math.max(node.config.autoscaling.min, instances)),
                  ),
                  ...(asgSubs.length > 0
                    ? [
                        hclAttr(
                          'vpc_zone_identifier',
                          hclList(asgSubs.map((s) => hclRef(`aws_subnet.${s}.id`))),
                        ),
                      ]
                    : []),
                  ...(upstreamAlbTgs.length > 0
                    ? [hclAttr('target_group_arns', hclList(upstreamAlbTgs))]
                    : []),
                ],
                blocks: [
                  hclBlock('launch_template', {
                    attributes: [
                      hclAttr('id', hclRef(`aws_launch_template.${ltName}.id`)),
                      hclAttr('version', hclLit('$Latest')),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_launch_template.${ltName}`);
          ctx.recordAddress(node.id, `aws_autoscaling_group.${name}`);
        } else {
          const envs = envBlockEntries(ctx, node, name);
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_instance', name],
                ...commentIf(ctx, [
                  `Compute node: ${node.label} (instances=${instances}, type=${instanceType})`,
                  ...(envs.length > 0 ? ['Environment keys validated cleanly.'] : []),
                ]),
                attributes: [
                  ...(instances > 1 ? [hclAttr('count', hclLit(instances))] : []),
                  hclAttr('ami', hclRef('data.aws_ssm_parameter.al2023_ami.value')),
                  hclAttr('instance_type', hclLit(instanceType)),
                  ...(subRef ? [hclAttr('subnet_id', hclRef(`aws_subnet.${subRef}.id`))] : []),
                  ...(sgName
                    ? [
                        hclAttr(
                          'vpc_security_group_ids',
                          hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                        ),
                      ]
                    : []),
                  hclAttr('key_name', hclRaw(`var.${keyVar} != "" ? var.${keyVar} : null`)),
                  hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${name}"`)]])),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_instance.${name}`);
        }
        break;
      }

      case 'aws.alb':
      case 'aws.nlb':
      case 'aws.gwlb': {
        const lbType =
          node.serviceId === 'aws.alb'
            ? 'application'
            : node.serviceId === 'aws.nlb'
              ? 'network'
              : 'gateway';
        const albSubnets =
          state.defaultPublicSubnetRefs.length >= 2
            ? state.defaultPublicSubnetRefs
            : getVpcSubnets(vpcRef);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_lb', name],
              ...commentIf(ctx, [
                `Load balancer: ${node.label} (type=${lbType})`,
                ...(albSubnets.length < 2
                  ? [
                      'TODO: AWS ALBs/NLBs require at least 2 subnets across distinct Availability Zones.',
                    ]
                  : []),
              ]),
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('internal', hclLit(false)),
                hclAttr('load_balancer_type', hclLit(lbType)),
                ...(lbType === 'application' && sgName
                  ? [
                      hclAttr(
                        'security_groups',
                        hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                      ),
                    ]
                  : []),
                ...(albSubnets.length > 0
                  ? [
                      hclAttr(
                        'subnets',
                        hclList(albSubnets.map((s) => hclRef(`aws_subnet.${s}.id`))),
                      ),
                    ]
                  : []),
                ...(node.config.lb?.idleTimeoutMs
                  ? [
                      hclAttr(
                        'idle_timeout',
                        hclLit(Math.max(1, Math.round(node.config.lb.idleTimeoutMs / 1000))),
                      ),
                    ]
                  : []),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${name}"`)]])),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_lb.${name}`);

        const downstreams = outEdges
          .map((e) => ({ edge: e, target: ctx.nodesById.get(e.to) }))
          .filter((item): item is { edge: EdgeInstance; target: NodeInstance } =>
            Boolean(item.target),
          );
        const firstTarget = downstreams[0]?.target;
        const firstEdge = downstreams[0]?.edge;
        const tgProto =
          lbType === 'network' ? 'TCP' : firstEdge?.protocol === 'https' ? 'HTTPS' : 'HTTP';
        const tgPort = firstEdge?.port ?? (tgProto === 'HTTPS' ? 443 : 8080);
        const targetType =
          firstTarget?.serviceId === 'aws.lambda'
            ? 'lambda'
            : firstTarget?.serviceId === 'aws.fargate'
              ? 'ip'
              : 'instance';

        if (lbType !== 'gateway' && vpcRef) {
          const tgName = `${name}_tg`;
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_lb_target_group', tgName],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${tgName}"`)),
                  ...(targetType !== 'lambda'
                    ? [
                        hclAttr('port', hclLit(tgPort)),
                        hclAttr('protocol', hclLit(tgProto)),
                        hclAttr('vpc_id', hclRef(`aws_vpc.${vpcRef}.id`)),
                      ]
                    : []),
                  hclAttr('target_type', hclLit(targetType)),
                ],
                ...(node.config.lb?.healthCheck
                  ? {
                      blocks: [
                        hclBlock('health_check', {
                          attributes: [
                            hclAttr('interval', hclLit(node.config.lb.healthCheck.intervalS)),
                            hclAttr(
                              'healthy_threshold',
                              hclLit(node.config.lb.healthCheck.healthyThreshold),
                            ),
                            hclAttr(
                              'unhealthy_threshold',
                              hclLit(node.config.lb.healthCheck.unhealthyThreshold),
                            ),
                            hclAttr(
                              'timeout',
                              hclLit(
                                Math.max(
                                  2,
                                  Math.round(node.config.lb.healthCheck.timeoutMs / 1000),
                                ),
                              ),
                            ),
                          ],
                        }),
                      ],
                    }
                  : {}),
              }),
            ),
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_lb_listener', `${name}_listener`],
                attributes: [
                  hclAttr('load_balancer_arn', hclRef(`aws_lb.${name}.arn`)),
                  hclAttr('port', hclLit(lbType === 'application' ? 80 : tgPort)),
                  hclAttr('protocol', hclLit(lbType === 'application' ? 'HTTP' : 'TCP')),
                ],
                blocks: [
                  hclBlock('default_action', {
                    attributes: [
                      hclAttr('type', hclLit('forward')),
                      hclAttr('target_group_arn', hclRef(`aws_lb_target_group.${tgName}.arn`)),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_lb_target_group.${tgName}`);
          ctx.recordAddress(node.id, `aws_lb_listener.${name}_listener`);

          for (const { target } of downstreams) {
            if (target.serviceId === 'aws.ec2' && !target.config.autoscaling) {
              const targetTf = nodeTfName.get(target.id)!;
              const tCount = Math.max(1, Math.round(target.config.instances || 1));
              buckets.compute.push(
                hclBlockStmt(
                  hclBlock('resource', {
                    labels: ['aws_lb_target_group_attachment', `${name}_to_${targetTf}`],
                    attributes: [
                      ...(tCount > 1 ? [hclAttr('count', hclLit(tCount))] : []),
                      hclAttr('target_group_arn', hclRef(`aws_lb_target_group.${tgName}.arn`)),
                      hclAttr(
                        'target_id',
                        hclRef(
                          tCount > 1
                            ? `aws_instance.${targetTf}[count.index].id`
                            : `aws_instance.${targetTf}.id`,
                        ),
                      ),
                      hclAttr('port', hclLit(tgPort)),
                    ],
                  }),
                ),
              );
            }
          }
        }

        ctx.addOutput({
          name: `${name}_dns_name`,
          description: `DNS endpoint for ${node.label}`,
          valueRef: `aws_lb.${name}.dns_name`,
        });
        break;
      }

      case 'aws.lambda': {
        const roleName = `${name}_exec_role`;
        const envEntries = envBlockEntries(ctx, node, name);
        const concurrency = node.config.coldStart?.concurrencyLimit;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', roleName],
              ...commentIf(ctx, [
                `Minimal IAM execution role generated automatically for Lambda ${node.label}.`,
              ]),
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${roleName}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Effect    = "Allow"\n      Principal = { Service = "lambda.amazonaws.com" }\n      Action    = "sts:AssumeRole"\n    }]\n  })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role_policy_attachment', `${roleName}_logs`],
              attributes: [
                hclAttr('role', hclRef(`aws_iam_role.${roleName}.name`)),
                hclAttr(
                  'policy_arn',
                  hclLit('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_lambda_function', name],
              ...commentIf(ctx, [`Serverless function: ${node.label}`]),
              attributes: [
                hclAttr('function_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('role', hclRef(`aws_iam_role.${roleName}.arn`)),
                hclAttr('handler', hclLit('index.handler')),
                hclAttr('runtime', hclLit('nodejs20.x')),
                hclAttr(
                  'memory_size',
                  hclLit(Math.max(128, Math.round((node.config.memoryGb ?? 0.5) * 1024))),
                ),
                hclAttr(
                  'timeout',
                  hclLit(
                    Math.max(1, Math.min(900, Math.round((node.config.timeoutMs ?? 15000) / 1000))),
                  ),
                ),
                ...(concurrency !== undefined
                  ? [hclAttr('reserved_concurrent_executions', hclLit(concurrency))]
                  : []),
              ],
              blocks: [
                ...(envEntries.length > 0
                  ? [
                      hclBlock('environment', {
                        attributes: [hclAttr('variables', hclMap(envEntries))],
                      }),
                    ]
                  : []),
                ...(subRef && sgName
                  ? [
                      hclBlock('vpc_config', {
                        attributes: [
                          hclAttr('subnet_ids', hclList([hclRef(`aws_subnet.${subRef}.id`)])),
                          hclAttr(
                            'security_group_ids',
                            hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                          ),
                        ],
                      }),
                    ]
                  : []),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_lambda_function.${name}`);

        for (const inEdge of inEdges) {
          const src = ctx.nodesById.get(inEdge.from);
          if (!src) continue;
          const srcName = nodeTfName.get(src.id);
          if (!srcName) continue;
          if (
            src.serviceId === 'aws.sqs' ||
            src.serviceId === 'aws.kinesis' ||
            src.serviceId === 'aws.msk'
          ) {
            const arnRef =
              src.serviceId === 'aws.sqs'
                ? `aws_sqs_queue.${srcName}.arn`
                : src.serviceId === 'aws.kinesis'
                  ? `aws_kinesis_stream.${srcName}.arn`
                  : `aws_msk_cluster.${srcName}.arn`;
            buckets.compute.push(
              hclBlockStmt(
                hclBlock('resource', {
                  labels: ['aws_lambda_event_source_mapping', `${srcName}_to_${name}`],
                  attributes: [
                    hclAttr('event_source_arn', hclRef(arnRef)),
                    hclAttr('function_name', hclRef(`aws_lambda_function.${name}.arn`)),
                    hclAttr('batch_size', hclLit(node.config.consumer?.batchSize ?? 10)),
                  ],
                }),
              ),
            );
          }
        }
        break;
      }

      case 'aws.apigw_http': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_apigatewayv2_api', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('protocol_type', hclLit('HTTP')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_apigatewayv2_stage', `${name}_default`],
              attributes: [
                hclAttr('api_id', hclRef(`aws_apigatewayv2_api.${name}.id`)),
                hclAttr('name', hclLit('$default')),
                hclAttr('auto_deploy', hclLit(true)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_apigatewayv2_api.${name}`);
        ctx.addOutput({
          name: `${name}_api_endpoint`,
          description: `API Gateway endpoint for ${node.label}`,
          valueRef: `aws_apigatewayv2_api.${name}.api_endpoint`,
        });
        break;
      }

      case 'aws.apigw_rest': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_api_gateway_rest_api', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('description', hclLit(`REST API for ${node.label}`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_api_gateway_rest_api.${name}`);
        break;
      }

      case 'aws.fargate':
      case 'aws.ecs_ec2': {
        const execRole = `${name}_ecs_exec_role`;
        const clusterName = `${name}_cluster`;
        const tdName = `${name}_task`;
        const svcSubs = subRef ? [subRef] : getVpcSubnets(vpcRef);
        const cpuUnits = Math.max(256, Math.round((node.config.vcpu ?? 0.5) * 1024));
        const memMb = Math.max(512, Math.round((node.config.memoryGb ?? 1) * 1024));
        const envs = envBlockEntries(ctx, node, name);

        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', execRole],
              ...commentIf(ctx, [`ECS task execution role for ${node.label}`]),
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${execRole}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Effect    = "Allow"\n      Principal = { Service = "ecs-tasks.amazonaws.com" }\n      Action    = "sts:AssumeRole"\n    }]\n  })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_ecs_cluster', clusterName],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${clusterName}"`))],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_ecs_task_definition', tdName],
              attributes: [
                hclAttr('family', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('network_mode', hclLit('awsvpc')),
                hclAttr(
                  'requires_compatibilities',
                  hclList([hclLit(node.serviceId === 'aws.fargate' ? 'FARGATE' : 'EC2')]),
                ),
                hclAttr('cpu', hclLit(String(cpuUnits))),
                hclAttr('memory', hclLit(String(memMb))),
                hclAttr('execution_role_arn', hclRef(`aws_iam_role.${execRole}.arn`)),
                hclAttr(
                  'container_definitions',
                  hclRaw(
                    `jsonencode([{\n    name      = "${name}"\n    image     = "public.ecr.aws/docker/library/nginx:alpine"\n    essential = true\n    portMappings = [{ containerPort = 8080, protocol = "tcp" }]${envs.length > 0 ? `\n    environment = [${envs.map(([k, v]) => `{ name = "${k}", value = ${v.kind === 'ref' ? v.path : JSON.stringify((v as { value: unknown }).value)} }`).join(', ')}]` : ''}\n  }])`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_ecs_service', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('cluster', hclRef(`aws_ecs_cluster.${clusterName}.id`)),
                hclAttr('task_definition', hclRef(`aws_ecs_task_definition.${tdName}.arn`)),
                hclAttr('desired_count', hclLit(instances)),
                hclAttr(
                  'launch_type',
                  hclLit(node.serviceId === 'aws.fargate' ? 'FARGATE' : 'EC2'),
                ),
              ],
              ...(svcSubs.length > 0
                ? {
                    blocks: [
                      hclBlock('network_configuration', {
                        attributes: [
                          hclAttr(
                            'subnets',
                            hclList(svcSubs.map((s) => hclRef(`aws_subnet.${s}.id`))),
                          ),
                          ...(sgName
                            ? [
                                hclAttr(
                                  'security_groups',
                                  hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                                ),
                              ]
                            : []),
                        ],
                      }),
                    ],
                  }
                : {}),
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_ecs_cluster.${clusterName}`);
        ctx.recordAddress(node.id, `aws_ecs_service.${name}`);
        break;
      }

      case 'aws.eks': {
        const clusterRole = `${name}_cluster_role`;
        const nodeRole = `${name}_node_role`;
        const eksSubs = getVpcSubnets(vpcRef);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', clusterRole],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${clusterRole}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = "sts:AssumeRole" }] })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', nodeRole],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${nodeRole}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_eks_cluster', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('role_arn', hclRef(`aws_iam_role.${clusterRole}.arn`)),
              ],
              blocks: [
                hclBlock('vpc_config', {
                  attributes: [
                    hclAttr(
                      'subnet_ids',
                      hclList(eksSubs.map((s) => hclRef(`aws_subnet.${s}.id`))),
                    ),
                  ],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_eks_node_group', `${name}_nodes`],
              attributes: [
                hclAttr('cluster_name', hclRef(`aws_eks_cluster.${name}.name`)),
                hclAttr('node_group_name', hclLit(`${name}-default`)),
                hclAttr('node_role_arn', hclRef(`aws_iam_role.${nodeRole}.arn`)),
                hclAttr('subnet_ids', hclList(eksSubs.map((s) => hclRef(`aws_subnet.${s}.id`)))),
                hclAttr(
                  'instance_types',
                  hclList([hclLit(node.config.instanceType || 't3.medium')]),
                ),
              ],
              blocks: [
                hclBlock('scaling_config', {
                  attributes: [
                    hclAttr('desired_size', hclLit(instances)),
                    hclAttr('min_size', hclLit(node.config.autoscaling?.min ?? 1)),
                    hclAttr(
                      'max_size',
                      hclLit(node.config.autoscaling?.max ?? Math.max(3, instances)),
                    ),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_eks_cluster.${name}`);
        ctx.recordAddress(node.id, `aws_eks_node_group.${name}_nodes`);
        break;
      }

      case 'aws.app_runner': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_apprunner_service', name],
              attributes: [hclAttr('service_name', hclRaw(`"\${var.name_prefix}-${name}"`))],
              blocks: [
                hclBlock('source_configuration', {
                  attributes: [hclAttr('auto_deployments_enabled', hclLit(false))],
                  blocks: [
                    hclBlock('image_repository', {
                      attributes: [
                        hclAttr(
                          'image_identifier',
                          hclLit('public.ecr.aws/aws-containers/hello-app-runner:latest'),
                        ),
                        hclAttr('image_repository_type', hclLit('ECR_PUBLIC')),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_apprunner_service.${name}`);
        break;
      }

      case 'aws.cloudfront': {
        const originTarget = outEdges
          .map((e) => ctx.nodesById.get(e.to))
          .find((n) => Boolean(n && (n.serviceId === 'aws.alb' || n.serviceId === 'aws.s3')));
        const originDomainExpr = originTarget
          ? originTarget.serviceId === 'aws.alb'
            ? hclRef(`aws_lb.${nodeTfName.get(originTarget.id)!}.dns_name`)
            : hclRef(
                `aws_s3_bucket.${nodeTfName.get(originTarget.id)!}.bucket_regional_domain_name`,
              )
          : hclRef(
              `var.${ctx.addVariable({ name: `${name}_origin_domain`, type: 'string', description: `TODO: origin domain name for CloudFront (${node.label})` })}`,
            );

        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_cloudfront_distribution', name],
              attributes: [
                hclAttr('enabled', hclLit(true)),
                hclAttr('comment', hclLit(`InfraSim CDN: ${node.label}`)),
              ],
              blocks: [
                hclBlock('origin', {
                  attributes: [
                    hclAttr('domain_name', originDomainExpr),
                    hclAttr('origin_id', hclLit(`${name}-origin`)),
                  ],
                  blocks: [
                    hclBlock('custom_origin_config', {
                      attributes: [
                        hclAttr('http_port', hclLit(80)),
                        hclAttr('https_port', hclLit(443)),
                        hclAttr('origin_protocol_policy', hclLit('https-only')),
                        hclAttr('origin_ssl_protocols', hclList([hclLit('TLSv1.2')])),
                      ],
                    }),
                  ],
                }),
                hclBlock('default_cache_behavior', {
                  attributes: [
                    hclAttr('allowed_methods', hclList([hclLit('GET'), hclLit('HEAD')])),
                    hclAttr('cached_methods', hclList([hclLit('GET'), hclLit('HEAD')])),
                    hclAttr('target_origin_id', hclLit(`${name}-origin`)),
                    hclAttr('viewer_protocol_policy', hclLit('redirect-to-https')),
                    hclAttr('cache_policy_id', hclLit('658327ea-f89d-4fab-a63d-7e88639e58f6')),
                  ],
                }),
                hclBlock('restrictions', {
                  blocks: [
                    hclBlock('geo_restriction', {
                      attributes: [hclAttr('restriction_type', hclLit('none'))],
                    }),
                  ],
                }),
                hclBlock('viewer_certificate', {
                  attributes: [hclAttr('cloudfront_default_certificate', hclLit(true))],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_cloudfront_distribution.${name}`);
        break;
      }

      case 'aws.rds_postgres':
      case 'aws.rds_mysql': {
        const isPg = node.serviceId === 'aws.rds_postgres';
        const passVar = ctx.addVariable({
          name: `${name}_master_password`,
          type: 'string',
          sensitive: true,
          description: `Master database password for ${node.label} (no default for safety).`,
        });
        const subGroup = getDbSubnetGroup(vpcRef, name);
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_db_instance', name],
              ...commentIf(ctx, [
                `Managed RDS database: ${node.label} (${isPg ? 'PostgreSQL' : 'MySQL'})`,
              ]),
              attributes: [
                hclAttr('identifier', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('engine', hclLit(isPg ? 'postgres' : 'mysql')),
                hclAttr('engine_version', hclLit(isPg ? '16' : '8.0')),
                hclAttr('instance_class', hclLit(node.config.instanceType || 'db.t3.micro')),
                hclAttr(
                  'allocated_storage',
                  hclLit(Math.max(20, Math.round(node.config.storageGb ?? 20))),
                ),
                hclAttr('username', hclLit('infrasim_admin')),
                hclAttr('password', hclRef(`var.${passVar}`)),
                ...(subGroup
                  ? [
                      hclAttr(
                        'db_subnet_group_name',
                        hclRef(`aws_db_subnet_group.${subGroup}.name`),
                      ),
                    ]
                  : []),
                ...(sgName
                  ? [
                      hclAttr(
                        'vpc_security_group_ids',
                        hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                      ),
                    ]
                  : []),
                hclAttr('multi_az', hclLit(instances > 1)),
                hclAttr('skip_final_snapshot', hclLit(true)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_db_instance.${name}`);
        ctx.addOutput({
          name: `${name}_endpoint`,
          description: `Connection endpoint for ${node.label}`,
          valueRef: `aws_db_instance.${name}.endpoint`,
        });
        break;
      }

      case 'aws.aurora_pg':
      case 'aws.aurora_mysql':
      case 'aws.aurora_serverless': {
        const isMysql = node.serviceId === 'aws.aurora_mysql';
        const isServerless = node.serviceId === 'aws.aurora_serverless';
        const passVar = ctx.addVariable({
          name: `${name}_master_password`,
          type: 'string',
          sensitive: true,
          description: `Master password for Aurora cluster ${node.label}.`,
        });
        const subGroup = getDbSubnetGroup(vpcRef, name);
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_rds_cluster', name],
              attributes: [
                hclAttr('cluster_identifier', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('engine', hclLit(isMysql ? 'aurora-mysql' : 'aurora-postgresql')),
                hclAttr('master_username', hclLit('infrasim_admin')),
                hclAttr('master_password', hclRef(`var.${passVar}`)),
                ...(subGroup
                  ? [
                      hclAttr(
                        'db_subnet_group_name',
                        hclRef(`aws_db_subnet_group.${subGroup}.name`),
                      ),
                    ]
                  : []),
                ...(sgName
                  ? [
                      hclAttr(
                        'vpc_security_group_ids',
                        hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                      ),
                    ]
                  : []),
                hclAttr('skip_final_snapshot', hclLit(true)),
              ],
              ...(isServerless
                ? {
                    blocks: [
                      hclBlock('serverlessv2_scaling_configuration', {
                        attributes: [
                          hclAttr('min_capacity', hclLit(0.5)),
                          hclAttr('max_capacity', hclLit(8.0)),
                        ],
                      }),
                    ],
                  }
                : {}),
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_rds_cluster_instance', `${name}_writer`],
              attributes: [
                ...(instances > 1 ? [hclAttr('count', hclLit(instances))] : []),
                hclAttr('identifier', hclRaw(`"\${var.name_prefix}-${name}-node"`)),
                hclAttr('cluster_identifier', hclRef(`aws_rds_cluster.${name}.id`)),
                hclAttr(
                  'instance_class',
                  hclLit(
                    isServerless ? 'db.serverless' : node.config.instanceType || 'db.r6g.large',
                  ),
                ),
                hclAttr('engine', hclRef(`aws_rds_cluster.${name}.engine`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_rds_cluster.${name}`);
        ctx.recordAddress(node.id, `aws_rds_cluster_instance.${name}_writer`);
        break;
      }

      case 'aws.rds_proxy': {
        const roleName = `${name}_proxy_role`;
        const secretArnVar = ctx.addVariable({
          name: `${name}_secret_arn`,
          type: 'string',
          description: `TODO: Secrets Manager ARN holding DB credentials for RDS Proxy ${node.label}`,
        });
        const subs = getVpcSubnets(vpcRef);
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', roleName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${roleName}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "rds.amazonaws.com" }, Action = "sts:AssumeRole" }] })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_db_proxy', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('engine_family', hclLit('POSTGRESQL')),
                hclAttr('role_arn', hclRef(`aws_iam_role.${roleName}.arn`)),
                hclAttr('vpc_subnet_ids', hclList(subs.map((s) => hclRef(`aws_subnet.${s}.id`)))),
                ...(sgName
                  ? [
                      hclAttr(
                        'vpc_security_group_ids',
                        hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                      ),
                    ]
                  : []),
              ],
              blocks: [
                hclBlock('auth', {
                  attributes: [
                    hclAttr('auth_scheme', hclLit('SECRETS')),
                    hclAttr('iam_auth', hclLit('DISABLED')),
                    hclAttr('secret_arn', hclRef(`var.${secretArnVar}`)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_db_proxy.${name}`);
        break;
      }

      case 'aws.dynamodb': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_dynamodb_table', name],
              ...commentIf(ctx, [`DynamoDB NoSQL table: ${node.label}`]),
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('billing_mode', hclLit('PAY_PER_REQUEST')),
                hclAttr('hash_key', hclLit('pk')),
              ],
              blocks: [
                hclBlock('attribute', {
                  attributes: [hclAttr('name', hclLit('pk')), hclAttr('type', hclLit('S'))],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_dynamodb_table.${name}`);
        break;
      }

      case 'aws.elasticache_redis':
      case 'aws.elasticache_memcached': {
        const isRedis = node.serviceId === 'aws.elasticache_redis';
        const cacheSubs = state.defaultPrivateSubnetRefs.filter(
          (s) => state.subnetVpcRefBySubnetTfName.get(s) === vpcRef,
        );
        const subGroupSubs = cacheSubs.length > 0 ? cacheSubs : getVpcSubnets(vpcRef);
        const subGroup = subGroupSubs.length > 0 ? `${name}_subgrp` : undefined;
        if (subGroup) {
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_elasticache_subnet_group', subGroup],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${subGroup}"`)),
                  hclAttr(
                    'subnet_ids',
                    hclList(subGroupSubs.map((s) => hclRef(`aws_subnet.${s}.id`))),
                  ),
                ],
              }),
            ),
          );
        }
        if (isRedis) {
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_elasticache_replication_group', name],
                attributes: [
                  hclAttr('replication_group_id', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('description', hclLit(`Redis cache for ${node.label}`)),
                  hclAttr('engine', hclLit('redis')),
                  hclAttr('node_type', hclLit(node.config.instanceType || 'cache.t3.micro')),
                  hclAttr('num_cache_clusters', hclLit(instances)),
                  hclAttr('port', hclLit(6379)),
                  ...(subGroup
                    ? [
                        hclAttr(
                          'subnet_group_name',
                          hclRef(`aws_elasticache_subnet_group.${subGroup}.name`),
                        ),
                      ]
                    : []),
                  ...(sgName
                    ? [
                        hclAttr(
                          'security_group_ids',
                          hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                        ),
                      ]
                    : []),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_elasticache_replication_group.${name}`);
        } else {
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['aws_elasticache_cluster', name],
                attributes: [
                  hclAttr('cluster_id', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('engine', hclLit('memcached')),
                  hclAttr('node_type', hclLit(node.config.instanceType || 'cache.t3.micro')),
                  hclAttr('num_cache_nodes', hclLit(instances)),
                  hclAttr('port', hclLit(11211)),
                  ...(subGroup
                    ? [
                        hclAttr(
                          'subnet_group_name',
                          hclRef(`aws_elasticache_subnet_group.${subGroup}.name`),
                        ),
                      ]
                    : []),
                  ...(sgName
                    ? [
                        hclAttr(
                          'security_group_ids',
                          hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                        ),
                      ]
                    : []),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `aws_elasticache_cluster.${name}`);
        }
        break;
      }

      case 'aws.s3': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_s3_bucket', name],
              ...commentIf(ctx, [`Object storage bucket: ${node.label}`]),
              attributes: [hclAttr('bucket', hclRaw(`"\${var.name_prefix}-${name}"`))],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_s3_bucket_public_access_block', `${name}_pab`],
              attributes: [
                hclAttr('bucket', hclRef(`aws_s3_bucket.${name}.id`)),
                hclAttr('block_public_acls', hclLit(true)),
                hclAttr('block_public_policy', hclLit(true)),
                hclAttr('ignore_public_acls', hclLit(true)),
                hclAttr('restrict_public_buckets', hclLit(true)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_s3_bucket.${name}`);
        break;
      }

      case 'aws.ebs': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_ebs_volume', name],
              attributes: [
                hclAttr('availability_zone', hclRaw(`"\${var.${awsRegionVar}}a"`)),
                hclAttr('size', hclLit(Math.max(8, Math.round(node.config.storageGb ?? 50)))),
                hclAttr('type', hclLit('gp3')),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${name}"`)]])),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_ebs_volume.${name}`);
        break;
      }

      case 'aws.efs': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_efs_file_system', name],
              attributes: [
                hclAttr('encrypted', hclLit(true)),
                hclAttr('tags', hclMap([['Name', hclRaw(`"\${var.name_prefix}-${name}"`)]])),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_efs_file_system.${name}`);
        break;
      }

      case 'aws.sqs': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_sqs_queue', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_sqs_queue.${name}`);
        break;
      }

      case 'aws.sns': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_sns_topic', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_sns_topic.${name}`);
        for (const edge of outEdges) {
          const target = ctx.nodesById.get(edge.to);
          if (!target) continue;
          const tName = nodeTfName.get(target.id);
          if (target.serviceId === 'aws.sqs' && tName) {
            buckets.data.push(
              hclBlockStmt(
                hclBlock('resource', {
                  labels: ['aws_sns_topic_subscription', `${name}_to_${tName}`],
                  attributes: [
                    hclAttr('topic_arn', hclRef(`aws_sns_topic.${name}.arn`)),
                    hclAttr('protocol', hclLit('sqs')),
                    hclAttr('endpoint', hclRef(`aws_sqs_queue.${tName}.arn`)),
                  ],
                }),
              ),
            );
          } else if (target.serviceId === 'aws.lambda' && tName) {
            buckets.data.push(
              hclBlockStmt(
                hclBlock('resource', {
                  labels: ['aws_sns_topic_subscription', `${name}_to_${tName}`],
                  attributes: [
                    hclAttr('topic_arn', hclRef(`aws_sns_topic.${name}.arn`)),
                    hclAttr('protocol', hclLit('lambda')),
                    hclAttr('endpoint', hclRef(`aws_lambda_function.${tName}.arn`)),
                  ],
                }),
              ),
            );
          }
        }
        break;
      }

      case 'aws.kinesis': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_kinesis_stream', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('shard_count', hclLit(instances)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_kinesis_stream.${name}`);
        break;
      }

      case 'aws.msk': {
        const mskSubs =
          state.defaultPrivateSubnetRefs.length >= 2
            ? state.defaultPrivateSubnetRefs.slice(0, 2)
            : getVpcSubnets(vpcRef);
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_msk_cluster', name],
              attributes: [
                hclAttr('cluster_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('kafka_version', hclLit('3.6.0')),
                hclAttr('number_of_broker_nodes', hclLit(Math.max(2, instances))),
              ],
              blocks: [
                hclBlock('broker_node_group_info', {
                  attributes: [
                    hclAttr('instance_type', hclLit(node.config.instanceType || 'kafka.t3.small')),
                    hclAttr(
                      'client_subnets',
                      hclList(mskSubs.map((s) => hclRef(`aws_subnet.${s}.id`))),
                    ),
                    ...(sgName
                      ? [
                          hclAttr(
                            'security_groups',
                            hclList([hclRef(`aws_security_group.${sgName}.id`)]),
                          ),
                        ]
                      : []),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_msk_cluster.${name}`);
        break;
      }

      case 'aws.eventbridge': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_cloudwatch_event_bus', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_cloudwatch_event_bus.${name}`);
        break;
      }

      case 'aws.secrets_manager': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_secretsmanager_secret', name],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}/${name}"`))],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_secretsmanager_secret.${name}`);
        break;
      }

      case 'aws.ssm_parameter': {
        const valVar = ctx.addVariable({
          name: `${name}_value`,
          type: 'string',
          sensitive: true,
          description: `Sensitive parameter value for ${node.label}.`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_ssm_parameter', name],
              attributes: [
                hclAttr('name', hclRaw(`"/\${var.name_prefix}/${name}"`)),
                hclAttr('type', hclLit('SecureString')),
                hclAttr('value', hclRef(`var.${valVar}`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_ssm_parameter.${name}`);
        break;
      }

      case 'aws.kms': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_kms_key', name],
              attributes: [
                hclAttr('description', hclLit(`Encryption key for ${node.label}`)),
                hclAttr('enable_key_rotation', hclLit(true)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_kms_key.${name}`);
        break;
      }

      case 'aws.sagemaker_endpoint': {
        const roleName = `${name}_sm_role`;
        const modelName = `${name}_model`;
        const cfgName = `${name}_cfg`;
        const imageVar = ctx.addVariable({
          name: `${name}_container_image`,
          type: 'string',
          description: `TODO: ECR container image URI for SageMaker model (${node.label})`,
        });
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_role', roleName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${roleName}"`)),
                hclAttr(
                  'assume_role_policy',
                  hclRaw(
                    `jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "sagemaker.amazonaws.com" }, Action = "sts:AssumeRole" }] })`,
                  ),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_sagemaker_model', modelName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${modelName}"`)),
                hclAttr('execution_role_arn', hclRef(`aws_iam_role.${roleName}.arn`)),
              ],
              blocks: [
                hclBlock('primary_container', {
                  attributes: [hclAttr('image', hclRef(`var.${imageVar}`))],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_sagemaker_endpoint_configuration', cfgName],
              attributes: [hclAttr('name', hclRaw(`"\${var.name_prefix}-${cfgName}"`))],
              blocks: [
                hclBlock('production_variants', {
                  attributes: [
                    hclAttr('variant_name', hclLit('AllTraffic')),
                    hclAttr('model_name', hclRef(`aws_sagemaker_model.${modelName}.name`)),
                    hclAttr('initial_instance_count', hclLit(instances)),
                    hclAttr('instance_type', hclLit(node.config.instanceType || 'ml.m5.large')),
                  ],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_sagemaker_endpoint', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr(
                  'endpoint_config_name',
                  hclRef(`aws_sagemaker_endpoint_configuration.${cfgName}.name`),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_sagemaker_endpoint.${name}`);
        break;
      }

      case 'aws.bedrock': {
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['aws_iam_policy', `${name}_invoke`],
              ...commentIf(ctx, [
                `Amazon Bedrock (${node.label}): foundation models are invoked via API rather than provisioned as instances.`,
                'Grant least-privilege bedrock:InvokeModel permission to caller compute roles.',
              ]),
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}-invoke"`)),
                hclAttr(
                  'policy',
                  hclRaw(
                    `jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Effect   = "Allow"\n      Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]\n      Resource = "arn:aws:bedrock:*::foundation-model/${node.config.ai?.modelLabel ?? '*'}"\n    }]\n  })`,
                  ),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `aws_iam_policy.${name}_invoke`);
        break;
      }

      default: {
        const msg = `InfraSim: no Terraform mapping for ${node.serviceId} (${node.label})`;
        const bucketTarget = node.serviceId.includes('bedrock') ? buckets.ai : buckets.compute;
        bucketTarget.push(hclCommentStmt(msg));
        ctx.addUnsupported(node, `No v1 AWS Terraform resource mapping for ${node.serviceId}`);
        break;
      }
    }
  }
}

export function buildAwsProviderBlockStatements(): HclStatement[] {
  return [];
}
