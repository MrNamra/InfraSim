'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileJson,
  Lock,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Design } from '@infrasim/shared-types';
import {
  TERRAFORM_MAX_INPUT_BYTES,
  type TerraformImportReport,
  type TerraformImportResult,
  type TerraformUnsupportedResourceInfo,
} from '@infrasim/terraform';
import { Button } from '@infrasim/ui-kit';
import { runTerraformImportInWorker } from '../lib/terraformImportClient';

const CLI_HINT_CMD = 'terraform plan -out=tfplan && terraform show -json tfplan > plan.json';

export interface TerraformImportModalProps {
  open: boolean;
  onClose: () => void;
  onPlaceDesign: (design: Design, report: TerraformImportReport) => void;
  onCreateCustomForUnsupported: (
    design: Design,
    report: TerraformImportReport,
    unsupportedItem: TerraformUnsupportedResourceInfo,
  ) => void;
}

/**
 * Client-side Terraform `show -json` importer modal.
 * Runs parsing/sanitization/ELK layout off-thread in a Web Worker, displays a full Import Report
 * (mapped/unsupported/ignored/inferred edges/secrets stripped), and places the result on canvas.
 */
export function TerraformImportModal({
  open,
  onClose,
  onPlaceDesign,
  onCreateCustomForUnsupported,
}: TerraformImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [cliCopied, setCliCopied] = useState(false);
  const [result, setResult] = useState<TerraformImportResult | null>(null);
  const [confirmedEdgeIds, setConfirmedEdgeIds] = useState<Set<string>>(() => new Set());
  const [removedEdgeIds, setRemovedEdgeIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  const finalDesign = useMemo<Design | null>(() => {
    if (!result) return null;
    const nextEdges = result.design.edges
      .filter((edge) => !removedEdgeIds.has(edge.id))
      .map((edge) => {
        if (!confirmedEdgeIds.has(edge.id)) return edge;
        const copy = { ...edge, inferred: false };
        delete copy.confidence;
        delete copy.reason;
        return copy;
      });
    return {
      ...result.design,
      edges: nextEdges,
    };
  }, [result, confirmedEdgeIds, removedEdgeIds]);

  if (!open) return null;

  const resetState = () => {
    setError(null);
    setFileName(null);
    setResult(null);
    setConfirmedEdgeIds(new Set());
    setRemovedEdgeIds(new Set());
  };

  const runImportFromText = async (rawText: string, label: string) => {
    setBusy(true);
    setError(null);
    setFileName(label);
    try {
      const importResult = await runTerraformImportInWorker(rawText, {
        designName: label.replace(/\.json$/i, '') || 'Imported Terraform architecture',
      });
      setResult(importResult);
      setConfirmedEdgeIds(new Set());
      setRemovedEdgeIds(new Set());
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Unable to parse Terraform JSON.');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > TERRAFORM_MAX_INPUT_BYTES) {
      setResult(null);
      setError(
        `File "${file.name}" (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the 5 MB safety limit.`,
      );
      return;
    }
    const text = await file.text();
    await runImportFromText(text, file.name);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void handleFile(e.dataTransfer.files?.[0]);
  };

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(CLI_HINT_CMD);
      setCliCopied(true);
      setTimeout(() => setCliCopied(false), 1800);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
  };

  const toggleConfirmEdge = (edgeId: string) => {
    setConfirmedEdgeIds((prev) => {
      const next = new Set(prev);
      if (next.has(edgeId)) next.delete(edgeId);
      else next.add(edgeId);
      return next;
    });
    setRemovedEdgeIds((prev) => {
      if (!prev.has(edgeId)) return prev;
      const next = new Set(prev);
      next.delete(edgeId);
      return next;
    });
  };

  const toggleRemoveEdge = (edgeId: string) => {
    setRemovedEdgeIds((prev) => {
      const next = new Set(prev);
      if (next.has(edgeId)) next.delete(edgeId);
      else next.add(edgeId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tf-import-modal-title"
        data-testid="terraform-import-modal"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-floating)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
          <div className="flex items-center gap-2">
            <FileJson className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
            <h2 id="tf-import-modal-title" className="text-[14px] font-medium">
              Import Terraform plan or state JSON
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close Terraform import"
            disabled={busy}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
          {/* Browser-local privacy notice + CLI hint */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
            <div className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--status-ok)]" strokeWidth={1.5} />
              <span>
                Imports are processed in your browser — nothing is uploaded and secrets are
                stripped.
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono text-[10px] text-[var(--text-primary)]">
              <span>{CLI_HINT_CMD}</span>
              <button
                type="button"
                onClick={() => void handleCopyCli()}
                title="Copy Terraform export command"
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {cliCopied ? (
                  <Check className="h-3 w-3 text-[var(--status-ok)]" strokeWidth={1.5} />
                ) : (
                  <Copy className="h-3 w-3" strokeWidth={1.5} />
                )}
              </button>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              data-testid="tf-import-error"
              className="flex items-start gap-2 rounded-[8px] border border-[var(--status-overloaded)] bg-[rgba(229,72,77,0.08)] px-3 py-2 text-[11px] text-[var(--status-overloaded)]"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span>{error}</span>
            </div>
          ) : null}

          {!result ? (
            <div className="space-y-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center rounded-[10px] border border-dashed px-6 py-8 text-center transition-colors ${
                  dragging
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-strong)] bg-[var(--bg-sunken)]'
                }`}
              >
                <Upload className="h-6 w-6 text-[var(--text-muted)]" strokeWidth={1.5} />
                <p className="mt-2 text-[13px] font-medium text-[var(--text-primary)]">
                  {busy
                    ? `Processing ${fileName ?? 'plan.json'}…`
                    : 'Drop plan.json or state JSON here'}
                </p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Accepts `terraform show -json` plan or state files up to 5 MB (10 s worker limit).
                </p>
                <input
                  ref={fileInputRef}
                  data-testid="tf-import-file-input"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    void handleFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>Select JSON file</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => setPasteOpen((prev) => !prev)}
                    className="h-8 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {pasteOpen ? 'Hide pasted JSON' : 'Paste JSON instead'}
                  </button>
                </div>
              </div>

              {pasteOpen ? (
                <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
                  <textarea
                    aria-label="Paste Terraform show JSON"
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder='{"format_version":"1.2","planned_values":{"root_module":{"resources":[]}}}'
                    rows={6}
                    className="w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <div className="flex justify-end">
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="tf-import-parse-btn"
                      disabled={busy || !pasteText.trim()}
                      onClick={() => void runImportFromText(pasteText, 'pasted-plan.json')}
                    >
                      Parse pasted JSON
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div data-testid="tf-import-report" className="space-y-4">
              {/* Summary header & metrics grid */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-[var(--text-primary)]">
                    Import report — {fileName ?? 'plan.json'}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                    Source: {result.report.sourceKind} JSON · Format v{result.report.formatVersion}{' '}
                    · Providers:{' '}
                    {result.report.providersDetected.length > 0
                      ? result.report.providersDetected.map((p) => p.toUpperCase()).join(', ')
                      : 'auto'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetState}
                  className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Choose another file
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[
                  { label: 'Mapped', value: result.report.mappedCount },
                  { label: 'Containers', value: result.report.groupCount },
                  { label: 'Network objs', value: result.report.networkObjectCount },
                  { label: 'Ignored', value: result.report.ignoredCount },
                  { label: 'Secrets stripped', value: result.report.strippedSensitiveCount },
                  { label: 'Time (ms)', value: result.report.elapsedMs },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-2"
                  >
                    <div className="text-[10px] text-[var(--text-muted)]">{stat.label}</div>
                    <div className="mt-0.5 font-mono text-[14px] font-medium tabular-nums text-[var(--text-primary)]">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Warnings */}
              {result.report.warnings.length > 0 ? (
                <div className="space-y-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
                  <div className="text-[11px] font-medium text-[var(--status-warm)]">
                    Import notes & warnings
                  </div>
                  <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    {result.report.warnings.map((w, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[var(--status-warm)]" />
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Inferred edges review */}
              <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-[var(--text-primary)]">
                    Inferred connections ({result.report.inferredEdges.length})
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Conservative signals only — confirm or drop before placing
                  </span>
                </div>
                {result.report.inferredEdges.length === 0 ? (
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                    No edge wiring signals detected; you can connect nodes manually on the canvas.
                  </p>
                ) : (
                  <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto">
                    {result.report.inferredEdges.map((edge) => {
                      const isConfirmed = confirmedEdgeIds.has(edge.edgeId);
                      const isRemoved = removedEdgeIds.has(edge.edgeId);
                      return (
                        <div
                          key={edge.edgeId}
                          data-testid={`tf-import-edge-${edge.edgeId}`}
                          className={`flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[11px] ${
                            isRemoved
                              ? 'border-[var(--border-hairline)] bg-[var(--bg-surface)] opacity-45'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                              <span className={isRemoved ? 'line-through' : ''}>
                                {edge.fromLabel} → {edge.toLabel}
                              </span>
                              <span className="rounded bg-[var(--bg-sunken)] px-1 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
                                {edge.protocol}
                                {edge.port ? `:${edge.port}` : ''} · {edge.callType}
                              </span>
                              <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                                {Math.round(edge.confidence * 100)}%
                              </span>
                            </div>
                            <div className="truncate text-[10px] text-[var(--text-muted)]">
                              {edge.reason}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => toggleConfirmEdge(edge.edgeId)}
                              className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-[10px] font-medium transition-colors ${
                                isConfirmed
                                  ? 'border-[var(--status-ok)] bg-[rgba(48,164,108,0.12)] text-[var(--status-ok)]'
                                  : 'border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                              }`}
                            >
                              <CheckCircle2 className="h-3 w-3" strokeWidth={1.5} />
                              <span>{isConfirmed ? 'Confirmed' : 'Confirm'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleRemoveEdge(edge.edgeId)}
                              className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-[10px] font-medium transition-colors ${
                                isRemoved
                                  ? 'border-[var(--status-overloaded)] bg-[rgba(229,72,77,0.12)] text-[var(--status-overloaded)]'
                                  : 'border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--status-overloaded)]'
                              }`}
                            >
                              <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                              <span>{isRemoved ? 'Restore' : 'Remove'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Unsupported resources with Custom Service conversion action */}
              {result.report.unsupported.length > 0 ? (
                <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-[var(--text-primary)]">
                      Unsupported Terraform resources ({result.report.unsupported.length})
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Placed as neutral gray nodes; convert any to a custom service
                    </span>
                  </div>
                  <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
                    {result.report.unsupported.map((item, idx) => (
                      <div
                        key={item.address}
                        className="flex items-center justify-between gap-2 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px]"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[var(--text-primary)]">
                            {item.label}
                          </div>
                          <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                            {item.address}
                          </div>
                        </div>
                        <button
                          type="button"
                          data-testid={`tf-import-add-custom-${idx}`}
                          onClick={() => {
                            if (finalDesign) {
                              onCreateCustomForUnsupported(finalDesign, result.report, item);
                            }
                          }}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-[10px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                        >
                          <Plus className="h-3 w-3" strokeWidth={1.5} />
                          <span>Add custom service</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3">
          <div className="text-[11px] text-[var(--text-muted)]">
            {result
              ? `Ready to place ${result.design.nodes.length} nodes, ${result.design.groups.length} containers, and ${finalDesign?.edges.length ?? 0} edges`
              : 'Supports AWS, GCP, Azure, and OCI resources'}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="tf-import-place-btn"
              disabled={!finalDesign || busy}
              onClick={() => {
                if (finalDesign && result) {
                  onPlaceDesign(finalDesign, result.report);
                }
              }}
            >
              Place on canvas
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
