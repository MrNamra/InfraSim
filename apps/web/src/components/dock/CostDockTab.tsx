'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Download,
  FileText,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import type { CloudTargetProvider } from '@infrasim/catalog';
import {
  estimateWhatIfCost,
  exportCostCsv,
  exportCostMarkdown,
  getTopCostDrivers,
  type CostBreakdownMeta,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import type {
  CostAssumptions,
  CostReport,
  CustomServiceDefinition,
  Design,
  SimulationResult,
} from '@infrasim/shared-types';
import { formatMoney, formatSnapshotAge, formatUnitPrice } from '../../lib/costFormat';
import { CostComparisonView } from './CostComparisonView';
import { CostSweepView } from './CostSweepView';

export interface CostDockTabProps {
  design: Design;
  result: SimulationResult | null;
  report: CostReport;
  breakdownMeta: CostBreakdownMeta;
  assumptions: CostAssumptions;
  snapshot: PriceSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  lastFetchedAt: string | null;
  isOfflineFallback: boolean;
  defaultRegion?: string;
  selectedNodeId?: string | null;
  customServices?: CustomServiceDefinition[];
  onRefreshPrices: () => void;
  onSyncAllCloudsPrices?: () => void;
  onSelectNode: (nodeId: string) => void;
  onSelectRegion?: (regionCode: string) => void;
  onOpenAssumptions: () => void;
  onOpenProviderSwitch?: (targetProvider?: CloudTargetProvider) => void;
  onApplyPatchedDesign?: (nextDesign: Design, changeLabel: string) => void;
}

type SortKey = 'subtotal' | 'label' | 'provider';

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Bottom dock Cost breakdown panel with top-3 drivers, category/provider split, transfer table, and what-if sliders. */
export function CostDockTab({
  design,
  result,
  report,
  breakdownMeta,
  assumptions,
  snapshot,
  snapshotLoading,
  snapshotError,
  lastFetchedAt,
  isOfflineFallback,
  defaultRegion = 'us-east-1',
  selectedNodeId = null,
  customServices = [],
  onRefreshPrices,
  onSyncAllCloudsPrices,
  onSelectNode,
  onSelectRegion,
  onOpenAssumptions,
  onOpenProviderSwitch,
  onApplyPatchedDesign,
}: CostDockTabProps) {
  const [sortKey, setSortKey] = useState<SortKey>('subtotal');
  const [sortDesc, setSortDesc] = useState(true);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [rpsMultiplier, setRpsMultiplier] = useState(1);
  const [instanceScale, setInstanceScale] = useState(1);
  const [activeSubView, setActiveSubView] = useState<
    'breakdown' | 'transfer' | 'compare' | 'sweep'
  >('breakdown');

  const currency = report.currency || assumptions.currency;
  const fxRate =
    currency !== 'USD' && assumptions.fxRateToUSD && assumptions.fxRateToUSD > 0
      ? assumptions.fxRateToUSD
      : null;

  const topDrivers = useMemo(() => getTopCostDrivers(report, design, 3), [report, design]);

  const whatIfOverrides = useMemo(() => {
    if (instanceScale === 1) return undefined;
    const overrides: Record<string, number> = {};
    for (const n of design.nodes) {
      if (n.config.instances > 0 && n.serviceId !== 'generic.client') {
        overrides[n.id] = Math.max(1, Math.round(n.config.instances * instanceScale));
      }
    }
    return overrides;
  }, [design.nodes, instanceScale]);

  const whatIfResult = useMemo(
    () =>
      estimateWhatIfCost(report, design, result, {
        rpsMultiplier,
        instanceOverrides: whatIfOverrides,
      }),
    [report, design, result, rpsMultiplier, whatIfOverrides],
  );

  const nodeRows = useMemo(() => {
    const items = design.nodes.map((node) => {
      const entry = report.perNode[node.id] ?? { lines: [], subtotal: 0 };
      const provider = node.serviceId.split('.')[0] ?? 'generic';
      const hasUnavailable = entry.lines.some((l) => l.source === 'unavailable');
      const primarySource =
        entry.lines.find((l) => l.source === 'manual')?.source ??
        entry.lines.find((l) => l.source === 'synced')?.source ??
        entry.lines[0]?.source ??
        'unavailable';
      return {
        node,
        provider,
        lines: entry.lines,
        subtotal: entry.subtotal,
        hasUnavailable,
        primarySource,
      };
    });

    items.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'subtotal') {
        cmp = a.subtotal - b.subtotal;
      } else if (sortKey === 'provider') {
        cmp = a.provider.localeCompare(b.provider);
      } else {
        cmp = a.node.label.localeCompare(b.node.label);
      }
      return sortDesc ? -cmp : cmp;
    });
    return items;
  }, [design.nodes, report.perNode, sortKey, sortDesc]);

  const categoryEntries = Object.entries(report.byCategory).filter(([, val]) => val > 0);
  const providerEntries = Object.entries(breakdownMeta.byProvider).filter(([, val]) => val > 0);
  const effectiveAgeIso = snapshot?.generatedAt ?? lastFetchedAt;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(key === 'subtotal');
    }
  };

  return (
    <div data-testid="cost-dock-tab" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Top summary strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Monthly total</span>
            <span
              data-testid="dock-cost-total"
              title={
                fxRate
                  ? `Original USD estimate: ${formatMoney(breakdownMeta.usdMonthlyTotal, 'USD')}/mo`
                  : undefined
              }
              className="font-mono text-[13px] font-medium tabular-nums text-[var(--text-primary)]"
            >
              {formatMoney(report.monthlyTotal, currency)}/mo
            </span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Per 1M req</span>
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">
              {formatMoney(report.costPerMillionRequests, currency)}
            </span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Transfer</span>
            <span className="font-mono tabular-nums text-[var(--text-secondary)]">
              {formatMoney(breakdownMeta.transferTotal, currency)}/mo
            </span>
          </div>

          <button
            type="button"
            onClick={onOpenAssumptions}
            className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {assumptions.hoursPerMonth}h · {assumptions.instanceCountMode} ·{' '}
            {assumptions.traffic.mode} · {currency}
          </button>

          <span className="text-[10px] text-[var(--text-muted)]">On-demand list prices only</span>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="cost-snapshot-age"
            className="font-mono text-[10px] text-[var(--text-muted)]"
            title={snapshotError ?? undefined}
          >
            {snapshotLoading
              ? 'Syncing prices'
              : effectiveAgeIso
                ? `Snapshot ${formatSnapshotAge(effectiveAgeIso)}${isOfflineFallback ? ' (cached)' : ''}`
                : 'No price snapshot'}
          </span>

          <button
            type="button"
            data-testid="cost-refresh-btn"
            onClick={onRefreshPrices}
            disabled={snapshotLoading}
            title="Refresh synced price snapshot"
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
            <span>Refresh</span>
          </button>

          {onOpenProviderSwitch ? (
            <button
              type="button"
              data-testid="cost-switch-provider-btn"
              onClick={() => onOpenProviderSwitch()}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeftRight className="h-3 w-3" strokeWidth={1.5} />
              <span>Switch cloud</span>
            </button>
          ) : null}

          <button
            type="button"
            data-testid="cost-export-csv-btn"
            onClick={() =>
              triggerDownload(
                `${design.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'infrasim'}-cost.csv`,
                exportCostCsv(report, design),
                'text/csv;charset=utf-8',
              )
            }
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Download className="h-3 w-3" strokeWidth={1.5} />
            <span>CSV</span>
          </button>

          <button
            type="button"
            data-testid="cost-export-md-btn"
            onClick={() =>
              triggerDownload(
                `${design.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'infrasim'}-cost.md`,
                exportCostMarkdown(report, design),
                'text/markdown;charset=utf-8',
              )
            }
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <FileText className="h-3 w-3" strokeWidth={1.5} />
            <span>Markdown</span>
          </button>
        </div>
      </div>

      {/* Main split */}
      <div className="flex min-h-0 flex-1 divide-x divide-[var(--border-hairline)]">
        {/* Left: Top drivers + Categories + What-if */}
        <div className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto p-3 text-[11px]">
          {report.warnings.length > 0 ? (
            <div
              data-testid="cost-warnings-banner"
              className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5 font-medium text-[var(--status-warm)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                <span>{report.warnings.length} pricing notice(s)</span>
              </div>
              <ul className="mt-1 space-y-1 text-[10px] text-[var(--text-secondary)]">
                {report.warnings.slice(0, 3).map((w, idx) => (
                  <li key={idx} className="leading-snug">
                    {w}
                  </li>
                ))}
                {report.warnings.length > 3 ? (
                  <li className="text-[var(--text-muted)]">
                    +{report.warnings.length - 3} more notice(s)
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {/* Top 3 cost drivers */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-medium text-[var(--text-secondary)]">Top cost drivers</span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">% of total</span>
            </div>
            {topDrivers.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">No billable cost drivers yet</p>
            ) : (
              <div className="space-y-2">
                {topDrivers.map((d, idx) => (
                  <button
                    key={`${d.label}-${idx}`}
                    type="button"
                    disabled={!d.nodeId}
                    onClick={() => {
                      if (d.nodeId) onSelectNode(d.nodeId);
                    }}
                    className="block w-full text-left disabled:cursor-default"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {d.label} ·{' '}
                        <span className="font-normal text-[var(--text-muted)]">{d.dimension}</span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-[var(--text-secondary)]">
                        {formatMoney(d.amount, currency)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${Math.min(100, Math.max(4, d.percentOfTotal))}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                        {d.percentOfTotal.toFixed(0)}%
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* By category & provider */}
          {categoryEntries.length > 0 || providerEntries.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 border-t border-[var(--border-hairline)] pt-2.5">
              <div>
                <div className="mb-1 text-[10px] font-medium text-[var(--text-muted)]">
                  By category
                </div>
                <div className="space-y-1 font-mono text-[10px] tabular-nums">
                  {categoryEntries.map(([cat, amt]) => (
                    <div key={cat} className="flex items-center justify-between gap-2">
                      <span className="capitalize text-[var(--text-secondary)]">{cat}</span>
                      <span className="text-[var(--text-primary)]">
                        {formatMoney(amt, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-medium text-[var(--text-muted)]">
                  By provider
                </div>
                <div className="space-y-1 font-mono text-[10px] tabular-nums">
                  {providerEntries.map(([prov, amt]) => (
                    <div key={prov} className="flex items-center justify-between gap-2">
                      <span className="uppercase text-[var(--text-secondary)]">{prov}</span>
                      <span className="text-[var(--text-primary)]">
                        {formatMoney(amt, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* Instant what-if sliders */}
          <div className="border-t border-[var(--border-hairline)] pt-2.5">
            <button
              type="button"
              data-testid="cost-whatif-toggle"
              onClick={() => setShowWhatIf((prev) => !prev)}
              className="flex w-full items-center justify-between text-left font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <span className="inline-flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>What-if estimator</span>
              </span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {showWhatIf ? 'Hide' : 'Open'}
              </span>
            </button>

            {showWhatIf ? (
              <div
                data-testid="cost-whatif-panel"
                className="mt-2 space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5"
              >
                <label className="block">
                  <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
                    <span>Traffic multiplier</span>
                    <span className="font-mono tabular-nums text-[var(--text-primary)]">
                      {rpsMultiplier.toFixed(1)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={5}
                    step={0.2}
                    value={rpsMultiplier}
                    onChange={(e) => setRpsMultiplier(Number(e.target.value))}
                    className="mt-1 h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                  />
                </label>

                <label className="block">
                  <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
                    <span>Instance count scale</span>
                    <span className="font-mono tabular-nums text-[var(--text-primary)]">
                      {instanceScale.toFixed(1)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={0.5}
                    value={instanceScale}
                    onChange={(e) => setInstanceScale(Number(e.target.value))}
                    className="mt-1 h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                  />
                </label>

                <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-2">
                  <span className="text-[10px] text-[var(--status-warm)]">
                    Estimate until re-run
                  </span>
                  <span
                    data-testid="cost-whatif-total"
                    className="font-mono text-[12px] font-medium tabular-nums text-[var(--text-primary)]"
                  >
                    {formatMoney(whatIfResult.monthlyTotal, currency)}/mo
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: Sub-tabs for Per-node table, Transfer lines, Comparison */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-1 border-b border-[var(--border-hairline)] px-3 py-1.5">
            <button
              type="button"
              onClick={() => setActiveSubView('breakdown')}
              className={`h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
                activeSubView === 'breakdown'
                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Per-node ({nodeRows.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSubView('transfer')}
              className={`h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
                activeSubView === 'transfer'
                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Data transfer ({report.transfer.length})
            </button>
            <button
              type="button"
              data-testid="cost-subtab-compare"
              onClick={() => setActiveSubView('compare')}
              className={`h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
                activeSubView === 'compare'
                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Compare clouds & regions
            </button>
            <button
              type="button"
              data-testid="cost-subtab-sweep"
              onClick={() => setActiveSubView('sweep')}
              className={`h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
                activeSubView === 'sweep'
                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Cost vs latency sweep
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {activeSubView === 'breakdown' ? (
              <table className="w-full text-left font-mono text-[11px] tabular-nums">
                <thead>
                  <tr className="border-b border-[var(--border-hairline)] text-[var(--text-muted)]">
                    <th className="py-1 font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort('label')}
                        className="hover:text-[var(--text-primary)]"
                      >
                        Service node
                      </button>
                    </th>
                    <th className="py-1 font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort('provider')}
                        className="hover:text-[var(--text-primary)]"
                      >
                        Cloud
                      </button>
                    </th>
                    <th className="py-1 font-medium">Dimensions</th>
                    <th className="py-1 text-right font-medium">Source</th>
                    <th className="py-1 text-right font-medium">
                      <button
                        type="button"
                        onClick={() => toggleSort('subtotal')}
                        className="hover:text-[var(--text-primary)]"
                      >
                        Monthly
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-hairline)]">
                  {nodeRows.map(
                    ({ node, provider, lines, subtotal, hasUnavailable, primarySource }) => (
                      <tr
                        key={node.id}
                        onClick={() => onSelectNode(node.id)}
                        className="cursor-pointer hover:bg-[var(--bg-raised)]"
                      >
                        <td className="max-w-[160px] truncate py-1.5 font-sans text-[12px] font-medium text-[var(--text-primary)]">
                          {node.label}
                        </td>
                        <td className="py-1.5 uppercase text-[var(--text-muted)]">{provider}</td>
                        <td className="max-w-[260px] truncate py-1.5 font-sans text-[11px] text-[var(--text-secondary)]">
                          {lines.length > 0
                            ? lines.map((l) => l.dimension).join(' + ')
                            : 'Free / non-billable'}
                        </td>
                        <td className="py-1.5 text-right text-[10px] text-[var(--text-muted)]">
                          {hasUnavailable ? 'unavailable' : primarySource}
                        </td>
                        <td
                          className={`py-1.5 text-right font-medium ${
                            hasUnavailable && subtotal === 0
                              ? 'text-[var(--text-muted)]'
                              : 'text-[var(--text-primary)]'
                          }`}
                        >
                          {hasUnavailable && subtotal === 0
                            ? 'Price unavailable'
                            : formatMoney(subtotal, currency)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            ) : activeSubView === 'transfer' ? (
              report.transfer.length === 0 ? (
                <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-[var(--text-muted)]">
                  Run a simulation with connected edges to inspect internet egress, inter-AZ,
                  inter-region, and NAT processing transfer lines. Same-AZ transfer is free.
                </div>
              ) : (
                <table className="w-full text-left font-mono text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border-hairline)] text-[var(--text-muted)]">
                      <th className="py-1 font-medium">Category</th>
                      <th className="py-1 text-right font-medium">Volume</th>
                      <th className="py-1 text-right font-medium">Unit price</th>
                      <th className="py-1 font-medium pl-3">Note</th>
                      <th className="py-1 text-right font-medium">Monthly</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {report.transfer.map((line, idx) => (
                      <tr key={`${line.dimension}-${idx}`}>
                        <td className="py-1.5 font-sans text-[12px] text-[var(--text-primary)]">
                          {line.dimension}
                        </td>
                        <td className="py-1.5 text-right text-[var(--text-secondary)]">
                          {line.quantity.toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                          {line.unit}
                        </td>
                        <td className="py-1.5 text-right text-[var(--text-secondary)]">
                          {formatUnitPrice(line.unitPrice, currency)}
                        </td>
                        <td className="max-w-[200px] truncate py-1.5 pl-3 font-sans text-[11px] text-[var(--text-muted)]">
                          {line.note ?? ''}
                        </td>
                        <td className="py-1.5 text-right font-medium text-[var(--text-primary)]">
                          {line.amount !== null
                            ? formatMoney(line.amount, currency)
                            : 'Price unavailable'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : activeSubView === 'compare' ? (
              <CostComparisonView
                design={design}
                result={result}
                assumptions={assumptions}
                snapshot={snapshot}
                defaultRegion={defaultRegion}
                customServices={customServices}
                snapshotLoading={snapshotLoading}
                onSyncAllCloudsPrices={onSyncAllCloudsPrices}
                onSwitchProviderClick={(prov) => onOpenProviderSwitch?.(prov)}
                onSelectRegion={(reg) => onSelectRegion?.(reg)}
              />
            ) : (
              <CostSweepView
                design={design}
                result={result}
                assumptions={assumptions}
                snapshot={snapshot}
                selectedNodeId={selectedNodeId}
                onApplyPatchedDesign={onApplyPatchedDesign}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
