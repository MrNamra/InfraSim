'use client';

import dynamic from 'next/dynamic';
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accessibility,
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Command,
  Copy,
  DollarSign,
  FileCode2,
  FolderOpen,
  HelpCircle,
  Layers,
  LayoutTemplate,
  Moon,
  Network,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  RotateCcw,
  Share2,
  Sliders,
  Square,
  Sun,
  Terminal,
  Undo2,
  User,
} from 'lucide-react';
import type {
  CostAssumptions,
  CostReport,
  CustomServiceDefinition,
  Design,
  GroupInstance,
  PayloadFixture,
  Provider,
  ServiceDefinition,
} from '@infrasim/shared-types';
import type { AutoFillPatchPreview, ExtractedScenarioResult } from '@infrasim/sandbox';
import { getService, type CloudTargetProvider } from '@infrasim/catalog';
import type * as CostEngineMod from '@infrasim/cost-engine';
import type { CostBreakdownMeta } from '@infrasim/cost-engine';
import { Button, Keycap, LogoMark } from '@infrasim/ui-kit';
import {
  createCustomServiceApi,
  deleteCustomServiceApi,
  fetchCurrentUser,
  fetchCustomServicesApi,
  fetchFixturesApi,
  getStoredToken,
  setStoredToken,
  updateCustomServiceApi,
  type AuthUser,
} from '../lib/api';
import {
  deleteCustomServiceFromIndexedDb,
  loadActiveDesignFromIndexedDb,
  loadCustomServicesFromIndexedDb,
  loadFixturesFromIndexedDb,
  loadPresetsFromIndexedDb,
  saveCustomServiceToIndexedDb,
  saveDesignToIndexedDb,
  saveFixtureToIndexedDb,
} from '../lib/autosave';
import { formatCompactMonthlyCost, formatMoney, formatSnapshotAge } from '../lib/costFormat';
import { mergeCustomServices } from '../lib/customServices';
import { formatVirtualTime } from '../lib/timeFormat';
import type { StarterTemplate } from '../lib/templates';
import { useCostStore } from '../store/costStore';
import { useDesignStore } from '../store/designStore';
import { type SimSpeed, useSimulationStore } from '../store/simulationStore';
import { Canvas } from './canvas/Canvas';
import type { NodeCostChipInfo } from './canvas/CanvasSimContext';
import type { CommandItem } from './CommandPalette';
import { Palette } from './Palette';
import { ServiceIcon } from './ServiceIcon';
import type { WhyTabProps } from './inspector/WhyTab';

const MetricsDockTab = dynamic(
  () => import('./dock/MetricsDockTab').then((m) => m.MetricsDockTab),
  { ssr: false },
);

const ConfigTab = dynamic(() => import('./inspector/ConfigTab').then((m) => m.ConfigTab), {
  ssr: false,
});
const TrafficProfileEditor = dynamic(
  () => import('./TrafficProfileEditor').then((m) => m.TrafficProfileEditor),
  { ssr: false },
);

const AccountModal = dynamic(() => import('./AccountModal').then((m) => m.AccountModal), {
  ssr: false,
});
const CommandPalette = dynamic(() => import('./CommandPalette').then((m) => m.CommandPalette), {
  ssr: false,
});
const TemplateModal = dynamic(() => import('./TemplateModal').then((m) => m.TemplateModal), {
  ssr: false,
});
const CustomServiceModal = dynamic(
  () => import('./CustomServiceModal').then((m) => m.CustomServiceModal),
  { ssr: false },
);
const LatencyMockTab = dynamic(
  () => import('./inspector/LatencyMockTab').then((m) => m.LatencyMockTab),
  { ssr: false },
);
const CodeTab = dynamic(() => import('./inspector/CodeTab').then((m) => m.CodeTab), {
  ssr: false,
});
const CostTab = dynamic(() => import('./inspector/CostTab').then((m) => m.CostTab), {
  ssr: false,
});

type WhyTabComponent = ComponentType<WhyTabProps>;
let cachedWhyTab: WhyTabComponent | null = null;
let whyTabPromise: Promise<WhyTabComponent> | null = null;

function preloadWhyTab(): Promise<WhyTabComponent> {
  if (cachedWhyTab) {
    return Promise.resolve(cachedWhyTab);
  }
  if (!whyTabPromise) {
    whyTabPromise = import('./inspector/WhyTab').then((m) => {
      cachedWhyTab = m.WhyTab;
      return m.WhyTab;
    });
  }
  return whyTabPromise;
}

/** Preloaded lazy wrapper so Why? renders synchronously on first overloaded node click. */
function WhyTabSlot(props: WhyTabProps) {
  const [LoadedWhyTab, setLoadedWhyTab] = useState<WhyTabComponent | null>(() => cachedWhyTab);

  useEffect(() => {
    if (LoadedWhyTab) return;
    let active = true;
    void preloadWhyTab().then((Comp) => {
      if (active) {
        setLoadedWhyTab(() => Comp);
      }
    });
    return () => {
      active = false;
    };
  }, [LoadedWhyTab]);

  if (!LoadedWhyTab) {
    return null;
  }
  return <LoadedWhyTab {...props} />;
}
const InsightsDockTab = dynamic(
  () => import('./dock/InsightsDockTab').then((m) => m.InsightsDockTab),
  { ssr: false },
);
const CostDockTab = dynamic(() => import('./dock/CostDockTab').then((m) => m.CostDockTab), {
  ssr: false,
});
const ProviderSwitchModal = dynamic(
  () => import('./ProviderSwitchModal').then((m) => m.ProviderSwitchModal),
  { ssr: false },
);
const ChaosTimelineEditor = dynamic(
  () => import('./ChaosTimelineEditor').then((m) => m.ChaosTimelineEditor),
  { ssr: false },
);
const TracesDockTab = dynamic(() => import('./dock/TracesDockTab').then((m) => m.TracesDockTab), {
  ssr: false,
});
const LogsDockTab = dynamic(() => import('./dock/LogsDockTab').then((m) => m.LogsDockTab), {
  ssr: false,
});

type Theme = 'dark' | 'light';
type InspectorTab = 'config' | 'latency' | 'code' | 'network' | 'cost' | 'why';
type DockTab = 'metrics' | 'logs' | 'traces' | 'reachability' | 'terraform' | 'cost' | 'insights';

const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: 'config', label: 'Config' },
  { id: 'latency', label: 'Latency & Mock' },
  { id: 'code', label: 'Code' },
  { id: 'network', label: 'Network' },
  { id: 'cost', label: 'Cost' },
  { id: 'why', label: 'Why?' },
];

const DOCK_TABS: { id: DockTab; label: string; icon: typeof Activity }[] = [
  { id: 'metrics', label: 'Metrics', icon: Activity },
  { id: 'logs', label: 'Logs', icon: Terminal },
  { id: 'traces', label: 'Traces', icon: Layers },
  { id: 'reachability', label: 'Reachability', icon: Network },
  { id: 'terraform', label: 'Terraform', icon: FileCode2 },
  { id: 'cost', label: 'Cost', icon: DollarSign },
  { id: 'insights', label: 'Insights', icon: HelpCircle },
];

function mergePayloadFixtures(
  primary: PayloadFixture[],
  secondary: PayloadFixture[],
): PayloadFixture[] {
  const seen = new Set<string>();
  const out: PayloadFixture[] = [];
  for (const item of [...primary, ...secondary]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** Top-level InfraSim workbench shell wired to catalog palette, React Flow canvas, and IndexedDB autosave. */
export function EditorShell() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('config');
  const [dockTab, setDockTab] = useState<DockTab>('metrics');
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [primaryRegion, setPrimaryRegion] = useState('us-east-1');
  const [editingTitle, setEditingTitle] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [costEngineMod, setCostEngineMod] = useState<typeof CostEngineMod | null>(null);
  const [scenarioPopoverTab, setScenarioPopoverTab] = useState<'traffic' | 'chaos'>('traffic');

  useEffect(() => {
    let active = true;
    void import('@infrasim/cost-engine').then((mod) => {
      if (active) setCostEngineMod(mod);
    });
    return () => {
      active = false;
    };
  }, []);
  const [chaosTargetNode, setChaosTargetNode] = useState<{
    nodeId: string;
    az?: string;
  } | null>(null);
  const [costPopoverOpen, setCostPopoverOpen] = useState(false);
  const [providerSwitchModal, setProviderSwitchModal] = useState<{
    open: boolean;
    targetProvider?: CloudTargetProvider;
  }>({ open: false });
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [appliedFixLabel, setAppliedFixLabel] = useState<string | null>(null);
  const [focusedOpState, setFocusedOpState] = useState<{
    nodeId: string;
    opName: string;
  } | null>(null);
  const [codeFocusLocation, setCodeFocusLocation] = useState<{
    nodeId: string;
    line: number;
    column: number;
    nonce: number;
  } | null>(null);
  const [requestedTraceId, setRequestedTraceId] = useState<{
    traceId: string;
    nonce: number;
  } | null>(null);
  const [customModal, setCustomModal] = useState<{
    open: boolean;
    mode: 'create' | 'edit' | 'duplicate';
    source: ServiceDefinition | CustomServiceDefinition | null;
    targetNodeId: string | null;
    targetNodeLabel: string | null;
  }>({
    open: false,
    mode: 'create',
    source: null,
    targetNodeId: null,
    targetNodeLabel: null,
  });

  const viewportCenterGetterRef = useRef<() => { x: number; y: number }>(() => ({
    x: 240,
    y: 180,
  }));
  const autosaveHydratedRef = useRef(false);

  const design = useDesignStore((s) => s.design);
  const presets = useDesignStore((s) => s.presets);
  const userCustomServices = useDesignStore((s) => s.userCustomServices);
  const libraryFixtures = useDesignStore((s) => s.libraryFixtures);
  const activeScenarioId = useDesignStore((s) => s.activeScenarioId);
  const canUndo = useDesignStore((s) => s.past.length > 0);
  const canRedo = useDesignStore((s) => s.future.length > 0);
  const selectedNodeId = useDesignStore((s) => s.selectedNodeId);
  const selectedGroupId = useDesignStore((s) => s.selectedGroupId);
  const reduceMotionOverride = useDesignStore((s) => s.reduceMotionOverride);

  const loadDesign = useDesignStore((s) => s.loadDesign);
  const applyPatchedDesign = useDesignStore((s) => s.applyPatchedDesign);
  const setPresets = useDesignStore((s) => s.setPresets);
  const addPreset = useDesignStore((s) => s.addPreset);
  const setUserCustomServices = useDesignStore((s) => s.setUserCustomServices);
  const upsertCustomService = useDesignStore((s) => s.upsertCustomService);
  const deleteCustomService = useDesignStore((s) => s.deleteCustomService);
  const replaceNodeServiceId = useDesignStore((s) => s.replaceNodeServiceId);
  const setLibraryFixtures = useDesignStore((s) => s.setLibraryFixtures);
  const upsertDesignFixture = useDesignStore((s) => s.upsertDesignFixture);
  const upsertLibraryFixture = useDesignStore((s) => s.upsertLibraryFixture);
  const upsertDesignScript = useDesignStore((s) => s.upsertDesignScript);
  const deleteDesignScript = useDesignStore((s) => s.deleteDesignScript);
  const applyPresetToNode = useDesignStore((s) => s.applyPresetToNode);
  const updateDesignMeta = useDesignStore((s) => s.updateDesignMeta);
  const updateScenario = useDesignStore((s) => s.updateScenario);
  const setActiveScenario = useDesignStore((s) => s.setActiveScenario);
  const addServiceNode = useDesignStore((s) => s.addServiceNode);
  const addGroup = useDesignStore((s) => s.addGroup);
  const connectEdge = useDesignStore((s) => s.connectEdge);
  const selectNode = useDesignStore((s) => s.selectNode);
  const updateGroup = useDesignStore((s) => s.updateGroup);
  const updateNodeLabel = useDesignStore((s) => s.updateNodeLabel);
  const updateNodePlacement = useDesignStore((s) => s.updateNodePlacement);
  const updateNodeConfig = useDesignStore((s) => s.updateNodeConfig);
  const resetNodeToDefaults = useDesignStore((s) => s.resetNodeToDefaults);
  const setReduceMotionOverride = useDesignStore((s) => s.setReduceMotionOverride);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);

  const simStatus = useSimulationStore((s) => s.status);
  const simFrames = useSimulationStore((s) => s.frames);
  const playbackIdx = useSimulationStore((s) => s.playbackIdx);
  const simPlaying = useSimulationStore((s) => s.playing);
  const speed = useSimulationStore((s) => s.speed);
  const simDurationS = useSimulationStore((s) => s.durationS);
  const simElapsedWallMs = useSimulationStore((s) => s.elapsedWallMs);
  const simResult = useSimulationStore((s) => s.result);
  const simPreviousResult = useSimulationStore((s) => s.previousResult);
  const simLogs = useSimulationStore((s) => s.logs);
  const simError = useSimulationStore((s) => s.errorMessage);
  const missingClientPromptOpen = useSimulationStore((s) => s.missingClientPromptOpen);
  const liveCodeMode = useSimulationStore((s) => s.liveCodeMode);
  const verboseLogs = useSimulationStore((s) => s.verboseLogs);
  const profileIterations = useSimulationStore((s) => s.profileIterations);
  const profileSummaries = useSimulationStore((s) => s.profileSummaries);

  const startSimulation = useSimulationStore((s) => s.runSimulation);
  const setLiveCodeMode = useSimulationStore((s) => s.setLiveCodeMode);
  const setVerboseLogs = useSimulationStore((s) => s.setVerboseLogs);
  const setProfileIterations = useSimulationStore((s) => s.setProfileIterations);
  const setProfileSummary = useSimulationStore((s) => s.setProfileSummary);
  const appendSimLogs = useSimulationStore((s) => s.appendLogs);
  const clearSimLogs = useSimulationStore((s) => s.clearLogs);
  const stopPlayback = useSimulationStore((s) => s.stopPlayback);
  const togglePausePlayback = useSimulationStore((s) => s.togglePausePlayback);
  const scrubTo = useSimulationStore((s) => s.scrubTo);
  const seekToTimeS = useSimulationStore((s) => s.seekToTimeS);
  const advancePlayback = useSimulationStore((s) => s.advancePlayback);
  const setSpeed = useSimulationStore((s) => s.setSpeed);
  const dismissMissingClientPrompt = useSimulationStore((s) => s.dismissMissingClientPrompt);
  const resetSimulation = useSimulationStore((s) => s.resetSimulation);

  const costSnapshot = useCostStore((s) => s.snapshot);
  const costLoading = useCostStore((s) => s.loading);
  const costError = useCostStore((s) => s.error);
  const costLastFetchedAt = useCostStore((s) => s.lastFetchedAt);
  const costIsOfflineFallback = useCostStore((s) => s.isOfflineFallback);
  const hoursPerMonth = useCostStore((s) => s.hoursPerMonth);
  const costTrafficAssumption = useCostStore((s) => s.traffic);
  const instanceCountMode = useCostStore((s) => s.instanceCountMode);
  const hydrateCostStorage = useCostStore((s) => s.hydrateFromStorage);
  const syncPriceSnapshot = useCostStore((s) => s.syncSnapshot);
  const setHoursPerMonth = useCostStore((s) => s.setHoursPerMonth);
  const setTrafficAssumption = useCostStore((s) => s.setTrafficAssumption);
  const setInstanceCountMode = useCostStore((s) => s.setInstanceCountMode);

  const reducedMotion = systemReducedMotion || reduceMotionOverride;
  const isSimActive = simStatus === 'running' || simPlaying;

  const currentFrame = useMemo(
    () =>
      playbackIdx >= 0 && playbackIdx < simFrames.length ? (simFrames[playbackIdx] ?? null) : null,
    [simFrames, playbackIdx],
  );

  // Sync OS prefers-reduced-motion media query
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setSystemReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Animate buffered frames smoothly at 1x / 5x / 20x playback speeds
  useEffect(() => {
    if (!simPlaying) {
      return;
    }
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (nowTs: number) => {
      const dt = Math.min(100, nowTs - lastTs);
      lastTs = nowTs;
      advancePlayback(dt);
      if (useSimulationStore.getState().playing) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [simPlaying, advancePlayback]);

  // Hydrate theme, auth session, and autosaved design + custom presets on boot
  useEffect(() => {
    hydrateCostStorage();
    const saved = window.localStorage.getItem('infrasim.theme');
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
      document.documentElement.dataset.theme = saved;
    } else {
      document.documentElement.dataset.theme = 'dark';
    }

    const storedToken = getStoredToken();
    if (storedToken) {
      setToken(storedToken);
      Promise.all([
        fetchCurrentUser(storedToken),
        fetchCustomServicesApi(storedToken),
        fetchFixturesApi(storedToken).catch(() => []),
      ])
        .then(([u, remoteCustom, remoteFixtures]) => {
          setUser(u);
          if (remoteCustom.length > 0) {
            const localNow = useDesignStore.getState().userCustomServices;
            const merged = mergeCustomServices(
              remoteCustom.map((r) => r.definition),
              localNow,
            );
            setUserCustomServices(merged);
            for (const item of merged) {
              void saveCustomServiceToIndexedDb(item);
            }
          }
          if (remoteFixtures.length > 0) {
            const mappedRemote: PayloadFixture[] = remoteFixtures.map((r) => ({
              id: r.id,
              name: r.name,
              ...(r.template ? { template: r.template } : {}),
              event: r.event,
              ...(r.schema ? { schema: r.schema } : {}),
            }));
            const mergedFixtures = mergePayloadFixtures(
              mappedRemote,
              useDesignStore.getState().libraryFixtures,
            );
            setLibraryFixtures(mergedFixtures);
            for (const f of mergedFixtures) {
              void saveFixtureToIndexedDb(f);
            }
          }
        })
        .catch(() => {
          setStoredToken(null);
          setToken(null);
        });
    }

    Promise.all([
      loadActiveDesignFromIndexedDb(),
      loadPresetsFromIndexedDb(),
      loadCustomServicesFromIndexedDb(),
      loadFixturesFromIndexedDb(),
    ])
      .then(([savedDesign, savedPresets, savedCustom, savedFixtures]) => {
        if (savedDesign && savedDesign.nodes.length + savedDesign.groups.length > 0) {
          loadDesign(savedDesign, true);
        }
        if (savedPresets.length > 0) {
          setPresets(savedPresets);
        }
        if (savedCustom.length > 0) {
          const existing = useDesignStore.getState().userCustomServices;
          setUserCustomServices(mergeCustomServices(existing, savedCustom));
        }
        if (savedFixtures.length > 0) {
          const existingFix = useDesignStore.getState().libraryFixtures;
          setLibraryFixtures(mergePayloadFixtures(existingFix, savedFixtures));
        }
      })
      .catch(() => {
        // Ignore IndexedDB unavailability in restricted contexts
      })
      .finally(() => {
        autosaveHydratedRef.current = true;
      });
  }, [loadDesign, setPresets, setUserCustomServices, setLibraryFixtures, hydrateCostStorage]);

  // Debounced autosave to IndexedDB whenever Design changes
  useEffect(() => {
    if (!autosaveHydratedRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveDesignToIndexedDb(design);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [design]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('infrasim.theme', theme);
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  const handleAddServiceAtCenter = useCallback(
    (serviceId: string) => {
      const center = viewportCenterGetterRef.current();
      const offset = (design.nodes.length % 5) * 24;
      addServiceNode(serviceId, { x: center.x + offset, y: center.y + offset });
    },
    [addServiceNode, design.nodes.length],
  );

  const handleAddGroupAtCenter = useCallback(
    (kind: GroupInstance['kind']) => {
      const center = viewportCenterGetterRef.current();
      addGroup(kind, { x: center.x - 160, y: center.y - 120 });
    },
    [addGroup],
  );

  const handleInspectNode = useCallback(
    (nodeId: string, tab: 'config' | 'latency' | 'code' | 'cost' | 'why') => {
      selectNode(nodeId);
      setInspectorTab(tab);
    },
    [selectNode],
  );

  const handleEditCallMock = useCallback(
    (targetNodeId: string | undefined, serviceId: string, opName: string) => {
      const target =
        (targetNodeId ? design.nodes.find((n) => n.id === targetNodeId) : undefined) ??
        design.nodes.find((n) => n.serviceId === serviceId);
      if (target) {
        selectNode(target.id);
        setFocusedOpState({ nodeId: target.id, opName });
        setInspectorTab('latency');
        return;
      }
      setStatusNotice(
        `Add a ${serviceId} service and connect an edge from this node to customize ${opName} mock responses.`,
      );
    },
    [design.nodes, selectNode],
  );

  const handleApplyMockPatches = useCallback(
    (patches: readonly AutoFillPatchPreview[]): Design => {
      const currentDesign = useDesignStore.getState().design;
      const nextDesign = structuredClone(currentDesign);
      for (const patch of patches) {
        const targetNode =
          (patch.targetNodeId
            ? nextDesign.nodes.find((n) => n.id === patch.targetNodeId)
            : undefined) ?? nextDesign.nodes.find((n) => n.serviceId === patch.serviceId);
        if (!targetNode) continue;
        if (!targetNode.config.operations) {
          targetNode.config.operations = {};
        }
        const existingOp = targetNode.config.operations[patch.op];
        targetNode.config.operations[patch.op] = {
          ...(existingOp ?? {}),
          responseTemplate: patch.afterTemplate,
        };
      }
      applyPatchedDesign(nextDesign);
      setStatusNotice(
        `Applied mock schema updates for ${patches.map((p) => `${p.serviceId}.${p.op}`).join(', ')}.`,
      );
      return nextDesign;
    },
    [applyPatchedDesign],
  );

  // Map top diagnostic short reason onto each node card / tooltip
  const nodeReasons = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (!simResult) {
      return map;
    }
    for (const insight of simResult.insights) {
      for (const nid of insight.nodeIds) {
        if (!map[nid]) {
          map[nid] = insight.title;
        }
      }
    }
    return map;
  }, [simResult]);

  // Preload Why? tab chunk once simulation runs so clicking an overloaded node opens instantaneously
  useEffect(() => {
    if (simStatus === 'running' || simStatus === 'completed') {
      void preloadWhyTab();
    }
  }, [simStatus]);

  // Auto-open Why? tab when clicking an overloaded or down node after a run
  const prevSelectedNodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== prevSelectedNodeRef.current) {
      const h = currentFrame?.nodes[selectedNodeId]?.health;
      if (h === 'overloaded' || h === 'down') {
        setInspectorTab('why');
      }
    }
    prevSelectedNodeRef.current = selectedNodeId;
  }, [selectedNodeId, currentFrame]);

  const ensureHandlerProfiles = useCallback(
    async (curDesign: Design) => {
      const state = useSimulationStore.getState();
      const scenario =
        curDesign.scenarios.find((s) => s.id === activeScenarioId) ?? curDesign.scenarios[0];
      if (state.liveCodeMode && scenario) {
        const { estimateProfilePeakRps } = await import('@infrasim/sim-engine');
        if (estimateProfilePeakRps(scenario.profile, Math.max(1, scenario.durationS)) <= 50) {
          return;
        }
      }

      const pendingNodes = curDesign.nodes.filter((n) => {
        if (
          !n.config.scriptId ||
          n.serviceId === 'generic.client' ||
          n.serviceId === 'generic.users'
        ) {
          return false;
        }
        const script = curDesign.scripts.find((s) => s.id === n.config.scriptId);
        return script?.kind === 'handler';
      });
      if (pendingNodes.length === 0) {
        return;
      }

      const mergedCustom = mergeCustomServices(
        useDesignStore.getState().userCustomServices,
        curDesign.customServices,
      );
      const [{ getSharedSandboxClient }, { computeProfileCacheKey }] = await Promise.all([
        import('../lib/sandboxClient'),
        import('@infrasim/sandbox/profile-key'),
      ]);
      const client = getSharedSandboxClient();

      const seenScripts = new Set<string>();
      for (const node of pendingNodes) {
        const script = curDesign.scripts.find((s) => s.id === node.config.scriptId);
        if (!script || seenScripts.has(script.id)) continue;
        seenScripts.add(script.id);

        const expectedKey = computeProfileCacheKey({
          script,
          designScripts: curDesign.scripts,
          design: curDesign,
          node,
          customServices: mergedCustom,
          fixtures: curDesign.fixtures,
          seed: curDesign.settings.seed,
          iterations: state.profileIterations,
        });
        const cached = useSimulationStore.getState().profileSummaries[script.id];
        if (cached && cached.cacheKey === expectedKey) {
          continue;
        }
        const summary = await client.profile({
          script,
          designScripts: curDesign.scripts,
          design: curDesign,
          node,
          customServices: mergedCustom,
          fixtures: curDesign.fixtures,
          seed: curDesign.settings.seed,
          iterations: state.profileIterations,
        });
        setProfileSummary(script.id, summary);
      }
    },
    [activeScenarioId, setProfileSummary],
  );

  const handleRunSimulation = useCallback(async () => {
    setScenarioOpen(false);
    setAppliedFixLabel(null);
    const curDesign = useDesignStore.getState().design;
    await ensureHandlerProfiles(curDesign);
    await startSimulation(curDesign, activeScenarioId);
  }, [activeScenarioId, ensureHandlerProfiles, startSimulation]);

  const handleApplyPatchedDesign = useCallback(
    (nextDesign: typeof design, fixLabel: string) => {
      applyPatchedDesign(nextDesign);
      setAppliedFixLabel(fixLabel);
    },
    [applyPatchedDesign],
  );

  const handleRerunVerify = useCallback(() => {
    setAppliedFixLabel(null);
    const curDesign = useDesignStore.getState().design;
    void ensureHandlerProfiles(curDesign).then(() => startSimulation(curDesign, activeScenarioId));
  }, [activeScenarioId, ensureHandlerProfiles, startSimulation]);

  const handleSaveCustomService = useCallback(
    async (
      service: CustomServiceDefinition,
      options: { previousId?: string; switchTargetNode: boolean },
    ): Promise<{ error?: string }> => {
      if (token) {
        try {
          if (options.previousId) {
            await updateCustomServiceApi(token, options.previousId, service);
          } else {
            await createCustomServiceApi(token, service);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unable to sync custom service';
          // Distinguish network outage (offline mode continues locally) vs HTTP validation errors
          if (!(err instanceof TypeError)) {
            return { error: message };
          }
          setStatusNotice('Saved locally — backend unreachable for sync');
        }
      }

      upsertCustomService(service, { previousId: options.previousId });
      if (options.previousId && options.previousId !== service.id) {
        void deleteCustomServiceFromIndexedDb(options.previousId);
      }
      void saveCustomServiceToIndexedDb(service);

      if (options.switchTargetNode && customModal.targetNodeId) {
        replaceNodeServiceId(customModal.targetNodeId, service);
      }

      return {};
    },
    [token, upsertCustomService, replaceNodeServiceId, customModal.targetNodeId],
  );

  const handleDeleteCustomService = useCallback(
    (serviceId: string) => {
      deleteCustomService(serviceId);
      void deleteCustomServiceFromIndexedDb(serviceId);
      if (token) {
        void deleteCustomServiceApi(token, serviceId).catch(() => {
          // Ignore 404 or network issues when cleaning up local library items
        });
      }
    },
    [deleteCustomService, token],
  );

  const handleLoadTemplate = useCallback(
    (template: StarterTemplate) => {
      loadDesign(structuredClone(template.design), true);
      resetSimulation(true);
      setAppliedFixLabel(null);
      setStatusNotice(null);
      setScenarioOpen(false);
    },
    [loadDesign, resetSimulation],
  );

  const handleSelectComparisonRegion = useCallback(
    (regionCode: string) => {
      const nextDesign = structuredClone(design);
      for (const g of nextDesign.groups) {
        if (g.kind === 'region' || g.region) {
          g.region = regionCode;
          if (g.kind === 'region') {
            g.label = regionCode;
          }
        }
      }
      for (const n of nextDesign.nodes) {
        n.region = regionCode;
      }
      setPrimaryRegion(regionCode);
      applyPatchedDesign(nextDesign);
      setStatusNotice(`Switched region to ${regionCode} — undo with Ctrl+Z`);
    },
    [applyPatchedDesign, design],
  );

  const handleSyncAllComparisonPrices = useCallback(() => {
    if (costEngineMod) {
      const allRegions = Array.from(
        new Set([
          ...costEngineMod.CURATED_REGION_MAP.flatMap((r) => [r.aws, r.gcp, r.azure, r.oci]),
          'global',
        ]),
      );
      void syncPriceSnapshot(['aws', 'gcp', 'azure', 'oci'], allRegions, { force: true });
      return;
    }
    void import('@infrasim/cost-engine').then((mod) => {
      setCostEngineMod(mod);
      const allRegions = Array.from(
        new Set([
          ...mod.CURATED_REGION_MAP.flatMap((r) => [r.aws, r.gcp, r.azure, r.oci]),
          'global',
        ]),
      );
      void syncPriceSnapshot(['aws', 'gcp', 'azure', 'oci'], allRegions, { force: true });
    });
  }, [costEngineMod, syncPriceSnapshot]);

  const selectedNodeInsightCount = useMemo(() => {
    if (!simResult || !selectedNodeId) return 0;
    return simResult.insights.filter((ins) => ins.nodeIds.includes(selectedNodeId)).length;
  }, [simResult, selectedNodeId]);

  const handleAddLoadGeneratorAndRun = useCallback(() => {
    const state = useDesignStore.getState();
    const curDesign = state.design;
    const incomingSet = new Set(curDesign.edges.map((e) => e.to));
    const targetNode =
      curDesign.nodes.find((n) => !incomingSet.has(n.id)) ?? curDesign.nodes[0] ?? null;

    const clientPos = targetNode
      ? { x: Math.max(40, targetNode.position.x - 280), y: targetNode.position.y }
      : viewportCenterGetterRef.current();

    const clientId = addServiceNode('generic.client', clientPos);
    if (!clientId) {
      return;
    }
    if (targetNode) {
      connectEdge(clientId, targetNode.id);
    }
    selectNode(clientId);
    const targetScenarioId = state.activeScenarioId;
    updateScenario(targetScenarioId, (s) => {
      s.entryNodeId = clientId;
    });
    dismissMissingClientPrompt();
    const updatedDesign = useDesignStore.getState().design;
    void startSimulation(updatedDesign, targetScenarioId);
  }, [
    addServiceNode,
    connectEdge,
    dismissMissingClientPrompt,
    selectNode,
    startSimulation,
    updateScenario,
  ]);

  const availableCustomServices = useMemo(
    () => mergeCustomServices(userCustomServices, design.customServices),
    [userCustomServices, design.customServices],
  );

  const selectedNode = useMemo(
    () => (selectedNodeId ? (design.nodes.find((n) => n.id === selectedNodeId) ?? null) : null),
    [design.nodes, selectedNodeId],
  );
  const selectedNodeService = useMemo(
    () => (selectedNode ? getService(selectedNode.serviceId, availableCustomServices) : undefined),
    [selectedNode, availableCustomServices],
  );
  const selectedGroup = useMemo(
    () => (selectedGroupId ? (design.groups.find((g) => g.id === selectedGroupId) ?? null) : null),
    [design.groups, selectedGroupId],
  );
  const activeScenario = useMemo(
    () => design.scenarios.find((s) => s.id === activeScenarioId) ?? design.scenarios[0] ?? null,
    [design.scenarios, activeScenarioId],
  );

  const primaryProviderRegions = useMemo(
    () =>
      costEngineMod
        ? costEngineMod.listRegionsForProvider(design.settings.primaryProvider ?? 'aws')
        : [{ key: primaryRegion, code: primaryRegion, label: primaryRegion }],
    [costEngineMod, design.settings.primaryProvider, primaryRegion],
  );

  // Keep primaryRegion consistent when design changes via undo/redo, templates, or provider switch
  useEffect(() => {
    if (
      primaryProviderRegions.length > 0 &&
      !primaryProviderRegions.some((r) => r.code === primaryRegion)
    ) {
      setPrimaryRegion(primaryProviderRegions[0]!.code);
    }
  }, [primaryProviderRegions, primaryRegion]);

  const { snapshotProviders, snapshotRegions } = useMemo(() => {
    const provSet = new Set<string>();
    const regSet = new Set<string>([primaryRegion]);
    const pProv = design.settings.primaryProvider ?? 'aws';
    if (pProv === 'aws' || pProv === 'gcp' || pProv === 'azure' || pProv === 'oci') {
      provSet.add(pProv);
    }
    for (const n of design.nodes) {
      const p = n.serviceId.split('.')[0];
      if (p === 'aws' || p === 'gcp' || p === 'azure' || p === 'oci') {
        provSet.add(p);
      }
      if (n.region?.trim()) {
        regSet.add(n.region.trim());
      }
    }
    for (const g of design.groups) {
      if (
        g.provider &&
        (g.provider === 'aws' ||
          g.provider === 'gcp' ||
          g.provider === 'azure' ||
          g.provider === 'oci')
      ) {
        provSet.add(g.provider);
      }
      if (g.region?.trim()) {
        regSet.add(g.region.trim());
      }
    }
    if (provSet.size === 0) {
      provSet.add('aws');
    }
    return {
      snapshotProviders: [...provSet].sort(),
      snapshotRegions: [...regSet].sort(),
    };
  }, [design.settings.primaryProvider, design.nodes, design.groups, primaryRegion]);

  // Debounced public price snapshot fetch whenever cloud providers or regions in design change
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void syncPriceSnapshot(snapshotProviders, snapshotRegions);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [snapshotProviders, snapshotRegions, syncPriceSnapshot]);

  const costAssumptions = useMemo<CostAssumptions>(
    () => ({
      hoursPerMonth,
      traffic: costTrafficAssumption,
      instanceCountMode,
      includeFreeTier: design.settings.includeFreeTier,
      currency: design.settings.currency,
      ...(design.settings.fxRateToUSD ? { fxRateToUSD: design.settings.fxRateToUSD } : {}),
    }),
    [
      hoursPerMonth,
      costTrafficAssumption,
      instanceCountMode,
      design.settings.includeFreeTier,
      design.settings.currency,
      design.settings.fxRateToUSD,
    ],
  );

  const costReport = useMemo<CostReport>(
    () =>
      costEngineMod
        ? costEngineMod.estimateMonthlyCost(design, simResult, costSnapshot, costAssumptions, {
            defaultRegion: primaryRegion,
            customServices: availableCustomServices,
          })
        : {
            currency: design.settings.currency ?? 'USD',
            asOf: 'none',
            monthlyTotal: 0,
            perNode: {},
            transfer: [],
            byCategory: {},
            costPerMillionRequests: 0,
            warnings: [],
            assumptions: costAssumptions,
          },
    [
      costEngineMod,
      design,
      simResult,
      costSnapshot,
      costAssumptions,
      primaryRegion,
      availableCustomServices,
    ],
  );

  const costBreakdownMeta = useMemo<CostBreakdownMeta>(
    () =>
      costEngineMod
        ? costEngineMod.summarizeCostBreakdown(design, costReport, simResult, {
            customServices: availableCustomServices,
          })
        : {
            byProvider: {},
            transferTotal: 0,
            usdMonthlyTotal: 0,
            monthlyRequests: 0,
            unavailableCount: 0,
          },
    [costEngineMod, costReport, design, simResult, availableCustomServices],
  );

  const nodeCosts = useMemo<Record<string, NodeCostChipInfo>>(() => {
    const out: Record<string, NodeCostChipInfo> = {};
    for (const node of design.nodes) {
      const svc = getService(node.serviceId, availableCustomServices);
      const entry = costReport.perNode[node.id];
      const lines = entry?.lines ?? [];
      const subtotal = entry?.subtotal ?? 0;
      const unavailable = lines.some((l) => l.source === 'unavailable');
      const isFree = svc?.pricing.model === 'free' && lines.length === 0;
      const lineSummary =
        lines.length > 0
          ? lines
              .map((l) =>
                l.amount !== null
                  ? `${l.dimension}: ${formatMoney(l.amount, costReport.currency)}/mo`
                  : `${l.dimension}: price unavailable`,
              )
              .join('\n')
          : isFree
            ? 'Free / no charge'
            : 'Price unavailable';
      out[node.id] = {
        monthly: subtotal,
        currency: costReport.currency,
        unavailable,
        free: isFree,
        summaryTooltip: `${node.label} — ${
          unavailable && subtotal === 0
            ? 'price unavailable'
            : `${formatMoney(subtotal, costReport.currency)}/mo`
        }\n${lineSummary}`,
      };
    }
    return out;
  }, [design.nodes, availableCustomServices, costReport]);

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: 'run-sim',
        group: 'Simulation',
        label: isSimActive ? 'Stop simulation' : 'Run simulation',
        onSelect: () => {
          if (isSimActive) {
            stopPlayback();
          } else {
            void handleRunSimulation();
          }
        },
      },
      {
        id: 'reset-sim',
        group: 'Simulation',
        label: 'Reset simulation results',
        onSelect: () => resetSimulation(false),
      },
      {
        id: 'toggle-reduce-motion',
        group: 'Accessibility',
        label: reduceMotionOverride ? 'Disable reduce motion override' : 'Enable reduce motion',
        onSelect: () => setReduceMotionOverride(!reduceMotionOverride),
      },
      {
        id: 'toggle-theme',
        group: 'Appearance',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        onSelect: toggleTheme,
      },
      {
        id: 'undo',
        group: 'Edit',
        label: 'Undo last canvas edit',
        shortcut: 'Ctrl+Z',
        onSelect: undo,
      },
      {
        id: 'redo',
        group: 'Edit',
        label: 'Redo last canvas edit',
        shortcut: 'Ctrl+Shift+Z',
        onSelect: redo,
      },
      {
        id: 'toggle-dock',
        group: 'Layout',
        label: dockCollapsed ? 'Expand bottom dock' : 'Collapse bottom dock',
        onSelect: () => setDockCollapsed((prev) => !prev),
      },
      {
        id: 'tab-metrics',
        group: 'Dock',
        label: 'Open Metrics panel',
        onSelect: () => {
          setDockCollapsed(false);
          setDockTab('metrics');
        },
      },
      {
        id: 'tab-insights',
        group: 'Dock',
        label: 'Open Insights panel',
        onSelect: () => {
          setDockCollapsed(false);
          setDockTab('insights');
        },
      },
      {
        id: 'tab-traces',
        group: 'Dock',
        label: 'Open Traces waterfall',
        onSelect: () => {
          setDockCollapsed(false);
          setDockTab('traces');
        },
      },
      {
        id: 'edit-scenario-chaos',
        group: 'Simulation',
        label: 'Edit scenario chaos events',
        onSelect: () => {
          setCostPopoverOpen(false);
          setScenarioPopoverTab('chaos');
          setScenarioOpen(true);
        },
      },
      {
        id: 'tab-cost',
        group: 'Dock',
        label: 'Open Cost breakdown panel',
        onSelect: () => {
          setDockCollapsed(false);
          setDockTab('cost');
        },
      },
      {
        id: 'tab-latency',
        group: 'Inspector',
        label: 'Open Latency & Mock tab',
        onSelect: () => setInspectorTab('latency'),
      },
      {
        id: 'tab-code',
        group: 'Inspector',
        label: 'Open Code & Payload Tester tab',
        onSelect: () => setInspectorTab('code'),
      },
      {
        id: 'tab-inspector-cost',
        group: 'Inspector',
        label: 'Open Cost inspector tab',
        onSelect: () => setInspectorTab('cost'),
      },
      {
        id: 'tab-why',
        group: 'Inspector',
        label: 'Open Why? diagnostics tab',
        onSelect: () => setInspectorTab('why'),
      },
      {
        id: 'create-custom-service',
        group: 'Catalog',
        label: 'Create custom service',
        onSelect: () =>
          setCustomModal({
            open: true,
            mode: 'create',
            source: null,
            targetNodeId: null,
            targetNodeLabel: null,
          }),
      },
      {
        id: 'switch-cloud-provider',
        group: 'Cost & Cloud',
        label: 'Switch cloud provider...',
        onSelect: () => setProviderSwitchModal({ open: true }),
      },
      {
        id: 'open-templates',
        group: 'Templates',
        label: 'Open starter templates gallery',
        onSelect: () => setTemplatesOpen(true),
      },
      {
        id: 'load-template-tpl-3tier',
        group: 'Templates',
        label: 'Load template: Simple 3-tier web app',
        onSelect: () => {
          void import('../lib/templates').then((m) => {
            const tpl = m.getStarterTemplate('tpl-3tier');
            if (tpl) handleLoadTemplate(tpl);
          });
        },
      },
      {
        id: 'load-template-tpl-cache',
        group: 'Templates',
        label: 'Load template: Add a cache',
        onSelect: () => {
          void import('../lib/templates').then((m) => {
            const tpl = m.getStarterTemplate('tpl-cache');
            if (tpl) handleLoadTemplate(tpl);
          });
        },
      },
      {
        id: 'open-account',
        group: 'Account',
        label: user ? 'View account' : 'Sign in or register',
        onSelect: () => setAccountOpen(true),
      },
    ],
    [
      isSimActive,
      stopPlayback,
      handleRunSimulation,
      resetSimulation,
      handleLoadTemplate,
      reduceMotionOverride,
      setReduceMotionOverride,
      theme,
      dockCollapsed,
      user,
      undo,
      redo,
    ],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Top Bar */}
      <header
        data-testid="topbar"
        className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 2xl:gap-2">
          <div className="flex shrink-0 items-center gap-2 pr-0.5">
            <LogoMark className="h-5 w-5 text-[var(--text-primary)]" />
            <span className="text-[16px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
              InfraSim
            </span>
          </div>

          <div className="h-4 w-px shrink-0 bg-[var(--border-hairline)]" />

          {editingTitle ? (
            <input
              type="text"
              autoFocus
              aria-label="Design name"
              value={design.name}
              onChange={(e) => updateDesignMeta({ name: e.target.value })}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
              className="h-8 w-36 shrink rounded-[8px] border border-[var(--accent)] bg-[var(--bg-raised)] px-2 text-[13px] font-medium text-[var(--text-primary)] focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title={`${design.name} — click to rename architecture`}
              className="flex h-8 min-w-0 max-w-[96px] shrink items-center gap-1 rounded-[8px] px-1.5 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)] xl:max-w-[116px] 2xl:max-w-[176px]"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
              <span className="truncate">{design.name}</span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            </button>
          )}

          <button
            type="button"
            data-testid="open-templates-button"
            aria-label="Templates"
            onClick={() => setTemplatesOpen(true)}
            title="Starter templates"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[12px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <LayoutTemplate className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span className="hidden xl:inline">Templates</span>
          </button>

          <select
            aria-label="Primary provider"
            value={design.settings.primaryProvider ?? 'aws'}
            onChange={(e) => {
              const nextProv = e.target.value as Provider;
              updateDesignMeta({ settings: { primaryProvider: nextProv } });
              const regionsForNext = costEngineMod
                ? costEngineMod.listRegionsForProvider(nextProv)
                : [];
              if (
                regionsForNext.length > 0 &&
                !regionsForNext.some((r) => r.code === primaryRegion)
              ) {
                setPrimaryRegion(regionsForNext[0]!.code);
              }
            }}
            className="h-8 shrink-0 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-1.5 text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="aws">AWS</option>
            <option value="gcp">GCP</option>
            <option value="azure">Azure</option>
            <option value="oci">OCI</option>
          </select>

          <button
            type="button"
            data-testid="topbar-switch-cloud-btn"
            title="Map topology and cost to another cloud provider"
            onClick={() => setProviderSwitchModal({ open: true })}
            className="hidden h-8 shrink-0 items-center gap-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] xl:inline-flex"
          >
            <ArrowLeftRight className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span className="hidden 2xl:inline">Switch cloud</span>
          </button>

          <select
            aria-label="Primary region"
            value={primaryRegion}
            onChange={(e) => setPrimaryRegion(e.target.value)}
            className="hidden h-8 shrink-0 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 font-mono text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none 2xl:block"
          >
            {primaryProviderRegions.length > 0 ? (
              primaryProviderRegions.map((reg) => (
                <option key={reg.key} value={reg.code}>
                  {reg.code}
                </option>
              ))
            ) : (
              <>
                <option value="us-east-1">us-east-1</option>
                <option value="us-west-2">us-west-2</option>
                <option value="eu-central-1">eu-central-1</option>
                <option value="ap-south-1">ap-south-1</option>
              </>
            )}
          </select>

          {activeScenario ? (
            <div className="relative min-w-0 max-w-[164px] shrink 2xl:max-w-[260px]">
              <button
                type="button"
                data-testid="scenario-button"
                title={`${activeScenario.name} (${activeScenario.profile.kind})`}
                onClick={() => {
                  setCostPopoverOpen(false);
                  setScenarioOpen((prev) => {
                    const next = !prev;
                    if (next) {
                      setScenarioPopoverTab('traffic');
                      setChaosTargetNode(null);
                    }
                    return next;
                  });
                }}
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[12px] text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <span className="min-w-0 flex-1 truncate">{activeScenario.name}</span>
                <span className="hidden shrink-0 font-mono text-[11px] text-[var(--text-muted)] 2xl:inline">
                  {activeScenario.profile.kind}
                </span>
                {activeScenario.chaos.length > 0 ? (
                  <span
                    data-testid="scenario-chaos-count"
                    className="shrink-0 rounded-[4px] bg-[rgba(229,160,13,0.16)] px-1 font-mono text-[10px] tabular-nums text-[var(--status-warm)]"
                  >
                    {activeScenario.chaos.length} chaos
                  </span>
                ) : null}
                <ChevronDown
                  className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                  strokeWidth={1.5}
                />
              </button>

              {scenarioOpen ? (
                <div
                  data-testid="scenario-popover"
                  className="absolute left-0 top-10 z-40 max-h-[calc(100vh-80px)] w-96 overflow-y-auto rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-floating)]"
                >
                  <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2">
                    <select
                      aria-label="Active scenario"
                      value={activeScenario.id}
                      onChange={(e) => setActiveScenario(e.target.value)}
                      className="h-7 flex-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                    >
                      {design.scenarios.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setScenarioOpen(false)}
                      className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      Done
                    </button>
                  </div>

                  <div
                    role="tablist"
                    aria-label="Scenario editor mode"
                    className="mb-3 grid grid-cols-2 gap-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-1"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={scenarioPopoverTab === 'traffic'}
                      data-testid="scenario-tab-traffic"
                      onClick={() => setScenarioPopoverTab('traffic')}
                      className={`h-7 rounded-[6px] text-[12px] font-medium transition-colors ${
                        scenarioPopoverTab === 'traffic'
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      Traffic
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={scenarioPopoverTab === 'chaos'}
                      data-testid="scenario-tab-chaos"
                      onClick={() => setScenarioPopoverTab('chaos')}
                      className={`flex h-7 items-center justify-center gap-1.5 rounded-[6px] text-[12px] font-medium transition-colors ${
                        scenarioPopoverTab === 'chaos'
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      <span>Chaos</span>
                      <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                        ({activeScenario.chaos.length})
                      </span>
                    </button>
                  </div>

                  {scenarioPopoverTab === 'traffic' ? (
                    <TrafficProfileEditor
                      scenario={activeScenario}
                      seed={design.settings.seed}
                      liveCodeMode={liveCodeMode}
                      verboseLogs={verboseLogs}
                      onUpdateScenario={(updater) => updateScenario(activeScenario.id, updater)}
                      onUpdateSeed={(seed) => updateDesignMeta({ settings: { seed } })}
                      onChangeLiveCodeMode={setLiveCodeMode}
                      onChangeVerboseLogs={setVerboseLogs}
                    />
                  ) : (
                    <ChaosTimelineEditor
                      scenario={activeScenario}
                      nodes={design.nodes}
                      groups={design.groups}
                      preselectedNodeId={chaosTargetNode?.nodeId ?? selectedNodeId}
                      preselectedAz={chaosTargetNode?.az}
                      onUpdateScenario={(updater) => updateScenario(activeScenario.id, updater)}
                    />
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Center run controls */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-1">
            {isSimActive ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="stop-sim-button"
                onClick={stopPlayback}
                title={simStatus === 'running' ? 'Stop simulation run' : 'Stop playback'}
                className="h-7 px-3 text-[12px] text-[var(--status-overloaded)]"
              >
                <Square className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>Stop</span>
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                data-testid="run-sim-button"
                onClick={() => void handleRunSimulation()}
                className="h-7 px-3 text-[12px]"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>Run</span>
              </Button>
            )}

            <button
              type="button"
              data-testid="pause-sim-button"
              aria-label={simPlaying ? 'Pause playback' : 'Play buffered frames'}
              title={simPlaying ? 'Pause playback' : 'Play buffered frames'}
              disabled={simStatus === 'running' || simFrames.length === 0}
              onClick={togglePausePlayback}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              {simPlaying ? (
                <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />
              ) : (
                <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
            </button>

            <button
              type="button"
              data-testid="reset-sim-button"
              aria-label="Reset simulation"
              title="Reset simulation"
              disabled={simFrames.length === 0 && !simResult && simStatus === 'idle'}
              onClick={() => resetSimulation(false)}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>

          <select
            aria-label="Playback speed"
            data-testid="sim-speed-select"
            value={speed}
            onChange={(e) => setSpeed(e.target.value as SimSpeed)}
            className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="1">1× speed</option>
            <option value="5">5× speed</option>
            <option value="20">20× speed</option>
            <option value="max">Max</option>
          </select>

          {simResult?.scaled ? (
            <span
              title={`Scaled DES mode: 1 simulated event represents ${simResult.scaled.factor} requests`}
              className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 py-1 font-mono text-[11px] tabular-nums text-[var(--status-warm)]"
            >
              Scaled ×{simResult.scaled.factor}
            </span>
          ) : null}

          <div className="relative shrink-0">
            <button
              type="button"
              data-testid="topbar-cost-pill"
              onClick={() => {
                setScenarioOpen(false);
                setCostPopoverOpen((prev) => !prev);
              }}
              title={
                costReport.currency !== 'USD' && design.settings.fxRateToUSD
                  ? `Original USD estimate: ${formatMoney(costBreakdownMeta.usdMonthlyTotal, 'USD')}/mo (${costAssumptions.hoursPerMonth}h/mo, ${costAssumptions.instanceCountMode} instances)`
                  : `Estimated monthly on-demand cost (${costAssumptions.hoursPerMonth}h/mo, ${costAssumptions.instanceCountMode} instances)`
              }
              className="flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)]"
            >
              <span>
                {costReport.monthlyTotal === 0 && costBreakdownMeta.unavailableCount > 0
                  ? '$?'
                  : formatCompactMonthlyCost(costReport.monthlyTotal, costReport.currency)}
              </span>
              {costBreakdownMeta.unavailableCount > 0 ? (
                <span className="rounded-[4px] bg-[var(--bg-sunken)] px-1 text-[10px] text-[var(--status-warm)]">
                  {costBreakdownMeta.unavailableCount}?
                </span>
              ) : null}
            </button>

            {costPopoverOpen ? (
              <div
                data-testid="cost-assumptions-popover"
                className="absolute right-0 top-10 z-40 w-80 space-y-3 rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 text-[12px] shadow-[var(--shadow-floating)]"
              >
                <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2">
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">
                      Monthly cost assumptions
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)]">
                      On-demand list prices only
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCostPopoverOpen(false)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    Done
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-secondary)]">Hours / month</span>
                    <input
                      type="number"
                      min={1}
                      max={744}
                      value={hoursPerMonth}
                      onChange={(e) => setHoursPerMonth(Number(e.target.value))}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      Autoscaled nodes
                    </span>
                    <select
                      aria-label="Instance count mode"
                      value={instanceCountMode}
                      onChange={(e) =>
                        setInstanceCountMode(e.target.value as CostAssumptions['instanceCountMode'])
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                    >
                      <option value="average">Time-weighted avg</option>
                      <option value="peak">Peak active</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-secondary)]">Traffic basis</span>
                    <select
                      aria-label="Traffic scaling mode"
                      value={costTrafficAssumption.mode}
                      onChange={(e) => {
                        const mode = e.target.value as CostAssumptions['traffic']['mode'];
                        setTrafficAssumption({
                          mode,
                          ...(mode === 'custom-avg-rps'
                            ? { value: costTrafficAssumption.value ?? 100 }
                            : mode === 'custom-monthly-requests'
                              ? { value: costTrafficAssumption.value ?? 1_000_000 }
                              : {}),
                        });
                      }}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                    >
                      <option value="run-average">Run average</option>
                      <option value="custom-avg-rps">Custom avg RPS</option>
                      <option value="custom-monthly-requests">Monthly requests</option>
                    </select>
                  </label>

                  {costTrafficAssumption.mode !== 'run-average' ? (
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        {costTrafficAssumption.mode === 'custom-avg-rps' ? 'Avg RPS' : 'Requests'}
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={costTrafficAssumption.value ?? 0}
                        onChange={(e) =>
                          setTrafficAssumption({
                            mode: costTrafficAssumption.mode,
                            value: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                  ) : (
                    <div className="flex items-end pb-1.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                      ~{Math.round(costBreakdownMeta.monthlyRequests).toLocaleString()} req/mo
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-secondary)]">Currency</span>
                    <select
                      aria-label="Display currency"
                      value={design.settings.currency}
                      onChange={(e) =>
                        updateDesignMeta({
                          settings: {
                            currency: e.target.value as 'USD' | 'INR' | 'EUR' | 'GBP',
                          },
                        })
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)]"
                    >
                      <option value="USD">USD ($)</option>
                      <option value="INR">INR (₹)</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="GBP">GBP (£)</option>
                    </select>
                  </label>

                  {design.settings.currency !== 'USD' ? (
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        FX (1 USD = ?)
                      </span>
                      <input
                        type="number"
                        min={0.0001}
                        step="0.01"
                        placeholder="e.g. 84"
                        value={design.settings.fxRateToUSD ?? ''}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          updateDesignMeta({
                            settings: {
                              fxRateToUSD: Number.isFinite(v) && v > 0 ? v : undefined,
                            },
                          });
                        }}
                        className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                  ) : null}
                </div>

                <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={design.settings.includeFreeTier}
                    onChange={(e) =>
                      updateDesignMeta({ settings: { includeFreeTier: e.target.checked } })
                    }
                  />
                  <span>Include free-tier allowance (from snapshot bands)</span>
                </label>

                <div className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-2.5 text-[11px]">
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    {(costSnapshot?.generatedAt ?? costLastFetchedAt)
                      ? `Snapshot ${formatSnapshotAge(costSnapshot?.generatedAt ?? costLastFetchedAt)}`
                      : costError
                        ? 'Snapshot offline'
                        : 'No snapshot loaded'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void syncPriceSnapshot(snapshotProviders, snapshotRegions, { force: true })
                      }
                      disabled={costLoading}
                      className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
                      <span>Sync</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCostPopoverOpen(false);
                        setDockTab('cost');
                        setDockCollapsed(false);
                      }}
                      className="inline-flex h-7 items-center rounded-[6px] bg-[var(--accent-solid)] px-2.5 text-[11px] font-medium text-[var(--accent-solid-text)]"
                    >
                      Breakdown
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={undo}
              title="Undo (Ctrl+Z)"
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={redo}
              title="Redo (Ctrl+Shift+Z)"
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCommandOpen(true)}
            aria-label="Open command palette"
            className="hidden sm:inline-flex"
          >
            <Command className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span className="hidden 2xl:inline">Commands</span>
            <Keycap className="hidden 2xl:inline-flex">Ctrl+K</Keycap>
          </Button>

          <button
            type="button"
            aria-label="Share design"
            onClick={() => setStatusNotice('Design sharing activates in Phase 6')}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <Share2 className="h-4 w-4" strokeWidth={1.5} />
          </button>

          <button
            type="button"
            data-testid="reduce-motion-toggle"
            aria-pressed={reducedMotion}
            aria-label={reducedMotion ? 'Reduce motion enabled' : 'Reduce motion'}
            title={`Reduce motion (${reduceMotionOverride ? 'manual on' : systemReducedMotion ? 'OS setting' : 'off'})`}
            onClick={() => setReduceMotionOverride(!reduceMotionOverride)}
            className={`flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors ${
              reducedMotion
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Accessibility className="h-4 w-4" strokeWidth={1.5} />
          </button>

          <button
            type="button"
            data-testid="theme-toggle"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={toggleTheme}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <Moon className="h-4 w-4" strokeWidth={1.5} />
            )}
          </button>

          <Button
            variant="secondary"
            size="sm"
            data-testid="account-button"
            onClick={() => setAccountOpen(true)}
          >
            <User className="h-4 w-4 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>{user ? user.name : 'Guest'}</span>
          </Button>
        </div>
      </header>

      {/* Main 3-column Workbench */}
      <div className="flex min-h-0 flex-1">
        <Palette
          customServices={availableCustomServices}
          onAddService={handleAddServiceAtCenter}
          onAddGroup={handleAddGroupAtCenter}
          onRequestCustomService={() =>
            setCustomModal({
              open: true,
              mode: 'create',
              source: null,
              targetNodeId: null,
              targetNodeLabel: null,
            })
          }
          onEditCustomService={(svc) =>
            setCustomModal({
              open: true,
              mode: 'edit',
              source: svc,
              targetNodeId: null,
              targetNodeLabel: null,
            })
          }
          onDeleteCustomService={handleDeleteCustomService}
        />

        <main className="relative flex min-w-0 flex-1">
          <Canvas
            theme={theme}
            currentFrame={currentFrame}
            nodeReasons={nodeReasons}
            nodeCosts={nodeCosts}
            reducedMotion={reducedMotion}
            onInspectNode={handleInspectNode}
            onInjectChaosNode={(nodeId, az) => {
              setCostPopoverOpen(false);
              setChaosTargetNode({ nodeId, ...(az ? { az } : {}) });
              setScenarioPopoverTab('chaos');
              setScenarioOpen(true);
            }}
            onLoadTemplateClick={() => setTemplatesOpen(true)}
            registerViewportCenterGetter={(getter) => {
              viewportCenterGetterRef.current = getter;
            }}
          />

          {missingClientPromptOpen ? (
            <div
              data-testid="missing-client-prompt"
              role="status"
              className="absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-3 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-[12px] shadow-[var(--shadow-floating)]"
            >
              <AlertTriangle
                className="h-4 w-4 shrink-0 text-[var(--status-warm)]"
                strokeWidth={1.5}
              />
              <span className="text-[var(--text-primary)]">
                {design.nodes.length === 0
                  ? 'Add services or a Load Generator before running a simulation'
                  : 'No Load Generator on canvas'}
              </span>
              <Button
                variant="primary"
                size="sm"
                data-testid="add-load-generator-btn"
                onClick={handleAddLoadGeneratorAndRun}
                className="h-7 px-2.5 text-[11px]"
              >
                Add Load Generator
              </Button>
              {design.nodes.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    void startSimulation(design, activeScenarioId, { allowMissingClient: true })
                  }
                  className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Run from first node
                </button>
              ) : null}
              <button
                type="button"
                onClick={dismissMissingClientPrompt}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {simError ? (
            <div
              role="alert"
              className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-[8px] border border-[var(--status-overloaded)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--status-overloaded)] shadow-[var(--shadow-floating)]"
            >
              <span>Simulation failed: {simError}</span>
              <button
                type="button"
                onClick={() => resetSimulation(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Clear
              </button>
            </div>
          ) : null}

          {statusNotice ? (
            <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-floating)]">
              <span>{statusNotice}</span>
              <button
                type="button"
                onClick={() => setStatusNotice(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </main>

        {/* Right Inspector */}
        <aside
          data-testid="inspector-panel"
          className="flex w-80 shrink-0 flex-col border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] xl:w-[348px]"
        >
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-[var(--border-hairline)] px-2 py-2">
            {INSPECTOR_TABS.map((tab) => {
              const active = inspectorTab === tab.id;
              const badgeCount = tab.id === 'why' ? selectedNodeInsightCount : 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`inspector-tab-${tab.id}`}
                  onClick={() => setInspectorTab(tab.id)}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11px] font-medium transition-colors ${
                    active
                      ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <span>{tab.label}</span>
                  {badgeCount > 0 ? (
                    <span className="rounded-full bg-[rgba(229,72,77,0.16)] px-1 py-0.5 font-mono text-[10px] tabular-nums text-[var(--status-overloaded)]">
                      {badgeCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selectedGroup ? (
            <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
              <div>
                <div className="text-[11px] font-medium text-[var(--text-muted)]">
                  Container ({selectedGroup.kind})
                </div>
                <label className="mt-2 block">
                  <span className="text-[11px] text-[var(--text-secondary)]">Label</span>
                  <input
                    type="text"
                    value={selectedGroup.label}
                    onChange={(e) => updateGroup(selectedGroup.id, { label: e.target.value })}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>
                {selectedGroup.kind === 'region' ||
                selectedGroup.kind === 'vpc' ||
                selectedGroup.kind === 'subnet' ||
                selectedGroup.kind === 'az' ||
                selectedGroup.kind === 'zone' ||
                selectedGroup.kind === 'compartment' ? (
                  <label className="mt-2.5 block">
                    <span className="text-[11px] text-[var(--text-secondary)]">Region</span>
                    <input
                      type="text"
                      placeholder="us-east-1"
                      value={selectedGroup.region ?? ''}
                      onChange={(e) => updateGroup(selectedGroup.id, { region: e.target.value })}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  </label>
                ) : null}
                {selectedGroup.kind === 'vpc' || selectedGroup.kind === 'subnet' ? (
                  <label className="mt-2.5 block">
                    <span className="text-[11px] text-[var(--text-secondary)]">CIDR block</span>
                    <input
                      type="text"
                      value={selectedGroup.cidr ?? ''}
                      onChange={(e) => updateGroup(selectedGroup.id, { cidr: e.target.value })}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  </label>
                ) : null}
                {selectedGroup.kind === 'subnet' ? (
                  <label className="mt-3 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedGroup.public)}
                      onChange={(e) => updateGroup(selectedGroup.id, { public: e.target.checked })}
                    />
                    <span className="text-[12px] text-[var(--text-primary)]">Public subnet</span>
                  </label>
                ) : null}
              </div>
            </div>
          ) : selectedNode ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="border-b border-[var(--border-hairline)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--bg-raised)] text-[var(--text-secondary)]">
                      <ServiceIcon
                        icon={selectedNodeService?.icon ?? 'generic'}
                        serviceId={selectedNode.serviceId}
                        color={
                          selectedNodeService &&
                          'color' in selectedNodeService &&
                          typeof selectedNodeService.color === 'string'
                            ? selectedNodeService.color
                            : undefined
                        }
                        className="h-4 w-4 shrink-0 rounded-[3px]"
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {selectedNode.label}
                      </div>
                      <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                        {selectedNode.serviceId}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {selectedNodeService ? (
                      <button
                        type="button"
                        data-testid="duplicate-as-custom-button"
                        title="Duplicate service as editable custom block"
                        onClick={() =>
                          setCustomModal({
                            open: true,
                            mode: selectedNodeService.provider === 'custom' ? 'edit' : 'duplicate',
                            source: selectedNodeService,
                            targetNodeId: selectedNode.id,
                            targetNodeLabel: selectedNode.label,
                          })
                        }
                        className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-1.5 text-[10px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                      >
                        <Copy className="h-3 w-3" strokeWidth={1.5} />
                        <span>
                          {selectedNodeService.provider === 'custom' ? 'Edit custom' : 'Customize'}
                        </span>
                      </button>
                    ) : null}
                    <span className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                      {selectedNodeService?.kind ?? 'node'}
                    </span>
                  </div>
                </div>
              </div>

              {inspectorTab === 'config' ? (
                <ConfigTab
                  node={selectedNode}
                  service={selectedNodeService}
                  groups={design.groups}
                  activeScenario={activeScenario}
                  seed={design.settings.seed}
                  onUpdateScenario={updateScenario}
                  onUpdateSeed={(seed) => updateDesignMeta({ settings: { seed } })}
                  onRename={(label) => updateNodeLabel(selectedNode.id, label)}
                  onUpdatePlacement={(placement) => updateNodePlacement(selectedNode.id, placement)}
                  onUpdateConfig={(updater) => updateNodeConfig(selectedNode.id, updater)}
                />
              ) : inspectorTab === 'latency' ? (
                <LatencyMockTab
                  node={selectedNode}
                  service={selectedNodeService}
                  activeScenario={activeScenario}
                  seed={design.settings.seed}
                  presets={presets}
                  focusedOpName={
                    focusedOpState?.nodeId === selectedNode.id ? focusedOpState.opName : null
                  }
                  onUpdateConfig={(updater) => updateNodeConfig(selectedNode.id, updater)}
                  onResetNode={() => resetNodeToDefaults(selectedNode.id)}
                  onSavePreset={addPreset}
                  onApplyPreset={(preset) => applyPresetToNode(selectedNode.id, preset)}
                />
              ) : inspectorTab === 'code' ? (
                <CodeTab
                  theme={theme}
                  design={design}
                  node={selectedNode}
                  customServices={availableCustomServices}
                  libraryFixtures={libraryFixtures}
                  token={token}
                  focusLocation={
                    codeFocusLocation?.nodeId === selectedNode.id ? codeFocusLocation : null
                  }
                  profileSummary={
                    selectedNode.config.scriptId
                      ? profileSummaries[selectedNode.config.scriptId]
                      : undefined
                  }
                  profileIterations={profileIterations}
                  onChangeProfileIterations={setProfileIterations}
                  onSaveProfileSummary={setProfileSummary}
                  onUpdateNodeConfig={(updater) => updateNodeConfig(selectedNode.id, updater)}
                  onUpsertScript={upsertDesignScript}
                  onDeleteScript={deleteDesignScript}
                  onUpsertDesignFixture={upsertDesignFixture}
                  onUpsertLibraryFixture={upsertLibraryFixture}
                  onEditCallMock={handleEditCallMock}
                  onApplyMockPatches={handleApplyMockPatches}
                  onRecordDryRunLogs={appendSimLogs}
                  onSyncScenarioScript={(extracted: ExtractedScenarioResult, scriptId: string) => {
                    const targetScenarioId = activeScenario?.id;
                    if (!targetScenarioId) return;
                    void import('@infrasim/sandbox/thresholds').then(
                      ({ applyExtractedScenarioToScenario }) => {
                        updateScenario(targetScenarioId, (s) => {
                          Object.assign(
                            s,
                            applyExtractedScenarioToScenario(s, extracted, scriptId),
                          );
                        });
                        setStatusNotice(
                          `Synced ${extracted.flows.length} scenario flow(s) from script`,
                        );
                      },
                    );
                  }}
                  onOpenNetworkTab={() => setInspectorTab('network')}
                />
              ) : inspectorTab === 'cost' ? (
                <CostTab
                  node={selectedNode}
                  service={selectedNodeService}
                  costReport={costReport}
                  assumptions={costAssumptions}
                  onUpdateConfig={(updater) => updateNodeConfig(selectedNode.id, updater)}
                  onOpenCostDock={() => {
                    setDockTab('cost');
                    setDockCollapsed(false);
                  }}
                />
              ) : inspectorTab === 'why' ? (
                <WhyTabSlot
                  design={design}
                  node={selectedNode}
                  service={selectedNodeService}
                  result={simResult}
                  previousResult={simPreviousResult}
                  appliedFixLabel={appliedFixLabel}
                  isRunning={simStatus === 'running'}
                  onApplyPatchedDesign={handleApplyPatchedDesign}
                  onRerunVerify={handleRerunVerify}
                />
              ) : (
                <div className="p-4 text-[12px] text-[var(--text-secondary)]">
                  The {inspectorTab} inspector activates in its upcoming phase.
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
              <Sliders className="mb-2 h-4 w-4 text-[var(--text-muted)]" strokeWidth={1.5} />
              <p className="text-[13px] font-medium text-[var(--text-secondary)]">
                No node selected
              </p>
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                Select a node, group, or edge on the canvas to inspect {inspectorTab} properties.
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* Bottom Dock */}
      <section
        data-testid="bottom-dock"
        className={`flex shrink-0 flex-col border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] ${
          dockCollapsed ? 'h-10' : 'h-64'
        }`}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-3">
          <div className="flex items-center gap-1 overflow-x-auto">
            {DOCK_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = dockTab === tab.id;
              const insightsBadge =
                tab.id === 'insights' && simResult ? simResult.insights.length : 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`dock-tab-${tab.id}`}
                  onClick={() => {
                    setDockTab(tab.id);
                    setDockCollapsed(false);
                  }}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${
                    active && !dockCollapsed
                      ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>{tab.label}</span>
                  {insightsBadge > 0 ? (
                    <span className="rounded-full bg-[rgba(229,72,77,0.16)] px-1.5 font-mono text-[10px] tabular-nums text-[var(--status-overloaded)]">
                      {insightsBadge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            {simFrames.length > 1 ? (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  aria-label="Simulation timeline scrubber"
                  data-testid="sim-scrubber"
                  min={0}
                  max={simFrames.length - 1}
                  value={Math.max(0, playbackIdx)}
                  onChange={(e) => scrubTo(Number(e.target.value))}
                  className="h-1.5 w-36 cursor-pointer accent-[var(--accent)]"
                />
                {activeScenario && activeScenario.chaos.length > 0 ? (
                  <span
                    title={`${activeScenario.chaos.length} chaos marker(s) in scenario`}
                    className="font-mono text-[10px] text-[var(--status-warm)]"
                  >
                    {activeScenario.chaos.length}c
                  </span>
                ) : null}
              </div>
            ) : null}
            <span
              data-testid="sim-time-readout"
              className="font-mono text-[12px] tabular-nums text-[var(--text-muted)]"
            >
              t = {formatVirtualTime(currentFrame?.tVirtualMs ?? 0)} /{' '}
              {formatVirtualTime(
                (simFrames.length > 0 ? simDurationS : (activeScenario?.durationS ?? 60)) * 1000,
              )}
            </span>
            <button
              type="button"
              aria-label={dockCollapsed ? 'Expand bottom dock' : 'Collapse bottom dock'}
              onClick={() => setDockCollapsed((prev) => !prev)}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              {dockCollapsed ? (
                <ChevronUp className="h-4 w-4" strokeWidth={1.5} />
              ) : (
                <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>

        {!dockCollapsed ? (
          dockTab === 'metrics' ? (
            <MetricsDockTab
              design={design}
              result={simResult}
              previousResult={simPreviousResult}
              chaos={activeScenario?.chaos ?? []}
              scenarioThresholds={activeScenario?.thresholds}
              selectedNodeId={selectedNodeId}
              currentTimeS={currentFrame ? currentFrame.tVirtualMs / 1000 : null}
              elapsedWallMs={simElapsedWallMs}
              onSeekToTimeS={seekToTimeS}
              onSelectBottleneck={(nodeId) => handleInspectNode(nodeId, 'why')}
            />
          ) : dockTab === 'logs' ? (
            <LogsDockTab
              design={design}
              logs={simLogs}
              onClearLogs={clearSimLogs}
              onJumpToTrace={(traceId) => {
                setRequestedTraceId({ traceId, nonce: Date.now() });
                setDockTab('traces');
                setDockCollapsed(false);
              }}
              onJumpToCode={(nodeId, line, column) => {
                selectNode(nodeId);
                setInspectorTab('code');
                setCodeFocusLocation({ nodeId, line, column, nonce: Date.now() });
              }}
              onOpenWhy={(nodeId) => handleInspectNode(nodeId, 'why')}
            />
          ) : dockTab === 'traces' ? (
            <TracesDockTab
              design={design}
              result={simResult}
              selectedNodeId={selectedNodeId}
              requestedTraceId={requestedTraceId}
              onSelectNode={(nodeId, openWhy) =>
                handleInspectNode(nodeId, openWhy ? 'why' : 'latency')
              }
            />
          ) : dockTab === 'cost' ? (
            <CostDockTab
              design={design}
              result={simResult}
              report={costReport}
              breakdownMeta={costBreakdownMeta}
              assumptions={costAssumptions}
              snapshot={costSnapshot}
              snapshotLoading={costLoading}
              snapshotError={costError}
              lastFetchedAt={costLastFetchedAt}
              isOfflineFallback={costIsOfflineFallback}
              defaultRegion={primaryRegion}
              customServices={availableCustomServices}
              onRefreshPrices={() =>
                void syncPriceSnapshot(snapshotProviders, snapshotRegions, { force: true })
              }
              onSyncAllCloudsPrices={handleSyncAllComparisonPrices}
              onSelectNode={(nodeId) => handleInspectNode(nodeId, 'cost')}
              onSelectRegion={handleSelectComparisonRegion}
              onOpenAssumptions={() => setCostPopoverOpen(true)}
              onOpenProviderSwitch={(targetProv) =>
                setProviderSwitchModal({
                  open: true,
                  ...(targetProv ? { targetProvider: targetProv } : {}),
                })
              }
            />
          ) : dockTab === 'insights' ? (
            <InsightsDockTab
              design={design}
              result={simResult}
              appliedFixLabel={appliedFixLabel}
              isRunning={simStatus === 'running'}
              onSelectNodeWhy={(nodeId) => handleInspectNode(nodeId, 'why')}
              onApplyPatchedDesign={handleApplyPatchedDesign}
              onRerunVerify={handleRerunVerify}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-4 text-center">
              <p className="text-[12px] text-[var(--text-muted)]">
                Run a simulation to populate {dockTab} telemetry.
              </p>
            </div>
          )
        ) : null}
      </section>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        commands={commands}
      />

      <TemplateModal
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onSelectTemplate={handleLoadTemplate}
      />

      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        token={token}
        onAuthChange={(nextUser, nextToken) => {
          setUser(nextUser);
          setToken(nextToken);
          if (nextToken) {
            void fetchCustomServicesApi(nextToken)
              .then((remoteCustom) => {
                if (remoteCustom.length > 0) {
                  const localNow = useDesignStore.getState().userCustomServices;
                  const merged = mergeCustomServices(
                    remoteCustom.map((r) => r.definition),
                    localNow,
                  );
                  setUserCustomServices(merged);
                  for (const item of merged) {
                    void saveCustomServiceToIndexedDb(item);
                  }
                }
              })
              .catch(() => {
                // Ignore sync failure if offline
              });
            void fetchFixturesApi(nextToken)
              .then((remoteFixtures) => {
                if (remoteFixtures.length > 0) {
                  const mapped: PayloadFixture[] = remoteFixtures.map((r) => ({
                    id: r.id,
                    name: r.name,
                    ...(r.template ? { template: r.template } : {}),
                    event: r.event,
                    ...(r.schema ? { schema: r.schema } : {}),
                  }));
                  const merged = mergePayloadFixtures(
                    mapped,
                    useDesignStore.getState().libraryFixtures,
                  );
                  setLibraryFixtures(merged);
                  for (const item of merged) {
                    void saveFixtureToIndexedDb(item);
                  }
                }
              })
              .catch(() => {
                // Ignore sync failure if offline
              });
          }
        }}
      />

      <CustomServiceModal
        open={customModal.open}
        mode={customModal.mode}
        initialSource={customModal.source}
        targetNodeLabel={customModal.targetNodeLabel}
        existingCustomIds={availableCustomServices.map((s) => s.id)}
        isSignedIn={Boolean(token)}
        onClose={() =>
          setCustomModal((prev) => ({
            ...prev,
            open: false,
          }))
        }
        onSave={handleSaveCustomService}
      />

      <ProviderSwitchModal
        open={providerSwitchModal.open}
        design={design}
        simResult={simResult}
        priceSnapshot={costSnapshot}
        assumptions={costAssumptions}
        currentRegion={primaryRegion}
        customServices={availableCustomServices}
        initialTargetProvider={providerSwitchModal.targetProvider}
        onClose={() => setProviderSwitchModal({ open: false })}
        onApplySwitch={(nextDesign, targetProvider, targetRegion) => {
          applyPatchedDesign(nextDesign);
          setPrimaryRegion(targetRegion);
          setStatusNotice(
            `Switched architecture to ${targetProvider.toUpperCase()} (${targetRegion}) — undo with Ctrl+Z`,
          );
        }}
      />
    </div>
  );
}
