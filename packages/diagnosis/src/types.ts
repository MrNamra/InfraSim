import type {
  CostReport,
  Design,
  FixSuggestion,
  InsightExplanation,
  NetworkAnalysis,
  NodeInstance,
  NodeSummary,
  ServiceDefinition,
  SimulationResult,
} from '@infrasim/shared-types';

/** Context passed into deterministic diagnostic rules. */
export interface DiagnosisContext {
  design: Design;
  result?: SimulationResult;
  network?: NetworkAnalysis;
  cost?: CostReport;
  catalog?: readonly ServiceDefinition[];
}

/** Evidence and structural metadata matched by a diagnostic rule. */
export interface RuleMatch {
  nodeIds: string[];
  edgeIds?: string[];
  evidence: Record<string, string | number>;
  /** Fraction of traffic affected `[0..1]` for impact ranking. */
  trafficShare: number;
  /** Fraction of run duration affected `[0..1]` for impact ranking. */
  durationFraction: number;
  /** Override severity for a specific match if needed. */
  severityOverride?: 'info' | 'warning' | 'critical';
}

/** Declarative rule definition matching spec 17 §2. */
export interface Rule {
  id: string;
  title: string;
  severity: 'info' | 'warning' | 'critical';
  requires?: ('sim' | 'network' | 'cost')[];
  lessonSlug?: string;
  appliesTo: (ctx: DiagnosisContext) => RuleMatch[];
  explain: (match: RuleMatch, ctx: DiagnosisContext) => InsightExplanation;
  fixes: (match: RuleMatch, ctx: DiagnosisContext) => FixSuggestion[];
}

export interface NodeEvalInfo {
  node: NodeInstance;
  nodeIdx: number;
  summary: NodeSummary;
  hotBuckets: number;
  overloadedBuckets: number;
  downBuckets: number;
  growingQueueBuckets: number;
  isHotOrOverloaded: boolean;
}
