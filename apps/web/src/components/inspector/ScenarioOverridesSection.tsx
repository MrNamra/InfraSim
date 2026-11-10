'use client';

import { Plus, Trash2 } from 'lucide-react';
import type {
  NodeConfig,
  NodeInstance,
  Scenario,
  ScenarioOverride,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { validateErrorRatePercent, validateLatencyInput } from '../../lib/inspectorValidation';

export interface ScenarioOverridesSectionProps {
  node: NodeInstance;
  service?: ServiceDefinition;
  activeScenario?: Scenario | null;
  onUpdateConfig: (updater: (config: NodeConfig) => void) => void;
}

/** Time-boxed scenario overrides for node latency, errors, and rate limits per time window. */
export function ScenarioOverridesSection({
  node,
  service,
  activeScenario,
  onUpdateConfig,
}: ScenarioOverridesSectionProps) {
  const overrides = node.config.scenarioOverrides ?? [];
  const defaultLat = node.config.latency ??
    service?.latency ?? { distribution: 'lognormal' as const, p50: 15, p95: 60 };
  const durationS = activeScenario?.durationS ?? 60;

  const updateAt = (index: number, updater: (prev: ScenarioOverride) => ScenarioOverride) => {
    onUpdateConfig((cfg) => {
      const list = [...(cfg.scenarioOverrides ?? [])];
      if (!list[index]) return;
      list[index] = updater(list[index]!);
      cfg.scenarioOverrides = list;
    });
  };

  const removeAt = (index: number) => {
    onUpdateConfig((cfg) => {
      const list = [...(cfg.scenarioOverrides ?? [])];
      list.splice(index, 1);
      if (list.length === 0) {
        delete cfg.scenarioOverrides;
      } else {
        cfg.scenarioOverrides = list;
      }
    });
  };

  const addWindow = () => {
    onUpdateConfig((cfg) => {
      const next: ScenarioOverride = {
        ...(activeScenario ? { scenarioId: activeScenario.id } : {}),
        fromS: Math.min(Math.floor(durationS / 2), Math.max(0, durationS - 10)),
        toS: Math.min(durationS, Math.floor(durationS / 2) + 20),
        latency: {
          distribution: 'fixed',
          p50: Math.max(100, defaultLat.p95 * 4),
          p95: Math.max(100, defaultLat.p95 * 4),
        },
      };
      cfg.scenarioOverrides = [...(cfg.scenarioOverrides ?? []), next];
    });
  };

  return (
    <section className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Scenario time windows ({overrides.length})
        </span>
        <button
          type="button"
          data-testid="add-scenario-override-btn"
          onClick={addWindow}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
        >
          <Plus className="h-3 w-3" strokeWidth={1.5} />
          <span>Add window</span>
        </button>
      </div>

      {overrides.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)]">
          Simulate slowdowns or throttling inside a specific interval of{' '}
          {activeScenario?.name ?? 'the active scenario'}.
        </p>
      ) : (
        <div className="space-y-2">
          {overrides.map((ov, idx) => {
            const lat = ov.latency ?? defaultLat;
            const timeError =
              !Number.isFinite(ov.fromS) ||
              !Number.isFinite(ov.toS) ||
              ov.fromS < 0 ||
              ov.toS <= ov.fromS
                ? 'End second must exceed start second.'
                : null;
            const latCheck = validateLatencyInput({
              distribution: lat.distribution,
              p50: lat.p50,
              p95: lat.distribution === 'fixed' ? lat.p50 : lat.p95,
            });
            const errPct = Number(((ov.errorRate ?? 0) * 100).toFixed(2));
            const errMsg = ov.errorRate !== undefined ? validateErrorRatePercent(errPct) : null;

            return (
              <div
                key={`${ov.scenarioId ?? 'all'}-${idx}`}
                data-testid={`scenario-override-${idx}`}
                className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <select
                    aria-label={`Window ${idx + 1} scenario scope`}
                    value={ov.scenarioId ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateAt(idx, (prev) => {
                        const next = { ...prev };
                        if (!val) {
                          delete next.scenarioId;
                        } else {
                          next.scenarioId = val;
                        }
                        return next;
                      });
                    }}
                    className="h-6 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[10px] text-[var(--text-secondary)]"
                  >
                    {activeScenario ? (
                      <option value={activeScenario.id}>{activeScenario.name}</option>
                    ) : null}
                    <option value="">All scenarios</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`Remove window ${idx + 1}`}
                    onClick={() => removeAt(idx)}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">From (s)</span>
                    <input
                      type="number"
                      min={0}
                      value={ov.fromS}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        updateAt(idx, (prev) => ({
                          ...prev,
                          fromS: Number.isFinite(val) ? val : 0,
                        }));
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">To (s)</span>
                    <input
                      type="number"
                      min={1}
                      value={ov.toS}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        updateAt(idx, (prev) => ({
                          ...prev,
                          toS: Number.isFinite(val) ? val : prev.fromS + 1,
                        }));
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">p50 (ms)</span>
                    <input
                      type="number"
                      min={0.1}
                      step={5}
                      value={lat.p50}
                      onChange={(e) => {
                        const p50 = Number(e.target.value);
                        if (!Number.isFinite(p50) || p50 <= 0) return;
                        updateAt(idx, (prev) => ({
                          ...prev,
                          latency: {
                            distribution: prev.latency?.distribution ?? 'lognormal',
                            p50,
                            p95: Math.max(p50, prev.latency?.p95 ?? p50),
                          },
                        }));
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">p95 (ms)</span>
                    <input
                      type="number"
                      min={0.1}
                      step={10}
                      value={lat.p95}
                      onChange={(e) => {
                        const p95 = Number(e.target.value);
                        if (!Number.isFinite(p95) || p95 <= 0) return;
                        updateAt(idx, (prev) => ({
                          ...prev,
                          latency: {
                            distribution: prev.latency?.distribution ?? 'lognormal',
                            p50: prev.latency?.p50 ?? defaultLat.p50,
                            p95,
                          },
                        }));
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Error (%)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      placeholder="Auto"
                      value={ov.errorRate !== undefined ? String(errPct) : ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        updateAt(idx, (prev) => {
                          const next = { ...prev };
                          if (raw.trim() === '') {
                            delete next.errorRate;
                          } else {
                            next.errorRate = Math.max(0, Math.min(100, Number(raw))) / 100;
                          }
                          return next;
                        });
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-[10px] text-[var(--text-muted)]">
                    Rate limit inside window (rps, blank = unchanged)
                  </span>
                  <input
                    type="number"
                    min={0}
                    placeholder="No override"
                    value={ov.rateLimitRps !== undefined ? String(ov.rateLimitRps) : ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      updateAt(idx, (prev) => {
                        const next = { ...prev };
                        if (raw.trim() === '') {
                          delete next.rateLimitRps;
                        } else {
                          next.rateLimitRps = Math.max(0, Number(raw));
                        }
                        return next;
                      });
                    }}
                    className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                  />
                </label>

                {timeError || latCheck.errors.p95 || errMsg ? (
                  <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                    {timeError ?? latCheck.errors.p95 ?? errMsg}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
