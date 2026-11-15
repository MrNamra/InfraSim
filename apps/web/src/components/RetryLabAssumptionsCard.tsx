'use client';

import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Play,
  RotateCcw,
  Sliders,
  X,
  XCircle,
} from 'lucide-react';
import { runSimulation } from '@infrasim/sim-engine';
import type { Design, SimulationResult, TimeSeriesBucket } from '@infrasim/shared-types';
import {
  buildRetryAmplificationLabDesign,
  RETRY_LAB_VARIANTS,
  type RetryLabVariant,
  type RetryLabVariantId,
} from '../lib/templates';
import { downsampleLttb } from '../lib/lttb';

export interface RetryLabAssumptionsCardProps {
  design: Design;
  onUpdateDesign: (design: Design) => void;
  onClose?: () => void;
}

interface VariantSummaryRow {
  variant: RetryLabVariant;
  peakAmplification: number;
  minGoodputRps: number;
  peakQueueDepth: number;
  faultP95Ms: number;
  faultErrorRatePct: number;
  recoveryTimeS: number | null;
}

const VARIANT_COLORS: Record<RetryLabVariantId, string> = {
  A: '#f43f5e', // Baseline - Rose red
  B: '#f97316', // Bounded + Jitter - Orange
  C: '#eab308', // Circuit Breaker - Amber
  D: '#0ea5e9', // Load Shedding - Sky blue
  E: '#10b981', // Comprehensive - Emerald
};

function computeFaultWindowMetrics(
  buckets: readonly TimeSeriesBucket[],
  fromS: number,
  toS: number,
): { faultP95Ms: number; faultErrorRatePct: number } {
  const faultBuckets = buckets.filter((b) => b.tS >= fromS && b.tS <= toS);
  if (faultBuckets.length === 0) {
    return { faultP95Ms: 0, faultErrorRatePct: 0 };
  }
  let maxP95 = 0;
  let totalArrivals = 0;
  let totalErrors = 0;
  for (const b of faultBuckets) {
    if (b.p95 > maxP95) maxP95 = b.p95;
    const arrivals = Math.max(1, b.offeredRps ?? b.rpsIn);
    totalArrivals += arrivals;
    totalErrors += (b.errorRate ?? 0) * arrivals;
  }
  const faultErrorRatePct = totalArrivals > 0 ? (totalErrors / totalArrivals) * 100 : 0;
  return { faultP95Ms: maxP95, faultErrorRatePct };
}

export function RetryLabAssumptionsCard({
  design,
  onUpdateDesign,
  onClose,
}: RetryLabAssumptionsCardProps) {
  const [activeVariantId, setActiveVariantId] = useState<RetryLabVariantId>('A');
  const [collapsed, setCollapsed] = useState(false);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [variantResults, setVariantResults] = useState<
    Record<RetryLabVariantId, SimulationResult | null>
  >({
    A: null,
    B: null,
    C: null,
    D: null,
    E: null,
  });
  const [overlayMetric, setOverlayMetric] = useState<'goodput' | 'amplification' | 'queue'>(
    'goodput',
  );

  // Extract explicit assumptions from current design
  const clientNode = design.nodes.find((n) => n.id === 'client');
  const apiNode = design.nodes.find((n) => n.id === 'api');
  const dbNode = design.nodes.find((n) => n.id === 'db');
  const scenario = design.scenarios[0];
  const chaosEvent = scenario?.chaos.find(
    (c): c is Extract<import('@infrasim/shared-types').ChaosEvent, { kind: 'add-latency' }> =>
      c.kind === 'add-latency' && c.nodeId === 'db',
  );

  const loadRps = scenario?.profile.kind === 'constant' ? scenario.profile.rps : 300;
  const durationS = scenario?.durationS ?? 180;
  const seed = scenario?.seedOverride ?? design.settings.seed ?? 42;
  const clientTimeoutMs = clientNode?.config.timeoutMs ?? 1000;
  const apiInstances = apiNode?.config.instances ?? 3;
  const dbConnPool = dbNode?.config.connections?.max ?? 100;
  const dbLatencyNormalMs = dbNode?.config.latency?.p50 ?? 20;
  const dbExtraMs = chaosEvent?.extraMs ?? 780;
  const dbLatencyFaultMs = dbLatencyNormalMs + dbExtraMs;
  const faultStartS = chaosEvent?.atS ?? 30;
  const faultDurationS = chaosEvent?.durationS ?? 60;
  const faultEndS = faultStartS + faultDurationS;

  const handleApplyVariant = (variantId: RetryLabVariantId) => {
    setActiveVariantId(variantId);
    const variant = RETRY_LAB_VARIANTS.find((v) => v.id === variantId);
    if (!variant) return;
    const updated = variant.apply(design);
    onUpdateDesign(updated);
  };

  const handleResetDefaults = () => {
    const defaultDesign = buildRetryAmplificationLabDesign();
    setActiveVariantId('A');
    onUpdateDesign(defaultDesign);
    setVariantResults({ A: null, B: null, C: null, D: null, E: null });
  };

  const handleRunAllVariants = async () => {
    setIsRunningAll(true);
    try {
      const results: Record<RetryLabVariantId, SimulationResult> = {} as any;
      for (const v of RETRY_LAB_VARIANTS) {
        const vDesign = v.apply(design);
        vDesign.settings.seed = seed;
        const scenId = vDesign.scenarios[0]?.id ?? 'sc-retry-lab';
        if (vDesign.scenarios[0]) {
          vDesign.scenarios[0].seedOverride = seed;
        }
        const res = await runSimulation(
          {
            design: vDesign,
            scenarioId: scenId,
          },
          () => {},
        );
        results[v.id] = res;
      }
      setVariantResults(results);
    } finally {
      setIsRunningAll(false);
    }
  };

  // Build comparison rows
  const comparisonRows = useMemo<VariantSummaryRow[]>(() => {
    return RETRY_LAB_VARIANTS.map((v) => {
      const res = variantResults[v.id];
      if (!res) {
        return {
          variant: v,
          peakAmplification: 1,
          minGoodputRps: loadRps,
          peakQueueDepth: 0,
          faultP95Ms: dbLatencyNormalMs,
          faultErrorRatePct: 0,
          recoveryTimeS: 0,
        };
      }
      const { faultP95Ms, faultErrorRatePct } = computeFaultWindowMetrics(
        res.series.buckets,
        faultStartS,
        faultEndS,
      );
      return {
        variant: v,
        peakAmplification: res.summary.peakAmplification ?? 1,
        minGoodputRps: res.summary.minGoodputRps ?? 0,
        peakQueueDepth: res.summary.peakQueueDepth ?? 0,
        faultP95Ms,
        faultErrorRatePct,
        recoveryTimeS: res.summary.recoveryTimeS ?? null,
      };
    });
  }, [
    variantResults,
    loadRps,
    dbLatencyNormalMs,
    faultStartS,
    faultEndS,
  ]);

  const hasAnyResults = Boolean(variantResults.A);

  // Overlay chart lines
  const overlayLines = useMemo(() => {
    if (!hasAnyResults) return [];
    return RETRY_LAB_VARIANTS.map((v) => {
      const res = variantResults[v.id];
      if (!res) return { id: v.id, label: v.shortLabel, color: VARIANT_COLORS[v.id], points: [] };
      const points = res.series.buckets.map((b) => {
        let val = 0;
        if (overlayMetric === 'goodput') val = b.goodputRps ?? b.throughputRps;
        else if (overlayMetric === 'amplification') val = b.amplification ?? 1;
        else val = b.queueDepth ?? 0;
        return { x: b.tS, y: val };
      });
      return {
        id: v.id,
        label: v.shortLabel,
        color: VARIANT_COLORS[v.id],
        points: downsampleLttb(points, 200),
      };
    });
  }, [hasAnyResults, variantResults, overlayMetric]);

  const chartMaxY = useMemo(() => {
    let max = overlayMetric === 'amplification' ? 3 : loadRps;
    for (const l of overlayLines) {
      for (const p of l.points) {
        if (p.y > max) max = p.y;
      }
    }
    return max * 1.1;
  }, [overlayLines, overlayMetric, loadRps]);

  const svgWidth = 640;
  const svgHeight = 110;
  const padX = 8;
  const padY = 8;
  const plotW = svgWidth - padX * 2;
  const plotH = svgHeight - padY * 2;

  return (
    <div
      data-testid="retry-lab-assumptions-card"
      className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3 text-[12px] shadow-sm"
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.1)] text-[var(--status-overloaded)]">
            <FlaskConical className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                Retry Amplification Lab
              </h2>
              <span className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 py-0.2 font-mono text-[10px] text-[var(--text-secondary)]">
                Fixed seed: {seed}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              Downstream database slowdown triggers client timeouts and cascading retry
              amplification.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="run-all-variants-btn"
            onClick={handleRunAllVariants}
            disabled={isRunningAll}
            className="inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-[var(--accent-solid)] px-3 text-[11px] font-medium text-[var(--accent-solid-text)] transition-colors hover:opacity-90 disabled:opacity-50"
          >
            <Play className="h-3 w-3 fill-current" />
            <span>{isRunningAll ? 'Running all...' : 'Run all variants'}</span>
          </button>

          <button
            type="button"
            title="Reset to original lab assumptions"
            onClick={handleResetDefaults}
            className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-[var(--border-hairline)] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>

          <button
            type="button"
            title={collapsed ? 'Expand lab details' : 'Collapse lab details'}
            onClick={() => setCollapsed(!collapsed)}
            className="flex h-7 w-7 items-center justify-center rounded-[5px] border border-[var(--border-hairline)] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            {collapsed ? (
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </button>

          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          ) : null}
        </div>
      </div>

      {!collapsed && (
        <div className="mt-3 space-y-3">
          {/* Explicit Editable Assumptions Row */}
          <div className="grid grid-cols-2 gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5 sm:grid-cols-4 md:grid-cols-7">
            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">Client Load</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="Client load RPS"
                  min={10}
                  step={50}
                  value={loadRps}
                  onChange={(e) => {
                    const rps = Math.max(1, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    if (copy.scenarios[0]) {
                      copy.scenarios[0].profile = { kind: 'constant', rps };
                      onUpdateDesign(copy);
                    }
                  }}
                  className="w-14 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>RPS</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">Duration</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="Simulation duration seconds"
                  min={30}
                  step={30}
                  value={durationS}
                  onChange={(e) => {
                    const dur = Math.max(10, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    if (copy.scenarios[0]) {
                      copy.scenarios[0].durationS = dur;
                      onUpdateDesign(copy);
                    }
                  }}
                  className="w-14 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>s</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">Client Timeout</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="Client timeout milliseconds"
                  min={100}
                  step={100}
                  value={clientTimeoutMs}
                  onChange={(e) => {
                    const timeoutMs = Math.max(10, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    const c = copy.nodes.find((n) => n.id === 'client');
                    if (c) c.config.timeoutMs = timeoutMs;
                    const a = copy.nodes.find((n) => n.id === 'api');
                    if (a) a.config.timeoutMs = timeoutMs;
                    onUpdateDesign(copy);
                  }}
                  className="w-14 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>ms</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">API Capacity</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="API instances"
                  min={1}
                  max={20}
                  value={apiInstances}
                  onChange={(e) => {
                    const instances = Math.max(1, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    const a = copy.nodes.find((n) => n.id === 'api');
                    if (a) a.config.instances = instances;
                    onUpdateDesign(copy);
                  }}
                  className="w-10 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>inst (~30% util)</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">DB Pool</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="Database connection pool"
                  min={10}
                  step={10}
                  value={dbConnPool}
                  onChange={(e) => {
                    const max = Math.max(1, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    const d = copy.nodes.find((n) => n.id === 'db');
                    if (d) {
                      if (!d.config.connections) d.config.connections = { max };
                      else d.config.connections.max = max;
                    }
                    onUpdateDesign(copy);
                  }}
                  className="w-12 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>conns</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">DB Normal</span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                <input
                  type="number"
                  aria-label="DB normal latency ms"
                  min={1}
                  step={5}
                  value={dbLatencyNormalMs}
                  onChange={(e) => {
                    const p50 = Math.max(1, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    const d = copy.nodes.find((n) => n.id === 'db');
                    if (d) {
                      d.config.latency = { distribution: 'fixed', p50, p95: p50 };
                    }
                    onUpdateDesign(copy);
                  }}
                  className="w-12 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums"
                />
                <span>ms</span>
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-[var(--text-muted)]">
                DB Fault ({faultStartS}s–{faultEndS}s)
              </span>
              <div className="flex items-center gap-1 font-mono text-[11px] font-medium text-[var(--status-overloaded)]">
                <input
                  type="number"
                  aria-label="DB fault latency ms"
                  min={50}
                  step={50}
                  value={dbLatencyFaultMs}
                  onChange={(e) => {
                    const totalFault = Math.max(dbLatencyNormalMs + 1, Number(e.target.value));
                    const copy = JSON.parse(JSON.stringify(design)) as Design;
                    const ch = copy.scenarios[0]?.chaos.find(
                      (c): c is Extract<import('@infrasim/shared-types').ChaosEvent, { kind: 'add-latency' }> =>
                        c.kind === 'add-latency' && c.nodeId === 'db',
                    );
                    if (ch) {
                      ch.extraMs = totalFault - dbLatencyNormalMs;
                    }
                    onUpdateDesign(copy);
                  }}
                  className="w-14 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-0.5 text-center font-mono tabular-nums text-[var(--status-overloaded)]"
                />
                <span>ms</span>
              </div>
            </div>
          </div>

          {/* Variants Selector */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Active variant:
            </span>
            {RETRY_LAB_VARIANTS.map((v) => {
              const active = activeVariantId === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  data-testid={`variant-btn-${v.id}`}
                  onClick={() => handleApplyVariant(v.id)}
                  className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)] shadow-sm'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: VARIANT_COLORS[v.id] }}
                  />
                  <span>{v.shortLabel}</span>
                </button>
              );
            })}
          </div>

          {/* Multi-Variant Comparison Table & Overlay Chart */}
          {hasAnyResults && (
            <div className="space-y-3 pt-1">
              <div className="overflow-x-auto rounded-[8px] border border-[var(--border-hairline)]">
                <table
                  data-testid="variants-comparison-table"
                  className="w-full text-left font-mono text-[11px] tabular-nums"
                >
                  <thead>
                    <tr className="border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-muted)]">
                      <th className="px-3 py-1.5 font-medium">Variant</th>
                      <th className="px-2 py-1.5 text-right font-medium">Peak Amp</th>
                      <th className="px-2 py-1.5 text-right font-medium">Min Goodput</th>
                      <th className="px-2 py-1.5 text-right font-medium">Peak Queue</th>
                      <th className="px-2 py-1.5 text-right font-medium">Fault p95</th>
                      <th className="px-2 py-1.5 text-right font-medium">Fault Err %</th>
                      <th className="px-3 py-1.5 text-right font-medium">Recovery Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {comparisonRows.map((r) => {
                      const isActive = activeVariantId === r.variant.id;
                      return (
                        <tr
                          key={r.variant.id}
                          className={isActive ? 'bg-[var(--accent-soft)]/20' : undefined}
                        >
                          <td className="px-3 py-1.5 font-sans font-medium text-[var(--text-primary)]">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: VARIANT_COLORS[r.variant.id] }}
                              />
                              <span>{r.variant.name}</span>
                            </div>
                          </td>
                          <td
                            className={`px-2 py-1.5 text-right font-medium ${
                              r.peakAmplification > 1.5
                                ? 'text-[var(--status-overloaded)]'
                                : 'text-[var(--status-ok)]'
                            }`}
                          >
                            {r.peakAmplification.toFixed(2)}x
                          </td>
                          <td className="px-2 py-1.5 text-right text-[var(--text-primary)]">
                            {Math.round(r.minGoodputRps)} req/s
                          </td>
                          <td
                            className={`px-2 py-1.5 text-right ${
                              r.peakQueueDepth > 50
                                ? 'text-[var(--status-overloaded)]'
                                : 'text-[var(--text-primary)]'
                            }`}
                          >
                            {Math.round(r.peakQueueDepth)}
                          </td>
                          <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">
                            {Math.round(r.faultP95Ms)} ms
                          </td>
                          <td
                            className={`px-2 py-1.5 text-right font-medium ${
                              r.faultErrorRatePct > 50
                                ? 'text-[var(--status-overloaded)]'
                                : r.faultErrorRatePct > 10
                                  ? 'text-[var(--status-warm)]'
                                  : 'text-[var(--status-ok)]'
                            }`}
                          >
                            {r.faultErrorRatePct.toFixed(1)}%
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            {r.recoveryTimeS !== null ? (
                              <span className="font-medium text-[var(--status-ok)]">
                                {r.recoveryTimeS.toFixed(1)}s
                              </span>
                            ) : (
                              <span
                                data-testid="did-not-recover-badge"
                                className="inline-flex rounded border border-[rgba(229,72,77,0.3)] bg-[rgba(229,72,77,0.1)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-overloaded)]"
                              >
                                Did not recover
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Multi-variant Overlay SVG Chart */}
              <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
                <div className="mb-2 flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-secondary)]">
                      Variant Overlay:
                    </span>
                    <button
                      type="button"
                      onClick={() => setOverlayMetric('goodput')}
                      className={`rounded-[4px] px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        overlayMetric === 'goodput'
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      Goodput (req/s)
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverlayMetric('amplification')}
                      className={`rounded-[4px] px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        overlayMetric === 'amplification'
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      Amplification factor
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverlayMetric('queue')}
                      className={`rounded-[4px] px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        overlayMetric === 'queue'
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      DB Queue depth
                    </button>
                  </div>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    Max: {Math.round(chartMaxY)} · Timeline: 0–{durationS}s
                  </span>
                </div>

                <div className="relative h-28 w-full">
                  <svg
                    data-testid="variants-overlay-chart"
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    preserveAspectRatio="none"
                    className="h-full w-full select-none rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
                  >
                    {/* Shaded Fault Window */}
                    {(() => {
                      const startX = padX + (faultStartS / durationS) * plotW;
                      const endX = padX + (faultEndS / durationS) * plotW;
                      return (
                        <g data-testid="overlay-fault-window">
                          <rect
                            x={startX}
                            y={padY}
                            width={endX - startX}
                            height={plotH}
                            fill="rgba(239, 68, 68, 0.12)"
                          />
                          <line
                            x1={startX}
                            x2={startX}
                            y1={padY}
                            y2={padY + plotH}
                            stroke="var(--status-overloaded)"
                            strokeWidth={1}
                            strokeDasharray="2 2"
                            opacity={0.65}
                          />
                          <line
                            x1={endX}
                            x2={endX}
                            y1={padY}
                            y2={padY + plotH}
                            stroke="var(--status-overloaded)"
                            strokeWidth={1}
                            strokeDasharray="2 2"
                            opacity={0.65}
                          />
                          <text
                            x={startX + 4}
                            y={padY + 12}
                            fill="var(--status-overloaded)"
                            fontSize="9"
                            fontFamily="monospace"
                            opacity={0.8}
                          >
                            Fault ({faultStartS}s–{faultEndS}s)
                          </text>
                        </g>
                      );
                    })()}

                    {/* Variant Lines */}
                    {overlayLines.map((line) => {
                      if (line.points.length === 0) return null;
                      const d = line.points
                        .map((pt, idx) => {
                          const px = padX + (pt.x / durationS) * plotW;
                          const py = padY + plotH - (Math.min(chartMaxY, pt.y) / chartMaxY) * plotH;
                          return `${idx === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
                        })
                        .join(' ');
                      return (
                        <path
                          key={line.id}
                          d={d}
                          fill="none"
                          stroke={line.color}
                          strokeWidth={activeVariantId === line.id ? 2.5 : 1.5}
                          opacity={activeVariantId === line.id ? 1 : 0.75}
                        />
                      );
                    })}
                  </svg>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                  <div className="flex flex-wrap items-center gap-3">
                    {RETRY_LAB_VARIANTS.map((v) => (
                      <span key={v.id} className="inline-flex items-center gap-1 font-mono">
                        <span
                          className="inline-block h-1.5 w-3 rounded-full"
                          style={{ backgroundColor: VARIANT_COLORS[v.id] }}
                        />
                        <span>{v.shortLabel}</span>
                      </span>
                    ))}
                  </div>
                  <span>Shaded band = Fault duration (20ms → 800ms)</span>
                </div>
              </div>
            </div>
          )}

          {/* Mandatory Footer Disclaimer */}
          <div className="pt-1 text-[11px] italic text-[var(--text-muted)]">
            Simulated with the assumptions above. Not a cloud benchmark.
          </div>
        </div>
      )}
    </div>
  );
}
