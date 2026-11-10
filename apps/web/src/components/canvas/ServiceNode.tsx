'use client';

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type {
  HealthState,
  NodeFrame,
  NodeInstance,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { getService } from '@infrasim/catalog';
import { formatLatencyShort } from '../../lib/palette';
import { PROVIDER_META, ServiceIcon } from '../ServiceIcon';

export interface ServiceNodeData extends Record<string, unknown> {
  nodeInstance: NodeInstance;
  customService?: ServiceDefinition;
  frame?: NodeFrame;
  topReason?: string;
  allowShake?: boolean;
  reducedMotion?: boolean;
}

export type ServiceFlowNode = Node<ServiceNodeData, 'serviceNode'>;

const HEALTH_META: Record<HealthState, { symbol: string; label: string; colorVar: string }> = {
  ok: { symbol: '●', label: 'Healthy', colorVar: 'var(--status-ok)' },
  warm: { symbol: '◐', label: 'Warming up', colorVar: 'var(--status-warm)' },
  hot: { symbol: '▲', label: 'Under stress', colorVar: 'var(--status-hot)' },
  overloaded: { symbol: '⚠', label: 'Overloaded', colorVar: 'var(--status-overloaded)' },
  down: { symbol: '✖', label: 'Down', colorVar: 'var(--status-down)' },
};

function ServiceNodeComponent({ data, selected }: NodeProps<ServiceFlowNode>) {
  const {
    nodeInstance,
    customService,
    frame,
    topReason,
    allowShake = true,
    reducedMotion = false,
  } = data;
  const service = customService ?? getService(nodeInstance.serviceId);
  const provider = service?.provider ?? 'generic';
  const meta = PROVIDER_META[provider];

  const effectiveLatency = nodeInstance.config.latency ?? service?.latency;
  const p50 = effectiveLatency?.p50 ?? 0;
  const isEdited = Boolean(
    nodeInstance.config.latency ||
    nodeInstance.config.errorRate !== undefined ||
    nodeInstance.config.rateLimit ||
    nodeInstance.config.coldStart ||
    Object.keys(nodeInstance.config.operations ?? {}).length > 0,
  );

  const health: HealthState | null = frame?.health ?? null;
  const healthInfo = health ? HEALTH_META[health] : null;
  const utilization = frame?.utilization ?? 0;
  const barPercent = (Math.min(utilization, 1.2) / 1.2) * 100;
  const overflow = utilization > 1;
  const cpuUtilization = frame?.cpuUtilization ?? 0;
  const showCpuBar =
    frame && (service?.kind === 'compute' || service?.kind === 'fn') && cpuUtilization > 0;

  const isOverloaded = health === 'overloaded';
  const errorsTotal = frame
    ? Object.values(frame.errorsPerSec).reduce<number>((sum, val) => sum + (val ?? 0), 0)
    : 0;
  const dropCount = frame ? errorsTotal + frame.dropsPerSec : 0;

  const motionClass = isOverloaded
    ? reducedMotion
      ? 'infrasim-pulse-overloaded infrasim-motion-safe'
      : allowShake
        ? 'infrasim-shake infrasim-motion-safe'
        : 'ring-1 ring-[var(--status-overloaded)]'
    : '';

  const shakeAmp = dropCount > 50 ? '3px' : dropCount > 10 ? '2.5px' : '2px';

  return (
    <div
      data-testid={`canvas-node-${nodeInstance.id}`}
      data-service-id={nodeInstance.serviceId}
      data-health={health ?? 'idle'}
      aria-label={
        frame
          ? `${nodeInstance.label}: ${healthInfo?.label.toLowerCase() ?? 'idle'}, ${Math.round(utilization * 100)}% utilization${dropCount > 0 ? `, ${Math.round(dropCount)} errors per second` : ''}`
          : `${nodeInstance.label} (${service?.name ?? nodeInstance.serviceId})`
      }
      style={{ '--shake-amplitude': shakeAmp } as React.CSSProperties}
      className={`group relative w-[216px] overflow-hidden rounded-[10px] border bg-[var(--bg-surface)] text-[var(--text-primary)] transition-colors ${motionClass} ${
        selected
          ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
          : isOverloaded
            ? 'border-[var(--status-overloaded)]'
            : health === 'hot'
              ? 'border-[var(--status-hot)]'
              : health === 'warm'
                ? 'border-[var(--status-warm)]'
                : 'border-[var(--border-strong)] hover:border-[var(--text-muted)]'
      } ${health === 'down' ? 'opacity-60 grayscale' : ''}`}
      title={
        frame
          ? `${nodeInstance.label} — ${Math.round(utilization * 100)}% util (${healthInfo?.label ?? ''}), p95 ${Math.round(frame.latency.p95)} ms${topReason ? ` — ${topReason}` : ''}`
          : `${nodeInstance.label} (${service?.id ?? nodeInstance.serviceId})`
      }
    >
      {/* Left provider stripe */}
      <div
        className="absolute bottom-0 left-0 top-0 w-[3px]"
        style={{ backgroundColor: meta.stripeColor }}
        aria-hidden="true"
      />

      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border !border-[var(--bg-surface)] !bg-[var(--text-muted)] group-hover:!bg-[var(--accent)]"
      />

      <div className="px-3 py-2 pl-3.5">
        {/* Top row: icon + label + timing/instances */}
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-[var(--bg-raised)] text-[var(--text-secondary)]">
            <ServiceIcon icon={service?.icon ?? 'generic'} className="h-3.5 w-3.5" />
          </span>

          <span
            className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
              health === 'down' ? 'line-through' : ''
            }`}
          >
            {nodeInstance.label}
          </span>

          {isEdited ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
              title="Latency or mock customized"
              aria-label="Customized node configuration"
            />
          ) : null}
        </div>

        {/* Meta row: timing chip, instances, health glyph */}
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
              {formatLatencyShort(p50)}
            </span>
            <span
              data-testid="node-instances-badge"
              className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]"
            >
              ×{frame ? frame.instancesActive : nodeInstance.config.instances}
            </span>
            {frame && frame.queueDepth > 0 ? (
              <span className="font-mono text-[10px] tabular-nums text-[var(--status-warm)]">
                q:{Math.round(frame.queueDepth)}
              </span>
            ) : null}
          </div>

          {healthInfo ? (
            <span
              className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums"
              style={{ color: healthInfo.colorVar }}
            >
              <span aria-hidden="true">{healthInfo.symbol}</span>
              <span>{Math.round(utilization * 100)}%</span>
              <span className="sr-only">{healthInfo.label}</span>
            </span>
          ) : (
            <span className="font-mono text-[10px] text-[var(--text-muted)]">{meta.short}</span>
          )}
        </div>

        {/* Segmented Utilization Bar (60 / 80 / 95% ticks) */}
        <div className="relative mt-2 flex items-center gap-1">
          <div
            className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]"
            role="meter"
            aria-label={`${nodeInstance.label} utilization`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(utilization * 100))}
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-100"
              style={{
                width: `${frame ? Math.max(2, barPercent) : 0}%`,
                backgroundColor: healthInfo ? healthInfo.colorVar : 'var(--border-strong)',
              }}
            />
            {/* Segment ticks at 50% (=60% of 1.2), 66.7% (=80%), 79.2% (=95%) */}
            <span
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--bg-surface)] opacity-70"
              style={{ left: '50%' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--bg-surface)] opacity-70"
              style={{ left: '66.67%' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--bg-surface)] opacity-70"
              style={{ left: '79.17%' }}
              aria-hidden="true"
            />
          </div>

          {overflow ? (
            <span
              className="font-mono text-[10px] font-medium leading-none text-[var(--status-overloaded)]"
              title="Utilization exceeds 100%"
            >
              +
            </span>
          ) : null}
        </div>

        {/* Secondary thin CPU bar when saturated or active on compute/fn nodes */}
        {showCpuBar ? (
          <div
            className="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
            title={`CPU ${Math.round(cpuUtilization * 100)}%`}
          >
            <div
              className="h-full transition-[width] duration-100"
              style={{
                width: `${Math.min(100, Math.round(cpuUtilization * 100))}%`,
                backgroundColor:
                  cpuUtilization > 0.85 ? 'var(--status-overloaded)' : 'var(--accent)',
              }}
            />
          </div>
        ) : null}

        {isOverloaded && frame ? (
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--status-overloaded)]">
            <span className="truncate">{topReason ?? 'Capacity saturated'}</span>
            <span className="shrink-0 font-mono tabular-nums">
              {dropCount > 0 ? `${Math.round(dropCount)} err/s` : 'Overloaded'}
            </span>
          </div>
        ) : null}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border !border-[var(--bg-surface)] !bg-[var(--text-muted)] group-hover:!bg-[var(--accent)]"
      />
    </div>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);
