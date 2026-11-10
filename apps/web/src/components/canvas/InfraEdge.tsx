'use client';

import { memo, useEffect } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { EdgeFrame, EdgeInstance } from '@infrasim/shared-types';
import { useCanvasSimState, useEdgePathRegistry } from './CanvasSimContext';
import { computeEdgeLabelPlacement } from './edgeLabelLayout';

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

  const simState = useCanvasSimState();
  const pathRegistry = useEdgePathRegistry();

  const edge = data?.edgeInstance;
  const frame = simState ? simState.currentFrame?.edges[id] : data?.frame;
  const blocked = Boolean(data?.blockedReason);
  const isAsync = edge?.callType === 'async';

  useEffect(() => {
    if (!pathRegistry) {
      return;
    }
    pathRegistry.registerEdgePath(id, edgePath, blocked);
  }, [pathRegistry, id, edgePath, blocked]);

  useEffect(() => {
    if (!pathRegistry) {
      return;
    }
    return () => {
      pathRegistry.unregisterEdgePath(id);
    };
  }, [pathRegistry, id]);

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
  const labelText = `${blocked ? '✖ ' : ''}${protoText}${weightText}${rpsText}`;

  const placement = computeEdgeLabelPlacement({
    sourceX,
    sourceY,
    targetX,
    targetY,
    labelX,
    labelY,
    labelTextLength: labelText.length,
  });

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

      <EdgeLabelRenderer>
        <div
          data-testid={`edge-label-${id}`}
          data-offset={placement.isOffset ? 'true' : 'false'}
          style={{
            transform: `translate(-50%, -50%) translate(${placement.x}px,${placement.y}px)`,
          }}
          className={`nodrag nopan pointer-events-auto absolute whitespace-nowrap rounded-[5px] border px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition-colors ${
            selected
              ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : blocked
                ? 'border-[var(--status-overloaded)] bg-[var(--bg-surface)] text-[var(--status-overloaded)]'
                : 'border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          {placement.isOffset && placement.stemHeight > 0 ? (
            <span
              aria-hidden="true"
              style={{ height: `${placement.stemHeight}px` }}
              className="pointer-events-none absolute left-1/2 top-full w-px -translate-x-1/2 bg-[var(--border-strong)] opacity-60"
            />
          ) : null}
          {labelText}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const InfraEdge = memo(InfraEdgeComponent);
