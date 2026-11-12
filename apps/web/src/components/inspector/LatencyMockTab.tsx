'use client';

import { useEffect, useState } from 'react';
import { BookmarkPlus, Info, RotateCcw } from 'lucide-react';
import type {
  CustomPreset,
  LatencyModel,
  NodeConfig,
  NodeInstance,
  Scenario,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import { savePresetToIndexedDb } from '../../lib/autosave';
import {
  buildPresetFromNode,
  validateErrorRatePercent,
  validateLatencyInput,
  validateRateLimitInput,
} from '../../lib/inspectorValidation';
import { getEffectiveServiceDefaults } from '../../lib/nodeDefaults';
import { OperationsSection } from './OperationsSection';
import { ScenarioOverridesSection } from './ScenarioOverridesSection';

export interface LatencyMockTabProps {
  node: NodeInstance;
  service?: ServiceDefinition;
  activeScenario?: Scenario | null;
  seed?: number;
  presets: CustomPreset[];
  focusedOpName?: string | null;
  onUpdateConfig: (updater: (config: NodeConfig) => void) => void;
  onResetNode: () => void;
  onSavePreset: (preset: CustomPreset) => void;
  onApplyPreset: (preset: CustomPreset) => void;
}

/** Inspector "Latency & Mock" tab with inline validation, edited indicators, per-field resets, and saved presets. */
export function LatencyMockTab({
  node,
  service,
  activeScenario,
  seed = 42,
  presets,
  focusedOpName,
  onUpdateConfig,
  onResetNode,
  onSavePreset,
  onApplyPreset,
}: LatencyMockTabProps) {
  const defaults = getEffectiveServiceDefaults(service);
  const cfg = node.config;
  const activeLatency = cfg.latency ?? defaults.latency;
  const activeErrorPct = Number(((cfg.errorRate ?? defaults.errorRate) * 100).toFixed(4));
  const activeRps = cfg.rateLimit?.rps ?? defaults.rateLimitRps;
  const activeBurst = cfg.rateLimit?.burst ?? defaults.rateLimitBurst;

  // Draft input strings allow showing inline errors (e.g. p95 < p50) without silent clamping
  const [distribution, setDistribution] = useState<LatencyModel['distribution']>(
    activeLatency.distribution,
  );
  const [p50Draft, setP50Draft] = useState(String(activeLatency.p50));
  const [p95Draft, setP95Draft] = useState(String(activeLatency.p95));
  const [mode2WeightDraft, setMode2WeightDraft] = useState(
    String(activeLatency.mode2?.weight ?? 0.1),
  );
  const [mode2P50Draft, setMode2P50Draft] = useState(
    String(activeLatency.mode2?.p50 ?? activeLatency.p50 * 4),
  );
  const [mode2P95Draft, setMode2P95Draft] = useState(
    String(activeLatency.mode2?.p95 ?? activeLatency.p95 * 4),
  );
  const [errorDraft, setErrorDraft] = useState(String(activeErrorPct));
  const [rpsDraft, setRpsDraft] = useState(activeRps !== undefined ? String(activeRps) : '');
  const [burstDraft, setBurstDraft] = useState(
    activeBurst !== undefined ? String(activeBurst) : '',
  );

  const [showPresetForm, setShowPresetForm] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetNotice, setPresetNotice] = useState<string | null>(null);

  // Synchronize drafts when selecting a different node or resetting externally
  useEffect(() => {
    const lat = node.config.latency ?? defaults.latency;
    setDistribution(lat.distribution);
    setP50Draft(String(lat.p50));
    setP95Draft(String(lat.p95));
    setMode2WeightDraft(String(lat.mode2?.weight ?? 0.1));
    setMode2P50Draft(String(lat.mode2?.p50 ?? lat.p50 * 4));
    setMode2P95Draft(String(lat.mode2?.p95 ?? lat.p95 * 4));
    setErrorDraft(String(Number(((node.config.errorRate ?? defaults.errorRate) * 100).toFixed(4))));
    const r = node.config.rateLimit?.rps ?? defaults.rateLimitRps;
    const b = node.config.rateLimit?.burst ?? defaults.rateLimitBurst;
    setRpsDraft(r !== undefined ? String(r) : '');
    setBurstDraft(b !== undefined ? String(b) : '');
  }, [
    node.id,
    node.config.latency,
    node.config.errorRate,
    node.config.rateLimit,
    defaults.latency,
    defaults.errorRate,
    defaults.rateLimitRps,
    defaults.rateLimitBurst,
  ]);

  const parsedP50 = Number(p50Draft);
  const parsedP95 = Number(p95Draft);
  const parsedM2W = Number(mode2WeightDraft);
  const parsedM2P50 = Number(mode2P50Draft);
  const parsedM2P95 = Number(mode2P95Draft);

  const latencyValidation = validateLatencyInput({
    distribution,
    p50: p50Draft.trim() === '' ? Number.NaN : parsedP50,
    p95: p95Draft.trim() === '' ? Number.NaN : parsedP95,
    mode2Weight: mode2WeightDraft.trim() === '' ? Number.NaN : parsedM2W,
    mode2P50: mode2P50Draft.trim() === '' ? Number.NaN : parsedM2P50,
    mode2P95: mode2P95Draft.trim() === '' ? Number.NaN : parsedM2P95,
  });

  const errorValidationMsg = validateErrorRatePercent(
    errorDraft.trim() === '' ? Number.NaN : Number(errorDraft),
  );

  const parsedRps = rpsDraft.trim() === '' ? undefined : Number(rpsDraft);
  const parsedBurst = burstDraft.trim() === '' ? undefined : Number(burstDraft);
  const rateValidation = validateRateLimitInput(parsedRps, parsedBurst);

  const commitLatencyIfValid = (next: {
    dist?: LatencyModel['distribution'];
    p50?: string;
    p95?: string;
    m2w?: string;
    m2p50?: string;
    m2p95?: string;
  }) => {
    const d = next.dist ?? distribution;
    const sP50 = next.p50 ?? p50Draft;
    const sP95 = next.p95 ?? p95Draft;
    const sM2W = next.m2w ?? mode2WeightDraft;
    const sM2P50 = next.m2p50 ?? mode2P50Draft;
    const sM2P95 = next.m2p95 ?? mode2P95Draft;

    const nP50 = sP50.trim() === '' ? Number.NaN : Number(sP50);
    const nP95 = sP95.trim() === '' ? Number.NaN : Number(sP95);
    const nM2W = sM2W.trim() === '' ? Number.NaN : Number(sM2W);
    const nM2P50 = sM2P50.trim() === '' ? Number.NaN : Number(sM2P50);
    const nM2P95 = sM2P95.trim() === '' ? Number.NaN : Number(sM2P95);

    const check = validateLatencyInput({
      distribution: d,
      p50: nP50,
      p95: nP95,
      mode2Weight: nM2W,
      mode2P50: nM2P50,
      mode2P95: nM2P95,
    });

    if (check.valid) {
      onUpdateConfig((draft) => {
        draft.latency = {
          distribution: d,
          p50: nP50,
          p95: d === 'fixed' ? nP50 : nP95,
          ...(d === 'bimodal' ? { mode2: { weight: nM2W, p50: nM2P50, p95: nM2P95 } } : {}),
        };
      });
    }
  };

  const latencyEdited = Boolean(cfg.latency);
  const errorEdited = cfg.errorRate !== undefined;
  const rateLimitEdited = Boolean(cfg.rateLimit);
  const coldStartEdited = Boolean(cfg.coldStart);
  const hasAnyOverride =
    latencyEdited ||
    errorEdited ||
    rateLimitEdited ||
    coldStartEdited ||
    Object.keys(cfg.operations ?? {}).length > 0 ||
    Boolean(cfg.scenarioOverrides?.length);

  const coldStartCfg = cfg.coldStart ?? defaults.coldStart;
  const showColdStartSection = Boolean(
    service?.coldStart || service?.kind === 'fn' || cfg.coldStart,
  );

  const handleSavePreset = () => {
    const clean = presetName.trim();
    if (!clean) {
      return;
    }
    const preset = buildPresetFromNode(node, service, clean, `preset-${Date.now()}`);
    onSavePreset(preset);
    void savePresetToIndexedDb(preset);
    setPresetName('');
    setShowPresetForm(false);
    setPresetNotice(`Saved "${preset.name}"`);
    window.setTimeout(() => setPresetNotice(null), 2500);
  };

  return (
    <div className="space-y-4 p-4 text-[12px]" data-testid="inspector-latency-tab">
      {/* Typical default reminder */}
      <div className="flex items-start justify-between gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[11px] text-[var(--text-secondary)]">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" strokeWidth={1.5} />
          <span>Typical default — edit me. Changes apply directly to the next run.</span>
        </div>
        {hasAnyOverride ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-[var(--accent)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            edited
          </span>
        ) : null}
      </div>

      {/* Presets bar */}
      <div className="flex items-center gap-2">
        <select
          aria-label="Apply saved preset"
          value=""
          onChange={(e) => {
            const picked = presets.find((p) => p.id === e.target.value);
            if (picked) {
              onApplyPreset(picked);
            }
          }}
          className="h-8 flex-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[11px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
        >
          <option value="">
            {presets.length > 0
              ? `Apply preset (${presets.length} saved)…`
              : 'No saved presets yet'}
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowPresetForm((prev) => !prev)}
          className="h-8 px-2.5 text-[11px]"
        >
          <BookmarkPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>Save preset</span>
        </Button>
      </div>

      {showPresetForm ? (
        <div className="flex items-center gap-2 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-2">
          <input
            type="text"
            placeholder="Preset name (e.g. Fast Redis)"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSavePreset();
              }
            }}
            className="h-7 flex-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSavePreset}
            className="h-7 px-2.5 text-[11px]"
          >
            Save
          </Button>
        </div>
      ) : null}

      {presetNotice ? (
        <div className="text-[11px] text-[var(--status-ok)]">{presetNotice}</div>
      ) : null}

      {/* Service Latency */}
      <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            <span>Service latency</span>
            {latencyEdited ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                title={`Default: p50 ${defaults.latency.p50} ms, p95 ${defaults.latency.p95} ms`}
              />
            ) : null}
          </span>
          {latencyEdited ? (
            <button
              type="button"
              onClick={() => {
                onUpdateConfig((d) => {
                  delete d.latency;
                });
              }}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
              <span>default</span>
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">p50 (ms)</span>
            <input
              type="number"
              aria-label="Latency p50 ms"
              min={0.01}
              step={0.5}
              value={p50Draft}
              onChange={(e) => {
                const val = e.target.value;
                setP50Draft(val);
                commitLatencyIfValid({ p50: val });
              }}
              className={`mt-1 h-8 w-full rounded-[6px] border bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:outline-none ${
                latencyValidation.errors.p50
                  ? 'border-[var(--status-overloaded)]'
                  : 'border-[var(--border-hairline)] focus:border-[var(--accent)]'
              }`}
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">p95 (ms)</span>
            <input
              type="number"
              aria-label="Latency p95 ms"
              min={0.01}
              step={1}
              disabled={distribution === 'fixed'}
              value={distribution === 'fixed' ? p50Draft : p95Draft}
              onChange={(e) => {
                const val = e.target.value;
                setP95Draft(val);
                commitLatencyIfValid({ p95: val });
              }}
              className={`mt-1 h-8 w-full rounded-[6px] border bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:outline-none disabled:opacity-45 ${
                latencyValidation.errors.p95
                  ? 'border-[var(--status-overloaded)]'
                  : 'border-[var(--border-hairline)] focus:border-[var(--accent)]'
              }`}
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Distribution</span>
            <select
              aria-label="Latency distribution"
              value={distribution}
              onChange={(e) => {
                const nextDist = e.target.value as LatencyModel['distribution'];
                setDistribution(nextDist);
                commitLatencyIfValid({ dist: nextDist });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="lognormal">lognormal</option>
              <option value="fixed">fixed</option>
              <option value="normal">normal</option>
              <option value="bimodal">bimodal</option>
            </select>
          </label>
        </div>

        {latencyValidation.errors.p50 ? (
          <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
            {latencyValidation.errors.p50}
          </p>
        ) : null}
        {latencyValidation.errors.p95 ? (
          <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
            {latencyValidation.errors.p95}
          </p>
        ) : null}

        {distribution === 'bimodal' ? (
          <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
            <div className="text-[11px] font-medium text-[var(--text-secondary)]">
              Mode 2 (slow tail / miss branch)
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Weight (0–1)</span>
                <input
                  type="number"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={mode2WeightDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMode2WeightDraft(val);
                    commitLatencyIfValid({ m2w: val });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Mode 2 p50</span>
                <input
                  type="number"
                  min={0.01}
                  step={1}
                  value={mode2P50Draft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMode2P50Draft(val);
                    commitLatencyIfValid({ m2p50: val });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Mode 2 p95</span>
                <input
                  type="number"
                  min={0.01}
                  step={1}
                  value={mode2P95Draft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMode2P95Draft(val);
                    commitLatencyIfValid({ m2p95: val });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            </div>
            {latencyValidation.errors.mode2Weight ||
            latencyValidation.errors.mode2P50 ||
            latencyValidation.errors.mode2P95 ? (
              <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                {latencyValidation.errors.mode2Weight ??
                  latencyValidation.errors.mode2P50 ??
                  latencyValidation.errors.mode2P95}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Error rate & rate limit */}
      <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            <span>Errors & rate limit</span>
            {errorEdited || rateLimitEdited ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                title={`Default error rate: ${(defaults.errorRate * 100).toFixed(2)}%`}
              />
            ) : null}
          </span>
          {errorEdited || rateLimitEdited ? (
            <button
              type="button"
              onClick={() =>
                onUpdateConfig((d) => {
                  delete d.errorRate;
                  delete d.rateLimit;
                })
              }
              className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
              <span>default</span>
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Error (%)</span>
            <input
              type="number"
              aria-label="Baseline error rate percent"
              min={0}
              max={100}
              step={0.01}
              value={errorDraft}
              onChange={(e) => {
                const val = e.target.value;
                setErrorDraft(val);
                const parsed = val.trim() === '' ? Number.NaN : Number(val);
                if (!validateErrorRatePercent(parsed)) {
                  onUpdateConfig((d) => {
                    d.errorRate = parsed / 100;
                  });
                }
              }}
              className={`mt-1 h-8 w-full rounded-[6px] border bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:outline-none ${
                errorValidationMsg
                  ? 'border-[var(--status-overloaded)]'
                  : 'border-[var(--border-hairline)] focus:border-[var(--accent)]'
              }`}
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Limit (rps)</span>
            <input
              type="number"
              min={0}
              placeholder="None"
              value={rpsDraft}
              onChange={(e) => {
                const val = e.target.value;
                setRpsDraft(val);
                if (val.trim() === '') {
                  onUpdateConfig((d) => {
                    delete d.rateLimit;
                  });
                  return;
                }
                const rps = Number(val);
                if (!validateRateLimitInput(rps, parsedBurst).rps) {
                  onUpdateConfig((d) => {
                    d.rateLimit = {
                      ...(d.rateLimit ?? {}),
                      rps,
                    };
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Burst</span>
            <input
              type="number"
              min={0}
              placeholder="Auto"
              value={burstDraft}
              onChange={(e) => {
                const val = e.target.value;
                setBurstDraft(val);
                if (val.trim() === '') {
                  onUpdateConfig((d) => {
                    if (d.rateLimit) {
                      delete d.rateLimit.burst;
                    }
                  });
                  return;
                }
                const burst = Number(val);
                if (!validateRateLimitInput(parsedRps, burst).burst) {
                  onUpdateConfig((d) => {
                    d.rateLimit = {
                      ...(d.rateLimit ?? {}),
                      burst,
                    };
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>

        {errorValidationMsg ? (
          <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
            {errorValidationMsg}
          </p>
        ) : null}
        {rateValidation.rps || rateValidation.burst ? (
          <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
            {rateValidation.rps ?? rateValidation.burst}
          </p>
        ) : null}
      </section>

      {/* Cold start */}
      {showColdStartSection ? (
        <section className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={coldStartCfg?.enabled ?? false}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  onUpdateConfig((d) => {
                    d.coldStart = {
                      enabled,
                      probabilityModel: d.coldStart?.probabilityModel ?? 'idle-based',
                      p50: d.coldStart?.p50 ?? defaults.coldStart?.p50 ?? 250,
                      p95: d.coldStart?.p95 ?? defaults.coldStart?.p95 ?? 900,
                      idleTtlS: d.coldStart?.idleTtlS ?? defaults.coldStart?.idleTtlS ?? 600,
                      onLimit: d.coldStart?.onLimit ?? 'throttle',
                      concurrencyLimit: d.coldStart?.concurrencyLimit,
                    };
                  });
                }}
              />
              <span>Cold start modeling</span>
            </label>
            {coldStartEdited ? (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" title="Edited" />
            ) : null}
          </div>

          {coldStartCfg?.enabled ? (
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Cold p50</span>
                <input
                  type="number"
                  min={1}
                  value={coldStartCfg.p50}
                  onChange={(e) => {
                    const n = Math.max(1, Number(e.target.value));
                    onUpdateConfig((d) => {
                      if (d.coldStart) {
                        d.coldStart.p50 = n;
                      } else {
                        d.coldStart = { ...coldStartCfg, p50: n };
                      }
                    });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Cold p95</span>
                <input
                  type="number"
                  min={1}
                  value={coldStartCfg.p95}
                  onChange={(e) => {
                    const n = Math.max(1, Number(e.target.value));
                    onUpdateConfig((d) => {
                      if (d.coldStart) {
                        d.coldStart.p95 = n;
                      } else {
                        d.coldStart = { ...coldStartCfg, p95: n };
                      }
                    });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-[var(--text-muted)]">Idle TTL (s)</span>
                <input
                  type="number"
                  min={1}
                  value={coldStartCfg.idleTtlS ?? 600}
                  onChange={(e) => {
                    const n = Math.max(1, Number(e.target.value));
                    onUpdateConfig((d) => {
                      if (d.coldStart) {
                        d.coldStart.idleTtlS = n;
                      } else {
                        d.coldStart = { ...coldStartCfg, idleTtlS: n };
                      }
                    });
                  }}
                  className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Catalog operation mocks & JSON schema overrides */}
      <OperationsSection
        node={node}
        service={service}
        seed={seed}
        focusedOpName={focusedOpName}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Scenario time-boxed overrides */}
      <ScenarioOverridesSection
        node={node}
        service={service}
        activeScenario={activeScenario}
        onUpdateConfig={onUpdateConfig}
      />

      {/* Footer reset */}
      <div className="border-t border-[var(--border-hairline)] pt-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onResetNode}
          className="h-8 w-full text-[11px]"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>Reset node to defaults</span>
        </Button>
      </div>
    </div>
  );
}
