'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Play } from 'lucide-react';
import type { PriceSnapshot } from '@infrasim/cost-engine';
import { applyJsonPatch } from '@infrasim/diagnosis';
import type { CostLatencySweepResult, SweepPoint } from '@infrasim/diagnosis/sweep';
import type { CostAssumptions, Design, SimulationResult } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { formatMoney } from '../../lib/costFormat';

export interface CostSweepViewProps {
  design: Design;
  result: SimulationResult | null;
  assumptions: CostAssumptions;
  snapshot: PriceSnapshot | null;
  selectedNodeId?: string | null;
  onApplyPatchedDesign?: (nextDesign: Design, changeLabel: string) => void;
}

/** Interactive SVG Pareto scatter chart & table sweeping node scale/SKU configurations against p95 latency and cost. */
export function CostSweepView({
  design,
  result,
  assumptions,
  snapshot,
  selectedNodeId,
  onApplyPatchedDesign,
}: CostSweepViewProps) {
  const candidateNodes = useMemo(
    () =>
      design.nodes.filter(
        (n) => n.serviceId !== 'generic.client' && n.serviceId !== 'generic.users',
      ),
    [design.nodes],
  );

  const defaultTargetId = useMemo(() => {
    if (selectedNodeId && candidateNodes.some((n) => n.id === selectedNodeId)) {
      return selectedNodeId;
    }
    if (result?.bottleneckNodeId && candidateNodes.some((n) => n.id === result.bottleneckNodeId)) {
      return result.bottleneckNodeId;
    }
    return candidateNodes[0]?.id ?? '';
  }, [candidateNodes, selectedNodeId, result?.bottleneckNodeId]);

  const [targetNodeId, setTargetNodeId] = useState<string>(defaultTargetId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweep, setSweep] = useState<CostLatencySweepResult | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);

  useEffect(() => {
    if (defaultTargetId && !candidateNodes.some((n) => n.id === targetNodeId)) {
      setTargetNodeId(defaultTargetId);
    } else if (!targetNodeId && defaultTargetId) {
      setTargetNodeId(defaultTargetId);
    }
  }, [defaultTargetId, candidateNodes, targetNodeId]);

  const handleRunSweep = async () => {
    if (!targetNodeId) return;
    setBusy(true);
    setError(null);
    try {
      const { runCostLatencySweep } = await import('@infrasim/diagnosis/sweep');
      const res = await runCostLatencySweep({
        design,
        nodeId: targetNodeId,
        snapshot,
        assumptions,
      });
      setSweep(res);
      const bestPareto =
        res.points.find((p) => p.isPareto && !p.isCurrent) ?? res.points[0] ?? null;
      setSelectedPointId(bestPareto?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to run cost vs latency sweep.');
    } finally {
      setBusy(false);
    }
  };

  const activePoint: SweepPoint | null = useMemo(() => {
    if (!sweep || sweep.points.length === 0) return null;
    return sweep.points.find((p) => p.id === selectedPointId) ?? sweep.points[0] ?? null;
  }, [sweep, selectedPointId]);

  const chartGeometry = useMemo(() => {
    if (!sweep || sweep.points.length === 0) return null;
    const width = 420;
    const height = 148;
    const padL = 44;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const hasCosts = sweep.points.every((p) => p.monthlyCostUsd !== null);
    const xValues = sweep.points.map((p) => (hasCosts ? (p.monthlyCostUsd ?? 0) : p.instances));
    const yValues = sweep.points.map((p) => p.p95Ms);

    const minX = Math.min(...xValues);
    const maxX = Math.max(minX + 1, ...xValues);
    const maxY = Math.max(10, ...yValues) * 1.12;

    const coords = sweep.points.map((pt, i) => {
      const xRaw = xValues[i]!;
      const yRaw = yValues[i]!;
      const cx = maxX === minX ? padL + plotW / 2 : padL + ((xRaw - minX) / (maxX - minX)) * plotW;
      const cy = padT + plotH - (yRaw / maxY) * plotH;
      return { pt, cx, cy };
    });

    const paretoCoords = coords.filter((c) => c.pt.isPareto).sort((a, b) => a.cx - b.cx);
    const paretoPath =
      paretoCoords.length > 1
        ? paretoCoords
            .map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`)
            .join(' ')
        : '';

    return {
      width,
      height,
      padL,
      padR,
      padT,
      padB,
      plotW,
      plotH,
      hasCosts,
      minX,
      maxX,
      maxY,
      coords,
      paretoPath,
    };
  }, [sweep]);

  if (candidateNodes.length === 0 || design.scenarios.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-[var(--text-muted)]">
        Add a service node and scenario to sweep cost vs latency trade-offs.
      </div>
    );
  }

  return (
    <div data-testid="cost-sweep-view" className="space-y-3 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span>Sweep target</span>
            <select
              aria-label="Sweep target node"
              data-testid="cost-sweep-node-select"
              value={targetNodeId}
              onChange={(e) => setTargetNodeId(e.target.value)}
              className="h-7 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[11px] text-[var(--text-primary)]"
            >
              {candidateNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} (×{n.config.instances})
                </option>
              ))}
            </select>
          </label>
        </div>

        <Button
          variant="primary"
          size="sm"
          data-testid="cost-run-sweep-btn"
          disabled={busy || !targetNodeId}
          onClick={() => void handleRunSweep()}
          className="h-7 px-2.5 text-[11px]"
        >
          <Play className="h-3 w-3" strokeWidth={1.5} />
          <span>{busy ? 'Sweeping...' : 'Run cost vs latency sweep'}</span>
        </Button>
      </div>

      {error ? (
        <div className="rounded-[6px] border border-[var(--status-overloaded)] bg-[var(--bg-sunken)] px-2.5 py-1.5 text-[var(--status-overloaded)]">
          {error}
        </div>
      ) : null}

      {!sweep ? (
        <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3 text-[var(--text-muted)]">
          Simulates ×1, ×2, ×4, ×8 instances (and curated SKUs when applicable) with your active
          seed and scenario to plot the Pareto cost-vs-p95 frontier.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {chartGeometry ? (
            <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
              <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                <span>
                  p95 latency (ms) vs {chartGeometry.hasCosts ? 'Monthly cost' : 'Instances'}
                </span>
                <span>Highlighted dots = Pareto optimal</span>
              </div>
              <svg
                data-testid="cost-sweep-chart"
                viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
                className="h-36 w-full select-none"
                role="img"
                aria-label="Cost vs p95 latency Pareto chart"
              >
                {[0, 0.5, 1].map((frac) => {
                  const y = chartGeometry.padT + chartGeometry.plotH * (1 - frac);
                  const val = Math.round(chartGeometry.maxY * frac);
                  return (
                    <g key={frac}>
                      <line
                        x1={chartGeometry.padL}
                        x2={chartGeometry.width - chartGeometry.padR}
                        y1={y}
                        y2={y}
                        stroke="var(--border-hairline)"
                        strokeWidth={1}
                      />
                      <text
                        x={chartGeometry.padL - 6}
                        y={y + 3}
                        textAnchor="end"
                        fill="var(--text-muted)"
                        fontSize={9}
                        fontFamily="monospace"
                      >
                        {val}ms
                      </text>
                    </g>
                  );
                })}

                <text
                  x={chartGeometry.padL}
                  y={chartGeometry.height - 6}
                  textAnchor="start"
                  fill="var(--text-muted)"
                  fontSize={9}
                  fontFamily="monospace"
                >
                  {chartGeometry.hasCosts
                    ? formatMoney(chartGeometry.minX, sweep.currency)
                    : `×${chartGeometry.minX}`}
                </text>
                <text
                  x={chartGeometry.width - chartGeometry.padR}
                  y={chartGeometry.height - 6}
                  textAnchor="end"
                  fill="var(--text-muted)"
                  fontSize={9}
                  fontFamily="monospace"
                >
                  {chartGeometry.hasCosts
                    ? formatMoney(chartGeometry.maxX, sweep.currency)
                    : `×${chartGeometry.maxX}`}
                </text>

                {chartGeometry.paretoPath ? (
                  <path
                    d={chartGeometry.paretoPath}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ) : null}

                {chartGeometry.coords.map(({ pt, cx, cy }) => {
                  const selected = pt.id === activePoint?.id;
                  return (
                    <g
                      key={pt.id}
                      onClick={() => setSelectedPointId(pt.id)}
                      className="cursor-pointer"
                    >
                      <circle
                        cx={cx}
                        cy={cy}
                        r={selected ? 6 : 4.5}
                        fill={pt.isPareto ? 'var(--accent)' : 'var(--text-muted)'}
                        stroke={selected ? 'var(--text-primary)' : 'var(--bg-surface)'}
                        strokeWidth={selected ? 2 : 1.2}
                      />
                      <text
                        x={cx}
                        y={cy - 8}
                        textAnchor="middle"
                        fill="var(--text-secondary)"
                        fontSize={9}
                        fontFamily="monospace"
                      >
                        ×{pt.instances}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : null}

          <div className="flex flex-col justify-between gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
            <table className="w-full text-left font-mono text-[10px] tabular-nums">
              <thead>
                <tr className="border-b border-[var(--border-hairline)] text-[var(--text-muted)]">
                  <th className="py-1 font-medium">Config</th>
                  <th className="py-1 text-right font-medium">Monthly</th>
                  <th className="py-1 text-right font-medium">p95</th>
                  <th className="py-1 text-right font-medium">Err</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {sweep.points.map((pt) => {
                  const selected = pt.id === activePoint?.id;
                  return (
                    <tr
                      key={pt.id}
                      data-testid={`sweep-row-${pt.id}`}
                      onClick={() => setSelectedPointId(pt.id)}
                      className={`cursor-pointer ${
                        selected ? 'bg-[var(--bg-raised)]' : 'hover:bg-[var(--bg-surface)]'
                      }`}
                    >
                      <td className="py-1 text-[var(--text-primary)]">
                        {pt.label}
                        {pt.isCurrent ? ' (current)' : ''}
                        {pt.isPareto ? ' · pareto' : ''}
                      </td>
                      <td className="py-1 text-right text-[var(--text-secondary)]">
                        {pt.monthlyCostUsd !== null
                          ? formatMoney(pt.monthlyCostUsd, sweep.currency)
                          : 'Price unavailable'}
                      </td>
                      <td className="py-1 text-right text-[var(--text-primary)]">{pt.p95Ms}ms</td>
                      <td className="py-1 text-right text-[var(--text-secondary)]">
                        {(pt.errorRate * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {activePoint && onApplyPatchedDesign ? (
              <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-2">
                <span className="text-[10px] text-[var(--text-muted)]">
                  Selected:{' '}
                  <strong className="text-[var(--text-primary)]">{activePoint.label}</strong>
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="cost-sweep-apply-btn"
                  disabled={activePoint.isCurrent}
                  onClick={() => {
                    const nextDesign = applyJsonPatch(design, activePoint.patch);
                    onApplyPatchedDesign(
                      nextDesign,
                      `Applied ${sweep.nodeLabel} ${activePoint.label} (${activePoint.p95Ms}ms p95)`,
                    );
                  }}
                  className="h-6 px-2 text-[10px]"
                >
                  <Check className="h-3 w-3" strokeWidth={1.5} />
                  <span>{activePoint.isCurrent ? 'Active config' : 'Apply config'}</span>
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
