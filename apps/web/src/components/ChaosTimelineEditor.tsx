'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Flame, Plus, Trash2 } from 'lucide-react';
import type { ChaosEvent, GroupInstance, NodeInstance, Scenario } from '@infrasim/shared-types';

export interface ChaosTimelineEditorProps {
  scenario: Scenario;
  nodes: readonly NodeInstance[];
  groups: readonly GroupInstance[];
  preselectedNodeId?: string | null;
  preselectedAz?: string | null;
  onUpdateScenario: (updater: (scenario: Scenario) => void) => void;
}

const CHAOS_KIND_LABELS: Record<ChaosEvent['kind'], string> = {
  'add-latency': 'Add latency',
  'error-rate': 'Error rate',
  throttle: 'Rate throttle',
  'kill-instances': 'Kill instances',
  'az-outage': 'AZ outage',
  'cache-flush': 'Cache flush',
};

function defaultTargetNodeId(nodes: readonly NodeInstance[], preferredId?: string | null): string {
  if (preferredId && nodes.some((n) => n.id === preferredId)) {
    return preferredId;
  }
  const nonClient = nodes.find(
    (n) => n.serviceId !== 'generic.client' && n.serviceId !== 'generic.users',
  );
  return nonClient?.id ?? nodes[0]?.id ?? '';
}

function defaultAzValue(
  nodes: readonly NodeInstance[],
  groups: readonly GroupInstance[],
  preferredAz?: string | null,
): string {
  if (preferredAz && preferredAz.trim() !== '') {
    return preferredAz.trim();
  }
  const nodeAz = nodes.find((n) => n.az && n.az.trim() !== '')?.az?.trim();
  if (nodeAz) return nodeAz;
  const azGroup = groups.find((g) => g.kind === 'az')?.label?.trim();
  return azGroup || 'az-a';
}

function buildChaosEvent(
  kind: ChaosEvent['kind'],
  atS: number,
  durationS: number,
  nodeId: string,
  az: string,
): ChaosEvent {
  switch (kind) {
    case 'add-latency':
      return { atS, durationS, kind, nodeId, extraMs: 250 };
    case 'error-rate':
      return { atS, durationS, kind, nodeId, rate: 0.25 };
    case 'throttle':
      return { atS, durationS, kind, nodeId, rps: 50 };
    case 'kill-instances':
      return { atS, durationS, kind, nodeId, count: 1 };
    case 'az-outage':
      return { atS, durationS, kind, az };
    case 'cache-flush':
      return { atS, durationS, kind, nodeId, warmupS: Math.max(5, Math.min(30, durationS)) };
  }
}

function validateChaosEvent(ev: ChaosEvent, scenarioDurationS: number): string[] {
  const issues: string[] = [];
  if (!Number.isFinite(ev.atS) || ev.atS < 0) {
    issues.push('Start second must be 0 or greater.');
  }
  if (!Number.isFinite(ev.durationS) || ev.durationS <= 0) {
    issues.push('Duration must be greater than 0 s.');
  }
  if (ev.atS + ev.durationS > scenarioDurationS) {
    issues.push(
      `Window ends at ${ev.atS + ev.durationS}s past scenario duration (${scenarioDurationS}s).`,
    );
  }
  if (ev.kind === 'error-rate' && (ev.rate < 0 || ev.rate > 1)) {
    issues.push('Error rate must be between 0 and 1.');
  }
  if (ev.kind === 'add-latency' && ev.extraMs < 0) {
    issues.push('Added latency must be 0 ms or greater.');
  }
  if (ev.kind === 'kill-instances' && ev.count < 1) {
    issues.push('Instances to kill must be at least 1.');
  }
  if (ev.kind === 'throttle' && ev.rps < 0) {
    issues.push('Throttle RPS must be 0 or greater.');
  }
  if (ev.kind === 'az-outage' && !ev.az.trim()) {
    issues.push('AZ identifier is required.');
  } else if (ev.kind !== 'az-outage' && !ev.nodeId) {
    issues.push('Select a target node.');
  }
  return issues;
}

/** Scenario chaos fault timeline strip & editor supporting all six deterministic fault kinds. */
export function ChaosTimelineEditor({
  scenario,
  nodes,
  groups,
  preselectedNodeId,
  preselectedAz,
  onUpdateScenario,
}: ChaosTimelineEditorProps) {
  const [selectedIdx, setSelectedIdx] = useState<number>(0);

  useEffect(() => {
    if (scenario.chaos.length === 0) {
      setSelectedIdx(0);
    } else if (selectedIdx >= scenario.chaos.length) {
      setSelectedIdx(scenario.chaos.length - 1);
    }
  }, [scenario.chaos.length, selectedIdx]);

  const targetNodes = useMemo(
    () => nodes.filter((n) => n.serviceId !== 'generic.client' && n.serviceId !== 'generic.users'),
    [nodes],
  );
  const selectableNodes = targetNodes.length > 0 ? targetNodes : nodes;
  const knownAzs = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      if (n.az?.trim()) set.add(n.az.trim());
    }
    for (const g of groups) {
      if (g.kind === 'az' && g.label.trim()) set.add(g.label.trim());
    }
    if (set.size === 0) {
      set.add('az-a');
      set.add('az-b');
    }
    return [...set];
  }, [nodes, groups]);

  const durationS = Math.max(1, scenario.durationS);
  const activeEvent = scenario.chaos[selectedIdx] ?? null;
  const activeIssues = activeEvent ? validateChaosEvent(activeEvent, durationS) : [];

  const handleAddChaos = (kind: ChaosEvent['kind'] = 'add-latency') => {
    const startAt = Math.min(Math.max(0, durationS - 2), Math.round(durationS * 0.25));
    const spanDur = Math.max(1, Math.min(durationS - startAt, Math.round(durationS * 0.25)));
    const nextNodeId = defaultTargetNodeId(selectableNodes, preselectedNodeId);
    const nextAz = defaultAzValue(nodes, groups, preselectedAz);
    const nextEv = buildChaosEvent(kind, startAt, spanDur, nextNodeId, nextAz);
    const nextIdx = scenario.chaos.length;
    onUpdateScenario((s) => {
      s.chaos.push(nextEv);
    });
    setSelectedIdx(nextIdx);
  };

  return (
    <div data-testid="chaos-timeline-editor" className="space-y-3 text-[12px]">
      {/* Timeline bar */}
      <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
        <div className="mb-2 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
          <span>Chaos windows (0–{durationS}s)</span>
          <span className="font-mono tabular-nums">{scenario.chaos.length} scheduled</span>
        </div>

        <div className="relative h-7 w-full overflow-hidden rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
          {scenario.chaos.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[10px] text-[var(--text-muted)]">
              No chaos events configured
            </div>
          ) : (
            scenario.chaos.map((ev, idx) => {
              const leftPct = Math.max(0, Math.min(100, (ev.atS / durationS) * 100));
              const rightPct = Math.max(
                leftPct + 2,
                Math.min(100, ((ev.atS + Math.max(0.5, ev.durationS)) / durationS) * 100),
              );
              const selected = idx === selectedIdx;
              const nodeLabel =
                ev.kind === 'az-outage'
                  ? ev.az
                  : (nodes.find((n) => n.id === ev.nodeId)?.label ?? ev.nodeId);
              return (
                <button
                  key={idx}
                  type="button"
                  data-testid={`chaos-window-pill-${idx}`}
                  onClick={() => setSelectedIdx(idx)}
                  title={`${CHAOS_KIND_LABELS[ev.kind]} on ${nodeLabel} (${ev.atS}s–${ev.atS + ev.durationS}s)`}
                  style={{ left: `${leftPct}%`, width: `${Math.max(4, rightPct - leftPct)}%` }}
                  className={`absolute bottom-1 top-1 flex items-center overflow-hidden rounded-[4px] border px-1 font-mono text-[10px] tabular-nums transition-colors ${
                    selected
                      ? 'border-[var(--status-warm)] bg-[rgba(229,160,13,0.18)] text-[var(--text-primary)]'
                      : 'border-[var(--border-strong)] bg-[rgba(229,160,13,0.09)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span className="truncate">{CHAOS_KIND_LABELS[ev.kind]}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="add-chaos-event-btn"
            onClick={() => handleAddChaos('add-latency')}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Add chaos event</span>
          </button>
          {preselectedNodeId ? (
            <span className="truncate font-mono text-[10px] text-[var(--text-muted)]">
              Target: {nodes.find((n) => n.id === preselectedNodeId)?.label ?? preselectedNodeId}
            </span>
          ) : null}
        </div>
      </div>

      {/* Event list / selector when > 1 */}
      {scenario.chaos.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {scenario.chaos.map((ev, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setSelectedIdx(idx)}
              className={`rounded-[6px] border px-2 py-1 font-mono text-[10px] tabular-nums transition-colors ${
                idx === selectedIdx
                  ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-muted)]'
              }`}
            >
              #{idx + 1} {CHAOS_KIND_LABELS[ev.kind]} ({ev.atS}s)
            </button>
          ))}
        </div>
      ) : null}

      {/* Selected Event Form */}
      {activeEvent ? (
        <div
          data-testid="chaos-event-form"
          className="space-y-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
              <Flame className="h-3.5 w-3.5 text-[var(--text-secondary)]" strokeWidth={1.5} />
              <span>Chaos event #{selectedIdx + 1}</span>
            </span>
            <button
              type="button"
              data-testid="delete-chaos-event-btn"
              onClick={() => {
                onUpdateScenario((s) => {
                  s.chaos.splice(selectedIdx, 1);
                });
                setSelectedIdx((prev) => Math.max(0, prev - 1));
              }}
              aria-label="Remove chaos event"
              className="inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[10px] text-[var(--status-overloaded)] hover:bg-[rgba(229,72,77,0.12)]"
            >
              <Trash2 className="h-3 w-3" strokeWidth={1.5} />
              <span>Remove</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Fault kind</span>
              <select
                aria-label="Chaos fault kind"
                data-testid="chaos-kind-select"
                value={activeEvent.kind}
                onChange={(e) => {
                  const nextKind = e.target.value as ChaosEvent['kind'];
                  const nid =
                    'nodeId' in activeEvent
                      ? activeEvent.nodeId
                      : defaultTargetNodeId(selectableNodes, preselectedNodeId);
                  const azVal =
                    activeEvent.kind === 'az-outage'
                      ? activeEvent.az
                      : defaultAzValue(nodes, groups, preselectedAz);
                  onUpdateScenario((s) => {
                    s.chaos[selectedIdx] = buildChaosEvent(
                      nextKind,
                      activeEvent.atS,
                      activeEvent.durationS,
                      nid,
                      azVal,
                    );
                  });
                }}
                className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
              >
                {(Object.keys(CHAOS_KIND_LABELS) as ChaosEvent['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {CHAOS_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>

            {activeEvent.kind === 'az-outage' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Availability zone</span>
                <input
                  type="text"
                  aria-label="Chaos target AZ"
                  list="infrasim-chaos-az-list"
                  value={activeEvent.az}
                  onChange={(e) => {
                    const val = e.target.value;
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'az-outage') ev.az = val;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                />
                <datalist id="infrasim-chaos-az-list">
                  {knownAzs.map((az) => (
                    <option key={az} value={az} />
                  ))}
                </datalist>
              </label>
            ) : (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Target node</span>
                <select
                  aria-label="Chaos target node"
                  data-testid="chaos-node-select"
                  value={activeEvent.nodeId}
                  onChange={(e) => {
                    const nextNodeId = e.target.value;
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev && ev.kind !== 'az-outage') {
                        ev.nodeId = nextNodeId;
                      }
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
                >
                  {selectableNodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Start (s)</span>
              <input
                type="number"
                aria-label="Chaos start second"
                data-testid="chaos-at-input"
                value={activeEvent.atS}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onUpdateScenario((s) => {
                    const ev = s.chaos[selectedIdx];
                    if (ev) ev.atS = Number.isFinite(v) ? v : 0;
                  });
                }}
                className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Duration (s)</span>
              <input
                type="number"
                aria-label="Chaos duration seconds"
                data-testid="chaos-duration-input"
                value={activeEvent.durationS}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onUpdateScenario((s) => {
                    const ev = s.chaos[selectedIdx];
                    if (ev) ev.durationS = Number.isFinite(v) ? v : 1;
                  });
                }}
                className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            {activeEvent.kind === 'add-latency' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Extra (ms)</span>
                <input
                  type="number"
                  aria-label="Extra latency ms"
                  data-testid="chaos-param-input"
                  value={activeEvent.extraMs}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'add-latency') ev.extraMs = Number.isFinite(v) ? v : 0;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            ) : activeEvent.kind === 'error-rate' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Rate (0–1)</span>
                <input
                  type="number"
                  step="0.05"
                  aria-label="Injected error rate"
                  data-testid="chaos-param-input"
                  value={activeEvent.rate}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'error-rate') ev.rate = Number.isFinite(v) ? v : 0;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            ) : activeEvent.kind === 'throttle' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Cap RPS</span>
                <input
                  type="number"
                  aria-label="Throttle cap RPS"
                  data-testid="chaos-param-input"
                  value={activeEvent.rps}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'throttle') ev.rps = Number.isFinite(v) ? v : 0;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            ) : activeEvent.kind === 'kill-instances' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Kill count</span>
                <input
                  type="number"
                  aria-label="Instances to kill"
                  data-testid="chaos-param-input"
                  value={activeEvent.count}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'kill-instances') ev.count = Number.isFinite(v) ? v : 1;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            ) : activeEvent.kind === 'cache-flush' ? (
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Warmup (s)</span>
                <input
                  type="number"
                  aria-label="Cache warmup seconds"
                  data-testid="chaos-param-input"
                  value={activeEvent.warmupS}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    onUpdateScenario((s) => {
                      const ev = s.chaos[selectedIdx];
                      if (ev?.kind === 'cache-flush') ev.warmupS = Number.isFinite(v) ? v : 0;
                    });
                  }}
                  className="mt-1 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            ) : (
              <div className="flex items-end pb-1 text-[10px] text-[var(--text-muted)]">
                Down all nodes in AZ
              </div>
            )}
          </div>

          {activeIssues.length > 0 ? (
            <div
              role="alert"
              data-testid="chaos-validation-error"
              className="flex items-start gap-1.5 rounded-[6px] border border-[var(--status-overloaded)] bg-[rgba(229,72,77,0.08)] px-2 py-1.5 text-[10px] text-[var(--status-overloaded)]"
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.5} />
              <div>{activeIssues.join(' ')}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
