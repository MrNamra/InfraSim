import {
  createEmptyNetworkConfig,
  type Attachment,
  type DnsZone,
  type FirewallObject,
  type FirewallRule,
  type Gateway,
  type GroupInstance,
  type Network,
  type NodeInstance,
  type Peering,
  type PrivateEndpoint,
  type RouteTable,
  type RouteTarget,
  type Selector,
  type Subnet,
} from '@infrasim/shared-types';
import { snakeCaseSlug } from '../naming.js';
import { extractResourceAddressFromRef } from './parser.js';
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function normalizeProtocol(proto: unknown): FirewallRule['protocol'] {
  if (typeof proto === 'number') {
    if (proto === 6) return 'tcp';
    if (proto === 17) return 'udp';
    if (proto === 1) return 'icmp';
    return 'any';
  }
  const s = typeof proto === 'string' ? proto.trim().toLowerCase() : '';
  if (s === 'tcp' || s === '6') return 'tcp';
  if (s === 'udp' || s === '17') return 'udp';
  if (s === 'icmp' || s === '1') return 'icmp';
  return 'any';
}

function uniqueId(used: Set<string>, base: string): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

export interface TopologyBuildOutput {
  groups: GroupInstance[];
  nodes: NodeInstance[];
  network: Required<ReturnType<typeof createEmptyNetworkConfig>>;
  /** Maps canonical resource address (`aws_vpc.main` / `module.x.aws_subnet.a`) -> InfraSim node or group ID. */
  addressToEntityId: Map<string, string>;
  /** Maps base resource address -> matching full classified resource(s). */
  resourcesByAddress: Map<string, ClassifiedResource>;
  /** Maps SG/Firewall resource address -> InfraSim firewallId. */
  addressToFirewallId: Map<string, string>;
  /** Maps InfraSim firewallId -> attached InfraSim node IDs. */
  firewallIdToNodeIds: Map<string, string[]>;
  /** Maps group ID (VPC/subnet) -> GroupInstance. */
  groupsById: Map<string, GroupInstance>;
  /** Maps node ID -> NodeInstance. */
  nodesById: Map<string, NodeInstance>;
  /** Maps DNS zone address -> DNS zone ID. */
  addressToDnsZoneId: Map<string, string>;
  /** Helper lookup for expression ref resolution from any classified resource. */
  resolveRefTargets: (res: NormalizedPlanResource, attrNames?: string[]) => ClassifiedResource[];
}

/**
 * Reconstructs containment hierarchy (`groups`, `node.parentGroupId`) and full `NetworkConfig`
 * (networks, subnets, route tables, gateways, firewalls, peerings, endpoints, DNS zones, attachments).
 */
export function buildTopologyAndNetwork(classified: ClassifiedResource[]): TopologyBuildOutput {
  const network = createEmptyNetworkConfig();
  const usedIds = new Set<string>();
  const resourcesByAddress = new Map<string, ClassifiedResource>();
  const resourcesByBaseAddress = new Map<string, ClassifiedResource[]>();
  const resourcesByValueId = new Map<string, ClassifiedResource>();

  for (const item of classified) {
    resourcesByAddress.set(item.resource.address, item);
    const list = resourcesByBaseAddress.get(item.resource.baseAddress) ?? [];
    list.push(item);
    resourcesByBaseAddress.set(item.resource.baseAddress, list);

    const v = item.resource.values;
    for (const idField of [v.id, v.arn, v.self_link]) {
      if (typeof idField === 'string' && idField.trim() && !idField.startsWith('(')) {
        resourcesByValueId.set(idField.trim(), item);
      }
    }
  }

  const resolveSingleAddress = (addr: string): ClassifiedResource | undefined => {
    const exact = resourcesByAddress.get(addr);
    if (exact) return exact;
    const baseList = resourcesByBaseAddress.get(addr);
    if (baseList && baseList.length > 0) return baseList[0];
    return undefined;
  };

  const resolveRefTargets = (
    res: NormalizedPlanResource,
    attrNames?: string[],
  ): ClassifiedResource[] => {
    const found: ClassifiedResource[] = [];
    const seen = new Set<string>();

    const addMatch = (item: ClassifiedResource | undefined) => {
      if (item && !seen.has(item.resource.address)) {
        seen.add(item.resource.address);
        found.push(item);
      }
    };

    const candidateRefStrings: string[] = [];
    if (attrNames && attrNames.length > 0) {
      for (const attr of attrNames) {
        const refs = res.referencesByAttr[attr];
        if (refs) candidateRefStrings.push(...refs);
        const val = res.values[attr];
        if (typeof val === 'string' && resourcesByValueId.has(val)) {
          addMatch(resourcesByValueId.get(val));
        } else if (Array.isArray(val)) {
          for (const entry of val) {
            if (typeof entry === 'string' && resourcesByValueId.has(entry)) {
              addMatch(resourcesByValueId.get(entry));
            }
          }
        }
      }
    } else {
      candidateRefStrings.push(...res.allReferences);
    }

    for (const rawRef of candidateRefStrings) {
      const targetAddr = extractResourceAddressFromRef(rawRef, res.moduleAddress);
      if (targetAddr) {
        addMatch(resolveSingleAddress(targetAddr));
      }
    }

    return found;
  };

  const addressToEntityId = new Map<string, string>();
  const addressToFirewallId = new Map<string, string>();
  const addressToDnsZoneId = new Map<string, string>();
  const vpcGroupByAddr = new Map<string, GroupInstance>();
  const subnetGroupByAddr = new Map<string, GroupInstance>();
  const subnetObjByGroupId = new Map<string, Subnet>();
  const groups: GroupInstance[] = [];
  const groupsById = new Map<string, GroupInstance>();

  // 1. Build VPC / VNet / VCN groups & Network entries
  const vpcResources = classified.filter(
    (c) => c.classification === 'group' && c.groupKind === 'vpc',
  );
  for (const item of vpcResources) {
    const gid = uniqueId(usedIds, `grp-${snakeCaseSlug(item.resource.name, 'vpc')}`);
    const cidr = item.cidr ?? '10.0.0.0/16';
    const group: GroupInstance = {
      id: gid,
      kind: 'vpc',
      label: item.label,
      ...(item.provider ? { provider: item.provider } : {}),
      ...(item.region ? { region: item.region } : {}),
      cidr,
      position: { x: 0, y: 0 },
      size: { width: 512, height: 352 },
    };
    const netObj: Network = {
      id: `net-${gid}`,
      provider: item.provider ?? 'aws',
      ...(item.region ? { region: item.region } : {}),
      cidrs: [cidr],
      name: item.label,
    };
    groups.push(group);
    groupsById.set(gid, group);
    network.networks.push(netObj);
    addressToEntityId.set(item.resource.address, gid);
    vpcGroupByAddr.set(item.resource.address, group);
  }

  // 2. Build Subnet groups & Subnet entries anchored to parent VPC
  const subnetResources = classified.filter(
    (c) => c.classification === 'group' && c.groupKind === 'subnet',
  );
  for (const item of subnetResources) {
    const targets = resolveRefTargets(item.resource, [
      'vpc_id',
      'network',
      'virtual_network_name',
      'vcn_id',
    ]);
    let parentVpc = targets.find((t) => t.classification === 'group' && t.groupKind === 'vpc');
    if (!parentVpc) {
      // Fallback: same module & provider VPC, or sole VPC for that provider
      const sameProviderVpcs = vpcResources.filter((v) => v.provider === item.provider);
      parentVpc =
        sameProviderVpcs.find((v) => v.resource.moduleAddress === item.resource.moduleAddress) ??
        (sameProviderVpcs.length === 1 ? sameProviderVpcs[0] : undefined);
    }

    const parentGroup = parentVpc ? vpcGroupByAddr.get(parentVpc.resource.address) : undefined;
    const gid = uniqueId(usedIds, `grp-${snakeCaseSlug(item.resource.name, 'subnet')}`);
    const cidr = item.cidr ?? '10.0.1.0/24';
    const group: GroupInstance = {
      id: gid,
      kind: 'subnet',
      label: item.label,
      ...(item.provider ? { provider: item.provider } : {}),
      ...(item.region ? { region: item.region } : {}),
      cidr,
      ...(parentGroup ? { parentGroupId: parentGroup.id } : {}),
      ...(item.isPublicSubnet !== undefined ? { public: item.isPublicSubnet } : {}),
      position: { x: 0, y: 0 },
      size: { width: 288, height: 224 },
    };

    const rtId = `rt-default-${gid}`;
    const subObj: Subnet = {
      id: `sub-${gid}`,
      networkId: parentGroup ? `net-${parentGroup.id}` : (network.networks[0]?.id ?? 'net-default'),
      cidr,
      ...(item.az ? { az: item.az } : {}),
      routeTableId: rtId,
      ...(item.isPublicSubnet !== undefined ? { autoAssignPublicIp: item.isPublicSubnet } : {}),
      firewallIds: [],
    };
    network.routeTables.push({
      id: rtId,
      routes: [{ dest: cidr, target: { kind: 'local' } }],
    });

    groups.push(group);
    groupsById.set(gid, group);
    network.subnets.push(subObj);
    addressToEntityId.set(item.resource.address, gid);
    subnetGroupByAddr.set(item.resource.address, group);
    subnetObjByGroupId.set(gid, subObj);
  }

  // Helper: map subnet resource address -> Subnet object & GroupInstance
  const subnetGroupForResource = (item: ClassifiedResource): GroupInstance | undefined =>
    subnetGroupByAddr.get(item.resource.address);

  // 3. Build Gateways (IGW, NAT, TGW, DRG, Service GW)
  const gatewayIdByAddr = new Map<string, string>();
  const findVpcGroupForResource = (res: NormalizedPlanResource): GroupInstance | undefined => {
    const refs = resolveRefTargets(res, ['vpc_id', 'network', 'vcn_id', 'router']);
    for (const t of refs) {
      if (vpcGroupByAddr.has(t.resource.address)) return vpcGroupByAddr.get(t.resource.address);
      if (t.resource.type === 'google_compute_router') {
        const routerRefs = resolveRefTargets(t.resource, ['network']);
        for (const rt of routerRefs) {
          if (vpcGroupByAddr.has(rt.resource.address)) {
            return vpcGroupByAddr.get(rt.resource.address);
          }
        }
      }
    }
    const subRefs = resolveRefTargets(res, ['subnet_id', 'subnetwork']);
    for (const s of subRefs) {
      const subGrp = subnetGroupForResource(s);
      if (subGrp?.parentGroupId && groupsById.has(subGrp.parentGroupId)) {
        return groupsById.get(subGrp.parentGroupId);
      }
    }
    return undefined;
  };

  for (const item of classified) {
    const rType = item.resource.type;
    let gwKind: Gateway['kind'] | undefined;
    if (rType === 'aws_internet_gateway' || rType === 'oci_core_internet_gateway') gwKind = 'igw';
    else if (
      rType === 'aws_nat_gateway' ||
      rType === 'google_compute_router_nat' ||
      rType === 'azurerm_nat_gateway' ||
      rType === 'oci_core_nat_gateway'
    ) {
      gwKind = 'nat';
    } else if (rType === 'aws_ec2_transit_gateway') gwKind = 'tgw';
    else if (rType === 'oci_core_drg') gwKind = 'drg';
    else if (rType === 'oci_core_service_gateway') gwKind = 'service-gw';

    if (!gwKind) continue;
    const vpcGrp = findVpcGroupForResource(item.resource);
    const subRefs = resolveRefTargets(item.resource, ['subnet_id', 'subnetwork']);
    const subGrp = subRefs.map(subnetGroupForResource).find(Boolean);
    const gwId = uniqueId(usedIds, `gw-${snakeCaseSlug(item.resource.name, gwKind)}`);
    network.gateways.push({
      id: gwId,
      kind: gwKind,
      ...(vpcGrp ? { networkId: `net-${vpcGrp.id}` } : {}),
      ...(subGrp ? { subnetId: `sub-${subGrp.id}` } : {}),
      ...(gwKind === 'igw' || gwKind === 'nat' ? { publicIp: true } : {}),
    });
    gatewayIdByAddr.set(item.resource.address, gwId);
  }

  // 4. Build Peerings & Endpoints & DNS Zones
  const peeringIdByAddr = new Map<string, string>();
  for (const item of classified.filter((c) => c.networkRole === 'peering')) {
    const refs = resolveRefTargets(item.resource);
    const vpcs = refs.filter((t) => vpcGroupByAddr.has(t.resource.address));
    const aNet = vpcs[0]
      ? `net-${vpcGroupByAddr.get(vpcs[0].resource.address)!.id}`
      : network.networks[0]?.id;
    const bNet = vpcs[1]
      ? `net-${vpcGroupByAddr.get(vpcs[1].resource.address)!.id}`
      : 'external-peer';
    if (!aNet) continue;
    const peerId = uniqueId(usedIds, `peer-${snakeCaseSlug(item.resource.name, 'peer')}`);
    const peerObj: Peering = {
      id: peerId,
      a: aNet,
      b: bNet,
      routedA: true,
      routedB: true,
      transitive: false,
    };
    network.peerings.push(peerObj);
    peeringIdByAddr.set(item.resource.address, peerId);
  }

  // Route tables & associations (determines public vs private AWS subnets)
  const routeTableByAddr = new Map<string, RouteTable>();
  const resolveRouteTarget = (res: NormalizedPlanResource): RouteTarget | undefined => {
    const allRefs = resolveRefTargets(res);
    for (const target of allRefs) {
      const gwId = gatewayIdByAddr.get(target.resource.address);
      if (gwId) {
        const gwObj = network.gateways.find((g) => g.id === gwId);
        if (gwObj?.kind === 'igw') return { kind: 'igw' };
        if (gwObj?.kind === 'nat') return { kind: 'nat', gatewayId: gwId };
        if (gwObj?.kind === 'tgw') return { kind: 'tgw', id: gwId };
      }
      const pId = peeringIdByAddr.get(target.resource.address);
      if (pId) return { kind: 'peering', id: pId };
    }
    if (res.referencesByAttr.gateway_id?.some((r) => r.includes('internet_gateway'))) {
      return { kind: 'igw' };
    }
    return undefined;
  };

  for (const item of classified.filter((c) => c.networkRole === 'route_table')) {
    const rtId = uniqueId(usedIds, `rt-${snakeCaseSlug(item.resource.name, 'rt')}`);
    const vpcGrp = findVpcGroupForResource(item.resource);
    const localCidr = vpcGrp?.cidr ?? '10.0.0.0/16';
    const routes: RouteTable['routes'] = [{ dest: localCidr, target: { kind: 'local' } }];
    if (Array.isArray(item.resource.values.route)) {
      for (const inlineRoute of item.resource.values.route) {
        if (!isPlainObject(inlineRoute)) continue;
        const dest = asString(inlineRoute.cidr_block);
        if (dest && asString(inlineRoute.gateway_id)) {
          routes.push({ dest, target: { kind: 'igw' } });
        } else if (dest && asString(inlineRoute.nat_gateway_id)) {
          const natGw = network.gateways.find((g) => g.kind === 'nat');
          if (natGw) routes.push({ dest, target: { kind: 'nat', gatewayId: natGw.id } });
        }
      }
    }
    const rt: RouteTable = { id: rtId, routes };
    network.routeTables.push(rt);
    routeTableByAddr.set(item.resource.address, rt);
  }

  for (const item of classified.filter((c) => c.networkRole === 'route')) {
    const rtRefs = resolveRefTargets(item.resource, ['route_table_id']);
    const rtItem = rtRefs.find((t) => routeTableByAddr.has(t.resource.address));
    if (!rtItem) continue;
    const rt = routeTableByAddr.get(rtItem.resource.address)!;
    const dest = asString(item.resource.values.destination_cidr_block) ?? '0.0.0.0/0';
    const target = resolveRouteTarget(item.resource);
    if (target && !rt.routes.some((r) => r.dest === dest)) {
      rt.routes.push({ dest, target });
    }
  }

  for (const item of classified.filter((c) => c.networkRole === 'route_assoc')) {
    const subTargets = resolveRefTargets(item.resource, ['subnet_id']);
    const rtTargets = resolveRefTargets(item.resource, ['route_table_id']);
    const subGrp = subTargets.map(subnetGroupForResource).find(Boolean);
    const rtItem = rtTargets.find((t) => routeTableByAddr.has(t.resource.address));
    if (!subGrp || !rtItem) continue;
    const rt = routeTableByAddr.get(rtItem.resource.address)!;
    const subObj = subnetObjByGroupId.get(subGrp.id);
    if (subObj) {
      const oldDefaultRtId = subObj.routeTableId;
      subObj.routeTableId = rt.id;
      if (oldDefaultRtId.startsWith('rt-default-')) {
        const idx = network.routeTables.findIndex((r) => r.id === oldDefaultRtId);
        if (idx >= 0) network.routeTables.splice(idx, 1);
      }
    }
    if (rt.routes.some((r) => r.dest === '0.0.0.0/0' && r.target.kind === 'igw')) {
      subGrp.public = true;
      if (subObj) subObj.autoAssignPublicIp = true;
    }
  }

  // Fallback for subnets marked public/internet-facing when no explicit route_table_association
  for (const subGrp of subnetGroupByAddr.values()) {
    const subObj = subnetObjByGroupId.get(subGrp.id);
    if (!subObj) continue;
    const rt = network.routeTables.find((r) => r.id === subObj.routeTableId);
    if (subGrp.public === true && rt && !rt.routes.some((r) => r.dest === '0.0.0.0/0')) {
      rt.routes.push({ dest: '0.0.0.0/0', target: { kind: 'igw' } });
    }
  }

  // 5. Build Firewalls (SG, NACL, GCP FW, Azure NSG, OCI NSG / Security List)
  const fwByAddr = new Map<string, FirewallObject>();
  const makeFw = (
    addr: string,
    idHint: string,
    kind: FirewallObject['kind'],
    stateful: boolean,
  ): FirewallObject => {
    const fwId = uniqueId(usedIds, idHint);
    const fw: FirewallObject = {
      id: fwId,
      kind,
      stateful,
      rules: [],
      attachedTo: { nodeIds: [], subnetIds: [], tags: [] },
    };
    network.firewalls.push(fw);
    fwByAddr.set(addr, fw);
    addressToFirewallId.set(addr, fwId);
    return fw;
  };

  for (const item of classified) {
    if (item.networkRole === 'sg') {
      const fw = makeFw(
        item.resource.address,
        `sg-${snakeCaseSlug(item.resource.name, 'sg')}`,
        'sg',
        true,
      );
      const parseInlineRules = (dir: 'ingress' | 'egress', blocks: unknown) => {
        if (!Array.isArray(blocks)) return;
        blocks.forEach((b, idx) => {
          if (!isPlainObject(b)) return;
          const proto = normalizeProtocol(b.protocol);
          const fromPort = asNumber(b.from_port);
          const toPort = asNumber(b.to_port);
          const cidrs = asStringArray(b.cidr_blocks);
          const sgVals = asStringArray(b.security_groups);
          let peerSg = sgVals
            .map((idStr) => resourcesByValueId.get(idStr))
            .map((r) => (r ? fwByAddr.get(r.resource.address) : undefined))
            .find(Boolean);
          if (!peerSg) {
            const pathRefs = item.resource.referencesByAttr[`${dir}.${idx}.security_groups`] ?? [];
            peerSg = pathRefs
              .map((ref) => extractResourceAddressFromRef(ref, item.resource.moduleAddress))
              .map((addr) => (addr ? fwByAddr.get(addr) : undefined))
              .find(Boolean);
          }
          const selector: Selector = peerSg
            ? { firewallId: peerSg.id }
            : cidrs[0]
              ? { cidr: cidrs[0] }
              : { any: true };
          fw.rules.push({
            id: `${fw.id}-${dir}-${idx}`,
            direction: dir,
            action: 'allow',
            protocol: proto,
            ...(fromPort !== undefined ? { portFrom: fromPort } : {}),
            ...(toPort !== undefined ? { portTo: toPort } : {}),
            ...(dir === 'ingress' ? { source: selector } : { destination: selector }),
          });
        });
      };
      parseInlineRules('ingress', item.resource.values.ingress);
      parseInlineRules('egress', item.resource.values.egress);
    } else if (item.networkRole === 'nacl') {
      const fw = makeFw(
        item.resource.address,
        `nacl-${snakeCaseSlug(item.resource.name, 'nacl')}`,
        'nacl',
        false,
      );
      for (const sRef of resolveRefTargets(item.resource, ['subnet_ids'])) {
        const subGrp = subnetGroupForResource(sRef);
        const subObj = subGrp ? subnetObjByGroupId.get(subGrp.id) : undefined;
        if (subObj) {
          fw.attachedTo?.subnetIds?.push(subObj.id);
          subObj.firewallIds = [...(subObj.firewallIds ?? []), fw.id];
        }
      }
    } else if (item.networkRole === 'nsg') {
      makeFw(
        item.resource.address,
        `nsg-${snakeCaseSlug(item.resource.name, 'nsg')}`,
        item.provider === 'oci' ? 'oci-nsg' : 'nsg',
        true,
      );
    } else if (item.networkRole === 'security_list') {
      makeFw(
        item.resource.address,
        `sl-${snakeCaseSlug(item.resource.name, 'sl')}`,
        'oci-sl',
        true,
      );
    } else if (item.networkRole === 'firewall') {
      const fw = makeFw(
        item.resource.address,
        `gcpfw-${snakeCaseSlug(item.resource.name, 'fw')}`,
        'gcp-fw',
        true,
      );
      const targetTags = asStringArray(item.resource.values.target_tags);
      const sourceTags = asStringArray(item.resource.values.source_tags);
      const sourceRanges = asStringArray(item.resource.values.source_ranges);
      const dir = asString(item.resource.values.direction) === 'EGRESS' ? 'egress' : 'ingress';
      if (targetTags.length > 0) {
        fw.attachedTo?.tags?.push(...targetTags);
      }
      const allowBlocks = Array.isArray(item.resource.values.allow)
        ? item.resource.values.allow
        : [];
      allowBlocks.forEach((b, idx) => {
        if (!isPlainObject(b)) return;
        const proto = normalizeProtocol(b.protocol);
        const ports = asStringArray(b.ports);
        const firstPort = ports[0] ? asNumber(ports[0].split('-')[0]) : undefined;
        const selector: Selector = sourceTags[0]
          ? { tag: sourceTags[0] }
          : sourceRanges[0]
            ? { cidr: sourceRanges[0] }
            : { any: true };
        fw.rules.push({
          id: `${fw.id}-rule-${idx}`,
          direction: dir,
          action: 'allow',
          protocol: proto,
          ...(firstPort !== undefined ? { portFrom: firstPort, portTo: firstPort } : {}),
          ...(dir === 'ingress' ? { source: selector } : { destination: selector }),
        });
      });
    }
  }

  // Attach standalone AWS SG ingress/egress rules (`aws_vpc_security_group_ingress_rule`/`egress_rule`)
  for (const item of classified.filter(
    (c) => c.networkRole === 'sg_ingress' || c.networkRole === 'sg_egress',
  )) {
    const dir: 'ingress' | 'egress' = item.networkRole === 'sg_ingress' ? 'ingress' : 'egress';
    const sgRefs = resolveRefTargets(item.resource, ['security_group_id']);
    const targetSg = sgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
    if (!targetSg) continue;

    const peerSgRefs = resolveRefTargets(item.resource, ['referenced_security_group_id']);
    const peerSg = peerSgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
    const cidr = asString(item.resource.values.cidr_ipv4);
    const proto = normalizeProtocol(item.resource.values.ip_protocol);
    const fromPort = asNumber(item.resource.values.from_port);
    const toPort = asNumber(item.resource.values.to_port);

    const selector: Selector = peerSg ? { firewallId: peerSg.id } : cidr ? { cidr } : { any: true };

    targetSg.rules.push({
      id: `${targetSg.id}-${item.resource.name}`,
      direction: dir,
      action: 'allow',
      protocol: proto,
      ...(fromPort !== undefined ? { portFrom: fromPort } : {}),
      ...(toPort !== undefined ? { portTo: toPort } : {}),
      ...(dir === 'ingress' ? { source: selector } : { destination: selector }),
    });
  }

  // Attach Azure NSG rules + subnet associations & OCI NSG rules
  for (const item of classified.filter((c) => c.networkRole === 'nsg_rule')) {
    if (item.provider === 'oci') {
      const nsgRefs = resolveRefTargets(item.resource, ['network_security_group_id']);
      const targetNsg = nsgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
      if (!targetNsg) continue;
      const dir = asString(item.resource.values.direction) === 'EGRESS' ? 'egress' : 'ingress';
      const proto = normalizeProtocol(item.resource.values.protocol);
      let portFrom: number | undefined;
      let portTo: number | undefined;
      const tcpOpts = Array.isArray(item.resource.values.tcp_options)
        ? item.resource.values.tcp_options[0]
        : undefined;
      if (isPlainObject(tcpOpts) && Array.isArray(tcpOpts.destination_port_range)) {
        const range = tcpOpts.destination_port_range[0];
        if (isPlainObject(range)) {
          portFrom = asNumber(range.min);
          portTo = asNumber(range.max);
        }
      }
      const peerNsgRefs = resolveRefTargets(item.resource, ['source']);
      const peerNsg = peerNsgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
      const srcStr = asString(item.resource.values.source);
      const selector: Selector = peerNsg
        ? { firewallId: peerNsg.id }
        : srcStr
          ? { cidr: srcStr }
          : { any: true };
      targetNsg.rules.push({
        id: `${targetNsg.id}-${item.resource.name}`,
        direction: dir,
        action: 'allow',
        protocol: proto,
        ...(portFrom !== undefined ? { portFrom } : {}),
        ...(portTo !== undefined ? { portTo } : {}),
        ...(dir === 'ingress' ? { source: selector } : { destination: selector }),
      });
    } else {
      const nsgRefs = resolveRefTargets(item.resource, ['network_security_group_name']);
      const targetNsg = nsgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
      if (!targetNsg) continue;
      const dir = asString(item.resource.values.direction) === 'Outbound' ? 'egress' : 'ingress';
      const action = asString(item.resource.values.access) === 'Deny' ? 'deny' : 'allow';
      const priority = asNumber(item.resource.values.priority);
      const proto = normalizeProtocol(item.resource.values.protocol);
      const portStr = asString(item.resource.values.destination_port_range);
      const port = portStr && portStr !== '*' ? asNumber(portStr.split('-')[0]) : undefined;
      const srcPrefix = asString(item.resource.values.source_address_prefix);
      const selector: Selector =
        srcPrefix && srcPrefix !== '*' && srcPrefix !== 'Internet'
          ? { cidr: srcPrefix === 'VirtualNetwork' ? '10.20.0.0/16' : srcPrefix }
          : { any: true };
      targetNsg.rules.push({
        id: `${targetNsg.id}-${item.resource.name}`,
        direction: dir,
        action,
        ...(priority !== undefined ? { priority } : {}),
        protocol: proto,
        ...(port !== undefined ? { portFrom: port, portTo: port } : {}),
        ...(dir === 'ingress' ? { source: selector } : { destination: selector }),
      });
    }
  }

  for (const item of classified.filter((c) => c.networkRole === 'nsg_assoc')) {
    const subRefs = resolveRefTargets(item.resource, ['subnet_id']);
    const nsgRefs = resolveRefTargets(item.resource, ['network_security_group_id']);
    const subGrp = subRefs.map(subnetGroupForResource).find(Boolean);
    const nsg = nsgRefs.map((s) => fwByAddr.get(s.resource.address)).find(Boolean);
    const subObj = subGrp ? subnetObjByGroupId.get(subGrp.id) : undefined;
    if (subObj && nsg) {
      subObj.firewallIds = [...(subObj.firewallIds ?? []), nsg.id];
      nsg.attachedTo?.subnetIds?.push(subObj.id);
    }
  }

  // DNS Zones & records
  const dnsZonesByAddr = new Map<string, DnsZone>();
  const DNS_SERVICE_IDS = new Set(['aws.route53', 'gcp.cloud_dns', 'azure.dns', 'oci.dns']);
  for (const item of classified.filter(
    (c) =>
      c.networkRole === 'dns_zone' ||
      (c.serviceId !== undefined && DNS_SERVICE_IDS.has(c.serviceId)),
  )) {
    const zoneId = uniqueId(usedIds, `dns-${snakeCaseSlug(item.resource.name, 'zone')}`);
    const zoneName =
      asString(item.resource.values.name)?.replace(/\.$/, '') ??
      asString(item.resource.values.dns_name)?.replace(/\.$/, '') ??
      item.label;
    const vpcRefs = resolveRefTargets(item.resource, ['vpc_id', 'vpc']);
    const netIds = vpcRefs
      .map((r) => vpcGroupByAddr.get(r.resource.address))
      .filter((g): g is GroupInstance => Boolean(g))
      .map((g) => `net-${g.id}`);
    const zone: DnsZone = {
      id: zoneId,
      name: zoneName,
      private: netIds.length > 0,
      networkIds: netIds,
      records: [],
    };
    network.dnsZones.push(zone);
    dnsZonesByAddr.set(item.resource.address, zone);
    addressToDnsZoneId.set(item.resource.address, zoneId);
  }

  for (const item of classified.filter((c) => c.edgeRole === 'dns_record')) {
    const zoneRefs = resolveRefTargets(item.resource, ['zone_id', 'managed_zone']);
    const zone = zoneRefs.map((z) => dnsZonesByAddr.get(z.resource.address)).find(Boolean);
    if (!zone) continue;
    const recName = asString(item.resource.values.name) ?? item.label;
    const recType = asString(item.resource.values.type) ?? 'A';
    const recs = asStringArray(item.resource.values.records);
    const rrdatas = asStringArray(item.resource.values.rrdatas);
    const val = recs[0] ?? rrdatas[0] ?? 'alias';
    zone.records.push({ name: recName, type: recType, value: val });
  }

  // 6. Build NodeInstances + Containment + Attachments
  const nodes: NodeInstance[] = [];
  const nodesById = new Map<string, NodeInstance>();
  const firewallIdToNodeIds = new Map<string, string[]>();

  const nodeItems = classified.filter(
    (c) => c.classification === 'node' || c.classification === 'unsupported',
  );

  // Pre-index indirect helper -> subnet links (e.g. NIC, db_subnet_group, instance_template, launch_template)
  const indirectSubnetsByHelperAddr = new Map<string, GroupInstance[]>();
  for (const helper of classified) {
    if (helper.classification !== 'ignored') continue;
    const directSubs = resolveRefTargets(helper.resource, [
      'subnet_id',
      'subnet_ids',
      'subnetwork',
      'vpc_id',
      'network',
    ])
      .map(subnetGroupForResource)
      .filter((g): g is GroupInstance => Boolean(g));
    if (directSubs.length > 0) {
      indirectSubnetsByHelperAddr.set(helper.resource.address, directSubs);
    }
  }

  // Map VPC endpoints after subnet/vpc resolution too
  for (const item of classified.filter((c) => c.networkRole === 'endpoint')) {
    const refs = resolveRefTargets(item.resource, ['subnet_ids', 'subnet_id', 'vpc_id']);
    const subGrp = refs.map(subnetGroupForResource).find(Boolean);
    const vpcGrp =
      refs.map((r) => vpcGroupByAddr.get(r.resource.address)).find(Boolean) ??
      (subGrp?.parentGroupId ? groupsById.get(subGrp.parentGroupId) : undefined);
    if (vpcGrp && subGrp) {
      const ep: PrivateEndpoint = {
        id: uniqueId(usedIds, `ep-${snakeCaseSlug(item.resource.name, 'ep')}`),
        networkId: `net-${vpcGrp.id}`,
        subnetId: `sub-${subGrp.id}`,
        serviceId: asString(item.resource.values.service_name) ?? 'aws.s3',
        privateDns: item.resource.values.private_dns_enabled === true,
      };
      network.endpoints.push(ep);
    }
  }

  for (const item of nodeItems) {
    const nodeId = uniqueId(usedIds, `n-${snakeCaseSlug(item.resource.name, 'svc')}`);
    const allRefs = resolveRefTargets(item.resource);

    // Resolve subnet parent via direct ref OR helper resource indirection (NIC / DB subnet group / ASG launch template)
    let parentSubnet: GroupInstance | undefined = allRefs.map(subnetGroupForResource).find(Boolean);
    if (!parentSubnet) {
      for (const target of allRefs) {
        const helperSubs = indirectSubnetsByHelperAddr.get(target.resource.address);
        if (helperSubs && helperSubs.length > 0) {
          parentSubnet = helperSubs[0];
          break;
        }
      }
    }

    // Resolve VPC parent if no subnet ref was attached directly
    let parentVpc: GroupInstance | undefined = allRefs
      .map((r) => vpcGroupByAddr.get(r.resource.address))
      .find(Boolean);

    // Resolve firewalls (SG / OCI NSG / GCP tags)
    const fwIds: string[] = [];
    for (const target of allRefs) {
      const fw = fwByAddr.get(target.resource.address);
      if (fw) {
        fwIds.push(fw.id);
        fw.attachedTo?.nodeIds?.push(nodeId);
        const list = firewallIdToNodeIds.get(fw.id) ?? [];
        list.push(nodeId);
        firewallIdToNodeIds.set(fw.id, list);
        if (!parentSubnet && !parentVpc) {
          const fwVpc = findVpcGroupForResource(target.resource);
          if (fwVpc) parentVpc = fwVpc;
        }
      }
    }

    // Match GCP firewall tags attached to this node
    const nodeTags = asStringArray(item.resource.values.tags);
    if (nodeTags.length > 0 && item.provider === 'gcp') {
      for (const fw of network.firewalls) {
        if (fw.kind === 'gcp-fw' && fw.attachedTo?.tags?.some((t) => nodeTags.includes(t))) {
          if (!fwIds.includes(fw.id)) fwIds.push(fw.id);
          fw.attachedTo?.nodeIds?.push(nodeId);
          const list = firewallIdToNodeIds.get(fw.id) ?? [];
          if (!list.includes(nodeId)) list.push(nodeId);
          firewallIdToNodeIds.set(fw.id, list);
        }
      }
    }

    const parentGroupId = parentSubnet?.id ?? parentVpc?.id;
    const node: NodeInstance = {
      id: nodeId,
      serviceId: item.serviceId ?? `custom.tf_${item.resource.type}`,
      label: item.label,
      position: { x: 0, y: 0 },
      ...(parentGroupId ? { parentGroupId } : {}),
      ...(item.region ? { region: item.region } : {}),
      ...(item.az ? { az: item.az } : {}),
      config: item.nodeConfig ?? { instances: 1, operations: {} },
      ...(Object.keys(item.importedAttrs).length > 0 ? { importedAttrs: item.importedAttrs } : {}),
    };

    nodes.push(node);
    nodesById.set(nodeId, node);
    addressToEntityId.set(item.resource.address, nodeId);

    if (parentSubnet || fwIds.length > 0 || nodeTags.length > 0) {
      const att: Attachment = {
        nodeId,
        ...(parentSubnet ? { subnetId: `sub-${parentSubnet.id}` } : {}),
        firewallIds: fwIds,
        ...(nodeTags.length > 0 ? { tags: nodeTags } : {}),
      };
      network.attachments.push(att);
    }
  }

  return {
    groups,
    nodes,
    network,
    addressToEntityId,
    resourcesByAddress,
    addressToFirewallId,
    firewallIdToNodeIds,
    groupsById,
    nodesById,
    addressToDnsZoneId,
    resolveRefTargets,
  };
}
