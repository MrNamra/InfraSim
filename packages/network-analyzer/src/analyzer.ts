import type {
  Attachment,
  Design,
  FirewallObject,
  FirewallRule,
  Gateway,
  GroupInstance,
  Hop,
  Network,
  NetworkAnalysis,
  NetworkConfig,
  NodeInstance,
  Peering,
  PrivateEndpoint,
  Provider,
  ReachabilityResult,
  ReasonCode,
  RouteTable,
  Selector,
  ServiceDefinition,
  Subnet,
} from '@infrasim/shared-types';
import { cidrContainsIp, cidrsOverlap, prefixLength } from './cidr.js';
import {
  getEffectiveListeningPorts,
  inferEdgePortAndProtocol,
  inferSubnetPublicness,
  normalizeL4Protocol,
  resolveServiceDef,
} from './defaults.js';
import { buildReachabilityFixes, type FixBuildContext } from './fixes.js';
import { detectNetworkSecuritySmells, formatReachabilityExplanation } from './templates.js';

export interface ReachabilityQuery {
  srcNodeId: string;
  dstNodeId: string; // node ID, 'internet', DNS name, or IPv4 address
  protocol?: string;
  port?: number;
}

export interface AnalyzerOptions {
  customServices?: readonly ServiceDefinition[];
  servicesById?: ReadonlyMap<string, ServiceDefinition>;
  skipSmells?: boolean;
}

export interface ExtendedReachabilityResult {
  reachable: boolean;
  hops: Hop[];
  blockedAt?: { objectKind: string; objectId: string; ruleId?: string };
  reasonCode?: ReasonCode;
  failureMode?: 'timeout' | 'refused' | 'dns' | 'none';
  explanation: { short: string; deep: string };
  fixes: ReturnType<typeof buildReachabilityFixes>;
  extraLatencyMs: number;
  crossAz: boolean;
  crossRegion: boolean;
  viaNat: boolean;
  viaEndpoint: boolean;
}

interface NetworkIndex {
  design: Design;
  net: NetworkConfig;
  nodesById: Map<string, NodeInstance>;
  groupsById: Map<string, GroupInstance>;
  subnetsById: Map<string, Subnet>;
  networksById: Map<string, Network>;
  routeTablesById: Map<string, RouteTable>;
  gatewaysById: Map<string, Gateway>;
  firewallsById: Map<string, FirewallObject>;
  attachmentsByNodeId: Map<string, Attachment>;
  subnetPublicness: Map<string, boolean>;
  subnetFirewalls: Map<string, FirewallObject[]>;
  nodeFirewalls: Map<string, FirewallObject[]>;
  fwNodeMembers: Map<string, Set<string>>;
  servicesById?: ReadonlyMap<string, ServiceDefinition>;
  customServices: readonly ServiceDefinition[];
}

const PAAS_ENDPOINT_KINDS = new Set([
  'kv',
  'doc',
  'object',
  'queue',
  'topic',
  'stream',
  'bus',
  'secret',
  'kms',
  'llm',
  'ml',
  'email',
]);

function buildNetworkIndex(design: Design, options: AnalyzerOptions = {}): NetworkIndex {
  const net = design.network ?? {};
  const nodesById = new Map(design.nodes.map((n) => [n.id, n]));
  const groupsById = new Map(design.groups.map((g) => [g.id, g]));
  const subnetsById = new Map((net.subnets ?? []).map((s) => [s.id, s]));
  const networksById = new Map((net.networks ?? []).map((n) => [n.id, n]));
  const routeTablesById = new Map((net.routeTables ?? []).map((r) => [r.id, r]));
  const gatewaysById = new Map((net.gateways ?? []).map((g) => [g.id, g]));
  const firewallsById = new Map((net.firewalls ?? []).map((f) => [f.id, f]));
  const attachmentsByNodeId = new Map((net.attachments ?? []).map((a) => [a.nodeId, a]));

  const subnetPublicness = new Map<string, boolean>();
  for (const s of net.subnets ?? []) {
    subnetPublicness.set(s.id, inferSubnetPublicness(s, net));
  }

  const subnetFirewalls = new Map<string, FirewallObject[]>();
  const addSubnetFw = (subId: string, fw: FirewallObject) => {
    const arr = subnetFirewalls.get(subId);
    if (!arr) {
      subnetFirewalls.set(subId, [fw]);
    } else if (!arr.some((x) => x.id === fw.id)) {
      arr.push(fw);
    }
  };
  for (const s of net.subnets ?? []) {
    for (const fwId of s.firewallIds ?? []) {
      const fw = firewallsById.get(fwId);
      if (fw) addSubnetFw(s.id, fw);
    }
  }
  for (const fw of net.firewalls ?? []) {
    for (const subId of fw.attachedTo?.subnetIds ?? []) {
      addSubnetFw(subId, fw);
    }
  }

  const fwNodeMembers = new Map<string, Set<string>>();
  const nodeFirewalls = new Map<string, FirewallObject[]>();
  const addNodeFw = (nodeId: string, fw: FirewallObject) => {
    let members = fwNodeMembers.get(fw.id);
    if (!members) {
      members = new Set<string>();
      fwNodeMembers.set(fw.id, members);
    }
    members.add(nodeId);

    const arr = nodeFirewalls.get(nodeId);
    if (!arr) {
      nodeFirewalls.set(nodeId, [fw]);
    } else if (!arr.some((x) => x.id === fw.id)) {
      arr.push(fw);
    }
  };

  for (const att of net.attachments ?? []) {
    for (const fwId of att.firewallIds ?? []) {
      const fw = firewallsById.get(fwId);
      if (fw) addNodeFw(att.nodeId, fw);
    }
  }
  for (const fw of net.firewalls ?? []) {
    for (const nid of fw.attachedTo?.nodeIds ?? []) {
      addNodeFw(nid, fw);
    }
    const fwTags = fw.attachedTo?.tags ?? [];
    if (fwTags.length > 0) {
      for (const att of net.attachments ?? []) {
        const nodeTags = att.tags ?? [];
        if (fwTags.some((t) => nodeTags.includes(t))) {
          addNodeFw(att.nodeId, fw);
        }
      }
    }
  }

  return {
    design,
    net,
    nodesById,
    groupsById,
    subnetsById,
    networksById,
    routeTablesById,
    gatewaysById,
    firewallsById,
    attachmentsByNodeId,
    subnetPublicness,
    subnetFirewalls,
    nodeFirewalls,
    fwNodeMembers,
    servicesById: options.servicesById,
    customServices: options.customServices ?? design.customServices ?? [],
  };
}

function getServiceForNode(
  index: NetworkIndex,
  node: NodeInstance | undefined,
): ServiceDefinition | undefined {
  if (!node) return undefined;
  return (
    index.servicesById?.get(node.serviceId) ??
    resolveServiceDef(node.serviceId, index.customServices)
  );
}

function isIpv4Literal(val: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(val.trim());
}

function protocolMatches(ruleProto: FirewallRule['protocol'], queryProto: string): boolean {
  if (ruleProto === 'any') return true;
  return ruleProto === queryProto;
}

function portMatches(rule: FirewallRule, port: number): boolean {
  if (rule.protocol === 'any' && rule.portFrom === undefined && rule.portTo === undefined) {
    return true;
  }
  if (rule.portFrom === undefined && rule.portTo === undefined) {
    return true;
  }
  const from = rule.portFrom ?? 0;
  const to = rule.portTo ?? from;
  return port >= from && port <= to;
}

function portRangeMatchesEphemeral(rule: FirewallRule): boolean {
  if (rule.portFrom === undefined && rule.portTo === undefined) {
    return true;
  }
  const from = rule.portFrom ?? 0;
  const to = rule.portTo ?? from;
  if (rule.action === 'allow') {
    // Return ephemeral responses use arbitrary high ports; a narrow single-port allow (e.g. 5432) does not cover them
    return from <= 32768 && to >= 60999;
  }
  return to >= 32768 && from <= 60999;
}

function selectorMatchesPeer(
  sel: Selector | undefined,
  peerIp: string,
  peerNodeId: string | undefined,
  peerAttachment: Attachment | undefined,
  index: NetworkIndex,
  peerFirewalls: readonly FirewallObject[],
): boolean {
  if (!sel) return false;
  if ('any' in sel && sel.any) return true;
  if ('cidr' in sel) {
    if (sel.cidr === '0.0.0.0/0' || sel.cidr === '::/0') return true;
    if (!peerIp || peerIp === 'internet') return false;
    return cidrContainsIp(sel.cidr, peerIp);
  }
  if ('firewallId' in sel) {
    if (!peerNodeId) return false;
    if (peerFirewalls.some((f) => f.id === sel.firewallId)) return true;
    return index.fwNodeMembers.get(sel.firewallId)?.has(peerNodeId) ?? false;
  }
  if ('tag' in sel) {
    const tags = peerAttachment?.tags ?? [];
    return tags.includes(sel.tag);
  }
  return false;
}

function evaluateStatelessSubnetFirewall(
  fw: FirewallObject,
  direction: 'ingress' | 'egress',
  protocol: 'tcp' | 'udp' | 'icmp' | 'any',
  port: number,
  peerIp: string,
  peerNodeId: string | undefined,
  peerAtt: Attachment | undefined,
  peerFws: readonly FirewallObject[],
  index: NetworkIndex,
  ephemeralCheck = false,
): { allowed: boolean; ruleId?: string; detail: string } {
  const rules = fw.rules
    .filter((r) => r.direction === direction)
    .sort((a, b) => (a.priority ?? 32767) - (b.priority ?? 32767));

  for (const r of rules) {
    if (!protocolMatches(r.protocol, protocol)) continue;
    if (ephemeralCheck) {
      if (!portRangeMatchesEphemeral(r)) continue;
    } else if (!portMatches(r, port)) {
      continue;
    }
    const sel = direction === 'ingress' ? r.source : r.destination;
    if (selectorMatchesPeer(sel, peerIp, peerNodeId, peerAtt, index, peerFws)) {
      return {
        allowed: r.action === 'allow',
        ruleId: r.id,
        detail: `${r.action} rule ${r.priority ?? '-'} (${r.id}) matched ${protocol.toUpperCase()} ${ephemeralCheck ? '1024-65535' : port}`,
      };
    }
  }
  return {
    allowed: false,
    detail: `Implied deny (*) on ${fw.id} ${direction} for ${protocol.toUpperCase()} ${ephemeralCheck ? '1024-65535' : port}`,
  };
}

function evaluateSecurityGroupSet(
  fws: readonly FirewallObject[],
  direction: 'ingress' | 'egress',
  protocol: 'tcp' | 'udp' | 'icmp' | 'any',
  port: number,
  peerIp: string,
  peerNodeId: string | undefined,
  peerAtt: Attachment | undefined,
  peerFws: readonly FirewallObject[],
  index: NetworkIndex,
): { allowed: boolean; fwId: string; ruleId?: string; detail: string } {
  if (fws.length === 0) {
    return {
      allowed: false,
      fwId: 'no-sg',
      detail: `No ${direction} firewall attached`,
    };
  }
  for (const fw of fws) {
    const matching = fw.rules.filter((r) => {
      if (r.direction !== direction || r.action !== 'allow') return false;
      if (!protocolMatches(r.protocol, protocol)) return false;
      if (!portMatches(r, port)) return false;
      const sel = direction === 'ingress' ? r.source : r.destination;
      return selectorMatchesPeer(sel, peerIp, peerNodeId, peerAtt, index, peerFws);
    });
    if (matching.length > 0) {
      return {
        allowed: true,
        fwId: fw.id,
        ruleId: matching[0]!.id,
        detail: `${fw.id} rule ${matching[0]!.id} allows ${protocol.toUpperCase()} ${port}`,
      };
    }
  }
  return {
    allowed: false,
    fwId: fws[0]!.id,
    detail: `No ${direction} rule in ${fws.map((f) => f.id).join(', ')} allows ${protocol.toUpperCase()} ${port} from ${peerIp || peerNodeId || 'source'}`,
  };
}

function evaluateGcpFirewall(
  index: NetworkIndex,
  targetNode: NodeInstance,
  targetAtt: Attachment | undefined,
  direction: 'ingress' | 'egress',
  protocol: 'tcp' | 'udp' | 'icmp' | 'any',
  port: number,
  peerIp: string,
  peerNodeId: string | undefined,
  peerAtt: Attachment | undefined,
  peerFws: readonly FirewallObject[],
  networkId?: string,
): { allowed: boolean; fwId: string; ruleId?: string; detail: string } {
  const targetTags = new Set(targetAtt?.tags ?? []);
  const gcpFws = (index.net.firewalls ?? []).filter((f) => {
    if (f.kind !== 'gcp-fw') return false;
    if (f.attachedTo?.nodeIds?.includes(targetNode.id)) return true;
    if (targetAtt?.firewallIds.includes(f.id)) return true;
    const fwTags = f.attachedTo?.tags ?? [];
    if (fwTags.length > 0) {
      return fwTags.some((t) => targetTags.has(t));
    }
    return Boolean(networkId) && !f.attachedTo?.nodeIds?.length && !f.attachedTo?.tags?.length;
  });

  const orderedRules: { fwId: string; rule: FirewallRule }[] = [];
  for (const fw of gcpFws) {
    for (const r of fw.rules) {
      if (r.direction === direction) {
        orderedRules.push({ fwId: fw.id, rule: r });
      }
    }
  }
  orderedRules.sort((a, b) => {
    const pa = a.rule.priority ?? 1000;
    const pb = b.rule.priority ?? 1000;
    if (pa !== pb) return pa - pb;
    if (a.rule.action === b.rule.action) return 0;
    return a.rule.action === 'deny' ? -1 : 1;
  });

  for (const { fwId, rule } of orderedRules) {
    if (!protocolMatches(rule.protocol, protocol) || !portMatches(rule, port)) continue;
    const sel = direction === 'ingress' ? rule.source : rule.destination;
    if (selectorMatchesPeer(sel, peerIp, peerNodeId, peerAtt, index, peerFws)) {
      return {
        allowed: rule.action === 'allow',
        fwId,
        ruleId: rule.id,
        detail: `${fwId} priority ${rule.priority ?? 1000} (${rule.id}) ${rule.action}s ${protocol.toUpperCase()} ${port}`,
      };
    }
  }

  if (direction === 'egress') {
    return {
      allowed: true,
      fwId: gcpFws[0]?.id ?? 'gcp-implied-egress',
      detail: 'GCP implied allow egress (priority 65535)',
    };
  }

  // Check if an unattached tag-targeted GCP firewall exists for hint context (tag mismatch)
  const tagMismatchFw = (index.net.firewalls ?? []).find(
    (f) =>
      f.kind === 'gcp-fw' &&
      (f.attachedTo?.tags?.length ?? 0) > 0 &&
      f.rules.some(
        (r) =>
          r.direction === 'ingress' &&
          r.action === 'allow' &&
          protocolMatches(r.protocol, protocol) &&
          portMatches(r, port),
      ),
  );
  if (tagMismatchFw) {
    const fwTags = tagMismatchFw.attachedTo?.tags ?? [];
    return {
      allowed: false,
      fwId: tagMismatchFw.id,
      ruleId: tagMismatchFw.rules[0]?.id,
      detail: `GCP firewall ${tagMismatchFw.id} targets tag [${fwTags.join(', ')}]; ${targetNode.label} has tags [${Array.from(targetTags).join(', ') || 'none'}]`,
    };
  }

  return {
    allowed: false,
    fwId: gcpFws[0]?.id ?? 'gcp-implied-deny',
    detail: `GCP implied deny ingress (priority 65535) blocked ${protocol.toUpperCase()} ${port}`,
  };
}

function evaluateAzureNsg(
  fw: FirewallObject,
  direction: 'ingress' | 'egress',
  protocol: 'tcp' | 'udp' | 'icmp' | 'any',
  port: number,
  peerIp: string,
  peerNodeId: string | undefined,
  peerAtt: Attachment | undefined,
  peerFws: readonly FirewallObject[],
  sameOrPeeredVnet: boolean,
  index: NetworkIndex,
): { allowed: boolean; ruleId?: string; detail: string } {
  const rules = fw.rules
    .filter((r) => r.direction === direction)
    .sort((a, b) => (a.priority ?? 65000) - (b.priority ?? 65000));

  for (const r of rules) {
    if (!protocolMatches(r.protocol, protocol) || !portMatches(r, port)) continue;
    const sel = direction === 'ingress' ? r.source : r.destination;
    if (selectorMatchesPeer(sel, peerIp, peerNodeId, peerAtt, index, peerFws)) {
      return {
        allowed: r.action === 'allow',
        ruleId: r.id,
        detail: `${fw.id} priority ${r.priority ?? 65000} (${r.id}) ${r.action}s ${protocol.toUpperCase()} ${port}`,
      };
    }
  }

  if (direction === 'egress') {
    return {
      allowed: true,
      detail: `${fw.id} default AllowInternetOutBound (65000)`,
    };
  }
  if (sameOrPeeredVnet) {
    return {
      allowed: true,
      detail: `${fw.id} default AllowVnetInBound (65000)`,
    };
  }
  return {
    allowed: false,
    detail: `${fw.id} default DenyAllInBound (65500)`,
  };
}

function matchLongestPrefixRoute(
  rt: RouteTable | undefined,
  destIp: string,
): RouteTable['routes'][number] | undefined {
  if (!rt) return undefined;
  let bestRoute: RouteTable['routes'][number] | undefined;
  let bestPrefix = -1;
  for (const route of rt.routes) {
    if (route.dest === '0.0.0.0/0' || route.dest === '::/0') {
      if (0 > bestPrefix) {
        bestPrefix = 0;
        bestRoute = route;
      }
      continue;
    }
    if (isIpv4Literal(destIp) && cidrContainsIp(route.dest, destIp)) {
      const len = prefixLength(route.dest);
      if (len > bestPrefix) {
        bestPrefix = len;
        bestRoute = route;
      }
    }
  }
  return bestRoute;
}

function findDirectPeering(
  peerings: readonly Peering[],
  netAId: string,
  netBId: string,
): Peering | undefined {
  return peerings.find(
    (p) => (p.a === netAId && p.b === netBId) || (p.b === netAId && p.a === netBId),
  );
}

function hasTransitivePeeringPath(
  peerings: readonly Peering[],
  startNetId: string,
  targetNetId: string,
): boolean {
  if (startNetId === targetNetId) return false;
  const visited = new Set<string>([startNetId]);
  const queue: { id: string; depth: number }[] = [{ id: startNetId, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const p of peerings) {
      const next = p.a === cur.id ? p.b : p.b === cur.id ? p.a : null;
      if (!next) continue;
      if (next === targetNetId && cur.depth >= 1) {
        return true;
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ id: next, depth: cur.depth + 1 });
      }
    }
  }
  return false;
}

function checkServiceAllowlist(
  dstNode: NodeInstance,
  srcIp: string,
): { allowed: boolean; detail: string } {
  const allowlist = dstNode.config.firewallAllowlist;
  if (!allowlist || allowlist.length === 0) {
    return { allowed: true, detail: 'No service allowlist restriction' };
  }
  for (const entry of allowlist) {
    if (entry === '0.0.0.0/0' || entry === '*') {
      return { allowed: true, detail: `Service allowlist permits ${entry}` };
    }
    if (entry.includes('/') && isIpv4Literal(srcIp) && cidrContainsIp(entry, srcIp)) {
      return { allowed: true, detail: `Service allowlist permits ${entry}` };
    }
    if (entry === srcIp) {
      return { allowed: true, detail: `Service allowlist permits ${entry}` };
    }
  }
  return {
    allowed: false,
    detail: `Service firewall allowlist on ${dstNode.label} [${allowlist.join(', ')}] rejects ${srcIp}`,
  };
}

function inferAzRegionFlags(
  srcNode: NodeInstance | undefined,
  dstNode: NodeInstance | undefined,
  srcSubnet: Subnet | undefined,
  dstSubnet: Subnet | undefined,
  srcNetwork: Network | undefined,
  dstNetwork: Network | undefined,
): { crossAz: boolean; crossRegion: boolean } {
  const srcRegion = srcNode?.region ?? srcNetwork?.region;
  const dstRegion = dstNode?.region ?? dstNetwork?.region;
  const crossRegion = Boolean(srcRegion && dstRegion && srcRegion !== dstRegion);
  const srcAz = srcNode?.az ?? srcSubnet?.az;
  const dstAz = dstNode?.az ?? dstSubnet?.az;
  const crossAz = !crossRegion && Boolean(srcAz && dstAz && srcAz !== dstAz);
  return { crossAz, crossRegion };
}

function failResult(
  index: NetworkIndex,
  params: {
    reasonCode: ReasonCode;
    failureMode: 'timeout' | 'refused' | 'dns';
    hops: Hop[];
    srcNodeId: string;
    dstNodeId: string;
    srcLabel: string;
    dstLabel: string;
    srcIp: string;
    dstIp: string;
    protocol: 'tcp' | 'udp' | 'icmp' | 'any';
    port: number;
    srcSubnet?: Subnet;
    dstSubnet?: Subnet;
    srcNetwork?: Network;
    dstNetwork?: Network;
    srcAttachment?: Attachment;
    dstAttachment?: Attachment;
    srcPrimarySg?: FirewallObject;
    dstPrimarySg?: FirewallObject;
    blockedAt?: { objectKind: string; objectId: string; ruleId?: string };
    blockedDirection?: 'ingress' | 'egress';
    extraDetail?: string;
    crossAz?: boolean;
    crossRegion?: boolean;
    extraLatencyMs?: number;
    viaNat?: boolean;
    viaEndpoint?: boolean;
  },
): ExtendedReachabilityResult {
  const fixCtx: FixBuildContext = {
    design: index.design,
    reasonCode: params.reasonCode,
    srcNodeId: params.srcNodeId,
    dstNodeId: params.dstNodeId,
    srcIp: params.srcIp,
    dstIp: params.dstIp,
    protocol: params.protocol,
    port: params.port,
    srcSubnet: params.srcSubnet,
    dstSubnet: params.dstSubnet,
    srcNetwork: params.srcNetwork,
    dstNetwork: params.dstNetwork,
    srcAttachment: params.srcAttachment,
    dstAttachment: params.dstAttachment,
    srcPrimarySg: params.srcPrimarySg,
    dstPrimarySg: params.dstPrimarySg,
    blockingObjectKind: params.blockedAt?.objectKind,
    blockingObjectId: params.blockedAt?.objectId,
    blockingRuleId: params.blockedAt?.ruleId,
    blockedDirection: params.blockedDirection,
    customServices: index.customServices,
  };
  const fixes = buildReachabilityFixes(fixCtx);
  const explanation = formatReachabilityExplanation(false, params.reasonCode, {
    srcLabel: params.srcLabel,
    srcAddr: params.srcIp,
    dstLabel: params.dstLabel,
    dstAddr: params.dstIp,
    protocol: params.protocol,
    port: params.port,
    hops: params.hops,
    blockingObjectId: params.blockedAt?.objectId,
    blockingObjectKind: params.blockedAt?.objectKind,
    blockingRuleId: params.blockedAt?.ruleId,
    extraDetail: params.extraDetail,
    fixSummary: fixes[0]?.label,
  });

  return {
    reachable: false,
    hops: params.hops,
    ...(params.blockedAt ? { blockedAt: params.blockedAt } : {}),
    reasonCode: params.reasonCode,
    failureMode: params.failureMode,
    explanation,
    fixes,
    extraLatencyMs: params.extraLatencyMs ?? 0,
    crossAz: params.crossAz ?? false,
    crossRegion: params.crossRegion ?? false,
    viaNat: params.viaNat ?? false,
    viaEndpoint: params.viaEndpoint ?? false,
  };
}

function checkWithIndex(index: NetworkIndex, query: ReachabilityQuery): ExtendedReachabilityResult {
  const srcNode = index.nodesById.get(query.srcNodeId);
  const dstNodeById = index.nodesById.get(query.dstNodeId);
  const srcSvc = getServiceForNode(index, srcNode);
  const dstSvc = getServiceForNode(index, dstNodeById);

  const portInfo = query.port
    ? { protocol: normalizeL4Protocol(query.protocol), port: query.port }
    : inferEdgePortAndProtocol(
        { protocol: (query.protocol ?? 'https') as 'https' },
        dstSvc,
        dstNodeById,
      );
  const protocol = portInfo.protocol;
  const port = portInfo.port;

  const srcAtt = index.attachmentsByNodeId.get(query.srcNodeId);
  const dstAtt = dstNodeById ? index.attachmentsByNodeId.get(dstNodeById.id) : undefined;
  const srcSubnet = srcAtt?.subnetId ? index.subnetsById.get(srcAtt.subnetId) : undefined;
  const dstSubnet = dstAtt?.subnetId ? index.subnetsById.get(dstAtt.subnetId) : undefined;
  const srcNetwork = srcSubnet ? index.networksById.get(srcSubnet.networkId) : undefined;
  const dstNetwork = dstSubnet ? index.networksById.get(dstSubnet.networkId) : undefined;

  const srcFws = index.nodeFirewalls.get(query.srcNodeId) ?? [];
  const dstFws = dstNodeById ? (index.nodeFirewalls.get(dstNodeById.id) ?? []) : [];
  const srcSubnetFws = srcSubnet ? (index.subnetFirewalls.get(srcSubnet.id) ?? []) : [];
  const dstSubnetFws = dstSubnet ? (index.subnetFirewalls.get(dstSubnet.id) ?? []) : [];

  const srcLabel = srcNode?.label ?? query.srcNodeId;
  const srcIp = srcAtt?.privateIp ?? srcAtt?.publicIp ?? 'internet';
  const hops: Hop[] = [];
  const { crossAz, crossRegion } = inferAzRegionFlags(
    srcNode,
    dstNodeById,
    srcSubnet,
    dstSubnet,
    srcNetwork,
    dstNetwork,
  );
  let extraLatencyMs = 0;
  let viaNat = false;
  let viaEndpoint = false;

  const commonFail = {
    hops,
    srcNodeId: query.srcNodeId,
    dstNodeId: dstNodeById?.id ?? query.dstNodeId,
    srcLabel,
    dstLabel: dstNodeById?.label ?? query.dstNodeId,
    srcIp,
    dstIp: dstAtt?.privateIp ?? dstAtt?.publicIp ?? 'internet',
    protocol,
    port,
    srcSubnet,
    dstSubnet,
    srcNetwork,
    dstNetwork,
    srcAttachment: srcAtt,
    dstAttachment: dstAtt,
    srcPrimarySg: srcFws[0],
    dstPrimarySg: dstFws[0],
    crossAz,
    crossRegion,
  };

  // Golden #12: Serverless without VPC attachment calling a private VPC node
  const isSrcServerless = srcSvc?.kind === 'fn';
  if (isSrcServerless && !srcAtt?.subnetId && dstSubnet && dstAtt?.privateIp && !dstAtt.publicIp) {
    hops.push({
      step: 'vpc-attachment',
      objectId: srcNode?.id ?? query.srcNodeId,
      verdict: 'deny',
      detail: `${srcLabel} is not attached to a VPC/subnet and cannot route to private IP ${dstAtt.privateIp}`,
    });
    return failResult(index, {
      ...commonFail,
      reasonCode: 'SERVICE_NOT_IN_VPC',
      failureMode: 'timeout',
      blockedAt: { objectKind: 'node', objectId: srcNode?.id ?? query.srcNodeId },
    });
  }

  // Unconfigured legacy designs without subnet attachments on either side remain reachable unless listener/allowlist blocks
  const isExternalClientSrc =
    !srcAtt?.subnetId &&
    (!srcNode ||
      srcSvc?.kind === 'compute' ||
      query.srcNodeId === 'internet' ||
      srcNode.serviceId === 'generic.client' ||
      srcNode.serviceId === 'generic.users');
  if (!srcAtt?.subnetId && !dstAtt?.subnetId) {
    if (dstNodeById) {
      const allowlistCheck = checkServiceAllowlist(dstNodeById, srcIp);
      if (!allowlistCheck.allowed) {
        hops.push({
          step: 'service-firewall',
          objectId: dstNodeById.id,
          verdict: 'deny',
          detail: allowlistCheck.detail,
        });
        return failResult(index, {
          ...commonFail,
          reasonCode: 'SERVICE_FIREWALL_BLOCK',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'node', objectId: dstNodeById.id },
        });
      }
      if (dstNodeById.config.listeningPorts !== undefined) {
        const listeners = getEffectiveListeningPorts(dstSvc, dstNodeById.config);
        const listens = listeners.some(
          (l) =>
            l.port === port && (normalizeL4Protocol(l.protocol) === protocol || protocol === 'any'),
        );
        if (!listens) {
          hops.push({
            step: 'listener',
            objectId: dstNodeById.id,
            verdict: 'deny',
            detail: `${dstNodeById.label} is not listening on ${protocol.toUpperCase()} ${port}`,
          });
          return failResult(index, {
            ...commonFail,
            reasonCode: 'PORT_NOT_LISTENING',
            failureMode: 'refused',
            blockedAt: { objectKind: 'node', objectId: dstNodeById.id },
          });
        }
      }
    }
    return {
      reachable: true,
      hops: [
        {
          step: 'direct',
          objectId: dstNodeById?.id ?? query.dstNodeId,
          verdict: 'allow',
          detail: `No subnet isolation configured; ${srcLabel} reaches ${dstNodeById?.label ?? query.dstNodeId} on ${protocol.toUpperCase()} ${port}`,
        },
      ],
      failureMode: 'none',
      explanation: formatReachabilityExplanation(true, undefined, {
        srcLabel,
        srcAddr: srcIp,
        dstLabel: dstNodeById?.label ?? query.dstNodeId,
        dstAddr: dstAtt?.privateIp ?? dstAtt?.publicIp ?? query.dstNodeId,
        protocol,
        port,
        hops: [],
      }),
      fixes: [],
      extraLatencyMs: 0,
      crossAz,
      crossRegion,
      viaNat: false,
      viaEndpoint: false,
    };
  }

  // STEP 1: Endpoint & DNS Resolution
  let targetIsInternet = query.dstNodeId === 'internet' || query.dstNodeId === 'generic.internet';
  let resolvedIp = '198.51.100.254';
  const dstLabel = dstNodeById?.label ?? query.dstNodeId;

  if (!dstNodeById && !targetIsInternet) {
    if (isIpv4Literal(query.dstNodeId)) {
      resolvedIp = query.dstNodeId.trim();
      hops.push({
        step: 'dns',
        objectId: 'ip-literal',
        verdict: 'allow',
        detail: `Using IP literal ${resolvedIp}`,
      });
    } else {
      const dnsZones = index.net.dnsZones ?? [];
      const visibleZones = dnsZones
        .filter((z) => z.private && srcNetwork && z.networkIds.includes(srcNetwork.id))
        .concat(dnsZones.filter((z) => !z.private));
      let matchedRecord: string | undefined;
      for (const z of visibleZones) {
        const rec = z.records.find(
          (r) =>
            r.name === query.dstNodeId ||
            `${r.name}.${z.name}` === query.dstNodeId ||
            z.name === query.dstNodeId,
        );
        if (rec) {
          matchedRecord = rec.value;
          break;
        }
      }
      if (!matchedRecord) {
        hops.push({
          step: 'dns',
          objectId: srcNetwork?.id ?? 'dns',
          verdict: 'deny',
          detail: `No DNS record found for "${query.dstNodeId}"`,
        });
        return failResult(index, {
          ...commonFail,
          dstLabel: query.dstNodeId,
          dstIp: 'unresolved',
          reasonCode: 'DNS_UNRESOLVED',
          failureMode: 'dns',
          blockedAt: { objectKind: 'dns', objectId: srcNetwork?.id ?? 'dns' },
        });
      }
      resolvedIp = matchedRecord;
      hops.push({
        step: 'dns',
        objectId: 'dns',
        verdict: 'allow',
        detail: `Resolved ${query.dstNodeId} -> ${resolvedIp}`,
      });
    }
  } else if (dstNodeById) {
    if (
      dstNodeById.serviceId === 'generic.internet' ||
      dstNodeById.serviceId === 'generic.client'
    ) {
      targetIsInternet = true;
      resolvedIp = dstAtt?.publicIp ?? '198.51.100.254';
    } else if (srcNetwork && dstNetwork && srcNetwork.id === dstNetwork.id) {
      resolvedIp = dstAtt?.privateIp ?? dstAtt?.publicIp ?? '10.0.1.20';
    } else if (
      srcNetwork &&
      dstNetwork &&
      findDirectPeering(index.net.peerings ?? [], srcNetwork.id, dstNetwork.id)
    ) {
      resolvedIp = dstAtt?.privateIp ?? dstAtt?.publicIp ?? '10.1.1.20';
    } else if (dstAtt?.publicIp) {
      resolvedIp = dstAtt.publicIp;
    } else {
      resolvedIp = dstAtt?.privateIp ?? '198.51.100.250';
    }
  }

  // Check PrivateEndpoint + Private DNS when src is inside a network calling a PaaS service or external endpoint
  const matchingEndpoint: PrivateEndpoint | undefined =
    srcNetwork && dstNodeById
      ? (index.net.endpoints ?? []).find(
          (ep) =>
            ep.networkId === srcNetwork.id &&
            (ep.serviceId === dstNodeById.serviceId || ep.serviceId === '*'),
        )
      : undefined;

  if (matchingEndpoint && matchingEndpoint.privateDns === false) {
    hops.push({
      step: 'private-dns',
      objectId: matchingEndpoint.id,
      verdict: 'deny',
      detail: `Private endpoint ${matchingEndpoint.id} has privateDns disabled`,
    });
    return failResult(index, {
      ...commonFail,
      dstIp: resolvedIp,
      reasonCode: 'PRIVATE_DNS_MISSING',
      failureMode: 'timeout',
      blockedAt: { objectKind: 'endpoint', objectId: matchingEndpoint.id },
    });
  }

  // Also check unlinked Private DNS zone referencing dst service or node label
  if (srcNetwork && dstNodeById && matchingEndpoint) {
    const privateServiceZone = (index.net.dnsZones ?? []).find(
      (z) =>
        z.private &&
        z.records.some(
          (r) =>
            r.name === dstNodeById.id ||
            r.name === dstNodeById.serviceId ||
            r.name === dstNodeById.label,
        ) &&
        !z.networkIds.includes(srcNetwork.id),
    );
    if (privateServiceZone) {
      hops.push({
        step: 'private-dns',
        objectId: privateServiceZone.id,
        verdict: 'deny',
        detail: `Private DNS zone ${privateServiceZone.name} is not linked to ${srcNetwork.name}`,
      });
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'PRIVATE_DNS_MISSING',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'dnsZone', objectId: privateServiceZone.id },
      });
    }
  }

  const sameNetwork = Boolean(srcNetwork && dstNetwork && srcNetwork.id === dstNetwork.id);
  const directPeering =
    srcNetwork && dstNetwork && !sameNetwork
      ? findDirectPeering(index.net.peerings ?? [], srcNetwork.id, dstNetwork.id)
      : undefined;
  const srcProvider: Provider =
    srcNetwork?.provider ?? index.design.settings.primaryProvider ?? 'aws';
  const dstProvider: Provider =
    dstNetwork?.provider ?? index.design.settings.primaryProvider ?? 'aws';

  // STEP 2: SOURCE-SIDE FIREWALLS (when src is attached in a subnet)
  let srcStatelessNacl: FirewallObject | undefined;
  let srcUsedStatefulEgress = false;
  if (srcSubnet && srcNetwork) {
    if (srcProvider === 'gcp') {
      const gcpEg = srcNode
        ? evaluateGcpFirewall(
            index,
            srcNode,
            srcAtt,
            'egress',
            protocol,
            port,
            resolvedIp,
            dstNodeById?.id,
            dstAtt,
            dstFws,
            srcNetwork.id,
          )
        : { allowed: true, fwId: 'gcp-implied-egress', detail: 'Implied allow egress' };
      hops.push({
        step: 'source-gcp-fw-egress',
        objectId: gcpEg.fwId,
        verdict: gcpEg.allowed ? 'allow' : 'deny',
        detail: gcpEg.detail,
      });
      if (!gcpEg.allowed) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'GCP_FW_DENY',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'gcp-fw', objectId: gcpEg.fwId, ruleId: gcpEg.ruleId },
        });
      }
      srcUsedStatefulEgress = true;
    } else if (srcProvider === 'azure') {
      const nsgList = [...srcFws, ...srcSubnetFws].filter((f) => f.kind === 'nsg');
      for (const nsg of nsgList) {
        const res = evaluateAzureNsg(
          nsg,
          'egress',
          protocol,
          port,
          resolvedIp,
          dstNodeById?.id,
          dstAtt,
          dstFws,
          sameNetwork || Boolean(directPeering),
          index,
        );
        hops.push({
          step: 'source-nsg-egress',
          objectId: nsg.id,
          verdict: res.allowed ? 'allow' : 'deny',
          detail: res.detail,
        });
        if (!res.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'NSG_DENY',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'nsg', objectId: nsg.id, ruleId: res.ruleId },
          });
        }
        srcUsedStatefulEgress = true;
      }
    } else if (srcProvider === 'oci') {
      const ociList = [...srcFws, ...srcSubnetFws].filter(
        (f) => f.kind === 'oci-nsg' || f.kind === 'oci-sl',
      );
      if (ociList.length > 0) {
        const res = evaluateSecurityGroupSet(
          ociList,
          'egress',
          protocol,
          port,
          resolvedIp,
          dstNodeById?.id,
          dstAtt,
          dstFws,
          index,
        );
        hops.push({
          step: 'source-oci-egress',
          objectId: res.fwId,
          verdict: res.allowed ? 'allow' : 'deny',
          detail: res.detail,
        });
        if (!res.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'OCI_SL_NO_RULE',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'oci-sl', objectId: res.fwId, ruleId: res.ruleId },
          });
        }
        srcUsedStatefulEgress = true;
      }
    } else {
      // AWS SG + NACL egress
      if (srcFws.length > 0) {
        const sgEg = evaluateSecurityGroupSet(
          srcFws,
          'egress',
          protocol,
          port,
          resolvedIp,
          dstNodeById?.id,
          dstAtt,
          dstFws,
          index,
        );
        hops.push({
          step: 'source-sg-egress',
          objectId: sgEg.fwId,
          verdict: sgEg.allowed ? 'allow' : 'deny',
          detail: sgEg.detail,
        });
        if (!sgEg.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'SG_NO_EGRESS',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'sg', objectId: sgEg.fwId, ruleId: sgEg.ruleId },
          });
        }
        srcUsedStatefulEgress = true;
      }
      srcStatelessNacl = srcSubnetFws.find((f) => f.kind === 'nacl' || !f.stateful);
      if (srcStatelessNacl) {
        const naclEg = evaluateStatelessSubnetFirewall(
          srcStatelessNacl,
          'egress',
          protocol,
          port,
          resolvedIp,
          dstNodeById?.id,
          dstAtt,
          dstFws,
          index,
          false,
        );
        hops.push({
          step: 'source-nacl-egress',
          objectId: srcStatelessNacl.id,
          verdict: naclEg.allowed ? 'allow' : 'deny',
          detail: naclEg.detail,
        });
        if (!naclEg.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'NACL_DENY',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'nacl', objectId: srcStatelessNacl.id, ruleId: naclEg.ruleId },
          });
        }
      }
    }
  }

  // STEP 3: CROSS-NETWORK OVERLAP, TRANSITIVE PEERING, REGION, & ROUTING
  if (srcNetwork && dstNetwork && !sameNetwork) {
    // Check CIDR overlap on all peered links between these networks (or transitive peerings)
    if (directPeering) {
      const overlaps = srcNetwork.cidrs.some((ca) =>
        dstNetwork.cidrs.some((cb) => cidrsOverlap(ca, cb)),
      );
      if (overlaps) {
        hops.push({
          step: 'peering-cidr-check',
          objectId: directPeering.id,
          verdict: 'deny',
          detail: `CIDR conflict between ${srcNetwork.cidrs.join(',')} and ${dstNetwork.cidrs.join(',')}`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'CIDR_OVERLAP',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'peering', objectId: directPeering.id },
          extraDetail: `${srcNetwork.cidrs[0]} vs ${dstNetwork.cidrs[0]}`,
        });
      }
    }

    // Also check if any peering connected to srcNetwork overlaps with dstNetwork
    const peeringBetweenSrcDst = directPeering;
    if (!peeringBetweenSrcDst) {
      if (hasTransitivePeeringPath(index.net.peerings ?? [], srcNetwork.id, dstNetwork.id)) {
        // Only raise TRANSITIVE_PEERING_UNSUPPORTED when destination is private (not reachable via public IGW/NAT)
        if (!dstAtt?.publicIp) {
          hops.push({
            step: 'peering-transitivity',
            objectId: `${srcNetwork.id}->${dstNetwork.id}`,
            verdict: 'deny',
            detail: `VPC/VNet peering is non-transitive between ${srcNetwork.name} and ${dstNetwork.name}`,
          });
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'TRANSITIVE_PEERING_UNSUPPORTED',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'network', objectId: srcNetwork.id },
          });
        }
      }
    }
  }

  // Evaluate source subnet route table
  let dstStatelessNacl: FirewallObject | undefined;
  if (srcSubnet && srcNetwork) {
    const srcRt = index.routeTablesById.get(srcSubnet.routeTableId);
    const route = matchLongestPrefixRoute(srcRt, resolvedIp);

    // Special check for private subnet calling PaaS storage/DB/API without NAT or Endpoint
    const dstIsPaaSWithoutVpc =
      dstNodeById && !dstAtt?.subnetId && dstSvc && PAAS_ENDPOINT_KINDS.has(dstSvc.kind);

    if (!route) {
      if (dstIsPaaSWithoutVpc) {
        hops.push({
          step: 'route',
          objectId: srcSubnet.routeTableId,
          verdict: 'deny',
          detail: `No endpoint or internet route for PaaS service ${dstNodeById.label}`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'ENDPOINT_MISSING',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'routeTable', objectId: srcSubnet.routeTableId },
        });
      }

      if (targetIsInternet || (!sameNetwork && !directPeering)) {
        hops.push({
          step: 'route',
          objectId: srcSubnet.routeTableId,
          verdict: 'deny',
          detail: `Private subnet route table ${srcSubnet.routeTableId} has no 0.0.0.0/0 NAT or IGW route`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: !srcSubnet.autoAssignPublicIp ? 'NO_NAT' : 'NO_ROUTE',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'routeTable', objectId: srcSubnet.routeTableId },
        });
      }

      hops.push({
        step: 'route',
        objectId: srcSubnet.routeTableId,
        verdict: 'deny',
        detail: `No route in ${srcSubnet.routeTableId} matches ${resolvedIp}`,
      });
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'NO_ROUTE',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'routeTable', objectId: srcSubnet.routeTableId },
      });
    }

    if (route.target.kind === 'blackhole') {
      hops.push({
        step: 'route',
        objectId: srcSubnet.routeTableId,
        verdict: 'deny',
        detail: `Route ${route.dest} targets blackhole`,
      });
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'NO_ROUTE',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'routeTable', objectId: srcSubnet.routeTableId },
      });
    }

    if (route.target.kind === 'local') {
      if (dstNetwork && dstNetwork.id !== srcNetwork.id) {
        hops.push({
          step: 'route',
          objectId: srcSubnet.routeTableId,
          verdict: 'deny',
          detail: `Route ${route.dest} is local to ${srcNetwork.name}, cannot reach ${dstNetwork.name}`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: crossRegion ? 'DIFFERENT_REGION_NO_CONNECTIVITY' : 'NO_ROUTE',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'routeTable', objectId: srcSubnet.routeTableId },
        });
      }
      hops.push({
        step: 'route',
        objectId: srcSubnet.routeTableId,
        verdict: 'allow',
        detail: `${route.dest} -> local`,
      });
    } else if (route.target.kind === 'igw') {
      if (!srcAtt?.publicIp) {
        hops.push({
          step: 'igw',
          objectId: srcSubnet.routeTableId,
          verdict: 'deny',
          detail: `${srcLabel} routes through IGW but lacks a public IP`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'NO_PUBLIC_IP',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'attachment', objectId: query.srcNodeId },
        });
      }
      if (crossRegion && !dstAtt?.publicIp && dstNetwork) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'DIFFERENT_REGION_NO_CONNECTIVITY',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'network', objectId: dstNetwork.id },
        });
      }
      hops.push({
        step: 'route',
        objectId: srcSubnet.routeTableId,
        verdict: 'allow',
        detail: `${route.dest} -> igw (src public IP ${srcAtt.publicIp})`,
      });
    } else if (route.target.kind === 'nat') {
      const natGw = index.gatewaysById.get(route.target.gatewayId);
      if (!natGw || natGw.kind !== 'nat') {
        hops.push({
          step: 'nat',
          objectId: route.target.gatewayId,
          verdict: 'deny',
          detail: `NAT gateway ${route.target.gatewayId} not found`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'NO_NAT',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'gateway', objectId: route.target.gatewayId },
        });
      }
      const natSub = natGw.subnetId ? index.subnetsById.get(natGw.subnetId) : undefined;
      const natSubPublic = natSub ? Boolean(index.subnetPublicness.get(natSub.id)) : false;
      if (!natSub || !natSubPublic) {
        hops.push({
          step: 'nat',
          objectId: natGw.id,
          verdict: 'deny',
          detail: `NAT gateway ${natGw.id} is placed in private subnet ${natGw.subnetId ?? 'unknown'} without IGW route`,
        });
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'NAT_NOT_IN_PUBLIC_SUBNET',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'gateway', objectId: natGw.id },
        });
      }
      viaNat = true;
      extraLatencyMs += 1;
      hops.push({
        step: 'route',
        objectId: natGw.id,
        verdict: 'allow',
        detail: `${route.dest} -> nat (${natGw.id} in public subnet ${natSub.id})`,
      });
    } else if (route.target.kind === 'peering') {
      const peerId = route.target.id;
      const peer = (index.net.peerings ?? []).find((p) => p.id === peerId);
      if (!peer) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'PEERING_NOT_ROUTED',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'peering', objectId: peerId },
        });
      }
      const otherNetId = peer.a === srcNetwork.id ? peer.b : peer.a;
      if (dstNetwork && otherNetId !== dstNetwork.id) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'TRANSITIVE_PEERING_UNSUPPORTED',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'peering', objectId: peer.id },
        });
      }
      const peerOtherNet = index.networksById.get(otherNetId);
      if (
        peerOtherNet &&
        srcNetwork.cidrs.some((ca) => peerOtherNet.cidrs.some((cb) => cidrsOverlap(ca, cb)))
      ) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'CIDR_OVERLAP',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'peering', objectId: peer.id },
          extraDetail: `${srcNetwork.cidrs[0]} overlaps ${peerOtherNet.cidrs[0]}`,
        });
      }
      if (dstSubnet) {
        const dstRt = index.routeTablesById.get(dstSubnet.routeTableId);
        const returnRoute = matchLongestPrefixRoute(dstRt, srcIp);
        const sideFlag = peer.a === dstNetwork?.id ? peer.routedA : peer.routedB;
        if (!returnRoute || returnRoute.target.kind !== 'peering' || sideFlag === false) {
          hops.push({
            step: 'return-route',
            objectId: dstSubnet.routeTableId,
            verdict: 'deny',
            detail: `Return route back to ${srcIp} via peering ${peer.id} is missing in ${dstSubnet.routeTableId}`,
          });
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'MISSING_RETURN_ROUTE',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'routeTable', objectId: dstSubnet.routeTableId },
          });
        }
      }
      extraLatencyMs += 0.3;
      hops.push({
        step: 'peering',
        objectId: peer.id,
        verdict: 'allow',
        detail: `Symmetric peering route ${route.dest} -> ${peer.id}`,
      });
    } else if (
      route.target.kind === 'tgw' ||
      route.target.kind === 'drg' ||
      route.target.kind === 'vpn' ||
      route.target.kind === 'interconnect'
    ) {
      const hopMs = route.target.kind === 'vpn' ? 10 : 1;
      extraLatencyMs += hopMs;
      if (dstSubnet && srcNetwork && dstNetwork && srcNetwork.id !== dstNetwork.id) {
        const dstRt = index.routeTablesById.get(dstSubnet.routeTableId);
        const returnRoute = matchLongestPrefixRoute(dstRt, srcIp);
        if (!returnRoute || returnRoute.target.kind === 'blackhole') {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'MISSING_RETURN_ROUTE',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'routeTable', objectId: dstSubnet.routeTableId },
          });
        }
      }
      hops.push({
        step: route.target.kind,
        objectId: route.target.id,
        verdict: 'allow',
        detail: `${route.dest} -> ${route.target.kind} (${route.target.id})`,
      });
    } else if (route.target.kind === 'endpoint') {
      viaEndpoint = true;
      extraLatencyMs += 0.3;
      hops.push({
        step: 'endpoint',
        objectId: route.target.id,
        verdict: 'allow',
        detail: `${route.dest} -> endpoint (${route.target.id})`,
      });
    } else if (route.target.kind === 'appliance') {
      extraLatencyMs += 1;
      hops.push({
        step: 'appliance',
        objectId: route.target.nodeId,
        verdict: 'allow',
        detail: `${route.dest} -> firewall appliance (${route.target.nodeId})`,
      });
    }
  } else if (isExternalClientSrc && dstSubnet) {
    // External internet client entering a subnet must see public IP + IGW route on destination subnet
    const dstSubPublic = Boolean(index.subnetPublicness.get(dstSubnet.id));
    if (!dstSubPublic || !dstAtt?.publicIp) {
      hops.push({
        step: 'igw-ingress',
        objectId: dstSubnet.routeTableId,
        verdict: 'deny',
        detail: `${dstLabel} has no public IP / public IGW subnet route for external traffic`,
      });
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'NO_PUBLIC_IP',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'subnet', objectId: dstSubnet.id },
      });
    }
    hops.push({
      step: 'igw-ingress',
      objectId: dstSubnet.id,
      verdict: 'allow',
      detail: `Internet -> ${dstLabel} (${dstAtt.publicIp}) via public subnet ${dstSubnet.id}`,
    });
  }

  // STEP 4: DESTINATION-SIDE FIREWALLS & LISTENER
  let dstUsedStatefulIngress = false;
  if (dstNodeById && dstSubnet && dstNetwork) {
    if (dstProvider === 'gcp') {
      const gcpIn = evaluateGcpFirewall(
        index,
        dstNodeById,
        dstAtt,
        'ingress',
        protocol,
        port,
        srcIp,
        srcNode?.id,
        srcAtt,
        srcFws,
        dstNetwork.id,
      );
      hops.push({
        step: 'dest-gcp-fw-ingress',
        objectId: gcpIn.fwId,
        verdict: gcpIn.allowed ? 'allow' : 'deny',
        detail: gcpIn.detail,
      });
      if (!gcpIn.allowed) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'GCP_FW_DENY',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'gcp-fw', objectId: gcpIn.fwId, ruleId: gcpIn.ruleId },
        });
      }
      dstUsedStatefulIngress = true;
    } else if (dstProvider === 'azure') {
      const nsgList = [...dstSubnetFws, ...dstFws].filter((f) => f.kind === 'nsg');
      if (nsgList.length === 0) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'NSG_DENY',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'subnet', objectId: dstSubnet.id },
        });
      }
      for (const nsg of nsgList) {
        const res = evaluateAzureNsg(
          nsg,
          'ingress',
          protocol,
          port,
          srcIp,
          srcNode?.id,
          srcAtt,
          srcFws,
          sameNetwork || Boolean(directPeering),
          index,
        );
        hops.push({
          step: 'dest-nsg-ingress',
          objectId: nsg.id,
          verdict: res.allowed ? 'allow' : 'deny',
          detail: res.detail,
        });
        if (!res.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'NSG_DENY',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'nsg', objectId: nsg.id, ruleId: res.ruleId },
          });
        }
        dstUsedStatefulIngress = true;
      }
    } else if (dstProvider === 'oci') {
      const ociList = [...dstSubnetFws, ...dstFws].filter(
        (f) => f.kind === 'oci-sl' || f.kind === 'oci-nsg',
      );
      const res = evaluateSecurityGroupSet(
        ociList,
        'ingress',
        protocol,
        port,
        srcIp,
        srcNode?.id,
        srcAtt,
        srcFws,
        index,
      );
      hops.push({
        step: 'dest-oci-ingress',
        objectId: res.fwId,
        verdict: res.allowed ? 'allow' : 'deny',
        detail: res.detail,
      });
      if (!res.allowed) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'OCI_SL_NO_RULE',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'oci-sl', objectId: res.fwId, ruleId: res.ruleId },
        });
      }
      dstUsedStatefulIngress = !ociList.some((f) => f.stateful === false);
    } else {
      // AWS NACL ingress then SG ingress
      dstStatelessNacl = dstSubnetFws.find((f) => f.kind === 'nacl' || !f.stateful);
      if (dstStatelessNacl) {
        const naclIn = evaluateStatelessSubnetFirewall(
          dstStatelessNacl,
          'ingress',
          protocol,
          port,
          srcIp,
          srcNode?.id,
          srcAtt,
          srcFws,
          index,
          false,
        );
        hops.push({
          step: 'dest-nacl-ingress',
          objectId: dstStatelessNacl.id,
          verdict: naclIn.allowed ? 'allow' : 'deny',
          detail: naclIn.detail,
        });
        if (!naclIn.allowed) {
          return failResult(index, {
            ...commonFail,
            dstIp: resolvedIp,
            reasonCode: 'NACL_DENY',
            failureMode: 'timeout',
            blockedAt: { objectKind: 'nacl', objectId: dstStatelessNacl.id, ruleId: naclIn.ruleId },
          });
        }
      }

      const sgIn = evaluateSecurityGroupSet(
        dstFws,
        'ingress',
        protocol,
        port,
        srcIp,
        srcNode?.id,
        srcAtt,
        srcFws,
        index,
      );
      hops.push({
        step: 'dest-sg-ingress',
        objectId: sgIn.fwId,
        verdict: sgIn.allowed ? 'allow' : 'deny',
        detail: sgIn.detail,
      });
      if (!sgIn.allowed) {
        return failResult(index, {
          ...commonFail,
          dstIp: resolvedIp,
          reasonCode: 'SG_NO_INGRESS',
          failureMode: 'timeout',
          blockedAt: { objectKind: 'sg', objectId: sgIn.fwId, ruleId: sgIn.ruleId },
        });
      }
      dstUsedStatefulIngress = true;
    }
  }

  // PaaS service allowlist check (applies even if PaaS sits outside VPC)
  if (dstNodeById) {
    const allowlistCheck = checkServiceAllowlist(dstNodeById, srcIp);
    if (!allowlistCheck.allowed) {
      hops.push({
        step: 'service-firewall',
        objectId: dstNodeById.id,
        verdict: 'deny',
        detail: allowlistCheck.detail,
      });
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'SERVICE_FIREWALL_BLOCK',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'node', objectId: dstNodeById.id },
      });
    }
  }

  // STEP 5: STATELESS RETURN PATH (Ephemeral ports 1024-65535 on stateless NACLs / stateless SLs)
  if (dstStatelessNacl) {
    const retEg = evaluateStatelessSubnetFirewall(
      dstStatelessNacl,
      'egress',
      protocol,
      port,
      srcIp,
      srcNode?.id,
      srcAtt,
      srcFws,
      index,
      true,
    );
    hops.push({
      step: 'dest-nacl-return-egress',
      objectId: dstStatelessNacl.id,
      verdict: retEg.allowed ? 'allow' : 'deny',
      detail: retEg.detail,
    });
    if (!retEg.allowed) {
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'EPHEMERAL_PORTS_BLOCKED',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'nacl', objectId: dstStatelessNacl.id, ruleId: retEg.ruleId },
        blockedDirection: 'egress',
      });
    }
  }
  if (srcStatelessNacl) {
    const retIn = evaluateStatelessSubnetFirewall(
      srcStatelessNacl,
      'ingress',
      protocol,
      port,
      resolvedIp,
      dstNodeById?.id,
      dstAtt,
      dstFws,
      index,
      true,
    );
    hops.push({
      step: 'source-nacl-return-ingress',
      objectId: srcStatelessNacl.id,
      verdict: retIn.allowed ? 'allow' : 'deny',
      detail: retIn.detail,
    });
    if (!retIn.allowed) {
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'EPHEMERAL_PORTS_BLOCKED',
        failureMode: 'timeout',
        blockedAt: { objectKind: 'nacl', objectId: srcStatelessNacl.id, ruleId: retIn.ruleId },
        blockedDirection: 'ingress',
      });
    }
  }

  // Check if destination node listens on (protocol, port) -> else connection refused (ECONNREFUSED)
  if (dstNodeById && !targetIsInternet) {
    const listeners = getEffectiveListeningPorts(dstSvc, dstNodeById.config);
    const listens = listeners.some(
      (l) =>
        l.port === port &&
        (normalizeL4Protocol(l.protocol) === protocol ||
          protocol === 'any' ||
          l.protocol === 'any'),
    );
    hops.push({
      step: 'listener',
      objectId: dstNodeById.id,
      verdict: listens ? 'allow' : 'deny',
      detail: listens
        ? `${dstLabel} listens on ${protocol.toUpperCase()} ${port}`
        : `${dstLabel} has no active listener on ${protocol.toUpperCase()} ${port}`,
    });
    if (!listens) {
      return failResult(index, {
        ...commonFail,
        dstIp: resolvedIp,
        reasonCode: 'PORT_NOT_LISTENING',
        failureMode: 'refused',
        blockedAt: { objectKind: 'node', objectId: dstNodeById.id },
      });
    }
  }

  // Track stateful annotations cleanly
  void srcUsedStatefulEgress;
  void dstUsedStatefulIngress;

  return {
    reachable: true,
    hops,
    failureMode: 'none',
    explanation: formatReachabilityExplanation(true, undefined, {
      srcLabel,
      srcAddr: srcIp,
      dstLabel,
      dstAddr: resolvedIp,
      protocol,
      port,
      hops,
    }),
    fixes: [],
    extraLatencyMs,
    crossAz,
    crossRegion,
    viaNat,
    viaEndpoint,
  };
}

/**
 * Evaluates point-to-point network reachability between a source node and destination
 * (node ID, `'internet'`, hostname, or IPv4) across routing, DNS, firewalls, and listeners.
 */
export function checkReachability(
  design: Design,
  query: ReachabilityQuery,
  options: AnalyzerOptions = {},
): ExtendedReachabilityResult {
  const index = buildNetworkIndex(design, options);
  return checkWithIndex(index, query);
}

/**
 * Evaluates reachability for every edge in `design`, computes hop latency / cost flags
 * (`crossAz`, `crossRegion`, `viaNat`, `viaEndpoint`), and flags network security smells.
 */
export function analyzeDesignNetwork(
  design: Design,
  options: AnalyzerOptions = {},
): NetworkAnalysis {
  const index = buildNetworkIndex(design, options);
  const edges: NetworkAnalysis['edges'] = {};

  const smellReport = options.skipSmells
    ? { smells: [], riskyEdgeReasons: {} as Record<string, string> }
    : detectNetworkSecuritySmells(design, options.servicesById);

  for (const edge of design.edges) {
    const res = checkWithIndex(index, {
      srcNodeId: edge.from,
      dstNodeId: edge.to,
      protocol: edge.protocol,
      port: edge.port,
    });
    const riskyReason = res.reachable ? smellReport.riskyEdgeReasons[edge.id] : undefined;
    edges[edge.id] = {
      reachable: res.reachable,
      hops: res.hops,
      ...(res.blockedAt ? { blockedAt: res.blockedAt } : {}),
      ...(res.reasonCode ? { reasonCode: res.reasonCode } : {}),
      ...(res.failureMode ? { failureMode: res.failureMode } : {}),
      explanation: res.explanation,
      fixes: res.fixes,
      extraLatencyMs: res.extraLatencyMs,
      crossAz: res.crossAz,
      crossRegion: res.crossRegion,
      viaNat: res.viaNat,
      viaEndpoint: res.viaEndpoint,
      ...(riskyReason ? { riskyReason } : {}),
    } as ReachabilityResult & {
      crossAz?: boolean;
      crossRegion?: boolean;
      viaNat?: boolean;
      viaEndpoint?: boolean;
      extraLatencyMs?: number;
      riskyReason?: string;
    };
  }

  return {
    edges,
    ...(smellReport.smells.length > 0 ? { smells: smellReport.smells } : {}),
  };
}
