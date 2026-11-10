import { evaluateAllNodes, getTrafficShare, resolveNodeService } from '../helpers.js';
import type { Rule } from '../types.js';

function nodeIndexOf(
  ctx: { design: { nodes: { id: string }[] } },
  nodeId: string | undefined,
): number {
  return nodeId ? ctx.design.nodes.findIndex((n) => n.id === nodeId) : -1;
}

/** Rule: Database connection pool exhausted (`sql`/`doc`/`graph` saturated or waiters timing out). */
export const dbPoolExhaustedRule: Rule = {
  id: 'db-pool-exhausted',
  title: 'Database connection pool exhausted',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'db-connection-pooling',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      const kind = svc?.kind ?? 'compute';
      if (kind !== 'sql' && kind !== 'doc' && kind !== 'graph') continue;

      const timeouts = info.summary.errors.timeout ?? 0;
      const peakUtil = info.summary.peakUtilization;
      if (timeouts > 0 || peakUtil >= 0.85 || info.summary.avgUtilization >= 0.8) {
        const poolMax =
          info.node.config.connections?.max ??
          (svc?.capacity.type === 'conn' ? svc.capacity.default : 100);
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            poolMax,
            peakUtilPct: Math.round(peakUtil * 100),
            timeouts,
            p95Ms: Math.round(info.summary.p95),
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.max(0.25, info.summary.avgUtilization),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} saturated its connection pool (${m.evidence.poolMax} max, ${m.evidence.peakUtilPct}% peak${Number(m.evidence.timeouts) > 0 ? `, ${m.evidence.timeouts} connection timeouts` : ''}).`,
    deep: `What happened: Concurrent queries filled ${m.evidence.nodeLabel}'s pool of ${m.evidence.poolMax} connections (${m.evidence.timeouts} waiter timeouts).\nWhy: Each open query holds a connection slot until completion; pool ceiling caps throughput at poolSize / avgQuerySec.\nHow to fix: Raise max connections, add a connection pooler, or cache hot reads upstream.\nTrade-off: Too many direct DB connections add memory and context-switch pressure.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const poolMax = Math.max(10, Number(m.evidence.poolMax));
    return [
      {
        label: `Raise DB pool cap (${poolMax} -> ${poolMax * 2})`,
        patch: [
          { op: 'add', path: `/nodes/${idx}/config/connections`, value: { max: poolMax * 2 } },
        ],
      },
    ];
  },
};

/** Rule: Read-heavy database (> 70% reads) running hot (> 65% util) without an upstream cache. */
export const dbReadHeavyNoCacheRule: Rule = {
  id: 'db-read-heavy-no-cache',
  title: 'Read-heavy database has no upstream cache',
  severity: 'warning',
  requires: ['sim'],
  lessonSlug: 'read-through-caching',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      const kind = svc?.kind ?? 'compute';
      if (kind !== 'sql' && kind !== 'doc' && kind !== 'graph') continue;

      const readRatio = info.node.config.readRatio ?? 0.8;
      if (readRatio <= 0.7 || info.summary.peakUtilization < 0.65) continue;

      const inboundEdges = ctx.design.edges.filter((e) => e.to === info.node.id);
      const hasUpstreamCache = inboundEdges.some((e) => {
        const upNode = ctx.design.nodes.find((n) => n.id === e.from);
        if (!upNode) return false;
        const upKind = resolveNodeService(upNode.serviceId, ctx)?.kind;
        return upKind === 'cache' || upKind === 'cdn';
      });
      if (!hasUpstreamCache) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            readPct: Math.round(readRatio * 100),
            peakUtilPct: Math.round(info.summary.peakUtilization * 100),
            requests: info.summary.requests,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: Math.max(0.25, info.summary.avgUtilization),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} handled ~${m.evidence.readPct}% reads at ${m.evidence.peakUtilPct}% peak load without an upstream cache.`,
    deep: `What happened: All reads hit ${m.evidence.nodeLabel} directly (${m.evidence.requests} queries).\nWhy: Caching 80-90% of hot reads in Redis or Valkey reduces DB connection pressure 5-10x.\nHow to fix: Add a cache node before database reads.\nTrade-off: Introduces cache invalidation and small cache cost.`,
  }),
  fixes: () => [],
};

/** Rule: Serverless concurrency or rate limiter throttling (429 / throttled errors). */
export const serverlessThrottledRule: Rule = {
  id: 'serverless-throttled',
  title: 'Requests throttled at rate or concurrency limit',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const throttled = info.summary.errors.throttled ?? 0;
      if (throttled > 0) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            throttled,
            requests: info.summary.requests,
          },
          trafficShare: Math.min(1, throttled / Math.max(1, info.summary.requests)),
          durationFraction: 0.5,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} rejected ${m.evidence.throttled} requests (429 Throttled) at its configured limit.`,
    deep: `What happened: Incoming rate exceeded ${m.evidence.nodeLabel}'s rate or concurrency ceiling.\nHow to fix: Raise the rate or concurrency limit, or buffer bursts in a queue.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const curRps = ctx.design.nodes[idx]!.config.rateLimit?.rps;
    if (curRps !== undefined && curRps > 0) {
      return [
        {
          label: `Double rate limit (${curRps} -> ${curRps * 2} req/s)`,
          patch: [
            {
              op: 'add',
              path: `/nodes/${idx}/config/rateLimit`,
              value: { rps: curRps * 2, burst: Math.max(10, curRps) },
            },
          ],
        },
      ];
    }
    const curInstances = Math.max(1, ctx.design.nodes[idx]!.config.instances);
    return [
      {
        label: `Scale instances (${curInstances} -> ${curInstances * 2})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: curInstances * 2 }],
      },
    ];
  },
};
