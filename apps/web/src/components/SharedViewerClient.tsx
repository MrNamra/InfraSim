'use client';

import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import { Eye, Layers, Moon, Sun } from 'lucide-react';
import { getService } from '@infrasim/catalog';
import type { Design, NodeInstance } from '@infrasim/shared-types';
import { LogoMark } from '@infrasim/ui-kit';
import { fetchSharedDesignApi } from '../lib/api';
import { getGroupRect, sortGroupsParentsFirst, worldToFlowPosition } from '../lib/canvasGeometry';
import { decodeSharedDesignFragment, sanitizeDesignForShare } from '../lib/shareEncoding';
import { GroupNode, type GroupFlowNode } from './canvas/GroupNode';
import { InfraEdge, type InfraFlowEdge } from './canvas/InfraEdge';
import { ServiceNode, type ServiceFlowNode } from './canvas/ServiceNode';
import { PROVIDER_META, ServiceIcon } from './ServiceIcon';

const nodeTypes: NodeTypes = {
  serviceNode: ServiceNode,
  groupNode: GroupNode,
};

const edgeTypes: EdgeTypes = {
  infraEdge: InfraEdge,
};

export interface SharedViewerClientProps {
  token: string;
}

/** Mobile-first responsive read-only viewer rendered for `/shared/[token]` and portable `#d=...` links. */
export function SharedViewerClient({ token }: SharedViewerClientProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [design, setDesign] = useState<Design | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'diagram' | 'summary'>('diagram');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem('infrasim.theme');
    const resolved = saved === 'light' || saved === 'dark' ? saved : 'dark';
    setTheme(resolved);
    document.documentElement.dataset.theme = resolved;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (token === 'inline') {
      const parsed = decodeSharedDesignFragment(window.location.hash);
      if (parsed) {
        setDesign(parsed);
        setSelectedNodeId(parsed.nodes[0]?.id ?? null);
      } else {
        setError('Shared snapshot payload is missing or corrupted.');
      }
      setLoading(false);
      return;
    }

    void fetchSharedDesignApi(token)
      .then((res) => {
        if (cancelled) return;
        const clean = sanitizeDesignForShare(res.doc);
        setDesign(clean);
        setVersion(res.version);
        setSelectedNodeId(clean.nodes[0]?.id ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Shared design could not be loaded.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!design) return { flowNodes: [], flowEdges: [] };
    const groups = design.groups ?? [];
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    const customById = new Map((design.customServices ?? []).map((c) => [c.id, c]));
    const orderedGroups = sortGroupsParentsFirst(groups);

    const groupNodes: GroupFlowNode[] = orderedGroups.map((g) => {
      const rect = getGroupRect(g);
      const parentGroup = g.parentGroupId ? groupsById.get(g.parentGroupId) : undefined;
      return {
        id: g.id,
        type: 'groupNode',
        position: worldToFlowPosition({ x: rect.x, y: rect.y }, parentGroup),
        style: { width: rect.width, height: rect.height },
        ...(g.parentGroupId ? { parentId: g.parentGroupId } : {}),
        data: { group: g },
        selectable: false,
        draggable: false,
      };
    });

    const serviceNodes: ServiceFlowNode[] = design.nodes.map((node) => {
      const parentGroup = node.parentGroupId ? groupsById.get(node.parentGroupId) : undefined;
      const customService = customById.get(node.serviceId);
      return {
        id: node.id,
        type: 'serviceNode',
        position: worldToFlowPosition(node.position, parentGroup),
        ...(node.parentGroupId ? { parentId: node.parentGroupId } : {}),
        data: {
          nodeInstance: node,
          ...(customService ? { customService } : {}),
          allowShake: false,
          reducedMotion: true,
        },
        draggable: false,
        connectable: false,
        selectable: true,
      };
    });

    const edges: InfraFlowEdge[] = design.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'infraEdge',
      data: { edgeInstance: edge, reducedMotion: true },
      selectable: false,
    }));

    return { flowNodes: [...groupNodes, ...serviceNodes], flowEdges: edges };
  }, [design]);

  const selectedNode: NodeInstance | null = useMemo(
    () => design?.nodes.find((n) => n.id === selectedNodeId) ?? design?.nodes[0] ?? null,
    [design, selectedNodeId],
  );

  const selectedService = selectedNode
    ? getService(selectedNode.serviceId, design?.customServices)
    : undefined;

  return (
    <div
      data-testid="shared-viewer-root"
      className="flex min-h-screen w-full max-w-full flex-col overflow-x-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]"
    >
      {/* Compact responsive top header (safe <= 375px width) */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="flex shrink-0 items-center gap-1.5" title="Open InfraSim">
            <LogoMark className="h-4 w-4 text-[var(--text-primary)]" />
            <span className="text-[14px] font-medium">InfraSim</span>
          </Link>
          <span className="h-3.5 w-px shrink-0 bg-[var(--border-hairline)]" />
          <span
            data-testid="shared-design-name"
            className="truncate text-[13px] font-medium text-[var(--text-primary)]"
          >
            {design?.name ?? 'Shared design'}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span
            data-testid="shared-readonly-badge"
            className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
          >
            <Eye className="h-3 w-3 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>Read-only{version ? ` · v${version}` : ''}</span>
          </span>

          <button
            type="button"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)]"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <Moon className="h-4 w-4" strokeWidth={1.5} />
            )}
          </button>
        </div>
      </header>

      {/* Mobile view switcher (< 768px) */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-1.5 md:hidden">
        <button
          type="button"
          data-testid="mobile-tab-diagram"
          onClick={() => setMobileTab('diagram')}
          className={`flex-1 rounded-[6px] py-1.5 text-[12px] font-medium ${
            mobileTab === 'diagram'
              ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          Diagram
        </button>
        <button
          type="button"
          data-testid="mobile-tab-summary"
          onClick={() => setMobileTab('summary')}
          className={`flex-1 rounded-[6px] py-1.5 text-[12px] font-medium ${
            mobileTab === 'summary'
              ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          Nodes & details ({design?.nodes.length ?? 0})
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-[var(--text-muted)]">
          Loading shared architecture...
        </div>
      ) : error || !design ? (
        <div
          data-testid="shared-error-state"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <Layers className="h-6 w-6 text-[var(--text-muted)]" strokeWidth={1.5} />
          <p className="text-[13px] text-[var(--text-primary)]">
            {error ?? 'Shared design not found.'}
          </p>
          <Link href="/" className="text-[12px] font-medium text-[var(--accent)] hover:underline">
            Return to InfraSim workspace
          </Link>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={`relative h-[calc(100vh-5.5rem)] min-h-[360px] w-full flex-1 md:h-auto ${
              mobileTab === 'diagram' ? 'block' : 'hidden md:block'
            }`}
          >
            <ReactFlowProvider>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                fitView
                onNodeClick={(_evt, node) => {
                  if (node.type === 'serviceNode') {
                    setSelectedNodeId(node.id);
                  }
                }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>

          <aside
            data-testid="shared-summary-panel"
            className={`w-full shrink-0 flex-col border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] md:flex md:w-80 md:border-l md:border-t-0 ${
              mobileTab === 'summary' ? 'flex flex-1' : 'hidden md:flex'
            }`}
          >
            <div className="border-b border-[var(--border-hairline)] px-4 py-3">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                Architecture overview
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
                <div className="rounded-[6px] bg-[var(--bg-sunken)] px-2 py-1.5">
                  <div className="text-[10px] text-[var(--text-muted)]">Nodes</div>
                  <div className="text-[13px] text-[var(--text-primary)]">
                    {design.nodes.length}
                  </div>
                </div>
                <div className="rounded-[6px] bg-[var(--bg-sunken)] px-2 py-1.5">
                  <div className="text-[10px] text-[var(--text-muted)]">Edges</div>
                  <div className="text-[13px] text-[var(--text-primary)]">
                    {design.edges.length}
                  </div>
                </div>
                <div className="rounded-[6px] bg-[var(--bg-sunken)] px-2 py-1.5">
                  <div className="text-[10px] text-[var(--text-muted)]">Scenarios</div>
                  <div className="text-[13px] text-[var(--text-primary)]">
                    {design.scenarios.length}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-[var(--text-secondary)]">Services</div>
                <div className="space-y-1">
                  {design.nodes.map((n) => {
                    const svc = getService(n.serviceId, design.customServices);
                    const prov = svc ? PROVIDER_META[svc.provider] : null;
                    const active = n.id === selectedNode?.id;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => setSelectedNodeId(n.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-[6px] border px-2.5 py-2 text-left transition-colors ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
                            : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)] hover:border-[var(--border-strong)]'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ServiceIcon
                            icon={svc?.icon ?? 'generic'}
                            serviceId={n.serviceId}
                            className="h-4 w-4 shrink-0"
                          />
                          <span className="truncate font-medium text-[var(--text-primary)]">
                            {n.label}
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                          {prov?.short ?? svc?.provider ?? ''} ×{n.config.instances}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedNode ? (
                <div
                  data-testid="shared-node-inspector"
                  className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[var(--text-primary)]">
                      {selectedNode.label}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">
                      {selectedNode.serviceId}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
                    <div>Instances: {selectedNode.config.instances}</div>
                    <div>Kind: {selectedService?.kind ?? 'service'}</div>
                    <div>Region: {selectedNode.region ?? 'default'}</div>
                    <div>AZ: {selectedNode.az ?? 'single'}</div>
                    {selectedNode.config.instanceType ? (
                      <div className="col-span-2">SKU: {selectedNode.config.instanceType}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
