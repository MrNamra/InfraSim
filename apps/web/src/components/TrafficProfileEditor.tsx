'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  estimateProfilePeakRps,
  evaluateProfileRps,
  sampleProfileCurve,
} from '@infrasim/sim-engine';
import type { Scenario, TrafficProfile } from '@infrasim/shared-types';

export interface TrafficProfileEditorProps {
  scenario: Scenario;
  seed: number;
  liveCodeMode?: boolean;
  verboseLogs?: boolean;
  onUpdateScenario: (updater: (scenario: Scenario) => void) => void;
  onUpdateSeed: (seed: number) => void;
  onChangeLiveCodeMode?: (enabled: boolean) => void;
  onChangeVerboseLogs?: (enabled: boolean) => void;
}

function buildDefaultProfile(kind: TrafficProfile['kind'], durationS: number): TrafficProfile {
  const dur = Math.max(5, durationS);
  switch (kind) {
    case 'constant':
      return { kind: 'constant', rps: 100 };
    case 'ramp':
      return { kind: 'ramp', fromRps: 20, toRps: 300 };
    case 'spike':
      return {
        kind: 'spike',
        baseRps: 50,
        peakRps: 400,
        atS: Math.round(dur * 0.25),
        widthS: Math.max(2, Math.round(dur * 0.25)),
      };
    case 'steps':
      return {
        kind: 'steps',
        steps: [
          { atS: 0, rps: 50 },
          { atS: Math.round(dur * 0.33), rps: 200 },
          { atS: Math.round(dur * 0.67), rps: 450 },
        ],
      };
    case 'diurnal':
      return { kind: 'diurnal', meanRps: 150, amplitude: 100, periodS: dur };
    case 'custom':
      return {
        kind: 'custom',
        points: [
          { tS: 0, rps: 50 },
          { tS: Math.round(dur * 0.33), rps: 250 },
          { tS: Math.round(dur * 0.67), rps: 100 },
          { tS: dur, rps: 300 },
        ],
      };
  }
}

/** Editable scenario traffic profile form + interactive SVG sparkline curve editor. */
export function TrafficProfileEditor({
  scenario,
  seed,
  liveCodeMode = false,
  verboseLogs = false,
  onUpdateScenario,
  onUpdateSeed,
  onChangeLiveCodeMode,
  onChangeVerboseLogs,
}: TrafficProfileEditorProps) {
  const profile = scenario.profile;
  const durationS = Math.max(1, scenario.durationS);
  const peakRps = estimateProfilePeakRps(profile, durationS);
  const liveCodeAllowed = peakRps <= 50;
  const curve = sampleProfileCurve(profile, durationS, 48);
  const customMax =
    profile.kind === 'custom' ? Math.max(0, ...profile.points.map((pt) => pt.rps)) : 0;
  const maxRps = Math.max(10, customMax, ...curve.map((pt) => pt.rps));

  const w = 240;
  const h = 56;
  const plotBottom = h - 4;
  const plotSpanH = h - 10;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [dragPointIdx, setDragPointIdx] = useState<number | null>(null);

  const onUpdateRef = useRef(onUpdateScenario);
  onUpdateRef.current = onUpdateScenario;
  const scaleRef = useRef({ durationS, maxRps });
  scaleRef.current = { durationS, maxRps };

  useEffect(() => {
    if (dragPointIdx === null) {
      return;
    }
    const updateDraggedPoint = (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const fracX = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const svgY = ((clientY - rect.top) / Math.max(1, rect.height)) * h;
      const fracY = Math.max(0, Math.min(1, (plotBottom - svgY) / plotSpanH));
      const { durationS: dur, maxRps: yCap } = scaleRef.current;
      const nextTs = Math.round(fracX * dur);
      const nextRps = Math.round(fracY * yCap);
      setHoverTs(nextTs);
      onUpdateRef.current((s) => {
        if (s.profile.kind === 'custom' && s.profile.points[dragPointIdx]) {
          s.profile.points[dragPointIdx]!.tS = nextTs;
          s.profile.points[dragPointIdx]!.rps = nextRps;
        }
      });
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      updateDraggedPoint(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      setDragPointIdx(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragPointIdx, plotBottom, plotSpanH]);

  const polyPoints = curve
    .map((pt) => {
      const x = (pt.tS / durationS) * w;
      const y = plotBottom - (pt.rps / maxRps) * plotSpanH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const hoverRps = hoverTs !== null ? evaluateProfileRps(profile, hoverTs, durationS) : null;

  const handleCurvePointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const rect = svg.getBoundingClientRect();
    const fracX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const svgX = fracX * w;
    const svgY = ((e.clientY - rect.top) / Math.max(1, rect.height)) * h;
    const fracY = Math.max(0, Math.min(1, (plotBottom - svgY) / plotSpanH));
    const clickedTs = Math.round(fracX * durationS);
    const clickedRps = Math.round(fracY * maxRps);
    setHoverTs(clickedTs);

    if (profile.kind !== 'custom') {
      return;
    }

    e.preventDefault();
    // Pick nearest waypoint within threshold, otherwise insert a new waypoint and drag it
    let closestIdx = -1;
    let closestDist = Number.POSITIVE_INFINITY;
    profile.points.forEach((pt, idx) => {
      const px = (Math.min(durationS, Math.max(0, pt.tS)) / durationS) * w;
      const py = plotBottom - (Math.min(maxRps, Math.max(0, pt.rps)) / maxRps) * plotSpanH;
      const dist = Math.hypot(svgX - px, svgY - py);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = idx;
      }
    });

    if (closestIdx >= 0 && closestDist <= 14) {
      onUpdateScenario((s) => {
        if (s.profile.kind === 'custom' && s.profile.points[closestIdx]) {
          s.profile.points[closestIdx]!.tS = clickedTs;
          s.profile.points[closestIdx]!.rps = clickedRps;
        }
      });
      setDragPointIdx(closestIdx);
      return;
    }

    const nextPoints = [...profile.points, { tS: clickedTs, rps: clickedRps }].sort(
      (a, b) => a.tS - b.tS,
    );
    const insertedIdx = nextPoints.findIndex((pt) => pt.tS === clickedTs && pt.rps === clickedRps);
    onUpdateScenario((s) => {
      if (s.profile.kind === 'custom') {
        s.profile.points = nextPoints;
      }
    });
    if (insertedIdx >= 0) {
      setDragPointIdx(insertedIdx);
    }
  };

  const handleCurvePointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (dragPointIdx !== null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const fracX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    setHoverTs(Math.round(fracX * durationS));
  };

  return (
    <div className="space-y-3 text-[12px]" data-testid="traffic-profile-editor">
      {/* Mini SVG load curve preview / interactive custom editor */}
      <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
          <span className="truncate">
            {profile.kind === 'custom' ? 'Custom timeline' : 'Arrival curve'}
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">
            {hoverTs !== null && hoverRps !== null
              ? `${hoverTs}s · ${Math.round(hoverRps)} req/s`
              : `peak ${Math.round(maxRps)} req/s · ${durationS}s`}
          </span>
        </div>
        <svg
          ref={svgRef}
          data-testid="arrival-curve-svg"
          viewBox={`0 0 ${w} ${h}`}
          onPointerDown={handleCurvePointerDown}
          onPointerMove={handleCurvePointerMove}
          onPointerLeave={() => {
            if (dragPointIdx === null) {
              setHoverTs(null);
            }
          }}
          className={`h-14 w-full touch-none overflow-visible ${
            profile.kind === 'custom' ? 'cursor-crosshair' : ''
          }`}
        >
          <line
            x1={0}
            y1={plotBottom}
            x2={w}
            y2={plotBottom}
            stroke="var(--border-hairline)"
            strokeWidth={1}
          />
          {hoverTs !== null ? (
            <line
              x1={(hoverTs / durationS) * w}
              y1={4}
              x2={(hoverTs / durationS) * w}
              y2={plotBottom}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.7}
            />
          ) : null}
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.75}
            strokeLinejoin="round"
            points={polyPoints}
          />
          {profile.kind === 'custom'
            ? profile.points.map((pt, idx) => {
                const cx = (Math.min(durationS, Math.max(0, pt.tS)) / durationS) * w;
                const cy =
                  plotBottom - (Math.min(maxRps, Math.max(0, pt.rps)) / maxRps) * plotSpanH;
                return (
                  <circle
                    key={idx}
                    data-testid={`custom-curve-point-${idx}`}
                    cx={cx}
                    cy={cy}
                    r={dragPointIdx === idx ? 4.5 : 3.5}
                    fill={dragPointIdx === idx ? 'var(--text-primary)' : 'var(--accent)'}
                    stroke="var(--bg-surface)"
                    strokeWidth={1.5}
                  />
                );
              })
            : null}
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
                s.profile = buildDefaultProfile(kind, s.durationS);
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
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2 text-[10px] text-[var(--text-muted)]">
            <span>Time (s)</span>
            <span>RPS</span>
            <button
              type="button"
              aria-label="Add custom timeline point"
              onClick={() => {
                onUpdateScenario((s) => {
                  if (s.profile.kind !== 'custom') return;
                  const last = s.profile.points[s.profile.points.length - 1];
                  const nextTs = Math.min(s.durationS, (last?.tS ?? 0) + 5);
                  s.profile.points.push({ tS: nextTs, rps: last?.rps ?? 100 });
                  s.profile.points.sort((a, b) => a.tS - b.tS);
                });
              }}
              className="flex h-6 w-7 items-center justify-center rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {profile.points.map((pt, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2"
              >
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
                  className="h-7 min-w-0 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
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
                  className="h-7 min-w-0 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
                <button
                  type="button"
                  aria-label={`Remove point ${idx + 1}`}
                  disabled={profile.points.length <= 2}
                  onClick={() => {
                    onUpdateScenario((s) => {
                      if (s.profile.kind === 'custom' && s.profile.points.length > 2) {
                        s.profile.points.splice(idx, 1);
                      }
                    });
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--status-overloaded)] disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {onChangeLiveCodeMode || onChangeVerboseLogs ? (
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          {onChangeLiveCodeMode ? (
            <label className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-[var(--text-primary)]">
                  Live code execution
                </div>
                <div className="text-[10px] text-[var(--text-muted)] tabular-nums">
                  {liveCodeAllowed
                    ? 'Runs actual sandboxed handler per request (cap 50 req/s)'
                    : `Disabled above 50 req/s (peak ${Math.round(peakRps)} req/s)`}
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="live-code-toggle"
                checked={liveCodeAllowed && liveCodeMode}
                disabled={!liveCodeAllowed}
                onChange={(e) => onChangeLiveCodeMode(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--accent)] disabled:opacity-40"
              />
            </label>
          ) : null}

          {onChangeVerboseLogs ? (
            <label className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-[var(--text-primary)]">
                  Verbose debug logs
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  Include console.debug lines during simulation runs
                </div>
              </div>
              <input
                type="checkbox"
                data-testid="verbose-logs-toggle"
                checked={verboseLogs}
                onChange={(e) => onChangeVerboseLogs(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--accent)]"
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
