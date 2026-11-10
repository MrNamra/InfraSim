'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accessibility,
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Command,
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
  RotateCcw,
  Share2,
  Sliders,
  Square,
  Sun,
  Terminal,
  Undo2,
  User,
} from 'lucide-react';
import type { GroupInstance, Provider } from '@infrasim/shared-types';
import { getService } from '@infrasim/catalog';
import { Button, Keycap, LogoMark } from '@infrasim/ui-kit';
import { fetchCurrentUser, getStoredToken, setStoredToken, type AuthUser } from '../lib/api';
import {
  loadActiveDesignFromIndexedDb,
  loadPresetsFromIndexedDb,
  saveDesignToIndexedDb,
} from '../lib/autosave';
import { formatVirtualTime } from '../lib/timeFormat';
import { STARTER_TEMPLATES, type StarterTemplate } from '../lib/templates';
import { useDesignStore } from '../store/designStore';
import { type SimSpeed, useSimulationStore } from '../store/simulationStore';
import { AccountModal } from './AccountModal';
import { Canvas } from './canvas/Canvas';
import { CommandPalette, type CommandItem } from './CommandPalette';
import { InsightsDockTab } from './dock/InsightsDockTab';
import { MetricsDockTab } from './dock/MetricsDockTab';
import { ConfigTab } from './inspector/ConfigTab';
import { LatencyMockTab } from './inspector/LatencyMockTab';
import { WhyTab } from './inspector/WhyTab';
import { Palette } from './Palette';
import { ServiceIcon } from './ServiceIcon';
import { TemplateModal } from './TemplateModal';
import { TrafficProfileEditor } from './TrafficProfileEditor';

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
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [appliedFixLabel, setAppliedFixLabel] = useState<string | null>(null);

  const viewportCenterGetterRef = useRef<() => { x: number; y: number }>(() => ({
    x: 240,
    y: 180,
  }));
  const autosaveHydratedRef = useRef(false);

  const design = useDesignStore((s) => s.design);
  const presets = useDesignStore((s) => s.presets);
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
  const simError = useSimulationStore((s) => s.errorMessage);
  const missingClientPromptOpen = useSimulationStore((s) => s.missingClientPromptOpen);

  const startSimulation = useSimulationStore((s) => s.runSimulation);
  const stopPlayback = useSimulationStore((s) => s.stopPlayback);
  const togglePausePlayback = useSimulationStore((s) => s.togglePausePlayback);
  const scrubTo = useSimulationStore((s) => s.scrubTo);
  const seekToTimeS = useSimulationStore((s) => s.seekToTimeS);
  const advancePlayback = useSimulationStore((s) => s.advancePlayback);
  const setSpeed = useSimulationStore((s) => s.setSpeed);
  const dismissMissingClientPrompt = useSimulationStore((s) => s.dismissMissingClientPrompt);
  const resetSimulation = useSimulationStore((s) => s.resetSimulation);

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
      fetchCurrentUser(storedToken)
        .then((u) => setUser(u))
        .catch(() => {
          setStoredToken(null);
          setToken(null);
        });
    }

    Promise.all([loadActiveDesignFromIndexedDb(), loadPresetsFromIndexedDb()])
      .then(([savedDesign, savedPresets]) => {
        if (savedDesign && savedDesign.nodes.length + savedDesign.groups.length > 0) {
          loadDesign(savedDesign, true);
        }
        if (savedPresets.length > 0) {
          setPresets(savedPresets);
        }
      })
      .catch(() => {
        // Ignore IndexedDB unavailability in restricted contexts
      })
      .finally(() => {
        autosaveHydratedRef.current = true;
      });
  }, [loadDesign, setPresets]);

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
    (nodeId: string, tab: 'config' | 'latency' | 'why') => {
      selectNode(nodeId);
      setInspectorTab(tab);
    },
    [selectNode],
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

  const handleRunSimulation = useCallback(async () => {
    setScenarioOpen(false);
    setAppliedFixLabel(null);
    await startSimulation(useDesignStore.getState().design, activeScenarioId);
  }, [activeScenarioId, startSimulation]);

  const handleApplyPatchedDesign = useCallback(
    (nextDesign: typeof design, fixLabel: string) => {
      applyPatchedDesign(nextDesign);
      setAppliedFixLabel(fixLabel);
    },
    [applyPatchedDesign],
  );

  const handleRerunVerify = useCallback(() => {
    setAppliedFixLabel(null);
    void startSimulation(useDesignStore.getState().design, activeScenarioId);
  }, [activeScenarioId, startSimulation]);

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
    const targetScenarioId = state.activeScenarioId;
    updateScenario(targetScenarioId, (s) => {
      s.entryNodeId = clientId;
    });
    dismissMissingClientPrompt();
    const updatedDesign = useDesignStore.getState().design;
    void startSimulation(updatedDesign, targetScenarioId);
  }, [addServiceNode, connectEdge, dismissMissingClientPrompt, startSimulation, updateScenario]);

  const selectedNode = useMemo(
    () => (selectedNodeId ? (design.nodes.find((n) => n.id === selectedNodeId) ?? null) : null),
    [design.nodes, selectedNodeId],
  );
  const selectedNodeService = useMemo(
    () =>
      selectedNode ? getService(selectedNode.serviceId, design.customServices ?? []) : undefined,
    [selectedNode, design.customServices],
  );
  const selectedGroup = useMemo(
    () => (selectedGroupId ? (design.groups.find((g) => g.id === selectedGroupId) ?? null) : null),
    [design.groups, selectedGroupId],
  );
  const activeScenario = useMemo(
    () => design.scenarios.find((s) => s.id === activeScenarioId) ?? design.scenarios[0] ?? null,
    [design.scenarios, activeScenarioId],
  );

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
        id: 'tab-latency',
        group: 'Inspector',
        label: 'Open Latency & Mock tab',
        onSelect: () => setInspectorTab('latency'),
      },
      {
        id: 'tab-why',
        group: 'Inspector',
        label: 'Open Why? diagnostics tab',
        onSelect: () => setInspectorTab('why'),
      },
      {
        id: 'open-templates',
        group: 'Templates',
        label: 'Open starter templates gallery',
        onSelect: () => setTemplatesOpen(true),
      },
      ...STARTER_TEMPLATES.map((tpl) => ({
        id: `load-template-${tpl.id}`,
        group: 'Templates',
        label: `Load template: ${tpl.title}`,
        onSelect: () => handleLoadTemplate(tpl),
      })),
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
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2 pr-1">
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
              className="h-8 w-40 shrink rounded-[8px] border border-[var(--accent)] bg-[var(--bg-raised)] px-2 text-[13px] font-medium text-[var(--text-primary)] focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Click to rename architecture"
              className="flex h-8 min-w-0 max-w-[176px] shrink items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
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
            onClick={() => setTemplatesOpen(true)}
            title="Starter templates"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <LayoutTemplate className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>Templates</span>
          </button>

          <select
            aria-label="Primary provider"
            value={design.settings.primaryProvider ?? 'aws'}
            onChange={(e) =>
              updateDesignMeta({ settings: { primaryProvider: e.target.value as Provider } })
            }
            className="h-8 shrink-0 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="aws">AWS</option>
            <option value="gcp">GCP</option>
            <option value="azure">Azure</option>
            <option value="oci">OCI</option>
          </select>

          <select
            aria-label="Primary region"
            value={primaryRegion}
            onChange={(e) => setPrimaryRegion(e.target.value)}
            className="hidden h-8 shrink-0 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 font-mono text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none 2xl:block"
          >
            <option value="us-east-1">us-east-1</option>
            <option value="us-west-2">us-west-2</option>
            <option value="eu-central-1">eu-central-1</option>
            <option value="ap-south-1">ap-south-1</option>
          </select>

          {activeScenario ? (
            <div className="relative shrink-0">
              <button
                type="button"
                data-testid="scenario-button"
                onClick={() => setScenarioOpen((prev) => !prev)}
                className="flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 text-[12px] text-[var(--text-primary)] hover:border-[var(--border-strong)]"
              >
                <span className="max-w-[112px] truncate">{activeScenario.name}</span>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">
                  {activeScenario.profile.kind}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
              </button>

              {scenarioOpen ? (
                <div
                  data-testid="scenario-popover"
                  className="absolute left-0 top-10 z-40 w-80 rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-floating)]"
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

                  <TrafficProfileEditor
                    scenario={activeScenario}
                    seed={design.settings.seed}
                    onUpdateScenario={(updater) => updateScenario(activeScenario.id, updater)}
                    onUpdateSeed={(seed) => updateDesignMeta({ settings: { seed } })}
                  />
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

          <div
            title="Monthly estimate activates after price snapshot sync in Phase 2"
            className="flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]"
          >
            <span>$—/mo</span>
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
            <span className="hidden lg:inline">Commands</span>
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
          customServices={design.customServices}
          onAddService={handleAddServiceAtCenter}
          onAddGroup={handleAddGroupAtCenter}
          onRequestCustomService={() =>
            setStatusNotice('Custom service editor arrives in Phase 2 (T2.3)')
          }
        />

        <main className="relative flex min-w-0 flex-1">
          <Canvas
            theme={theme}
            currentFrame={currentFrame}
            nodeReasons={nodeReasons}
            reducedMotion={reducedMotion}
            onInspectNode={handleInspectNode}
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
          className="flex w-80 shrink-0 flex-col border-l border-[var(--border-hairline)] bg-[var(--bg-surface)]"
        >
          <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border-hairline)] px-2 py-2">
            {INSPECTOR_TABS.map((tab) => {
              const active = inspectorTab === tab.id;
              const badgeCount = tab.id === 'why' ? selectedNodeInsightCount : 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`inspector-tab-${tab.id}`}
                  onClick={() => setInspectorTab(tab.id)}
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${
                    active
                      ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <span>{tab.label}</span>
                  {badgeCount > 0 ? (
                    <span className="rounded-full bg-[rgba(229,72,77,0.16)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--status-overloaded)]">
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
                  <span className="shrink-0 rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                    {selectedNodeService?.kind ?? 'node'}
                  </span>
                </div>
              </div>

              {inspectorTab === 'config' ? (
                <ConfigTab
                  node={selectedNode}
                  service={selectedNodeService}
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
                  presets={presets}
                  onUpdateConfig={(updater) => updateNodeConfig(selectedNode.id, updater)}
                  onResetNode={() => resetNodeToDefaults(selectedNode.id)}
                  onSavePreset={addPreset}
                  onApplyPreset={(preset) => applyPresetToNode(selectedNode.id, preset)}
                />
              ) : inspectorTab === 'why' ? (
                <WhyTab
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
              selectedNodeId={selectedNodeId}
              currentTimeS={currentFrame ? currentFrame.tVirtualMs / 1000 : null}
              elapsedWallMs={simElapsedWallMs}
              onSeekToTimeS={seekToTimeS}
              onSelectBottleneck={(nodeId) => handleInspectNode(nodeId, 'why')}
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
        }}
      />
    </div>
  );
}
