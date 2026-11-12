import type { Insight } from '@infrasim/shared-types';
import {
  autoscaleTooSlowRule,
  bottleneckNodeRule,
  cpuSaturatedRule,
  dropsQueueFullRule,
  idleOverprovisionedRule,
  queueGrowingRule,
  slotsExhaustedRule,
} from './rules/capacity.js';
import {
  cacheLowHitRatioRule,
  cacheStampedeRule,
  dbPoolExhaustedRule,
  dbReadHeavyNoCacheRule,
  hotPartitionRule,
  serverlessDbConnectionsRule,
  serverlessThrottledRule,
  singleDbNoReplicaRule,
} from './rules/database.js';
import { networkEdgeBlockedRule, networkSecuritySmellRule } from './rules/network.js';
import {
  healthCheckCascadeRule,
  noTimeoutRule,
  retryStormRule,
  singlePointOfFailureRule,
  timeoutInversionRule,
  zombieWorkRule,
} from './rules/resilience.js';
import type { DiagnosisContext, Rule } from './types.js';

export const PHASE1_RULES: Rule[] = [
  networkEdgeBlockedRule,
  networkSecuritySmellRule,
  cpuSaturatedRule,
  dbPoolExhaustedRule,
  dropsQueueFullRule,
  serverlessThrottledRule,
  slotsExhaustedRule,
  queueGrowingRule,
  autoscaleTooSlowRule,
  dbReadHeavyNoCacheRule,
  bottleneckNodeRule,
  idleOverprovisionedRule,
];

/** First 23 deterministic rules (Capacity, DB & Cache, Resilience, Network). */
export const FIRST_20_RULES: Rule[] = [
  ...PHASE1_RULES,
  cacheLowHitRatioRule,
  cacheStampedeRule,
  serverlessDbConnectionsRule,
  hotPartitionRule,
  singleDbNoReplicaRule,
  singlePointOfFailureRule,
  retryStormRule,
  noTimeoutRule,
  timeoutInversionRule,
  zombieWorkRule,
  healthCheckCascadeRule,
];

const SEVERITY_WEIGHT: Record<'info' | 'warning' | 'critical', number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

/**
 * Evaluates all deterministic rules against `ctx`, deduplicates generic fallback noise
 * when a more specific cause exists on the same node, and sorts insights deterministically
 * by `impact = severityWeight * trafficShare * durationFraction` (then severity and ruleId).
 */
export function diagnose(
  ctx: DiagnosisContext,
  rules: readonly Rule[] = FIRST_20_RULES,
): Insight[] {
  const candidates: (Insight & { _orderKey: string })[] = [];

  for (const rule of rules) {
    if (rule.requires?.includes('sim') && !ctx.result) continue;
    if (rule.requires?.includes('network') && !ctx.network) continue;
    if (rule.requires?.includes('cost') && !ctx.cost) continue;

    const matches = rule.appliesTo(ctx);
    for (const match of matches) {
      const severity = match.severityOverride ?? rule.severity;
      const impact = Number(
        (SEVERITY_WEIGHT[severity] * match.trafficShare * match.durationFraction).toFixed(4),
      );
      const explain = rule.explain(match, ctx);
      const fixes = rule.fixes(match, ctx);

      candidates.push({
        ruleId: rule.id,
        severity,
        nodeIds: match.nodeIds,
        title: rule.title,
        explanation: explain,
        fixes,
        evidence: match.evidence,
        impactScore: impact,
        ...(rule.lessonSlug ? { lessonSlug: rule.lessonSlug } : {}),
        _orderKey: `${rule.id}:${match.nodeIds.join(',')}`,
      });
    }
  }

  // Keep generic `bottleneck-node` only for hot/overloaded nodes that didn't trigger a more specific capacity/DB rule
  const specificNodes = new Set<string>();
  for (const item of candidates) {
    if (item.ruleId !== 'bottleneck-node' && item.ruleId !== 'idle-overprovisioned') {
      for (const nid of item.nodeIds) specificNodes.add(nid);
    }
  }

  const filtered = candidates.filter((c) => {
    if (c.ruleId !== 'bottleneck-node') return true;
    return c.nodeIds.some((nid) => !specificNodes.has(nid));
  });

  filtered.sort((a, b) => {
    const impDiff = (b.impactScore ?? 0) - (a.impactScore ?? 0);
    if (Math.abs(impDiff) > 1e-6) return impDiff;
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return a._orderKey.localeCompare(b._orderKey);
  });

  return filtered.map(({ _orderKey: _drop, ...insight }) => insight);
}
