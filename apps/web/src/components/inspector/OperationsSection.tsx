'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  LatencyModel,
  NodeConfig,
  NodeInstance,
  OperationDef,
  OperationOverride,
  ServiceDefinition,
} from '@infrasim/shared-types';
import {
  type MockOperationPreview,
  renderMockOperationPreview,
  validateJsonSchemaDefinition,
  validateJsonSchemaValue,
  validateResponseTemplate,
} from '@infrasim/catalog';
import { Button } from '@infrasim/ui-kit';
import { validateErrorRatePercent, validateLatencyInput } from '../../lib/inspectorValidation';

export interface OperationsSectionProps {
  node: NodeInstance;
  service?: ServiceDefinition;
  seed: number;
  onUpdateConfig: (updater: (config: NodeConfig) => void) => void;
}

const ERROR_KINDS: NonNullable<OperationOverride['errorKind']>[] = [
  'throttle',
  'timeout',
  'server',
  'not_found',
  'access_denied',
  'validation',
];

function isOperationEdited(override: OperationOverride | undefined): boolean {
  if (!override) return false;
  return (
    override.latency !== undefined ||
    override.statusCode !== undefined ||
    override.headers !== undefined ||
    override.responseTemplate !== undefined ||
    override.responseSizeBytes !== undefined ||
    override.errorRate !== undefined ||
    override.errorKind !== undefined ||
    override.inputSchema !== undefined
  );
}

interface OperationCardProps {
  op: OperationDef;
  override: OperationOverride | undefined;
  nodeLatency: LatencyModel;
  nodeErrorRate: number;
  mockEnv: Record<string, string> | undefined;
  seed: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdateOperation: (updater: (prev: OperationOverride) => OperationOverride | null) => void;
}

function OperationEditorCard({
  op,
  override,
  nodeLatency,
  nodeErrorRate,
  mockEnv,
  seed,
  expanded,
  onToggleExpand,
  onUpdateOperation,
}: OperationCardProps) {
  const edited = isOperationEdited(override);
  const effStatus = override?.statusCode ?? op.defaultResponse.statusCode;
  const effTemplate = override?.responseTemplate ?? op.defaultResponse.bodyTemplate;
  const effHeaders = override?.headers ?? op.defaultResponse.headers ?? {};
  const effSize = override?.responseSizeBytes ?? op.defaultResponse.sizeBytes ?? 512;
  const effErrorPct = Number(((override?.errorRate ?? nodeErrorRate) * 100).toFixed(4));
  const effErrorKind = override?.errorKind ?? 'server';
  const baseOpLatency = override?.latency ?? op.latency ?? nodeLatency;

  const [latOverrideEnabled, setLatOverrideEnabled] = useState(Boolean(override?.latency));
  const [distDraft, setDistDraft] = useState<LatencyModel['distribution']>(
    baseOpLatency.distribution,
  );
  const [p50Draft, setP50Draft] = useState(String(baseOpLatency.p50));
  const [p95Draft, setP95Draft] = useState(String(baseOpLatency.p95));
  const [statusDraft, setStatusDraft] = useState(String(effStatus));
  const [sizeDraft, setSizeDraft] = useState(String(effSize));
  const [errRateDraft, setErrRateDraft] = useState(String(effErrorPct));
  const [templateDraft, setTemplateDraft] = useState(effTemplate);
  const [sampleInputDraft, setSampleInputDraft] = useState(
    '{\n  "id": "ord-1042",\n  "user": { "name": "Avery" }\n}',
  );
  const [showSchema, setShowSchema] = useState(Boolean(override?.inputSchema ?? op.inputSchema));
  const [schemaDraft, setSchemaDraft] = useState(
    JSON.stringify(
      override?.inputSchema ??
        op.inputSchema ?? {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
          },
          required: ['id'],
        },
      null,
      2,
    ),
  );
  const [preview, setPreview] = useState<MockOperationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [newHeaderKey, setNewHeaderKey] = useState('');
  const [newHeaderVal, setNewHeaderVal] = useState('');

  useEffect(() => {
    const lat = override?.latency ?? op.latency ?? nodeLatency;
    setLatOverrideEnabled(Boolean(override?.latency));
    setDistDraft(lat.distribution);
    setP50Draft(String(lat.p50));
    setP95Draft(String(lat.p95));
    setStatusDraft(String(override?.statusCode ?? op.defaultResponse.statusCode));
    setSizeDraft(String(override?.responseSizeBytes ?? op.defaultResponse.sizeBytes ?? 512));
    setErrRateDraft(String(Number(((override?.errorRate ?? nodeErrorRate) * 100).toFixed(4))));
    setTemplateDraft(override?.responseTemplate ?? op.defaultResponse.bodyTemplate);
    if (override?.inputSchema || op.inputSchema) {
      setSchemaDraft(JSON.stringify(override?.inputSchema ?? op.inputSchema, null, 2));
    }
  }, [override, op, nodeLatency, nodeErrorRate]);

  const parsedP50 = p50Draft.trim() === '' ? Number.NaN : Number(p50Draft);
  const parsedP95 = p95Draft.trim() === '' ? Number.NaN : Number(p95Draft);
  const latCheck = latOverrideEnabled
    ? validateLatencyInput({
        distribution: distDraft,
        p50: parsedP50,
        p95: distDraft === 'fixed' ? parsedP50 : parsedP95,
      })
    : { valid: true, errors: {} };

  const statusNum = Number(statusDraft);
  const statusError =
    !Number.isInteger(statusNum) || statusNum < 100 || statusNum > 599
      ? 'Status code must be an integer between 100 and 599.'
      : null;

  const sizeNum = Number(sizeDraft);
  const sizeError =
    !Number.isFinite(sizeNum) || sizeNum < 0 ? 'Size must be 0 bytes or greater.' : null;

  const errNum = errRateDraft.trim() === '' ? Number.NaN : Number(errRateDraft);
  const errMsg = validateErrorRatePercent(errNum);
  const tplValidation = validateResponseTemplate(templateDraft);

  let parsedSchemaObj: Record<string, unknown> | null = null;
  let schemaParseError: string | null = null;
  if (showSchema) {
    try {
      const candidate = JSON.parse(schemaDraft) as unknown;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        schemaParseError = 'Schema must be a JSON object.';
      } else {
        const res = validateJsonSchemaDefinition(candidate);
        if (!res.valid) {
          const first = res.errors[0];
          schemaParseError = first ? `${first.path}: ${first.message}` : 'Invalid JSON Schema.';
        } else {
          parsedSchemaObj = candidate as Record<string, unknown>;
        }
      }
    } catch {
      schemaParseError = 'Schema is not valid JSON.';
    }
  }

  let parsedSampleInput: unknown = {};
  let sampleInputError: string | null = null;
  try {
    parsedSampleInput = sampleInputDraft.trim() === '' ? {} : JSON.parse(sampleInputDraft);
  } catch {
    sampleInputError = 'Sample input is not valid JSON.';
  }

  const schemaInputErrors =
    !sampleInputError && parsedSchemaObj
      ? validateJsonSchemaValue(parsedSchemaObj, parsedSampleInput).errors
      : [];

  const handleRunPreview = () => {
    if (!tplValidation.valid) {
      setPreviewError(
        `Line ${tplValidation.error?.line ?? 1}, column ${tplValidation.error?.column ?? 1}: ${tplValidation.error?.message}`,
      );
      setPreview(null);
      return;
    }
    if (sampleInputError) {
      setPreviewError(sampleInputError);
      setPreview(null);
      return;
    }
    try {
      const rendered = renderMockOperationPreview(
        op,
        {
          ...override,
          statusCode: statusError ? effStatus : statusNum,
          responseTemplate: templateDraft,
          responseSizeBytes: sizeError ? effSize : Math.round(sizeNum),
          headers: effHeaders,
        },
        {
          input: parsedSampleInput,
          env: mockEnv,
          seed,
          seq: 1,
          nowMs: 1200,
        },
      );
      setPreview(rendered);
      setPreviewError(null);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to render response preview.');
      setPreview(null);
    }
  };

  return (
    <div
      data-testid={`op-row-${op.name}`}
      className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)]"
    >
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-raised)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[11px] font-medium text-[var(--text-primary)]">
                {op.name}
              </span>
              {edited ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
                  title="Operation overridden on this node"
                />
              ) : null}
            </div>
            <div className="truncate text-[10px] text-[var(--text-muted)]">{op.summary}</div>
          </div>
        </div>
        <span className="shrink-0 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
          {effStatus}
        </span>
      </button>

      {expanded ? (
        <div
          data-testid={`op-editor-${op.name}`}
          className="space-y-3 border-t border-[var(--border-hairline)] p-3"
        >
          {/* Operation Latency */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={latOverrideEnabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setLatOverrideEnabled(checked);
                    onUpdateOperation((prev) => {
                      const next = { ...prev };
                      if (!checked) {
                        delete next.latency;
                      } else {
                        const base = op.latency ?? nodeLatency;
                        next.latency = {
                          distribution: base.distribution,
                          p50: base.p50,
                          p95: base.p95,
                        };
                      }
                      return next;
                    });
                  }}
                />
                <span>Override operation latency</span>
              </label>
              {edited ? (
                <button
                  type="button"
                  onClick={() => {
                    onUpdateOperation(() => null);
                    setPreview(null);
                    setPreviewError(null);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
                >
                  <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
                  <span>Reset op</span>
                </button>
              ) : null}
            </div>

            {latOverrideEnabled ? (
              <div className="space-y-1.5">
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">p50 (ms)</span>
                    <input
                      type="number"
                      aria-label={`${op.name} p50 ms`}
                      min={0.01}
                      step={0.5}
                      value={p50Draft}
                      onChange={(e) => {
                        const val = e.target.value;
                        setP50Draft(val);
                        const n50 = val.trim() === '' ? Number.NaN : Number(val);
                        const chk = validateLatencyInput({
                          distribution: distDraft,
                          p50: n50,
                          p95: distDraft === 'fixed' ? n50 : parsedP95,
                        });
                        if (chk.valid) {
                          onUpdateOperation((prev) => ({
                            ...prev,
                            latency: {
                              distribution: distDraft,
                              p50: n50,
                              p95: distDraft === 'fixed' ? n50 : parsedP95,
                            },
                          }));
                        }
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">p95 (ms)</span>
                    <input
                      type="number"
                      aria-label={`${op.name} p95 ms`}
                      min={0.01}
                      step={1}
                      disabled={distDraft === 'fixed'}
                      value={distDraft === 'fixed' ? p50Draft : p95Draft}
                      onChange={(e) => {
                        const val = e.target.value;
                        setP95Draft(val);
                        const n95 = val.trim() === '' ? Number.NaN : Number(val);
                        const chk = validateLatencyInput({
                          distribution: distDraft,
                          p50: parsedP50,
                          p95: n95,
                        });
                        if (chk.valid) {
                          onUpdateOperation((prev) => ({
                            ...prev,
                            latency: {
                              distribution: distDraft,
                              p50: parsedP50,
                              p95: n95,
                            },
                          }));
                        }
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)] disabled:opacity-45"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-[var(--text-muted)]">Distribution</span>
                    <select
                      aria-label={`${op.name} distribution`}
                      value={distDraft}
                      onChange={(e) => {
                        const d = e.target.value as LatencyModel['distribution'];
                        setDistDraft(d);
                        const chk = validateLatencyInput({
                          distribution: d,
                          p50: parsedP50,
                          p95: d === 'fixed' ? parsedP50 : parsedP95,
                        });
                        if (chk.valid) {
                          onUpdateOperation((prev) => ({
                            ...prev,
                            latency: {
                              distribution: d,
                              p50: parsedP50,
                              p95: d === 'fixed' ? parsedP50 : parsedP95,
                            },
                          }));
                        }
                      }}
                      className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
                    >
                      <option value="lognormal">lognormal</option>
                      <option value="fixed">fixed</option>
                      <option value="normal">normal</option>
                    </select>
                  </label>
                </div>
                {latCheck.errors.p50 || latCheck.errors.p95 ? (
                  <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                    {latCheck.errors.p50 ?? latCheck.errors.p95}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Response Metadata */}
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Status code</span>
              <input
                type="number"
                aria-label={`${op.name} status code`}
                min={100}
                max={599}
                value={statusDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setStatusDraft(val);
                  const n = Number(val);
                  if (Number.isInteger(n) && n >= 100 && n <= 599) {
                    onUpdateOperation((prev) => ({ ...prev, statusCode: n }));
                  }
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Response size (bytes)</span>
              <input
                type="number"
                aria-label={`${op.name} size bytes`}
                min={0}
                step={64}
                value={sizeDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setSizeDraft(val);
                  const n = Number(val);
                  if (Number.isFinite(n) && n >= 0) {
                    onUpdateOperation((prev) => ({ ...prev, responseSizeBytes: Math.round(n) }));
                  }
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Op error (%)</span>
              <input
                type="number"
                aria-label={`${op.name} error rate`}
                min={0}
                max={100}
                step={0.1}
                value={errRateDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setErrRateDraft(val);
                  const n = val.trim() === '' ? Number.NaN : Number(val);
                  if (!validateErrorRatePercent(n)) {
                    onUpdateOperation((prev) => ({ ...prev, errorRate: n / 100 }));
                  }
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] text-[var(--text-muted)]">Error kind</span>
              <select
                aria-label={`${op.name} error kind`}
                value={effErrorKind}
                onChange={(e) => {
                  const k = e.target.value as NonNullable<OperationOverride['errorKind']>;
                  onUpdateOperation((prev) => ({ ...prev, errorKind: k }));
                }}
                className="mt-0.5 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[11px] text-[var(--text-primary)]"
              >
                {ERROR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {statusError || sizeError || errMsg ? (
            <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
              {statusError ?? sizeError ?? errMsg}
            </p>
          ) : null}

          {/* Headers Editor */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-[var(--text-muted)]">Headers</div>
            <div className="space-y-1">
              {Object.entries(effHeaders).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={k}
                    readOnly
                    className="h-6 w-28 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-1.5 font-mono text-[10px] text-[var(--text-secondary)]"
                  />
                  <input
                    type="text"
                    aria-label={`Header ${k}`}
                    value={v}
                    onChange={(e) => {
                      const val = e.target.value;
                      onUpdateOperation((prev) => ({
                        ...prev,
                        headers: {
                          ...(prev.headers ?? op.defaultResponse.headers ?? {}),
                          [k]: val,
                        },
                      }));
                    }}
                    className="h-6 flex-1 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                  />
                  <button
                    type="button"
                    aria-label={`Remove header ${k}`}
                    onClick={() => {
                      onUpdateOperation((prev) => {
                        const nextHeaders = {
                          ...(prev.headers ?? op.defaultResponse.headers ?? {}),
                        };
                        delete nextHeaders[k];
                        return { ...prev, headers: nextHeaders };
                      });
                    }}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-1.5 pt-0.5">
                <input
                  type="text"
                  placeholder="header-name"
                  value={newHeaderKey}
                  onChange={(e) => setNewHeaderKey(e.target.value)}
                  className="h-6 w-28 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                />
                <input
                  type="text"
                  placeholder="value or {{faker.uuid}}"
                  value={newHeaderVal}
                  onChange={(e) => setNewHeaderVal(e.target.value)}
                  className="h-6 flex-1 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                />
                <button
                  type="button"
                  onClick={() => {
                    const cleanKey = newHeaderKey.trim();
                    if (!cleanKey) return;
                    onUpdateOperation((prev) => ({
                      ...prev,
                      headers: {
                        ...(prev.headers ?? op.defaultResponse.headers ?? {}),
                        [cleanKey]: newHeaderVal,
                      },
                    }));
                    setNewHeaderKey('');
                    setNewHeaderVal('');
                  }}
                  className="inline-flex h-6 items-center gap-0.5 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <Plus className="h-3 w-3" strokeWidth={1.5} />
                  <span>Add</span>
                </button>
              </div>
            </div>
          </div>

          {/* Body Template */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)]">Response template</span>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {'{{faker.uuid}}, {{input.id}}, {{repeat(n,"...")}}'}
              </span>
            </div>
            <textarea
              aria-label={`${op.name} response template`}
              rows={3}
              value={templateDraft}
              onChange={(e) => {
                const val = e.target.value;
                setTemplateDraft(val);
                const check = validateResponseTemplate(val);
                if (check.valid) {
                  onUpdateOperation((prev) => ({ ...prev, responseTemplate: val }));
                }
              }}
              className={`w-full rounded-[6px] border bg-[var(--bg-surface)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)] focus:outline-none ${
                tplValidation.valid
                  ? 'border-[var(--border-hairline)] focus:border-[var(--accent)]'
                  : 'border-[var(--status-overloaded)]'
              }`}
            />
            {!tplValidation.valid && tplValidation.error ? (
              <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                Line {tplValidation.error.line}, column {tplValidation.error.column}:{' '}
                {tplValidation.error.message}
              </p>
            ) : null}
          </div>

          {/* Preview Runner */}
          <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)]">Sample input & preview</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRunPreview}
                data-testid={`op-preview-btn-${op.name}`}
                className="h-6 px-2 text-[10px]"
              >
                <Play className="h-3 w-3" strokeWidth={1.5} />
                <span>Preview</span>
              </Button>
            </div>
            <textarea
              aria-label={`${op.name} sample input json`}
              rows={2}
              value={sampleInputDraft}
              onChange={(e) => setSampleInputDraft(e.target.value)}
              className="w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[10px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            {sampleInputError ? (
              <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                {sampleInputError}
              </p>
            ) : null}
            {previewError ? (
              <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                {previewError}
              </p>
            ) : null}
            {preview ? (
              <div
                data-testid={`op-preview-output-${op.name}`}
                className="space-y-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[10px]"
              >
                <div className="flex items-center justify-between text-[var(--text-secondary)]">
                  <span>HTTP {preview.statusCode}</span>
                  <span className="tabular-nums">{preview.byteLength} bytes</span>
                </div>
                {Object.keys(preview.headers).length > 0 ? (
                  <div className="space-y-0.5 border-t border-[var(--border-hairline)] pt-1 text-[var(--text-muted)]">
                    {Object.entries(preview.headers).map(([hk, hv]) => (
                      <div key={hk} className="truncate">
                        {hk}: {hv}
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all border-t border-[var(--border-hairline)] pt-1 text-[var(--text-primary)]">
                  {preview.body}
                </pre>
              </div>
            ) : null}
          </div>

          {/* Input JSON Schema */}
          <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2">
            <label className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={showSchema}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setShowSchema(enabled);
                  if (!enabled) {
                    onUpdateOperation((prev) => {
                      const next = { ...prev };
                      delete next.inputSchema;
                      return next;
                    });
                  } else if (parsedSchemaObj) {
                    onUpdateOperation((prev) => ({ ...prev, inputSchema: parsedSchemaObj! }));
                  }
                }}
              />
              <span>Validate input with JSON Schema</span>
            </label>

            {showSchema ? (
              <div className="space-y-1.5">
                <textarea
                  aria-label={`${op.name} input schema`}
                  rows={4}
                  value={schemaDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSchemaDraft(val);
                    try {
                      const obj = JSON.parse(val) as unknown;
                      const valid = validateJsonSchemaDefinition(obj);
                      if (valid.valid && obj && typeof obj === 'object' && !Array.isArray(obj)) {
                        onUpdateOperation((prev) => ({
                          ...prev,
                          inputSchema: obj as Record<string, unknown>,
                        }));
                      }
                    } catch {
                      // Leave draft active and report inline error cleanly
                    }
                  }}
                  className="w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[10px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                {schemaParseError ? (
                  <p role="alert" className="text-[11px] text-[var(--status-overloaded)]">
                    {schemaParseError}
                  </p>
                ) : schemaInputErrors.length > 0 ? (
                  <div
                    role="alert"
                    className="space-y-0.5 text-[11px] text-[var(--status-overloaded)]"
                  >
                    {schemaInputErrors.map((errItem) => (
                      <div key={`${errItem.path}:${errItem.message}`}>
                        {errItem.path}: {errItem.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-[var(--status-ok)]">Sample input matches schema</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Expandable operation-level latency, mock response template, headers, preview, and JSON Schema editor. */
export function OperationsSection({ node, service, seed, onUpdateConfig }: OperationsSectionProps) {
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const catalogOps = service?.operations ?? [];
  const catalogNames = new Set(catalogOps.map((o) => o.name));
  const extraOps: OperationDef[] = Object.keys(node.config.operations ?? {})
    .filter((name) => !catalogNames.has(name))
    .map((name) => ({
      name,
      summary: 'Custom operation override',
      defaultResponse: { statusCode: 200, bodyTemplate: '{"ok":true}', sizeBytes: 128 },
      errors: [],
    }));
  const allOps = [...catalogOps, ...extraOps];

  if (allOps.length === 0) {
    return null;
  }

  const nodeLatency = node.config.latency ??
    service?.latency ?? { distribution: 'lognormal', p50: 15, p95: 60 };
  const nodeErrorRate = node.config.errorRate ?? service?.failure.errorRate ?? 0;

  return (
    <section className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Operations ({allOps.length})
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">Click row to customize</span>
      </div>
      <div className="space-y-1.5">
        {allOps.map((op) => (
          <OperationEditorCard
            key={op.name}
            op={op}
            override={node.config.operations?.[op.name]}
            nodeLatency={nodeLatency}
            nodeErrorRate={nodeErrorRate}
            mockEnv={node.config.mockEnv}
            seed={seed}
            expanded={expandedOp === op.name}
            onToggleExpand={() => setExpandedOp((prev) => (prev === op.name ? null : op.name))}
            onUpdateOperation={(updater) => {
              onUpdateConfig((cfg) => {
                if (!cfg.operations) {
                  cfg.operations = {};
                }
                const next = updater(cfg.operations[op.name] ?? {});
                if (next === null) {
                  delete cfg.operations[op.name];
                } else {
                  cfg.operations[op.name] = next;
                }
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}
