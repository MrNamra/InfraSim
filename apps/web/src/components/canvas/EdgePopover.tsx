'use client';

import { AlertTriangle, CheckCircle2, Network, Trash2, X, XCircle } from 'lucide-react';
import type { EdgeInstance, NetworkAnalysis } from '@infrasim/shared-types';
import type { InferredEdgePlacement } from '@infrasim/sim-engine';
import { Button } from '@infrasim/ui-kit';

export interface EdgePopoverProps {
  edge: EdgeInstance;
  sourceLabel: string;
  targetLabel: string;
  inferredPlacement?: InferredEdgePlacement | null;
  reachability?: NetworkAnalysis['edges'][string] | null;
  onInspectReachability?: (edgeId: string) => void;
  onUpdate: (edgeId: string, updater: (draft: EdgeInstance) => void) => void;
  onDelete: (edgeId: string) => void;
  onClose: () => void;
}

const PROTOCOLS: EdgeInstance['protocol'][] = [
  'https',
  'http',
  'grpc',
  'tcp',
  'udp',
  'amqp',
  'kafka',
  'sql',
  'redis',
  'dns',
  'internal',
];

/** Side popover for inspecting and tuning an edge's protocol, routing, latency, retries, and circuit breaker. */
export function EdgePopover({
  edge,
  sourceLabel,
  targetLabel,
  inferredPlacement = null,
  reachability = null,
  onInspectReachability,
  onUpdate,
  onDelete,
  onClose,
}: EdgePopoverProps) {
  const defaultP50 = inferredPlacement?.model.p50 ?? 0.4;
  const defaultP95 = inferredPlacement?.model.p95 ?? 1.2;

  return (
    <div
      data-testid="edge-popover"
      className="absolute right-4 top-14 z-30 max-h-[calc(100%-64px)] w-72 overflow-y-auto rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-floating)]"
    >
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-hairline)] pb-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">
            {sourceLabel} → {targetLabel}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">{edge.id}</div>
        </div>
        <button
          type="button"
          aria-label="Close edge settings"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>

      <div className="mt-3 space-y-3 text-[12px]">
        {reachability ? (
          <div
            data-testid="edge-reachability-banner"
            className={`rounded-[8px] border p-2.5 text-[11px] ${
              !reachability.reachable
                ? 'border-[var(--status-overloaded)] bg-[rgba(229,72,77,0.08)]'
                : reachability.riskyReason
                  ? 'border-[var(--status-warm)] bg-[rgba(229,160,13,0.08)]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)]'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 font-medium">
                {!reachability.reachable ? (
                  <XCircle
                    className="h-3.5 w-3.5 shrink-0 text-[var(--status-overloaded)]"
                    strokeWidth={1.5}
                  />
                ) : reachability.riskyReason ? (
                  <AlertTriangle
                    className="h-3.5 w-3.5 shrink-0 text-[var(--status-warm)]"
                    strokeWidth={1.5}
                  />
                ) : (
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0 text-[var(--status-ok)]"
                    strokeWidth={1.5}
                  />
                )}
                <span className="text-[var(--text-primary)]">
                  {!reachability.reachable
                    ? `Blocked (${reachability.reasonCode ?? 'DENY'})`
                    : reachability.riskyReason
                      ? 'Reachable (risky)'
                      : 'Reachable'}
                </span>
              </div>
              {onInspectReachability ? (
                <button
                  type="button"
                  data-testid="edge-inspect-fix-btn"
                  onClick={() => onInspectReachability(edge.id)}
                  className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--accent)] hover:underline"
                >
                  <Network className="h-3 w-3" strokeWidth={1.5} />
                  <span>{!reachability.reachable ? 'Inspect & fix' : 'Trace hops'}</span>
                </button>
              ) : null}
            </div>
            <p className="mt-1 leading-4 text-[var(--text-secondary)]">
              {!reachability.reachable
                ? reachability.explanation.short
                : (reachability.riskyReason ?? reachability.explanation.short)}
            </p>
            {reachability.viaNat || reachability.viaEndpoint || reachability.extraLatencyMs ? (
              <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                {reachability.viaNat ? (
                  <span className="rounded bg-[var(--bg-surface)] px-1 py-0.5">NAT</span>
                ) : null}
                {reachability.viaEndpoint ? (
                  <span className="rounded bg-[var(--bg-surface)] px-1 py-0.5">Endpoint</span>
                ) : null}
                {reachability.extraLatencyMs ? (
                  <span className="rounded bg-[var(--bg-surface)] px-1 py-0.5">
                    +{reachability.extraLatencyMs} ms hop
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Protocol</span>
            <select
              value={edge.protocol}
              onChange={(e) =>
                onUpdate(edge.id, (d) => {
                  d.protocol = e.target.value as EdgeInstance['protocol'];
                })
              }
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={edge.port ?? 443}
              onChange={(e) => {
                const port = Number(e.target.value);
                onUpdate(edge.id, (d) => {
                  d.port = Number.isFinite(port) && port > 0 ? port : undefined;
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Mode</span>
            <select
              value={edge.callType}
              onChange={(e) =>
                onUpdate(edge.id, (d) => {
                  d.callType = e.target.value as 'sync' | 'async';
                })
              }
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="sync">sync</option>
              <option value="async">async</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Weight</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={edge.weight}
              onChange={(e) => {
                const val = Number(e.target.value);
                onUpdate(edge.id, (d) => {
                  d.weight = Number.isFinite(val) && val >= 0 ? val : 1;
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-[var(--text-muted)]">Fan-out</span>
            <input
              type="number"
              min={1}
              step={1}
              value={edge.fanOut ?? 1}
              onChange={(e) => {
                const val = Number(e.target.value);
                onUpdate(edge.id, (d) => {
                  d.fanOut = Number.isFinite(val) && val >= 1 ? Math.round(val) : 1;
                });
              }}
              className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>

        {/* Network latency & link properties */}
        <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Network & link latency (ms)
            </span>
            {edge.networkLatency ? (
              <button
                type="button"
                onClick={() =>
                  onUpdate(edge.id, (d) => {
                    delete d.networkLatency;
                  })
                }
                className="text-[11px] text-[var(--accent)] hover:underline"
              >
                Use placement default
              </button>
            ) : (
              <span
                className="text-[11px] text-[var(--text-muted)]"
                title="Typical default — edit me"
              >
                Auto (typical default)
              </span>
            )}
          </div>
          {inferredPlacement ? (
            <div
              data-testid="edge-placement-summary"
              className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)]"
            >
              <span>{inferredPlacement.label}</span>
              <span>·</span>
              <span>
                p50 {defaultP50} / p95 {defaultP95} ms
              </span>
              {inferredPlacement.crossAz ? (
                <span className="rounded bg-[var(--bg-raised)] px-1 text-[var(--text-secondary)]">
                  Cross-AZ
                </span>
              ) : null}
              {inferredPlacement.crossRegion ? (
                <span className="rounded bg-[var(--bg-raised)] px-1 text-[var(--text-secondary)]">
                  Cross-region
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">p50</span>
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder={String(defaultP50)}
                value={edge.networkLatency?.p50 ?? ''}
                onChange={(e) => {
                  const p50 = Number(e.target.value);
                  onUpdate(edge.id, (d) => {
                    if (!e.target.value) {
                      delete d.networkLatency;
                      return;
                    }
                    const currentP95 = d.networkLatency?.p95 ?? Math.max(p50, p50 * 2.5);
                    d.networkLatency = {
                      distribution: 'lognormal',
                      p50: Math.max(0, p50),
                      p95: Math.max(p50, currentP95),
                    };
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">p95</span>
              <input
                type="number"
                min={0}
                step={0.1}
                placeholder={String(defaultP95)}
                value={edge.networkLatency?.p95 ?? ''}
                onChange={(e) => {
                  const p95 = Number(e.target.value);
                  onUpdate(edge.id, (d) => {
                    if (!e.target.value) {
                      delete d.networkLatency;
                      return;
                    }
                    const currentP50 = d.networkLatency?.p50 ?? defaultP50;
                    d.networkLatency = {
                      distribution: 'lognormal',
                      p50: Math.min(currentP50, Math.max(0, p95)),
                      p95: Math.max(0, p95),
                    };
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Tunnel</span>
              <select
                aria-label="Network tunnel"
                value={edge.tunnel ?? 'none'}
                onChange={(e) => {
                  const val = e.target.value as 'none' | 'privatelink' | 'vpn';
                  onUpdate(edge.id, (d) => {
                    if (val === 'none') {
                      delete d.tunnel;
                    } else {
                      d.tunnel = val;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
              >
                <option value="none">Direct</option>
                <option value="privatelink">PrivateLink (+0.3/0.8 ms)</option>
                <option value="vpn">Over VPN (+10/30 ms)</option>
              </select>
            </label>
            <label className="block">
              <span
                className="text-[10px] text-[var(--text-muted)]"
                title="Typical default (1 Gbps) — edit me"
              >
                Bandwidth (Gbps)
              </span>
              <input
                type="number"
                aria-label="Bandwidth (Gbps)"
                min={0.01}
                step={0.5}
                value={edge.bandwidthGbps ?? 1}
                onChange={(e) => {
                  const gbps = Number(e.target.value);
                  onUpdate(edge.id, (d) => {
                    if (!Number.isFinite(gbps) || gbps <= 0 || gbps === 1) {
                      delete d.bandwidthGbps;
                    } else {
                      d.bandwidthGbps = gbps;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>
          </div>
        </div>

        {/* Retries & Circuit Breaker */}
        <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            Retries & circuit breaker
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Max retries</span>
              <input
                type="number"
                min={0}
                max={10}
                value={edge.retry?.max ?? 0}
                onChange={(e) => {
                  const max = Math.max(0, Math.round(Number(e.target.value)));
                  onUpdate(edge.id, (d) => {
                    if (max === 0) {
                      delete d.retry;
                    } else {
                      d.retry = {
                        max,
                        backoffMs: d.retry?.backoffMs ?? 50,
                        jitter: d.retry?.jitter ?? true,
                      };
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Backoff (ms)</span>
              <input
                type="number"
                min={1}
                value={edge.retry?.backoffMs ?? 50}
                disabled={!edge.retry || edge.retry.max === 0}
                onChange={(e) => {
                  const backoffMs = Math.max(1, Number(e.target.value));
                  onUpdate(edge.id, (d) => {
                    if (d.retry) {
                      d.retry.backoffMs = backoffMs;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)] disabled:opacity-40"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">CB threshold</span>
              <input
                type="number"
                min={0}
                placeholder="Off"
                value={edge.circuitBreaker?.failureThreshold ?? ''}
                onChange={(e) => {
                  const threshold = Number(e.target.value);
                  onUpdate(edge.id, (d) => {
                    if (!e.target.value || threshold <= 0) {
                      delete d.circuitBreaker;
                    } else {
                      d.circuitBreaker = {
                        failureThreshold: Math.round(threshold),
                        windowMs: d.circuitBreaker?.windowMs ?? 10000,
                        openMs: d.circuitBreaker?.openMs ?? 5000,
                      };
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">CB open (ms)</span>
              <input
                type="number"
                min={100}
                step={500}
                disabled={!edge.circuitBreaker}
                value={edge.circuitBreaker?.openMs ?? 5000}
                onChange={(e) => {
                  const openMs = Math.max(100, Number(e.target.value));
                  onUpdate(edge.id, (d) => {
                    if (d.circuitBreaker) {
                      d.circuitBreaker.openMs = openMs;
                    }
                  });
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)] disabled:opacity-40"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDelete(edge.id)}
            className="h-7 px-2.5 text-[11px]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Delete edge</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2.5 text-[11px]">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
