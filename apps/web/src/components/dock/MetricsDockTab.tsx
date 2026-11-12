'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { CheckCircle2, Pin, PinOff, XCircle } from 'lucide-react';
import { getService } from '@infrasim/catalog';
import { evaluateScenarioThresholds } from '@infrasim/sandbox/thresholds';
import { computeErlangC } from '@infrasim/sim-engine';
import type { ChaosEvent, Design, SimulationResult } from '@infrasim/shared-types';
import { chartClientXToTimeS, chartTimeSToPercent } from '../../lib/chartCursor';
import { formatMoney } from '../../lib/costFormat';
import { downsampleLttb } from '../../lib/lttb';
import { computeTheoreticalMaxRps } from '../../lib/nodeDefaults';
import { formatVirtualTime } from '../../lib/timeFormat';

export interface MetricsDockTabProps {
  design: Design;
  result: SimulationResult | null;
  previousResult: SimulationResult | null;
  pinnedRun?: {
    label: string;
    result: SimulationResult;
    monthlyCostUsd: number | null;
  } | null;
  currentMonthlyCostUsd?: number | null;
  currency?: string;
  chaos?: readonly ChaosEvent[];
  scenarioThresholds?: Record<string, string[]>;
  selectedNodeId: string | null;
  currentTimeS: number | null;
  elapsedWallMs: number | null;
  onSeekToTimeS: (tS: number) => void;
  onSelectBottleneck: (nodeId: string) => void;
  onPinRunA?: () => void;
  onUnpinRunA?: () => void;
}

type ChartMode = 'rps' | 'latency' | 'utilization' | 'queue';

const MODE_LABELS: { id: ChartMode; label: string }[] = [
  { id: 'rps', label: 'Throughput & Errors' },
  { id: 'latency', label: 'Latency (p50/p95/p99)' },
  { id: 'utilization', label: 'Utilization' },
  { id: 'queue', label: 'Queue & Instances' },
];

interface SeriesLine {
  id: string;
  label: string;
  color: string;
  dashed?: boolean;
  points: { x: number; y: number }[];
}

function buildPolylinePath(
  points: readonly { x: number; y: number }[],
  maxX: number,
  maxY: number,
  width: number,
  height: number,
  padX: number,
  padY: number,
): string {
  if (points.length === 0) return '';
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;
  const safeMaxX = Math.max(1, maxX);
  const safeMaxY = Math.max(0.0001, maxY);

  return points
    .map((p, idx) => {
      const px = padX + (p.x / safeMaxX) * plotW;
      const clampedY = Math.max(0, Math.min(safeMaxY, p.y));
      const py = padY + plotH - (clampedY / safeMaxY) * plotH;
      return `${idx === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
}

function sumResultErrors(res: SimulationResult): number {
  let sum = 0;
  for (const val of Object.values(res.summary.errors)) {
    sum += val ?? 0;
  }
  return sum;
}

/** Bottom dock Metrics view with Result Summary Card, LTTB SVG time series, Erlang C overlay, and per-node table. */
export function MetricsDockTab({
  design,
  result,
  previousResult,
  pinnedRun = null,
  currentMonthlyCostUsd = null,
  currency = 'USD',
  chaos = [],
  scenarioThresholds,
  selectedNodeId,
  currentTimeS,
  elapsedWallMs,
  onSeekToTimeS,
  onSelectBottleneck,
  onPinRunA,
  onUnpinRunA,
}: MetricsDockTabProps) {
  const [chartMode, setChartMode] = useState<ChartMode>('rps');
  const [filterNodeId, setFilterNodeId] = useState<string>('__auto__');
  const [showTheory, setShowTheory] = useState(true);
  const [comparePrev, setComparePrev] = useState(true);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverTimeS, setHoverTimeS] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const clipId = useId();
  const onSeekRef = useRef(onSeekToTimeS);
  onSeekRef.current = onSeekToTimeS;

  const effectiveNodeFilter = useMemo(() => {
    if (filterNodeId !== '__auto__') {
      return filterNodeId === '__all__' ? null : filterNodeId;
    }
    if (selectedNodeId && result?.perNode[selectedNodeId]) {
      return selectedNodeId;
    }
    return null;
  }, [filterNodeId, selectedNodeId, result]);

  const targetNodeObj = useMemo(
    () =>
      effectiveNodeFilter
        ? (design.nodes.find((n) => n.id === effectiveNodeFilter) ?? null)
        : result?.bottleneckNodeId
          ? (design.nodes.find((n) => n.id === result.bottleneckNodeId) ?? null)
          : null,
    [design.nodes, effectiveNodeFilter, result?.bottleneckNodeId],
  );

  const targetService = useMemo(
    () =>
      targetNodeObj ? getService(targetNodeObj.serviceId, design.customServices ?? []) : undefined,
    [design.customServices, targetNodeObj],
  );

  const targetMaxRps = useMemo(
    () => (targetNodeObj ? computeTheoreticalMaxRps(targetNodeObj.config, targetService) : null),
    [targetNodeObj, targetService],
  );

  const { seriesLines, yUnit, maxX, maxY } = useMemo<{
    seriesLines: SeriesLine[];
    yUnit: string;
    maxX: number;
    maxY: number;
  }>(() => {
    if (!result || result.series.buckets.length === 0) {
      return { seriesLines: [], yUnit: '', maxX: 1, maxY: 1 };
    }

    const baselineResult = pinnedRun?.result ?? previousResult;
    const baselineLabel = pinnedRun ? pinnedRun.label : 'Prev';
    const buckets = result.series.buckets;
    const prevBuckets = baselineResult?.series.buckets ?? [];
    const lines: SeriesLine[] = [];
    let unit = '';
    const durMax = Math.max(1, buckets[buckets.length - 1]!.tS);

    const theoryNodeId = effectiveNodeFilter ?? result.bottleneckNodeId;
    const theoryNode = theoryNodeId ? design.nodes.find((n) => n.id === theoryNodeId) : undefined;
    const theorySvc = theoryNode
      ? getService(theoryNode.serviceId, design.customServices ?? [])
      : undefined;

    if (chartMode === 'rps') {
      unit = 'req/s';
      lines.push({
        id: 'rps-in',
        label: effectiveNodeFilter ? 'RPS In' : 'Arrivals (req/s)',
        color: 'var(--accent)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.rpsIn ?? 0) : b.rpsIn,
        })),
      });
      lines.push({
        id: 'rps-out',
        label: effectiveNodeFilter ? 'RPS Out' : 'Completed (req/s)',
        color: 'var(--status-ok)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.rpsOut ?? 0) : b.throughputRps,
        })),
      });
      lines.push({
        id: 'errors',
        label: 'Errors + Drops (/s)',
        color: 'var(--status-overloaded)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter
            ? (b.perNode[effectiveNodeFilter]?.errors ?? 0) +
              (b.perNode[effectiveNodeFilter]?.drops ?? 0)
            : b.errorRate * Math.max(1, b.rpsIn),
        })),
      });
      if (comparePrev && prevBuckets.length > 0) {
        lines.push({
          id: 'prev-rps',
          label: `${baselineLabel} Completed`,
          color: 'var(--text-muted)',
          dashed: true,
          points: prevBuckets.map((b) => ({
            x: b.tS,
            y: effectiveNodeFilter
              ? (b.perNode[effectiveNodeFilter]?.rpsOut ?? 0)
              : b.throughputRps,
          })),
        });
      }
    } else if (chartMode === 'latency') {
      unit = 'ms';
      lines.push({
        id: 'p50',
        label: 'p50 ms',
        color: 'var(--status-ok)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.p50 ?? 0) : b.p50,
        })),
      });
      lines.push({
        id: 'p95',
        label: 'p95 ms',
        color: 'var(--accent)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.p95 ?? 0) : b.p95,
        })),
      });
      lines.push({
        id: 'p99',
        label: 'p99 ms',
        color: 'var(--status-warm)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.p99 ?? 0) : b.p99,
        })),
      });
      if (comparePrev && prevBuckets.length > 0) {
        lines.push({
          id: 'prev-p95',
          label: `${baselineLabel} p95 ms`,
          color: 'var(--text-muted)',
          dashed: true,
          points: prevBuckets.map((b) => ({
            x: b.tS,
            y: effectiveNodeFilter ? (b.perNode[effectiveNodeFilter]?.p95 ?? 0) : b.p95,
          })),
        });
      }
      if (showTheory && theoryNode) {
        const meanMs = theoryNode.config.latency?.p50 ?? theorySvc?.latency.p50 ?? 15;
        const capPerInst =
          theoryNode.config.maxInFlightPerInstance ??
          (theorySvc?.capacity.type === 'conc' ? theorySvc.capacity.limit : 100);
        lines.push({
          id: 'erlang-latency',
          label: 'Erlang C theory',
          color: 'var(--text-secondary)',
          dashed: true,
          points: buckets.map((b) => {
            const nb = b.perNode[theoryNode.id];
            const c = Math.max(
              1,
              (nb?.instancesActive ?? theoryNode.config.instances) * capPerInst,
            );
            const lambda = nb?.rpsIn ?? b.rpsIn;
            const ec = computeErlangC(c, lambda, meanMs);
            return {
              x: b.tS,
              y: Number.isFinite(ec.expectedTotalMs)
                ? Math.min(5000, ec.expectedTotalMs)
                : meanMs * 10,
            };
          }),
        });
      }
    } else if (chartMode === 'utilization') {
      unit = '%';
      const utilNodeId = effectiveNodeFilter ?? result.bottleneckNodeId ?? design.nodes[0]?.id;
      lines.push({
        id: 'util',
        label: utilNodeId
          ? `${design.nodes.find((n) => n.id === utilNodeId)?.label ?? utilNodeId} util %`
          : 'Utilization %',
        color: 'var(--accent)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: Math.round((utilNodeId ? (b.perNode[utilNodeId]?.utilization ?? 0) : 0) * 100),
        })),
      });
      lines.push({
        id: 'cpu-util',
        label: 'CPU %',
        color: 'var(--status-warm)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: Math.round((utilNodeId ? (b.perNode[utilNodeId]?.cpuUtilization ?? 0) : 0) * 100),
        })),
      });
      if (showTheory && theoryNode) {
        const meanMs = theoryNode.config.latency?.p50 ?? theorySvc?.latency.p50 ?? 15;
        const capPerInst =
          theoryNode.config.maxInFlightPerInstance ??
          (theorySvc?.capacity.type === 'conc' ? theorySvc.capacity.limit : 100);
        lines.push({
          id: 'erlang-rho',
          label: 'Erlang C ρ theory',
          color: 'var(--text-secondary)',
          dashed: true,
          points: buckets.map((b) => {
            const nb = b.perNode[theoryNode.id];
            const c = Math.max(
              1,
              (nb?.instancesActive ?? theoryNode.config.instances) * capPerInst,
            );
            const ec = computeErlangC(c, nb?.rpsIn ?? b.rpsIn, meanMs);
            return { x: b.tS, y: Math.min(120, Math.round(ec.utilizationRho * 100)) };
          }),
        });
      }
    } else {
      unit = 'count';
      const qNodeId = effectiveNodeFilter ?? result.bottleneckNodeId ?? design.nodes[0]?.id;
      lines.push({
        id: 'queue',
        label: 'Queue depth',
        color: 'var(--status-hot)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: qNodeId ? (b.perNode[qNodeId]?.queueDepth ?? 0) : 0,
        })),
      });
      lines.push({
        id: 'inflight',
        label: 'In-flight',
        color: 'var(--accent)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: qNodeId ? (b.perNode[qNodeId]?.inFlight ?? 0) : 0,
        })),
      });
      lines.push({
        id: 'instances',
        label: 'Active instances',
        color: 'var(--status-ok)',
        points: buckets.map((b) => ({
          x: b.tS,
          y: qNodeId ? (b.perNode[qNodeId]?.instancesActive ?? 0) : 0,
        })),
      });
    }

    const decimated = lines.map((line) => ({
      ...line,
      points: downsampleLttb(
        line.points.filter((pt) => pt.x <= durMax),
        500,
      ),
    }));

    let computedMaxY = chartMode === 'utilization' ? 100 : 1;
    for (const line of decimated) {
      for (const pt of line.points) {
        if (pt.y > computedMaxY) {
          computedMaxY = pt.y;
        }
      }
    }

    return {
      seriesLines: decimated,
      yUnit: unit,
      maxX: durMax,
      maxY: computedMaxY * 1.1,
    };
  }, [
    result,
    previousResult,
    pinnedRun,
    effectiveNodeFilter,
    chartMode,
    comparePrev,
    showTheory,
    design,
  ]);

  const svgWidth = 560;
  const svgHeight = 128;
  const padX = 4;
  const padY = 10;

  const maxXRef = useRef(maxX);
  maxXRef.current = maxX;

  useEffect(() => {
    if (!isScrubbing) {
      return;
    }
    const seekAtClientX = (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const targetS = chartClientXToTimeS(
        clientX,
        rect.left,
        rect.width,
        maxXRef.current,
        svgWidth,
        padX,
      );
      setHoverTimeS(targetS);
      onSeekRef.current(targetS);
    };
    const handleWindowMove = (ev: globalThis.PointerEvent) => {
      seekAtClientX(ev.clientX);
    };
    const handleWindowUp = () => {
      setIsScrubbing(false);
    };
    window.addEventListener('pointermove', handleWindowMove);
    window.addEventListener('pointerup', handleWindowUp);
    window.addEventListener('pointercancel', handleWindowUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowMove);
      window.removeEventListener('pointerup', handleWindowUp);
      window.removeEventListener('pointercancel', handleWindowUp);
    };
  }, [isScrubbing]);

  const activeThresholds = scenarioThresholds ?? design.scenarios[0]?.thresholds;
  const thresholdResults = useMemo(
    () => (result && activeThresholds ? evaluateScenarioThresholds(activeThresholds, result) : []),
    [result, activeThresholds],
  );

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-[12px] text-[var(--text-muted)]">
          Run a simulation to inspect RPS, latency percentiles, utilization, and queue metrics.
        </p>
      </div>
    );
  }

  const totalErrs = sumResultErrors(result);
  const errorPct =
    result.summary.totalRequests > 0 ? (totalErrs / result.summary.totalRequests) * 100 : 0;
  const prevErrs = previousResult ? sumResultErrors(previousResult) : null;
  const prevErrorPct =
    previousResult && previousResult.summary.totalRequests > 0
      ? ((prevErrs ?? 0) / previousResult.summary.totalRequests) * 100
      : null;

  const bottleneckNode = result.bottleneckNodeId
    ? design.nodes.find((n) => n.id === result.bottleneckNodeId)
    : undefined;
  const bottleneckSummary = result.bottleneckNodeId
    ? result.perNode[result.bottleneckNodeId]
    : undefined;

  const resolveTimeFromClientX = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return chartClientXToTimeS(clientX, rect.left, rect.width, maxX, svgWidth, padX);
  };

  const handleSvgPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }
    e.preventDefault();
    const targetS = resolveTimeFromClientX(e.clientX);
    setHoverTimeS(targetS);
    setIsScrubbing(true);
    onSeekToTimeS(targetS);
  };

  const handleSvgPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (isScrubbing) {
      return;
    }
    setHoverTimeS(resolveTimeFromClientX(e.clientX));
  };

  const handleSvgKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? Math.max(1, maxX / 10) : Math.max(0.1, Math.min(1, maxX / 30));
    const baseTime = currentTimeS ?? 0;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSeekToTimeS(Math.max(0, Number((baseTime - step).toFixed(2))));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSeekToTimeS(Math.min(maxX, Number((baseTime + step).toFixed(2))));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeekToTimeS(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSeekToTimeS(maxX);
    }
  };

  const cursorPct =
    currentTimeS !== null ? chartTimeSToPercent(currentTimeS, maxX, svgWidth, padX) : null;
  const hoverSvgX =
    hoverTimeS !== null
      ? padX + (Math.min(maxX, Math.max(0, hoverTimeS)) / Math.max(1, maxX)) * (svgWidth - padX * 2)
      : null;
  const cursorSvgX =
    currentTimeS !== null
      ? padX +
        (Math.min(maxX, Math.max(0, currentTimeS)) / Math.max(1, maxX)) * (svgWidth - padX * 2)
      : null;

  return (
    <div data-testid="metrics-dock-tab" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Result Summary Strip */}
      <div
        data-testid="result-summary-card"
        className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[11px]"
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Throughput</span>
            <span className="font-mono font-medium tabular-nums text-[var(--text-primary)]">
              {result.summary.throughputRps.toFixed(1)} req/s
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
              ({result.summary.totalRequests.toLocaleString()} req)
            </span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Errors</span>
            <span
              className={`font-mono font-medium tabular-nums ${
                errorPct > 1
                  ? 'text-[var(--status-overloaded)]'
                  : errorPct > 0
                    ? 'text-[var(--status-warm)]'
                    : 'text-[var(--status-ok)]'
              }`}
            >
              {errorPct.toFixed(2)}%
            </span>
            {prevErrorPct !== null ? (
              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                (was {prevErrorPct.toFixed(2)}%)
              </span>
            ) : null}
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[var(--text-muted)]">Latency</span>
            <span className="font-mono tabular-nums text-[var(--text-primary)]">
              {Math.round(result.summary.p50)} / {Math.round(result.summary.p95)} /{' '}
              {Math.round(result.summary.p99)} ms
            </span>
            {previousResult ? (
              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                (p95 was {Math.round(previousResult.summary.p95)} ms)
              </span>
            ) : null}
          </div>

          {bottleneckNode && bottleneckSummary ? (
            <div className="flex items-baseline gap-1.5">
              <span className="text-[var(--text-muted)]">Bottleneck</span>
              <button
                type="button"
                data-testid="summary-bottleneck-btn"
                onClick={() => onSelectBottleneck(bottleneckNode.id)}
                className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--accent)] hover:border-[var(--accent)]"
              >
                {bottleneckNode.label} ({Math.round(bottleneckSummary.peakUtilization * 100)}% peak)
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
          {onPinRunA && onUnpinRunA ? (
            pinnedRun ? (
              <button
                type="button"
                data-testid="pin-run-a-btn"
                onClick={onUnpinRunA}
                className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--accent)] bg-[var(--accent-soft)] px-2 font-sans text-[10px] font-medium text-[var(--text-primary)]"
              >
                <PinOff className="h-3 w-3" strokeWidth={1.5} />
                <span>Unpin Run A</span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="pin-run-a-btn"
                onClick={onPinRunA}
                className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-sans text-[10px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <Pin className="h-3 w-3" strokeWidth={1.5} />
                <span>Pin as Run A</span>
              </button>
            )
          ) : null}
          {targetMaxRps?.rps ? (
            <span data-testid="summary-theoretical-max-rps" title={targetMaxRps.explanation}>
              Max theoretical: {targetMaxRps.rps.toLocaleString()} req/s
            </span>
          ) : null}
          {elapsedWallMs !== null ? <span>Ran in {elapsedWallMs} ms</span> : null}
        </div>
      </div>

      {pinnedRun
        ? (() => {
            const aErrs = sumResultErrors(pinnedRun.result);
            const aErrPct =
              pinnedRun.result.summary.totalRequests > 0
                ? (aErrs / pinnedRun.result.summary.totalRequests) * 100
                : 0;
            const p95Delta = Math.round(result.summary.p95 - pinnedRun.result.summary.p95);
            const errDelta = errorPct - aErrPct;
            const rpsDelta = result.summary.throughputRps - pinnedRun.result.summary.throughputRps;
            const costDelta =
              pinnedRun.monthlyCostUsd !== null && currentMonthlyCostUsd !== null
                ? currentMonthlyCostUsd - pinnedRun.monthlyCostUsd
                : null;
            return (
              <div
                data-testid="ab-comparison-bar"
                className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-[11px]"
              >
                <span className="font-medium text-[var(--text-primary)]">A/B Run comparison</span>
                <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums">
                  <span className="text-[var(--text-secondary)]">
                    p95:{' '}
                    <strong className="font-medium text-[var(--text-primary)]">
                      {Math.round(pinnedRun.result.summary.p95)}ms →{' '}
                      {Math.round(result.summary.p95)}ms
                    </strong>{' '}
                    <span
                      className={
                        p95Delta < 0
                          ? 'text-[var(--status-ok)]'
                          : p95Delta > 0
                            ? 'text-[var(--status-overloaded)]'
                            : 'text-[var(--text-muted)]'
                      }
                    >
                      ({p95Delta > 0 ? `+${p95Delta}` : p95Delta}ms)
                    </span>
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    Err:{' '}
                    <strong className="font-medium text-[var(--text-primary)]">
                      {aErrPct.toFixed(2)}% → {errorPct.toFixed(2)}%
                    </strong>{' '}
                    <span
                      className={
                        errDelta < -0.01
                          ? 'text-[var(--status-ok)]'
                          : errDelta > 0.01
                            ? 'text-[var(--status-overloaded)]'
                            : 'text-[var(--text-muted)]'
                      }
                    >
                      ({errDelta > 0 ? `+${errDelta.toFixed(2)}` : errDelta.toFixed(2)}%)
                    </span>
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    RPS:{' '}
                    <strong className="font-medium text-[var(--text-primary)]">
                      {pinnedRun.result.summary.throughputRps.toFixed(1)} →{' '}
                      {result.summary.throughputRps.toFixed(1)}
                    </strong>{' '}
                    <span
                      className={
                        rpsDelta > 0.5
                          ? 'text-[var(--status-ok)]'
                          : rpsDelta < -0.5
                            ? 'text-[var(--status-warm)]'
                            : 'text-[var(--text-muted)]'
                      }
                    >
                      ({rpsDelta > 0 ? `+${rpsDelta.toFixed(1)}` : rpsDelta.toFixed(1)})
                    </span>
                  </span>
                  {costDelta !== null &&
                  pinnedRun.monthlyCostUsd !== null &&
                  currentMonthlyCostUsd !== null ? (
                    <span className="text-[var(--text-secondary)]">
                      Cost:{' '}
                      <strong className="font-medium text-[var(--text-primary)]">
                        {formatMoney(pinnedRun.monthlyCostUsd, currency)} →{' '}
                        {formatMoney(currentMonthlyCostUsd, currency)}
                      </strong>{' '}
                      <span
                        className={
                          costDelta < 0 ? 'text-[var(--status-ok)]' : 'text-[var(--text-muted)]'
                        }
                      >
                        (
                        {costDelta >= 0
                          ? `+${formatMoney(costDelta, currency)}`
                          : formatMoney(costDelta, currency)}
                        )
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })()
        : null}

      {thresholdResults.length > 0 ? (
        <div
          data-testid="scenario-thresholds"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1 text-[10px]"
        >
          <span className="font-medium text-[var(--text-muted)]">Thresholds</span>
          {thresholdResults.map((t, idx) => (
            <span
              key={`${t.metric}-${idx}`}
              data-testid="threshold-badge"
              data-passed={t.passed ? 'true' : 'false'}
              title={`${t.metric} ${t.expression}`}
              className={`inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-mono tabular-nums ${
                t.passed
                  ? 'border-[rgba(76,195,138,0.3)] bg-[rgba(76,195,138,0.1)] text-[var(--status-ok)]'
                  : 'border-[rgba(229,72,77,0.3)] bg-[rgba(229,72,77,0.1)] text-[var(--status-overloaded)]'
              }`}
            >
              {t.passed ? (
                <CheckCircle2 className="h-3 w-3 shrink-0" strokeWidth={1.5} />
              ) : (
                <XCircle className="h-3 w-3 shrink-0" strokeWidth={1.5} />
              )}
              <span>
                {t.metric} ({t.label})
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {/* Main Split: Hero SVG Chart + Per-Node Table */}
      <div className="flex min-h-0 flex-1 divide-x divide-[var(--border-hairline)]">
        {/* Chart Side */}
        <div className="flex min-w-0 flex-1 flex-col p-2.5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {MODE_LABELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setChartMode(m.id)}
                  className={`h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors ${
                    chartMode === m.id
                      ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 text-[11px]">
              <select
                aria-label="Filter metrics by node"
                value={filterNodeId}
                onChange={(e) => setFilterNodeId(e.target.value)}
                className="h-6 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 text-[11px] text-[var(--text-secondary)]"
              >
                <option value="__auto__">
                  {selectedNodeId
                    ? `Selected (${design.nodes.find((n) => n.id === selectedNodeId)?.label ?? selectedNodeId})`
                    : 'All nodes'}
                </option>
                <option value="__all__">All nodes</option>
                {design.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>

              <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={showTheory}
                  onChange={(e) => setShowTheory(e.target.checked)}
                />
                <span>Erlang C theory</span>
              </label>

              {pinnedRun || previousResult ? (
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={comparePrev}
                    onChange={(e) => setComparePrev(e.target.checked)}
                  />
                  <span>{pinnedRun ? 'Overlay Run A' : 'Compare prev'}</span>
                </label>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 items-stretch gap-2">
              <div
                aria-hidden="true"
                className="flex w-10 shrink-0 flex-col justify-between py-1 text-right font-mono text-[10px] tabular-nums text-[var(--text-muted)]"
              >
                <span>{Math.round(maxY)}</span>
                <span>{Math.round(maxY * 0.5)}</span>
                <span>0</span>
              </div>

              <div className="relative h-full min-w-0 flex-1 select-none">
                <svg
                  ref={svgRef}
                  data-testid="metrics-hero-chart"
                  viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                  preserveAspectRatio="none"
                  tabIndex={0}
                  onPointerDown={handleSvgPointerDown}
                  onPointerMove={handleSvgPointerMove}
                  onPointerLeave={() => {
                    if (!isScrubbing) {
                      setHoverTimeS(null);
                    }
                  }}
                  onKeyDown={handleSvgKeyDown}
                  role="slider"
                  aria-label={`Timeline cursor for ${MODE_LABELS.find((m) => m.id === chartMode)?.label ?? chartMode}`}
                  aria-valuemin={0}
                  aria-valuemax={maxX}
                  aria-valuenow={Number((currentTimeS ?? 0).toFixed(2))}
                  aria-valuetext={
                    currentTimeS !== null ? formatVirtualTime(currentTimeS * 1000) : undefined
                  }
                  className="h-full w-full touch-none cursor-ew-resize select-none rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
                >
                  <defs>
                    <clipPath id={clipId}>
                      <rect x={padX} y={0} width={svgWidth - padX * 2} height={svgHeight} />
                    </clipPath>
                  </defs>

                  {/* Horizontal muted reference lines */}
                  {[0, 0.5, 1].map((frac) => {
                    const py = padY + (svgHeight - padY * 2) * (1 - frac);
                    return (
                      <line
                        key={frac}
                        x1={padX}
                        x2={svgWidth - padX}
                        y1={py}
                        y2={py}
                        stroke="var(--border-hairline)"
                        strokeWidth={1}
                      />
                    );
                  })}

                  {/* Chaos window shaded bands */}
                  <g clipPath={`url(#${clipId})`}>
                    {chaos.map((ev, idx) => {
                      const plotW = svgWidth - padX * 2;
                      const safeMaxX = Math.max(1, maxX);
                      const startX =
                        padX + (Math.max(0, Math.min(safeMaxX, ev.atS)) / safeMaxX) * plotW;
                      const endX =
                        padX +
                        (Math.max(0, Math.min(safeMaxX, ev.atS + Math.max(0.25, ev.durationS))) /
                          safeMaxX) *
                          plotW;
                      const widthPx = Math.max(2, endX - startX);
                      return (
                        <g key={`chaos-band-${idx}`} data-testid="metrics-chaos-band">
                          <rect
                            x={startX}
                            y={padY}
                            width={widthPx}
                            height={svgHeight - padY * 2}
                            fill="var(--status-warm)"
                            fillOpacity={0.1}
                          />
                          <line
                            x1={startX}
                            x2={startX}
                            y1={padY}
                            y2={svgHeight - padY}
                            stroke="var(--status-warm)"
                            strokeWidth={1}
                            strokeDasharray="2 2"
                            opacity={0.55}
                          />
                        </g>
                      );
                    })}
                  </g>

                  {/* Series polylines */}
                  <g clipPath={`url(#${clipId})`}>
                    {seriesLines.map((line) => (
                      <path
                        key={line.id}
                        d={buildPolylinePath(
                          line.points,
                          maxX,
                          maxY,
                          svgWidth,
                          svgHeight,
                          padX,
                          padY,
                        )}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={line.dashed ? 1.25 : 1.75}
                        strokeDasharray={line.dashed ? '4 3' : undefined}
                      />
                    ))}
                  </g>

                  {/* Hover guide */}
                  {hoverSvgX !== null && !isScrubbing ? (
                    <line
                      x1={hoverSvgX}
                      x2={hoverSvgX}
                      y1={padY}
                      y2={svgHeight - padY}
                      stroke="var(--text-muted)"
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      opacity={0.55}
                    />
                  ) : null}

                  {/* Active scrubber vertical playhead */}
                  {cursorSvgX !== null ? (
                    <line
                      x1={cursorSvgX}
                      x2={cursorSvgX}
                      y1={4}
                      y2={svgHeight - 4}
                      stroke="var(--text-primary)"
                      strokeWidth={1.5}
                      opacity={0.85}
                    />
                  ) : null}
                </svg>

                {/* Non-stretched HTML cursor handle & tabular timestamp readout */}
                {cursorPct !== null && currentTimeS !== null ? (
                  <div
                    data-testid="metrics-chart-cursor"
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-1 top-1 z-10"
                    style={{ left: `${cursorPct}%` }}
                  >
                    <div
                      className={`h-2.5 w-2.5 -translate-x-1/2 -translate-y-0.5 rounded-full border border-[var(--bg-surface)] transition-colors ${
                        isScrubbing ? 'bg-[var(--accent)]' : 'bg-[var(--text-primary)]'
                      }`}
                    />
                    <span
                      className="absolute top-0.5 whitespace-nowrap rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 py-px font-mono text-[10px] leading-tight tabular-nums text-[var(--text-primary)]"
                      style={{
                        left: cursorPct > 84 ? 'auto' : '6px',
                        right: cursorPct > 84 ? '6px' : 'auto',
                      }}
                    >
                      {formatVirtualTime(currentTimeS * 1000)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
              <div className="flex flex-wrap items-center gap-3">
                {seriesLines.map((line) => (
                  <span key={line.id} className="inline-flex items-center gap-1">
                    <span
                      className="inline-block h-1.5 w-3 rounded-full"
                      style={{
                        backgroundColor: line.color,
                        opacity: line.dashed ? 0.6 : 1,
                      }}
                    />
                    <span>{line.label}</span>
                  </span>
                ))}
                {chaos.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-[var(--status-warm)]">
                    <span className="inline-block h-2 w-2.5 rounded-[2px] border border-[var(--status-warm)] bg-[rgba(229,160,13,0.18)]" />
                    <span>Chaos ({chaos.length})</span>
                  </span>
                ) : null}
              </div>
              <span className="font-mono tabular-nums">
                {hoverTimeS !== null && !isScrubbing
                  ? `Hover ${formatVirtualTime(hoverTimeS * 1000)} · `
                  : ''}
                Unit: {yUnit} · Drag or click chart to scrub
              </span>
            </div>
          </div>
        </div>

        {/* Right: Per-Node Summary Breakdown */}
        <div className="hidden w-[360px] shrink-0 overflow-y-auto p-2.5 lg:block">
          <div className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            Per-node breakdown
          </div>
          <table className="w-full text-left font-mono text-[10px] tabular-nums">
            <thead>
              <tr className="border-b border-[var(--border-hairline)] text-[var(--text-muted)]">
                <th className="py-1 font-medium">Node</th>
                <th className="py-1 text-right font-medium">Peak</th>
                <th className="py-1 text-right font-medium">p95</th>
                <th className="py-1 text-right font-medium">Drops/Err</th>
                <th className="py-1 text-right font-medium">Max RPS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-hairline)]">
              {design.nodes.map((node) => {
                const ns = result.perNode[node.id];
                if (!ns) return null;
                const svc = getService(node.serviceId, design.customServices ?? []);
                const tMax = computeTheoreticalMaxRps(node.config, svc);
                const errSum =
                  ns.drops + Object.values(ns.errors).reduce<number>((a, b) => a + (b ?? 0), 0);
                const peakPct = Math.round(ns.peakUtilization * 100);
                return (
                  <tr
                    key={node.id}
                    onClick={() => onSelectBottleneck(node.id)}
                    className={`cursor-pointer hover:bg-[var(--bg-raised)] ${
                      selectedNodeId === node.id ? 'bg-[var(--bg-raised)]' : ''
                    }`}
                  >
                    <td className="max-w-[110px] truncate py-1 font-sans text-[11px] font-medium text-[var(--text-primary)]">
                      {node.label}
                    </td>
                    <td
                      className={`py-1 text-right ${
                        peakPct >= 95
                          ? 'text-[var(--status-overloaded)]'
                          : peakPct >= 80
                            ? 'text-[var(--status-hot)]'
                            : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      {peakPct}%
                    </td>
                    <td className="py-1 text-right text-[var(--text-secondary)]">
                      {Math.round(ns.p95)}ms
                    </td>
                    <td
                      className={`py-1 text-right ${
                        errSum > 0 ? 'text-[var(--status-overloaded)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {errSum}
                    </td>
                    <td className="py-1 text-right text-[var(--text-muted)]">
                      {tMax.rps !== null ? tMax.rps : '∞'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
