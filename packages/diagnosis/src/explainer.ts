import { getService } from '@infrasim/catalog';
import type { Design, Insight, SimulationResult } from '@infrasim/shared-types';

/** Strictly sanitized node metadata included in the optional explainer summary (no env vars, secrets, or code). */
export interface ExplainSummaryNode {
  id: string;
  serviceId: string;
  kind: string;
  label: string;
  instances: number;
  region?: string;
}

/** Strictly sanitized insight metadata forwarded for optional prose rephrasing. */
export interface ExplainSummaryInsight {
  ruleId: string;
  title: string;
  severity: Insight['severity'];
  isRootCause: boolean;
  nodeIds: string[];
  evidence: Record<string, string | number>;
  short: string;
  suggestedFixes: { label: string; tradeOff?: string }[];
}

/** Aggregate simulation & cost numbers safe to preview and send to `POST /api/explain`. */
export interface ExplainSummaryPayload {
  designName: string;
  focusNodeId?: string;
  nodes: ExplainSummaryNode[];
  kpis: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    errorRate: number;
    throughputRps: number;
    monthlyCostUsd: number | null;
  };
  insights: ExplainSummaryInsight[];
}

const FORBIDDEN_EVIDENCE_KEY_RE =
  /(env|secret|token|key|password|script|source|code|fixture|payload)/i;

function sanitizeEvidenceRecord(
  evidence: Record<string, string | number> | undefined,
): Record<string, string | number> {
  if (!evidence) return {};
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (FORBIDDEN_EVIDENCE_KEY_RE.test(k)) {
      continue;
    }
    if (typeof v === 'number') {
      clean[k] = Number.isFinite(v) ? v : 0;
    } else if (typeof v === 'string') {
      clean[k] = v.slice(0, 120);
    }
  }
  return clean;
}

function countResolvedRequests(result: SimulationResult): {
  success: number;
  errors: number;
  throughputRps: number;
  errorRate: number;
} {
  let errors = 0;
  for (const val of Object.values(result.summary.errors)) {
    errors += val ?? 0;
  }
  const success = result.summary.success;
  const resolved = success + errors;
  const errorRate = resolved > 0 ? Number((errors / resolved).toFixed(4)) : 0;

  const throughputRps = Number((result.summary.throughputRps ?? 0).toFixed(2));

  return { success, errors, throughputRps, errorRate };
}

export interface BuildExplainSummaryOptions {
  design: Design;
  result: SimulationResult;
  insights: readonly Insight[];
  monthlyCostUsd?: number | null;
  focusNodeId?: string;
  maxInsights?: number;
}

/**
 * Builds a strictly sanitized summary payload containing ONLY node kinds/labels,
 * aggregate KPIs, and top rule insights. Never reads scripts, env vars, secrets, or fixture payloads.
 */
export function buildExplainSummaryPayload(
  options: BuildExplainSummaryOptions,
): ExplainSummaryPayload {
  const { design, result, insights, monthlyCostUsd = null, focusNodeId, maxInsights = 5 } = options;

  const nodes: ExplainSummaryNode[] = design.nodes.map((node) => {
    const svc = getService(node.serviceId, design.customServices);
    return {
      id: node.id,
      serviceId: node.serviceId,
      kind: svc?.kind ?? 'service',
      label: node.label,
      instances: node.config.instances,
      ...(node.region ? { region: node.region } : {}),
    };
  });

  const stats = countResolvedRequests(result);

  const selectedInsights = (
    focusNodeId
      ? [
          ...insights.filter((i) => i.nodeIds.includes(focusNodeId)),
          ...insights.filter((i) => !i.nodeIds.includes(focusNodeId)),
        ]
      : [...insights]
  )
    .slice(0, Math.max(1, maxInsights))
    .map<ExplainSummaryInsight>((ins) => ({
      ruleId: ins.ruleId,
      title: ins.title,
      severity: ins.severity,
      isRootCause: Boolean(ins.isRootCause),
      nodeIds: [...ins.nodeIds],
      evidence: sanitizeEvidenceRecord(ins.evidence),
      short: ins.explanation.short,
      suggestedFixes: ins.fixes.slice(0, 3).map((fix) => ({
        label: fix.label,
        ...(fix.tradeOff ? { tradeOff: fix.tradeOff } : {}),
      })),
    }));

  return {
    designName: design.name,
    ...(focusNodeId ? { focusNodeId } : {}),
    nodes,
    kpis: {
      p50Ms: Math.round(result.summary.p50),
      p95Ms: Math.round(result.summary.p95),
      p99Ms: Math.round(result.summary.p99),
      errorRate: stats.errorRate,
      throughputRps: stats.throughputRps,
      monthlyCostUsd: monthlyCostUsd !== null ? Number(monthlyCostUsd.toFixed(2)) : null,
    },
    insights: selectedInsights,
  };
}
