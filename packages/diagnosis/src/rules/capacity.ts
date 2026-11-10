import { evaluateAllNodes, getTrafficShare, resolveNodeService } from '../helpers.js';
import type { Rule } from '../types.js';

function nodeIndexOf(
  ctx: { design: { nodes: { id: string }[] } },
  nodeId: string | undefined,
): number {
  return nodeId ? ctx.design.nodes.findIndex((n) => n.id === nodeId) : -1;
}

/** Rule: CPU cores saturated (`avgCpuUtilization >= 0.85` or busy CPU during overload). */
export const cpuSaturatedRule: Rule = {
  id: 'cpu-saturated',
  title: 'CPU cores saturated',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'cpu-vs-io-bound',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const evals = evaluateAllNodes(ctx);
    const matches = [];
    for (const info of evals) {
      const cpu = info.summary.avgCpuUtilization ?? 0;
      const util = info.summary.avgUtilization;
      if (cpu >= 0.85 || (util >= 0.85 && cpu >= 0.7)) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            cpuPct: Math.round(cpu * 100),
            peakUtilPct: Math.round(info.summary.peakUtilization * 100),
            p95Ms: Math.round(info.summary.p95),
            instances: info.node.config.instances,
            vcpu: info.node.config.vcpu ?? 1,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.min(1, Math.max(0.2, util)),
        });
      }
    }
    return matches;
  },
  explain: (m, ctx) => {
    const node = ctx.design.nodes.find((n) => n.id === m.nodeIds[0]);
    const isSingleCoreNode =
      (node?.config.runtimePreset ?? 'node') === 'node' && !node?.config.cluster;
    return {
      short: `${m.evidence.nodeLabel} likely hit a CPU limit (~${m.evidence.cpuPct}% busy across ${m.evidence.instances}x ${m.evidence.vcpu} vCPU), pushing latency to ${m.evidence.p95Ms} ms p95.`,
      deep: `What happened: Requests arriving at ${m.evidence.nodeLabel} spent CPU time faster than available cores could drain them (~${m.evidence.cpuPct}% CPU utilization).\nWhy: Under saturation, incoming requests queue behind active CPU work${isSingleCoreNode ? ' (Node.js without cluster mode uses 1 CPU core per instance)' : ''}.\nHow to fix: Add instances, increase vCPU per instance${isSingleCoreNode ? ', or enable Node.js cluster mode to use all vCPUs' : ''}.\nTrade-off: More instances/vCPU increase compute cost directly.`,
    };
  },
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const curInstances = Math.max(1, node.config.instances);
    const curVcpu = Math.max(1, node.config.vcpu ?? 1);
    const fixes: {
      label: string;
      patch: { op: 'add'; path: string; value: unknown }[];
    }[] = [
      {
        label: `Scale instances (${curInstances} -> ${curInstances * 2})`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/instances`,
            value: curInstances * 2,
          },
        ],
      },
      {
        label: `Double vCPU (${curVcpu} -> ${curVcpu * 2})`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/vcpu`,
            value: curVcpu * 2,
          },
        ],
      },
    ];
    if ((node.config.runtimePreset ?? 'node') === 'node' && !node.config.cluster && curVcpu >= 2) {
      fixes.unshift({
        label: 'Enable Node.js cluster mode',
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/cluster`,
            value: true,
          },
        ],
      });
    }
    return fixes;
  },
};

/** Rule: Concurrency slots saturated while CPU remains mostly idle (blocked on I/O). */
export const slotsExhaustedRule: Rule = {
  id: 'slots-exhausted',
  title: 'Concurrency slots exhausted (I/O wait)',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'concurrency-slots-and-littles-law',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const cpu = info.summary.avgCpuUtilization ?? 0;
      const peak = info.summary.peakUtilization;
      if ((peak >= 0.85 || info.summary.avgUtilization >= 0.8) && cpu < 0.7) {
        const svc = resolveNodeService(info.node.serviceId, ctx);
        if (svc?.kind === 'sql' || svc?.kind === 'doc' || svc?.kind === 'graph') continue;
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            peakUtilPct: Math.round(peak * 100),
            cpuPct: Math.round(cpu * 100),
            p95Ms: Math.round(info.summary.p95),
            instances: info.node.config.instances,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.min(1, Math.max(0.2, info.summary.avgUtilization)),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} filled concurrency slots (${m.evidence.peakUtilPct}% peak) while CPU stayed low (${m.evidence.cpuPct}%).`,
    deep: `What happened: All request slots on ${m.evidence.nodeLabel} stayed occupied waiting on downstream responses.\nWhy: By Little's Law (L = λ x W), slow downstream calls tie up worker slots even while CPU is ${m.evidence.cpuPct}% busy.\nHow to fix: Add instances, raise max concurrency, or add a cache to cut downstream wait.\nTrade-off: Higher concurrency uses more memory and shifts load downstream.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const curInstances = Math.max(1, node.config.instances);
    const curConc = Math.max(20, node.config.maxInFlightPerInstance ?? 100);
    return [
      {
        label: `Scale instances (${curInstances} -> ${curInstances * 2})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: curInstances * 2 }],
      },
      {
        label: `Raise max concurrency (${curConc} -> ${Math.min(5000, curConc * 2)})`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/maxInFlightPerInstance`,
            value: Math.min(5000, curConc * 2),
          },
        ],
      },
    ];
  },
};

/** Rule: Requests dropped due to full bounded queue (`dropped_queue_full > 0`). */
export const dropsQueueFullRule: Rule = {
  id: 'drops-queue-full',
  title: 'Requests dropped (queue full)',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'bounded-queues-and-backpressure',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      if (info.summary.drops > 0) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            drops: info.summary.drops,
            peakQueue: info.summary.peakQueueDepth,
            instances: info.node.config.instances,
          },
          trafficShare: Math.min(1, info.summary.drops / Math.max(1, info.summary.requests)),
          durationFraction: Math.max(
            0.25,
            info.overloadedBuckets / Math.max(1, ctx.result.durationS),
          ),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} dropped ${m.evidence.drops} requests after its queue filled to ${m.evidence.peakQueue}.`,
    deep: `What happened: Arrivals exceeded ${m.evidence.nodeLabel}'s service rate until slots and bounded wait queue filled.\nWhy: Failing fast bounds queue latency and memory pressure, returning drops to callers.\nHow to fix: Scale capacity or enlarge the burst queue for short spikes.\nTrade-off: Larger queues turn drops into higher tail latency during sustained overload.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const curInstances = Math.max(1, node.config.instances);
    const curQ = Math.max(50, node.config.queue?.maxLength ?? 1000);
    return [
      {
        label: `Add instances (${curInstances} -> ${curInstances * 2})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: curInstances * 2 }],
      },
      {
        label: `Increase queue depth (${curQ} -> ${curQ * 2})`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/queue`,
            value: { maxLength: curQ * 2, policy: node.config.queue?.policy ?? 'reject' },
          },
        ],
      },
    ];
  },
};

/** Rule: Sustained queue growth across >= 5 consecutive 1-second buckets. */
export const queueGrowingRule: Rule = {
  id: 'queue-growing',
  title: 'Queue depth growing continuously',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      if (info.growingQueueBuckets >= 5 && info.summary.peakQueueDepth > 5) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            growthSec: info.growingQueueBuckets,
            peakQueue: info.summary.peakQueueDepth,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.min(
            1,
            info.growingQueueBuckets / Math.max(1, ctx.result.durationS),
          ),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel}'s queue grew for ${m.evidence.growthSec} s (peak depth ${m.evidence.peakQueue}).`,
    deep: `What happened: Arrivals exceeded ${m.evidence.nodeLabel}'s drain rate for ${m.evidence.growthSec} consecutive seconds.\nHow to fix: Scale instances out or rate-limit excess arrivals.\nTrade-off: Scaling increases instance cost while stabilizing latency.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const cur = Math.max(1, ctx.design.nodes[idx]!.config.instances);
    return [
      {
        label: `Scale instances (${cur} -> ${cur + 1})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: cur + 1 }],
      },
    ];
  },
};

/** Rule: Autoscaling enabled, yet node saturated during warmup window. */
export const autoscaleTooSlowRule: Rule = {
  id: 'autoscale-too-slow',
  title: 'Autoscaling warmed up too slowly for spike',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const as = info.node.config.autoscaling;
      if (as && (info.summary.peakUtilization >= 0.9 || info.summary.drops > 0)) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            warmupS: as.warmupS,
            minInstances: as.min,
            peakUtilPct: Math.round(info.summary.peakUtilization * 100),
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.min(1, as.warmupS / Math.max(1, ctx.result.durationS)),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} saturated (${m.evidence.peakUtilPct}% peak) during its ${m.evidence.warmupS} s autoscale warmup.`,
    deep: `What happened: Traffic spiked faster than ${m.evidence.nodeLabel}'s autoscaler could boot and warm new capacity (${m.evidence.warmupS} s warmup).\nHow to fix: Increase min instances for headroom or reduce warmup duration.\nTrade-off: Higher min instances adds baseline idle spend.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const as = ctx.design.nodes[idx]!.config.autoscaling;
    if (!as) return [];
    return [
      {
        label: `Raise min instances (${as.min} -> ${as.min + 1})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/autoscaling/min`, value: as.min + 1 }],
      },
    ];
  },
};

/**
 * Rule: Primary bottleneck / universal coverage fallback guaranteeing EVERY hot/overloaded/down node
 * has a concrete explanation and minimal fix patch.
 */
export const bottleneckNodeRule: Rule = {
  id: 'bottleneck-node',
  title: 'Service bottleneck detected',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'identifying-bottlenecks',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      if (!info.isHotOrOverloaded) continue;
      const isDown = info.downBuckets > 0;
      const overloaded = info.overloadedBuckets > 0 || info.summary.peakUtilization >= 0.95;
      matches.push({
        nodeIds: [info.node.id],
        severityOverride: isDown || overloaded ? ('critical' as const) : ('warning' as const),
        evidence: {
          nodeLabel: info.node.label,
          avgUtilPct: Math.round(info.summary.avgUtilization * 100),
          peakUtilPct: Math.round(info.summary.peakUtilization * 100),
          p95Ms: Math.round(info.summary.p95),
          drops: info.summary.drops,
          theoreticalMaxRps: info.summary.theoreticalMaxRps ?? 0,
        },
        trafficShare: getTrafficShare(info.summary.requests, ctx),
        durationFraction: Math.max(
          0.15,
          (info.hotBuckets + info.overloadedBuckets + info.downBuckets) /
            Math.max(1, ctx.result.durationS),
        ),
      });
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} hit ${m.evidence.peakUtilPct}% peak load (${m.evidence.p95Ms} ms p95${Number(m.evidence.drops) > 0 ? `, ${m.evidence.drops} drops` : ''}).`,
    deep: `What happened: ${m.evidence.nodeLabel} operated near or above its sustainable capacity (~${m.evidence.theoreticalMaxRps} req/s max).\nWhy: Above 80% utilization, queueing delay grows steeply.\nHow to fix: Scale out instances or offload reads with caching.\nTrade-off: More instances increase monthly cost while restoring low latency.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const cur = Math.max(1, ctx.design.nodes[idx]!.config.instances);
    return [
      {
        label: `Scale instances (${cur} -> ${cur + 1})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: cur + 1 }],
      },
    ];
  },
};

/** Rule: Informational insight for multi-instance nodes running below 15% peak utilization. */
export const idleOverprovisionedRule: Rule = {
  id: 'idle-overprovisioned',
  title: 'Overprovisioned capacity (< 15% peak util)',
  severity: 'info',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      if (
        info.node.config.instances > 1 &&
        info.summary.requests > 0 &&
        info.summary.drops === 0 &&
        info.downBuckets === 0 &&
        (info.summary.errors.throttled ?? 0) === 0 &&
        info.summary.peakUtilization < 0.15
      ) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            peakUtilPct: Math.round(info.summary.peakUtilization * 100),
            instances: info.node.config.instances,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: 1,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} peaked at ${m.evidence.peakUtilPct}% across ${m.evidence.instances} instances.`,
    deep: `What happened: ${m.evidence.nodeLabel} used under 15% capacity for the entire run.\nHow to fix: Reduce instances if HA redundancy is not required.\nTrade-off: Fewer than 2 instances sacrifices single-instance failover.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const cur = Math.max(2, ctx.design.nodes[idx]!.config.instances);
    const next = Math.max(1, Math.ceil(cur / 2));
    return [
      {
        label: `Downsize instances (${cur} -> ${next})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: next }],
      },
    ];
  },
};
