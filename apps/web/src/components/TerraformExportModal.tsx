'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, FileCode2, Info, X } from 'lucide-react';
import type { Design } from '@infrasim/shared-types';
import type { TerraformExportResult } from '@infrasim/terraform';
import { Button } from '@infrasim/ui-kit';
import { HclCodeView } from './HclCodeView';
import { triggerZipDownload } from './dock/TerraformDockTab';

export interface TerraformExportModalProps {
  open: boolean;
  design: Design;
  defaultRegion: string;
  onClose: () => void;
}

const CLOUD_PROVIDERS: Array<{ id: 'aws' | 'gcp' | 'azure' | 'oci'; label: string }> = [
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
  { id: 'oci', label: 'OCI' },
];

const DEFAULT_REGIONS: Record<'aws' | 'gcp' | 'azure' | 'oci', string> = {
  aws: 'us-east-1',
  gcp: 'us-central1',
  azure: 'eastus',
  oci: 'us-ashburn-1',
};

/** Modal for configuring Terraform export options, inspecting generated files, copying HCL, and downloading a ZIP archive. */
export function TerraformExportModal({
  open,
  design,
  defaultRegion,
  onClose,
}: TerraformExportModalProps) {
  const [selectedProviders, setSelectedProviders] = useState<
    Array<'aws' | 'gcp' | 'azure' | 'oci'>
  >(['aws']);
  const [namePrefix, setNamePrefix] = useState('infrasim');
  const [regions, setRegions] =
    useState<Record<'aws' | 'gcp' | 'azure' | 'oci', string>>(DEFAULT_REGIONS);
  const [includeComments, setIncludeComments] = useState(true);
  const [result, setResult] = useState<TerraformExportResult | null>(null);
  const [activeFilename, setActiveFilename] = useState('providers.tf');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const detected = new Set<'aws' | 'gcp' | 'azure' | 'oci'>();
    for (const node of design.nodes) {
      const p = node.serviceId.split('.')[0];
      if (p === 'aws' || p === 'gcp' || p === 'azure' || p === 'oci') {
        detected.add(p);
      }
    }
    const primary = design.settings.primaryProvider;
    if (
      detected.size === 0 &&
      (primary === 'aws' || primary === 'gcp' || primary === 'azure' || primary === 'oci')
    ) {
      detected.add(primary);
    }
    if (detected.size === 0) detected.add('aws');
    setSelectedProviders([...detected].sort());

    const slug = design.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    setNamePrefix(slug || 'infrasim');

    if (primary === 'aws' || primary === 'gcp' || primary === 'azure' || primary === 'oci') {
      setRegions((prev) => ({ ...prev, [primary]: defaultRegion || prev[primary] }));
    }
  }, [open, design.name, design.nodes, design.settings.primaryProvider, defaultRegion]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void import('@infrasim/terraform').then((mod) => {
      if (!active) return;
      const next = mod.exportDesignToTerraform(design, {
        providers: selectedProviders,
        namePrefix,
        regions,
        includeComments,
      });
      setResult(next);
      if (!next.files.some((f) => f.filename === activeFilename)) {
        setActiveFilename(next.files[0]?.filename ?? 'providers.tf');
      }
    });
    return () => {
      active = false;
    };
  }, [open, design, selectedProviders, namePrefix, regions, includeComments, activeFilename]);

  const activeFile = useMemo(
    () => result?.files.find((f) => f.filename === activeFilename) ?? result?.files[0] ?? null,
    [result, activeFilename],
  );

  if (!open) return null;

  const toggleProvider = (id: 'aws' | 'gcp' | 'azure' | 'oci') => {
    setSelectedProviders((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev;
        return prev.filter((p) => p !== id);
      }
      return [...prev, id].sort();
    });
  };

  const handleCopy = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  };

  const handleDownloadZip = async () => {
    if (!result) return;
    const mod = await import('@infrasim/terraform');
    const bytes = mod.exportTerraformZip(result);
    const safePrefix = mod.snakeCaseSlug(namePrefix, 'infrasim').replace(/_/g, '-');
    triggerZipDownload(bytes, `${safePrefix}-terraform.zip`);
  };

  return (
    <div
      data-testid="terraform-export-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Export Terraform"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <FileCode2 className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
            <div>
              <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                Export Terraform HCL
              </h2>
              <p className="text-[11px] text-[var(--text-muted)]">
                Generated in your browser for learning — secrets become variables without defaults.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close export modal"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[270px_minmax(0,1fr)]">
          {/* Options column */}
          <div className="space-y-4 overflow-y-auto border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-[12px] md:border-b-0 md:border-r">
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                Providers to emit
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {CLOUD_PROVIDERS.map((p) => {
                  const checked = selectedProviders.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-[6px] border px-2.5 py-1.5 text-[11px] font-medium ${
                        checked
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-secondary)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProvider(p.id)}
                      />
                      <span>{p.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="block">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                Resource name prefix
              </span>
              <input
                type="text"
                data-testid="tf-export-prefix-input"
                value={namePrefix}
                onChange={(e) => setNamePrefix(e.target.value)}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Default regions
              </div>
              {selectedProviders.map((prov) => (
                <label key={prov} className="block">
                  <span className="font-mono text-[10px] uppercase text-[var(--text-muted)]">
                    {prov}
                  </span>
                  <input
                    type="text"
                    value={regions[prov]}
                    onChange={(e) => setRegions((prev) => ({ ...prev, [prov]: e.target.value }))}
                    className="mt-0.5 h-7 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2 font-mono text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={includeComments}
                onChange={(e) => setIncludeComments(e.target.checked)}
              />
              <span>Include educational comments</span>
            </label>

            {result && result.unsupportedNodes.length > 0 ? (
              <div className="rounded-[8px] border border-[rgba(229,160,13,0.4)] bg-[rgba(229,160,13,0.08)] p-2.5 text-[11px] text-[var(--status-warm)]">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                  <span>{result.unsupportedNodes.length} custom or unmapped item(s)</span>
                </div>
                <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--text-secondary)]">
                  {result.unsupportedNodes.map((u) => (
                    <li key={u.nodeId} className="truncate font-mono">
                      • {u.serviceId}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5 text-[11px] text-[var(--text-muted)]">
              <div className="flex items-start gap-1.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                <span>
                  Review generated `.tf` files and supply sensitive variables before running{' '}
                  <code className="font-mono text-[10px] text-[var(--text-secondary)]">
                    terraform plan
                  </code>
                  .
                </span>
              </div>
            </div>
          </div>

          {/* File tabs + highlighted preview */}
          <div className="flex min-h-0 flex-col bg-[var(--bg-sunken)]">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {(result?.files ?? []).map((f) => {
                  const active = activeFile?.filename === f.filename;
                  return (
                    <button
                      key={f.filename}
                      type="button"
                      data-testid={`tf-modal-tab-${f.filename}`}
                      onClick={() => setActiveFilename(f.filename)}
                      className={`h-7 shrink-0 rounded-[6px] px-2.5 font-mono text-[11px] transition-colors ${
                        active
                          ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {f.filename}
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="tf-modal-copy-btn"
                  onClick={() => void handleCopy()}
                  className="h-7 px-2.5 text-[11px]"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" strokeWidth={1.5} />
                  ) : (
                    <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                  <span>{copied ? 'Copied' : 'Copy file'}</span>
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="tf-modal-download-zip-btn"
                  onClick={() => void handleDownloadZip()}
                  className="h-7 px-3 text-[11px]"
                >
                  <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>Download ZIP</span>
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              {activeFile ? (
                <HclCodeView
                  content={activeFile.content}
                  language={activeFile.language}
                  testId="tf-modal-code-view"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
