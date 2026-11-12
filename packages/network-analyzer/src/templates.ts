import type {
  Design,
  Hop,
  NetworkConfig,
  NodeInstance,
  ReasonCode,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { inferEdgePortAndProtocol, inferSubnetPublicness, resolveServiceDef } from './defaults.js';

export interface ExplanationContext {
  srcLabel: string;
  srcAddr: string;
  dstLabel: string;
  dstAddr: string;
  protocol: string;
  port: number;
  hops: readonly Hop[];
  blockingObjectId?: string;
  blockingObjectKind?: string;
  blockingRuleId?: string;
  extraDetail?: string;
  fixSummary?: string;
}

const DB_KINDS = new Set(['sql', 'kv', 'doc', 'cache', 'graph', 'ts', 'olap', 'search']);
const WEB_PORTS = new Set([80, 443]);

function renderHopPath(ctx: ExplanationContext): string {
  const header = `Path: ${ctx.srcLabel} (${ctx.srcAddr}) -> ${ctx.dstLabel} (${ctx.dstAddr}:${ctx.port}/${ctx.protocol})`;
  const hopLines = ctx.hops.map((h) => {
    const glyph = h.verdict === 'allow' ? '✔' : h.verdict === 'deny' ? '✘' : '—';
    return `${glyph} ${h.step} (${h.objectId}): ${h.detail}`;
  });
  const fixLine = ctx.fixSummary ? `Fix: ${ctx.fixSummary}` : '';
  return [header, ...hopLines, ...(fixLine ? [fixLine] : [])].join('\n');
}

/** Formats concise short and detailed deep explanations for any reachability verdict. */
export function formatReachabilityExplanation(
  reachable: boolean,
  reasonCode: ReasonCode | undefined,
  ctx: ExplanationContext,
): { short: string; deep: string } {
  const portProto = `${ctx.protocol.toUpperCase()} ${ctx.port}`;
  if (reachable || !reasonCode) {
    return {
      short: `${ctx.srcLabel} can reach ${ctx.dstLabel} on ${portProto}.`,
      deep: renderHopPath(ctx),
    };
  }

  let short: string;
  switch (reasonCode) {
    case 'SG_NO_INGRESS':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (instance firewall missing ingress rule).`;
      break;
    case 'SG_NO_EGRESS':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (source firewall blocks outbound traffic).`;
      break;
    case 'NACL_DENY':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (subnet NACL ${ctx.blockingObjectId ?? ''} denies traffic).`;
      break;
    case 'EPHEMERAL_PORTS_BLOCKED':
      short = `Return traffic from ${ctx.dstLabel} to ${ctx.srcLabel} is blocked on ephemeral ports 1024-65535.`;
      break;
    case 'NSG_DENY':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (Azure NSG ${ctx.blockingObjectId ?? ''} denies traffic).`;
      break;
    case 'GCP_FW_DENY':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (GCP firewall rule denies or tag mismatches).`;
      break;
    case 'OCI_SL_NO_RULE':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} on ${portProto} (OCI security list/NSG has no matching rule).`;
      break;
    case 'NO_ROUTE':
      short = `${ctx.srcLabel} has no route to ${ctx.dstLabel} (${ctx.dstAddr}).`;
      break;
    case 'NO_PUBLIC_IP':
      short = `${ctx.srcLabel} is in a public route without a public IP or NAT gateway.`;
      break;
    case 'NO_NAT':
      short = `${ctx.srcLabel} (private subnet) can't reach ${ctx.dstLabel} without a NAT gateway and 0.0.0.0/0 route.`;
      break;
    case 'NAT_NOT_IN_PUBLIC_SUBNET':
      short = `NAT gateway ${ctx.blockingObjectId ?? ''} is not placed in a public subnet with an IGW route.`;
      break;
    case 'MISSING_RETURN_ROUTE':
      short = `${ctx.dstLabel}'s route table lacks a return route back to ${ctx.srcLabel}.`;
      break;
    case 'PEERING_NOT_ROUTED':
      short = `Peering link ${ctx.blockingObjectId ?? ''} is missing a route table entry.`;
      break;
    case 'TRANSITIVE_PEERING_UNSUPPORTED':
      short = `${ctx.srcLabel} can't reach ${ctx.dstLabel} across transitive peering (VPC/VNet peering is non-transitive).`;
      break;
    case 'CIDR_OVERLAP':
      short = `Peered networks have overlapping CIDRs (${ctx.extraDetail ?? 'conflict'}).`;
      break;
    case 'DIFFERENT_REGION_NO_CONNECTIVITY':
      short = `${ctx.srcLabel} and ${ctx.dstLabel} are in different regions without cross-region peering, TGW, or VPN.`;
      break;
    case 'SERVICE_NOT_IN_VPC':
      short = `${ctx.srcLabel} has no VPC/subnet attachment and cannot reach private destination ${ctx.dstLabel}.`;
      break;
    case 'ENDPOINT_MISSING':
      short = `${ctx.srcLabel} (private subnet) lacks a Private Endpoint / Service Gateway to reach ${ctx.dstLabel}.`;
      break;
    case 'PRIVATE_DNS_MISSING':
      short = `Private endpoint for ${ctx.dstLabel} lacks private DNS resolution; queries fall back to public IP.`;
      break;
    case 'DNS_UNRESOLVED':
      short = `DNS resolution failed for ${ctx.dstLabel} from ${ctx.srcLabel}'s network.`;
      break;
    case 'PORT_NOT_LISTENING':
      short = `${ctx.dstLabel} is reachable on ${ctx.dstAddr}, but nothing listens on ${portProto} (connection refused).`;
      break;
    case 'SERVICE_FIREWALL_BLOCK':
      short = `${ctx.dstLabel} service firewall blocked ${ctx.srcLabel} (${ctx.srcAddr}).`;
      break;
  }

  return {
    short,
    deep: renderHopPath(ctx),
  };
}

export interface DetectedSecuritySmell {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  nodeIds: string[];
  edgeIds: string[];
  title: string;
  short: string;
  deep: string;
  fixes: {
    label: string;
    patch: { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }[];
  }[];
}

/**
 * Scans a design's network attachments, subnets, and firewall rules for common
 * security & architecture smells (public DBs, open world ingress on non-web ports, unrestricted egress).
 */
export function detectNetworkSecuritySmells(
  design: Design,
  servicesById?: ReadonlyMap<string, ServiceDefinition>,
): {
  smells: DetectedSecuritySmell[];
  riskyEdgeReasons: Record<string, string>;
} {
  const net: NetworkConfig = design.network ?? {};
  const firewalls = net.firewalls ?? [];
  const subnets = net.subnets ?? [];
  const attachments = net.attachments ?? [];
  const routeTables = net.routeTables ?? [];
  const networks = net.networks ?? [];

  const smells: DetectedSecuritySmell[] = [];
  const riskyEdgeReasons: Record<string, string> = {};
  const customServices = design.customServices ?? [];

  const resolveSvc = (node: NodeInstance): ServiceDefinition | undefined =>
    servicesById?.get(node.serviceId) ?? resolveServiceDef(node.serviceId, customServices);

  // 1. Database / stateful data store placed in a public subnet or with a public IP
  for (let idx = 0; idx < design.nodes.length; idx++) {
    const node = design.nodes[idx]!;
    const svc = resolveSvc(node);
    if (!svc || !DB_KINDS.has(svc.kind)) {
      continue;
    }
    const attIdx = attachments.findIndex((a) => a.nodeId === node.id);
    if (attIdx < 0) continue;
    const att = attachments[attIdx]!;
    const subnet = att.subnetId ? subnets.find((s) => s.id === att.subnetId) : undefined;
    const groupIdx = subnet ? design.groups.findIndex((g) => `sub-${g.id}` === subnet.id) : -1;
    const isPublicSubnet = subnet ? inferSubnetPublicness(subnet, net) : false;
    if (isPublicSubnet || att.publicIp) {
      const fixes: DetectedSecuritySmell['fixes'] = [];
      if (att.publicIp) {
        fixes.push({
          label: `Remove public IP from ${node.label}`,
          patch: [{ op: 'remove', path: `/network/attachments/${attIdx}/publicIp` }],
        });
      }
      if (subnet) {
        const subIdx = subnets.findIndex((s) => s.id === subnet.id);
        const rtIdx = routeTables.findIndex((r) => r.id === subnet.routeTableId);
        const igwRouteIdx =
          rtIdx >= 0
            ? routeTables[rtIdx]!.routes.findIndex(
                (r) => r.dest === '0.0.0.0/0' && r.target.kind === 'igw',
              )
            : -1;
        const patch: { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }[] = [
          {
            op: 'replace',
            path: `/network/subnets/${subIdx}/autoAssignPublicIp`,
            value: false,
          },
        ];
        if (igwRouteIdx >= 0) {
          patch.push({
            op: 'remove',
            path: `/network/routeTables/${rtIdx}/routes/${igwRouteIdx}`,
          });
        }
        if (groupIdx >= 0) {
          patch.push({ op: 'replace', path: `/groups/${groupIdx}/public`, value: false });
        }
        if (att.publicIp) {
          patch.push({ op: 'remove', path: `/network/attachments/${attIdx}/publicIp` });
        }
        fixes.push({
          label: `Make subnet ${subnet.id} private`,
          patch,
        });
      }

      const incomingEdgeIds = design.edges.filter((e) => e.to === node.id).map((e) => e.id);
      for (const eid of incomingEdgeIds) {
        riskyEdgeReasons[eid] = `${node.label} is exposed in a public subnet`;
      }

      smells.push({
        ruleId: 'net-smell-db-public-subnet',
        severity: 'warning',
        nodeIds: [node.id],
        edgeIds: incomingEdgeIds,
        title: `Data store ${node.label} exposed in public subnet`,
        short: `${node.label} sits in a public subnet with an Internet Gateway route${att.publicIp ? ` and public IP ${att.publicIp}` : ''}.`,
        deep: `Stateful databases (${svc.name}) should run in private subnets with no public IP and allow ingress only from application security groups.`,
        fixes,
      });
    }
  }

  // 2. Firewall rules open to 0.0.0.0/0 on non-web or SSH/DB ports
  let hasUnrestrictedEgress = false;
  for (let fwIdx = 0; fwIdx < firewalls.length; fwIdx++) {
    const fw = firewalls[fwIdx]!;
    if (fw.kind === 'nacl') continue; // NACLs commonly use 0.0.0.0/0 paired with SG least privilege
    const attachedNodeIds = new Set<string>(fw.attachedTo?.nodeIds ?? []);
    for (const att of attachments) {
      if (att.firewallIds.includes(fw.id)) {
        attachedNodeIds.add(att.nodeId);
      }
    }
    const sampleNodeId = Array.from(attachedNodeIds)[0];
    const sampleSubnetId = attachments.find((a) => a.nodeId === sampleNodeId)?.subnetId;
    const sampleNetId = sampleSubnetId
      ? subnets.find((s) => s.id === sampleSubnetId)?.networkId
      : networks[0]?.id;
    const vpcCidr = networks.find((n) => n.id === sampleNetId)?.cidrs[0] ?? '10.0.0.0/16';

    for (let rIdx = 0; rIdx < fw.rules.length; rIdx++) {
      const rule = fw.rules[rIdx]!;
      const isAnySrc =
        rule.direction === 'ingress' &&
        rule.action === 'allow' &&
        rule.source &&
        (('any' in rule.source && rule.source.any) ||
          ('cidr' in rule.source && rule.source.cidr === '0.0.0.0/0'));

      if (isAnySrc) {
        const from = rule.portFrom ?? 0;
        const to = rule.portTo ?? 65535;
        const isWebOnly = WEB_PORTS.has(from) && WEB_PORTS.has(to) && from === to;
        const includesSshOrRdp = (from <= 22 && to >= 22) || (from <= 3389 && to >= 3389);
        if (!isWebOnly) {
          const affectedNodes = Array.from(attachedNodeIds);
          const affectedEdges = design.edges
            .filter((e) => affectedNodes.includes(e.to))
            .map((e) => {
              const tgt = design.nodes.find((n) => n.id === e.to);
              const portInfo = inferEdgePortAndProtocol(e, tgt ? resolveSvc(tgt) : undefined, tgt);
              return portInfo.port >= from && portInfo.port <= to ? e.id : null;
            })
            .filter((x): x is string => x !== null);
          for (const eid of affectedEdges) {
            if (!riskyEdgeReasons[eid]) {
              riskyEdgeReasons[eid] = `Open 0.0.0.0/0 ingress in ${fw.id}`;
            }
          }

          smells.push({
            ruleId: includesSshOrRdp ? 'net-smell-ssh-open' : 'net-smell-open-world-nonweb',
            severity: includesSshOrRdp ? 'critical' : 'warning',
            nodeIds: affectedNodes,
            edgeIds: affectedEdges,
            title: includesSshOrRdp
              ? `SSH/RDP port open to 0.0.0.0/0 (${fw.id})`
              : `Firewall ${fw.id} allows 0.0.0.0/0 on non-web ports (${from}-${to})`,
            short: `Rule ${rule.id} in ${fw.id} allows any internet source on ports ${from}-${to}.`,
            deep: `Public 0.0.0.0/0 ingress should be limited to web/edge ports (80/443). Restrict ${fw.id} rule ${rule.id} to VPC CIDR ${vpcCidr} or a peer security group.`,
            fixes: [
              {
                label: `Restrict ${fw.id} rule ${rule.id} to ${vpcCidr}`,
                patch: [
                  {
                    op: 'replace',
                    path: `/network/firewalls/${fwIdx}/rules/${rIdx}/source`,
                    value: { cidr: vpcCidr },
                  },
                ],
              },
            ],
          });
        }
      }

      const isUnrestrictedEgress =
        rule.direction === 'egress' &&
        rule.action === 'allow' &&
        rule.protocol === 'any' &&
        rule.destination &&
        (('any' in rule.destination && rule.destination.any) ||
          ('cidr' in rule.destination && rule.destination.cidr === '0.0.0.0/0'));
      if (isUnrestrictedEgress && !hasUnrestrictedEgress && attachedNodeIds.size > 0) {
        hasUnrestrictedEgress = true;
        smells.push({
          ruleId: 'net-smell-unrestricted-egress',
          severity: 'info',
          nodeIds: Array.from(attachedNodeIds),
          edgeIds: [],
          title: `Unrestricted 0.0.0.0/0 egress in ${fw.id}`,
          short: `Outbound firewall rule ${rule.id} allows all destinations and ports.`,
          deep: `Production workloads typically restrict egress to required VPC CIDRs or HTTPS (443) endpoints to reduce exfiltration risk.`,
          fixes: [
            {
              label: `Restrict ${fw.id} egress to TCP 443`,
              patch: [
                {
                  op: 'replace',
                  path: `/network/firewalls/${fwIdx}/rules/${rIdx}`,
                  value: {
                    id: rule.id,
                    direction: 'egress',
                    action: 'allow',
                    ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
                    protocol: 'tcp',
                    portFrom: 443,
                    portTo: 443,
                    destination: { cidr: '0.0.0.0/0' },
                    description: 'HTTPS outbound only',
                  },
                },
              ],
            },
          ],
        });
      }
    }
  }

  return { smells, riskyEdgeReasons };
}
