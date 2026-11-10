'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Skull,
  Snowflake,
} from 'lucide-react';
import type { Design, SimulationResult, Span, Trace } from '@infrasim/shared-types';
import { formatVirtualTime } from '../../lib/timeFormat';

export interface TracesDockTabProps {
  design: Design;
  result: SimulationResult | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string, openWhy?: boolean) => void;
}

type TraceFilter = 'all' | 'errors' | 'slow' | 'ok';

interface OrderedSpanRow {
  span: Span;
  depth: number;
  nodeLabel: string;
}

function buildSpanTreeRows(
  spans: readonly Span[],
  nodeLabelById: ReadonlyMap<string, string>,
): OrderedSpanRow[] {
  const byParent = new Map<string | undefined, Span[]>();
  const spanIds = new Set(spans.map((s) => s.spanId));
  for (const sp of spans) {
    const parentKey = sp.parentId && spanIds.has(sp.parentId) ? sp.parentId : undefined;
    const list = byParent.get(parentKey);
    if (list) {
      list.push(sp);
    } else {
      byParent.set(parentKey, [sp]);
    }
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
  }

  const out: OrderedSpanRow[] = [];
  const visit = (parentId: string | undefined, depth: number) => {
    const children = byParent.get(parentId);
    if (!children) return;
    for (const sp of children) {
      out.push({
        span: sp,
        depth: Math.min(6, depth),
        nodeLabel: nodeLabelById.get(sp.nodeId) ?? sp.nodeId,
      });
      visit(sp.spanId, depth + 1);
    }
  };
  visit(undefined, 0);
  return out;
}

/** Interactive Traces dock panel listing sampled requests with hierarchical waterfall span timing. */
export function TracesDockTab({
  design,
  result,
  selectedNodeId,
  onSelectNode,
}: TracesDockTabProps) {
  const [filter, setFilter] = useState<TraceFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const nodeLabelById = useMemo(
    () => new Map(design.nodes.map((n) => [n.id, n.label])),
    [design.nodes],
  );

  const slowThresholdMs = Math.max(50, result?.summary.p95 ?? 100);

  const filteredTraces = useMemo<Trace[]>(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    return result.traces.filter((trace) => {
      if (filter === 'errors' && trace.status !== 'error') return false;
      if (filter === 'ok' && trace.status !== 'ok') return false;
      if (filter === 'slow' && trace.totalMs < slowThresholdMs) return false;
      if (!q) return true;
      if (trace.traceId.toLowerCase().includes(q)) return true;
      return trace.spans.some((sp) => {
        const label = (nodeLabelById.get(sp.nodeId) ?? sp.nodeId).toLowerCase();
        const op = (sp.operation ?? '').toLowerCase();
        return label.includes(q) || op.includes(q) || sp.status.toLowerCase().includes(q);
      });
    });
  }, [result, filter, query, slowThresholdMs, nodeLabelById]);

  useEffect(() => {
    if (filteredTraces.length === 0) {
      setSelectedTraceId(null);
      return;
    }
    if (!selectedTraceId || !filteredTraces.some((t) => t.traceId === selectedTraceId)) {
      setSelectedTraceId(filteredTraces[0]!.traceId);
    }
  }, [filteredTraces, selectedTraceId]);

  const activeTrace = useMemo(
    () => filteredTraces.find((t) => t.traceId === selectedTraceId) ?? filteredTraces[0] ?? null,
    [filteredTraces, selectedTraceId],
  );

  const orderedRows = useMemo(
    () => (activeTrace ? buildSpanTreeRows(activeTrace.spans, nodeLabelById) : []),
    [activeTrace, nodeLabelById],
  );

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-[12px] text-[var(--text-muted)]">
          Run a simulation to inspect sampled request traces and span waterfalls.
        </p>
      </div>
    );
  }

  if (result.traces.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-[12px] text-[var(--text-muted)]">
          No sampled traces recorded in this run. Verify a connected Load Generator node.
        </p>
      </div>
    );
  }

  const traceDuration = activeTrace ? Math.max(0.5, activeTrace.totalMs) : 1;
  const traceStart = activeTrace ? activeTrace.startMs : 0;

  return (
    <div data-testid="traces-dock-tab" className="flex min-h-0 flex-1 overflow-hidden text-[11px]">
      {/* Left list of sampled traces */}
      <div className="flex w-72 shrink-0 flex-col border-r border-[var(--border-hairline)]">
        <div className="space-y-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
            <input
              type="search"
              aria-label="Filter sampled traces"
              placeholder="Search trace, node, or op"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] pl-7 pr-2 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                ['all', `All (${result.traces.length})`],
                ['errors', 'Errors'],
                ['slow', 'Slow'],
                ['ok', 'OK'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-testid={`traces-filter-${id}`}
                onClick={() => setFilter(id)}
                className={`h-6 rounded-[6px] px-2 text-[10px] font-medium transition-colors ${
                  filter === id
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-[var(--border-hairline)] overflow-y-auto">
          {filteredTraces.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-[var(--text-muted)]">
              No traces match this filter.
            </div>
          ) : (
            filteredTraces.map((trace) => {
              const selected = activeTrace?.traceId === trace.traceId;
              const hasRetries = trace.spans.some((s) => s.attrs?.retried === 1);
              const hasZombie = trace.spans.some((s) => s.attrs?.zombie === 1);
              return (
                <button
                  key={trace.traceId}
                  type="button"
                  data-testid={`trace-list-item-${trace.traceId}`}
                  onClick={() => setSelectedTraceId(trace.traceId)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                    selected ? 'bg-[var(--bg-raised)]' : 'hover:bg-[var(--bg-sunken)]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {trace.status === 'error' ? (
                        <AlertTriangle
                          className="h-3 w-3 shrink-0 text-[var(--status-overloaded)]"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <CheckCircle2
                          className="h-3 w-3 shrink-0 text-[var(--status-ok)]"
                          strokeWidth={1.5}
                        />
                      )}
                      <span className="truncate font-mono text-[11px] font-medium text-[var(--text-primary)]">
                        {trace.traceId}
                      </span>
                      <span className="rounded-[4px] bg-[var(--bg-sunken)] px-1 font-mono text-[9px] text-[var(--text-muted)]">
                        {trace.status === 'error' ? 'Error' : 'OK'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                      <span>@{formatVirtualTime(trace.startMs)}</span>
                      <span>{trace.spans.length} spans</span>
                      {hasRetries ? (
                        <span className="text-[var(--status-warm)]">Retried</span>
                      ) : null}
                      {hasZombie ? <span className="text-[var(--status-warm)]">Zombie</span> : null}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-[11px] font-medium tabular-nums ${
                      trace.status === 'error'
                        ? 'text-[var(--status-overloaded)]'
                        : trace.totalMs >= slowThresholdMs
                          ? 'text-[var(--status-warm)]'
                          : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {trace.totalMs.toFixed(1)} ms
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right Waterfall Timeline */}
      {activeTrace ? (
        <div
          data-testid="trace-waterfall-panel"
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                {activeTrace.traceId}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
                Total: {activeTrace.totalMs.toFixed(2)} ms
              </span>
              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                Started at {formatVirtualTime(activeTrace.startMs)}
              </span>
            </div>

            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2.5 rounded-[2px] bg-[var(--status-warm)] opacity-75" />
                <span>Queue wait</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2.5 rounded-[2px] bg-[var(--accent)]" />
                <span>Service</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2.5 rounded-[2px] bg-[var(--status-overloaded)]" />
                <span>Failed</span>
              </span>
            </div>
          </div>

          {/* Span Rows */}
          <div className="min-h-0 flex-1 divide-y divide-[var(--border-hairline)] overflow-y-auto px-3 py-1.5">
            {orderedRows.map(({ span, depth, nodeLabel }) => {
              const relStart = Math.max(0, span.startMs - traceStart);
              const spanTotal = Math.max(0.05, span.waitMs + span.serviceMs);
              const startPct = Math.max(0, Math.min(98, (relStart / traceDuration) * 100));
              const totalPct = Math.max(
                1.5,
                Math.min(100 - startPct, (spanTotal / traceDuration) * 100),
              );
              const waitShare = spanTotal > 0 ? span.waitMs / spanTotal : 0;
              const waitPct = totalPct * waitShare;
              const servicePct = Math.max(0.5, totalPct - waitPct);

              const isError = span.status !== 'ok';
              const isSelectedNode = selectedNodeId === span.nodeId;
              const retryAttempt =
                span.attrs?.attempt !== undefined ? Number(span.attrs.attempt) : null;
              const isCold = span.attrs?.coldStart === 1;
              const isTimedOut = span.attrs?.timedOut === 1;
              const isZombie = span.attrs?.zombie === 1;

              return (
                <button
                  key={span.spanId}
                  type="button"
                  data-testid={`waterfall-span-${span.spanId}`}
                  onClick={() => onSelectNode(span.nodeId, isError)}
                  className={`grid w-full grid-cols-[minmax(210px,280px)_1fr_115px] items-center gap-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-sunken)] ${
                    isSelectedNode ? 'bg-[var(--bg-raised)]' : ''
                  }`}
                >
                  {/* Node + operation + badges */}
                  <div
                    className="flex min-w-0 items-center gap-1.5"
                    style={{ paddingLeft: `${depth * 14}px` }}
                  >
                    <span className="truncate font-medium text-[var(--text-primary)]">
                      {nodeLabel}
                    </span>
                    {span.operation ? (
                      <span className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                        {span.operation}
                      </span>
                    ) : null}
                    {retryAttempt ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[var(--bg-sunken)] px-1 font-mono text-[9px] text-[var(--status-warm)]">
                        <RefreshCw className="h-2.5 w-2.5" strokeWidth={1.5} />#{retryAttempt}
                      </span>
                    ) : null}
                    {isCold ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[var(--bg-sunken)] px-1 font-mono text-[9px] text-[var(--accent)]">
                        <Snowflake className="h-2.5 w-2.5" strokeWidth={1.5} />
                        Cold
                      </span>
                    ) : null}
                    {isTimedOut ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[rgba(229,72,77,0.14)] px-1 font-mono text-[9px] text-[var(--status-overloaded)]">
                        <Clock className="h-2.5 w-2.5" strokeWidth={1.5} />
                        Timeout
                      </span>
                    ) : null}
                    {isZombie ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-[var(--bg-sunken)] px-1 font-mono text-[9px] text-[var(--status-warm)]">
                        <Skull className="h-2.5 w-2.5" strokeWidth={1.5} />
                        Zombie
                      </span>
                    ) : null}
                    {isError && !isTimedOut ? (
                      <span className="shrink-0 rounded-[4px] bg-[rgba(229,72,77,0.14)] px-1 font-mono text-[9px] text-[var(--status-overloaded)]">
                        {span.status}
                      </span>
                    ) : null}
                  </div>

                  {/* Gantt timeline bar */}
                  <div className="relative h-4 w-full rounded-[3px] bg-[var(--bg-sunken)]">
                    {span.waitMs > 0 ? (
                      <div
                        style={{ left: `${startPct}%`, width: `${Math.max(0.5, waitPct)}%` }}
                        title={`Queue wait: ${span.waitMs.toFixed(2)} ms`}
                        className="absolute bottom-0.5 top-0.5 rounded-l-[2px] bg-[var(--status-warm)] opacity-75"
                      />
                    ) : null}
                    <div
                      style={{
                        left: `${startPct + waitPct}%`,
                        width: `${Math.max(1, servicePct)}%`,
                      }}
                      title={`Service: ${span.serviceMs.toFixed(2)} ms`}
                      className={`absolute bottom-0.5 top-0.5 ${
                        span.waitMs > 0 ? 'rounded-r-[2px]' : 'rounded-[2px]'
                      } ${isError ? 'bg-[var(--status-overloaded)]' : 'bg-[var(--accent)]'}`}
                    />
                  </div>

                  {/* Exact tabular timing */}
                  <div className="text-right font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
                    {span.waitMs > 0.1
                      ? `${span.waitMs.toFixed(0)}+${span.serviceMs.toFixed(1)} ms`
                      : `${span.serviceMs.toFixed(1)} ms`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
