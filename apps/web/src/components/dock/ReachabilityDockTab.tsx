'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Minus,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import {
  analyzeDesignNetwork,
  applyNetworkPatch,
  checkReachability,
  formatPatchDiffLines,
} from '@infrasim/network-analyzer';
import type {
  Design,
  NetworkAnalysis,
  ReachabilityResult,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';

export interface ReachabilityDockTabProps {
  design: Design;
  analysis: NetworkAnalysis | null;
  focusedEdgeId: string | null;
  customServices?: readonly ServiceDefinition[];
  isSimRunning: boolean;
  onSelectEdge: (edgeId: string | null) => void;
  onSetAnalysis: (analysis: NetworkAnalysis, durationMs?: number) => void;
  onApplyPatchedDesign: (nextDesign: Design, fixLabel: string) => void;
  onRerunVerify: () => void;
}

const FAILURE_MODE_LABEL: Record<
  NonNullable<ReachabilityResult['failureMode']>,
  { badge: string; hint: string }
> = {
  timeout: { badge: 'ETIMEDOUT', hint: 'Firewall or route drop (connection hangs until timeout)' },
  refused: { badge: 'ECONNREFUSED', hint: 'Host reachable, nothing listening on port' },
  dns: { badge: 'ENOTFOUND', hint: 'DNS name failed to resolve' },
  none: { badge: 'OK', hint: 'Reachable' },
};

/** Bottom dock panel for checking edge & ad-hoc reachability, inspecting hop traces, and applying least-privilege fixes. */
export function ReachabilityDockTab({
  design,
  analysis,
  focusedEdgeId,
  customServices,
  isSimRunning,
  onSelectEdge,
  onSetAnalysis,
  onApplyPatchedDesign,
  onRerunVerify,
}: ReachabilityDockTabProps) {
  const [srcNodeId, setSrcNodeId] = useState<string>(design.nodes[0]?.id ?? '');
  const [dstTarget, setDstTarget] = useState<string>(
    design.nodes[1]?.id ?? design.nodes[0]?.id ?? 'internet',
  );
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'icmp' | 'any'>('tcp');
  const [portInput, setPortInput] = useState('5432');
  const [adHocResult, setAdHocResult] = useState<{
    title: string;
    result: ReachabilityResult;
  } | null>(null);
  const [activeMode, setActiveMode] = useState<'edge' | 'query'>(
    focusedEdgeId ? 'edge' : design.edges.length > 0 ? 'edge' : 'query',
  );
  const [previewFixIdx, setPreviewFixIdx] = useState<number>(0);
  const [appliedBanner, setAppliedBanner] = useState<string | null>(null);

  useEffect(() => {
    if (design.nodes.length > 0 && !design.nodes.some((n) => n.id === srcNodeId)) {
      setSrcNodeId(design.nodes[0]!.id);
    }
    if (
      dstTarget !== 'internet' &&
      design.nodes.length > 1 &&
      !design.nodes.some((n) => n.id === dstTarget)
    ) {
      setDstTarget(design.nodes[1]!.id);
    }
  }, [design.nodes, dstTarget, srcNodeId]);

  useEffect(() => {
    if (focusedEdgeId) {
      setActiveMode('edge');
      setPreviewFixIdx(0);
    }
  }, [focusedEdgeId]);

  const effectiveAnalysis = useMemo(() => {
    if (analysis) return analysis;
    return analyzeDesignNetwork(design, { customServices });
  }, [analysis, customServices, design]);

  const nodesById = useMemo(() => new Map(design.nodes.map((n) => [n.id, n])), [design.nodes]);

  const edgeRows = useMemo(() => {
    return design.edges.map((edge) => {
      const res = effectiveAnalysis.edges[edge.id];
      const srcLabel = nodesById.get(edge.from)?.label ?? edge.from;
      const dstLabel = nodesById.get(edge.to)?.label ?? edge.to;
      return { edge, res, srcLabel, dstLabel };
    });
  }, [design.edges, effectiveAnalysis.edges, nodesById]);

  const counts = useMemo(() => {
    let reachable = 0;
    let blocked = 0;
    let risky = 0;
    for (const row of edgeRows) {
      if (row.res && !row.res.reachable) blocked += 1;
      else if (row.res?.riskyReason) risky += 1;
      else reachable += 1;
    }
    return { reachable, blocked, risky };
  }, [edgeRows]);

  const selectedEdgeRow = useMemo(() => {
    if (focusedEdgeId) {
      const found = edgeRows.find((r) => r.edge.id === focusedEdgeId);
      if (found) return found;
    }
    return edgeRows.find((r) => r.res && !r.res.reachable) ?? edgeRows[0] ?? null;
  }, [edgeRows, focusedEdgeId]);

  const handleCheckAllEdges = () => {
    const start = performance.now();
    const fresh = analyzeDesignNetwork(design, { customServices });
    onSetAnalysis(fresh, performance.now() - start);
    const firstBlocked = design.edges.find((e) => fresh.edges[e.id]?.reachable === false);
    if (firstBlocked) {
      onSelectEdge(firstBlocked.id);
    }
    setActiveMode('edge');
    setAppliedBanner(null);
  };

  const handleRunAdHocQuery = () => {
    if (!srcNodeId || !dstTarget.trim()) return;
    const portNum =
      protocol === 'icmp' || protocol === 'any' ? 0 : Math.max(1, Number(portInput) || 80);
    const res = checkReachability(
      design,
      { srcNodeId, dstNodeId: dstTarget.trim(), protocol, port: portNum },
      { customServices },
    );
    const srcName = nodesById.get(srcNodeId)?.label ?? srcNodeId;
    const dstName = nodesById.get(dstTarget.trim())?.label ?? dstTarget.trim();
    setAdHocResult({
      title: `${srcName} → ${dstName} (${protocol.toUpperCase()}${portNum > 0 ? ` ${portNum}` : ''})`,
      result: res,
    });
    setActiveMode('query');
    setPreviewFixIdx(0);
    setAppliedBanner(null);
  };

  const inspectedTarget =
    activeMode === 'query' && adHocResult
      ? {
          title: adHocResult.title,
          subtitle: 'Ad-hoc reachability query',
          result: adHocResult.result,
        }
      : selectedEdgeRow && selectedEdgeRow.res
        ? {
            title: `${selectedEdgeRow.srcLabel} → ${selectedEdgeRow.dstLabel}`,
            subtitle: `${selectedEdgeRow.edge.protocol.toUpperCase()}${
              selectedEdgeRow.edge.port ? `:${selectedEdgeRow.edge.port}` : ''
            } · ${selectedEdgeRow.edge.id}`,
            result: selectedEdgeRow.res,
          }
        : null;

  const activeFixes = inspectedTarget?.result.fixes ?? [];
  const selectedFix = activeFixes[previewFixIdx] ?? activeFixes[0] ?? null;
  const diffLines = useMemo(
    () => (selectedFix ? formatPatchDiffLines(selectedFix.patch) : []),
    [selectedFix],
  );

  const handleApplyFix = () => {
    if (!selectedFix) return;
    const patched = applyNetworkPatch(design, selectedFix.patch);
    onApplyPatchedDesign(patched, selectedFix.label);
    const t0 = performance.now();
    const rechecked = analyzeDesignNetwork(patched, { customServices });
    onSetAnalysis(rechecked, performance.now() - t0);
    if (activeMode === 'query' && srcNodeId && dstTarget.trim()) {
      const portNum =
        protocol === 'icmp' || protocol === 'any' ? 0 : Math.max(1, Number(portInput) || 80);
      const nextRes = checkReachability(
        patched,
        { srcNodeId, dstNodeId: dstTarget.trim(), protocol, port: portNum },
        { customServices },
      );
      setAdHocResult((prev) => (prev ? { ...prev, result: nextRes } : prev));
    }
    setAppliedBanner(selectedFix.label);
    setPreviewFixIdx(0);
  };

  return (
    <div
      data-testid="reachability-dock-tab"
      className="flex min-h-0 flex-1 divide-x divide-[var(--border-hairline)] overflow-hidden text-[12px]"
    >
      {/* Left: Point-to-point query + Check all edges summary */}
      <div className="flex w-[44%] min-w-[300px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3 py-2">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="check-all-edges-btn"
              onClick={handleCheckAllEdges}
              className="h-7 px-2.5 text-[11px]"
            >
              <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
              <span>Check all edges</span>
            </Button>
            <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
              <span className="text-[var(--status-ok)]">{counts.reachable} ok</span>
              <span className="text-[var(--status-overloaded)]">{counts.blocked} blocked</span>
              {counts.risky > 0 ? (
                <span className="text-[var(--status-warm)]">{counts.risky} risky</span>
              ) : null}
            </div>
          </div>
          {design.edges.length === 0 ? (
            <span className="text-[11px] text-[var(--text-muted)]">No edges wired</span>
          ) : null}
        </div>

        {/* Ad-hoc point-to-point query */}
        <div className="grid grid-cols-12 gap-1.5 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2">
          <select
            aria-label="Query source node"
            value={srcNodeId}
            onChange={(e) => setSrcNodeId(e.target.value)}
            className="col-span-3 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
          >
            {design.nodes.length === 0 ? <option value="">No nodes</option> : null}
            {design.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Query destination"
            list="reachability-dst-options"
            value={dstTarget}
            onChange={(e) => setDstTarget(e.target.value)}
            placeholder="Node ID, DNS, IP, or internet"
            className="col-span-4 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[11px] text-[var(--text-primary)]"
          />
          <datalist id="reachability-dst-options">
            <option value="internet">internet (public)</option>
            {design.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </datalist>
          <select
            aria-label="Query protocol"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as 'tcp' | 'udp' | 'icmp' | 'any')}
            className="col-span-2 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 font-mono text-[10px] text-[var(--text-primary)]"
          >
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
            <option value="icmp">icmp</option>
            <option value="any">any</option>
          </select>
          <input
            type="number"
            aria-label="Query port"
            min={1}
            max={65535}
            disabled={protocol === 'icmp' || protocol === 'any'}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            className="col-span-2 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] tabular-nums text-[var(--text-primary)] disabled:opacity-40"
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="run-reachability-query-btn"
            onClick={handleRunAdHocQuery}
            disabled={!srcNodeId}
            className="col-span-1 h-7 px-0"
            aria-label="Check reachability"
            title="Check reachability"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>

        {/* Edges table */}
        <div data-testid="reachability-edges-list" className="min-h-0 flex-1 overflow-y-auto p-2">
          {edgeRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-muted)]">
              Connect nodes or run a point-to-point query above.
            </div>
          ) : (
            <div className="space-y-1">
              {edgeRows.map(({ edge, res, srcLabel, dstLabel }) => {
                const isSelected = activeMode === 'edge' && selectedEdgeRow?.edge.id === edge.id;
                const blocked = res ? !res.reachable : false;
                const risky = !blocked && Boolean(res?.riskyReason);
                const mode = res?.failureMode;
                return (
                  <button
                    key={edge.id}
                    type="button"
                    data-testid={`reachability-edge-row-${edge.id}`}
                    onClick={() => {
                      setActiveMode('edge');
                      onSelectEdge(edge.id);
                      setPreviewFixIdx(0);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-left transition-colors ${
                      isSelected
                        ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:bg-[var(--bg-sunken)]'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {blocked ? (
                        <XCircle
                          className="h-3.5 w-3.5 shrink-0 text-[var(--status-overloaded)]"
                          strokeWidth={1.5}
                        />
                      ) : risky ? (
                        <AlertTriangle
                          className="h-3.5 w-3.5 shrink-0 text-[var(--status-warm)]"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <CheckCircle2
                          className="h-3.5 w-3.5 shrink-0 text-[var(--status-ok)]"
                          strokeWidth={1.5}
                        />
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium text-[var(--text-primary)]">
                          {srcLabel} → {dstLabel}
                        </div>
                        <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                          {edge.protocol}
                          {edge.port ? `:${edge.port}` : ''}
                          {blocked && res?.reasonCode ? ` · ${res.reasonCode}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {blocked && mode && mode !== 'none' ? (
                        <span className="rounded bg-[rgba(229,72,77,0.14)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--status-overloaded)]">
                          {FAILURE_MODE_LABEL[mode].badge}
                        </span>
                      ) : risky ? (
                        <span className="rounded bg-[rgba(229,160,13,0.14)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--status-warm)]">
                          Risky
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-[var(--status-ok)]">OK</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Hop trace + Failure mode + Patch diff preview & 1-click fix */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        {appliedBanner ? (
          <div
            data-testid="network-fix-applied-banner"
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px]"
          >
            <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--status-ok)]" strokeWidth={1.5} />
              <span>Applied: {appliedBanner} (undo with Ctrl+Z)</span>
            </div>
            <Button
              variant="primary"
              size="sm"
              data-testid="rerun-after-net-fix-btn"
              disabled={isSimRunning}
              onClick={onRerunVerify}
              className="h-7 px-2.5 text-[11px]"
            >
              <Play className="h-3 w-3" strokeWidth={1.5} />
              <span>{isSimRunning ? 'Running…' : 'Re-run simulation'}</span>
            </Button>
          </div>
        ) : null}

        {!inspectedTarget ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
            Select an edge on the left or run a reachability query to inspect hops and fixes.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Verdict Header */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  {inspectedTarget.result.reachable ? (
                    <CheckCircle2
                      className="h-4 w-4 shrink-0 text-[var(--status-ok)]"
                      strokeWidth={1.5}
                    />
                  ) : (
                    <ShieldAlert
                      className="h-4 w-4 shrink-0 text-[var(--status-overloaded)]"
                      strokeWidth={1.5}
                    />
                  )}
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {inspectedTarget.title}
                  </span>
                  {inspectedTarget.result.reasonCode ? (
                    <span className="rounded bg-[rgba(229,72,77,0.14)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--status-overloaded)]">
                      {inspectedTarget.result.reasonCode}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  {inspectedTarget.subtitle}
                </div>
              </div>

              {inspectedTarget.result.failureMode &&
              inspectedTarget.result.failureMode !== 'none' ? (
                <div
                  data-testid="failure-mode-badge"
                  className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 py-1 text-[10px]"
                >
                  <span className="font-mono font-medium text-[var(--status-overloaded)]">
                    {FAILURE_MODE_LABEL[inspectedTarget.result.failureMode].badge}
                  </span>{' '}
                  <span className="text-[var(--text-secondary)]">
                    — {FAILURE_MODE_LABEL[inspectedTarget.result.failureMode].hint}
                  </span>
                </div>
              ) : null}
            </div>

            <p className="text-[12px] text-[var(--text-secondary)]">
              {inspectedTarget.result.explanation.short}
            </p>

            {/* Hop-by-hop trace */}
            <div
              data-testid="reachability-hop-trace"
              className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5"
            >
              <div className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                Hop evaluation
              </div>
              <div className="space-y-1">
                {inspectedTarget.result.hops.map((hop, idx) => (
                  <div
                    key={`${hop.step}-${hop.objectId}-${idx}`}
                    className="flex items-start gap-2 font-mono text-[11px]"
                  >
                    {hop.verdict === 'allow' ? (
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-ok)]"
                        strokeWidth={1.5}
                      />
                    ) : hop.verdict === 'deny' ? (
                      <X
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-overloaded)]"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <Minus
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                        strokeWidth={1.5}
                      />
                    )}
                    <span className="shrink-0 text-[var(--text-muted)]">{hop.step}</span>
                    <span className="min-w-0 flex-1 text-[var(--text-primary)]">{hop.detail}</span>
                  </div>
                ))}
              </div>
              <details className="mt-2 border-t border-[var(--border-hairline)] pt-1.5">
                <summary className="cursor-pointer select-none text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                  Raw path summary
                </summary>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] leading-4 text-[var(--text-secondary)]">
                  {inspectedTarget.result.explanation.deep}
                </pre>
              </details>
            </div>

            {/* Suggested least-privilege fixes + JSON Patch Diff Preview (T4.5) */}
            {!inspectedTarget.result.reachable && activeFixes.length > 0 ? (
              <div
                data-testid="network-fix-panel"
                className="space-y-2 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-sunken)] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                    <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.5} />
                    <span>Suggested least-privilege fix</span>
                  </div>
                  {activeFixes.length > 1 ? (
                    <div className="flex items-center gap-1">
                      {activeFixes.map((fx, i) => (
                        <button
                          key={fx.label}
                          type="button"
                          onClick={() => setPreviewFixIdx(i)}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            previewFixIdx === i
                              ? 'bg-[var(--bg-raised)] font-medium text-[var(--text-primary)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                          }`}
                        >
                          Option {i + 1}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                {selectedFix ? (
                  <>
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      {selectedFix.label}
                    </div>
                    <div
                      data-testid="network-fix-diff-preview"
                      className="max-h-28 overflow-y-auto rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[10px]"
                    >
                      {diffLines.map((line, i) => (
                        <div
                          key={`${line.path}-${i}`}
                          className={
                            line.kind === 'add'
                              ? 'text-[var(--status-ok)]'
                              : line.kind === 'remove'
                                ? 'text-[var(--status-overloaded)]'
                                : 'text-[var(--accent)]'
                          }
                        >
                          {line.summary}
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        data-testid="apply-network-fix-btn"
                        onClick={handleApplyFix}
                        className="h-7 px-3 text-[11px]"
                      >
                        <Wrench className="h-3 w-3" strokeWidth={1.5} />
                        <span>Apply fix</span>
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
