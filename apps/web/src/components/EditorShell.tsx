'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Command,
  DollarSign,
  FileCode2,
  FolderOpen,
  HelpCircle,
  Layers,
  Moon,
  Network,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Share2,
  Sliders,
  Sun,
  Terminal,
  Undo2,
  User,
} from 'lucide-react';
import type { GroupInstance, Provider } from '@infrasim/shared-types';
import { Button, Keycap, LogoMark } from '@infrasim/ui-kit';
import { fetchCurrentUser, getStoredToken, setStoredToken, type AuthUser } from '../lib/api';
import {
  loadActiveDesignFromIndexedDb,
  loadPresetsFromIndexedDb,
  saveDesignToIndexedDb,
} from '../lib/autosave';
import { useDesignStore } from '../store/designStore';
import { AccountModal } from './AccountModal';
import { Canvas } from './canvas/Canvas';
import { CommandPalette, type CommandItem } from './CommandPalette';
import { Palette } from './Palette';

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
  const [speed, setSpeed] = useState<'1' | '5' | '20' | 'max'>('1');
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [primaryRegion, setPrimaryRegion] = useState('us-east-1');
  const [editingTitle, setEditingTitle] = useState(false);

  const viewportCenterGetterRef = useRef<() => { x: number; y: number }>(() => ({
    x: 240,
    y: 180,
  }));
  const autosaveHydratedRef = useRef(false);

  const design = useDesignStore((s) => s.design);
  const canUndo = useDesignStore((s) => s.past.length > 0);
  const canRedo = useDesignStore((s) => s.future.length > 0);
  const selectedNodeId = useDesignStore((s) => s.selectedNodeId);
  const selectedGroupId = useDesignStore((s) => s.selectedGroupId);
  const reduceMotionOverride = useDesignStore((s) => s.reduceMotionOverride);

  const loadDesign = useDesignStore((s) => s.loadDesign);
  const setPresets = useDesignStore((s) => s.setPresets);
  const updateDesignMeta = useDesignStore((s) => s.updateDesignMeta);
  const addServiceNode = useDesignStore((s) => s.addServiceNode);
  const addGroup = useDesignStore((s) => s.addGroup);
  const updateGroup = useDesignStore((s) => s.updateGroup);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);

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

  const handleInspectNode = useCallback((_nodeId: string, tab: 'config' | 'latency' | 'why') => {
    setInspectorTab(tab);
  }, []);

  const selectedNode = useMemo(
    () => (selectedNodeId ? (design.nodes.find((n) => n.id === selectedNodeId) ?? null) : null),
    [design.nodes, selectedNodeId],
  );
  const selectedGroup = useMemo(
    () => (selectedGroupId ? (design.groups.find((g) => g.id === selectedGroupId) ?? null) : null),
    [design.groups, selectedGroupId],
  );

  const commands = useMemo<CommandItem[]>(
    () => [
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
        id: 'tab-latency',
        group: 'Inspector',
        label: 'Open Latency & Mock tab',
        onSelect: () => setInspectorTab('latency'),
      },
      {
        id: 'open-account',
        group: 'Account',
        label: user ? 'View account' : 'Sign in or register',
        onSelect: () => setAccountOpen(true),
      },
    ],
    [theme, dockCollapsed, user, undo, redo],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* Top Bar */}
      <header
        data-testid="topbar"
        className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-2 pr-1">
            <LogoMark className="h-5 w-5 text-[var(--text-primary)]" />
            <span className="text-[16px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
              InfraSim
            </span>
          </div>

          <div className="h-4 w-px bg-[var(--border-hairline)]" />

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
              className="h-8 w-44 rounded-[8px] border border-[var(--accent)] bg-[var(--bg-raised)] px-2 text-[13px] font-medium text-[var(--text-primary)] focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Click to rename architecture"
              className="flex h-8 max-w-[200px] items-center gap-2 rounded-[8px] px-2.5 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
              <span className="truncate">{design.name}</span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
                strokeWidth={1.5}
              />
            </button>
          )}

          <select
            aria-label="Primary provider"
            value={design.settings.primaryProvider ?? 'aws'}
            onChange={(e) =>
              updateDesignMeta({ settings: { primaryProvider: e.target.value as Provider } })
            }
            className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
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
            className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 font-mono text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="us-east-1">us-east-1</option>
            <option value="us-west-2">us-west-2</option>
            <option value="eu-central-1">eu-central-1</option>
            <option value="ap-south-1">ap-south-1</option>
          </select>
        </div>

        {/* Center run controls */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-1">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setStatusNotice('Simulation runner activates once T1.5–T1.9 complete')}
              className="h-7 px-3 text-[12px]"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
              Run
            </Button>
            <button
              type="button"
              aria-label="Pause simulation"
              disabled
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] disabled:opacity-40"
            >
              <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Reset simulation"
              disabled
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>

          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(e) => setSpeed(e.target.value as typeof speed)}
            className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="1">1× speed</option>
            <option value="5">5× speed</option>
            <option value="20">20× speed</option>
            <option value="max">Max</option>
          </select>

          <div
            title="Monthly estimate activates after price snapshot sync in Phase 2"
            className="flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 font-mono text-[12px] tabular-nums text-[var(--text-secondary)]"
          >
            <span>$—/mo</span>
          </div>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2">
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
            <span>Commands</span>
            <Keycap>Ctrl+K</Keycap>
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
            reducedMotion={reduceMotionOverride}
            onInspectNode={handleInspectNode}
            onLoadTemplateClick={() =>
              setStatusNotice('Starter 3-tier & Cache templates activate in T1.11')
            }
            registerViewportCenterGetter={(getter) => {
              viewportCenterGetterRef.current = getter;
            }}
          />

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
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setInspectorTab(tab.id)}
                  className={`h-7 shrink-0 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${
                    active
                      ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {tab.label}
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
            <div className="flex-1 p-4 text-[12px]">
              <div className="font-medium text-[var(--text-primary)]">{selectedNode.label}</div>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                {selectedNode.serviceId}
              </div>
              <p className="mt-3 text-[var(--text-secondary)]">
                Full Config & Latency & Mock inspector activates in T1.4.
              </p>
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
          dockCollapsed ? 'h-10' : 'h-52'
        }`}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-3">
          <div className="flex items-center gap-1 overflow-x-auto">
            {DOCK_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = dockTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
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
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-[12px] tabular-nums text-[var(--text-muted)]">
              t = 00:00.0 / 01:00.0
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
          <div className="flex flex-1 items-center justify-center p-4 text-center">
            <p className="text-[12px] text-[var(--text-muted)]">
              Run a simulation to populate {dockTab} telemetry.
            </p>
          </div>
        ) : null}
      </section>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        commands={commands}
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
