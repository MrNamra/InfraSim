import { evaluateAllNodes, getTrafficShare, resolveNodeService } from '../helpers.js';
import type { DiagnosisContext, Rule } from '../types.js';

function nodeIndexOf(ctx: DiagnosisContext, nodeId: string | undefined): number {
  return nodeId ? ctx.design.nodes.findIndex((n) => n.id === nodeId) : -1;
}

/** Rule: Serverless function p99 tail dominated by cold starts (`fn` with `coldStart.enabled` and p99 >= 4x p50). */
export const coldStartTailRule: Rule = {
  id: 'cold-start-tail',
  title: 'Cold starts dominating serverless p99 latency',
  severity: 'warning',
  requires: ['sim'],
  lessonSlug: 'serverless-cold-starts',
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'fn') continue;
      const cs = info.node.config.coldStart;
      if (!cs || !cs.enabled) continue;
      if (info.summary.requests <= 0) continue;

      const tailRatio = info.summary.p99 / Math.max(1, info.summary.p50);
      if (info.summary.p99 >= 150 && (tailRatio >= 4 || cs.p95 >= info.summary.p50 * 3)) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            p50Ms: Math.round(info.summary.p50),
            p99Ms: Math.round(info.summary.p99),
            coldStartP95Ms: Math.round(cs.p95),
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: 0.4,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} p99 (${m.evidence.p99Ms} ms) spiked well above p50 (${m.evidence.p50Ms} ms) due to cold starts (~${m.evidence.coldStartP95Ms} ms).`,
    deep: `What happened: Infrequent bursts forced cold container initialization on ${m.evidence.nodeLabel}.\nHow to fix: Enable provisioned / warm instances (disable cold starts) or trim runtime bundle size.\nTrade-off: Keeping warm provisioned concurrency adds steady hourly compute cost.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    return [
      {
        label: 'Enable provisioned warm concurrency (eliminate cold starts)',
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/coldStart`,
            value: {
              ...(node.config.coldStart ?? {
                probabilityModel: 'idle-based' as const,
                p50: 80,
                p95: 300,
              }),
              enabled: false,
            },
          },
        ],
        tradeOff: 'Increases steady monthly compute cost for warm containers',
      },
    ];
  },
};

/** Rule: Upstream gateway/caller timeout shorter than LLM/AI downstream p95. */
export const gatewayTimeoutVsLlmRule: Rule = {
  id: 'gateway-timeout-vs-llm',
  title: 'Gateway timeout shorter than LLM response p95',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const edge of ctx.design.edges) {
      if (edge.callType !== 'sync') continue;
      const caller = ctx.design.nodes.find((n) => n.id === edge.from);
      const llm = ctx.design.nodes.find((n) => n.id === edge.to);
      if (!caller || !llm) continue;

      const llmSvc = resolveNodeService(llm.serviceId, ctx);
      if (llmSvc?.kind !== 'llm' && llmSvc?.kind !== 'ml' && llmSvc?.kind !== 'doc-ai') continue;

      const llmSummary = ctx.result.perNode[llm.id];
      const callerTimeout = caller.config.timeoutMs;
      if (!llmSummary || callerTimeout === undefined || callerTimeout <= 0) continue;

      if (llmSummary.p95 >= callerTimeout) {
        matches.push({
          nodeIds: [caller.id, llm.id],
          edgeIds: [edge.id],
          evidence: {
            edgeId: edge.id,
            callerLabel: caller.label,
            llmLabel: llm.label,
            callerTimeoutMs: callerTimeout,
            llmP95Ms: Math.round(llmSummary.p95),
          },
          trafficShare: getTrafficShare(llmSummary.requests, ctx),
          durationFraction: 0.75,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.callerLabel} cuts off calls after ${m.evidence.callerTimeoutMs} ms while ${m.evidence.llmLabel} takes ${m.evidence.llmP95Ms} ms at p95.`,
    deep: `What happened: Token generation latency at ${m.evidence.llmLabel} (${m.evidence.llmP95Ms} ms p95) exceeded ${m.evidence.callerLabel}'s ${m.evidence.callerTimeoutMs} ms timeout.\nHow to fix: Stream tokens over SSE/WebSocket, switch to async jobs, or raise the caller timeout.`,
  }),
  fixes: (m, ctx) => {
    const callerIdx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (callerIdx < 0) return [];
    const targetMs = Math.max(
      5000,
      Math.ceil((Number(m.evidence.llmP95Ms ?? 3000) * 1.5) / 500) * 500,
    );
    return [
      {
        label: `Raise caller deadline to ${targetMs} ms`,
        patch: [{ op: 'add', path: `/nodes/${callerIdx}/config/timeoutMs`, value: targetMs }],
      },
    ];
  },
};

/** Rule: LLM/AI model endpoint throttled due to TPM / RPM quota ceiling. */
export const llmTpmThrottleRule: Rule = {
  id: 'llm-tpm-throttle',
  title: 'LLM token-per-minute (TPM) quota throttled',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'llm' && svc?.kind !== 'ml') continue;

      const throttled = info.summary.errors.throttled ?? 0;
      if (throttled > 0) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            throttled,
            tpmCap: info.node.config.rateLimit?.tpm ?? 60_000,
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
    short: `${m.evidence.nodeLabel} throttled ${m.evidence.throttled} prompts after hitting its ${m.evidence.tpmCap} TPM/RPM ceiling.`,
    deep: `What happened: Combined prompt and output tokens exceeded ${m.evidence.nodeLabel}'s quota (${m.evidence.throttled} HTTP 429s).\nHow to fix: Raise provisioned throughput / TPM limit, trim prompt size, cache identical queries, or buffer bursts in a queue.\nTrade-off: Provisioned throughput adds fixed hourly cost; shorter prompts slightly limit context richness.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const node = ctx.design.nodes[idx]!;
    const curTpm = node.config.rateLimit?.tpm ?? 60_000;
    const curUnits = Math.max(1, node.config.ai?.provisionedUnits ?? 1);
    return [
      {
        label: `Double LLM TPM quota (${curTpm.toLocaleString()} -> ${(curTpm * 2).toLocaleString()} TPM)`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/rateLimit`,
            value: { ...(node.config.rateLimit ?? {}), tpm: curTpm * 2 },
          },
          {
            op: 'add',
            path: `/nodes/${idx}/config/ai`,
            value: {
              ...(node.config.ai ?? {}),
              capacityMode: 'provisioned',
              provisionedUnits: curUnits * 2,
            },
          },
        ],
        tradeOff: 'Higher provisioned capacity increases monthly AI spend',
      },
    ];
  },
};

/** Rule: Synchronous uncached LLM inference on the critical request path (> 400 ms p95). */
export const llmOnCriticalPathRule: Rule = {
  id: 'llm-on-critical-path',
  title: 'Uncached synchronous LLM on critical user path',
  severity: 'warning',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'llm') continue;
      if (info.summary.requests <= 0 || info.summary.p95 < 400) continue;

      const hasSyncCaller = ctx.design.edges.some(
        (e) => e.to === info.node.id && e.callType === 'sync',
      );
      if (!hasSyncCaller) continue;

      const hasCacheUpstream = ctx.design.edges
        .filter((e) => e.to === info.node.id)
        .some((e) => {
          const up = ctx.design.nodes.find((n) => n.id === e.from);
          const upKind = up ? resolveNodeService(up.serviceId, ctx)?.kind : undefined;
          return upKind === 'cache';
        });
      const hitRatio = info.node.config.cacheHitRatio ?? 0;

      if (!hasCacheUpstream && hitRatio < 0.2) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            p95Ms: Math.round(info.summary.p95),
            requests: info.summary.requests,
          },
          trafficShare: getTrafficShare(info.summary.requests, ctx),
          durationFraction: 0.7,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} adds ${m.evidence.p95Ms} ms p95 synchronously on every request with no semantic cache.`,
    deep: `What happened: Every user call waited for fresh inference at ${m.evidence.nodeLabel}.\nHow to fix: Cache common prompts (response cache / vector cache) or move non-blocking enrichment onto an async queue.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    return [
      {
        label: 'Enable prompt response caching (45% hit ratio)',
        patch: [{ op: 'add', path: `/nodes/${idx}/config/cacheHitRatio`, value: 0.45 }],
        tradeOff: 'Cached prompts serve repeated queries faster with static output',
      },
    ];
  },
};

/** Rule: LLM prompts exceeding maxContextTokens causing 400 validation errors. */
export const contextTooLargeRule: Rule = {
  id: 'context-too-large',
  title: 'Prompt exceeds model max context window',
  severity: 'critical',
  requires: ['sim'],
  appliesTo: (ctx) => {
    if (!ctx.result) return [];
    const contextSpanCount = new Map<string, number>();
    for (const trace of ctx.result.traces) {
      for (const span of trace.spans) {
        if (span.attrs?.errorCode === 'context_length_exceeded') {
          contextSpanCount.set(span.nodeId, (contextSpanCount.get(span.nodeId) ?? 0) + 1);
        }
      }
    }

    const matches = [];
    for (const info of evaluateAllNodes(ctx)) {
      const svc = resolveNodeService(info.node.serviceId, ctx);
      if (svc?.kind !== 'llm') continue;
      const traceHits = contextSpanCount.get(info.node.id) ?? 0;
      const serverErrors = info.summary.errors.server ?? 0;
      const hasSmallCap =
        info.node.config.rateLimit?.maxContextTokens !== undefined &&
        info.node.config.rateLimit.maxContextTokens <= 16_384;
      const overflowCount =
        traceHits > 0 ? Math.max(traceHits, serverErrors) : hasSmallCap ? serverErrors : 0;

      if (overflowCount > 0) {
        matches.push({
          nodeIds: [info.node.id],
          evidence: {
            nodeLabel: info.node.label,
            contextErrors: overflowCount,
            maxContextTokens: info.node.config.rateLimit?.maxContextTokens ?? 8192,
          },
          trafficShare: Math.min(1, overflowCount / Math.max(1, info.summary.requests)),
          durationFraction: 0.6,
        });
      }
    }
    return matches;
  },
  explain: (m) => ({
    short: `${m.evidence.nodeLabel} rejected ${m.evidence.contextErrors} requests for exceeding ${m.evidence.maxContextTokens} context tokens.`,
    deep: `What happened: Prompts passed to ${m.evidence.nodeLabel} overflowed its configured context window (${m.evidence.maxContextTokens} tokens).\nHow to fix: Switch to a larger-context model tier or chunk and summarize documents before calling the LLM.`,
  }),
  fixes: (m, ctx) => {
    const idx = nodeIndexOf(ctx, m.nodeIds[0]);
    if (idx < 0) return [];
    const curMax = Number(m.evidence.maxContextTokens ?? 8192);
    const curNode = ctx.design.nodes[idx]!;
    return [
      {
        label: `Increase context window (${curMax.toLocaleString()} -> ${(curMax * 2).toLocaleString()} tokens)`,
        patch: [
          {
            op: 'add',
            path: `/nodes/${idx}/config/rateLimit`,
            value: { ...(curNode.config.rateLimit ?? {}), maxContextTokens: curMax * 2 },
          },
        ],
      },
    ];
  },
};
