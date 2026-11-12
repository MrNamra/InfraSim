'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Bookmark,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  HelpCircle,
  Info,
  Pause,
  Play,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { Design, LogEntry } from '@infrasim/shared-types';
import {
  LOG_ROW_HEIGHT_PX,
  buildGroupedLogDisplayRows,
  computeVirtualWindow,
  createDefaultLogFilter,
  filterLogEntries,
  formatLogTimestampMmSsMs,
  formatLogsJsonl,
  isFailureExplanationRow,
  type LogDisplayRow,
  type LogFilterState,
  type SavedLogFilterPreset,
} from './logsModel';

const SAVED_FILTERS_STORAGE_KEY = 'infrasim.logs.savedFilters.v1';

export interface LogsDockTabProps {
  design: Design;
  logs: readonly LogEntry[];
  onClearLogs: () => void;
  onJumpToTrace: (traceId: string) => void;
  onJumpToCode: (nodeId: string, line: number, column: number) => void;
  onOpenWhy: (nodeId: string) => void;
}

function loadSavedFilters(): SavedLogFilterPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_FILTERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedLogFilterPreset[]) : [];
  } catch {
    return [];
  }
}

function saveFilterPresets(presets: readonly SavedLogFilterPreset[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SAVED_FILTERS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Ignore storage quota errors
  }
}

function getLevelMeta(level: LogEntry['level']) {
  switch (level) {
    case 'error':
      return {
        label: 'ERR',
        Icon: XCircle,
        textClass: 'text-[var(--status-overloaded)]',
      };
    case 'warn':
      return {
        label: 'WARN',
        Icon: AlertTriangle,
        textClass: 'text-[var(--status-warm)]',
      };
    case 'debug':
      return {
        label: 'DBG',
        Icon: Bug,
        textClass: 'text-[var(--text-muted)]',
      };
    case 'info':
    default:
      return {
        label: 'INFO',
        Icon: Info,
        textClass: 'text-[var(--text-secondary)]',
      };
  }
}

function getSourceBadgeClass(source: LogEntry['source']): string {
  switch (source) {
    case 'user':
      return 'bg-[rgba(99,102,241,0.14)] text-[var(--accent)]';
    case 'platform':
      return 'bg-[rgba(148,163,184,0.16)] text-[var(--text-secondary)]';
    case 'engine':
      return 'bg-[rgba(245,158,11,0.14)] text-[var(--status-warm)]';
  }
}

/** Lazy-loaded Logs bottom dock with 50k virtualized scrolling, grouping, saved filters, and deep links. */
export function LogsDockTab({
  design,
  logs,
  onClearLogs,
  onJumpToTrace,
  onJumpToCode,
  onOpenWhy,
}: LogsDockTabProps) {
  const [filter, setFilter] = useState<LogFilterState>(() => createDefaultLogFilter());
  const [groupByRequest, setGroupByRequest] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [followTail, setFollowTail] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedPresets, setSavedPresets] = useState<SavedLogFilterPreset[]>(() =>
    loadSavedFilters(),
  );

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rafScrollRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(180);

  const nodeLabelById = useMemo(
    () => new Map(design.nodes.map((n) => [n.id, n.label])),
    [design.nodes],
  );

  const { entries: filteredEntries, regexError } = useMemo(
    () => filterLogEntries(logs, filter),
    [logs, filter],
  );

  const displayRows = useMemo<LogDisplayRow[]>(() => {
    if (groupByRequest) {
      return buildGroupedLogDisplayRows(filteredEntries, expandedGroups);
    }
    return filteredEntries.map((entry) => ({
      kind: 'entry',
      entry,
      indented: false,
    }));
  }, [filteredEntries, groupByRequest, expandedGroups]);

  // Track scroll viewport height accurately
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight || 180);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const item of entries) {
        if (item.contentRect.height > 0) {
          setViewportHeight(item.contentRect.height);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow tail when new logs stream in
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!followTail || !el) return;
    const maxTop = Math.max(0, displayRows.length * LOG_ROW_HEIGHT_PX - viewportHeight);
    el.scrollTop = maxTop;
    setScrollTop(maxTop);
  }, [displayRows.length, followTail, viewportHeight]);

  // Clean up pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafScrollRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafScrollRef.current);
      }
    };
  }, []);

  const windowRange = useMemo(
    () =>
      computeVirtualWindow({
        totalRows: displayRows.length,
        scrollTop,
        viewportHeight,
        rowHeight: LOG_ROW_HEIGHT_PX,
      }),
    [displayRows.length, scrollTop, viewportHeight],
  );

  const visibleRows = useMemo(
    () => displayRows.slice(windowRange.startIdx, windowRange.endIdx),
    [displayRows, windowRange.startIdx, windowRange.endIdx],
  );

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (rafScrollRef.current !== null) return;
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      const top = el.scrollTop;
      setScrollTop(top);
      const nearBottom = top + el.clientHeight >= el.scrollHeight - LOG_ROW_HEIGHT_PX * 2;
      if (!nearBottom && followTail) {
        setFollowTail(false);
      }
    });
  };

  const toggleGroupExpanded = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const handleSavePreset = () => {
    const label =
      filter.query.trim() ||
      (filter.level !== 'all' ? filter.level : '') ||
      (filter.source !== 'all' ? filter.source : '') ||
      `Filter ${savedPresets.length + 1}`;
    const preset: SavedLogFilterPreset = {
      id: `preset-${Date.now()}`,
      name: label.slice(0, 24),
      filter: { ...filter },
    };
    const next = [...savedPresets.slice(-9), preset];
    setSavedPresets(next);
    saveFilterPresets(next);
  };

  const handleDownloadJsonl = () => {
    const content = formatLogsJsonl(filteredEntries);
    const blob = new Blob([content], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `infrasim-logs-${design.id}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyEntry = async (entry: LogEntry) => {
    const text = JSON.stringify(entry, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      const key = `${entry.id}-${entry.tVirtualMs}`;
      setCopiedId(key);
      setTimeout(() => setCopiedId((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      // Clipboard API unavailable in headless test context
    }
  };

  const distinctNodeIds = useMemo(() => {
    const ids = new Set<string>(design.nodes.map((n) => n.id));
    for (const l of logs) {
      if (l.nodeId) ids.add(l.nodeId);
    }
    return Array.from(ids);
  }, [design.nodes, logs]);

  return (
    <div
      data-testid="logs-dock-tab"
      className="flex min-h-0 flex-1 flex-col overflow-hidden text-[11px]"
    >
      {/* Filter & action bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-1.5">
        <select
          aria-label="Filter log level"
          data-testid="logs-filter-level"
          value={filter.level}
          onChange={(e) =>
            setFilter((prev) => ({
              ...prev,
              level: e.target.value as LogFilterState['level'],
            }))
          }
          className="h-6 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
        >
          <option value="all">All levels</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>

        <select
          aria-label="Filter log source"
          data-testid="logs-filter-source"
          value={filter.source}
          onChange={(e) =>
            setFilter((prev) => ({
              ...prev,
              source: e.target.value as LogFilterState['source'],
            }))
          }
          className="h-6 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
        >
          <option value="all">All sources</option>
          <option value="user">User</option>
          <option value="platform">Platform</option>
          <option value="engine">Engine</option>
        </select>

        <select
          aria-label="Filter log node"
          data-testid="logs-filter-node"
          value={filter.nodeId}
          onChange={(e) => setFilter((prev) => ({ ...prev, nodeId: e.target.value }))}
          className="h-6 max-w-[140px] rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
        >
          <option value="all">All nodes</option>
          {distinctNodeIds.map((nid) => (
            <option key={nid} value={nid}>
              {nodeLabelById.get(nid) ?? nid}
            </option>
          ))}
        </select>

        <input
          type="text"
          aria-label="Filter by request or trace ID"
          data-testid="logs-filter-request"
          placeholder="Request ID"
          value={filter.requestId}
          onChange={(e) => setFilter((prev) => ({ ...prev, requestId: e.target.value }))}
          className="h-6 w-28 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
        />

        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2 h-3 w-3 text-[var(--text-muted)]"
            strokeWidth={1.5}
          />
          <input
            type="search"
            aria-label="Search log messages"
            data-testid="logs-search-input"
            placeholder="Search logs"
            value={filter.query}
            onChange={(e) => setFilter((prev) => ({ ...prev, query: e.target.value }))}
            className="h-6 w-40 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] pl-6 pr-2 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <button
          type="button"
          aria-pressed={filter.regex}
          title="Toggle regular expression search"
          data-testid="logs-regex-toggle"
          onClick={() => setFilter((prev) => ({ ...prev, regex: !prev.regex }))}
          className={`h-6 rounded-[5px] border px-1.5 font-mono text-[10px] ${
            filter.regex
              ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          .*
        </button>

        {savedPresets.length > 0 ? (
          <select
            aria-label="Apply saved log filter"
            value=""
            onChange={(e) => {
              const preset = savedPresets.find((p) => p.id === e.target.value);
              if (preset) setFilter({ ...preset.filter });
            }}
            className="h-6 max-w-[116px] rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[10px] text-[var(--text-secondary)]"
          >
            <option value="">Saved filters</option>
            {savedPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          title="Save current filter preset"
          onClick={handleSavePreset}
          className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Bookmark className="h-3 w-3" strokeWidth={1.5} />
          <span>Save filter</span>
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
            {filteredEntries.length.toLocaleString()} / {logs.length.toLocaleString()}
          </span>

          <button
            type="button"
            aria-pressed={groupByRequest}
            data-testid="logs-group-toggle"
            onClick={() => setGroupByRequest((v) => !v)}
            className={`h-6 rounded-[5px] border px-2 text-[10px] font-medium ${
              groupByRequest
                ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Group by request
          </button>

          <button
            type="button"
            aria-pressed={followTail}
            data-testid="logs-follow-toggle"
            onClick={() => setFollowTail((v) => !v)}
            className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-[10px] ${
              followTail
                ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
            }`}
          >
            {followTail ? (
              <Play className="h-2.5 w-2.5" strokeWidth={1.5} />
            ) : (
              <Pause className="h-2.5 w-2.5" strokeWidth={1.5} />
            )}
            <span>{followTail ? 'Follow tail' : 'Paused'}</span>
          </button>

          <button
            type="button"
            title="Download filtered logs as JSONL"
            data-testid="logs-download-jsonl"
            disabled={filteredEntries.length === 0}
            onClick={handleDownloadJsonl}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <Download className="h-3 w-3" strokeWidth={1.5} />
            <span>.jsonl</span>
          </button>

          <button
            type="button"
            title="Clear logs"
            data-testid="logs-clear-btn"
            disabled={logs.length === 0}
            onClick={() => {
              setSelectedEntry(null);
              onClearLogs();
            }}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--status-overloaded)] disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {regexError ? (
        <div className="shrink-0 border-b border-[rgba(229,72,77,0.3)] bg-[rgba(229,72,77,0.08)] px-3 py-1 text-[10px] text-[var(--status-overloaded)]">
          Invalid regex: {regexError}
        </div>
      ) : null}

      {/* Main split: virtualized log table + optional selected row JSON inspector */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Column header */}
          <div className="grid h-6 shrink-0 grid-cols-[72px_58px_66px_110px_88px_1fr_auto] items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 text-[10px] font-medium text-[var(--text-muted)]">
            <span>Time</span>
            <span>Level</span>
            <span>Source</span>
            <span>Node</span>
            <span>Request</span>
            <span>Message</span>
            <span />
          </div>

          {displayRows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-4 text-center">
              <p className="text-[12px] text-[var(--text-muted)]">
                {logs.length === 0
                  ? 'Run a simulation or handler dry run to view user, platform, and engine logs.'
                  : 'No log entries match the active filters.'}
              </p>
            </div>
          ) : (
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              data-testid="logs-virtual-viewport"
              className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]"
            >
              <div style={{ height: windowRange.totalHeight, position: 'relative' }}>
                <div
                  style={{
                    transform: `translateY(${windowRange.offsetY}px)`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                  }}
                >
                  {visibleRows.map((row, localIdx) => {
                    const rowIndex = windowRange.startIdx + localIdx;
                    if (row.kind === 'group') {
                      const StatusIcon =
                        row.status === 'error'
                          ? XCircle
                          : row.status === 'warn'
                            ? AlertTriangle
                            : ArrowDownToLine;
                      const statusTone =
                        row.status === 'error'
                          ? 'text-[var(--status-overloaded)]'
                          : row.status === 'warn'
                            ? 'text-[var(--status-warm)]'
                            : 'text-[var(--status-ok)]';
                      return (
                        <button
                          key={`group:${row.groupKey}`}
                          type="button"
                          onClick={() => toggleGroupExpanded(row.groupKey)}
                          style={{ height: LOG_ROW_HEIGHT_PX }}
                          className="flex w-full items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 text-left hover:bg-[var(--bg-raised)]"
                        >
                          {row.expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                          )}
                          <span className="w-[62px] shrink-0 tabular-nums text-[var(--text-muted)]">
                            {formatLogTimestampMmSsMs(row.firstTimeMs)}
                          </span>
                          <StatusIcon
                            className={`h-3.5 w-3.5 shrink-0 ${statusTone}`}
                            strokeWidth={1.5}
                          />
                          <span className="truncate font-medium text-[var(--text-primary)]">
                            {row.groupKey}
                          </span>
                          <span className="rounded-[4px] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text-secondary)]">
                            {row.count} lines · {row.durationMs.toFixed(1)} ms
                          </span>
                          {row.nodeId ? (
                            <span className="truncate text-[10px] text-[var(--text-muted)]">
                              {nodeLabelById.get(row.nodeId) ?? row.nodeId}
                            </span>
                          ) : null}
                          {row.replayed ? (
                            <span className="ml-auto rounded-[4px] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                              replayed
                            </span>
                          ) : null}
                        </button>
                      );
                    }

                    const entry = row.entry;
                    const levelMeta = getLevelMeta(entry.level);
                    const LevelIcon = levelMeta.Icon;
                    const isSelected =
                      selectedEntry?.id === entry.id &&
                      selectedEntry.tVirtualMs === entry.tVirtualMs &&
                      selectedEntry.message === entry.message;
                    const isFailure = isFailureExplanationRow(entry);
                    const reqLabel = entry.requestId ?? entry.traceId ?? '—';

                    return (
                      <div
                        key={`row:${rowIndex}:${entry.id}:${entry.source}:${entry.tVirtualMs}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedEntry(entry)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedEntry(entry);
                          }
                        }}
                        style={{ height: LOG_ROW_HEIGHT_PX }}
                        className={`grid cursor-pointer grid-cols-[72px_58px_66px_110px_88px_1fr_auto] items-center gap-2 border-b border-[var(--border-hairline)] px-3 transition-colors ${
                          row.indented ? 'pl-7' : ''
                        } ${
                          isSelected
                            ? 'bg-[var(--bg-raised)]'
                            : isFailure
                              ? 'bg-[rgba(229,72,77,0.05)] hover:bg-[rgba(229,72,77,0.09)]'
                              : 'hover:bg-[var(--bg-sunken)]'
                        }`}
                      >
                        <span className="truncate tabular-nums text-[var(--text-muted)]">
                          {formatLogTimestampMmSsMs(entry.tVirtualMs)}
                        </span>
                        <span className={`inline-flex items-center gap-1 ${levelMeta.textClass}`}>
                          <LevelIcon className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                          <span className="text-[10px] font-medium">{levelMeta.label}</span>
                        </span>
                        <span
                          className={`inline-flex w-fit items-center rounded-[4px] px-1.5 py-0.5 text-[10px] ${getSourceBadgeClass(
                            entry.source,
                          )}`}
                        >
                          {entry.source}
                        </span>
                        <span className="truncate text-[var(--text-secondary)]">
                          {entry.nodeId
                            ? (nodeLabelById.get(entry.nodeId) ?? entry.nodeId)
                            : 'system'}
                        </span>
                        <span
                          className="truncate text-[10px] text-[var(--text-muted)]"
                          title={reqLabel}
                        >
                          {reqLabel.length > 10 ? reqLabel.slice(0, 10) : reqLabel}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-[var(--text-primary)]">
                          {entry.replayedFromProfile ? (
                            <span
                              title="Replayed from profile run"
                              className="shrink-0 rounded-[4px] bg-[var(--bg-sunken)] px-1 text-[9px] text-[var(--text-muted)]"
                            >
                              replayed
                            </span>
                          ) : null}
                          <span className="truncate">{entry.message}</span>
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          {isFailure && entry.nodeId ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenWhy(entry.nodeId!);
                              }}
                              className="inline-flex h-5 items-center gap-0.5 rounded-[4px] border border-[rgba(229,72,77,0.35)] bg-[var(--bg-surface)] px-1.5 text-[10px] font-medium text-[var(--status-overloaded)] hover:bg-[var(--bg-raised)]"
                            >
                              <HelpCircle className="h-2.5 w-2.5" strokeWidth={1.5} />
                              <span>Why?</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Selected Log Inspector Drawer */}
        {selectedEntry ? (
          <div
            data-testid="log-entry-inspector"
            className="flex w-72 shrink-0 flex-col border-l border-[var(--border-hairline)] bg-[var(--bg-sunken)]"
          >
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-3 py-2">
              <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                Log details
              </span>
              <button
                type="button"
                aria-label="Close log inspector"
                onClick={() => setSelectedEntry(null)}
                className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 text-[11px]">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                  <span>t = {formatLogTimestampMmSsMs(selectedEntry.tVirtualMs)}</span>
                  <span className="uppercase">{selectedEntry.source}</span>
                </div>
                <p className="break-words font-mono text-[11px] leading-4 text-[var(--text-primary)]">
                  {selectedEntry.message}
                </p>
                {selectedEntry.replayedFromProfile ? (
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Replayed from profile sample
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleCopyEntry(selectedEntry)}
                  className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {copiedId === `${selectedEntry.id}-${selectedEntry.tVirtualMs}` ? (
                    <Check className="h-3 w-3 text-[var(--status-ok)]" strokeWidth={1.5} />
                  ) : (
                    <Copy className="h-3 w-3" strokeWidth={1.5} />
                  )}
                  <span>
                    {copiedId === `${selectedEntry.id}-${selectedEntry.tVirtualMs}`
                      ? 'Copied'
                      : 'Copy row'}
                  </span>
                </button>

                {selectedEntry.traceId ? (
                  <button
                    type="button"
                    data-testid="log-jump-to-trace"
                    onClick={() => onJumpToTrace(selectedEntry.traceId!)}
                    className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--accent)] hover:border-[var(--border-strong)]"
                  >
                    <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                    <span>Jump to trace</span>
                  </button>
                ) : null}

                {selectedEntry.site && selectedEntry.nodeId ? (
                  <button
                    type="button"
                    data-testid="log-jump-to-code"
                    onClick={() =>
                      onJumpToCode(
                        selectedEntry.nodeId!,
                        selectedEntry.site!.line,
                        selectedEntry.site!.col,
                      )
                    }
                    className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--accent)] hover:border-[var(--border-strong)]"
                  >
                    <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                    <span>Jump to code :{selectedEntry.site.line}</span>
                  </button>
                ) : null}

                {isFailureExplanationRow(selectedEntry) && selectedEntry.nodeId ? (
                  <button
                    type="button"
                    onClick={() => onOpenWhy(selectedEntry.nodeId!)}
                    className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[rgba(229,72,77,0.35)] bg-[var(--bg-surface)] px-2 text-[10px] font-medium text-[var(--status-overloaded)]"
                  >
                    <HelpCircle className="h-3 w-3" strokeWidth={1.5} />
                    <span>Why?</span>
                  </button>
                ) : null}
              </div>

              {selectedEntry.data !== undefined ? (
                <div className="space-y-1 border-t border-[var(--border-hairline)] pt-2">
                  <div className="text-[10px] font-medium text-[var(--text-muted)]">
                    Data payload
                  </div>
                  <pre className="max-h-36 overflow-auto rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[10px] text-[var(--text-primary)]">
                    {JSON.stringify(selectedEntry.data, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
