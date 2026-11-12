'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, FileCode2, SlidersHorizontal } from 'lucide-react';
import type { Design } from '@infrasim/shared-types';
import type { TerraformExportResult } from '@infrasim/terraform';
import { HclCodeView } from '../HclCodeView';

export interface TerraformDockTabProps {
  design: Design;
  defaultRegion: string;
  onOpenExportModal: () => void;
}

/** Trigger browser download for a generated ZIP archive bytes buffer. */
export function triggerZipDownload(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Live debounced Terraform HCL preview inside the bottom dock with diff highlighting on edits. */
export function TerraformDockTab({
  design,
  defaultRegion,
  onOpenExportModal,
}: TerraformDockTabProps) {
  const [result, setResult] = useState<TerraformExportResult | null>(null);
  const [prevFileMap, setPrevFileMap] = useState<Record<string, string>>({});
  const [activeFilename, setActiveFilename] = useState<string>('network.tf');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [zipLoading, setZipLoading] = useState(false);

  const lastDesignIdRef = useRef<string>(design.id);
  const latestMapRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void import('@infrasim/terraform').then((mod) => {
        if (!active) return;
        const primaryProv = design.settings.primaryProvider;
        const regionOverrides =
          primaryProv === 'aws' ||
          primaryProv === 'gcp' ||
          primaryProv === 'azure' ||
          primaryProv === 'oci'
            ? { [primaryProv]: defaultRegion }
            : undefined;
        const next = mod.exportDesignToTerraform(design, {
          regions: regionOverrides,
          includeComments: true,
        });
        const nextMap: Record<string, string> = {};
        for (const f of next.files) {
          nextMap[f.filename] = f.content;
        }
        if (lastDesignIdRef.current !== design.id) {
          lastDesignIdRef.current = design.id;
          setPrevFileMap({});
        } else if (Object.keys(latestMapRef.current).length > 0) {
          setPrevFileMap(latestMapRef.current);
        }
        latestMapRef.current = nextMap;
        setResult(next);
        if (!next.files.some((f) => f.filename === activeFilename)) {
          setActiveFilename(next.files[0]?.filename ?? 'providers.tf');
        }
      });
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [design, defaultRegion, activeFilename]);

  const activeFile = useMemo(
    () => result?.files.find((f) => f.filename === activeFilename) ?? result?.files[0] ?? null,
    [result, activeFilename],
  );

  const changedFilenames = useMemo(() => {
    const changed = new Set<string>();
    if (!result) return changed;
    for (const f of result.files) {
      const prev = prevFileMap[f.filename];
      if (prev !== undefined && prev !== f.content) {
        changed.add(f.filename);
      }
    }
    return changed;
  }, [result, prevFileMap]);

  const handleCopyActive = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopiedFile(activeFile.filename);
      window.setTimeout(() => setCopiedFile(null), 1600);
    } catch {
      // Clipboard API unavailable in restricted headless contexts
    }
  };

  const handleDownloadZip = async () => {
    if (!result) return;
    setZipLoading(true);
    try {
      const mod = await import('@infrasim/terraform');
      const zipBytes = mod.exportTerraformZip(result);
      const slug = mod.snakeCaseSlug(design.name, 'infrasim').replace(/_/g, '-');
      triggerZipDownload(zipBytes, `${slug}-terraform.zip`);
    } finally {
      setZipLoading(false);
    }
  };

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-[var(--text-muted)]">
        Generating Terraform preview…
      </div>
    );
  }

  return (
    <div data-testid="terraform-dock-tab" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <span className="mr-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
            <FileCode2 className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span className="font-mono tabular-nums">{result.resourceCount}</span>
            <span>resources</span>
          </span>
          {result.files.map((file) => {
            const isActive = activeFile?.filename === file.filename;
            const isChanged = changedFilenames.has(file.filename);
            return (
              <button
                key={file.filename}
                type="button"
                data-testid={`terraform-file-tab-${file.filename}`}
                onClick={() => setActiveFilename(file.filename)}
                className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2 font-mono text-[11px] transition-colors ${
                  isActive
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                <span>{file.filename}</span>
                {isChanged ? (
                  <span
                    aria-label="Changed"
                    className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {result.unsupportedNodes.length > 0 ? (
            <span
              data-testid="terraform-unsupported-badge"
              title={result.unsupportedNodes
                .map((u) => `${u.label} (${u.serviceId}): ${u.reason}`)
                .join('\n')}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] bg-[rgba(229,160,13,0.14)] px-2 text-[11px] text-[var(--status-warm)]"
            >
              <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
              <span className="font-mono tabular-nums">{result.unsupportedNodes.length}</span>
              <span>stubbed</span>
            </span>
          ) : null}

          <button
            type="button"
            data-testid="terraform-copy-file-btn"
            onClick={() => void handleCopyActive()}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {copiedFile === activeFile?.filename ? (
              <Check className="h-3 w-3 text-[var(--status-ok)]" strokeWidth={1.5} />
            ) : (
              <Copy className="h-3 w-3" strokeWidth={1.5} />
            )}
            <span>{copiedFile === activeFile?.filename ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            data-testid="terraform-download-zip-btn"
            disabled={zipLoading}
            onClick={() => void handleDownloadZip()}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <Download className="h-3 w-3" strokeWidth={1.5} />
            <span>Download ZIP</span>
          </button>

          <button
            type="button"
            data-testid="terraform-export-options-btn"
            onClick={onOpenExportModal}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] bg-[var(--accent-solid)] px-2.5 text-[11px] font-medium text-[var(--accent-solid-text)]"
          >
            <SlidersHorizontal className="h-3 w-3" strokeWidth={1.5} />
            <span>Export options</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeFile ? (
          <HclCodeView
            content={activeFile.content}
            previousContent={prevFileMap[activeFile.filename]}
            language={activeFile.language}
            testId="terraform-dock-code-view"
          />
        ) : null}
      </div>
    </div>
  );
}
