import { getTrafficShare, resolveNodeService, sumSummaryErrors } from '../helpers.js';
import type { DiagnosisContext, Rule } from '../types.js';

function nodeIndexOf(ctx: DiagnosisContext, nodeId: string | undefined): number {
  return nodeId ? ctx.design.nodes.findIndex((n) => n.id === nodeId) : -1;
}

function edgeIndexOf(ctx: DiagnosisContext, edgeId: string | undefined): number {
  return edgeId ? ctx.design.edges.findIndex((e) => e.id === edgeId) : -1;
}

/** Rule: Node on critical path with instances=1 or single AZ handling >= 20% traffic or downed by chaos. */
export const singlePointOfFailureRule: Rule = {
  id: 'single-point-of-failure',
  title: 'Single point of failure (1 instance)',
  severity: 'warning',
  requires: ['sim'],
  lessonSlug: 'high-availability-multi-az',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const totalReq = Math.max(1, ctx.result.summary.totalRequests);
    const matches = [];

    for (const node of ctx.design.nodes) {
      if (node.serviceId === 'generic.client' || node.serviceId === 'generic.users') continue;
      if (node.serviceId === 'generic.internet') continue;
      const svc = resolveNodeService(node.serviceId, ctx);
      if (svc?.kind === 'fn' || svc?.kind === 'cdn' || svc?.kind === 'dns') continue;

      const summary = ctx.result.perNode[node.id];
      if (!summary || summary.requests <= 0) continue;

      const isMultiAz = node.az?.toLowerCase() === 'multi-az';
      const singleInstance = node.config.instances <= 1 && !isMultiAz;
      const singleAzMultiInstance =
        node.config.instances > 1 &&
        !isMultiAz &&
        ctx.result.series.buckets.some((b) => (b.perNode[node.id]?.instancesActive ?? 1) === 0);

      const trafficShare = summary.requests / totalReq;
      const hadOutage = ctx.result.series.buckets.some(
        (b) => (b.perNode[node.id]?.instancesActive ?? 1) <= 0,
      );

      if ((singleInstance && (trafficShare >= 0.2 || hadOutage)) || singleAzMultiInstance) {
        matches.push({
          nodeIds: [node.id],
          severityOverride: hadOutage ? ('critical' as const) : ('warning' as const),
          evidence: {
            nodeLabel: node.label,
            instances: node.config.instances,
            multiAz: isMultiAz ? 'yes' : 'no',
            trafficSharePct: Math.round(trafficShare * 100),
            hadOutage: hadOutage ? 'yes' : 'no',
          },
          trafficShare: Math.min(1, Math.max(0.15, trafficShare)),
          durationFraction: hadOutage ? 0.8 : 0.35,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} carries ${m.evidence.trafficSharePct}% of traffic on ${m.evidence.instances} instance without Multi-AZ redundancy.`,
    deep: `What happened: ${m.evidence.nodeLabel} is a single point of failure (instances=${m.evidence.instances}, Multi-AZ=${m.evidence.multiAz}).\nWhy: Any host crash, maintenance restart, or AZ outage drops 100% of traffic through this tier.\nHow to fix: Run at least 2 instances across distinct Availability Zones (Multi-AZ).\nTrade-off: Doubles compute/DB baseline spend in exchange for failover availability.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const nextInstances = Math.max(2, node.config.instances);
    return [
      {
        label: `Enable HA (${nextInstances} instances, Multi-AZ)`,
        patch: [
          { op: 'add', path: `/nodes/${idx}/config/instances`, value: nextInstances },
          { op: 'add', path: `/nodes/${idx}/az`, value: 'multi-az' },
        ],
      },
    ];
  },
};

/** Rule: Aggressive retries amplifying downstream errors (> 20% retry volume or un-jittered retries under load). */
export const retryStormRule: Rule = {
  id: 'retry-storm',
  title: 'Retry storm amplifying downstream failures',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'retries-backoff-and-circuit-breakers',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    const totalRetrySpansByTarget = new Map<string, number>();

    for (const trace of ctx.result.traces) {
      for (const span of trace.spans) {
        const attempt = Number(span.attrs?.attempt ?? 1);
        if (attempt > 1) {
          totalRetrySpansByTarget.set(
            span.nodeId,
            (totalRetrySpansByTarget.get(span.nodeId) ?? 0) + 1,
          );
        }
      }
    }

    for (const edge of ctx.design.edges) {
      if (!edge.retry || edge.retry.max <= 0) continue;
      const toSummary = ctx.result.perNode[edge.to];
      const fromSummary = ctx.result.perNode[edge.from];
      if (!toSummary || toSummary.requests <= 0) continue;

      const toErrTotal = sumSummaryErrors(toSummary) + toSummary.drops;
      const errRatio = toErrTotal / Math.max(1, toSummary.requests);
      const retrySpans = totalRetrySpansByTarget.get(edge.to) ?? 0;
      const hasJitter = edge.retry.jitter;
      const hasBackoff = edge.retry.backoffMs >= 25;
      const hasCb = Boolean(edge.circuitBreaker);

      const triggeredBySpans = retrySpans > 0 && errRatio > 0.05;
      const triggeredByAmplification =
        (errRatio >= 0.15 || (toSummary.peakUtilization >= 0.9 && toErrTotal > 0)) &&
        (!hasJitter || !hasBackoff || !hasCb);

      if (triggeredBySpans || triggeredByAmplification) {
        const targetNode = ctx.design.nodes.find((n) => n.id === edge.to);
        const callerNode = ctx.design.nodes.find((n) => n.id === edge.from);
        matches.push({
          nodeIds: [edge.from, edge.to],
          edgeIds: [edge.id],
          evidence: {
            edgeId: edge.id,
            callerLabel: callerNode?.label ?? edge.from,
            targetLabel: targetNode?.label ?? edge.to,
            maxRetries: edge.retry.max,
            backoffMs: edge.retry.backoffMs,
            jitter: edge.retry.jitter ? 'on' : 'off',
            targetErrorPct: Math.round(errRatio * 100),
            retrySpans,
          },
          trafficShare: getTrafficShare(
            Math.max(fromSummary?.requests ?? 0, toSummary.requests),
            ctx,
          ),
          durationFraction: Math.max(0.35, Math.min(1, errRatio * 2)),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `Edge ${m.evidence.callerLabel} → ${m.evidence.targetLabel} retried aggressively (max=${m.evidence.maxRetries}, backoff=${m.evidence.backoffMs} ms, jitter=${m.evidence.jitter}) while errors hit ${m.evidence.targetErrorPct}%.`,
    deep: `What happened: Immediate or un-jittered retries multiplied inbound traffic onto ${m.evidence.targetLabel} just as it began failing (${m.evidence.targetErrorPct}% error rate).\nWhy: Without exponential backoff + jitter and a circuit breaker, N callers retrying M times multiplies overload by up to (M + 1)x.\nHow to fix: Add exponential backoff with jitter (>= 100 ms), cap retries, and attach a circuit breaker.\nTrade-off: Failing requests return slightly faster instead of retrying repeatedly against a saturated dependency.`,
  }),
  fixes: (m, ctx) => {
    const eIdx = edgeIndexOf(ctx, String(m.evidence.edgeId ?? ''));
    if (eIdx < 0) return [];
    return [
      {
        label: 'Enable exponential backoff + jitter & circuit breaker',
        patch: [
          {
            op: 'add',
            path: `/edges/${eIdx}/retry`,
            value: { max: 2, backoffMs: 100, jitter: true },
          },
          {
            op: 'add',
            path: `/edges/${eIdx}/circuitBreaker`,
            value: { failureThreshold: 5, windowMs: 10_000, openMs: 10_000 },
          },
        ],
      },
    ];
  },
};

/** Rule: Node without an explicit timeout experiencing severe tail latency (> 5x p50 and > 100 ms p99). */
export const noTimeoutRule: Rule = {
  id: 'no-timeout',
  title: 'Missing timeout under heavy tail latency',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const node of ctx.design.nodes) {
      if (node.serviceId === 'generic.client' || node.serviceId === 'generic.users') continue;
      if (node.serviceId === 'generic.internet') continue;
      const summary = ctx.result.perNode[node.id];
      if (!summary || summary.requests <= 0) continue;

      const hasOutbound = ctx.design.edges.some((e) => e.from === node.id && e.callType === 'sync');
      if (!hasOutbound) continue;

      const hasTimeout = node.config.timeoutMs !== undefined && node.config.timeoutMs > 0;
      const ratio = summary.p99 / Math.max(1, summary.p50);
      if (!hasTimeout && ratio > 5 && summary.p99 > 100) {
        matches.push({
          nodeIds: [node.id],
          evidence: {
            nodeLabel: node.label,
            p50Ms: Math.round(summary.p50),
            p99Ms: Math.round(summary.p99),
            tailRatio: Number(ratio.toFixed(1)),
          },
          trafficShare: getTrafficShare(summary.requests, ctx),
          durationFraction: 0.45,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} has no request timeout set even though p99 (${m.evidence.p99Ms} ms) is ${m.evidence.tailRatio}x its p50 (${m.evidence.p50Ms} ms).`,
    deep: `What happened: Requests through ${m.evidence.nodeLabel} wait indefinitely during downstream stalls (${m.evidence.p99Ms} ms p99 vs ${m.evidence.p50Ms} ms p50).\nHow to fix: Configure an explicit timeout (e.g. 3000 ms) so stalled calls release worker slots promptly.\nTrade-off: Slow outliers beyond the deadline fail with timeout instead of blocking threads.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const p95 = Math.max(200, Math.round(Number(m.evidence.p99Ms ?? 500) * 1.2));
    const suggested = Math.min(10_000, Math.max(500, Math.ceil(p95 / 100) * 100));
    return [
      {
        label: `Set ${suggested} ms timeout`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/timeoutMs`, value: suggested }],
      },
    ];
  },
};

/** Rule: Upstream parent timeout <= downstream child timeout (parent gives up before child does). */
export const timeoutInversionRule: Rule = {
  id: 'timeout-inversion',
  title: 'Timeout inversion (child deadline >= parent)',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const edge of ctx.design.edges) {
      if (edge.callType !== 'sync') continue;
      const parent = ctx.design.nodes.find((n) => n.id === edge.from);
      const child = ctx.design.nodes.find((n) => n.id === edge.to);
      if (!parent || !child) continue;
      if (parent.serviceId === 'generic.client' || parent.serviceId === 'generic.users') continue;

      const parentTimeout = parent.config.timeoutMs;
      const childTimeout = child.config.timeoutMs;
      if (
        parentTimeout !== undefined &&
        parentTimeout > 0 &&
        childTimeout !== undefined &&
        childTimeout >= parentTimeout
      ) {
        const parentSummary = ctx.result.perNode[parent.id];
        matches.push({
          nodeIds: [parent.id, child.id],
          edgeIds: [edge.id],
          evidence: {
            parentLabel: parent.label,
            childLabel: child.label,
            parentTimeoutMs: parentTimeout,
            childTimeoutMs: childTimeout,
          },
          trafficShare: getTrafficShare(parentSummary?.requests ?? 1, ctx),
          durationFraction: 0.5,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.parentLabel} times out at ${m.evidence.parentTimeoutMs} ms, which is <= ${m.evidence.childLabel}'s ${m.evidence.childTimeoutMs} ms timeout.`,
    deep: `What happened: ${m.evidence.parentLabel} (${m.evidence.parentTimeoutMs} ms) aborts before ${m.evidence.childLabel} (${m.evidence.childTimeoutMs} ms) finishes.\nWhy: ${m.evidence.childLabel} continues performing wasted "zombie" work for a caller that already hung up.\nHow to fix: Set the downstream timeout strictly below the parent deadline (or raise the parent timeout).`,
  }),
  fixes: (m, ctx) => {
    const childIdx = nodeIndexOf(ctx, m.nodeIds[1]);
    if (childIdx < 0) return [];
    const parentTimeout = Number(m.evidence.parentTimeoutMs ?? 1000);
    const nextChild = Math.max(100, Math.round(parentTimeout * 0.7));
    return [
      {
        label: `Tighten child timeout to ${nextChild} ms (< ${parentTimeout} ms)`,
        patch: [{ op: 'add', path: `/nodes/${childIdx}/config/timeoutMs`, value: nextChild }],
      },
    ];
  },
};

/** Rule: Significant wasted "zombie work" executed after upstream caller already timed out (> 10%). */
export const zombieWorkRule: Rule = {
  id: 'zombie-work',
  title: 'Wasted zombie work after caller timeout',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const node of ctx.design.nodes) {
      if (node.serviceId === 'generic.client' || node.serviceId === 'generic.users') continue;
      const summary = ctx.result.perNode[node.id];
      if (!summary || summary.requests <= 0) continue;

      const wastedMs = summary.wastedWorkMs ?? 0;
      if (wastedMs <= 0) continue;

      const busyMs = Math.max(1, summary.requests * Math.max(1, summary.p50));
      const wastedRatio = wastedMs / busyMs;
      if (wastedRatio > 0.1 || wastedMs > 1000) {
        matches.push({
          nodeIds: [node.id],
          evidence: {
            nodeLabel: node.label,
            wastedWorkMs: Math.round(wastedMs),
            wastedPct: Math.min(100, Math.round(wastedRatio * 100)),
            requests: summary.requests,
          },
          trafficShare: getTrafficShare(summary.requests, ctx),
          durationFraction: Math.min(1, Math.max(0.25, wastedRatio)),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} spent ${m.evidence.wastedWorkMs} ms finishing requests after upstream callers had already timed out.`,
    deep: `What happened: Upstream callers timed out and abandoned responses while ${m.evidence.nodeLabel} kept executing those requests (${m.evidence.wastedWorkMs} ms wasted work).\nHow to fix: Lower downstream timeouts below upstream deadlines or scale ${m.evidence.nodeLabel} so requests finish within the caller deadline.\nTrade-off: Shorter server deadlines drop slow tail queries earlier instead of finishing abandoned work.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const curTimeout = node.config.timeoutMs ?? 5000;
    const nextTimeout = Math.max(200, Math.round(curTimeout * 0.6));
    return [
      {
        label: `Cap server deadline at ${nextTimeout} ms`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/timeoutMs`, value: nextTimeout }],
      },
    ];
  },
};

/** Rule: Health-check eviction cascade (instances marked unhealthy/down while remaining instances overload). */
export const healthCheckCascadeRule: Rule = {
  id: 'health-check-cascade',
  title: 'Health-check removal cascading overload',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const node of ctx.design.nodes) {
      if (node.serviceId === 'generic.client' || node.serviceId === 'generic.users') continue;
      const summary = ctx.result.perNode[node.id];
      if (!summary || summary.requests <= 0) continue;

      const totalInstances = Math.max(1, node.config.instances);
      let reducedActiveBuckets = 0;
      let hotWhileReduced = 0;

      for (const b of ctx.result.series.buckets) {
        const nb = b.perNode[node.id];
        if (!nb) continue;
        if (nb.instancesActive < totalInstances) {
          reducedActiveBuckets += 1;
          if (nb.utilization >= 0.85 || nb.drops > 0) {
            hotWhileReduced += 1;
          }
        }
      }

      if (reducedActiveBuckets > 0 && hotWhileReduced > 0 && totalInstances >= 2) {
        matches.push({
          nodeIds: [node.id],
          evidence: {
            nodeLabel: node.label,
            instancesTotal: totalInstances,
            degradedBuckets: reducedActiveBuckets,
            overloadedWhileReduced: hotWhileReduced,
          },
          trafficShare: getTrafficShare(summary.requests, ctx),
          durationFraction: Math.min(
            1,
            Math.max(0.25, reducedActiveBuckets / Math.max(1, ctx.result.durationS)),
          ),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} lost active instances across ${m.evidence.degradedBuckets} s, shifting load onto survivors (${m.evidence.overloadedWhileReduced} s overloaded).`,
    deep: `What happened: Health checks or instance failures removed ${m.evidence.nodeLabel} capacity while incoming traffic remained constant, overloading the remaining instances.\nHow to fix: Provision N+1 headroom (scale instances) and tune health-check thresholds so transient spikes do not evict busy instances.\nTrade-off: Keeping extra standby instances adds baseline compute spend.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const cur = Math.max(2, ctx.design.nodes[idx]!.config.instances);
    return [
      {
        label: `Add N+1 headroom (${cur} -> ${cur + 2} instances)`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: cur + 2 }],
      },
    ];
  },
};
