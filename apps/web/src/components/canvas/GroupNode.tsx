'use client';

import { memo } from 'react';
import { Globe, Lock } from 'lucide-react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import type { GroupInstance } from '@infrasim/shared-types';

export interface GroupNodeData extends Record<string, unknown> {
  group: GroupInstance;
}

export type GroupFlowNode = Node<GroupNodeData, 'groupNode'>;

const KIND_LABELS: Record<GroupInstance['kind'], string> = {
  region: 'Region',
  vpc: 'VPC',
  subnet: 'Subnet',
  az: 'AZ',
  cluster: 'Cluster',
  zone: 'Zone',
  compartment: 'Compartment',
  custom: 'Group',
};

function GroupNodeComponent({ data, selected }: NodeProps<GroupFlowNode>) {
  const { group } = data;

  return (
    <div
      data-testid={`canvas-group-${group.id}`}
      className={`relative h-full w-full rounded-[12px] border border-dashed bg-[rgba(35,35,37,0.18)] transition-colors ${
        selected
          ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
          : 'border-[var(--border-strong)]'
      }`}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={192}
        minHeight={128}
        lineClassName="!border-[var(--accent)]"
        handleClassName="!h-2.5 !w-2.5 !rounded-[2px] !border-[var(--bg-surface)] !bg-[var(--accent)]"
      />

      <div className="flex items-center justify-between gap-2 border-b border-dashed border-[var(--border-hairline)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
            {KIND_LABELS[group.kind]}
          </span>
          <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
            {group.label}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {group.cidr ? (
            <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
              {group.cidr}
            </span>
          ) : null}
          {group.kind === 'subnet' && group.public !== undefined ? (
            <span
              data-testid={`subnet-visibility-${group.id}`}
              className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"
            >
              {group.public ? (
                <Globe className="h-2.5 w-2.5 text-[var(--accent)]" strokeWidth={1.5} />
              ) : (
                <Lock className="h-2.5 w-2.5 text-[var(--text-muted)]" strokeWidth={1.5} />
              )}
              <span>{group.public ? 'Public' : 'Private'}</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeComponent);
