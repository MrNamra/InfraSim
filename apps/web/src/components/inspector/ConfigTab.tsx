'use client';

import { useMemo, useState } from 'react';
import { HelpCircle, Info } from 'lucide-react';
import type {
  GroupInstance,
  NodeConfig,
  NodeInstance,
  RuntimePreset,
  Scenario,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { resolveNodePlacement } from '@infrasim/sim-engine';
import { getInstanceSpec, listInstanceSpecs, listRegionsForProvider } from '@infrasim/cost-engine';
import {
  RUNTIME_PRESET_SPECS,
  computeTheoreticalMaxRps,
  getEffectiveServiceDefaults,
} from '../../lib/nodeDefaults';
import { TrafficProfileEditor } from '../TrafficProfileEditor';

export interface ConfigTabProps {
  node: NodeInstance;
  service?: ServiceDefinition;
  groups?: readonly GroupInstance[];
  activeScenario?: Scenario | null;
  seed?: number;
  onUpdateScenario?: (scenarioId: string, updater: (scenario: Scenario) => void) => void;
  onUpdateSeed?: (seed: number) => void;
  onRename: (label: string) => void;
  onUpdatePlacement: (placement: { region?: string; az?: string }) => void;
  onUpdateConfig: (updater: (config: NodeConfig) => void) => void;
}

/** Config inspector tab covering capacity, runtime preset, queues, timeouts, and kind-specific settings. */
export function ConfigTab({
  node,
  service,
  groups = [],
  activeScenario,
  seed = 42,
  onUpdateScenario,
  onUpdateSeed,
  onRename,
  onUpdatePlacement,
  onUpdateConfig,
}: ConfigTabProps) {
  const [showRpsDetail, setShowRpsDetail] = useState(false);

  const inheritedPlacement = useMemo(() => {
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    return resolveNodePlacement({ ...node, region: undefined, az: undefined }, groupsById);
  }, [groups, node]);

  const isClientNode = node.serviceId === 'generic.client' || node.serviceId === 'generic.users';

  const defaults = getEffectiveServiceDefaults(service);
  const cfg = node.config;
  const kind = service?.kind ?? 'compute';
  const maxRpsInfo = computeTheoreticalMaxRps(cfg, service);

  const isComputeOnly = kind === 'compute';
  const isComputeLike = kind === 'compute' || kind === 'fn';
  const isFn = kind === 'fn';
  const isDatabaseLike = kind === 'sql' || kind === 'kv' || kind === 'doc' || kind === 'graph';
  const isCacheLike = kind === 'cache' || kind === 'cdn';
  const isLb = kind === 'lb';
  const isQueueLike = kind === 'queue' || kind === 'topic' || kind === 'stream' || kind === 'bus';

  const runtimePreset = cfg.runtimePreset ?? defaults.runtimePreset;
  const maxInFlight = cfg.maxInFlightPerInstance ?? defaults.maxInFlightPerInstance;
  const cpuMs = cfg.cpuMsPerRequest ?? defaults.cpuMsPerRequest;
  const queueMaxLength = cfg.queue?.maxLength ?? defaults.queueMaxLength;
  const queuePolicy = cfg.queue?.policy ?? defaults.queuePolicy;
  const timeoutMs = cfg.timeoutMs ?? defaults.timeoutMs;
  const vcpu = cfg.vcpu ?? defaults.vcpu;
  const memoryGb = cfg.memoryGb ?? defaults.memoryGb;

  const showInstancePicker = isComputeOnly || isDatabaseLike;
  const specCategory = isDatabaseLike ? 'database' : 'compute';
  const curatedSpecs = useMemo(
    () => (service ? listInstanceSpecs(service.provider, specCategory) : []),
    [service, specCategory],
  );
  const providerRegions = useMemo(
    () => (service ? listRegionsForProvider(service.provider) : []),
    [service],
  );
  const matchedSpec =
    service && cfg.instanceType ? getInstanceSpec(service.provider, cfg.instanceType) : undefined;
  const unknownInstanceType =
    showInstancePicker && Boolean(cfg.instanceType?.trim()) && !matchedSpec;

  const autoscale = cfg.autoscaling;
  const coldStartCfg = {
    enabled: cfg.coldStart?.enabled ?? defaults.coldStart?.enabled ?? false,
    probabilityModel:
      cfg.coldStart?.probabilityModel ?? defaults.coldStart?.probabilityModel ?? 'idle-based',
    p50: cfg.coldStart?.p50 ?? defaults.coldStart?.p50 ?? 250,
    p95: cfg.coldStart?.p95 ?? defaults.coldStart?.p95 ?? 900,
    idleTtlS: cfg.coldStart?.idleTtlS ?? defaults.coldStart?.idleTtlS ?? 600,
    onLimit: cfg.coldStart?.onLimit ?? defaults.coldStart?.onLimit ?? 'throttle',
    concurrencyLimit:
      cfg.coldStart?.concurrencyLimit ??
      cfg.maxInFlightPerInstance ??
      defaults.coldStart?.concurrencyLimit ??
      defaults.maxInFlightPerInstance,
  };

  return (
    <div className="space-y-4 p-4 text-[12px]" data-testid="inspector-config-tab">
      {/* Load generator scenario profile card when selecting Client / Users */}
      {isClientNode && activeScenario && onUpdateScenario && onUpdateSeed ? (
        <section className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-[var(--text-primary)]">
              Traffic scenario: {activeScenario.name}
            </span>
          </div>
          <TrafficProfileEditor
            scenario={activeScenario}
            seed={seed}
            onUpdateScenario={(updater) => onUpdateScenario(activeScenario.id, updater)}
            onUpdateSeed={onUpdateSeed}
          />
        </section>
      ) : null}

      {/* Editable defaults notice */}
      <div className="flex items-start gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2 text-[11px] text-[var(--text-secondary)]">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" strokeWidth={1.5} />
        <div>
          <span className="font-medium text-[var(--text-primary)]">Typical default — edit me.</span>{' '}
          Catalog numbers are starting defaults only, not benchmarks.
        </div>
      </div>

      {/* Theoretical max RPS card */}
      <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Theoretical max RPS
            </span>
            <button
              type="button"
              aria-label="Explain theoretical max RPS"
              onClick={() => setShowRpsDetail((prev) => !prev)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              title={maxRpsInfo.explanation}
            >
              <HelpCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
          <span
            data-testid="theoretical-max-rps"
            className="font-mono text-[13px] font-medium tabular-nums text-[var(--text-primary)]"
          >
            {maxRpsInfo.rps !== null ? `${maxRpsInfo.rps.toLocaleString()} req/s` : 'Elastic'}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>Limiting factor</span>
          <span className="font-mono text-[var(--text-secondary)]">
            {maxRpsInfo.limitingFactor}
          </span>
        </div>
        {showRpsDetail ? (
          <p className="mt-1.5 border-t border-[var(--border-hairline)] pt-1.5 text-[11px] leading-4 text-[var(--text-secondary)]">
            {maxRpsInfo.explanation} Formula: min(effectiveCores × 1000 / cpuMs, totalSlots /
            wallTimeSeconds).
          </p>
        ) : null}
      </div>

      {/* Identity & placement */}
      <section className="space-y-2.5">
        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">Label</span>
          <input
            type="text"
            aria-label="Node label"
            value={node.label}
            onChange={(e) => onRename(e.target.value)}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Region</span>
            <input
              type="text"
              list={`infrasim-regions-${node.id}`}
              placeholder={inheritedPlacement.region ?? 'us-east-1'}
              value={node.region ?? ''}
              onChange={(e) => onUpdatePlacement({ region: e.target.value })}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            {providerRegions.length > 0 ? (
              <datalist id={`infrasim-regions-${node.id}`}>
                {providerRegions.map((reg) => (
                  <option key={reg.key} value={reg.code}>
                    {reg.label}
                  </option>
                ))}
              </datalist>
            ) : null}
            {!node.region && inheritedPlacement.region ? (
              <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-muted)]">
                Inherited: {inheritedPlacement.region}
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">AZ / Zone</span>
            <input
              type="text"
              placeholder={inheritedPlacement.az ?? 'az-a'}
              value={node.az ?? ''}
              onChange={(e) => onUpdatePlacement({ az: e.target.value })}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            {!node.az && inheritedPlacement.az ? (
              <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-muted)]">
                Inherited: {inheritedPlacement.az}
              </span>
            ) : null}
          </label>
        </div>
      </section>

      {/* Sizing & runtime capacity */}
      <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
        <div className="text-[11px] font-medium text-[var(--text-secondary)]">
          Capacity & concurrency
        </div>

        {showInstancePicker ? (
          <div className="space-y-2">
            {curatedSpecs.length > 0 ? (
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Instance preset</span>
                <select
                  aria-label="Instance preset"
                  value={matchedSpec ? matchedSpec.instanceType : '__custom__'}
                  onChange={(e) => {
                    const selected = curatedSpecs.find((s) => s.instanceType === e.target.value);
                    if (selected) {
                      onUpdateConfig((d) => {
                        d.instanceType = selected.instanceType;
                        d.vcpu = selected.vcpu;
                        d.memoryGb = selected.memoryGb;
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                >
                  <option value="__custom__">
                    {cfg.instanceType ? `Custom (${cfg.instanceType})` : 'Custom / Enter manually'}
                  </option>
                  {curatedSpecs.map((spec) => (
                    <option key={spec.instanceType} value={spec.instanceType}>
                      {spec.instanceType} ({spec.vcpu} vCPU, {spec.memoryGb} GB)
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Instance type</span>
              <input
                type="text"
                aria-label="Instance type"
                placeholder="Custom instance type"
                value={cfg.instanceType ?? ''}
                onChange={(e) => {
                  const nextType = e.target.value;
                  const spec = service ? getInstanceSpec(service.provider, nextType) : undefined;
                  onUpdateConfig((d) => {
                    d.instanceType = nextType.trim() ? nextType : undefined;
                    if (spec) {
                      d.vcpu = spec.vcpu;
                      d.memoryGb = spec.memoryGb;
                    }
                  });
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>

            {unknownInstanceType ? (
              <p
                data-testid="unknown-instance-type-hint"
                className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-1.5 text-[11px] text-[var(--status-warm)]"
              >
                Unknown instance type — enter vCPU and RAM (GB) manually below
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Instances</span>
            <input
              type="number"
              min={1}
              max={500}
              value={cfg.instances}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) {
                  onUpdateConfig((d) => {
                    d.instances = Math.round(n);
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          {isComputeLike || isDatabaseLike ? (
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">vCPU</span>
              <input
                type="number"
                min={0.25}
                step={0.5}
                value={vcpu}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) {
                    onUpdateConfig((d) => {
                      d.vcpu = n;
                    });
                  }
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ) : null}

          {isComputeLike || isDatabaseLike ? (
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">RAM (GB)</span>
              <input
                type="number"
                min={0.25}
                step={0.5}
                value={memoryGb}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) {
                    onUpdateConfig((d) => {
                      d.memoryGb = n;
                    });
                  }
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ) : null}
        </div>

        {isComputeOnly ? (
          <div className="space-y-2">
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Runtime preset</span>
              <select
                value={runtimePreset}
                onChange={(e) => {
                  const preset = e.target.value as RuntimePreset;
                  const spec = RUNTIME_PRESET_SPECS[preset];
                  onUpdateConfig((d) => {
                    d.runtimePreset = preset;
                    d.maxInFlightPerInstance = spec.maxInFlight;
                    d.cpuMsPerRequest = spec.defaultCpuMs;
                  });
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              >
                {(Object.keys(RUNTIME_PRESET_SPECS) as RuntimePreset[]).map((key) => (
                  <option key={key} value={key}>
                    {RUNTIME_PRESET_SPECS[key].label}
                  </option>
                ))}
              </select>
            </label>

            {runtimePreset === 'node' ? (
              <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={Boolean(cfg.cluster)}
                  onChange={(e) =>
                    onUpdateConfig((d) => {
                      d.cluster = e.target.checked;
                    })
                  }
                />
                <span>Node cluster mode (utilize all {vcpu} vCPU cores)</span>
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>Max in-flight / inst</span>
              {cfg.maxInFlightPerInstance !== undefined ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  title={`Edited (default ${defaults.maxInFlightPerInstance})`}
                />
              ) : null}
            </span>
            <input
              type="number"
              min={1}
              value={maxInFlight}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) {
                  onUpdateConfig((d) => {
                    d.maxInFlightPerInstance = Math.round(n);
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>CPU ms / req</span>
              {cfg.cpuMsPerRequest !== undefined ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  title={`Edited (default ${defaults.cpuMsPerRequest} ms)`}
                />
              ) : null}
            </span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={cpuMs}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) {
                  onUpdateConfig((d) => {
                    d.cpuMsPerRequest = n;
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Queue max length</span>
            <input
              type="number"
              min={0}
              value={queueMaxLength}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) {
                  onUpdateConfig((d) => {
                    d.queue = {
                      maxLength: Math.round(n),
                      policy: d.queue?.policy ?? defaults.queuePolicy,
                    };
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Queue full policy</span>
            <select
              value={queuePolicy}
              onChange={(e) =>
                onUpdateConfig((d) => {
                  d.queue = {
                    maxLength: d.queue?.maxLength ?? defaults.queueMaxLength,
                    policy: e.target.value as 'reject' | 'drop-oldest',
                  };
                })
              }
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="reject">reject newest (503)</option>
              <option value="drop-oldest">drop oldest</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Timeout (ms)</span>
            <input
              type="number"
              min={1}
              value={timeoutMs}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) {
                  onUpdateConfig((d) => {
                    d.timeoutMs = Math.round(n);
                  });
                }
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="flex items-end gap-2 pb-1.5 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={Boolean(cfg.cancelOnTimeout)}
              onChange={(e) =>
                onUpdateConfig((d) => {
                  d.cancelOnTimeout = e.target.checked;
                })
              }
            />
            <span>Cancel downstream</span>
          </label>
        </div>
      </section>

      {/* Kind-specific behavior settings */}
      {isFn || isCacheLike || isDatabaseLike || isLb || isQueueLike ? (
        <section className="space-y-2.5 border-t border-[var(--border-hairline)] pt-3">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            Service behavior ({kind})
          </div>

          {isFn ? (
            <div className="space-y-2">
              <label className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
                <span>Cold starts enabled</span>
                <input
                  type="checkbox"
                  checked={coldStartCfg.enabled}
                  onChange={(e) =>
                    onUpdateConfig((d) => {
                      d.coldStart = {
                        ...coldStartCfg,
                        enabled: e.target.checked,
                      };
                    })
                  }
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Concurrency limit</span>
                  <input
                    type="number"
                    min={1}
                    value={coldStartCfg.concurrencyLimit}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (Number.isFinite(n) && n >= 1) {
                        onUpdateConfig((d) => {
                          d.coldStart = { ...coldStartCfg, concurrencyLimit: n };
                          d.maxInFlightPerInstance = n;
                        });
                      }
                    }}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">On limit reached</span>
                  <select
                    value={coldStartCfg.onLimit}
                    onChange={(e) =>
                      onUpdateConfig((d) => {
                        d.coldStart = {
                          ...coldStartCfg,
                          onLimit: e.target.value as 'throttle' | 'queue',
                        };
                      })
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  >
                    <option value="throttle">throttle (429)</option>
                    <option value="queue">queue (wait)</option>
                  </select>
                </label>
              </div>

              {coldStartCfg.enabled ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Cold start model</span>
                    <select
                      value={coldStartCfg.probabilityModel}
                      onChange={(e) =>
                        onUpdateConfig((d) => {
                          d.coldStart = {
                            ...coldStartCfg,
                            probabilityModel: e.target.value as 'idle-based' | 'fixed',
                          };
                        })
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    >
                      <option value="idle-based">idle-based (warm pool)</option>
                      <option value="fixed">fixed overhead chance</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Idle TTL (s)</span>
                    <input
                      type="number"
                      min={1}
                      value={coldStartCfg.idleTtlS}
                      onChange={(e) => {
                        const n = Math.round(Number(e.target.value));
                        if (Number.isFinite(n) && n >= 1) {
                          onUpdateConfig((d) => {
                            d.coldStart = { ...coldStartCfg, idleTtlS: n };
                          });
                        }
                      }}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Cold p50 (ms)</span>
                    <input
                      type="number"
                      min={0}
                      value={coldStartCfg.p50}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0) {
                          onUpdateConfig((d) => {
                            d.coldStart = { ...coldStartCfg, p50: n };
                          });
                        }
                      }}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Cold p95 (ms)</span>
                    <input
                      type="number"
                      min={0}
                      value={coldStartCfg.p95}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0) {
                          onUpdateConfig((d) => {
                            d.coldStart = { ...coldStartCfg, p95: n };
                          });
                        }
                      }}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {isCacheLike ? (
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Cache hit ratio (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round((cfg.cacheHitRatio ?? defaults.cacheHitRatio ?? 0.85) * 100)}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
                    onUpdateConfig((d) => {
                      d.cacheHitRatio = pct / 100;
                    });
                  }
                }}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ) : null}

          {isDatabaseLike ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Connection pool max</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.connections?.max ?? defaults.connectionsMax ?? 100}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) {
                      onUpdateConfig((d) => {
                        d.connections = { max: Math.round(n) };
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Pool wait (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.connectionWaitMs ?? defaults.connectionWaitMs ?? 500}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) {
                      onUpdateConfig((d) => {
                        d.connectionWaitMs = Math.round(n);
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Read mix (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round((cfg.readRatio ?? defaults.readRatio ?? 0.8) * 100)}
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
                      onUpdateConfig((d) => {
                        d.readRatio = pct / 100;
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Write latency mult</span>
                <input
                  type="number"
                  min={0.5}
                  step={0.1}
                  value={cfg.writeLatencyMultiplier ?? defaults.writeLatencyMultiplier ?? 1.5}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 0.1) {
                      onUpdateConfig((d) => {
                        d.writeLatencyMultiplier = n;
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            </div>
          ) : null}

          {isLb ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Algorithm</span>
                  <select
                    value={cfg.lb?.algorithm ?? 'round-robin'}
                    onChange={(e) =>
                      onUpdateConfig((d) => {
                        d.lb = {
                          ...(d.lb ?? { algorithm: 'round-robin' }),
                          algorithm: e.target.value as 'round-robin' | 'least-conn' | 'random',
                        };
                      })
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                  >
                    <option value="round-robin">round-robin</option>
                    <option value="least-conn">least-conn</option>
                    <option value="random">random</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Idle timeout (ms)</span>
                  <input
                    type="number"
                    min={100}
                    value={cfg.lb?.idleTimeoutMs ?? 60000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 100) {
                        onUpdateConfig((d) => {
                          d.lb = {
                            ...(d.lb ?? { algorithm: 'round-robin' }),
                            idleTimeoutMs: Math.round(n),
                          };
                        });
                      }
                    }}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                </label>
              </div>

              <label className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
                <span>Active health checks</span>
                <input
                  type="checkbox"
                  checked={Boolean(cfg.lb?.healthCheck)}
                  onChange={(e) =>
                    onUpdateConfig((d) => {
                      const prevLb = d.lb ?? { algorithm: 'round-robin' as const };
                      if (e.target.checked) {
                        d.lb = {
                          ...prevLb,
                          healthCheck: {
                            intervalS: 2,
                            unhealthyThreshold: 2,
                            healthyThreshold: 2,
                            timeoutMs: 2000,
                          },
                        };
                      } else {
                        d.lb = { ...prevLb };
                        delete d.lb.healthCheck;
                      }
                    })
                  }
                />
              </label>

              {cfg.lb?.healthCheck ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Interval (s)</span>
                    <input
                      type="number"
                      min={1}
                      value={cfg.lb.healthCheck.intervalS}
                      onChange={(e) => {
                        const n = Math.max(1, Math.round(Number(e.target.value)));
                        onUpdateConfig((d) => {
                          if (d.lb?.healthCheck) {
                            d.lb.healthCheck.intervalS = n;
                          }
                        });
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Timeout (ms)</span>
                    <input
                      type="number"
                      min={10}
                      value={cfg.lb.healthCheck.timeoutMs}
                      onChange={(e) => {
                        const n = Math.max(10, Math.round(Number(e.target.value)));
                        onUpdateConfig((d) => {
                          if (d.lb?.healthCheck) {
                            d.lb.healthCheck.timeoutMs = n;
                          }
                        });
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Unhealthy fails</span>
                    <input
                      type="number"
                      min={1}
                      value={cfg.lb.healthCheck.unhealthyThreshold}
                      onChange={(e) => {
                        const n = Math.max(1, Math.round(Number(e.target.value)));
                        onUpdateConfig((d) => {
                          if (d.lb?.healthCheck) {
                            d.lb.healthCheck.unhealthyThreshold = n;
                          }
                        });
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Healthy passes</span>
                    <input
                      type="number"
                      min={1}
                      value={cfg.lb.healthCheck.healthyThreshold}
                      onChange={(e) => {
                        const n = Math.max(1, Math.round(Number(e.target.value)));
                        onUpdateConfig((d) => {
                          if (d.lb?.healthCheck) {
                            d.lb.healthCheck.healthyThreshold = n;
                          }
                        });
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {isQueueLike ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Consumer conc</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.consumer?.concurrency ?? 10}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) {
                      onUpdateConfig((d) => {
                        d.consumer = {
                          concurrency: Math.round(n),
                          batchSize: d.consumer?.batchSize ?? 1,
                          pollMs: d.consumer?.pollMs ?? 50,
                          maxRetries: d.consumer?.maxRetries ?? 3,
                          dlq: d.consumer?.dlq ?? true,
                        };
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Max retries</span>
                <input
                  type="number"
                  min={0}
                  value={cfg.consumer?.maxRetries ?? 3}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 0) {
                      onUpdateConfig((d) => {
                        d.consumer = {
                          concurrency: d.consumer?.concurrency ?? 10,
                          batchSize: d.consumer?.batchSize ?? 1,
                          pollMs: d.consumer?.pollMs ?? 50,
                          maxRetries: Math.round(n),
                          dlq: d.consumer?.dlq ?? true,
                        };
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Batch size</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.consumer?.batchSize ?? 1}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) {
                      onUpdateConfig((d) => {
                        d.consumer = {
                          concurrency: d.consumer?.concurrency ?? 10,
                          batchSize: Math.round(n),
                          pollMs: d.consumer?.pollMs ?? 50,
                          maxRetries: d.consumer?.maxRetries ?? 3,
                          dlq: d.consumer?.dlq ?? true,
                        };
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Poll interval (ms)</span>
                <input
                  type="number"
                  min={5}
                  value={cfg.consumer?.pollMs ?? 50}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 5) {
                      onUpdateConfig((d) => {
                        d.consumer = {
                          concurrency: d.consumer?.concurrency ?? 10,
                          batchSize: d.consumer?.batchSize ?? 1,
                          pollMs: Math.round(n),
                          maxRetries: d.consumer?.maxRetries ?? 3,
                          dlq: d.consumer?.dlq ?? true,
                        };
                      });
                    }
                  }}
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={cfg.consumer?.dlq ?? true}
                  onChange={(e) =>
                    onUpdateConfig((d) => {
                      d.consumer = {
                        concurrency: d.consumer?.concurrency ?? 10,
                        batchSize: d.consumer?.batchSize ?? 1,
                        pollMs: d.consumer?.pollMs ?? 50,
                        maxRetries: d.consumer?.maxRetries ?? 3,
                        dlq: e.target.checked,
                      };
                    })
                  }
                />
                <span>Send failed messages to dead-letter queue (DLQ)</span>
              </label>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Autoscaling */}
      <section className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
        <label className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Autoscaling</span>
          <input
            type="checkbox"
            checked={Boolean(autoscale)}
            onChange={(e) =>
              onUpdateConfig((d) => {
                if (e.target.checked) {
                  d.autoscaling = {
                    min: d.instances,
                    max: Math.max(d.instances * 2, 4),
                    metric: 'cpu',
                    target: 0.7,
                    scaleOutCooldownS: 30,
                    scaleInCooldownS: 60,
                    warmupS: service?.scaleOutLagS ?? 45,
                    checkIntervalS: 10,
                  };
                } else {
                  delete d.autoscaling;
                }
              })
            }
          />
        </label>

        {autoscale ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Min instances</span>
              <input
                type="number"
                min={1}
                value={autoscale.min}
                onChange={(e) => {
                  const n = Math.max(1, Math.round(Number(e.target.value)));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.min = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Max instances</span>
              <input
                type="number"
                min={1}
                value={autoscale.max}
                onChange={(e) => {
                  const n = Math.max(1, Math.round(Number(e.target.value)));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.max = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Metric</span>
              <select
                value={autoscale.metric}
                onChange={(e) =>
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.metric = e.target.value as 'cpu' | 'inflight' | 'rps' | 'queue';
                    }
                  })
                }
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 text-[11px] text-[var(--text-primary)]"
              >
                <option value="cpu">cpu</option>
                <option value="inflight">inflight</option>
                <option value="rps">rps</option>
                <option value="queue">queue</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Target (0–1 or RPS)</span>
              <input
                type="number"
                step={0.05}
                min={0.05}
                value={autoscale.target}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) {
                    onUpdateConfig((d) => {
                      if (d.autoscaling) {
                        d.autoscaling.target = n;
                      }
                    });
                  }
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Warmup (s)</span>
              <input
                type="number"
                min={0}
                value={autoscale.warmupS}
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.warmupS = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Check interval (s)</span>
              <input
                type="number"
                min={1}
                value={autoscale.checkIntervalS}
                onChange={(e) => {
                  const n = Math.max(1, Number(e.target.value));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.checkIntervalS = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Scale-out cooldown (s)</span>
              <input
                type="number"
                min={0}
                value={autoscale.scaleOutCooldownS}
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.scaleOutCooldownS = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Scale-in cooldown (s)</span>
              <input
                type="number"
                min={0}
                value={autoscale.scaleInCooldownS}
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value));
                  onUpdateConfig((d) => {
                    if (d.autoscaling) {
                      d.autoscaling.scaleInCooldownS = n;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
          </div>
        ) : null}
      </section>
    </div>
  );
}
