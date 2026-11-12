'use client';

import { useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Crosshair,
  Info,
  Play,
  Wrench,
} from 'lucide-react';
import { applyJsonPatch } from '@infrasim/diagnosis';
import type { Design, FixSuggestion, Insight, SimulationResult } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { formatMoney } from '../../lib/costFormat';

export interface InsightsDockTabProps {
  design: Design;
  result: SimulationResult | null;
  previousResult?: SimulationResult | null;
  currentMonthlyCost?: { total: number; currency: string } | null;
  previousMonthlyCost?: { total: number; currency: string } | null;
  appliedFixLabel: string | null;
  isRunning: boolean;
  onSelectNodeWhy: (nodeId: string) => void;
  onApplyPatchedDesign: (nextDesign: Design, fixLabel: string) => void;
  onRerunVerify: () => void;
}

const SEV_META: Record<
  Insight['severity'],
  { label: string; colorClass: string; Icon: typeof AlertOctagon }
> = {
  critical: {
    label: 'Critical',
    colorClass: 'text-[var(--status-overloaded)]',
    Icon: AlertOctagon,
  },
  warning: { label: 'Warning', colorClass: 'text-[var(--status-warm)]', Icon: AlertTriangle },
  info: { label: 'Info', colorClass: 'text-[var(--accent)]', Icon: Info },
};

function countErrors(res: SimulationResult): number {
  let sum = 0;
  for (const val of Object.values(res.summary.errors)) {
    sum += val ?? 0;
  }
  return sum;
}

/** Dock panel displaying all ranked architectural insights with causal chains, filters, and patch fixes. */
export function InsightsDockTab({
  design,
  result,
  previousResult,
  currentMonthlyCost,
  previousMonthlyCost,
  appliedFixLabel,
  isRunning,
  onSelectNodeWhy,
  onApplyPatchedDesign,
  onRerunVerify,
}: InsightsDockTabProps) {
  const [severityFilter, setSeverityFilter] = useState<'all' | Insight['severity']>('all');
  const [nodeFilter, setNodeFilter] = useState<string>('all');

  const nodeLabelMap = useMemo(
    () => new Map(design.nodes.map((n) => [n.id, n.label])),
    [design.nodes],
  );

  const affectedNodeOptions = useMemo(() => {
    if (!result) return [];
    const ids = new Set<string>();
    for (const ins of result.insights) {
      for (const id of ins.nodeIds) ids.add(id);
    }
    return [...ids]
      .map((id) => ({ id, label: nodeLabelMap.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [result, nodeLabelMap]);

  const filteredInsights = useMemo(() => {
    if (!result) return [];
    return result.insights.filter((ins) => {
      if (severityFilter !== 'all' && ins.severity !== severityFilter) return false;
      if (nodeFilter !== 'all' && !ins.nodeIds.includes(nodeFilter)) return false;
      return true;
    });
  }, [result, severityFilter, nodeFilter]);

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-[12px] text-[var(--text-muted)]">
          Run a simulation to inspect ranked bottlenecks and remedial fixes.
        </p>
      </div>
    );
  }

  const handleApplyFix = (fix: FixSuggestion) => {
    const patched = applyJsonPatch(design, fix.patch);
    onApplyPatchedDesign(patched, fix.label);
  };

  if (result.insights.length === 0) {
    return (
      <div
        data-testid="insights-dock-tab"
        className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      >
        <CheckCircle2 className="h-5 w-5 text-[var(--status-ok)]" strokeWidth={1.5} />
        <p className="text-[12px] font-medium text-[var(--text-primary)]">
          All nodes remained within sustainable operating capacity
        </p>
      </div>
    );
  }

  const prevErrors = previousResult ? countErrors(previousResult) : null;
  const curErrors = countErrors(result);

  return (
    <div
      data-testid="insights-dock-tab"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2">
        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'critical', 'warning', 'info'] as const).map((sev) => {
            const active = severityFilter === sev;
            return (
              <button
                key={sev}
                type="button"
                onClick={() => setSeverityFilter(sev)}
                className={`rounded-[6px] px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                  active
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] ring-1 ring-[var(--border-strong)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {sev}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Filter insights by node"
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            className="h-7 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-primary)]"
          >
            <option value="all">All nodes ({result.insights.length})</option>
            {affectedNodeOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {appliedFixLabel ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-[8px] border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px]">
          <span className="font-medium text-[var(--text-primary)]">Applied: {appliedFixLabel}</span>
          <Button
            variant="primary"
            size="sm"
            disabled={isRunning}
            onClick={onRerunVerify}
            className="h-7 px-2.5 text-[11px]"
          >
            <Play className="h-3 w-3" strokeWidth={1.5} />
            <span>{isRunning ? 'Running…' : 'Re-run to verify'}</span>
          </Button>
        </div>
      ) : null}

      {previousResult ? (
        <div
          data-testid="insights-before-after"
          className="mb-3 flex flex-wrap items-center gap-4 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 font-mono text-[11px] tabular-nums"
        >
          <span className="font-sans text-[10px] font-medium text-[var(--text-muted)]">
            Run diff:
          </span>
          <span className="text-[var(--text-secondary)]">
            p95{' '}
            <span className="text-[var(--text-primary)]">
              {Math.round(previousResult.summary.p95)} → {Math.round(result.summary.p95)} ms
            </span>
          </span>
          <span className="text-[var(--text-secondary)]">
            errors{' '}
            <span
              className={
                curErrors < (prevErrors ?? 0)
                  ? 'text-[var(--status-ok)]'
                  : 'text-[var(--text-primary)]'
              }
            >
              {prevErrors?.toLocaleString()} → {curErrors.toLocaleString()}
            </span>
          </span>
          {previousMonthlyCost && currentMonthlyCost ? (
            <span className="text-[var(--text-secondary)]">
              cost{' '}
              <span className="text-[var(--text-primary)]">
                {formatMoney(previousMonthlyCost.total, previousMonthlyCost.currency)} →{' '}
                {formatMoney(currentMonthlyCost.total, currentMonthlyCost.currency)}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        {filteredInsights.map((insight, idx) => {
          const sev = SEV_META[insight.severity];
          const Icon = sev.Icon;
          const primaryNodeId = insight.nodeIds[0];

          return (
            <div
              key={`${insight.ruleId}-${idx}`}
              data-testid={`dock-insight-${insight.ruleId}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[12px]"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-medium ${sev.colorClass}`}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>{sev.label}</span>
                  </span>
                  {insight.isRootCause ? (
                    <span className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)]">
                      <Crosshair className="h-2.5 w-2.5 text-[var(--accent)]" strokeWidth={1.5} />
                      <span>Root cause</span>
                    </span>
                  ) : null}
                  <span className="font-medium text-[var(--text-primary)]">{insight.title}</span>
                  {primaryNodeId ? (
                    <button
                      type="button"
                      onClick={() => onSelectNodeWhy(primaryNodeId)}
                      className="rounded-[4px] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)] hover:underline"
                    >
                      {nodeLabelMap.get(primaryNodeId) ?? primaryNodeId}
                    </button>
                  ) : null}
                </div>
                {insight.causalChain && insight.causalChain.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <span>Causal chain:</span>
                    {insight.causalChain.map((link, cIdx) => (
                      <span
                        key={`${link.nodeId}-${link.ruleId}-${cIdx}`}
                        className="inline-flex items-center gap-1"
                      >
                        {cIdx > 0 ? <ArrowRight className="h-2.5 w-2.5" strokeWidth={1.5} /> : null}
                        <button
                          type="button"
                          onClick={() => onSelectNodeWhy(link.nodeId)}
                          className="font-mono text-[var(--accent)] hover:underline"
                        >
                          {link.nodeLabel}
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="text-[11px] text-[var(--text-secondary)]">
                  {insight.explanation.short}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {insight.fixes[0] ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleApplyFix(insight.fixes[0]!)}
                    className="h-7 px-2.5 text-[11px]"
                  >
                    <Wrench className="h-3 w-3" strokeWidth={1.5} />
                    <span>{insight.fixes[0]!.label}</span>
                  </Button>
                ) : null}
                {primaryNodeId ? (
                  <button
                    type="button"
                    onClick={() => onSelectNodeWhy(primaryNodeId)}
                    className="text-[11px] font-medium text-[var(--accent)] hover:underline"
                  >
                    Inspect Why
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
