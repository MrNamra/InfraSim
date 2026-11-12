import type { Scenario, SimulationResult, TrafficProfile, UserFlow } from '@infrasim/shared-types';
import type { ExtractedScenarioResult, ThresholdEvaluationResult } from './types.js';

interface ParsedCondition {
  stat: string;
  op: '<' | '<=' | '>' | '>=' | '==' | '===';
  value: number;
}

function parseThresholdExpression(raw: string): ParsedCondition | null {
  const cleaned = raw.trim();
  const match =
    /^(p\(\s*\d+(?:\.\d+)?\s*\)|avg|med|min|max|rate|count)\s*(<=|>=|===|==|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(
      cleaned,
    );
  if (!match) {
    return null;
  }
  const stat = match[1]!.replace(/\s+/g, '').toLowerCase();
  const op = match[2]! as ParsedCondition['op'];
  const value = Number(match[3]);
  if (!Number.isFinite(value)) {
    return null;
  }
  return { stat, op, value };
}

function compareCondition(actual: number, op: ParsedCondition['op'], target: number): boolean {
  switch (op) {
    case '<':
      return actual < target;
    case '<=':
      return actual <= target;
    case '>':
      return actual > target;
    case '>=':
      return actual >= target;
    case '==':
    case '===':
      return Math.abs(actual - target) < 1e-9;
  }
}

function resolveDurationStat(stat: string, result: SimulationResult): number {
  const { p50, p95, p99 } = result.summary;
  if (stat === 'med' || stat === 'p(50)' || stat === 'avg') {
    return p50;
  }
  if (stat === 'p(90)') {
    return p50 + ((p95 - p50) * (90 - 50)) / 45;
  }
  if (stat === 'p(95)') {
    return p95;
  }
  if (stat === 'p(99)' || stat === 'max') {
    return p99;
  }
  if (stat === 'min') {
    return Math.min(p50, 1);
  }
  const pctMatch = /^p\((\d+(?:\.\d+)?)\)$/.exec(stat);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct <= 50) return (p50 * pct) / 50;
    if (pct <= 95) return p50 + ((p95 - p50) * (pct - 50)) / 45;
    return p95 + ((p99 - p95) * Math.min(4, pct - 95)) / 4;
  }
  return p95;
}

function formatMetricLabel(
  metric: string,
  stat: string,
  actual: number,
  op: string,
  target: number,
): string {
  if (metric === 'http_req_duration') {
    return `${stat}: ${actual.toFixed(1)} ms ${op} ${target} ms`;
  }
  if (metric === 'http_req_failed' || metric === 'checks') {
    if (stat === 'rate') {
      return `${stat}: ${(actual * 100).toFixed(2)}% ${op} ${(target * 100).toFixed(2)}%`;
    }
    return `${stat}: ${Math.round(actual)} ${op} ${target}`;
  }
  return `${stat}: ${actual.toFixed(2)} ${op} ${target}`;
}

/**
 * Evaluates k6-style threshold expressions against a finished `SimulationResult`.
 * Supports `http_req_duration`, `http_req_failed`, `http_reqs`, and `checks`.
 */
export function evaluateScenarioThresholds(
  thresholds: Record<string, string[]> | undefined,
  result: SimulationResult,
): ThresholdEvaluationResult[] {
  if (!thresholds) {
    return [];
  }

  const total = Math.max(0, result.summary.totalRequests);
  const failedCount = Math.max(0, total - result.summary.success);
  const failureRate = total > 0 ? failedCount / total : 0;
  const passRate = total > 0 ? result.summary.success / total : 1;

  const evaluations: ThresholdEvaluationResult[] = [];
  for (const [metric, expressions] of Object.entries(thresholds)) {
    if (!Array.isArray(expressions)) continue;
    for (const rawExpr of expressions) {
      const parsed = parseThresholdExpression(rawExpr);
      if (!parsed) {
        evaluations.push({
          metric,
          expression: rawExpr,
          actualValue: 0,
          thresholdValue: 0,
          passed: false,
          label: `Unsupported expression "${rawExpr}"`,
        });
        continue;
      }

      let actualValue = 0;
      if (metric === 'http_req_duration') {
        actualValue = resolveDurationStat(parsed.stat, result);
      } else if (metric === 'http_req_failed') {
        actualValue = parsed.stat === 'count' ? failedCount : failureRate;
      } else if (metric === 'checks') {
        actualValue = parsed.stat === 'count' ? result.summary.success : passRate;
      } else if (metric === 'http_reqs') {
        actualValue = parsed.stat === 'count' ? total : result.summary.throughputRps;
      }

      const passed = compareCondition(actualValue, parsed.op, parsed.value);
      evaluations.push({
        metric,
        expression: rawExpr,
        actualValue: Number(actualValue.toFixed(6)),
        thresholdValue: parsed.value,
        passed,
        label: formatMetricLabel(metric, parsed.stat, actualValue, parsed.op, parsed.value),
      });
    }
  }

  return evaluations;
}

/**
 * Converts an `ExtractedScenarioResult` into an updated `Scenario` object by
 * syncing extracted `options` (RPS, stages/ramp, duration, thresholds) and weighted `UserFlow[]`.
 */
export function applyExtractedScenarioToScenario(
  scenario: Scenario,
  extracted: ExtractedScenarioResult,
  scriptId?: string,
): Scenario {
  const opts = extracted.options;
  const durationS = Math.max(1, Math.round(opts.durationS ?? scenario.durationS));

  let nextProfile: TrafficProfile = scenario.profile;
  if (opts.stages && opts.stages.length > 0) {
    let elapsed = 0;
    const steps: { atS: number; rps: number }[] = [];
    for (const st of opts.stages) {
      steps.push({ atS: elapsed, rps: Math.max(0, Math.round(st.targetRps)) });
      elapsed += Math.max(1, Math.round(st.durationS));
    }
    nextProfile = { kind: 'steps', steps };
  } else if (opts.rps !== undefined) {
    const rps = Math.max(0, Math.round(opts.rps));
    if (opts.rampUpS && opts.rampUpS > 0 && durationS > opts.rampUpS) {
      nextProfile = {
        kind: 'steps',
        steps: [
          { atS: 0, rps: Math.max(1, Math.round(rps * 0.2)) },
          { atS: Math.round(opts.rampUpS), rps },
        ],
      };
    } else if (opts.rampUpS && opts.rampUpS > 0) {
      nextProfile = { kind: 'ramp', fromRps: Math.max(1, Math.round(rps * 0.1)), toRps: rps };
    } else {
      nextProfile = { kind: 'constant', rps };
    }
  }

  const nextFlows: UserFlow[] =
    extracted.flows.length > 0
      ? extracted.flows.map((f) => ({
          ...f,
          steps: f.steps.map((s) => ({ ...s })),
        }))
      : scenario.flows;

  const nextDuration =
    opts.stages && opts.stages.length > 0
      ? Math.max(
          durationS,
          opts.stages.reduce((acc, s) => acc + Math.max(1, Math.round(s.durationS)), 0),
        )
      : durationS;

  return {
    ...scenario,
    durationS: nextDuration,
    profile: nextProfile,
    flows: nextFlows,
    ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
    ...(scriptId ? { scriptId } : {}),
  };
}
