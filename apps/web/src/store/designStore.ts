import { create } from 'zustand';
import { current } from 'immer';
import { immer } from 'zustand/middleware/immer';
import type {
  CustomPreset,
  Design,
  DesignSettings,
  EdgeInstance,
  GroupInstance,
  NodeConfig,
  NodeInstance,
  Scenario,
} from '@infrasim/shared-types';
import { createEmptyDesign } from '@infrasim/shared-types';
import { getService } from '@infrasim/catalog';
import {
  DEFAULT_GROUP_SIZE,
  findDeepestContainingGroup,
  getGroupRect,
  inferEdgeDefaults,
  nextNodeLabel,
  resolveInheritedPlacement,
  snapPoint,
} from '../lib/canvasGeometry';
import { createInitialNodeConfig } from '../lib/nodeDefaults';

export const MAX_HISTORY_STEPS = 120;

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Builds a clean default Design containing one initial Scenario so simulations work out of the box. */
export function createStarterEmptyDesign(
  id = createId('design'),
  name = 'Untitled architecture',
): Design {
  const base = createEmptyDesign(id, name);
  base.scenarios = [
    {
      id: 'scenario-default',
      name: 'Baseline load',
      durationS: 60,
      entryNodeId: '',
      profile: { kind: 'constant', rps: 100 },
      flows: [
        {
          id: 'flow-default',
          name: 'Primary request',
          weight: 1,
          steps: [{ method: 'GET', path: '/' }],
        },
      ],
      chaos: [],
    },
  ];
  return base;
}

export interface DesignStoreState {
  design: Design;
  past: Design[];
  future: Design[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedGroupId: string | null;
  activeScenarioId: string;
  snapEnabled: boolean;
  reduceMotionOverride: boolean;
  presets: CustomPreset[];
  clipboard: { nodes: NodeInstance[]; edges: EdgeInstance[] } | null;

  // Actions
  loadDesign: (design: Design, resetHistory?: boolean) => void;
  applyPatchedDesign: (nextDesign: Design) => void;
  newDesign: (name?: string) => void;
  updateDesignMeta: (updates: {
    name?: string;
    description?: string;
    settings?: Partial<DesignSettings>;
  }) => void;
  addServiceNode: (
    serviceId: string,
    position: { x: number; y: number },
    explicitParentGroupId?: string,
  ) => string | null;
  addGroup: (
    kind: GroupInstance['kind'],
    position: { x: number; y: number },
    label?: string,
  ) => string;
  moveNodeWorldPosition: (nodeId: string, worldPos: { x: number; y: number }) => void;
  moveGroupWorldPosition: (groupId: string, worldPos: { x: number; y: number }) => void;
  resizeGroup: (
    groupId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void;
  updateNodeLabel: (nodeId: string, label: string) => void;
  updateNodePlacement: (nodeId: string, placement: { region?: string; az?: string }) => void;
  updateNodeConfig: (nodeId: string, updater: (config: NodeConfig) => void) => void;
  resetNodeLatencyDefaults: (nodeId: string) => void;
  resetNodeToDefaults: (nodeId: string) => void;
  applyPresetToNode: (nodeId: string, preset: CustomPreset) => void;
  updateGroup: (groupId: string, partial: Partial<Omit<GroupInstance, 'id'>>) => void;
  connectEdge: (from: string, to: string) => string | null;
  updateEdge: (edgeId: string, updater: (edge: EdgeInstance) => void) => void;
  deleteElements: (opts: { nodeIds?: string[]; edgeIds?: string[]; groupIds?: string[] }) => void;
  updateScenario: (scenarioId: string, updater: (scenario: Scenario) => void) => void;
  setActiveScenario: (scenarioId: string) => void;
  addPreset: (preset: CustomPreset) => void;
  setPresets: (presets: CustomPreset[]) => void;

  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  selectGroup: (groupId: string | null) => void;
  clearSelection: () => void;
  setSnapEnabled: (enabled: boolean) => void;
  setReduceMotionOverride: (enabled: boolean) => void;

  copySelection: () => void;
  pasteClipboard: () => void;
  duplicateSelection: () => void;
  undo: () => void;
  redo: () => void;
}

function pushSnapshot(past: Design[], snapshot: Design): Design[] {
  const next = [...past, snapshot];
  if (next.length > MAX_HISTORY_STEPS) {
    return next.slice(next.length - MAX_HISTORY_STEPS);
  }
  return next;
}

export const useDesignStore = create<DesignStoreState>()(
  immer((set, get) => {
    const commit = (recipe: (draft: Design) => void) => {
      const snapshot = structuredClone(get().design);
      set((state) => {
        state.past = pushSnapshot(state.past, snapshot);
        state.future = [];
        recipe(state.design);
      });
    };

    return {
      design: createStarterEmptyDesign('design-initial', 'Untitled architecture'),
      past: [],
      future: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      selectedGroupId: null,
      activeScenarioId: 'scenario-default',
      snapEnabled: true,
      reduceMotionOverride: false,
      presets: [],
      clipboard: null,

      loadDesign: (design, resetHistory = true) => {
        set((state) => {
          state.design = structuredClone(design);
          if (state.design.scenarios.length === 0) {
            state.design.scenarios = createStarterEmptyDesign().scenarios;
          }
          if (resetHistory) {
            state.past = [];
            state.future = [];
          }
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
          state.activeScenarioId = state.design.scenarios[0]?.id ?? 'scenario-default';
          if (design.presets) {
            state.presets = structuredClone(design.presets);
          }
        });
      },

      applyPatchedDesign: (nextDesign) => {
        const snapshot = structuredClone(get().design);
        set((state) => {
          state.past = pushSnapshot(state.past, snapshot);
          state.future = [];
          state.design = structuredClone(nextDesign);
          if (state.design.scenarios.length === 0) {
            state.design.scenarios = createStarterEmptyDesign().scenarios;
          }
        });
      },

      newDesign: (name) => {
        const fresh = createStarterEmptyDesign(createId('design'), name ?? 'Untitled architecture');
        const prevSnapshot = structuredClone(get().design);
        set((state) => {
          state.past = pushSnapshot(state.past, prevSnapshot);
          state.future = [];
          state.design = fresh;
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
          state.activeScenarioId = fresh.scenarios[0]!.id;
        });
      },

      updateDesignMeta: ({ name, description, settings }) => {
        commit((draft) => {
          if (name !== undefined) {
            draft.name = name;
          }
          if (description !== undefined) {
            draft.description = description;
          }
          if (settings) {
            draft.settings = { ...draft.settings, ...settings };
          }
        });
      },

      addServiceNode: (serviceId, rawPos, explicitParentGroupId) => {
        const customList = get().design.customServices ?? [];
        const service = getService(serviceId, customList);
        if (!service) {
          return null;
        }
        const snapped = get().snapEnabled ? snapPoint(rawPos) : rawPos;
        const nodeId = createId('node');

        commit((draft) => {
          const parentGroup = explicitParentGroupId
            ? draft.groups.find((g) => g.id === explicitParentGroupId)
            : findDeepestContainingGroup({ x: snapped.x + 88, y: snapped.y + 36 }, draft.groups);
          const groupsById = new Map(draft.groups.map((g) => [g.id, g]));
          const inherited = resolveInheritedPlacement(parentGroup?.id, groupsById);

          const node: NodeInstance = {
            id: nodeId,
            serviceId,
            label: nextNodeLabel(service.name, draft.nodes),
            position: snapped,
            ...(parentGroup ? { parentGroupId: parentGroup.id } : {}),
            ...(inherited.region ? { region: inherited.region } : {}),
            ...(inherited.az ? { az: inherited.az } : {}),
            config: createInitialNodeConfig(service),
          };

          draft.nodes.push(node);

          // Auto-wire scenario entryNodeId if this is the first Client/Users or first entry node
          const primaryScenario = draft.scenarios[0];
          if (primaryScenario && !primaryScenario.entryNodeId) {
            if (
              serviceId === 'generic.client' ||
              serviceId === 'generic.users' ||
              draft.nodes.length === 1
            ) {
              primaryScenario.entryNodeId = nodeId;
            }
          } else if (
            primaryScenario &&
            (serviceId === 'generic.client' || serviceId === 'generic.users')
          ) {
            const currentEntry = draft.nodes.find((n) => n.id === primaryScenario.entryNodeId);
            if (
              currentEntry &&
              currentEntry.serviceId !== 'generic.client' &&
              currentEntry.serviceId !== 'generic.users'
            ) {
              primaryScenario.entryNodeId = nodeId;
            }
          }
        });

        set((state) => {
          state.selectedNodeId = nodeId;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
        });

        return nodeId;
      },

      addGroup: (kind, rawPos, label) => {
        const snapped = get().snapEnabled ? snapPoint(rawPos) : rawPos;
        const size = DEFAULT_GROUP_SIZE[kind];
        const groupId = createId('group');
        const defaultLabel =
          label ??
          (kind === 'region'
            ? 'us-east-1'
            : kind === 'vpc'
              ? 'VPC 10.0.0.0/16'
              : kind === 'az'
                ? 'az-a'
                : kind === 'subnet'
                  ? 'Subnet 10.0.1.0/24'
                  : kind === 'compartment'
                    ? 'App Compartment'
                    : 'Cluster');

        commit((draft) => {
          const parentGroup = findDeepestContainingGroup(
            { x: snapped.x + size.width / 2, y: snapped.y + size.height / 2 },
            draft.groups,
          );
          const group: GroupInstance = {
            id: groupId,
            kind,
            label: defaultLabel,
            ...(parentGroup ? { parentGroupId: parentGroup.id } : {}),
            ...(kind === 'region' ? { region: defaultLabel } : {}),
            ...(kind === 'vpc' ? { cidr: '10.0.0.0/16' } : {}),
            ...(kind === 'subnet' ? { cidr: '10.0.1.0/24', public: true } : {}),
            position: snapped,
            size,
          };
          draft.groups.push(group);
        });

        set((state) => {
          state.selectedGroupId = groupId;
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
        });
        return groupId;
      },

      moveNodeWorldPosition: (nodeId, worldPos) => {
        const snapped = get().snapEnabled ? snapPoint(worldPos) : worldPos;
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (!node) {
            return;
          }
          node.position = snapped;
          const parent = findDeepestContainingGroup(
            { x: snapped.x + 88, y: snapped.y + 36 },
            draft.groups,
          );
          if (parent) {
            node.parentGroupId = parent.id;
            const groupsById = new Map(draft.groups.map((g) => [g.id, g]));
            const inherited = resolveInheritedPlacement(parent.id, groupsById);
            if (inherited.region) {
              node.region = inherited.region;
            }
            if (inherited.az) {
              node.az = inherited.az;
            }
          } else {
            delete node.parentGroupId;
          }
        });
      },

      moveGroupWorldPosition: (groupId, worldPos) => {
        const snapped = get().snapEnabled ? snapPoint(worldPos) : worldPos;
        commit((draft) => {
          const group = draft.groups.find((g) => g.id === groupId);
          if (!group) {
            return;
          }
          const oldRect = getGroupRect(group);
          const dx = snapped.x - oldRect.x;
          const dy = snapped.y - oldRect.y;
          group.position = snapped;

          // Move descendant groups and child nodes rigidly along with the group container
          const childGroupIds = new Set<string>([groupId]);
          let added = true;
          while (added) {
            added = false;
            for (const g of draft.groups) {
              if (
                g.parentGroupId &&
                childGroupIds.has(g.parentGroupId) &&
                !childGroupIds.has(g.id)
              ) {
                childGroupIds.add(g.id);
                added = true;
              }
            }
          }

          for (const g of draft.groups) {
            if (g.id !== groupId && childGroupIds.has(g.id)) {
              const r = getGroupRect(g);
              g.position = { x: r.x + dx, y: r.y + dy };
            }
          }
          for (const n of draft.nodes) {
            if (n.parentGroupId && childGroupIds.has(n.parentGroupId)) {
              n.position = { x: n.position.x + dx, y: n.position.y + dy };
            }
          }

          // Re-evaluate parent container for the moved top group
          const nextParent = findDeepestContainingGroup(
            { x: snapped.x + oldRect.width / 2, y: snapped.y + oldRect.height / 2 },
            draft.groups,
            childGroupIds,
          );
          if (nextParent) {
            group.parentGroupId = nextParent.id;
          } else {
            delete group.parentGroupId;
          }
        });
      },

      resizeGroup: (groupId, bounds) => {
        const snap = get().snapEnabled;
        commit((draft) => {
          const group = draft.groups.find((g) => g.id === groupId);
          if (!group) {
            return;
          }
          group.position = snap
            ? snapPoint({ x: bounds.x, y: bounds.y })
            : { x: bounds.x, y: bounds.y };
          group.size = {
            width: Math.max(192, snap ? Math.round(bounds.width / 16) * 16 : bounds.width),
            height: Math.max(128, snap ? Math.round(bounds.height / 16) * 16 : bounds.height),
          };
        });
      },

      updateNodeLabel: (nodeId, label) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.label = label;
          }
        });
      },

      updateNodePlacement: (nodeId, placement) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (!node) {
            return;
          }
          if (placement.region !== undefined) {
            if (placement.region === '') {
              delete node.region;
            } else {
              node.region = placement.region;
            }
          }
          if (placement.az !== undefined) {
            if (placement.az === '') {
              delete node.az;
            } else {
              node.az = placement.az;
            }
          }
        });
      },

      updateNodeConfig: (nodeId, updater) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (node) {
            updater(node.config);
          }
        });
      },

      resetNodeLatencyDefaults: (nodeId) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (!node) {
            return;
          }
          delete node.config.latency;
          delete node.config.errorRate;
          delete node.config.rateLimit;
          delete node.config.coldStart;
          delete node.config.timeoutMs;
          delete node.config.scenarioOverrides;
          node.config.operations = {};
        });
      },

      resetNodeToDefaults: (nodeId) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (!node) {
            return;
          }
          const service = getService(node.serviceId, draft.customServices ?? []);
          node.config = createInitialNodeConfig(service);
        });
      },

      applyPresetToNode: (nodeId, preset) => {
        commit((draft) => {
          const node = draft.nodes.find((n) => n.id === nodeId);
          if (!node) {
            return;
          }
          if (preset.latency) {
            node.config.latency = structuredClone(preset.latency);
          }
          if (preset.errorRate !== undefined) {
            node.config.errorRate = preset.errorRate;
          }
          if (preset.maxInFlightPerInstance !== undefined) {
            node.config.maxInFlightPerInstance = preset.maxInFlightPerInstance;
          }
          if (preset.rateLimit) {
            node.config.rateLimit = { ...(node.config.rateLimit ?? {}), ...preset.rateLimit };
          }
          if (preset.timeoutMs !== undefined) {
            node.config.timeoutMs = preset.timeoutMs;
          }
        });
      },

      updateGroup: (groupId, partial) => {
        commit((draft) => {
          const group = draft.groups.find((g) => g.id === groupId);
          if (!group) {
            return;
          }
          Object.assign(group, partial);
        });
      },

      connectEdge: (from, to) => {
        if (from === to) {
          return null;
        }
        const { design } = get();
        const duplicate = design.edges.some((e) => e.from === from && e.to === to);
        if (duplicate) {
          return null;
        }

        const customList = design.customServices ?? [];
        const sourceNode = design.nodes.find((n) => n.id === from);
        const targetNode = design.nodes.find((n) => n.id === to);
        if (!sourceNode || !targetNode) {
          return null;
        }

        const defaults = inferEdgeDefaults(
          getService(sourceNode.serviceId, customList),
          getService(targetNode.serviceId, customList),
        );
        const edgeId = createId('edge');

        commit((draft) => {
          draft.edges.push({
            id: edgeId,
            from,
            to,
            protocol: defaults.protocol,
            ...(defaults.port ? { port: defaults.port } : {}),
            callType: defaults.callType,
            weight: 1,
          });
        });

        set((state) => {
          state.selectedEdgeId = edgeId;
          state.selectedNodeId = null;
          state.selectedGroupId = null;
        });

        return edgeId;
      },

      updateEdge: (edgeId, updater) => {
        commit((draft) => {
          const edge = draft.edges.find((e) => e.id === edgeId);
          if (edge) {
            updater(edge);
          }
        });
      },

      deleteElements: ({ nodeIds = [], edgeIds = [], groupIds = [] }) => {
        if (nodeIds.length === 0 && edgeIds.length === 0 && groupIds.length === 0) {
          return;
        }
        const nodeSet = new Set(nodeIds);
        const edgeSet = new Set(edgeIds);
        const groupSet = new Set(groupIds);

        commit((draft) => {
          draft.nodes = draft.nodes.filter((n) => !nodeSet.has(n.id));
          draft.groups = draft.groups.filter((g) => !groupSet.has(g.id));
          for (const g of draft.groups) {
            if (g.parentGroupId && groupSet.has(g.parentGroupId)) {
              delete g.parentGroupId;
            }
          }
          for (const n of draft.nodes) {
            if (n.parentGroupId && groupSet.has(n.parentGroupId)) {
              delete n.parentGroupId;
            }
          }
          draft.edges = draft.edges.filter(
            (e) => !edgeSet.has(e.id) && !nodeSet.has(e.from) && !nodeSet.has(e.to),
          );
          for (const scenario of draft.scenarios) {
            if (nodeSet.has(scenario.entryNodeId)) {
              scenario.entryNodeId = draft.nodes[0]?.id ?? '';
            }
          }
        });

        set((state) => {
          if (state.selectedNodeId && nodeSet.has(state.selectedNodeId)) {
            state.selectedNodeId = null;
          }
          if (state.selectedEdgeId && edgeSet.has(state.selectedEdgeId)) {
            state.selectedEdgeId = null;
          }
          if (state.selectedGroupId && groupSet.has(state.selectedGroupId)) {
            state.selectedGroupId = null;
          }
        });
      },

      updateScenario: (scenarioId, updater) => {
        commit((draft) => {
          const target = draft.scenarios.find((s) => s.id === scenarioId);
          if (target) {
            updater(target);
          }
        });
      },

      setActiveScenario: (scenarioId) => {
        set((state) => {
          state.activeScenarioId = scenarioId;
        });
      },

      addPreset: (preset) => {
        set((state) => {
          state.presets = [preset, ...state.presets.filter((p) => p.id !== preset.id)];
          state.design.presets = structuredClone(current(state.presets));
        });
      },

      setPresets: (presets) => {
        set((state) => {
          state.presets = structuredClone(presets);
        });
      },

      selectNode: (nodeId) =>
        set((state) => {
          state.selectedNodeId = nodeId;
          if (nodeId) {
            state.selectedEdgeId = null;
            state.selectedGroupId = null;
          }
        }),

      selectEdge: (edgeId) =>
        set((state) => {
          state.selectedEdgeId = edgeId;
          if (edgeId) {
            state.selectedNodeId = null;
            state.selectedGroupId = null;
          }
        }),

      selectGroup: (groupId) =>
        set((state) => {
          state.selectedGroupId = groupId;
          if (groupId) {
            state.selectedNodeId = null;
            state.selectedEdgeId = null;
          }
        }),

      clearSelection: () =>
        set((state) => {
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
        }),

      setSnapEnabled: (enabled) =>
        set((state) => {
          state.snapEnabled = enabled;
        }),

      setReduceMotionOverride: (enabled) =>
        set((state) => {
          state.reduceMotionOverride = enabled;
        }),

      copySelection: () => {
        const { selectedNodeId, design } = get();
        if (!selectedNodeId) {
          return;
        }
        const node = design.nodes.find((n) => n.id === selectedNodeId);
        if (!node) {
          return;
        }
        set((state) => {
          state.clipboard = {
            nodes: [structuredClone(node)],
            edges: [],
          };
        });
      },

      pasteClipboard: () => {
        const { clipboard } = get();
        if (!clipboard || clipboard.nodes.length === 0) {
          return;
        }
        let newSelectedId: string | null = null;
        commit((draft) => {
          for (const sourceNode of clipboard.nodes) {
            const clone = structuredClone(sourceNode);
            clone.id = createId('node');
            clone.position = snapPoint({
              x: sourceNode.position.x + 32,
              y: sourceNode.position.y + 32,
            });
            clone.label = nextNodeLabel(sourceNode.label, draft.nodes);
            draft.nodes.push(clone);
            newSelectedId = clone.id;
          }
        });
        if (newSelectedId) {
          set((state) => {
            state.selectedNodeId = newSelectedId;
            state.selectedEdgeId = null;
            state.selectedGroupId = null;
          });
        }
      },

      duplicateSelection: () => {
        const { selectedNodeId, design } = get();
        if (!selectedNodeId) {
          return;
        }
        const source = design.nodes.find((n) => n.id === selectedNodeId);
        if (!source) {
          return;
        }
        let clonedId: string | null = null;
        commit((draft) => {
          const clone = structuredClone(source);
          clone.id = createId('node');
          clone.position = snapPoint({ x: source.position.x + 32, y: source.position.y + 32 });
          clone.label = nextNodeLabel(source.label, draft.nodes);
          draft.nodes.push(clone);
          clonedId = clone.id;
        });
        if (clonedId) {
          set((state) => {
            state.selectedNodeId = clonedId;
            state.selectedEdgeId = null;
            state.selectedGroupId = null;
          });
        }
      },

      undo: () => {
        set((state) => {
          const previous = state.past.pop();
          if (!previous) {
            return;
          }
          state.future = [structuredClone(current(state.design)), ...state.future].slice(
            0,
            MAX_HISTORY_STEPS,
          );
          state.design = previous;
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
        });
      },

      redo: () => {
        set((state) => {
          const next = state.future.shift();
          if (!next) {
            return;
          }
          state.past = pushSnapshot(state.past, structuredClone(current(state.design)));
          state.design = next;
          state.selectedNodeId = null;
          state.selectedEdgeId = null;
          state.selectedGroupId = null;
        });
      },
    };
  }),
);
