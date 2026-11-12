import { resolveNodeService } from '../helpers.js';
import type { DiagnosisContext, Rule } from '../types.js';

function nodeIndexOf(ctx: DiagnosisContext, nodeId: string | undefined): number {
  return nodeId ? ctx.design.nodes.findIndex((n) => n.id === nodeId) : -1;
}

/** Rule: Single resource line item accounts for > 50% of total estimated monthly bill. */
export const costDominantLineRule: Rule = {
  id: 'cost-dominant-line',
  title: 'Single service drives > 50% of monthly spend',
  severity: 'info',
  requires: ['cost'],
  appliesTo: (ctx) => {
    if (!ctx.cost || ctx.cost.monthlyTotal <= 10) return [];
    const total = ctx.cost.monthlyTotal;
    const matches = [];
    for (const [nodeId, entry] of Object.entries(ctx.cost.perNode)) {
      if (entry.subtotal <= 0) continue;
      const share = entry.subtotal / total;
      if (share > 0.5) {
        const node = ctx.design.nodes.find((n) => n.id === nodeId);
        if (!node) continue;
        matches.push({
          nodeIds: [nodeId],
          evidence: {
            nodeLabel: node.label,
            monthlyCost: Number(entry.subtotal.toFixed(2)),
            totalCost: Number(total.toFixed(2)),
            sharePct: Math.round(share * 100),
            currency: ctx.cost.currency,
          },
          trafficShare: Math.min(1, share),
          durationFraction: 1,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} accounts for ${m.evidence.sharePct}% (${m.evidence.monthlyCost} / ${m.evidence.totalCost} ${m.evidence.currency}) of projected monthly cost.`,
    deep: `What happened: More than half of the bill concentrates in ${m.evidence.nodeLabel}.\nHow to fix: Evaluate right-sizing instances, caching upstream reads, or choosing a smaller instance family.\nTrade-off: Trimming capacity saves spend but lowers peak headroom.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    if (node.config.instances > 2) {
      const target = Math.max(2, Math.ceil(node.config.instances * 0.75));
      return [
        {
          label: `Trim instances (${node.config.instances} -> ${target})`,
          patch: [{ op: 'replace', path: `/nodes/${idx}/config/instances`, value: target }],
          tradeOff: 'Lowers monthly spend at reduced peak headroom',
        },
      ];
    }
    return [];
  },
};

/** Rule: NAT gateway / NAT data processing exceeds 15% of total monthly spend. */
export const natCostHotspotRule: Rule = {
  id: 'nat-cost-hotspot',
  title: 'NAT gateway data processing > 15% of bill',
  severity: 'warning',
  requires: ['cost'],
  appliesTo: (ctx) => {
    if (!ctx.cost || ctx.cost.monthlyTotal <= 10) return [];
    const total = ctx.cost.monthlyTotal;

    let natSpend = 0;
    const natNodeIds: string[] = [];

    for (const [nodeId, entry] of Object.entries(ctx.cost.perNode)) {
      const node = ctx.design.nodes.find((n) => n.id === nodeId);
      const svc = node ? resolveNodeService(node.serviceId, ctx) : undefined;
      if (
        svc?.name?.toLowerCase().includes('nat') ||
        node?.serviceId.includes('nat_gw') ||
        node?.serviceId.includes('cloud_nat') ||
        node?.serviceId.includes('nat_gateway')
      ) {
        natSpend += entry.subtotal;
        natNodeIds.push(nodeId);
      }
    }

    for (const line of ctx.cost.transfer) {
      if (line.amount !== null && /nat/i.test(line.dimension)) {
        natSpend += line.amount;
      }
    }

    const share = natSpend / total;
    if (natSpend > 0 && share > 0.15) {
      return [
        {
          nodeIds: natNodeIds.length > 0 ? natNodeIds : [ctx.design.nodes[0]?.id ?? 'design'],
          evidence: {
            natSpend: Number(natSpend.toFixed(2)),
            totalCost: Number(total.toFixed(2)),
            sharePct: Math.round(share * 100),
            currency: ctx.cost.currency,
          },
          trafficShare: Math.min(1, share * 1.5),
          durationFraction: 1,
        },
      ];
    }
    return [];
  },
  explain: (m) => ({
    short: `NAT Gateway hours and per-GB processing make up ${m.evidence.sharePct}% (${m.evidence.natSpend} ${m.evidence.currency}/mo) of total spend.`,
    deep: `What happened: Private subnet calls to storage, queues, or APIs flowed through paid NAT gateways (~$0.045/GB).\nHow to fix: Add free Gateway VPC Endpoints for S3/DynamoDB or PrivateLink endpoints for internal traffic.\nTrade-off: Private endpoints eliminate NAT per-GB charges for supported services.`,
  }),
  fixes: () => [],
};

/** Rule: Internet egress / data transfer out exceeds 25% of total monthly spend. */
export const egressHeavyRule: Rule = {
  id: 'egress-heavy',
  title: 'Internet egress exceeds 25% of monthly bill',
  severity: 'warning',
  requires: ['cost'],
  appliesTo: (ctx) => {
    if (!ctx.cost || ctx.cost.monthlyTotal <= 10) return [];
    const total = ctx.cost.monthlyTotal;

    let egressSpend = 0;
    for (const line of ctx.cost.transfer) {
      if (line.amount === null) continue;
      if (/egress|internet|outbound/i.test(line.dimension) && !/nat/i.test(line.dimension)) {
        egressSpend += line.amount;
      }
    }
    for (const entry of Object.values(ctx.cost.perNode)) {
      for (const line of entry.lines) {
        if (line.amount !== null && /egress|data transfer out/i.test(line.dimension)) {
          egressSpend += line.amount;
        }
      }
    }

    const share = egressSpend / total;
    if (egressSpend > 0 && share > 0.25) {
      const originNode =
        ctx.design.nodes.find((n) => {
          const k = resolveNodeService(n.serviceId, ctx)?.kind;
          return k === 'lb' || k === 'gw' || k === 'object';
        }) ?? ctx.design.nodes[0];
      return [
        {
          nodeIds: originNode ? [originNode.id] : [],
          evidence: {
            egressSpend: Number(egressSpend.toFixed(2)),
            totalCost: Number(total.toFixed(2)),
            sharePct: Math.round(share * 100),
            currency: ctx.cost.currency,
          },
          trafficShare: Math.min(1, share * 1.2),
          durationFraction: 1,
        },
      ];
    }
    return [];
  },
  explain: (m) => ({
    short: `Internet egress accounts for ${m.evidence.sharePct}% (${m.evidence.egressSpend} ${m.evidence.currency}/mo) of total monthly cost.`,
    deep: `What happened: Large uncached responses left your cloud directly over paid public egress.\nHow to fix: Put a CDN in front of static/API responses, enable gzip/brotli compression, and trim payload sizes.`,
  }),
  fixes: () => [],
};

/** Rule: Over-provisioned node paying > $25/mo while running under 25% peak utilization. */
export const overSpecVsNeedRule: Rule = {
  id: 'over-spec-vs-need',
  title: 'Over-provisioned tier vs observed load',
  severity: 'info',
  requires: ['cost', 'sim'],
  appliesTo: (ctx) => {
    if (!ctx.cost || !ctx.result) return [];
    const matches = [];
    for (const node of ctx.design.nodes) {
      if (node.serviceId === 'generic.client' || node.serviceId === 'generic.users') continue;
      const summary = ctx.result.perNode[node.id];
      const costEntry = ctx.cost.perNode[node.id];
      if (!summary || !costEntry || summary.requests <= 0) continue;

      const subtotal = costEntry.subtotal;
      const oversized = node.config.instances >= 3 || (node.config.vcpu ?? 2) >= 4;
      if (oversized && summary.peakUtilization < 0.25 && subtotal >= 25) {
        matches.push({
          nodeIds: [node.id],
          evidence: {
            nodeLabel: node.label,
            peakUtilPct: Math.round(summary.peakUtilization * 100),
            instances: node.config.instances,
            monthlyCost: Number(subtotal.toFixed(2)),
            currency: ctx.cost.currency,
          },
          trafficShare: 0.4,
          durationFraction: 1,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} costs ${m.evidence.monthlyCost} ${m.evidence.currency}/mo across ${m.evidence.instances} instances yet peaked at only ${m.evidence.peakUtilPct}% utilization.`,
    deep: `What happened: Configured capacity is over 4x higher than peak simulated load.\nHow to fix: Downsize instance count (keeping >= 2 for HA) or step down instance size.\nTrade-off: Reduces monthly compute cost while leaving >= 2x headroom for current traffic.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    if (node.config.instances >= 3) {
      const nextCount = Math.max(2, Math.floor(node.config.instances / 2));
      return [
        {
          label: `Right-size instances (${node.config.instances} -> ${nextCount})`,
          patch: [{ op: 'replace', path: `/nodes/${idx}/config/instances`, value: nextCount }],
          tradeOff: 'Lowers compute cost while maintaining Multi-AZ floor (>= 2)',
        },
      ];
    }
    const nextVcpu = Math.max(2, Math.floor((node.config.vcpu ?? 4) / 2));
    return [
      {
        label: `Right-size vCPU (${node.config.vcpu} -> ${nextVcpu})`,
        patch: [{ op: 'replace', path: `/nodes/${idx}/config/vcpu`, value: nextVcpu }],
      },
    ];
  },
};
