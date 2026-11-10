'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Globe2, RefreshCw } from 'lucide-react';
import type { CloudTargetProvider } from '@infrasim/catalog';
import {
  compareProvidersCost,
  compareRegionsCost,
  CURATED_REGION_MAP,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import type {
  CostAssumptions,
  CustomServiceDefinition,
  Design,
  SimulationResult,
} from '@infrasim/shared-types';
import { formatMoney } from '../../lib/costFormat';

export interface CostComparisonViewProps {
  design: Design;
  result: SimulationResult | null;
  assumptions: CostAssumptions;
  snapshot: PriceSnapshot | null;
  defaultRegion: string;
  customServices: CustomServiceDefinition[];
  onSwitchProviderClick: (targetProvider: CloudTargetProvider) => void;
  onSelectRegion: (regionCode: string) => void;
  onSyncAllCloudsPrices?: () => void;
  snapshotLoading?: boolean;
}

function formatDeltaBadge(delta: number | null): { text: string; toneClass: string } {
  if (delta === null || !Number.isFinite(delta)) {
    return { text: 'baseline', toneClass: 'text-[var(--text-muted)]' };
  }
  const sign = delta > 0 ? '+' : '';
  const text = `${sign}${delta.toFixed(1)}%`;
  if (delta <= -3) return { text, toneClass: 'text-[var(--status-ok)]' };
  if (delta >= 5) return { text, toneClass: 'text-[var(--status-warm)]' };
  return { text, toneClass: 'text-[var(--text-secondary)]' };
}

/** Side-by-side multi-cloud and regional cost comparison tables inside the Cost dock. */
export function CostComparisonView({
  design,
  result,
  assumptions,
  snapshot,
  defaultRegion,
  customServices,
  onSwitchProviderClick,
  onSelectRegion,
  onSyncAllCloudsPrices,
  snapshotLoading = false,
}: CostComparisonViewProps) {
  const [section, setSection] = useState<'providers' | 'regions'>('providers');

  const providerComparison = useMemo(
    () =>
      compareProvidersCost(design, result, snapshot, assumptions, ['aws', 'gcp', 'azure', 'oci'], {
        defaultRegion,
        customServices,
      }),
    [design, result, snapshot, assumptions, defaultRegion, customServices],
  );

  const regionComparison = useMemo(
    () =>
      compareRegionsCost(
        design,
        result,
        snapshot,
        assumptions,
        CURATED_REGION_MAP.map((r) => r.key),
        {
          defaultRegion,
          customServices,
        },
      ),
    [design, result, snapshot, assumptions, defaultRegion, customServices],
  );

  const currency = providerComparison.currency || assumptions.currency;

  return (
    <div data-testid="cost-comparison-view" className="space-y-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-0.5">
          <button
            type="button"
            data-testid="compare-mode-providers"
            onClick={() => setSection('providers')}
            className={`inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
              section === 'providers'
                ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <ArrowLeftRight className="h-3 w-3" strokeWidth={1.5} />
            <span>Compare clouds</span>
          </button>
          <button
            type="button"
            data-testid="compare-mode-regions"
            onClick={() => setSection('regions')}
            className={`inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
              section === 'regions'
                ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <Globe2 className="h-3 w-3" strokeWidth={1.5} />
            <span>Compare regions ({regionComparison.provider.toUpperCase()})</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)]">
            {section === 'providers'
              ? 'Approximate mapping · No re-simulation required'
              : `Regional SKU delta & latency impact vs ${regionComparison.currentRegion}`}
          </span>
          {onSyncAllCloudsPrices ? (
            <button
              type="button"
              data-testid="compare-sync-all-btn"
              onClick={onSyncAllCloudsPrices}
              disabled={snapshotLoading}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
              <span>Sync all clouds</span>
            </button>
          ) : null}
        </div>
      </div>

      {section === 'providers' ? (
        <div className="space-y-2.5">
          <div className="overflow-x-auto rounded-[8px] border border-[var(--border-hairline)]">
            <table className="w-full text-left font-mono text-[11px] tabular-nums">
              <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-muted)]">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Cloud</th>
                  <th className="px-2.5 py-1.5 font-medium">Region</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Monthly</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Delta</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Unavailable</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {providerComparison.items.map((item) => {
                  const delta = item.isCurrent
                    ? { text: 'current', toneClass: 'text-[var(--accent)]' }
                    : formatDeltaBadge(item.deltaPercent);
                  return (
                    <tr key={item.provider} data-testid={`compare-provider-row-${item.provider}`}>
                      <td className="px-2.5 py-1.5 font-sans font-medium text-[var(--text-primary)]">
                        {item.providerLabel}
                        {item.unmappedCount > 0 ? (
                          <span
                            title={item.unmappedServices.join(', ')}
                            className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-normal text-[var(--status-warm)]"
                          >
                            <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
                            {item.unmappedCount} unmapped
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2.5 py-1.5 text-[10px] text-[var(--text-secondary)]">
                        {item.targetRegion}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-medium text-[var(--text-primary)]">
                        {item.unavailableCount > 0 && item.monthlyTotal === 0
                          ? 'Price unavailable'
                          : formatMoney(item.monthlyTotal, currency)}
                      </td>
                      <td className={`px-2.5 py-1.5 text-right text-[10px] ${delta.toneClass}`}>
                        {delta.text}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-[10px] text-[var(--text-muted)]">
                        {item.unavailableCount}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-sans">
                        {item.isCurrent ? (
                          <span className="text-[10px] text-[var(--text-muted)]">Active</span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`compare-switch-btn-${item.provider}`}
                            onClick={() => onSwitchProviderClick(item.provider)}
                            className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                          >
                            Diff & switch
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {providerComparison.items.some((i) => !i.isCurrent && i.behaviorSummary.length > 0) ? (
            <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[10px] text-[var(--text-muted)]">
              {providerComparison.items
                .filter((i) => !i.isCurrent && i.behaviorSummary.length > 0)
                .slice(0, 2)
                .map((i) => (
                  <div key={i.provider} className="leading-relaxed">
                    <span className="font-medium text-[var(--text-secondary)]">
                      {i.provider.toUpperCase()}:
                    </span>{' '}
                    {i.behaviorSummary[0]}
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[8px] border border-[var(--border-hairline)]">
          <table className="w-full text-left font-mono text-[11px] tabular-nums">
            <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-muted)]">
              <tr>
                <th className="px-2.5 py-1.5 font-medium">Region</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Monthly</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Delta</th>
                <th className="px-2.5 py-1.5 font-medium">Latency & availability</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Use</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-hairline)]">
              {regionComparison.items.map((item) => {
                const delta = item.isCurrent
                  ? { text: 'current', toneClass: 'text-[var(--accent)]' }
                  : formatDeltaBadge(item.deltaPercent);
                return (
                  <tr key={item.regionCode} data-testid={`compare-region-row-${item.regionCode}`}>
                    <td className="px-2.5 py-1.5">
                      <div className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                        {item.regionCode}
                      </div>
                      <div className="font-sans text-[10px] text-[var(--text-muted)]">
                        {item.regionLabel}
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-medium text-[var(--text-primary)]">
                      {item.unavailableCount > 0 && item.monthlyTotal === 0
                        ? 'Price unavailable'
                        : formatMoney(item.monthlyTotal, currency)}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right text-[10px] ${delta.toneClass}`}>
                      {delta.text}
                    </td>
                    <td className="max-w-[260px] px-2.5 py-1.5 font-sans text-[10px] text-[var(--text-secondary)]">
                      <div>{item.latencyNote}</div>
                      {item.missingServices.length > 0 ? (
                        <div className="text-[var(--status-warm)]">
                          Unavailable here: {item.missingServices.slice(0, 2).join(', ')}
                          {item.missingServices.length > 2
                            ? ` +${item.missingServices.length - 2}`
                            : ''}
                        </div>
                      ) : item.regionNote ? (
                        <div className="text-[var(--text-muted)]">{item.regionNote}</div>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-sans">
                      {item.isCurrent ? (
                        <span className="text-[10px] text-[var(--text-muted)]">Active</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSelectRegion(item.regionCode)}
                          className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                        >
                          Switch
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
