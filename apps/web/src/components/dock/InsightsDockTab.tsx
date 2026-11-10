'use client';

import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Play, Wrench } from 'lucide-react';
import { applyJsonPatch } from '@infrasim/diagnosis';
import type { Design, FixSuggestion, Insight, SimulationResult } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';

export interface InsightsDockTabProps {
  design: Design;
  result: SimulationResult | null;
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

/** Dock panel displaying all ranked architectural insights with clickable node links and patch fixes. */
export function InsightsDockTab({
  design,
  result,
  appliedFixLabel,
  isRunning,
  onSelectNodeWhy,
  onApplyPatchedDesign,
  onRerunVerify,
}: InsightsDockTabProps) {
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

  const nodeLabelMap = new Map(design.nodes.map((n) => [n.id, n.label]));

  return (
    <div
      data-testid="insights-dock-tab"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3"
    >
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

      <div className="space-y-2">
        {result.insights.map((insight, idx) => {
          const sev = SEV_META[insight.severity];
          const Icon = sev.Icon;
          const primaryNodeId = insight.nodeIds[0];

          return (
            <div
              key={`${insight.ruleId}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[12px]"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-medium ${sev.colorClass}`}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>{sev.label}</span>
                  </span>
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
