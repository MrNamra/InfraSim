import type { FixSuggestion } from '@infrasim/shared-types';
import { getTrafficShare, resolveNodeService } from '../helpers.js';
import type { DiagnosisContext, Rule } from '../types.js';

const NAT_BLOCK_CODES = new Set(['NO_NAT', 'NAT_NOT_IN_PUBLIC_SUBNET']);
const PROMOTED_SMELL_IDS = new Set([
  'net-smell-db-public-subnet',
  'net-smell-ssh-open',
  'net-smell-open-world-nonweb',
]);

/** Rule: Flag every blocked edge from `ctx.network` (except NAT-specific cases covered by `no-nat-private-egress`). */
export const networkEdgeBlockedRule: Rule = {
  id: 'network-edge-blocked',
  title: 'Network path blocked',
  severity: 'critical',
  requires: ['network'],
  appliesTo: (ctx) => {
    if (!ctx.network) return [];
    const matches: ReturnType<Rule['appliesTo']> = [];
    for (const edge of ctx.design.edges) {
      const analysis = ctx.network.edges[edge.id];
      if (!analysis || analysis.reachable) continue;
      if (analysis.reasonCode && NAT_BLOCK_CODES.has(analysis.reasonCode)) continue;
      matches.push({
        nodeIds: [edge.from, edge.to],
        evidence: {
          edgeId: edge.id,
          fromNodeId: edge.from,
          toNodeId: edge.to,
          reasonCode: analysis.reasonCode ?? 'NO_ROUTE',
          failureMode: analysis.failureMode ?? 'timeout',
          short: analysis.explanation.short,
          deep: analysis.explanation.deep,
          fixesJson: JSON.stringify(analysis.fixes),
        },
        trafficShare: 1,
        durationFraction: 1,
      });
    }
    return matches;
  },
  explain: (m) => ({
    short: String(m.evidence.short ?? 'Network path is blocked.'),
    deep: String(m.evidence.deep ?? 'Blocked by network routing or firewall evaluation.'),
  }),
  fixes: (m, ctx) => {
    const edgeId = String(m.evidence.edgeId ?? '');
    return (ctx.network?.edges[edgeId]?.fixes ?? []) as FixSuggestion[];
  },
};

/** Rule: Flag private subnet workloads attempting outbound internet/SaaS egress without a working NAT gateway. */
export const noNatPrivateEgressRule: Rule = {
  id: 'no-nat-private-egress',
  title: 'Private subnet missing NAT Gateway for outbound egress',
  severity: 'critical',
  requires: ['network'],
  appliesTo: (ctx) => {
    if (!ctx.network) return [];
    const matches: ReturnType<Rule['appliesTo']> = [];
    for (const edge of ctx.design.edges) {
      const analysis = ctx.network.edges[edge.id];
      if (!analysis || analysis.reachable) continue;
      if (!analysis.reasonCode || !NAT_BLOCK_CODES.has(analysis.reasonCode)) continue;
      matches.push({
        nodeIds: [edge.from, edge.to],
        evidence: {
          edgeId: edge.id,
          reasonCode: analysis.reasonCode,
          short: analysis.explanation.short,
          deep: analysis.explanation.deep,
        },
        trafficShare: 0.9,
        durationFraction: 1,
      });
    }
    return matches;
  },
  explain: (m) => ({
    short: String(
      m.evidence.short ??
        'Private node cannot reach external/internet destination because no public NAT gateway route exists.',
    ),
    deep: String(
      m.evidence.deep ??
        'Private subnets lack public IPs and must route 0.0.0.0/0 egress through a NAT gateway placed in a public subnet.',
    ),
  }),
  fixes: (m, ctx) => {
    const edgeId = String(m.evidence.edgeId ?? '');
    return (ctx.network?.edges[edgeId]?.fixes ?? []) as FixSuggestion[];
  },
};

/** Rule: Database or stateful store exposed in a public subnet or assigned a public IP. */
export const dbPublicRule: Rule = {
  id: 'db-public',
  title: 'Database exposed in public subnet',
  severity: 'critical',
  requires: ['network'],
  appliesTo: (ctx) => {
    const smells = (ctx.network?.smells ?? []).filter(
      (s) => s.ruleId === 'net-smell-db-public-subnet',
    );
    return smells.map((s) => ({
      nodeIds: s.nodeIds,
      evidence: {
        smellRuleId: s.ruleId,
        title: s.title,
        short: s.short,
        deep: s.deep,
      },
      trafficShare: 0.85,
      durationFraction: 1,
    }));
  },
  explain: (m) => ({
    short: String(
      m.evidence.short ?? 'Database is placed in a public subnet or assigned a public IP.',
    ),
    deep: String(
      m.evidence.deep ??
        'Move databases to isolated private subnets with no public IP and allow ingress only from application security groups.',
    ),
  }),
  fixes: (m, ctx: DiagnosisContext) => {
    const targetTitle = String(m.evidence.title ?? '');
    const match = ctx.network?.smells?.find(
      (s) => s.ruleId === 'net-smell-db-public-subnet' && s.title === targetTitle,
    );
    return (match?.fixes ?? []) as FixSuggestion[];
  },
};

/** Rule: Firewall allows 0.0.0.0/0 ingress on sensitive non-web ports (SSH, RDP, DB). */
export const wideOpenIngressRule: Rule = {
  id: 'wide-open-ingress',
  title: 'Firewall allows 0.0.0.0/0 ingress on non-web ports',
  severity: 'critical',
  requires: ['network'],
  appliesTo: (ctx) => {
    const smells = (ctx.network?.smells ?? []).filter(
      (s) => s.ruleId === 'net-smell-ssh-open' || s.ruleId === 'net-smell-open-world-nonweb',
    );
    return smells.map((s) => ({
      nodeIds: s.nodeIds,
      severityOverride: s.severity,
      evidence: {
        smellRuleId: s.ruleId,
        title: s.title,
        short: s.short,
        deep: s.deep,
      },
      trafficShare: s.severity === 'critical' ? 0.9 : 0.6,
      durationFraction: 1,
    }));
  },
  explain: (m) => ({
    short: String(
      m.evidence.short ?? 'Security rule permits 0.0.0.0/0 ingress on administrative or DB ports.',
    ),
    deep: String(
      m.evidence.deep ??
        'Restrict ingress CIDR to internal VPC ranges or trusted bastion/peer security groups.',
    ),
  }),
  fixes: (m, ctx: DiagnosisContext) => {
    const smellId = String(m.evidence.smellRuleId ?? '');
    const title = String(m.evidence.title ?? '');
    const match = ctx.network?.smells?.find((s) => s.ruleId === smellId && s.title === title);
    return (match?.fixes ?? []) as FixSuggestion[];
  },
};

/** Rule: Surface remaining security smells detected by `network-analyzer`. */
export const networkSecuritySmellRule: Rule = {
  id: 'network-security-smell',
  title: 'Network security smell',
  severity: 'warning',
  requires: ['network'],
  appliesTo: (ctx) => {
    const smells = (ctx.network?.smells ?? []).filter((s) => !PROMOTED_SMELL_IDS.has(s.ruleId));
    return smells.map((s) => ({
      nodeIds: s.nodeIds,
      severityOverride: s.severity,
      evidence: {
        smellRuleId: s.ruleId,
        title: s.title,
        short: s.short,
        deep: s.deep,
      },
      trafficShare: s.severity === 'critical' ? 0.9 : s.severity === 'warning' ? 0.5 : 0.15,
      durationFraction: 1,
    }));
  },
  explain: (m) => ({
    short: String(m.evidence.short ?? 'Network security configuration smell detected.'),
    deep: String(m.evidence.deep ?? ''),
  }),
  fixes: (m, ctx: DiagnosisContext) => {
    const targetId = String(m.evidence.smellRuleId ?? '');
    const targetTitle = String(m.evidence.title ?? '');
    const match = ctx.network?.smells?.find(
      (s) => s.ruleId === targetId && s.title === targetTitle,
    );
    return (match?.fixes ?? []) as FixSuggestion[];
  },
};

/** Rule: Chatty synchronous service-to-service traffic crossing Availability Zones. */
export const crossAzChattyRule: Rule = {
  id: 'cross-az-chatty',
  title: 'Chatty traffic crossing Availability Zones',
  severity: 'info',
  requires: ['network'],
  appliesTo: (ctx) => {
    if (!ctx.network) return [];
    const matches: ReturnType<Rule['appliesTo']> = [];
    for (const edge of ctx.design.edges) {
      if (edge.callType !== 'sync') continue;
      const netEdge = ctx.network.edges[edge.id];
      if (!netEdge || !netEdge.reachable || !netEdge.crossAz) continue;

      const fromNode = ctx.design.nodes.find((n) => n.id === edge.from);
      const toNode = ctx.design.nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) continue;
      if (fromNode.serviceId === 'generic.client' || fromNode.serviceId === 'generic.users')
        continue;
      if (toNode.az?.toLowerCase() === 'multi-az') continue;

      const toRequests = ctx.result?.perNode[toNode.id]?.requests ?? 0;
      const hasSimTraffic = !ctx.result || toRequests >= 100;
      if (!hasSimTraffic) continue;

      matches.push({
        nodeIds: [fromNode.id, toNode.id],
        edgeIds: [edge.id],
        evidence: {
          fromLabel: fromNode.label,
          toLabel: toNode.label,
          fromAz: fromNode.az ?? 'az-a',
          toAz: toNode.az ?? 'az-b',
          extraLatencyMs: Number((netEdge.extraLatencyMs ?? 1.5).toFixed(1)),
          requests: toRequests,
        },
        trafficShare: ctx.result ? getTrafficShare(toRequests, ctx) : 0.4,
        durationFraction: 0.7,
      });
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.fromLabel} (${m.evidence.fromAz}) makes synchronous calls across AZs to ${m.evidence.toLabel} (${m.evidence.toAz}), adding ~${m.evidence.extraLatencyMs} ms and inter-AZ data charges.`,
    deep: `What happened: Cross-AZ chatter multiplies egress fees (~$0.01/GB each way) and adds RTT overhead.\nHow to fix: Co-locate tightly coupled callers or enable topology-aware / zone-local routing.\nTrade-off: Strict single-AZ affinity saves transfer fees at the cost of failover headroom.`,
  }),
  fixes: (m, ctx) => {
    const toIdx = ctx.design.nodes.findIndex((n) => n.id === m.nodeIds[1]);
    if (toIdx < 0) return [];
    const fromAz = String(m.evidence.fromAz ?? '');
    if (!fromAz || fromAz === 'multi-az') return [];
    return [
      {
        label: `Co-locate in ${fromAz} (save cross-AZ transfer)`,
        patch: [{ op: 'add', path: `/nodes/${toIdx}/az`, value: fromAz }],
        tradeOff: 'Single-AZ co-location lowers cross-AZ cost but reduces AZ isolation',
      },
    ];
  },
};

/** Rule: Synchronous calls crossing cloud regions on critical request path. */
export const crossRegionLatencyRule: Rule = {
  id: 'cross-region-latency',
  title: 'Synchronous cross-region hop on user path',
  severity: 'warning',
  requires: ['network'],
  appliesTo: (ctx) => {
    if (!ctx.network) return [];
    const matches: ReturnType<Rule['appliesTo']> = [];
    for (const edge of ctx.design.edges) {
      if (edge.callType !== 'sync') continue;
      const netEdge = ctx.network.edges[edge.id];
      const fromNode = ctx.design.nodes.find((n) => n.id === edge.from);
      const toNode = ctx.design.nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) continue;

      const isCrossRegion =
        Boolean(netEdge?.crossRegion) ||
        Boolean(fromNode.region && toNode.region && fromNode.region !== toNode.region);
      if (!isCrossRegion) continue;
      if (fromNode.serviceId === 'generic.client' || fromNode.serviceId === 'generic.users')
        continue;

      const svcTo = resolveNodeService(toNode.serviceId, ctx);
      const extraMs = netEdge?.extraLatencyMs ?? 60;
      const reqs = ctx.result?.perNode[toNode.id]?.requests ?? 100;
      matches.push({
        nodeIds: [fromNode.id, toNode.id],
        edgeIds: [edge.id],
        evidence: {
          fromLabel: fromNode.label,
          toLabel: toNode.label,
          fromRegion: fromNode.region ?? 'region-a',
          toRegion: toNode.region ?? 'region-b',
          extraLatencyMs: Math.round(extraMs),
          targetKind: svcTo?.kind ?? 'service',
        },
        trafficShare: ctx.result ? getTrafficShare(reqs, ctx) : 0.6,
        durationFraction: 0.8,
      });
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.fromLabel} (${m.evidence.fromRegion}) calls ${m.evidence.toLabel} (${m.evidence.toRegion}) synchronously across regions (~+${m.evidence.extraLatencyMs} ms RTT).`,
    deep: `What happened: Every request crossed regional boundaries synchronously.\nHow to fix: Replicate data / deploy service into ${m.evidence.fromRegion}, front with a CDN, or make cross-region sync asynchronous.`,
  }),
  fixes: (m, ctx) => {
    const toIdx = ctx.design.nodes.findIndex((n) => n.id === m.nodeIds[1]);
    const fromRegion = ctx.design.nodes.find((n) => n.id === m.nodeIds[0])?.region;
    if (toIdx < 0 || !fromRegion) return [];
    return [
      {
        label: `Move/replicate ${ctx.design.nodes[toIdx]!.label} to ${fromRegion}`,
        patch: [{ op: 'add', path: `/nodes/${toIdx}/region`, value: fromRegion }],
        tradeOff: 'Reduces WAN latency; verify regional capacity and residency rules',
      },
    ];
  },
};
