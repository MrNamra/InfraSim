'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Layers, X } from 'lucide-react';
import { applyProviderSwitch, type CloudTargetProvider } from '@infrasim/catalog';
import {
  estimateMonthlyCost,
  findBestMatchingInstanceType,
  findEquivalentRegion,
  getInstanceSpec,
  summarizeCostBreakdown,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import type {
  CostAssumptions,
  CustomServiceDefinition,
  Design,
  Provider,
  SimulationResult,
} from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { formatMoney } from '../lib/costFormat';

export interface ProviderSwitchModalProps {
  open: boolean;
  design: Design;
  simResult: SimulationResult | null;
  priceSnapshot: PriceSnapshot | null;
  assumptions: CostAssumptions;
  currentRegion: string;
  customServices: CustomServiceDefinition[];
  initialTargetProvider?: CloudTargetProvider;
  onClose: () => void;
  onApplySwitch: (
    nextDesign: Design,
    targetProvider: CloudTargetProvider,
    targetRegion: string,
  ) => void;
}

const PROVIDERS: Array<{ id: CloudTargetProvider; label: string }> = [
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
  { id: 'oci', label: 'OCI' },
];

function isCloudProvider(p: Provider | undefined): p is CloudTargetProvider {
  return p === 'aws' || p === 'gcp' || p === 'azure' || p === 'oci';
}

function formatDeltaPercent(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

/** Modal previewing approximate cross-cloud service mapping, behavior notes, and cost delta before applying. */
export function ProviderSwitchModal({
  open,
  design,
  simResult,
  priceSnapshot,
  assumptions,
  currentRegion,
  customServices,
  initialTargetProvider,
  onClose,
  onApplySwitch,
}: ProviderSwitchModalProps) {
  const sourceProvider: CloudTargetProvider = isCloudProvider(design.settings.primaryProvider)
    ? design.settings.primaryProvider
    : 'aws';

  const defaultTarget: CloudTargetProvider =
    initialTargetProvider && initialTargetProvider !== sourceProvider
      ? initialTargetProvider
      : (PROVIDERS.find((p) => p.id !== sourceProvider)?.id ?? 'gcp');

  const [targetProvider, setTargetProvider] = useState<CloudTargetProvider>(defaultTarget);
  const [unmappedAction, setUnmappedAction] = useState<'keep' | 'convert-to-custom'>('keep');

  useEffect(() => {
    if (!open) return;
    setTargetProvider(
      initialTargetProvider && initialTargetProvider !== sourceProvider
        ? initialTargetProvider
        : (PROVIDERS.find((p) => p.id !== sourceProvider)?.id ?? 'gcp'),
    );
  }, [open, initialTargetProvider, sourceProvider]);

  const preview = useMemo(() => {
    const baseRegionEquiv = findEquivalentRegion(sourceProvider, currentRegion, targetProvider);
    const targetRegion = baseRegionEquiv?.targetRegion ?? currentRegion;

    const baseCostReport = estimateMonthlyCost(design, simResult, priceSnapshot, assumptions, {
      defaultRegion: currentRegion,
      customServices,
    });

    const applied = applyProviderSwitch(design, targetProvider, {
      customServices,
      defaultSourceRegion: currentRegion,
      defaultTargetRegion: targetRegion,
      unmappedAction,
      resolveRegion: (fromProv, fromReg, toProv) => {
        const effFrom = isCloudProvider(fromProv) ? fromProv : sourceProvider;
        return findEquivalentRegion(effFrom, fromReg, toProv);
      },
      resolveInstanceType: (tgtProv, srcCfg, srcSvc, tgtSvc) => {
        const srcProv =
          srcSvc && isCloudProvider(srcSvc.provider) ? srcSvc.provider : sourceProvider;
        const spec = srcCfg.instanceType
          ? getInstanceSpec(srcProv, srcCfg.instanceType)
          : undefined;
        const vcpu = srcCfg.vcpu ?? spec?.vcpu;
        const memGb = srcCfg.memoryGb ?? spec?.memoryGb;
        if (tgtSvc.kind !== 'compute' && tgtSvc.kind !== 'sql' && tgtSvc.kind !== 'cache') {
          return undefined;
        }
        return findBestMatchingInstanceType(
          tgtProv,
          vcpu,
          memGb,
          tgtSvc.kind === 'sql' || tgtSvc.kind === 'cache' ? 'database' : 'compute',
        );
      },
    });

    const targetCostReport = estimateMonthlyCost(
      applied.design,
      simResult,
      priceSnapshot,
      assumptions,
      {
        defaultRegion: targetRegion,
        customServices: applied.design.customServices ?? customServices,
      },
    );
    const targetMeta = summarizeCostBreakdown(applied.design, targetCostReport, simResult, {
      customServices: applied.design.customServices ?? customServices,
    });

    const deltaPercent =
      baseCostReport.monthlyTotal > 0
        ? ((targetCostReport.monthlyTotal - baseCostReport.monthlyTotal) /
            baseCostReport.monthlyTotal) *
          100
        : null;

    return {
      applied,
      targetRegion,
      baseCostReport,
      targetCostReport,
      targetMeta,
      deltaPercent,
    };
  }, [
    design,
    simResult,
    priceSnapshot,
    assumptions,
    currentRegion,
    customServices,
    sourceProvider,
    targetProvider,
    unmappedAction,
  ]);

  if (!open) {
    return null;
  }

  const currency = preview.targetCostReport.currency || assumptions.currency;
  const { plan } = preview.applied;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch cloud provider"
      data-testid="provider-switch-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
          <div>
            <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
              Switch cloud provider
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              Map topology and compatible services using catalog equivalents while preserving
              connections and traffic scenarios.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close modal"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Provider selector & approximate notice */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text-muted)]">Target cloud</span>
            <div className="flex items-center gap-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-0.5">
              {PROVIDERS.map((p) => {
                const active = targetProvider === p.id;
                const isSrc = sourceProvider === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`switch-target-${p.id}`}
                    onClick={() => setTargetProvider(p.id)}
                    className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? 'bg-[var(--accent-solid)] text-[var(--accent-solid-text)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {p.label}
                    {isSrc ? ' (current)' : ''}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            data-testid="provider-switch-approx-badge"
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
          >
            <Info className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.5} />
            <span>Approximate mapping — costs reused from current simulation counters</span>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-3 border-b border-[var(--border-hairline)] px-5 py-3 sm:grid-cols-4">
          <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)]">Mapped nodes</div>
            <div className="mt-0.5 font-mono text-[14px] font-medium tabular-nums text-[var(--text-primary)]">
              {plan.mappedCount}
              <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">
                ({plan.keptCount} kept)
              </span>
            </div>
          </div>

          <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)]">Unmapped services</div>
            <div
              className={`mt-0.5 font-mono text-[14px] font-medium tabular-nums ${
                plan.unmappedCount > 0 ? 'text-[var(--status-warm)]' : 'text-[var(--status-ok)]'
              }`}
            >
              {plan.unmappedCount}
            </div>
          </div>

          <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)]">Mapped region</div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--text-primary)]">
              {currentRegion} → {preview.targetRegion}
            </div>
          </div>

          <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2">
            <div className="text-[10px] text-[var(--text-muted)]">Estimated monthly cost</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[13px] font-medium tabular-nums text-[var(--text-primary)]">
              <span>{formatMoney(preview.targetCostReport.monthlyTotal, currency)}</span>
              <span
                className={`text-[10px] ${
                  preview.deltaPercent !== null && preview.deltaPercent > 5
                    ? 'text-[var(--status-warm)]'
                    : preview.deltaPercent !== null && preview.deltaPercent < -5
                      ? 'text-[var(--status-ok)]'
                      : 'text-[var(--text-muted)]'
                }`}
              >
                {formatDeltaPercent(preview.deltaPercent)}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[12px]">
          {plan.unmappedCount > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2.5">
              <div className="flex items-center gap-2 text-[11px] text-[var(--status-warm)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                <span>
                  {plan.unmappedCount} service(s) have no direct {targetProvider.toUpperCase()}{' '}
                  equivalent.
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)]">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="unmapped-action"
                    checked={unmappedAction === 'keep'}
                    onChange={() => setUnmappedAction('keep')}
                  />
                  <span>Keep original node</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="unmapped-action"
                    checked={unmappedAction === 'convert-to-custom'}
                    onChange={() => setUnmappedAction('convert-to-custom')}
                  />
                  <span>Convert to custom block</span>
                </label>
              </div>
            </div>
          ) : null}

          {/* Node Diff Table */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[11px] font-medium text-[var(--text-secondary)]">
                Service mapping diff ({plan.nodeDiffs.length})
              </h3>
              {preview.targetMeta.unavailableCount > 0 ? (
                <span className="font-mono text-[10px] text-[var(--status-warm)]">
                  {preview.targetMeta.unavailableCount} target SKU line(s) unavailable in loaded
                  snapshot
                </span>
              ) : null}
            </div>

            {plan.nodeDiffs.length === 0 ? (
              <p className="rounded-[8px] border border-[var(--border-hairline)] p-4 text-center text-[11px] text-[var(--text-muted)]">
                Canvas has no service nodes yet. Applying will switch default provider and region
                groups.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-[8px] border border-[var(--border-hairline)]">
                <table className="w-full text-left text-[11px]">
                  <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-muted)]">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Canvas node</th>
                      <th className="px-3 py-1.5 font-medium">Source service</th>
                      <th className="px-3 py-1.5 font-medium">Target service</th>
                      <th className="px-3 py-1.5 font-medium">SKU / Instance</th>
                      <th className="px-3 py-1.5 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {plan.nodeDiffs.map((diff) => (
                      <tr key={diff.nodeId} data-testid={`switch-diff-row-${diff.nodeId}`}>
                        <td className="px-3 py-2 font-medium text-[var(--text-primary)]">
                          {diff.nodeLabel}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-secondary)]">
                          <div>{diff.sourceServiceName}</div>
                          <div className="text-[var(--text-muted)]">{diff.sourceServiceId}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-primary)]">
                          {diff.status === 'mapped' ? (
                            <div className="flex items-center gap-1.5">
                              <ArrowRight
                                className="h-3 w-3 shrink-0 text-[var(--accent)]"
                                strokeWidth={1.5}
                              />
                              <div>
                                <div>{diff.targetServiceName}</div>
                                <div className="text-[var(--text-muted)]">
                                  {diff.targetServiceId}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">
                              {diff.status === 'unmapped' && unmappedAction === 'convert-to-custom'
                                ? 'custom placeholder block'
                                : diff.targetServiceId}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">
                          {diff.sourceInstanceType && diff.targetInstanceType
                            ? `${diff.sourceInstanceType} → ${diff.targetInstanceType}`
                            : diff.sourceInstanceType && diff.status === 'mapped'
                              ? `${diff.sourceInstanceType} → (default)`
                              : (diff.sourceInstanceType ?? '—')}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {diff.status === 'mapped' ? (
                            <span className="inline-flex items-center gap-1 rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--status-ok)]">
                              <CheckCircle2 className="h-3 w-3" strokeWidth={1.5} />
                              <span>Mapped</span>
                            </span>
                          ) : diff.status === 'unmapped' ? (
                            <span className="inline-flex items-center gap-1 rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--status-warm)]">
                              <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
                              <span>Unmapped</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                              <Layers className="h-3 w-3" strokeWidth={1.5} />
                              <span>Kept</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Behavior differences list */}
          {plan.behaviorSummary.length > 0 ? (
            <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
              <h3 className="text-[11px] font-medium text-[var(--text-secondary)]">
                Behavior & pricing differences to verify
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {plan.behaviorSummary.map((note, idx) => (
                  <li key={idx}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-5 py-3">
          <span className="text-[11px] text-[var(--text-muted)]">
            Recorded on undo stack — reverse anytime with Ctrl+Z
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="confirm-provider-switch-btn"
              onClick={() => {
                onApplySwitch(preview.applied.design, targetProvider, preview.targetRegion);
                onClose();
              }}
            >
              Apply switch to {targetProvider.toUpperCase()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
