import type { LogEntry } from '@infrasim/shared-types';

export const LOG_ROW_HEIGHT_PX = 28;
export const LOG_OVERSCAN_ROWS = 8;

export interface LogFilterState {
  level: 'all' | LogEntry['level'];
  source: 'all' | LogEntry['source'];
  nodeId: 'all' | string;
  requestId: string;
  query: string;
  regex: boolean;
}

export interface SavedLogFilterPreset {
  id: string;
  name: string;
  filter: LogFilterState;
}

export type LogDisplayRow =
  | {
      kind: 'group';
      groupKey: string;
      firstTimeMs: number;
      durationMs: number;
      count: number;
      status: 'ok' | 'error' | 'warn';
      nodeId?: string;
      traceId?: string;
      replayed: boolean;
      expanded: boolean;
    }
  | {
      kind: 'entry';
      entry: LogEntry;
      indented: boolean;
    };

export interface VirtualWindowRange {
  startIdx: number;
  endIdx: number;
  offsetY: number;
  totalHeight: number;
}

export function createDefaultLogFilter(): LogFilterState {
  return {
    level: 'all',
    source: 'all',
    nodeId: 'all',
    requestId: '',
    query: '',
    regex: false,
  };
}

/** Formats virtual milliseconds as fixed-width `mm:ss.mmm` for log columns. */
export function formatLogTimestampMmSsMs(tVirtualMs: number): string {
  const safeMs = Math.max(0, Math.round(tVirtualMs));
  const totalSec = Math.floor(safeMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const ms = safeMs % 1000;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Identifies failure/degradation log rows that warrant an inline "Why?" shortcut. */
export function isFailureExplanationRow(entry: LogEntry): boolean {
  if (!entry.nodeId) return false;
  if (entry.level === 'error') return true;
  if (entry.level === 'warn') {
    return /throttl|timeout|timed out|drop|overload|queue full|circuit|unhealthy|429|503|504/i.test(
      entry.message,
    );
  }
  return false;
}

/** Filters log entries synchronously across level, source, node, requestId, and text/regex query. */
export function filterLogEntries(
  logs: readonly LogEntry[],
  filter: LogFilterState,
): { entries: LogEntry[]; regexError: string | null } {
  const reqNeedle = filter.requestId.trim().toLowerCase();
  const queryNeedle = filter.query.trim();
  let regexMatcher: RegExp | null = null;
  let regexError: string | null = null;

  if (queryNeedle && filter.regex) {
    try {
      regexMatcher = new RegExp(queryNeedle, 'i');
    } catch (err) {
      regexError = err instanceof Error ? err.message : 'Invalid regular expression';
      return { entries: [], regexError };
    }
  }

  const lowerQuery = queryNeedle.toLowerCase();
  const hasAnyFilter =
    filter.level !== 'all' ||
    filter.source !== 'all' ||
    filter.nodeId !== 'all' ||
    reqNeedle.length > 0 ||
    queryNeedle.length > 0;

  if (!hasAnyFilter) {
    return { entries: logs as LogEntry[], regexError: null };
  }

  const out: LogEntry[] = [];
  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i]!;
    if (filter.level !== 'all' && entry.level !== filter.level) continue;
    if (filter.source !== 'all' && entry.source !== filter.source) continue;
    if (filter.nodeId !== 'all' && entry.nodeId !== filter.nodeId) continue;

    if (reqNeedle) {
      const req = (entry.requestId ?? '').toLowerCase();
      const tr = (entry.traceId ?? '').toLowerCase();
      if (!req.includes(reqNeedle) && !tr.includes(reqNeedle)) continue;
    }

    if (queryNeedle) {
      if (regexMatcher) {
        if (!regexMatcher.test(entry.message)) continue;
      } else if (!entry.message.toLowerCase().includes(lowerQuery)) {
        continue;
      }
    }

    out.push(entry);
  }
  return { entries: out, regexError: null };
}

/** Groups log entries by `requestId ?? traceId ?? system` into virtualizable header/child rows. */
export function buildGroupedLogDisplayRows(
  entries: readonly LogEntry[],
  expandedGroupKeys: ReadonlySet<string>,
): LogDisplayRow[] {
  const groups = new Map<
    string,
    {
      groupKey: string;
      entries: LogEntry[];
      minMs: number;
      maxMs: number;
      status: 'ok' | 'error' | 'warn';
      nodeId?: string;
      traceId?: string;
      replayed: boolean;
    }
  >();

  for (const entry of entries) {
    const key = entry.requestId ?? entry.traceId ?? 'system';
    let g = groups.get(key);
    if (!g) {
      g = {
        groupKey: key,
        entries: [],
        minMs: entry.tVirtualMs,
        maxMs: entry.tVirtualMs,
        status: 'ok',
        ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
        ...(entry.traceId ? { traceId: entry.traceId } : {}),
        replayed: Boolean(entry.replayedFromProfile),
      };
      groups.set(key, g);
    }
    g.entries.push(entry);
    if (entry.tVirtualMs < g.minMs) g.minMs = entry.tVirtualMs;
    if (entry.tVirtualMs > g.maxMs) g.maxMs = entry.tVirtualMs;
    if (entry.level === 'error') {
      g.status = 'error';
    } else if (entry.level === 'warn' && g.status !== 'error') {
      g.status = 'warn';
    }
    if (!g.nodeId && entry.nodeId) g.nodeId = entry.nodeId;
    if (!g.traceId && entry.traceId) g.traceId = entry.traceId;
    if (entry.replayedFromProfile) g.replayed = true;
  }

  const out: LogDisplayRow[] = [];
  for (const g of groups.values()) {
    const expanded = expandedGroupKeys.has(g.groupKey);
    out.push({
      kind: 'group',
      groupKey: g.groupKey,
      firstTimeMs: g.minMs,
      durationMs: Math.max(0, Number((g.maxMs - g.minMs).toFixed(2))),
      count: g.entries.length,
      status: g.status,
      ...(g.nodeId ? { nodeId: g.nodeId } : {}),
      ...(g.traceId ? { traceId: g.traceId } : {}),
      replayed: g.replayed,
      expanded,
    });
    if (expanded) {
      for (const entry of g.entries) {
        out.push({
          kind: 'entry',
          entry,
          indented: true,
        });
      }
    }
  }
  return out;
}

/** Computes visible row slice bounds in O(1) for fixed-height virtual scrolling. */
export function computeVirtualWindow(params: {
  totalRows: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight?: number;
  overscan?: number;
}): VirtualWindowRange {
  const rowHeight = Math.max(1, params.rowHeight ?? LOG_ROW_HEIGHT_PX);
  const overscan = Math.max(0, params.overscan ?? LOG_OVERSCAN_ROWS);
  const totalHeight = params.totalRows * rowHeight;
  if (params.totalRows <= 0) {
    return { startIdx: 0, endIdx: 0, offsetY: 0, totalHeight: 0 };
  }
  const viewportHeight = Math.max(rowHeight, params.viewportHeight);
  const rawStart = Math.floor(Math.max(0, params.scrollTop) / rowHeight);
  const startIdx = Math.max(0, rawStart - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const endIdx = Math.min(params.totalRows, startIdx + visibleCount);
  return {
    startIdx,
    endIdx,
    offsetY: startIdx * rowHeight,
    totalHeight,
  };
}

/** Serializes filtered logs into newline-delimited JSONL for export. */
export function formatLogsJsonl(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
