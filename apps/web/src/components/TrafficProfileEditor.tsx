'use client';

import { sampleProfileCurve } from '@infrasim/sim-engine';
import type { Scenario, TrafficProfile } from '@infrasim/shared-types';

export interface TrafficProfileEditorProps {
  scenario: Scenario;
  seed: number;
  onUpdateScenario: (updater: (scenario: Scenario) => void) => void;
  onUpdateSeed: (seed: number) => void;
}

const PROFILE_DEFAULTS: Record<TrafficProfile['kind'], TrafficProfile> = {
  constant: { kind: 'constant', rps: 100 },
  ramp: { kind: 'ramp', fromRps: 20, toRps: 300 },
  spike: { kind: 'spike', baseRps: 50, peakRps: 400, atS: 15, widthS: 15 },
  steps: {
    kind: 'steps',
    steps: [
      { atS: 0, rps: 50 },
      { atS: 20, rps: 200 },
      { atS: 40, rps: 450 },
    ],
  },
  diurnal: { kind: 'diurnal', meanRps: 150, amplitude: 100, periodS: 60 },
  custom: {
    kind: 'custom',
    points: [
      { tS: 0, rps: 50 },
      { tS: 20, rps: 250 },
      { tS: 40, rps: 100 },
      { tS: 60, rps: 300 },
    ],
  },
};

/** Editable scenario traffic profile form + SVG sparkline curve preview. */
export function TrafficProfileEditor({
  scenario,
  seed,
  onUpdateScenario,
  onUpdateSeed,
}: TrafficProfileEditorProps) {
  const profile = scenario.profile;
  const durationS = Math.max(1, scenario.durationS);
  const curve = sampleProfileCurve(profile, durationS, 48);
  const maxRps = Math.max(10, ...curve.map((pt) => pt.rps));

  const w = 240;
  const h = 56;
  const polyPoints = curve
    .map((pt) => {
      const x = (pt.tS / durationS) * w;
      const y = h - 4 - (pt.rps / maxRps) * (h - 10);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-3 text-[12px]" data-testid="traffic-profile-editor">
      {/* Mini SVG load curve preview */}
      <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
          <span>Arrival curve</span>
          <span className="font-mono tabular-nums">
            peak {Math.round(maxRps)} req/s · {durationS}s
          </span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full overflow-visible">
          <line
            x1={0}
            y1={h - 4}
            x2={w}
            y2={h - 4}
            stroke="var(--border-hairline)"
            strokeWidth={1}
          />
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.75}
            strokeLinejoin="round"
            points={polyPoints}
          />
        </svg>
      </div>

      {/* Curve shape, duration, seed */}
      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">Shape</span>
          <select
            aria-label="Traffic curve shape"
            value={profile.kind}
            onChange={(e) => {
              const kind = e.target.value as TrafficProfile['kind'];
              onUpdateScenario((s) => {
                s.profile = structuredClone(PROFILE_DEFAULTS[kind]);
              });
            }}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="constant">constant</option>
            <option value="ramp">ramp</option>
            <option value="spike">spike</option>
            <option value="steps">steps</option>
            <option value="diurnal">diurnal</option>
            <option value="custom">custom</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">Duration (s)</span>
          <input
            type="number"
            aria-label="Scenario duration seconds"
            min={5}
            max={600}
            value={scenario.durationS}
            onChange={(e) => {
              const val = Math.max(5, Math.min(600, Number(e.target.value) || 60));
              onUpdateScenario((s) => {
                s.durationS = val;
              });
            }}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">Seed</span>
          <input
            type="number"
            aria-label="Deterministic simulation seed"
            value={seed}
            onChange={(e) => {
              const nextSeed = Math.round(Number(e.target.value));
              if (Number.isFinite(nextSeed)) {
                onUpdateSeed(nextSeed);
              }
            }}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
      </div>

      {/* Curve-specific parameters */}
      {profile.kind === 'constant' ? (
        <label className="block">
          <span className="text-[11px] text-[var(--text-muted)]">Target RPS</span>
          <input
            type="number"
            aria-label="Constant target RPS"
            min={0}
            step={10}
            value={profile.rps}
            onChange={(e) => {
              const val = Math.max(0, Number(e.target.value));
              onUpdateScenario((s) => {
                if (s.profile.kind === 'constant') {
                  s.profile.rps = val;
                }
              });
            }}
            className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
      ) : null}

      {profile.kind === 'ramp' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Start RPS</span>
            <input
              type="number"
              min={0}
              value={profile.fromRps}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'ramp') {
                    s.profile.fromRps = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">End RPS</span>
            <input
              type="number"
              min={0}
              value={profile.toRps}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'ramp') {
                    s.profile.toRps = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
        </div>
      ) : null}

      {profile.kind === 'spike' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Base RPS</span>
            <input
              type="number"
              min={0}
              value={profile.baseRps}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'spike') {
                    s.profile.baseRps = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Peak RPS</span>
            <input
              type="number"
              min={0}
              value={profile.peakRps}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'spike') {
                    s.profile.peakRps = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Spike at (s)</span>
            <input
              type="number"
              min={0}
              value={profile.atS}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'spike') {
                    s.profile.atS = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Width (s)</span>
            <input
              type="number"
              min={1}
              value={profile.widthS}
              onChange={(e) => {
                const val = Math.max(1, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'spike') {
                    s.profile.widthS = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
        </div>
      ) : null}

      {profile.kind === 'diurnal' ? (
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Mean RPS</span>
            <input
              type="number"
              min={0}
              value={profile.meanRps}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'diurnal') {
                    s.profile.meanRps = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Amp</span>
            <input
              type="number"
              min={0}
              value={profile.amplitude}
              onChange={(e) => {
                const val = Math.max(0, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'diurnal') {
                    s.profile.amplitude = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Period (s)</span>
            <input
              type="number"
              min={2}
              value={profile.periodS}
              onChange={(e) => {
                const val = Math.max(2, Number(e.target.value));
                onUpdateScenario((s) => {
                  if (s.profile.kind === 'diurnal') {
                    s.profile.periodS = val;
                  }
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
            />
          </label>
        </div>
      ) : null}

      {profile.kind === 'steps' ? (
        <div className="space-y-1.5">
          {profile.steps.map((step, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min={0}
                value={step.atS}
                onChange={(e) => {
                  const atS = Math.max(0, Number(e.target.value));
                  onUpdateScenario((s) => {
                    if (s.profile.kind === 'steps' && s.profile.steps[idx]) {
                      s.profile.steps[idx]!.atS = atS;
                    }
                  });
                }}
                aria-label={`Step ${idx + 1} start second`}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
              <input
                type="number"
                min={0}
                value={step.rps}
                onChange={(e) => {
                  const rps = Math.max(0, Number(e.target.value));
                  onUpdateScenario((s) => {
                    if (s.profile.kind === 'steps' && s.profile.steps[idx]) {
                      s.profile.steps[idx]!.rps = rps;
                    }
                  });
                }}
                aria-label={`Step ${idx + 1} RPS`}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </div>
          ))}
        </div>
      ) : null}

      {profile.kind === 'custom' ? (
        <div className="space-y-1.5">
          {profile.points.map((pt, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min={0}
                value={pt.tS}
                onChange={(e) => {
                  const tS = Math.max(0, Number(e.target.value));
                  onUpdateScenario((s) => {
                    if (s.profile.kind === 'custom' && s.profile.points[idx]) {
                      s.profile.points[idx]!.tS = tS;
                    }
                  });
                }}
                aria-label={`Point ${idx + 1} second`}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
              <input
                type="number"
                min={0}
                value={pt.rps}
                onChange={(e) => {
                  const rps = Math.max(0, Number(e.target.value));
                  onUpdateScenario((s) => {
                    if (s.profile.kind === 'custom' && s.profile.points[idx]) {
                      s.profile.points[idx]!.rps = rps;
                    }
                  });
                }}
                aria-label={`Point ${idx + 1} RPS`}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
