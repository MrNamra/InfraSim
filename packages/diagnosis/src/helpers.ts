import type { ServiceDefinition } from '@infrasim/shared-types';
import { getService } from '@infrasim/catalog';
import type { DiagnosisContext, NodeEvalInfo } from './types.js';

export function resolveNodeService(
  serviceId: string,
  ctx: DiagnosisContext,
): ServiceDefinition | undefined {
  if (ctx.catalog) {
    return (
      ctx.catalog.find((s) => s.id === serviceId) ??
      ctx.design.customServices?.find((s) => s.id === serviceId)
    );
  }
  return getService(serviceId, ctx.design.customServices);
}

export function isClientService(serviceId: string): boolean {
  return serviceId === 'generic.client' || serviceId === 'generic.users';
}

export function sumSummaryErrors(summary: { errors: Record<string, number | undefined> }): number {
  let sum = 0;
  for (const val of Object.values(summary.errors)) {
    if (typeof val === 'number') {
      sum += val;
    }
  }
  return sum;
}

export function evaluateAllNodes(ctx: DiagnosisContext): NodeEvalInfo[] {
  const result = ctx.result;
  if (!result) return [];

  const buckets = result.series.buckets;
  const out: NodeEvalInfo[] = [];

  for (let idx = 0; idx < ctx.design.nodes.length; idx++) {
    const node = ctx.design.nodes[idx]!;
    if (isClientService(node.serviceId)) continue;
    const summary = result.perNode[node.id];
    if (!summary) continue;

    let hotBuckets = 0;
    let overloadedBuckets = 0;
    let downBuckets = 0;
    let maxConsecGrowth = 0;
    let curGrowth = 0;
    let prevQ = 0;

    for (const b of buckets) {
      const nb = b.perNode[node.id];
      if (!nb) continue;
      if (nb.instancesActive <= 0) {
        downBuckets += 1;
      } else if (
        nb.utilization >= 0.95 ||
        nb.drops > 0 ||
        (nb.rpsIn > 0 && nb.errors / nb.rpsIn > 0.2 && (summary.errors.throttled ?? 0) > 0)
      ) {
        overloadedBuckets += 1;
      } else if (nb.utilization >= 0.8) {
        hotBuckets += 1;
      }

      if (nb.queueDepth > prevQ && nb.queueDepth > 0) {
        curGrowth += 1;
        maxConsecGrowth = Math.max(maxConsecGrowth, curGrowth);
      } else {
        curGrowth = 0;
      }
      prevQ = nb.queueDepth;
    }

    const totalReqs = Math.max(1, summary.requests);
    const throttledRatio = (summary.errors.throttled ?? 0) / totalReqs;
    const isHotOrOverloaded =
      summary.peakUtilization >= 0.8 ||
      summary.avgUtilization >= 0.8 ||
      summary.drops > 0 ||
      maxConsecGrowth >= 5 ||
      throttledRatio > 0.01 ||
      hotBuckets > 0 ||
      overloadedBuckets > 0 ||
      downBuckets > 0;

    out.push({
      node,
      nodeIdx: idx,
      summary,
      hotBuckets,
      overloadedBuckets,
      downBuckets,
      growingQueueBuckets: maxConsecGrowth,
      isHotOrOverloaded,
    });
  }

  return out;
}

export function getTrafficShare(summaryRequests: number, ctx: DiagnosisContext): number {
  const total = Math.max(1, ctx.result?.summary.totalRequests ?? 1);
  return Math.min(1, Math.max(0.05, summaryRequests / total));
}
