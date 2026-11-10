'use client';

import { useEffect, useMemo, useState } from 'react';
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
  Search,
  Share2,
  Sliders,
  Sun,
  Terminal,
  Undo2,
  User,
} from 'lucide-react';
import { Button, Keycap, LogoMark } from '@infrasim/ui-kit';
import { fetchCurrentUser, getStoredToken, setStoredToken, type AuthUser } from '../lib/api';
import { AccountModal } from './AccountModal';
import { CommandPalette, type CommandItem } from './CommandPalette';

type Theme = 'dark' | 'light';
type ProviderTab = 'all' | 'aws' | 'gcp' | 'azure' | 'oci' | 'generic' | 'custom';
type InspectorTab = 'config' | 'latency' | 'code' | 'network' | 'cost' | 'why';
type DockTab = 'metrics' | 'logs' | 'traces' | 'reachability' | 'terraform' | 'cost' | 'insights';

const PROVIDER_TABS: { id: ProviderTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
  { id: 'oci', label: 'OCI' },
  { id: 'generic', label: 'Generic' },
  { id: 'custom', label: 'Custom' },
];

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

/** Top-level InfraSim workbench shell (Phase 0 empty panels + theme + command palette). */
export function EditorShell() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [providerTab, setProviderTab] = useState<ProviderTab>('all');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('config');
  const [dockTab, setDockTab] = useState<DockTab>('metrics');
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState('');
  const [speed, setSpeed] = useState<'1' | '5' | '20' | 'max'>('1');
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

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
  }, []);

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

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: 'toggle-theme',
        group: 'Appearance',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        onSelect: toggleTheme,
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
    [theme, dockCollapsed, user],
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

          <button
            type="button"
            onClick={() => setStatusNotice('Templates and saved designs arrive in Phase 1')}
            className="flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
          >
            <FolderOpen className="h-4 w-4 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span className="truncate">Untitled architecture</span>
            <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
          </button>

          <select
            aria-label="Primary provider"
            defaultValue="aws"
            className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[12px] text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="aws">AWS</option>
            <option value="gcp">GCP</option>
            <option value="azure">Azure</option>
            <option value="oci">OCI</option>
          </select>

          <select
            aria-label="Primary region"
            defaultValue="us-east-1"
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
              onClick={() => setStatusNotice('Simulation runner connects in Phase 1')}
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
              disabled
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] disabled:opacity-40"
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
        {/* Left Palette */}
        <aside
          data-testid="palette-panel"
          className="flex w-64 shrink-0 flex-col border-r border-[var(--border-hairline)] bg-[var(--bg-sunken)]"
        >
          <div className="border-b border-[var(--border-hairline)] p-3">
            <div className="flex h-8 items-center gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5">
              <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
              <input
                type="text"
                value={paletteSearch}
                onChange={(e) => setPaletteSearch(e.target.value)}
                placeholder="Search services"
                className="w-full bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>

            <div className="mt-2 flex flex-wrap gap-1">
              {PROVIDER_TABS.map((tab) => {
                const active = providerTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setProviderTab(tab.id)}
                    className={`h-7 rounded-[6px] px-2 text-[12px] font-medium transition-colors ${
                      active
                        ? 'bg-[var(--bg-raised)] text-[var(--text-primary)] ring-1 ring-[var(--border-strong)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-secondary)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">
              Service catalog empty
            </p>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">
              243 AWS, GCP, Azure, and OCI services will appear here once the catalog builds.
            </p>
          </div>
        </aside>

        {/* Center Canvas */}
        <main
          data-testid="canvas-panel"
          className="canvas-dot-grid relative flex min-w-0 flex-1 flex-col items-center justify-center p-6"
        >
          <div className="max-w-md rounded-[14px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-center shadow-[var(--shadow-floating)]">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--accent)]">
              <LogoMark className="h-5 w-5" />
            </div>
            <h1 className="text-[16px] font-medium text-[var(--text-primary)]">
              Architecture canvas
            </h1>
            <p className="mt-1.5 text-[13px] leading-5 text-[var(--text-secondary)]">
              Workspace shell booted cleanly. Interactive React Flow nodes, edges, and simulated
              load visualization arrive in Phase 1.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setCommandOpen(true)}>
                <span>Open commands</span>
                <Keycap>Ctrl+K</Keycap>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAccountOpen(true)}>
                {user ? `Signed in as ${user.name}` : 'Sign in'}
              </Button>
            </div>
          </div>

          {statusNotice ? (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[8px] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-floating)]">
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

          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <Sliders className="mb-2 h-4 w-4 text-[var(--text-muted)]" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">No node selected</p>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">
              Select a node or edge on the canvas to inspect {inspectorTab} properties.
            </p>
          </div>
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
