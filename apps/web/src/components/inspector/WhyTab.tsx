'use client';

import { useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Info,
  Play,
  Wrench,
} from 'lucide-react';
import { applyJsonPatch } from '@infrasim/diagnosis';
import type {
  Design,
  FixSuggestion,
  Insight,
  JsonPatchOp,
  NodeInstance,
  ServiceDefinition,
  SimulationResult,
} from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { formatMoney } from '../../lib/costFormat';
import { computeTheoreticalMaxRps } from '../../lib/nodeDefaults';

export interface WhyTabProps {
  design: Design;
  node: NodeInstance;
  service?: ServiceDefinition;
  result: SimulationResult | null;
  previousResult: SimulationResult | null;
  currentMonthlyCost?: { total: number; currency: string } | null;
  previousMonthlyCost?: { total: number; currency: string } | null;
  appliedFixLabel: string | null;
  isRunning: boolean;
  onApplyPatchedDesign: (nextDesign: Design, fixLabel: string) => void;
  onRerunVerify: () => void;
  onSelectNodeWhy?: (nodeId: string) => void;
}

const SEVERITY_STYLE: Record<
  Insight['severity'],
  { label: string; colorClass: string; Icon: typeof AlertOctagon }
> = {
  critical: {
    label: 'Critical',
    colorClass: 'text-[var(--status-overloaded)]',
    Icon: AlertOctagon,
  },
  warning: {
    label: 'Warning',
    colorClass: 'text-[var(--status-warm)]',
    Icon: AlertTriangle,
  },
  info: {
    label: 'Info',
    colorClass: 'text-[var(--accent)]',
    Icon: Info,
  },
};

function countTotalErrors(res: SimulationResult): number {
  let total = 0;
  for (const val of Object.values(res.summary.errors)) {
    total += val ?? 0;
  }
  return total;
}

function formatPatchLine(op: JsonPatchOp): string {
  const cleanPath = op.path.replace(/^\/nodes\/\d+\//, '');
  if (op.op === 'remove') {
    return `- ${cleanPath}`;
  }
  const valStr = typeof op.value === 'object' ? JSON.stringify(op.value) : String(op.value);
  return `+ ${cleanPath}: ${valStr}`;
}

function formatEvidenceEntry(key: string, val: string | number): string {
  if (key.endsWith('Pct')) {
    return `${key.replace(/Pct$/, '')}: ${val}%`;
  }
  if (key.endsWith('Ms')) {
    return `${key.replace(/Ms$/, '')}: ${val} ms`;
  }
  if (key.endsWith('S') && key !== 'p50S') {
    return `${key.replace(/S$/, '')}: ${val} s`;
  }
  return `${key}: ${val}`;
}

/** Node "Why?" diagnostic tab displaying ranked causes, root-cause chains, evidence, deep explanations, and patch fixes. */
export function WhyTab({
  design,
  node,
  service,
  result,
  previousResult,
  currentMonthlyCost,
  previousMonthlyCost,
  appliedFixLabel,
  isRunning,
  onApplyPatchedDesign,
  onRerunVerify,
  onSelectNodeWhy,
}: WhyTabProps) {
  const [expandedRuleIds, setExpandedRuleIds] = useState<Record<string, boolean>>({});
  const [expandedDiffKey, setExpandedDiffKey] = useState<string | null>(null);

  const theoretical = computeTheoreticalMaxRps(node.config, service);

  if (!result) {
    return (
      <div className="space-y-3 p-4 text-[12px]" data-testid="inspector-why-tab">
        <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3 text-[var(--text-secondary)]">
          Run a simulation to inspect bottlenecks, saturation causes, and suggested fixes for{' '}
          <span className="font-medium text-[var(--text-primary)]">{node.label}</span>.
        </div>
        {theoretical.rps !== null ? (
          <div className="flex items-center justify-between rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11px]">
            <span className="text-[var(--text-muted)]">Theoretical max RPS</span>
            <span className="font-mono font-medium tabular-nums text-[var(--text-primary)]">
              {theoretical.rps.toLocaleString()} req/s
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  const nodeSummary = result.perNode[node.id];
  const nodeInsights = result.insights.filter((ins) => ins.nodeIds.includes(node.id)).slice(0, 5);

  const handleApplyFix = (fix: FixSuggestion) => {
    const nextDesign = applyJsonPatch(design, fix.patch);
    onApplyPatchedDesign(nextDesign, fix.label);
  };

  const prevErrors = previousResult ? countTotalErrors(previousResult) : null;
  const curErrors = countTotalErrors(result);

  return (
    <div className="space-y-3 p-4 text-[12px]" data-testid="inspector-why-tab">
      {appliedFixLabel ? (
        <div
          data-testid="applied-fix-banner"
          className="flex flex-col gap-2 rounded-[8px] border border-[var(--accent)] bg-[var(--accent-soft)] p-3"
        >
          <div className="text-[11px] font-medium text-[var(--text-primary)]">
            Fix applied: {appliedFixLabel}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="rerun-verify-btn"
              disabled={isRunning}
              onClick={onRerunVerify}
              className="h-7 px-2.5 text-[11px]"
            >
              <Play className="h-3 w-3" strokeWidth={1.5} />
              <span>{isRunning ? 'Running…' : 'Re-run to verify'}</span>
            </Button>
          </div>
        </div>
      ) : null}

      {previousResult ? (
        <div
          data-testid="why-before-after"
          className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[11px]"
        >
          <div className="mb-1 text-[10px] font-medium text-[var(--text-muted)]">
            Comparison vs previous run
          </div>
          <div className="flex items-center justify-between font-mono tabular-nums">
            <span className="text-[var(--text-secondary)]">p95 latency</span>
            <span className="text-[var(--text-primary)]">
              {Math.round(previousResult.summary.p95)} ms → {Math.round(result.summary.p95)} ms
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between font-mono tabular-nums">
            <span className="text-[var(--text-secondary)]">Total errors</span>
            <span
              className={
                curErrors < (prevErrors ?? 0)
                  ? 'text-[var(--status-ok)]'
                  : 'text-[var(--text-primary)]'
              }
            >
              {prevErrors?.toLocaleString()} → {curErrors.toLocaleString()}
            </span>
          </div>
          {previousMonthlyCost && currentMonthlyCost ? (
            <div className="mt-0.5 flex items-center justify-between font-mono tabular-nums">
              <span className="text-[var(--text-secondary)]">Monthly cost</span>
              <span
                className={
                  currentMonthlyCost.total < previousMonthlyCost.total
                    ? 'text-[var(--status-ok)]'
                    : 'text-[var(--text-primary)]'
                }
              >
                {formatMoney(previousMonthlyCost.total, previousMonthlyCost.currency)} →{' '}
                {formatMoney(currentMonthlyCost.total, currentMonthlyCost.currency)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {nodeInsights.length === 0 ? (
        <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
          <div className="flex items-center gap-2 text-[var(--status-ok)]">
            <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            <span className="text-[12px] font-medium">Healthy</span>
          </div>
          {nodeSummary ? (
            <p className="text-[12px] leading-4 text-[var(--text-secondary)]">
              Peaked at{' '}
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {Math.round(nodeSummary.peakUtilization * 100)}%
              </span>{' '}
              utilization (
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {Math.round(nodeSummary.p95)} ms
              </span>{' '}
              p95
              {theoretical.rps !== null
                ? `, ~${theoretical.rps.toLocaleString()} req/s theoretical max`
                : ''}
              ).
            </p>
          ) : (
            <p className="text-[12px] text-[var(--text-secondary)]">
              No active capacity or timeout issues recorded for this node.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {nodeInsights.map((insight, idx) => {
            const sev = SEVERITY_STYLE[insight.severity];
            const SevIcon = sev.Icon;
            const ruleKey = `${insight.ruleId}-${idx}`;
            const isExpanded = Boolean(expandedRuleIds[ruleKey]);
            const evidenceEntries = Object.entries(insight.evidence ?? {}).filter(
              ([k]) => k !== 'nodeLabel',
            );

            return (
              <article
                key={ruleKey}
                data-testid={`why-insight-${insight.ruleId}`}
                className="space-y-2.5 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-sunken)] p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SevIcon className={`h-4 w-4 shrink-0 ${sev.colorClass}`} strokeWidth={1.5} />
                    <span className={`text-[11px] font-medium ${sev.colorClass}`}>{sev.label}</span>
                    {insight.isRootCause ? (
                      <span
                        data-testid={`root-cause-badge-${insight.ruleId}`}
                        className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)]"
                      >
                        <Crosshair className="h-2.5 w-2.5 text-[var(--accent)]" strokeWidth={1.5} />
                        <span>Root cause</span>
                      </span>
                    ) : null}
                  </div>
                  {insight.impactScore !== undefined ? (
                    <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                      impact {insight.impactScore.toFixed(2)}
                    </span>
                  ) : null}
                </div>

                <h3 className="text-[13px] font-medium leading-4 text-[var(--text-primary)]">
                  {insight.title}
                </h3>

                {insight.causalChain && insight.causalChain.length > 1 ? (
                  <div
                    data-testid={`causal-chain-${insight.ruleId}`}
                    className="flex flex-wrap items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[10px] text-[var(--text-secondary)]"
                  >
                    <span className="font-medium text-[var(--text-muted)]">Chain:</span>
                    {insight.causalChain.map((link, cIdx) => (
                      <span
                        key={`${link.nodeId}-${link.ruleId}-${cIdx}`}
                        className="inline-flex items-center gap-1"
                      >
                        {cIdx > 0 ? (
                          <ArrowRight
                            className="h-2.5 w-2.5 text-[var(--text-muted)]"
                            strokeWidth={1.5}
                          />
                        ) : null}
                        {onSelectNodeWhy && link.nodeId !== node.id ? (
                          <button
                            type="button"
                            onClick={() => onSelectNodeWhy(link.nodeId)}
                            className="rounded-[4px] bg-[var(--bg-sunken)] px-1 py-0.5 font-mono text-[var(--accent)] hover:underline"
                            title={`${link.title} (${link.ruleId})`}
                          >
                            {link.nodeLabel}
                          </button>
                        ) : (
                          <span
                            className={`rounded-[4px] bg-[var(--bg-sunken)] px-1 py-0.5 font-mono ${
                              cIdx === 0
                                ? 'font-medium text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)]'
                            }`}
                            title={`${link.title} (${link.ruleId})`}
                          >
                            {link.nodeLabel}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                ) : null}

                {evidenceEntries.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {evidenceEntries.map(([k, v]) => (
                      <span
                        key={k}
                        className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]"
                      >
                        {formatEvidenceEntry(k, v)}
                      </span>
                    ))}
                  </div>
                ) : null}

                <p className="text-[12px] leading-5 text-[var(--text-secondary)]">
                  {insight.explanation.short}
                </p>

                <button
                  type="button"
                  onClick={() =>
                    setExpandedRuleIds((prev) => ({
                      ...prev,
                      [ruleKey]: !prev[ruleKey],
                    }))
                  }
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
                >
                  <span>{isExpanded ? 'Hide detail' : 'Explain more'}</span>
                  {isExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.5} />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                </button>

                {isExpanded ? (
                  <div className="space-y-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11px] leading-4 text-[var(--text-secondary)]">
                    {insight.explanation.deep.split('\n').map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                ) : null}

                {insight.fixes.length > 0 ? (
                  <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
                      <Wrench className="h-3 w-3" strokeWidth={1.5} />
                      <span>Suggested fixes</span>
                    </div>
                    <div className="space-y-1.5">
                      {insight.fixes.map((fix, fIdx) => {
                        const diffKey = `${ruleKey}-fix-${fIdx}`;
                        const showDiff = expandedDiffKey === diffKey;
                        return (
                          <div
                            key={diffKey}
                            className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-medium text-[var(--text-primary)]">
                                {fix.label}
                              </span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedDiffKey((cur) => (cur === diffKey ? null : diffKey))
                                  }
                                  className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                >
                                  {showDiff ? 'Hide diff' : 'Diff'}
                                </button>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  data-testid={`apply-fix-${insight.ruleId}-${fIdx}`}
                                  onClick={() => handleApplyFix(fix)}
                                  className="h-6 px-2 text-[10px]"
                                >
                                  Apply fix
                                </Button>
                              </div>
                            </div>
                            {fix.tradeOff ? (
                              <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                                Trade-off: {fix.tradeOff}
                              </p>
                            ) : null}
                            {showDiff ? (
                              <pre className="mt-1.5 overflow-x-auto rounded-[4px] bg-[var(--bg-sunken)] p-1.5 font-mono text-[10px] text-[var(--status-ok)]">
                                {fix.patch.map(formatPatchLine).join('\n')}
                              </pre>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
