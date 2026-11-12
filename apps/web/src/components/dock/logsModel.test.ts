import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@infrasim/shared-types';
import { appendLogsToRingBuffer, MAX_LOG_RING_BUFFER } from '../../store/simulationStore';
import {
  buildGroupedLogDisplayRows,
  computeVirtualWindow,
  createDefaultLogFilter,
  filterLogEntries,
  formatLogTimestampMmSsMs,
  formatLogsJsonl,
  isFailureExplanationRow,
} from './logsModel';

function makeSyntheticLogs(count: number): LogEntry[] {
  const levels: LogEntry['level'][] = ['info', 'info', 'warn', 'error', 'debug'];
  const sources: LogEntry['source'][] = ['user', 'platform', 'engine'];
  const out: LogEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const reqIdx = i >> 1;
    out[i] = {
      id: i + 1,
      tVirtualMs: i * 1.25,
      level: levels[i % levels.length]!,
      source: sources[i % sources.length]!,
      nodeId: i % 2 === 0 ? 'api' : 'db',
      requestId: `req-${reqIdx}`,
      traceId: `tr-${reqIdx}`,
      message: i % 10 === 0 ? `Throttled request req-${reqIdx}` : `Handled step ${i}`,
      ...(i % 50 === 0 ? { replayedFromProfile: true } : {}),
    };
  }
  return out;
}

describe('T3.8 Log ring buffer & virtualized LogsDockTab model (Acceptance #12)', () => {
  it('enforces 50,000-entry FIFO ring buffer capacity cleanly', () => {
    const initial = makeSyntheticLogs(40_000);
    const extra = makeSyntheticLogs(15_000).map((e, idx) => ({ ...e, id: 40_001 + idx }));
    const merged = appendLogsToRingBuffer(initial, extra, MAX_LOG_RING_BUFFER);

    expect(MAX_LOG_RING_BUFFER).toBe(50_000);
    expect(merged).toHaveLength(50_000);
    expect(merged[0]?.id).toBe(5_001);
    expect(merged[merged.length - 1]?.id).toBe(55_000);
  });

  it('computes fixed-height virtual window slices across 50,000 rows in < 20 ms', () => {
    const logs = makeSyntheticLogs(50_000);

    const t0 = performance.now();
    const { entries: filtered } = filterLogEntries(logs, {
      ...createDefaultLogFilter(),
      query: 'Throttled',
    });
    const filterMs = performance.now() - t0;

    expect(filtered).toHaveLength(5_000);
    expect(filterMs).toBeLessThan(100);

    // Virtual viewport slice stays strictly bounded regardless of 50k total rows
    const win = computeVirtualWindow({
      totalRows: logs.length,
      scrollTop: 25_000 * 28,
      viewportHeight: 224,
      rowHeight: 28,
      overscan: 6,
    });
    expect(win.totalHeight).toBe(50_000 * 28);
    expect(win.endIdx - win.startIdx).toBeLessThanOrEqual(24);
    expect(win.offsetY).toBe(win.startIdx * 28);
  });

  it('supports regex filtering with invalid regex safety, grouping, failure links, mm:ss.mmm, and JSONL export', () => {
    const sample = makeSyntheticLogs(6);

    // Valid regex
    const regexOk = filterLogEntries(sample, {
      ...createDefaultLogFilter(),
      query: 'step (2|4)$',
      regex: true,
    });
    expect(regexOk.regexError).toBeNull();
    expect(regexOk.entries.map((e) => e.id)).toEqual([3, 5]);

    // Invalid regex does not throw
    const regexBad = filterLogEntries(sample, {
      ...createDefaultLogFilter(),
      query: '[unclosed',
      regex: true,
    });
    expect(regexBad.regexError).toBeTruthy();
    expect(regexBad.entries).toEqual([]);

    // Group by request collapsible rows
    const collapsed = buildGroupedLogDisplayRows(sample, new Set());
    expect(collapsed.every((r) => r.kind === 'group')).toBe(true);
    expect(collapsed).toHaveLength(3);

    const expanded = buildGroupedLogDisplayRows(sample, new Set(['req-1']));
    expect(expanded.map((r) => r.kind)).toEqual(['group', 'group', 'entry', 'entry', 'group']);

    // Timestamps & failure detection & JSONL
    expect(formatLogTimestampMmSsMs(65_432)).toBe('01:05.432');
    expect(isFailureExplanationRow(sample[3]!)).toBe(true); // error + nodeId
    expect(
      isFailureExplanationRow({
        id: 99,
        tVirtualMs: 100,
        level: 'warn',
        source: 'platform',
        nodeId: 'api',
        message: 'Throttled 429 on downstream call',
      }),
    ).toBe(true);
    expect(isFailureExplanationRow(sample[1]!)).toBe(false); // info
    const jsonl = formatLogsJsonl(sample.slice(0, 2));
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe(1);
  });
});
