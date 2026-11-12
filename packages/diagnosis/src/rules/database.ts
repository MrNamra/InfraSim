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

/** Rule: Cache or CDN node with < 50% hit ratio providing little offload for its cost. */
export const cacheLowHitRatioRule: Rule = {
  id: 'cache-low-hit-ratio',
  title: 'Cache hit ratio below 50%',
  severity: 'warning',
  requires: ['sim'],
  lessonSlug: 'cache-keys-and-ttl',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      const kind = svc?.kind ?? 'compute';
      if (kind !== 'cache' && kind !== 'cdn') continue;
      if (info.summary.requests <= 0) continue;

      const hitRatio = info.node.config.cacheHitRatio ?? (kind === 'cdn' ? 0.9 : 0.85);
      if (hitRatio < 0.5) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            hitRatioPct: Math.round(hitRatio * 100),
            requests: info.summary.requests,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: 0.75,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} only hits on ${m.evidence.hitRatioPct}% of requests (< 50%), sending most load downstream.`,
    deep: `What happened: More than half of requests at ${m.evidence.nodeLabel} missed the cache.\nWhy: Overly narrow cache keys (e.g. per-user timestamps) or short TTLs prevent reuse while paying cache memory cost.\nHow to fix: Normalize cache keys and lengthen TTL so hit ratio exceeds 80%.\nTrade-off: Longer TTLs delay propagation of rare writes unless explicitly invalidated.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    return [
      {
        label: 'Raise target hit ratio to 85% (tune keys & TTL)',
        patch: [{ op: 'add', path: `/nodes/${idx}/config/cacheHitRatio`, value: 0.85 }],
      },
    ];
  },
};

/** Rule: Cache flush or miss burst causing downstream database stampede spike. */
export const cacheStampedeRule: Rule = {
  id: 'cache-stampede',
  title: 'Cache stampede overloading database',
  severity: 'critical',
  requires: ['sim'],
  lessonSlug: 'cache-stampede-mitigation',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    const cacheFlushEvents = ctx.design.scenarios
      .flatMap((s) => s.chaos)
      .filter((c) => c.kind === 'cache-flush');

    for (const edge of ctx.design.edges) {
      const cacheNode = ctx.design.nodes.find((n) => n.id === edge.from);
      const dbNode = ctx.design.nodes.find((n) => n.id === edge.to);
      if (!cacheNode || !dbNode) continue;

      const cacheKind = resolveNodeService(cacheNode.serviceId, ctx)?.kind;
      const dbKind = resolveNodeService(dbNode.serviceId, ctx)?.kind;
      if (cacheKind !== 'cache' || (dbKind !== 'sql' && dbKind !== 'doc' && dbKind !== 'kv')) {
        continue;
      }

      const dbSummary = ctx.result.perNode[dbNode.id];
      const cacheSummary = ctx.result.perNode[cacheNode.id];
      if (!dbSummary || !cacheSummary || dbSummary.requests <= 0) continue;

      const hasFlushChaos = cacheFlushEvents.some((c) => c.nodeId === cacheNode.id);
      const hitRatio = cacheNode.config.cacheHitRatio ?? 0.85;
      const dbStrained = dbSummary.peakUtilization >= 0.85 || dbSummary.drops > 0;

      if (dbStrained && (hasFlushChaos || hitRatio < 0.7)) {
        matches.push({
          nodeIds: [cacheNode.id, dbNode.id],
          edgeIds: [edge.id],
          evidence: {
            cacheLabel: cacheNode.label,
            dbLabel: dbNode.label,
            dbPeakUtilPct: Math.round(dbSummary.peakUtilization * 100),
            cacheHitPct: Math.round(hitRatio * 100),
            flushEvent: hasFlushChaos ? 'yes' : 'no',
          },
          trafficShare: getTrafficShare(cacheSummary.requests, ctx),
          durationFraction: 0.5,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `Miss bursts from ${m.evidence.cacheLabel} hammered ${m.evidence.dbLabel} (${m.evidence.dbPeakUtilPct}% peak DB load).`,
    deep: `What happened: When ${m.evidence.cacheLabel} missed or flushed, concurrent cold misses bypassed to ${m.evidence.dbLabel} simultaneously (${m.evidence.dbPeakUtilPct}% peak).\nHow to fix: Protect the DB with higher pool/instances, pre-warm hot keys, or add request coalescing + TTL jitter.\nTrade-off: Staggered TTLs and pool buffers slightly increase stale-read window or DB memory use.`,
  }),
  fixes: (m, ctx) => {
    const dbIdx = nodeIndexOf(ctx, m.nodeIds[1]);
    if (dbIdx < 0) return [];
    const curPool = ctx.design.nodes[dbIdx]!.config.connections?.max ?? 50;
    return [
      {
        label: `Double DB pool (${curPool} -> ${curPool * 2}) to absorb miss bursts`,
        patch: [
          { op: 'add', path: `/nodes/${dbIdx}/config/connections`, value: { max: curPool * 2 } },
        ],
      },
    ];
  },
};

/** Rule: Serverless compute fan-in threatening or saturating database connection limit. */
export const serverlessDbConnectionsRule: Rule = {
  id: 'serverless-db-connections',
  title: 'Serverless fan-in exhausting DB connections',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const dbNode of ctx.design.nodes) {
      const dbSvc = resolveNodeService(dbNode.serviceId, ctx);
      if (dbSvc?.kind !== 'sql') continue;
      const dbSummary = ctx.result.perNode[dbNode.id];
      if (!dbSummary || dbSummary.requests <= 0) continue;

      const fnCallers = ctx.design.edges
        .filter((e) => e.to === dbNode.id)
        .map((e) => ctx.design.nodes.find((n) => n.id === e.from))
        .filter((n): n is NonNullable<typeof n> => {
          if (!n) return false;
          return resolveNodeService(n.serviceId, ctx)?.kind === 'fn';
        });
      if (fnCallers.length === 0) continue;

      const dbMaxConn = dbNode.config.connections?.max ?? 100;
      const potentialFnConn = fnCallers.reduce((acc, fn) => {
        const conc =
          fn.config.coldStart?.concurrencyLimit ?? Math.max(50, fn.config.instances * 50);
        return acc + conc;
      }, 0);

      if (
        potentialFnConn > dbMaxConn &&
        (dbSummary.peakUtilization >= 0.7 || (dbSummary.errors.timeout ?? 0) > 0)
      ) {
        matches.push({
          nodeIds: [dbNode.id, fnCallers[0]!.id],
          severityOverride:
            dbSummary.peakUtilization >= 0.9 || (dbSummary.errors.timeout ?? 0) > 0
              ? ('critical' as const)
              : ('warning' as const),
          evidence: {
            dbLabel: dbNode.label,
            fnLabel: fnCallers[0]!.label,
            dbMaxConn,
            potentialFnConn,
            dbPeakUtilPct: Math.round(dbSummary.peakUtilization * 100),
          },
          trafficShare: getTrafficShare(dbSummary.requests, ctx),
          durationFraction: Math.max(0.3, dbSummary.avgUtilization),
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.fnLabel} can open up to ${m.evidence.potentialFnConn} concurrent connections against ${m.evidence.dbLabel}'s ${m.evidence.dbMaxConn}-connection cap.`,
    deep: `What happened: Each concurrent serverless execution opens its own SQL connection (${m.evidence.dbPeakUtilPct}% peak DB utilization).\nHow to fix: Raise the DB pool / add a connection proxy (RDS Proxy / PgBouncer) or cap serverless reserved concurrency.`,
  }),
  fixes: (m, ctx) => {
    const dbIdx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (dbIdx < 0) return [];
    const curMax = Number(m.evidence.dbMaxConn ?? 100);
    return [
      {
        label: `Raise DB proxy/pool limit (${curMax} -> ${curMax * 2})`,
        patch: [
          { op: 'add', path: `/nodes/${dbIdx}/config/connections`, value: { max: curMax * 2 } },
        ],
      },
    ];
  },
};

/** Rule: Key-value store throttled despite moderate average/peak utilization (hot partition key skew). */
export const hotPartitionRule: Rule = {
  id: 'hot-partition',
  title: 'Hot partition key throttling KV store',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'kv') continue;
      const throttled = info.summary.errors.throttled ?? 0;
      if (throttled > 0 && info.summary.avgUtilization < 0.7) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            throttled,
            avgUtilPct: Math.round(info.summary.avgUtilization * 100),
            requests: info.summary.requests,
          },
          trafficShare: Math.min(1, throttled / Math.max(1, info.summary.requests)),
          durationFraction: 0.6,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} throttled ${m.evidence.throttled} calls even though overall utilization averaged only ${m.evidence.avgUtilPct}% (hot partition skew).`,
    deep: `What happened: A small set of partition keys received disproportionate traffic, hitting per-partition limits before global table capacity saturated.\nHow to fix: Add partition key sharding (suffixing), raise provisioned throughput, or put a short-TTL read cache in front.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const curInstances = Math.max(1, ctx.design.nodes[idx]!.config.instances);
    return [
      {
        label: `Scale KV partition capacity (${curInstances} -> ${curInstances * 2})`,
        patch: [{ op: 'add', path: `/nodes/${idx}/config/instances`, value: curInstances * 2 }],
      },
    ];
  },
};

/** Rule: Single-instance primary database handling read-heavy workload without a read replica. */
export const singleDbNoReplicaRule: Rule = {
  id: 'single-db-no-replica',
  title: 'Single database instance without read replica',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'sql' && svc?.kind !== 'doc') continue;
      const readRatio = info.node.config.readRatio ?? 0.8;
      if (
        info.node.config.instances <= 1 &&
        readRatio > 0.7 &&
        info.summary.requests > 0 &&
        info.summary.peakUtilization >= 0.5
      ) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            readPct: Math.round(readRatio * 100),
            peakUtilPct: Math.round(info.summary.peakUtilization * 100),
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: 0.5,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} runs 1 instance for a ${m.evidence.readPct}% read workload (${m.evidence.peakUtilPct}% peak load) without a read replica.`,
    deep: `What happened: Every read and write hit the single primary database.\nHow to fix: Add a read replica / Multi-AZ instance to split read load and survive primary failover.\nTrade-off: Doubles DB instance spend and adds slight replica lag for eventual-consistency reads.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    return [
      {
        label: 'Add read replica (instances -> 2, Multi-AZ)',
        patch: [
          { op: 'add', path: `/nodes/${idx}/config/instances`, value: 2 },
          { op: 'add', path: `/nodes/${idx}/az`, value: 'multi-az' },
        ],
      },
    ];
  },
};
