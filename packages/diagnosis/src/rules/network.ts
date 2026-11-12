import type { FixSuggestion } from '@infrasim/shared-types';
import type { DiagnosisContext, Rule } from '../types.js';

/** Rule: Flag every blocked edge from `ctx.network` with its exact firewall/routing reason and least-privilege fix. */
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

/** Rule: Surface security & exposure smells detected by `network-analyzer` (public DBs, 0.0.0.0/0 non-web ports). */
export const networkSecuritySmellRule: Rule = {
  id: 'network-security-smell',
  title: 'Network security smell',
  severity: 'warning',
  requires: ['network'],
  appliesTo: (ctx) => {
    const smells = ctx.network?.smells ?? [];
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
