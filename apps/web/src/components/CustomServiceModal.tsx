'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type {
  CustomServiceDefinition,
  LatencyModel,
  MockKind,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { getKindDefault, renderMockOperationPreview } from '@infrasim/catalog';
import { Button } from '@infrasim/ui-kit';
import {
  CUSTOM_BASE_KINDS,
  CUSTOM_ICON_OPTIONS,
  CUSTOM_SERVICE_COLORS,
  buildCustomServiceDefinition,
  createCustomServiceDraft,
  slugifyCustomServiceId,
  validateCustomServiceDraft,
  type CustomServiceDraft,
} from '../lib/customServices';
import { ServiceIcon } from './ServiceIcon';

export interface CustomServiceModalProps {
  open: boolean;
  mode: 'create' | 'edit' | 'duplicate';
  initialSource?: ServiceDefinition | CustomServiceDefinition | null;
  targetNodeLabel?: string | null;
  existingCustomIds: readonly string[];
  isSignedIn: boolean;
  onClose: () => void;
  onSave: (
    service: CustomServiceDefinition,
    options: { previousId?: string; switchTargetNode: boolean },
  ) => Promise<{ error?: string }>;
}

/** Modal editor for creating, editing, or duplicating `custom.*` infrastructure blocks. */
export function CustomServiceModal({
  open,
  mode,
  initialSource = null,
  targetNodeLabel = null,
  existingCustomIds,
  isSignedIn,
  onClose,
  onSave,
}: CustomServiceModalProps) {
  const [draft, setDraft] = useState<CustomServiceDraft>(() =>
    createCustomServiceDraft(initialSource, mode),
  );
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [switchTargetNode, setSwitchTargetNode] = useState(Boolean(targetNodeLabel));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const editingId =
    mode === 'edit' && initialSource?.provider === 'custom' ? initialSource.id : null;

  useEffect(() => {
    if (!open) return;
    setDraft(createCustomServiceDraft(initialSource, mode));
    setIdManuallyEdited(mode === 'edit');
    setSwitchTargetNode(Boolean(targetNodeLabel));
    setErrors({});
    setServerError(null);
    setSubmitting(false);
  }, [open, initialSource, mode, targetNodeLabel]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const templatePreview = useMemo(() => {
    if (!draft.bodyTemplate.trim()) return null;
    try {
      const def = buildCustomServiceDefinition(draft, initialSource);
      return renderMockOperationPreview(def.operations[0]!, undefined, {
        seed: 42,
        seq: 1,
        nowMs: 1250,
        input: { id: 'req_01' },
      });
    } catch {
      return null;
    }
  }, [draft, initialSource]);

  if (!open) return null;

  const handleApplyKindDefaults = (kind: MockKind) => {
    const kindDefaults = getKindDefault(kind);
    const primaryOp = kindDefaults.operations[0];
    const primaryPort = kindDefaults.ports[0];
    setDraft((prev) => ({
      ...prev,
      kind,
      icon: kindDefaults.icon ?? kind,
      errorRatePct: String(Number((kindDefaults.failure.errorRate * 100).toFixed(4))),
      protocol: primaryPort?.protocol ?? prev.protocol,
      port: String(primaryPort?.port ?? prev.port),
      operationName: primaryOp?.name ?? prev.operationName,
      operationSummary: primaryOp?.summary ?? prev.operationSummary,
      statusCode: String(primaryOp?.defaultResponse.statusCode ?? prev.statusCode),
      bodyTemplate: primaryOp?.defaultResponse.bodyTemplate ?? prev.bodyTemplate,
      sizeBytes: String(primaryOp?.defaultResponse.sizeBytes ?? prev.sizeBytes),
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const check = validateCustomServiceDraft(draft, existingCustomIds, editingId);
    if (!check.valid) {
      setErrors(check.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const built = buildCustomServiceDefinition(draft, initialSource);
      const outcome = await onSave(built, {
        ...(editingId ? { previousId: editingId } : {}),
        switchTargetNode,
      });
      if (outcome.error) {
        setServerError(outcome.error);
        return;
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    mode === 'edit'
      ? `Edit ${initialSource?.name ?? 'custom service'}`
      : mode === 'duplicate'
        ? `Duplicate ${initialSource?.name ?? 'service'} as custom`
        : 'Create custom service';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="custom-service-modal"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)]"
              style={{ borderLeftWidth: '3px', borderLeftColor: draft.color }}
            >
              <ServiceIcon icon={draft.icon} color={draft.color} className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[15px] font-medium text-[var(--text-primary)]">{title}</h2>
              <p className="text-[11px] text-[var(--text-muted)]">
                Embedded automatically inside exported designs
                {isSignedIn ? ' and synced to your account' : ' and saved locally'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close custom service editor"
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5 text-[12px]">
            {/* Identity & appearance */}
            <section className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Display name
                  </span>
                  <input
                    type="text"
                    data-testid="custom-service-name-input"
                    value={draft.name}
                    onChange={(e) => {
                      const nextName = e.target.value;
                      setDraft((prev) => ({
                        ...prev,
                        name: nextName,
                        id: !idManuallyEdited ? slugifyCustomServiceId(nextName) : prev.id,
                      }));
                    }}
                    placeholder="Stripe API"
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {errors.name ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.name}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Service ID
                  </span>
                  <input
                    type="text"
                    data-testid="custom-service-id-input"
                    value={draft.id}
                    onChange={(e) => {
                      setIdManuallyEdited(true);
                      setDraft((prev) => ({ ...prev, id: e.target.value }));
                    }}
                    placeholder="custom.stripe_api"
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {errors.id ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.id}
                    </span>
                  ) : null}
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                      Behavior kind
                    </span>
                    <button
                      type="button"
                      onClick={() => handleApplyKindDefaults(draft.kind)}
                      title="Load typical latency, operation, and port defaults for this kind"
                      className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
                    >
                      <RefreshCw className="h-2.5 w-2.5" strokeWidth={1.5} />
                      <span>Load defaults</span>
                    </button>
                  </div>
                  <select
                    aria-label="Behavior kind"
                    data-testid="custom-service-kind-select"
                    value={draft.kind}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, kind: e.target.value as MockKind }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  >
                    {CUSTOM_BASE_KINDS.map((item) => (
                      <option key={item.kind} value={item.kind}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="block">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Category
                  </span>
                  <input
                    type="text"
                    value={draft.category}
                    onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>

                <label className="block">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Scope
                  </span>
                  <select
                    value={draft.scope}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        scope: e.target.value as 'regional' | 'zonal' | 'global',
                      }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  >
                    <option value="regional">regional</option>
                    <option value="zonal">zonal</option>
                    <option value="global">global</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">Icon</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {CUSTOM_ICON_OPTIONS.map((opt) => {
                      const active = draft.icon === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          title={opt.label}
                          aria-label={`Icon ${opt.label}`}
                          onClick={() => setDraft((prev) => ({ ...prev, icon: opt.id }))}
                          className={`flex h-7 w-7 items-center justify-center rounded-[6px] border transition-colors ${
                            active
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                          }`}
                        >
                          <ServiceIcon
                            icon={opt.id}
                            color={active ? draft.color : undefined}
                            className="h-3.5 w-3.5"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Stripe color
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {CUSTOM_SERVICE_COLORS.map((swatch) => {
                      const active = draft.color.toLowerCase() === swatch.hex.toLowerCase();
                      return (
                        <button
                          key={swatch.hex}
                          type="button"
                          title={swatch.label}
                          aria-label={`Color ${swatch.label}`}
                          onClick={() => setDraft((prev) => ({ ...prev, color: swatch.hex }))}
                          className={`flex h-7 w-7 items-center justify-center rounded-[6px] border ${
                            active
                              ? 'border-[var(--text-primary)] ring-1 ring-[var(--text-primary)]'
                              : 'border-[var(--border-hairline)]'
                          }`}
                          style={{ backgroundColor: 'var(--bg-sunken)' }}
                        >
                          <span
                            className="h-3.5 w-3.5 rounded-full"
                            style={{ backgroundColor: swatch.hex }}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <label className="block">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Description
                </span>
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="External payment API or custom microservice"
                  className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                {errors.description ? (
                  <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                    {errors.description}
                  </span>
                ) : null}
              </label>
            </section>

            {/* Latency, Errors & Capacity */}
            <section className="space-y-3 border-t border-[var(--border-hairline)] pt-4">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Latency, errors & capacity
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Distribution</span>
                  <select
                    value={draft.distribution}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        distribution: e.target.value as LatencyModel['distribution'],
                      }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                  >
                    <option value="lognormal">lognormal</option>
                    <option value="normal">normal</option>
                    <option value="fixed">fixed</option>
                    <option value="bimodal">bimodal</option>
                  </select>
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">p50 (ms)</span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.5}
                    data-testid="custom-service-p50-input"
                    value={draft.p50}
                    onChange={(e) => setDraft((prev) => ({ ...prev, p50: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.p50 ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.p50}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">p95 (ms)</span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.5}
                    data-testid="custom-service-p95-input"
                    value={draft.p95}
                    onChange={(e) => setDraft((prev) => ({ ...prev, p95: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.p95 ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.p95}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Error rate (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={draft.errorRatePct}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, errorRatePct: e.target.value }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.errorRatePct ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.errorRatePct}
                    </span>
                  ) : null}
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Capacity model</span>
                  <select
                    value={draft.capacityType}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        capacityType: e.target.value as CustomServiceDraft['capacityType'],
                      }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                  >
                    <option value="rps">RPS rate limit</option>
                    <option value="conc">Concurrency slots</option>
                    <option value="slots">Compute instance slots</option>
                    <option value="conn">Connection pool</option>
                    <option value="tpm">AI token / request bucket</option>
                    <option value="elastic">Elastic scaling</option>
                    <option value="passthrough">Network passthrough</option>
                  </select>
                </label>

                {(draft.capacityType === 'rps' ||
                  draft.capacityType === 'conc' ||
                  draft.capacityType === 'conn') && (
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {draft.capacityType === 'rps'
                        ? 'RPS limit'
                        : draft.capacityType === 'conc'
                          ? 'Concurrent limit'
                          : 'Max connections'}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={draft.capacityLimit}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, capacityLimit: e.target.value }))
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                    />
                    {errors.capacityLimit ? (
                      <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                        {errors.capacityLimit}
                      </span>
                    ) : null}
                  </label>
                )}

                {draft.capacityType === 'rps' ? (
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">Burst allowance</span>
                    <input
                      type="number"
                      min={0}
                      value={draft.capacityBurst}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, capacityBurst: e.target.value }))
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                    />
                  </label>
                ) : draft.capacityType === 'conc' ? (
                  <label className="block">
                    <span className="text-[11px] text-[var(--text-muted)]">On limit</span>
                    <select
                      value={draft.capacityOnLimit}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          capacityOnLimit: e.target.value as 'throttle' | 'queue',
                        }))
                      }
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 text-[12px] text-[var(--text-primary)]"
                    >
                      <option value="throttle">throttle (429)</option>
                      <option value="queue">queue requests</option>
                    </select>
                  </label>
                ) : draft.capacityType === 'tpm' ? (
                  <>
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-muted)]">RPM</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.rpmLimit}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, rpmLimit: e.target.value }))
                        }
                        className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-[var(--text-muted)]">TPM</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.tpmLimit}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, tpmLimit: e.target.value }))
                        }
                        className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                      />
                    </label>
                  </>
                ) : null}
              </div>
            </section>

            {/* Primary operation, Network Port & Pricing */}
            <section className="space-y-3 border-t border-[var(--border-hairline)] pt-4">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Network port, primary mock operation & manual pricing
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Protocol</span>
                  <select
                    value={draft.protocol}
                    onChange={(e) => setDraft((prev) => ({ ...prev, protocol: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)]"
                  >
                    <option value="https">https</option>
                    <option value="http">http</option>
                    <option value="grpc">grpc</option>
                    <option value="tcp">tcp</option>
                    <option value="sql">sql</option>
                    <option value="redis">redis</option>
                    <option value="amqp">amqp</option>
                  </select>
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(e) => setDraft((prev) => ({ ...prev, port: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.port ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.port}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Manual price (USD, optional)
                  </span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="e.g. 29"
                    value={draft.manualUnitPrice}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, manualUnitPrice: e.target.value }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.manualUnitPrice ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.manualUnitPrice}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Unit</span>
                  <select
                    value={draft.manualUnit}
                    onChange={(e) => setDraft((prev) => ({ ...prev, manualUnit: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] text-[var(--text-primary)]"
                  >
                    <option value="month">month</option>
                    <option value="hour">hour</option>
                    <option value="1k req">1k req</option>
                    <option value="1M req">1M req</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Operation name</span>
                  <input
                    type="text"
                    value={draft.operationName}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, operationName: e.target.value }))
                    }
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)]"
                  />
                  {errors.operationName ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.operationName}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Status code</span>
                  <input
                    type="number"
                    min={100}
                    max={599}
                    value={draft.statusCode}
                    onChange={(e) => setDraft((prev) => ({ ...prev, statusCode: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                  {errors.statusCode ? (
                    <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                      {errors.statusCode}
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-[11px] text-[var(--text-muted)]">Payload bytes</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.sizeBytes}
                    onChange={(e) => setDraft((prev) => ({ ...prev, sizeBytes: e.target.value }))}
                    className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[12px] tabular-nums text-[var(--text-primary)]"
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">
                  Response body template (supports seeded {'{{faker.*}}'}, {'{{seq}}'},{' '}
                  {'{{now.iso}}'})
                </span>
                <textarea
                  rows={3}
                  value={draft.bodyTemplate}
                  onChange={(e) => setDraft((prev) => ({ ...prev, bodyTemplate: e.target.value }))}
                  className="mt-1 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                {errors.bodyTemplate ? (
                  <span className="mt-1 block text-[11px] text-[var(--status-overloaded)]">
                    {errors.bodyTemplate}
                  </span>
                ) : templatePreview ? (
                  <div className="mt-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2 font-mono text-[10px] text-[var(--text-secondary)]">
                    <div className="mb-0.5 text-[10px] text-[var(--text-muted)]">
                      Seeded preview ({templatePreview.statusCode}, {templatePreview.byteLength}{' '}
                      bytes)
                    </div>
                    <pre className="max-h-20 overflow-x-auto whitespace-pre-wrap break-all">
                      {templatePreview.body}
                    </pre>
                  </div>
                ) : null}
              </label>
            </section>

            {mode === 'duplicate' && targetNodeLabel ? (
              <label className="flex items-center gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[12px] text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={switchTargetNode}
                  onChange={(e) => setSwitchTargetNode(e.target.checked)}
                />
                <span>Switch selected node ({targetNodeLabel}) to this custom service</span>
              </label>
            ) : null}

            {serverError ? (
              <div
                role="alert"
                className="rounded-[8px] border border-[var(--status-overloaded)]/40 bg-[var(--status-overloaded)]/10 px-3 py-2 text-[12px] text-[var(--status-overloaded)]"
              >
                {serverError}
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              data-testid="custom-service-submit-btn"
              disabled={submitting}
            >
              {submitting
                ? 'Saving'
                : mode === 'edit'
                  ? 'Save changes'
                  : mode === 'duplicate'
                    ? 'Create custom copy'
                    : 'Create service'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
