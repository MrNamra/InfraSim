'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import {
  AlertTriangle,
  Ban,
  BookmarkPlus,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Info,
  ListChecks,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Sliders,
  Terminal,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  CustomServiceDefinition,
  Design,
  FixtureTemplateId,
  LogEntry,
  NodeConfig,
  NodeInstance,
  PayloadFixture,
  ScriptAsset,
} from '@infrasim/shared-types';
import {
  FIXTURE_TEMPLATES,
  createFixtureFromTemplate,
  generateValueFromSchema,
  validateFixtureEvent,
} from '@infrasim/sandbox/fixtures';
import { analyzeDryRunDiagnostics } from '@infrasim/sandbox/doctor';
import type {
  AutoFillPatchPreview,
  DryRunResult,
  FixtureSuiteReport,
  PayloadDoctorHint,
} from '@infrasim/sandbox';
import { Button } from '@infrasim/ui-kit';
import { createFixtureApi } from '../../lib/api';
import { saveFixtureToIndexedDb } from '../../lib/autosave';
import { getSharedSandboxClient } from '../../lib/sandboxClient';

if (typeof window !== 'undefined') {
  loader.config({ paths: { vs: '/monaco/vs' } });
}

export interface CodeTabProps {
  theme: 'dark' | 'light';
  design: Design;
  node: NodeInstance;
  customServices: CustomServiceDefinition[];
  libraryFixtures: PayloadFixture[];
  token: string | null;
  focusLocation?: { line: number; column: number; nonce: number } | null;
  onUpdateNodeConfig: (updater: (config: NodeConfig) => void) => void;
  onUpsertScript: (script: ScriptAsset) => void;
  onDeleteScript: (scriptId: string) => void;
  onUpsertDesignFixture: (fixture: PayloadFixture) => void;
  onUpsertLibraryFixture: (fixture: PayloadFixture) => void;
  onEditCallMock: (targetNodeId: string | undefined, serviceId: string, opName: string) => void;
  onApplyMockPatches: (patches: readonly AutoFillPatchPreview[]) => Design;
  onRecordDryRunLogs?: (entries: readonly LogEntry[]) => void;
  onOpenNetworkTab?: () => void;
}

const DEFAULT_HANDLER_SOURCE = `// Handler runs inside an isolated QuickJS-WASM sandbox.
// Real AWS / GCP / Azure / OCI SDK imports and cloud.call(...) hit your canvas mocks.
export async function handler(event: Record<string, unknown>) {
  const payload =
    typeof event.body === 'string' && event.body.trim().startsWith('{')
      ? JSON.parse(event.body)
      : event;

  console.log('received request', { path: event.path ?? event.rawPath ?? '/' });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, echo: payload }),
  };
}
`;

const DEFAULT_SCENARIO_SOURCE = `// k6-style traffic generator executed on Client nodes.
export const options = {
  scenarios: {
    browse: { rps: 100, durationS: 60, rampUpS: 5 },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('/items');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
  if (Math.random() < 0.25) {
    http.post('/checkout', { cartSize: 2 });
  }
}
`;

const SANDBOX_AMBIENT_TYPES = `
declare function sleep(ms: number): Promise<void>;
declare const cloud: {
  call<T = Record<string, any>>(
    serviceId: string,
    op: string,
    input?: unknown,
    opts?: { region?: string; alias?: string },
  ): Promise<T>;
  stream<T = unknown>(
    serviceId: string,
    op: string,
    input?: unknown,
    opts?: { region?: string; alias?: string },
  ): AsyncIterable<T>;
};
declare const http: {
  get(url: string, params?: unknown): { status: number; body: string };
  post(url: string, body?: unknown, params?: unknown): { status: number; body: string };
  put(url: string, body?: unknown, params?: unknown): { status: number; body: string };
  del(url: string, body?: unknown, params?: unknown): { status: number; body: string };
  patch(url: string, body?: unknown, params?: unknown): { status: number; body: string };
};
declare function check(res: unknown, checks: Record<string, (r: any) => boolean>): boolean;
declare function group(name: string, fn: () => void): void;
declare const __VU: number;
declare const __ITER: number;
`;

function createScriptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `script-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `script-${Math.random().toString(36).slice(2, 10)}`;
}

function createFixtureId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `fix-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `fix-${Math.random().toString(36).slice(2, 10)}`;
}

function prettyJson(val: unknown): string {
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

/** Lazy-loaded Code & Payload Tester Inspector tab backed by local Monaco + QuickJS-WASM worker. */
export function CodeTab({
  theme,
  design,
  node,
  customServices,
  libraryFixtures,
  token,
  focusLocation,
  onUpdateNodeConfig,
  onUpsertScript,
  onDeleteScript,
  onUpsertDesignFixture,
  onUpsertLibraryFixture,
  onEditCallMock,
  onApplyMockPatches,
  onRecordDryRunLogs,
  onOpenNetworkTab,
}: CodeTabProps) {
  const isClientNode = node.serviceId === 'generic.client';
  const defaultKind: ScriptAsset['kind'] = isClientNode ? 'scenario' : 'handler';
  const attachedScript = useMemo(
    () => design.scripts.find((s) => s.id === node.config.scriptId) ?? null,
    [design.scripts, node.config.scriptId],
  );

  const [editorExpanded, setEditorExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvVal, setNewEnvVal] = useState('');

  // Payload Tester state
  const [selectedFixtureKey, setSelectedFixtureKey] = useState<string>(() => {
    if (design.fixtures[0]) return `design:${design.fixtures[0].id}`;
    return 'template:aws.apigw.proxy.v1';
  });
  const [fixtureNameDraft, setFixtureNameDraft] = useState<string>(() => {
    if (design.fixtures[0]) return design.fixtures[0].name;
    return 'AWS API Gateway REST Proxy (v1)';
  });
  const [fixtureTemplateId, setFixtureTemplateId] = useState<FixtureTemplateId | undefined>(() => {
    if (design.fixtures[0]?.template) return design.fixtures[0].template;
    return 'aws.apigw.proxy.v1';
  });
  const [payloadSubTab, setPayloadSubTab] = useState<'event' | 'schema' | 'suite'>('event');
  const [eventJsonDraft, setEventJsonDraft] = useState<string>(() => {
    const first = design.fixtures[0] ?? createFixtureFromTemplate('aws.apigw.proxy.v1');
    return JSON.stringify(first.event, null, 2);
  });
  const [schemaJsonDraft, setSchemaJsonDraft] = useState<string>(() => {
    const first = design.fixtures[0] ?? createFixtureFromTemplate('aws.apigw.proxy.v1');
    return JSON.stringify(first.schema ?? {}, null, 2);
  });
  const [expectedStatusDraft, setExpectedStatusDraft] = useState<string>(() => {
    const first = design.fixtures[0] ?? createFixtureFromTemplate('aws.apigw.proxy.v1');
    return first.expectedStatus !== undefined ? String(first.expectedStatus) : '';
  });
  const [weightDraft, setWeightDraft] = useState<string>(() => {
    const first = design.fixtures[0] ?? createFixtureFromTemplate('aws.apigw.proxy.v1');
    return String(first.weight ?? 1);
  });

  const [runSeed, setRunSeed] = useState<number>(design.settings.seed ?? 42);
  const [running, setRunning] = useState(false);
  const [autoFillRunning, setAutoFillRunning] = useState(false);
  const [autoFillPatches, setAutoFillPatches] = useState<AutoFillPatchPreview[] | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [suiteReport, setSuiteReport] = useState<FixtureSuiteReport | null>(null);
  const [expandedCalls, setExpandedCalls] = useState<Record<number, boolean>>({});
  const [fixtureNotice, setFixtureNotice] = useState<string | null>(null);

  const monacoRef = useRef<typeof MonacoNs | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    setRunSeed(design.settings.seed ?? 42);
  }, [design.settings.seed]);

  // Reset run panel when switching nodes
  useEffect(() => {
    setDryRunResult(null);
    setSuiteReport(null);
    setAutoFillPatches(null);
    setExpandedCalls({});
  }, [node.id]);

  // Apply external Jump-to-code location
  useEffect(() => {
    if (!focusLocation || !editorRef.current) return;
    const editor = editorRef.current;
    editor.revealLineInCenter(focusLocation.line);
    editor.setPosition({
      lineNumber: Math.max(1, focusLocation.line),
      column: Math.max(1, focusLocation.column),
    });
    editor.focus();
  }, [focusLocation]);

  // Sync error markers onto Monaco model
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;

    const err = dryRunResult?.error;
    if (!err?.site) {
      monaco.editor.setModelMarkers(model, 'infrasim-sandbox', []);
      return;
    }

    const line = Math.max(1, Math.min(model.getLineCount(), err.site.line));
    const col = Math.max(1, err.site.column);
    monaco.editor.setModelMarkers(model, 'infrasim-sandbox', [
      {
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: Math.max(col + 1, model.getLineMaxColumn(line)),
        message: `${err.name}: ${err.message}`,
        severity: monaco.MarkerSeverity.Error,
      },
    ]);
  }, [dryRunResult]);

  const parsedEventState = useMemo(() => {
    try {
      const value = JSON.parse(eventJsonDraft) as unknown;
      return { valid: true as const, value };
    } catch (e) {
      return {
        valid: false as const,
        error: e instanceof Error ? e.message : 'Invalid event JSON',
      };
    }
  }, [eventJsonDraft]);

  const parsedSchemaState = useMemo(() => {
    const trimmed = schemaJsonDraft.trim();
    if (!trimmed || trimmed === '{}') {
      return { valid: true as const, schema: undefined };
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false as const, error: 'Schema must be a JSON object' };
      }
      return { valid: true as const, schema: parsed as Record<string, unknown> };
    } catch (e) {
      return {
        valid: false as const,
        error: e instanceof Error ? e.message : 'Invalid schema JSON',
      };
    }
  }, [schemaJsonDraft]);

  const schemaValidation = useMemo(() => {
    if (!parsedEventState.valid || !parsedSchemaState.valid || !parsedSchemaState.schema) {
      return { valid: true, errors: [] };
    }
    return validateFixtureEvent({
      id: 'draft',
      name: fixtureNameDraft || 'Draft',
      event: parsedEventState.value,
      schema: parsedSchemaState.schema,
    });
  }, [parsedEventState, parsedSchemaState, fixtureNameDraft]);

  const handleCreateAndAttachScript = useCallback(() => {
    const id = createScriptId();
    const isScenario = defaultKind === 'scenario';
    const nextScript: ScriptAsset = {
      id,
      name: isScenario
        ? 'scenario.ts'
        : `${node.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'handler'}.ts`,
      kind: defaultKind,
      language: 'typescript',
      entry: isScenario ? 'default' : 'handler',
      source: isScenario ? DEFAULT_SCENARIO_SOURCE : DEFAULT_HANDLER_SOURCE,
      memoryMb: 128,
      timeoutMs: 3000,
      env: {},
    };
    onUpsertScript(nextScript);
    onUpdateNodeConfig((cfg) => {
      cfg.scriptId = id;
    });
  }, [defaultKind, node.label, onUpsertScript, onUpdateNodeConfig]);

  const handleSelectExistingScript = useCallback(
    (scriptId: string) => {
      onUpdateNodeConfig((cfg) => {
        if (!scriptId) {
          delete cfg.scriptId;
        } else {
          cfg.scriptId = scriptId;
        }
      });
    },
    [onUpdateNodeConfig],
  );

  const handleSelectFixtureOption = useCallback(
    (key: string) => {
      setSelectedFixtureKey(key);
      let chosen: PayloadFixture | undefined;
      if (key.startsWith('design:')) {
        const id = key.slice('design:'.length);
        chosen = design.fixtures.find((f) => f.id === id);
      } else if (key.startsWith('library:')) {
        const id = key.slice('library:'.length);
        chosen = libraryFixtures.find((f) => f.id === id);
      } else if (key.startsWith('template:')) {
        const tplId = key.slice('template:'.length) as FixtureTemplateId;
        chosen = createFixtureFromTemplate(tplId);
      }
      if (!chosen) return;
      setFixtureNameDraft(chosen.name);
      setFixtureTemplateId(chosen.template);
      setEventJsonDraft(JSON.stringify(chosen.event, null, 2));
      setSchemaJsonDraft(JSON.stringify(chosen.schema ?? {}, null, 2));
      setExpectedStatusDraft(
        chosen.expectedStatus !== undefined ? String(chosen.expectedStatus) : '',
      );
      setWeightDraft(String(chosen.weight ?? 1));
      setFixtureNotice(null);
    },
    [design.fixtures, libraryFixtures],
  );

  const buildActiveFixture = useCallback((): PayloadFixture => {
    const parsedExp = expectedStatusDraft.trim() ? Number(expectedStatusDraft) : undefined;
    const parsedWeight = Number(weightDraft);
    const id = selectedFixtureKey.startsWith('design:')
      ? selectedFixtureKey.slice('design:'.length)
      : createFixtureId();
    return {
      id,
      name: fixtureNameDraft.trim() || 'Custom payload',
      ...(fixtureTemplateId ? { template: fixtureTemplateId } : {}),
      event: parsedEventState.valid ? parsedEventState.value : {},
      ...(parsedSchemaState.valid && parsedSchemaState.schema
        ? { schema: parsedSchemaState.schema }
        : {}),
      ...(parsedExp !== undefined && Number.isFinite(parsedExp)
        ? { expectedStatus: parsedExp }
        : {}),
      weight: Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : 1,
    };
  }, [
    expectedStatusDraft,
    weightDraft,
    selectedFixtureKey,
    fixtureNameDraft,
    fixtureTemplateId,
    parsedEventState,
    parsedSchemaState,
  ]);

  const handleRunDryRun = useCallback(
    async (
      seedToUse: number,
      overrides?: { design?: Design; node?: NodeInstance; script?: ScriptAsset },
    ) => {
      const targetDesign = overrides?.design ?? design;
      const targetNode =
        overrides?.node ?? targetDesign.nodes.find((n) => n.id === node.id) ?? node;
      const targetScript = overrides?.script ?? attachedScript;
      if (!targetScript) return;
      if (!parsedEventState.valid) {
        setFixtureNotice('Fix JSON syntax error in event payload before running');
        return;
      }
      setRunning(true);
      setFixtureNotice(null);
      try {
        const client = getSharedSandboxClient();
        const activeFixture = buildActiveFixture();
        const result = await client.dryRun({
          script: targetScript,
          designScripts: targetDesign.scripts,
          fixture: activeFixture,
          event: activeFixture.event,
          design: targetDesign,
          node: targetNode,
          customServices,
          seed: seedToUse,
          seq: seedToUse,
        });
        setDryRunResult(result);
        setPayloadSubTab('event');
        if (result.logs.length > 0) {
          onRecordDryRunLogs?.(result.logs);
        }
      } finally {
        setRunning(false);
      }
    },
    [
      attachedScript,
      parsedEventState.valid,
      buildActiveFixture,
      design,
      node,
      customServices,
      onRecordDryRunLogs,
    ],
  );

  const handleRunAutoFill = useCallback(async () => {
    if (!attachedScript) return;
    if (!parsedEventState.valid) {
      setFixtureNotice('Fix JSON syntax error in event payload before scanning mocks');
      return;
    }
    setAutoFillRunning(true);
    setFixtureNotice(null);
    try {
      const client = getSharedSandboxClient();
      const activeFixture = buildActiveFixture();
      const report = await client.autoFill({
        script: attachedScript,
        designScripts: design.scripts,
        fixture: activeFixture,
        event: activeFixture.event,
        design,
        node,
        customServices,
        seed: runSeed,
        seq: runSeed,
      });
      if (report.patches.length === 0) {
        setAutoFillPatches(null);
        const totalCalls = report.discoveryResult.calls.length;
        setFixtureNotice(
          totalCalls === 0
            ? 'No downstream mock calls executed during discovery.'
            : 'All accessed mock fields already exist in your configured mocks.',
        );
      } else {
        setAutoFillPatches(report.patches);
      }
    } finally {
      setAutoFillRunning(false);
    }
  }, [
    attachedScript,
    parsedEventState.valid,
    buildActiveFixture,
    design,
    node,
    customServices,
    runSeed,
  ]);

  const handleApplyAutoFillAndRerun = useCallback(async () => {
    if (!autoFillPatches || autoFillPatches.length === 0) return;
    const nextDesign = onApplyMockPatches(autoFillPatches);
    setAutoFillPatches(null);
    await handleRunDryRun(runSeed, { design: nextDesign });
  }, [autoFillPatches, onApplyMockPatches, handleRunDryRun, runSeed]);

  const diagnostics = useMemo(() => {
    if (!dryRunResult || !attachedScript) return [];
    return analyzeDryRunDiagnostics({
      result: dryRunResult,
      script: attachedScript,
      event: parsedEventState.valid ? parsedEventState.value : {},
      templateId: fixtureTemplateId,
      node,
    });
  }, [dryRunResult, attachedScript, parsedEventState, fixtureTemplateId, node]);

  const handleApplyDoctorFix = useCallback(
    async (hint: PayloadDoctorHint) => {
      if (!attachedScript) return;
      if (hint.actionKind === 'auto-fill-mock') {
        await handleRunAutoFill();
        return;
      }
      if (hint.actionKind === 'add-edge') {
        onOpenNetworkTab?.();
        return;
      }
      if (hint.actionKind === 'patch-source' && hint.patchedSource) {
        const nextScript: ScriptAsset = {
          ...attachedScript,
          source: hint.patchedSource,
        };
        onUpsertScript(nextScript);
        await handleRunDryRun(runSeed, { script: nextScript });
        return;
      }
      if (hint.actionKind === 'increase-timeout') {
        const nextTimeout = Math.min(
          900_000,
          Math.max(attachedScript.timeoutMs * 2, attachedScript.timeoutMs + 3000),
        );
        const nextScript: ScriptAsset = {
          ...attachedScript,
          timeoutMs: nextTimeout,
        };
        onUpsertScript(nextScript);
        await handleRunDryRun(runSeed, { script: nextScript });
        return;
      }
      if (hint.actionKind === 'add-env' && hint.envKey) {
        const key = hint.envKey;
        const nextNode: NodeInstance = {
          ...node,
          config: {
            ...node.config,
            mockEnv: {
              ...(node.config.mockEnv ?? {}),
              [key]: node.config.mockEnv?.[key] || 'mock-value',
            },
          },
        };
        onUpdateNodeConfig((cfg) => {
          cfg.mockEnv = {
            ...(cfg.mockEnv ?? {}),
            [key]: cfg.mockEnv?.[key] || 'mock-value',
          };
        });
        setShowSettings(true);
        setFixtureNotice(`Added ${key} in node environment settings`);
        await handleRunDryRun(runSeed, { node: nextNode });
      }
    },
    [
      attachedScript,
      handleRunAutoFill,
      onOpenNetworkTab,
      onUpsertScript,
      handleRunDryRun,
      runSeed,
      node,
      onUpdateNodeConfig,
    ],
  );

  const handleRunAllFixtures = useCallback(async () => {
    if (!attachedScript) return;
    const pool: PayloadFixture[] =
      design.fixtures.length > 0 ? design.fixtures : [buildActiveFixture()];
    setRunning(true);
    setFixtureNotice(null);
    try {
      const client = getSharedSandboxClient();
      const report = await client.runSuite({
        script: attachedScript,
        fixtures: pool,
        designScripts: design.scripts,
        design,
        node,
        customServices,
        seed: runSeed,
      });
      setSuiteReport(report);
      setPayloadSubTab('suite');
    } finally {
      setRunning(false);
    }
  }, [attachedScript, design, buildActiveFixture, customServices, node, runSeed]);

  const handleGenerateFromSchema = useCallback(() => {
    const nextSeed = runSeed + 1;
    setRunSeed(nextSeed);
    const schema = parsedSchemaState.valid ? parsedSchemaState.schema : undefined;
    const generated = generateValueFromSchema(schema, nextSeed);
    setEventJsonDraft(JSON.stringify(generated, null, 2));
    setFixtureNotice(`Generated payload from schema (seed ${nextSeed})`);
  }, [runSeed, parsedSchemaState]);

  const handleSaveAsFixture = useCallback(async () => {
    if (!parsedEventState.valid) {
      setFixtureNotice('Fix invalid JSON before saving fixture');
      return;
    }
    const base = buildActiveFixture();
    const saved: PayloadFixture = {
      ...base,
      id: selectedFixtureKey.startsWith('design:') ? base.id : createFixtureId(),
    };
    onUpsertDesignFixture(saved);
    onUpsertLibraryFixture(saved);
    void saveFixtureToIndexedDb(saved);
    setSelectedFixtureKey(`design:${saved.id}`);

    if (token) {
      try {
        await createFixtureApi(token, saved);
        setFixtureNotice(`Saved "${saved.name}" to design and account library`);
        return;
      } catch {
        // Offline fallback notice below
      }
    }
    setFixtureNotice(`Saved "${saved.name}" to design and local library`);
  }, [
    parsedEventState.valid,
    buildActiveFixture,
    selectedFixtureKey,
    onUpsertDesignFixture,
    onUpsertLibraryFixture,
    token,
  ]);

  const handleMonacoMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco as unknown as typeof MonacoNs;
    editorRef.current = editor;
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowJs: true,
      noEmit: true,
    });
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    const libUri = 'ts:filename/infrasim-globals.d.ts';
    if (!monaco.editor.getModel(monaco.Uri.parse(libUri))) {
      monaco.languages.typescript.typescriptDefaults.addExtraLib(SANDBOX_AMBIENT_TYPES, libUri);
    }
    if (focusLocation) {
      editor.revealLineInCenter(focusLocation.line);
      editor.setPosition({
        lineNumber: Math.max(1, focusLocation.line),
        column: Math.max(1, focusLocation.column),
      });
    }
  };

  const jumpToEditorLine = (line: number, column = 1) => {
    if (!editorRef.current) return;
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column });
    editorRef.current.focus();
  };

  const statusMeta = useMemo(() => {
    if (!dryRunResult) return null;
    if (dryRunResult.ok) {
      return {
        label: 'Succeeded',
        icon: CheckCircle2,
        toneClass:
          'border-[rgba(76,195,138,0.35)] bg-[rgba(76,195,138,0.08)] text-[var(--status-ok)]',
      };
    }
    const cat = dryRunResult.error?.category;
    if (cat === 'Timeout') {
      return {
        label: 'Timeout',
        icon: Clock,
        toneClass:
          'border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] text-[var(--status-warm)]',
      };
    }
    if (
      dryRunResult.error?.statusCode === 429 ||
      dryRunResult.error?.name === 'ThrottlingException'
    ) {
      return {
        label: 'Throttled',
        icon: Ban,
        toneClass:
          'border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] text-[var(--status-warm)]',
      };
    }
    return {
      label: cat ?? 'Error',
      icon: XCircle,
      toneClass:
        'border-[rgba(229,72,77,0.35)] bg-[rgba(229,72,77,0.08)] text-[var(--status-overloaded)]',
    };
  }, [dryRunResult]);

  if (!attachedScript) {
    return (
      <div className="space-y-4 p-4 text-[12px]" data-testid="code-tab-empty">
        <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
            <Code2 className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.5} />
            <span>{isClientNode ? 'Attach a traffic script' : 'Attach a handler script'}</span>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-[var(--text-secondary)]">
            {isClientNode
              ? 'Write a k6-style traffic script to generate user journeys and evaluate latency or error thresholds.'
              : 'Attach JavaScript or TypeScript handler code. Cloud SDK imports route through your canvas mocks inside an isolated sandbox.'}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="new-script-btn"
              onClick={handleCreateAndAttachScript}
              className="h-8 px-3 text-[12px]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span>{isClientNode ? 'New traffic script' : 'New handler script'}</span>
            </Button>

            {design.scripts.length > 0 ? (
              <select
                aria-label="Attach existing script"
                value=""
                onChange={(e) => handleSelectExistingScript(e.target.value)}
                className="h-8 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              >
                <option value="">Attach existing script</option>
                {design.scripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.kind})
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-4 p-3 text-[12px]" data-testid="code-tab-panel">
      {/* Script selector & quick actions */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <select
            aria-label="Active node script"
            data-testid="script-selector"
            value={attachedScript.id}
            onChange={(e) => handleSelectExistingScript(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          >
            {design.scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.language === 'typescript' ? 'TS' : 'JS'})
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Create new script"
            onClick={handleCreateAndAttachScript}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            title="Script settings and environment variables"
            onClick={() => setShowSettings((v) => !v)}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
              showSettings
                ? 'border-[var(--accent)] bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Settings2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            title={editorExpanded ? 'Compact editor height' : 'Expand editor height'}
            onClick={() => setEditorExpanded((v) => !v)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {editorExpanded ? (
              <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            title="Delete script"
            onClick={() => onDeleteScript(attachedScript.id)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>

        {showSettings ? (
          <div className="space-y-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Filename</span>
                <input
                  type="text"
                  value={attachedScript.name}
                  onChange={(e) => onUpsertScript({ ...attachedScript, name: e.target.value })}
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Language</span>
                <select
                  value={attachedScript.language}
                  onChange={(e) =>
                    onUpsertScript({
                      ...attachedScript,
                      language: e.target.value === 'javascript' ? 'javascript' : 'typescript',
                    })
                  }
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-primary)]"
                >
                  <option value="typescript">TypeScript</option>
                  <option value="javascript">JavaScript</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Timeout (ms)</span>
                <input
                  type="number"
                  min={50}
                  max={900000}
                  value={attachedScript.timeoutMs}
                  onChange={(e) =>
                    onUpsertScript({
                      ...attachedScript,
                      timeoutMs: Math.max(50, Number(e.target.value) || 3000),
                    })
                  }
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Memory (MB)</span>
                <input
                  type="number"
                  min={16}
                  max={512}
                  value={attachedScript.memoryMb}
                  onChange={(e) =>
                    onUpsertScript({
                      ...attachedScript,
                      memoryMb: Math.min(512, Math.max(16, Number(e.target.value) || 128)),
                    })
                  }
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            </div>

            <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Node environment variables
              </div>
              {Object.entries(node.config.mockEnv ?? {}).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span className="w-24 truncate font-mono text-[11px] text-[var(--text-secondary)]">
                    {k}
                  </span>
                  <input
                    type="text"
                    value={v}
                    onChange={(e) =>
                      onUpdateNodeConfig((cfg) => {
                        if (!cfg.mockEnv) cfg.mockEnv = {};
                        cfg.mockEnv[k] = e.target.value;
                      })
                    }
                    className="h-7 flex-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${k}`}
                    onClick={() =>
                      onUpdateNodeConfig((cfg) => {
                        if (cfg.mockEnv) {
                          delete cfg.mockEnv[k];
                        }
                      })
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  placeholder="KEY"
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
                  className="h-7 w-24 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                />
                <input
                  type="text"
                  placeholder="value"
                  value={newEnvVal}
                  onChange={(e) => setNewEnvVal(e.target.value)}
                  className="h-7 flex-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const key = newEnvKey.trim();
                    if (!key) return;
                    onUpdateNodeConfig((cfg) => {
                      cfg.mockEnv = { ...(cfg.mockEnv ?? {}), [key]: newEnvVal };
                    });
                    setNewEnvKey('');
                    setNewEnvVal('');
                  }}
                  className="h-7 px-2 text-[11px]"
                >
                  Add
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Monaco Code Editor */}
        <div
          data-testid="code-editor-container"
          className={`overflow-hidden rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] ${
            editorExpanded ? 'h-96' : 'h-56'
          }`}
        >
          <Editor
            height="100%"
            language={attachedScript.language}
            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
            value={attachedScript.source}
            onMount={handleMonacoMount}
            onChange={(val) => {
              onUpsertScript({
                ...attachedScript,
                source: val ?? '',
              });
            }}
            loading={
              <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-muted)]">
                Loading editor
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
      </section>

      {/* Payload Tester */}
      {!isClientNode ? (
        <section className="space-y-3 border-t border-[var(--border-hairline)] pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--text-primary)]">
              Payload tester
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
              Seed {runSeed}
            </span>
          </div>

          <div className="space-y-2">
            <label className="block">
              <span className="text-[11px] text-[var(--text-secondary)]">Fixture preset</span>
              <select
                aria-label="Test payload fixture"
                data-testid="fixture-selector"
                value={selectedFixtureKey}
                onChange={(e) => handleSelectFixtureOption(e.target.value)}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              >
                {design.fixtures.length > 0 ? (
                  <optgroup label="Design fixtures">
                    {design.fixtures.map((f) => (
                      <option key={f.id} value={`design:${f.id}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {libraryFixtures.length > 0 ? (
                  <optgroup label="My fixture library">
                    {libraryFixtures.map((f) => (
                      <option key={f.id} value={`library:${f.id}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="Provider event templates (17)">
                  {FIXTURE_TEMPLATES.map((t) => (
                    <option key={t.id} value={`template:${t.id}`}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>

            {/* Sub-tabs: Event / Schema / Suite */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-[6px] bg-[var(--bg-sunken)] p-0.5">
                {(['event', 'schema', 'suite'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setPayloadSubTab(tab)}
                    className={`h-6 rounded-[4px] px-2 text-[11px] font-medium capitalize transition-colors ${
                      payloadSubTab === tab
                        ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}
                  >
                    {tab === 'event' ? 'Event JSON' : tab === 'schema' ? 'Schema' : 'Suite'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-testid="generate-from-schema-btn"
                onClick={handleGenerateFromSchema}
                className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
                <span>Generate from schema</span>
              </button>
            </div>

            {payloadSubTab === 'event' ? (
              <div className="space-y-1.5">
                <textarea
                  aria-label="Fixture event JSON"
                  data-testid="fixture-event-editor"
                  rows={6}
                  value={eventJsonDraft}
                  onChange={(e) => setEventJsonDraft(e.target.value)}
                  className="w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                {!parsedEventState.valid ? (
                  <p className="text-[11px] text-[var(--status-overloaded)]">
                    {parsedEventState.error}
                  </p>
                ) : !schemaValidation.valid ? (
                  <div className="space-y-0.5 text-[11px] text-[var(--status-warm)]">
                    {schemaValidation.errors.slice(0, 4).map((e) => (
                      <div key={`${e.path}:${e.message}`}>
                        {e.path}: {e.message}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : payloadSubTab === 'schema' ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Fixture name</span>
                    <input
                      type="text"
                      value={fixtureNameDraft}
                      onChange={(e) => setFixtureNameDraft(e.target.value)}
                      className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[11px] text-[var(--text-primary)]"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-muted)]">Exp status</span>
                      <input
                        type="number"
                        placeholder="200"
                        value={expectedStatusDraft}
                        onChange={(e) => setExpectedStatusDraft(e.target.value)}
                        className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-muted)]">Weight</span>
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={weightDraft}
                        onChange={(e) => setWeightDraft(e.target.value)}
                        className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                  </div>
                </div>
                <textarea
                  aria-label="Fixture JSON Schema"
                  rows={5}
                  value={schemaJsonDraft}
                  onChange={(e) => setSchemaJsonDraft(e.target.value)}
                  className="w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                {!parsedSchemaState.valid ? (
                  <p className="text-[11px] text-[var(--status-overloaded)]">
                    {parsedSchemaState.error}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2">
                {suiteReport ? (
                  <>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-[var(--text-primary)]">
                        Fixture suite: {suiteReport.passed}/{suiteReport.total} passed
                      </span>
                      <span className="font-mono tabular-nums text-[var(--text-muted)]">
                        {suiteReport.failed} failed
                      </span>
                    </div>
                    <div className="space-y-1">
                      {suiteReport.results.map((item) => (
                        <div
                          key={item.fixtureId}
                          className="flex items-center justify-between rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-[11px] font-medium text-[var(--text-primary)]">
                              {item.fixtureName}
                            </div>
                            {item.reason ? (
                              <div className="truncate text-[10px] text-[var(--status-overloaded)]">
                                {item.reason}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                            {item.actualStatus !== undefined ? (
                              <span className="text-[var(--text-secondary)]">
                                {item.actualStatus}
                              </span>
                            ) : null}
                            {item.passed ? (
                              <CheckCircle2
                                className="h-3.5 w-3.5 text-[var(--status-ok)]"
                                strokeWidth={1.5}
                              />
                            ) : (
                              <XCircle
                                className="h-3.5 w-3.5 text-[var(--status-overloaded)]"
                                strokeWidth={1.5}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="py-2 text-center text-[11px] text-[var(--text-muted)]">
                    Click Run all fixtures to test every fixture against this handler
                  </p>
                )}
              </div>
            )}

            {/* Primary action bar */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="primary"
                size="sm"
                data-testid="dry-run-btn"
                disabled={running}
                onClick={() => void handleRunDryRun(runSeed)}
                className="h-8 px-3 text-[12px]"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>{running ? 'Running' : 'Run'}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="dry-run-reseed-btn"
                disabled={running}
                onClick={() => {
                  const next = runSeed + 1;
                  setRunSeed(next);
                  void handleRunDryRun(next);
                }}
                className="h-8 px-2.5 text-[11px]"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
                <span>Run again (new seed)</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="run-all-fixtures-btn"
                disabled={running}
                onClick={() => void handleRunAllFixtures()}
                className="h-8 px-2.5 text-[11px]"
              >
                <ListChecks className="h-3 w-3" strokeWidth={1.5} />
                <span>Run all fixtures</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="auto-fill-mocks-btn"
                disabled={running || autoFillRunning}
                onClick={() => void handleRunAutoFill()}
                className="h-8 px-2.5 text-[11px]"
              >
                <Wrench className="h-3 w-3" strokeWidth={1.5} />
                <span>{autoFillRunning ? 'Scanning mocks' : 'Auto-fill mocks'}</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="save-fixture-btn"
                onClick={() => void handleSaveAsFixture()}
                className="h-8 px-2.5 text-[11px]"
              >
                <BookmarkPlus className="h-3 w-3" strokeWidth={1.5} />
                <span>Save as fixture</span>
              </Button>
            </div>

            {fixtureNotice ? (
              <p className="text-[11px] text-[var(--text-secondary)]">{fixtureNotice}</p>
            ) : null}

            {/* Auto-fill diff preview card */}
            {autoFillPatches && autoFillPatches.length > 0 ? (
              <div
                data-testid="autofill-preview"
                className="space-y-3 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[12px] font-medium text-[var(--text-primary)]">
                      Auto-fill mock updates ({autoFillPatches.length})
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)]">
                      Review discovered response fields before updating downstream mock templates.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAutoFillPatches(null)}
                    className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    Dismiss
                  </button>
                </div>

                <div className="space-y-2">
                  {autoFillPatches.map((patch) => {
                    const targetNode = patch.targetNodeId
                      ? design.nodes.find((n) => n.id === patch.targetNodeId)
                      : design.nodes.find((n) => n.serviceId === patch.serviceId);
                    return (
                      <div
                        key={`${patch.serviceId}:${patch.op}:${patch.targetNodeId ?? 'default'}`}
                        className="space-y-2 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                            {targetNode ? `${targetNode.label} · ` : ''}
                            {patch.serviceId}.{patch.op}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            {patch.accessedPaths.length} fields
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {patch.accessedPaths.map((pathItem) => (
                            <span
                              key={pathItem}
                              className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
                            >
                              {pathItem}
                            </span>
                          ))}
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                          <div>
                            <div className="text-[10px] text-[var(--text-muted)]">Before</div>
                            <pre className="mt-0.5 max-h-24 overflow-auto rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-1.5 font-mono text-[10px] text-[var(--text-secondary)]">
                              {patch.beforeTemplate}
                            </pre>
                          </div>
                          <div>
                            <div className="text-[10px] text-[var(--status-ok)]">After</div>
                            <pre className="mt-0.5 max-h-32 overflow-auto rounded-[5px] border border-[rgba(76,195,138,0.35)] bg-[var(--bg-sunken)] p-1.5 font-mono text-[10px] text-[var(--text-primary)]">
                              {patch.afterTemplate}
                            </pre>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setAutoFillPatches(null)}
                    className="h-7 px-2.5 text-[11px]"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="autofill-apply-rerun-btn"
                    disabled={running}
                    onClick={() => void handleApplyAutoFillAndRerun()}
                    className="h-7 px-3 text-[11px]"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>Apply & re-run</span>
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Dry Run Output */}
          {dryRunResult && statusMeta ? (
            <div className="space-y-3" data-testid="dry-run-output">
              {/* Status banner */}
              <div
                data-testid="dry-run-status-banner"
                className={`rounded-[8px] border p-2.5 ${statusMeta.toneClass}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium">
                    <statusMeta.icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                    <span>{statusMeta.label}</span>
                  </div>
                  <div className="font-mono text-[11px] tabular-nums">
                    {dryRunResult.virtualDurationMs.toFixed(1)} ms virtual ·{' '}
                    {dryRunResult.billedDurationMs} ms billed
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] opacity-90">
                  <span>
                    Memory {(dryRunResult.memoryPeakBytes / (1024 * 1024)).toFixed(1)} /{' '}
                    {attachedScript.memoryMb} MB (est)
                  </span>
                  <span className="font-mono tabular-nums">
                    CPU {dryRunResult.guestCpuMs.toFixed(1)} ms
                  </span>
                </div>
                {dryRunResult.error ? (
                  <div className="mt-2 space-y-1.5 border-t border-current/20 pt-2 text-[var(--text-primary)]">
                    <div className="font-mono text-[11px]">
                      {dryRunResult.error.name}: {dryRunResult.error.message}
                    </div>
                    {dryRunResult.error.site ? (
                      <button
                        type="button"
                        onClick={() =>
                          jumpToEditorLine(
                            dryRunResult.error!.site!.line,
                            dryRunResult.error!.site!.column,
                          )
                        }
                        className="font-mono text-[11px] text-[var(--accent)] hover:underline"
                      >
                        Jump to {dryRunResult.error.site.file ?? attachedScript.name}:
                        {dryRunResult.error.site.line}:{dryRunResult.error.site.column}
                      </button>
                    ) : null}
                    {dryRunResult.error.category === 'MockNotConfigured' && onOpenNetworkTab ? (
                      <div>
                        <button
                          type="button"
                          onClick={onOpenNetworkTab}
                          className="text-[11px] font-medium text-[var(--accent)] hover:underline"
                        >
                          Add service or edge to enable mock
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* Payload Doctor Diagnostics */}
              {diagnostics.length > 0 ? (
                <div className="space-y-1.5" data-testid="payload-doctor-diagnostics">
                  <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Diagnostics ({diagnostics.length})
                  </div>
                  <div className="space-y-1.5">
                    {diagnostics.map((hint) => {
                      const HintIcon =
                        hint.severity === 'error'
                          ? XCircle
                          : hint.severity === 'warn'
                            ? AlertTriangle
                            : Info;
                      const hintTone =
                        hint.severity === 'error'
                          ? 'border-[rgba(229,72,77,0.35)] bg-[rgba(229,72,77,0.06)]'
                          : hint.severity === 'warn'
                            ? 'border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.06)]'
                            : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)]';
                      const iconColor =
                        hint.severity === 'error'
                          ? 'text-[var(--status-overloaded)]'
                          : hint.severity === 'warn'
                            ? 'text-[var(--status-warm)]'
                            : 'text-[var(--text-secondary)]';
                      return (
                        <div
                          key={hint.ruleId}
                          data-testid={`doctor-hint-${hint.ruleId}`}
                          className={`rounded-[6px] border p-2.5 ${hintTone}`}
                        >
                          <div className="flex items-start gap-2">
                            <HintIcon
                              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${iconColor}`}
                              strokeWidth={1.5}
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="text-[11px] font-medium text-[var(--text-primary)]">
                                {hint.title}
                              </div>
                              <p className="text-[11px] leading-4 text-[var(--text-secondary)]">
                                {hint.message}
                              </p>
                              {hint.actionLabel ? (
                                <div className="pt-0.5">
                                  <button
                                    type="button"
                                    data-testid={`doctor-fix-${hint.ruleId}`}
                                    disabled={running || autoFillRunning}
                                    onClick={() => void handleApplyDoctorFix(hint)}
                                    className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:border-[var(--border-strong)]"
                                  >
                                    {hint.actionLabel}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Result JSON */}
              {dryRunResult.ok ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                      Result
                    </span>
                    {dryRunResult.httpStatus !== undefined ? (
                      <span className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-primary)]">
                        HTTP {dryRunResult.httpStatus}
                      </span>
                    ) : null}
                  </div>
                  <pre
                    data-testid="dry-run-result-json"
                    className="max-h-40 overflow-auto rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[11px] text-[var(--text-primary)]"
                  >
                    {prettyJson(dryRunResult.result)}
                  </pre>
                </div>
              ) : null}

              {/* Console & platform logs */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                  <Terminal className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>Logs ({dryRunResult.logs.length})</span>
                </div>
                {dryRunResult.logs.length > 0 ? (
                  <div
                    data-testid="dry-run-logs-list"
                    className="max-h-40 space-y-1 overflow-y-auto rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[10px]"
                  >
                    {dryRunResult.logs.map((entry) => (
                      <div key={entry.id} className="flex items-start gap-1.5 leading-4">
                        <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                          {entry.tVirtualMs.toFixed(0)}ms
                        </span>
                        <span
                          className={`shrink-0 uppercase ${
                            entry.level === 'error'
                              ? 'text-[var(--status-overloaded)]'
                              : entry.level === 'warn'
                                ? 'text-[var(--status-warm)]'
                                : 'text-[var(--text-secondary)]'
                          }`}
                        >
                          {entry.level}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">
                          {entry.message}
                        </span>
                        {entry.site ? (
                          <button
                            type="button"
                            onClick={() => jumpToEditorLine(entry.site!.line, entry.site!.col)}
                            className="shrink-0 text-[var(--accent)] hover:underline"
                          >
                            :{entry.site.line}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                    No log lines recorded
                  </div>
                )}
              </div>

              {/* Detected calls table */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                  <Sliders className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>Detected calls ({dryRunResult.calls.length})</span>
                </div>
                {dryRunResult.calls.length > 0 ? (
                  <div className="space-y-1" data-testid="dry-run-calls-list">
                    {dryRunResult.calls.map((call) => {
                      const open = Boolean(expandedCalls[call.index]);
                      return (
                        <div
                          key={call.index}
                          className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedCalls((prev) => ({
                                  ...prev,
                                  [call.index]: !open,
                                }))
                              }
                              className="flex min-w-0 flex-1 items-center gap-1 text-left"
                            >
                              {open ? (
                                <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                              ) : (
                                <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                              )}
                              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                                #{call.index}
                              </span>
                              <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">
                                {call.serviceId}.{call.op}
                              </span>
                            </button>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span
                                className={`font-mono text-[10px] tabular-nums ${
                                  call.error
                                    ? 'text-[var(--status-overloaded)]'
                                    : 'text-[var(--status-ok)]'
                                }`}
                              >
                                {call.error ? (call.error.statusCode ?? 'ERR') : 'OK'}
                              </span>
                              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                                {call.latencyMs.toFixed(0)}ms
                              </span>
                              <button
                                type="button"
                                data-testid={`edit-call-mock-${call.index}`}
                                onClick={() =>
                                  onEditCallMock(call.targetNodeId, call.serviceId, call.op)
                                }
                                className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)] hover:border-[var(--border-strong)]"
                              >
                                Edit mock
                              </button>
                            </div>
                          </div>
                          {open ? (
                            <div className="mt-2 space-y-1 border-t border-[var(--border-hairline)] pt-2 font-mono text-[10px]">
                              <div>
                                <div className="text-[var(--text-muted)]">Input</div>
                                <pre className="max-h-24 overflow-auto text-[var(--text-secondary)]">
                                  {prettyJson(call.input)}
                                </pre>
                              </div>
                              <div>
                                <div className="text-[var(--text-muted)]">
                                  {call.error ? 'Error' : 'Output'}
                                </div>
                                <pre className="max-h-24 overflow-auto text-[var(--text-secondary)]">
                                  {prettyJson(call.error ?? call.output)}
                                </pre>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                    No downstream SDK or HTTP calls captured
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
