/** RFC 6902 JSON Patch operation targeting a Design document. */
export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

/** One-click remediation suggestion attached to an insight or reachability failure. */
export interface FixSuggestion {
  label: string;
  patch: JsonPatchOp[];
}

/** Two-level explanation rendered in the Why? tab and Insights dock. */
export interface InsightExplanation {
  short: string;
  deep: string;
}

/** Deterministic diagnostic insight emitted from simulation, network, or cost analysis. */
export interface Insight {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  nodeIds: string[];
  title: string;
  explanation: InsightExplanation;
  fixes: FixSuggestion[];
  lessonSlug?: string;
}
