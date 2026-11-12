import type { CausalChainLink, Design, Insight } from '@infrasim/shared-types';

/** Ordered list of driver rules from deepest resource/dependency failures up to generic saturation. */
const DRIVER_RULE_PRIORITY: readonly string[] = [
  'db-pool-exhausted',
  'cache-stampede',
  'hot-partition',
  'llm-tpm-throttle',
  'context-too-large',
  'network-edge-blocked',
  'edge-blocked',
  'cpu-saturated',
  'serverless-throttled',
  'health-check-cascade',
  'retry-storm',
  'drops-queue-full',
  'slots-exhausted',
  'queue-growing',
  'timeout-inversion',
  'zombie-work',
  'gateway-timeout-vs-llm',
  'bottleneck-node',
];

const UPSTREAM_SYMPTOM_RULES = new Set<string>([
  'drops-queue-full',
  'slots-exhausted',
  'queue-growing',
  'no-timeout',
  'timeout-inversion',
  'zombie-work',
  'gateway-timeout-vs-llm',
  'bottleneck-node',
  'retry-storm',
  'autoscale-too-slow',
]);

const SEVERITY_WEIGHT: Record<Insight['severity'], number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

function driverPriorityScore(ruleId: string): number {
  const idx = DRIVER_RULE_PRIORITY.indexOf(ruleId);
  return idx >= 0 ? DRIVER_RULE_PRIORITY.length - idx : -1;
}

function getAnchorNodeId(insight: Insight): string | undefined {
  if (insight.ruleId === 'retry-storm' || insight.ruleId === 'timeout-inversion') {
    return insight.nodeIds[1] ?? insight.nodeIds[0];
  }
  return insight.nodeIds[0];
}

function isPropagationDriver(insight: Insight): boolean {
  return DRIVER_RULE_PRIORITY.includes(insight.ruleId);
}

/**
 * Builds a causal dependency DAG over `design.edges` connecting upstream symptomatic nodes
 * to their deepest saturated/failed downstream dependency, populates causal metadata fields,
 * and ranks root causes cleanly ahead of downstream symptoms.
 */
export function applyCausalDagAndRank(design: Design, insights: readonly Insight[]): Insight[] {
  if (insights.length === 0) return [];

  const nodeLabelById = new Map<string, string>(design.nodes.map((n) => [n.id, n.label]));

  // Map each node to its highest-priority saturation/blocking driver insight.
  const primaryDriverByNode = new Map<string, Insight>();
  for (const ins of insights) {
    if (!isPropagationDriver(ins)) continue;
    const targetIds =
      ins.ruleId === 'retry-storm' || ins.ruleId === 'timeout-inversion'
        ? [ins.nodeIds[1] ?? ins.nodeIds[0]]
        : [ins.nodeIds[0]];

    for (const nid of targetIds) {
      if (!nid) continue;
      const existing = primaryDriverByNode.get(nid);
      if (!existing) {
        primaryDriverByNode.set(nid, ins);
        continue;
      }
      const pNew = driverPriorityScore(ins.ruleId);
      const pOld = driverPriorityScore(existing.ruleId);
      if (pNew > pOld || (pNew === pOld && (ins.impactScore ?? 0) > (existing.impactScore ?? 0))) {
        primaryDriverByNode.set(nid, ins);
      }
    }
  }

  // Adjacency list sorted deterministically by destination node ID
  const outboundByNode = new Map<string, string[]>();
  for (const edge of design.edges) {
    if (edge.from === edge.to) continue;
    const list = outboundByNode.get(edge.from) ?? [];
    if (!list.includes(edge.to)) {
      list.push(edge.to);
      outboundByNode.set(edge.from, list);
    }
  }
  for (const list of outboundByNode.values()) {
    list.sort();
  }

  interface ResolvedDeepest {
    pathNodes: string[]; // [deepestRoot, ..., caller]
    rootNodeId: string;
    rootInsight: Insight;
  }

  // For any node `n` with a driver insight, find deepest saturated path downstream of `n`.
  const memo = new Map<string, ResolvedDeepest>();

  const findDeepestForNode = (nodeId: string, visiting: Set<string>): ResolvedDeepest | null => {
    const ownDriver = primaryDriverByNode.get(nodeId);
    if (!ownDriver) return null;
    if (memo.has(nodeId)) return memo.get(nodeId)!;

    visiting.add(nodeId);
    let bestChild: ResolvedDeepest | null = null;
    let bestDirectTarget = '';

    for (const nextId of outboundByNode.get(nodeId) ?? []) {
      if (visiting.has(nextId)) continue;
      if (!primaryDriverByNode.has(nextId)) continue;
      const candidate = findDeepestForNode(nextId, visiting);
      if (!candidate) continue;

      if (
        !bestChild ||
        candidate.pathNodes.length > bestChild.pathNodes.length ||
        (candidate.pathNodes.length === bestChild.pathNodes.length &&
          driverPriorityScore(candidate.rootInsight.ruleId) >
            driverPriorityScore(bestChild.rootInsight.ruleId)) ||
        (candidate.pathNodes.length === bestChild.pathNodes.length &&
          driverPriorityScore(candidate.rootInsight.ruleId) ===
            driverPriorityScore(bestChild.rootInsight.ruleId) &&
          (candidate.rootInsight.impactScore ?? 0) > (bestChild.rootInsight.impactScore ?? 0))
      ) {
        bestChild = candidate;
        bestDirectTarget = nextId;
      }
    }

    visiting.delete(nodeId);

    const resolved: ResolvedDeepest = bestChild
      ? {
          pathNodes: [...bestChild.pathNodes, nodeId],
          rootNodeId: bestChild.rootNodeId,
          rootInsight: bestChild.rootInsight,
        }
      : {
          pathNodes: [nodeId],
          rootNodeId: nodeId,
          rootInsight: ownDriver,
        };

    // Keep track via memo only when visiting is empty to remain cycle-exact
    if (visiting.size === 0 && (!bestChild || bestDirectTarget !== '')) {
      memo.set(nodeId, resolved);
    }
    return resolved;
  };

  const makeLink = (nodeId: string, ins: Insight): CausalChainLink => ({
    nodeId,
    nodeLabel: nodeLabelById.get(nodeId) ?? nodeId,
    ruleId: ins.ruleId,
    title: ins.title,
  });

  // Track which root insights actually explain at least one upstream symptom
  const explainedCountByRootKey = new Map<string, number>();

  const enriched = insights.map((ins): Insight => {
    const anchorId = getAnchorNodeId(ins);
    if (!anchorId) return ins;

    // Special case: retry-storm spans `[caller, target]`; resolve deepest dependency starting at `target`
    if (ins.ruleId === 'retry-storm' && ins.nodeIds.length >= 2) {
      const targetId = ins.nodeIds[1]!;
      const deepest = findDeepestForNode(targetId, new Set<string>());
      if (deepest) {
        const isSelfRoot =
          deepest.rootInsight.ruleId === ins.ruleId && deepest.rootNodeId === targetId;
        const chain: CausalChainLink[] = [];
        for (const nid of deepest.pathNodes) {
          const drv = primaryDriverByNode.get(nid);
          if (drv) chain.push(makeLink(nid, drv));
        }
        if (chain.length === 0 || chain[chain.length - 1]!.ruleId !== ins.ruleId) {
          chain.push(makeLink(targetId, ins));
        }
        if (!isSelfRoot) {
          const rk = `${deepest.rootInsight.ruleId}:${deepest.rootNodeId}`;
          explainedCountByRootKey.set(rk, (explainedCountByRootKey.get(rk) ?? 0) + 1);
          return {
            ...ins,
            causedByNodeId: targetId,
            causedByRuleId: primaryDriverByNode.get(targetId)?.ruleId ?? deepest.rootInsight.ruleId,
            rootCauseNodeId: deepest.rootNodeId,
            rootCauseRuleId: deepest.rootInsight.ruleId,
            causalChain: chain,
          };
        }
      }
      return ins;
    }

    // Check downstream saturated dependencies from `anchorId`
    let bestDownstream: ResolvedDeepest | null = null;
    let bestDirectDownstreamId: string | undefined;

    for (const nextId of outboundByNode.get(anchorId) ?? []) {
      const candidate = findDeepestForNode(nextId, new Set<string>([anchorId]));
      if (!candidate) continue;
      if (
        !bestDownstream ||
        candidate.pathNodes.length > bestDownstream.pathNodes.length ||
        (candidate.pathNodes.length === bestDownstream.pathNodes.length &&
          driverPriorityScore(candidate.rootInsight.ruleId) >
            driverPriorityScore(bestDownstream.rootInsight.ruleId))
      ) {
        bestDownstream = candidate;
        bestDirectDownstreamId = nextId;
      }
    }

    if (bestDownstream && bestDirectDownstreamId && UPSTREAM_SYMPTOM_RULES.has(ins.ruleId)) {
      const directDriver = primaryDriverByNode.get(bestDirectDownstreamId);
      const chain: CausalChainLink[] = bestDownstream.pathNodes
        .map((nid) => {
          const drv = primaryDriverByNode.get(nid);
          return drv ? makeLink(nid, drv) : null;
        })
        .filter((x): x is CausalChainLink => x !== null);
      chain.push(makeLink(anchorId, ins));

      const rk = `${bestDownstream.rootInsight.ruleId}:${bestDownstream.rootNodeId}`;
      explainedCountByRootKey.set(rk, (explainedCountByRootKey.get(rk) ?? 0) + 1);

      return {
        ...ins,
        causedByNodeId: bestDirectDownstreamId,
        causedByRuleId: directDriver?.ruleId ?? bestDownstream.rootInsight.ruleId,
        rootCauseNodeId: bestDownstream.rootNodeId,
        rootCauseRuleId: bestDownstream.rootInsight.ruleId,
        causalChain: chain,
      };
    }

    return ins;
  });

  // Mark leaf drivers that sit at the root of an active causal chain (or sole deepest driver)
  const finalInsights = enriched.map((ins): Insight => {
    if (ins.causedByNodeId) return ins;
    const anchorId = getAnchorNodeId(ins);
    if (!anchorId || !isPropagationDriver(ins)) return ins;
    const primary = primaryDriverByNode.get(anchorId);
    if (!primary || primary.ruleId !== ins.ruleId) return ins;

    const rk = `${ins.ruleId}:${anchorId}`;
    const explainsOthers = (explainedCountByRootKey.get(rk) ?? 0) > 0;
    if (!explainsOthers) return ins;

    return {
      ...ins,
      isRootCause: true,
      rootCauseNodeId: anchorId,
      rootCauseRuleId: ins.ruleId,
      causalChain: [makeLink(anchorId, ins)],
    };
  });

  const rankValue = (ins: Insight): number => {
    const base = ins.impactScore ?? 0;
    if (ins.isRootCause) return base + 2.0;
    if (ins.causedByNodeId) return base - 0.5;
    return base;
  };

  finalInsights.sort((a, b) => {
    const rankDiff = rankValue(b) - rankValue(a);
    if (Math.abs(rankDiff) > 1e-6) return rankDiff;
    const impDiff = (b.impactScore ?? 0) - (a.impactScore ?? 0);
    if (Math.abs(impDiff) > 1e-6) return impDiff;
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) return sevDiff;
    const keyA = `${a.ruleId}:${a.nodeIds.join(',')}`;
    const keyB = `${b.ruleId}:${b.nodeIds.join(',')}`;
    return keyA.localeCompare(keyB);
  });

  return finalInsights;
}
