'use client';

import '@xyflow/react/dist/style.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes,
  type OnMoveEnd,
  type OnNodeDrag,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Grid3x3, Maximize2, Trash2 } from 'lucide-react';
import type { SimFrame } from '@infrasim/shared-types';
import {
  flowToWorldPosition,
  getGroupRect,
  sortGroupsParentsFirst,
  worldToFlowPosition,
} from '../../lib/canvasGeometry';
import { DRAG_SERVICE_MIME } from '../../lib/palette';
import { useDesignStore } from '../../store/designStore';
import {
  CanvasSimStateContext,
  EdgePathRegistryContext,
  type EdgeGeometryEntry,
  type EdgePathRegistryValue,
} from './CanvasSimContext';
import { EdgeParticlesOverlay } from './EdgeParticlesOverlay';
import { EdgePopover } from './EdgePopover';
import { GroupNode, type GroupFlowNode } from './GroupNode';
import { InfraEdge, type InfraFlowEdge } from './InfraEdge';
import { ServiceNode, type ServiceFlowNode } from './ServiceNode';

type CanvasFlowNode = GroupFlowNode | ServiceFlowNode;

const nodeTypes: NodeTypes = {
  serviceNode: ServiceNode,
  groupNode: GroupNode,
};

const edgeTypes: EdgeTypes = {
  infraEdge: InfraEdge,
};

export interface CanvasProps {
  theme?: 'dark' | 'light';
  currentFrame?: SimFrame | null;
  nodeReasons?: Record<string, string>;
  reducedMotion?: boolean;
  onInspectNode?: (nodeId: string, tab: 'config' | 'latency' | 'why') => void;
  onLoadTemplateClick?: () => void;
  registerViewportCenterGetter?: (getter: () => { x: number; y: number }) => void;
}

interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

function CanvasInner({
  theme = 'dark',
  currentFrame = null,
  nodeReasons = {},
  reducedMotion = false,
  onInspectNode,
  onLoadTemplateClick,
  registerViewportCenterGetter,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance<CanvasFlowNode, InfraFlowEdge> | null>(null);

  const design = useDesignStore((s) => s.design);
  const selectedNodeId = useDesignStore((s) => s.selectedNodeId);
  const selectedEdgeId = useDesignStore((s) => s.selectedEdgeId);
  const selectedGroupId = useDesignStore((s) => s.selectedGroupId);
  const snapEnabled = useDesignStore((s) => s.snapEnabled);
  const addServiceNode = useDesignStore((s) => s.addServiceNode);
  const moveNodeWorldPosition = useDesignStore((s) => s.moveNodeWorldPosition);
  const moveGroupWorldPosition = useDesignStore((s) => s.moveGroupWorldPosition);
  const resizeGroup = useDesignStore((s) => s.resizeGroup);
  const connectEdge = useDesignStore((s) => s.connectEdge);
  const updateEdge = useDesignStore((s) => s.updateEdge);
  const deleteElements = useDesignStore((s) => s.deleteElements);
  const selectNode = useDesignStore((s) => s.selectNode);
  const selectEdge = useDesignStore((s) => s.selectEdge);
  const selectGroup = useDesignStore((s) => s.selectGroup);
  const clearSelection = useDesignStore((s) => s.clearSelection);
  const duplicateSelection = useDesignStore((s) => s.duplicateSelection);
  const copySelection = useDesignStore((s) => s.copySelection);
  const pasteClipboard = useDesignStore((s) => s.pasteClipboard);
  const resetNodeLatencyDefaults = useDesignStore((s) => s.resetNodeLatencyDefaults);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);
  const setSnapEnabled = useDesignStore((s) => s.setSnapEnabled);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [liveNodes, setLiveNodes] = useState<CanvasFlowNode[]>([]);
  const lastFittedDesignIdRef = useRef<string | null>(null);

  // Cap concurrent shaking overloaded nodes at 30 per spec 16 §4
  const shakingAllowedIds = useMemo(() => {
    const allowed = new Set<string>();
    if (!currentFrame) {
      return allowed;
    }
    let count = 0;
    for (const [nodeId, nf] of Object.entries(currentFrame.nodes)) {
      if (nf.health === 'overloaded' && count < 30) {
        allowed.add(nodeId);
        count++;
      }
    }
    return allowed;
  }, [currentFrame]);

  // Derive React Flow nodes from canonical Design + active SimulationFrame
  const derivedNodes = useMemo<CanvasFlowNode[]>(() => {
    const groupsSorted = sortGroupsParentsFirst(design.groups);
    const groupsById = new Map(design.groups.map((g) => [g.id, g]));
    const customMap = new Map((design.customServices ?? []).map((s) => [s.id, s]));

    const flowGroups: GroupFlowNode[] = groupsSorted.map((group) => {
      const rect = getGroupRect(group);
      const parentGroup = group.parentGroupId ? groupsById.get(group.parentGroupId) : undefined;
      return {
        id: group.id,
        type: 'groupNode',
        position: worldToFlowPosition({ x: rect.x, y: rect.y }, parentGroup),
        style: { width: rect.width, height: rect.height },
        ...(parentGroup ? { parentId: parentGroup.id } : {}),
        selected: selectedGroupId === group.id,
        data: { group },
        zIndex: 0,
      };
    });

    const flowServices: ServiceFlowNode[] = design.nodes.map((node) => {
      const parentGroup = node.parentGroupId ? groupsById.get(node.parentGroupId) : undefined;
      return {
        id: node.id,
        type: 'serviceNode',
        position: worldToFlowPosition(node.position, parentGroup),
        ...(parentGroup ? { parentId: parentGroup.id } : {}),
        selected: selectedNodeId === node.id,
        data: {
          nodeInstance: node,
          customService: customMap.get(node.serviceId),
        },
        zIndex: 10,
      };
    });

    return [...flowGroups, ...flowServices];
  }, [design.groups, design.nodes, design.customServices, selectedGroupId, selectedNodeId]);

  const liveNodesRef = useRef<CanvasFlowNode[]>(liveNodes);
  useEffect(() => {
    setLiveNodes(derivedNodes);
    liveNodesRef.current = derivedNodes;
  }, [derivedNodes]);

  // Fit viewport when switching to a populated template or loaded design
  useEffect(() => {
    if (design.nodes.length + design.groups.length === 0) {
      lastFittedDesignIdRef.current = design.id;
      return;
    }
    if (lastFittedDesignIdRef.current === design.id || !rfInstanceRef.current) {
      return;
    }
    lastFittedDesignIdRef.current = design.id;
    const raf = window.requestAnimationFrame(() => {
      rfInstanceRef.current?.fitView({ padding: 0.18, duration: reducedMotion ? 0 : 150 });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [design.id, design.nodes.length, design.groups.length, reducedMotion]);

  // Topology-only React Flow edges; live frame traffic and 60fps particles bypass full-graph rebuilds
  const flowEdges = useMemo<InfraFlowEdge[]>(() => {
    return design.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: 'infraEdge',
      selected: selectedEdgeId === edge.id,
      data: {
        edgeInstance: edge,
      },
    }));
  }, [design.edges, selectedEdgeId]);

  const edgeGeomMapRef = useRef<Map<string, EdgeGeometryEntry>>(new Map());
  const geomListenersRef = useRef<Set<() => void>>(new Set());

  const edgePathRegistry = useMemo<EdgePathRegistryValue>(() => {
    const notifyGeometry = () => {
      for (const listener of geomListenersRef.current) {
        listener();
      }
    };
    return {
      registerEdgePath: (edgeId, pathD, blocked) => {
        const prev = edgeGeomMapRef.current.get(edgeId);
        if (prev && prev.pathD === pathD && prev.blocked === blocked) {
          return;
        }
        edgeGeomMapRef.current.set(edgeId, { edgeId, pathD, blocked });
        notifyGeometry();
      },
      unregisterEdgePath: (edgeId) => {
        if (edgeGeomMapRef.current.delete(edgeId)) {
          notifyGeometry();
        }
      },
      getEdgeGeometries: () => edgeGeomMapRef.current,
      subscribeGeometry: (listener) => {
        geomListenersRef.current.add(listener);
        return () => {
          geomListenersRef.current.delete(listener);
        };
      },
    };
  }, []);

  const simContextValue = useMemo(
    () => ({
      currentFrame,
      nodeReasons,
      shakingAllowedIds,
      reducedMotion,
    }),
    [currentFrame, nodeReasons, shakingAllowedIds, reducedMotion],
  );

  // Register viewport-center getter for double-click insert in Palette
  useEffect(() => {
    if (!registerViewportCenterGetter) {
      return;
    }
    registerViewportCenterGetter(() => {
      const rf = rfInstanceRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rf || !rect) {
        return { x: 240, y: 180 };
      }
      const center = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      return { x: center.x - 108, y: center.y - 36 };
    });
  }, [registerViewportCenterGetter]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    setLiveNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      liveNodesRef.current = next;
      return next;
    });
  }, []);

  const onNodeDragStop: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node) => {
      const groupsById = new Map(design.groups.map((g) => [g.id, g]));
      const parentGroup = node.parentId ? groupsById.get(node.parentId) : undefined;
      const worldPos = flowToWorldPosition(node.position, parentGroup);
      if (node.type === 'groupNode') {
        moveGroupWorldPosition(node.id, worldPos);
      } else {
        moveNodeWorldPosition(node.id, worldPos);
      }
    },
    [design.groups, moveGroupWorldPosition, moveNodeWorldPosition],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        connectEdge(connection.source, connection.target);
      }
    },
    [connectEdge],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (
      event.dataTransfer.types.includes(DRAG_SERVICE_MIME) ||
      event.dataTransfer.types.includes('text/plain')
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const serviceId =
        event.dataTransfer.getData(DRAG_SERVICE_MIME) || event.dataTransfer.getData('text/plain');
      if (!serviceId) {
        return;
      }
      const rf = rfInstanceRef.current;
      const flowPos = rf
        ? rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
        : { x: 200, y: 160 };
      addServiceNode(serviceId, { x: flowPos.x - 108, y: flowPos.y - 36 });
    },
    [addServiceNode],
  );

  const onNodeClick = useCallback(
    (_e: MouseEvent, node: Node) => {
      setContextMenu(null);
      if (node.type === 'groupNode') {
        selectGroup(node.id);
      } else {
        selectNode(node.id);
      }
    },
    [selectGroup, selectNode],
  );

  const onNodeDoubleClick = useCallback(
    (_e: MouseEvent, node: Node) => {
      if (node.type === 'serviceNode') {
        selectNode(node.id);
        onInspectNode?.(node.id, 'latency');
      }
    },
    [onInspectNode, selectNode],
  );

  const onNodeContextMenu = useCallback(
    (event: MouseEvent, node: Node) => {
      if (node.type !== 'serviceNode') {
        return;
      }
      event.preventDefault();
      selectNode(node.id);
      const rect = containerRef.current?.getBoundingClientRect();
      setContextMenu({
        nodeId: node.id,
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      });
    },
    [selectNode],
  );

  const onEdgeClick = useCallback(
    (_e: MouseEvent, edge: InfraFlowEdge) => {
      setContextMenu(null);
      selectEdge(edge.id);
    },
    [selectEdge],
  );

  const onPaneClick = useCallback(() => {
    setContextMenu(null);
    clearSelection();
  }, [clearSelection]);

  // Persist group resizes on resize completion cleanly from liveNodes dimensions
  const handleNodeResizeSync = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      onNodesChange(changes);
      for (const ch of changes) {
        if (ch.type === 'dimensions' && ch.resizing === false && ch.dimensions) {
          const matchedGroup = design.groups.find((g) => g.id === ch.id);
          const live = liveNodesRef.current.find((n) => n.id === ch.id);
          if (matchedGroup && live) {
            const groupsById = new Map(design.groups.map((g) => [g.id, g]));
            const parentGroup = matchedGroup.parentGroupId
              ? groupsById.get(matchedGroup.parentGroupId)
              : undefined;
            const worldPos = flowToWorldPosition(live.position, parentGroup);
            resizeGroup(matchedGroup.id, {
              x: worldPos.x,
              y: worldPos.y,
              width: ch.dimensions.width,
              height: ch.dimensions.height,
            });
          }
        }
      }
    },
    [design.groups, onNodesChange, resizeGroup],
  );

  // Canvas keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingText =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape') {
        setContextMenu(null);
        return;
      }
      if (isEditingText) {
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      const keyLower = e.key.toLowerCase();

      if (mod && keyLower === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (mod && keyLower === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && keyLower === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (mod && keyLower === 'c') {
        copySelection();
      } else if (mod && keyLower === 'v') {
        e.preventDefault();
        pasteClipboard();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId || selectedEdgeId || selectedGroupId) {
          e.preventDefault();
          deleteElements({
            nodeIds: selectedNodeId ? [selectedNodeId] : [],
            edgeIds: selectedEdgeId ? [selectedEdgeId] : [],
            groupIds: selectedGroupId ? [selectedGroupId] : [],
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    copySelection,
    deleteElements,
    duplicateSelection,
    pasteClipboard,
    redo,
    selectedEdgeId,
    selectedGroupId,
    selectedNodeId,
    undo,
  ]);

  const selectedEdgeObj = useMemo(
    () => (selectedEdgeId ? (design.edges.find((e) => e.id === selectedEdgeId) ?? null) : null),
    [design.edges, selectedEdgeId],
  );
  const selectedEdgeSourceLabel = useMemo(() => {
    if (!selectedEdgeObj) return '';
    return design.nodes.find((n) => n.id === selectedEdgeObj.from)?.label ?? selectedEdgeObj.from;
  }, [design.nodes, selectedEdgeObj]);
  const selectedEdgeTargetLabel = useMemo(() => {
    if (!selectedEdgeObj) return '';
    return design.nodes.find((n) => n.id === selectedEdgeObj.to)?.label ?? selectedEdgeObj.to;
  }, [design.nodes, selectedEdgeObj]);

  const hasSelectedElement = Boolean(selectedNodeId || selectedEdgeId || selectedGroupId);

  const onMoveEnd: OnMoveEnd = useCallback(() => {
    setContextMenu(null);
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="canvas-panel"
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="relative h-full w-full flex-1 bg-[var(--bg-canvas)]"
    >
      <EdgePathRegistryContext.Provider value={edgePathRegistry}>
        <CanvasSimStateContext.Provider value={simContextValue}>
          <ReactFlow<CanvasFlowNode, InfraFlowEdge>
            colorMode={theme}
            nodes={liveNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(instance) => {
              rfInstanceRef.current = instance;
              if (design.nodes.length + design.groups.length > 0) {
                lastFittedDesignIdRef.current = design.id;
                window.requestAnimationFrame(() => {
                  instance.fitView({ padding: 0.18, duration: 0 });
                });
              }
            }}
            onNodesChange={handleNodeResizeSync}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onMoveEnd={onMoveEnd}
            snapToGrid={snapEnabled}
            snapGrid={[16, 16]}
            deleteKeyCode={null}
            minZoom={0.25}
            maxZoom={2}
            fitViewOptions={{ padding: 0.25 }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={16}
              size={1}
              color="var(--grid-dot)"
            />
            <EdgeParticlesOverlay theme={theme} />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              bgColor="var(--bg-sunken)"
              maskColor="var(--minimap-mask)"
              nodeColor="var(--minimap-node)"
              nodeStrokeColor="var(--border-strong)"
            />
          </ReactFlow>
        </CanvasSimStateContext.Provider>
      </EdgePathRegistryContext.Provider>

      {/* Top-right compact canvas controls */}
      <div className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1">
        <button
          type="button"
          title={snapEnabled ? 'Grid snap on (16 px)' : 'Grid snap off'}
          aria-label="Toggle 16px grid snap"
          onClick={() => setSnapEnabled(!snapEnabled)}
          className={`flex h-7 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium transition-colors ${
            snapEnabled
              ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          <Grid3x3 className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>Snap</span>
        </button>

        <button
          type="button"
          title="Fit design to viewport"
          aria-label="Fit view"
          onClick={() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 150 })}
          className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
        >
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>Fit</span>
        </button>

        {hasSelectedElement ? (
          <button
            type="button"
            title="Delete selected item (Del)"
            aria-label="Delete selected"
            onClick={() =>
              deleteElements({
                nodeIds: selectedNodeId ? [selectedNodeId] : [],
                edgeIds: selectedEdgeId ? [selectedEdgeId] : [],
                groupIds: selectedGroupId ? [selectedGroupId] : [],
              })
            }
            className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium text-[var(--status-overloaded)] transition-colors hover:bg-[rgba(229,72,77,0.12)]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Delete</span>
          </button>
        ) : null}
      </div>

      {/* Empty canvas guide overlay (non-blocking drop target) */}
      {design.nodes.length === 0 && design.groups.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
          <div className="pointer-events-auto max-w-md rounded-[14px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center shadow-[var(--shadow-floating)]">
            <h1 className="text-[16px] font-medium text-[var(--text-primary)]">
              Blank architecture canvas
            </h1>
            <p className="mt-1.5 text-[13px] leading-5 text-[var(--text-secondary)]">
              Drag or double-click services from the catalog on the left, connect handles to wire
              traffic paths, or open a starter template.
            </p>
            {onLoadTemplateClick ? (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  data-testid="empty-browse-templates-button"
                  onClick={onLoadTemplateClick}
                  className="h-8 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
                >
                  Browse starter templates
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Edge inspector popover */}
      {selectedEdgeObj ? (
        <EdgePopover
          edge={selectedEdgeObj}
          sourceLabel={selectedEdgeSourceLabel}
          targetLabel={selectedEdgeTargetLabel}
          onUpdate={updateEdge}
          onDelete={(edgeId) => deleteElements({ edgeIds: [edgeId] })}
          onClose={() => selectEdge(null)}
        />
      ) : null}

      {/* Right-click context menu on ServiceNode */}
      {contextMenu ? (
        <div
          data-testid="node-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="absolute z-40 w-44 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-floating)]"
        >
          <button
            type="button"
            onClick={() => {
              onInspectNode?.(contextMenu.nodeId, 'latency');
              setContextMenu(null);
            }}
            className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
          >
            Edit latency & mock
          </button>
          <button
            type="button"
            onClick={() => {
              selectNode(contextMenu.nodeId);
              duplicateSelection();
              setContextMenu(null);
            }}
            className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
          >
            Duplicate
          </button>
          <button
            type="button"
            onClick={() => {
              resetNodeLatencyDefaults(contextMenu.nodeId);
              setContextMenu(null);
            }}
            className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
          >
            Reset latency defaults
          </button>
          <button
            type="button"
            onClick={() => {
              onInspectNode?.(contextMenu.nodeId, 'why');
              setContextMenu(null);
            }}
            className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
          >
            Why?
          </button>
          <div className="my-1 h-px bg-[var(--border-hairline)]" />
          <button
            type="button"
            onClick={() => {
              deleteElements({ nodeIds: [contextMenu.nodeId] });
              setContextMenu(null);
            }}
            className="flex h-7 w-full items-center rounded-[5px] px-2 text-left text-[12px] text-[var(--status-overloaded)] hover:bg-[rgba(229,72,77,0.12)]"
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Interactive React Flow canvas wired to the Zustand design store. */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
