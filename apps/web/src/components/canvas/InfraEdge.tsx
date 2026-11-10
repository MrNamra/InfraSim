'use client';

import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { EdgeFrame, EdgeInstance } from '@infrasim/shared-types';

export interface InfraEdgeData extends Record<string, unknown> {
  edgeInstance: EdgeInstance;
  frame?: EdgeFrame;
  particleCount?: number;
  reducedMotion?: boolean;
  blockedReason?: string;
}

export type InfraFlowEdge = Edge<InfraEdgeData, 'infraEdge'>;

function InfraEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<InfraFlowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edge = data?.edgeInstance;
  const frame = data?.frame;
  const blocked = Boolean(data?.blockedReason);
  const reducedMotion = Boolean(data?.reducedMotion);
  const isAsync = edge?.callType === 'async';

  const strokeColor = blocked
    ? 'var(--status-overloaded)'
    : selected
      ? 'var(--accent)'
      : frame && frame.errorRate > 0.01
        ? 'var(--status-overloaded)'
        : 'var(--border-strong)';

  const portPart = edge?.port ? `:${edge.port}` : '';
  const protoText = `${edge?.protocol ?? 'https'}${portPart}`;
  const weightText = edge && edge.weight !== 1 ? ` w=${edge.weight}` : '';
  const rpsText = frame && frame.rps > 0 ? ` · ${Math.round(frame.rps)}/s` : '';

  // Particle dots along active edge (globally capped <= 300 in Canvas.tsx)
  const particleCount =
    data?.particleCount !== undefined
      ? data.particleCount
      : frame && frame.rps > 0
        ? Math.min(4, Math.max(1, Math.ceil(Math.log10(frame.rps + 1))))
        : 0;
  const particleColor =
    frame && frame.errorRate > 0.1
      ? 'var(--status-overloaded)'
      : frame && frame.avgLatencyMs > 250
        ? 'var(--status-warm)'
        : 'var(--status-ok)';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: blocked || isAsync ? '5 4' : undefined,
        }}
      />

      {particleCount > 0 && !blocked && !reducedMotion ? (
        <g aria-hidden="true" className="pointer-events-none">
          {Array.from({ length: particleCount }).map((_, idx) => (
            <circle key={idx} r={2.5} fill={particleColor}>
              <animateMotion
                dur={`${Math.max(0.6, 1.8 - Math.min(1, (frame?.rps ?? 1) / 500))}s`}
                begin={`${(idx / particleCount) * 0.9}s`}
                repeatCount="indefinite"
                path={edgePath}
              />
            </circle>
          ))}
        </g>
      ) : particleCount > 0 && !blocked && reducedMotion ? (
        <circle
          cx={(sourceX + targetX) / 2}
          cy={(sourceY + targetY) / 2}
          r={2.5}
          fill={particleColor}
          aria-hidden="true"
          className="pointer-events-none"
        />
      ) : null}

      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
          className={`nodrag nopan pointer-events-auto absolute rounded-[5px] border px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition-colors ${
            selected
              ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : blocked
                ? 'border-[var(--status-overloaded)] bg-[var(--bg-surface)] text-[var(--status-overloaded)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          {blocked ? '✖ ' : ''}
          {protoText}
          {weightText}
          {rpsText}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const InfraEdge = memo(InfraEdgeComponent);
