'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileCode2,
  History,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { Design } from '@infrasim/shared-types';
import type { HclSyntaxError, TerraformExportResult } from '@infrasim/terraform';
import { HclCodeView } from '../HclCodeView';

export interface TerraformInspectorTabProps {
  design: Design;
  defaultRegion: string;
  onApplyPatchedDesign: (design: Design, changeLabel: string) => void;
  onOpenExportModal: () => void;
  selectedNodeId?: string | null;
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

export function TerraformInspectorTab({
  design,
  defaultRegion,
  onApplyPatchedDesign,
  onOpenExportModal,
}: TerraformInspectorTabProps) {
  const [result, setResult] = useState<TerraformExportResult | null>(null);
  const [prevFileMap, setPrevFileMap] = useState<Record<string, string>>({});
  const [activeFilename, setActiveFilename] = useState<string>('compute.tf');
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({});
  const [syntaxErrors, setSyntaxErrors] = useState<HclSyntaxError[]>([]);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'editor' | 'diff'>('editor');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [zipLoading, setZipLoading] = useState(false);

  const lastDesignIdRef = useRef<string>(design.id);
  const latestMapRef = useRef<Record<string, string>>({});
  const isUserTypingRef = useRef(false);
  const typingTimerRef = useRef<number | null>(null);
  const lastSyncedDesignRef = useRef<string>(JSON.stringify(design));

  // Regenerate Terraform when design changes from canvas (debounced)
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
          setFileDrafts(nextMap);
        } else if (!isUserTypingRef.current) {
          if (Object.keys(latestMapRef.current).length > 0) {
            setPrevFileMap(latestMapRef.current);
          }
          setFileDrafts((prev) => {
            // Only update files that don't have pending syntax errors
            if (syntaxErrors.length > 0) {
              return prev;
            }
            return { ...prev, ...nextMap };
          });
        }

        latestMapRef.current = nextMap;
        setResult(next);

        // If current active filename not in export, pick compute.tf or first available
        if (!next.files.some((f) => f.filename === activeFilename)) {
          const preferred =
            next.files.find((f) => f.filename === 'compute.tf')?.filename ??
            next.files[0]?.filename ??
            'providers.tf';
          setActiveFilename(preferred);
        }
      });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [design, defaultRegion, activeFilename, syntaxErrors.length]);

  const activeContent = useMemo(() => {
    if (fileDrafts[activeFilename] !== undefined) {
      return fileDrafts[activeFilename];
    }
    const fromExport = result?.files.find((f) => f.filename === activeFilename);
    return fromExport ? fromExport.content : '';
  }, [fileDrafts, activeFilename, result]);

  const activeLanguage = useMemo<'hcl' | 'markdown'>(() => {
    return activeFilename.endsWith('.md') ? 'markdown' : 'hcl';
  }, [activeFilename]);

  // Handle live user editing in HCL editor
  const handleEditorChange = useCallback(
    (newContent: string) => {
      isUserTypingRef.current = true;
      setFileDrafts((prev) => ({ ...prev, [activeFilename]: newContent }));

      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
      }

      typingTimerRef.current = window.setTimeout(async () => {
        try {
          const mod = await import('@infrasim/terraform');
          // Validate and parse
          const syncRes = mod.syncTerraformHclToDesign(design, newContent, activeFilename);

          if (syncRes.errors.length > 0) {
            setSyntaxErrors(syncRes.errors);
            setSyncNotice(null);
            // DO NOT update design: keep canvas UI completely safe!
            return;
          }

          // Valid syntax! Clear errors
          setSyntaxErrors([]);

          if (syncRes.changed) {
            const nextJson = JSON.stringify(syncRes.design);
            if (nextJson !== lastSyncedDesignRef.current) {
              lastSyncedDesignRef.current = nextJson;
              onApplyPatchedDesign(
                syncRes.design,
                syncRes.summary ?? 'Synced changes from Terraform HCL',
              );
              setSyncNotice('Applied to canvas');
              window.setTimeout(() => setSyncNotice(null), 2500);
            }
          }
        } finally {
          isUserTypingRef.current = false;
        }
      }, 160);
    },
    [activeFilename, design, onApplyPatchedDesign],
  );

  // Reset file draft to generated code
  const handleResetToGenerated = useCallback(() => {
    const original = latestMapRef.current[activeFilename];
    if (original !== undefined) {
      setFileDrafts((prev) => ({ ...prev, [activeFilename]: original }));
      setSyntaxErrors([]);
      setSyncNotice('Reverted to generated HCL');
      window.setTimeout(() => setSyncNotice(null), 2000);
    }
  }, [activeFilename]);

  const handleCopyActive = async () => {
    try {
      await navigator.clipboard.writeText(activeContent);
      setCopiedFile(activeFilename);
      window.setTimeout(() => setCopiedFile(null), 1600);
    } catch {
      // Fallback
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

  // Support indenting with 2 spaces on Tab key press in textarea
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const updated = val.substring(0, start) + '  ' + val.substring(end);
      handleEditorChange(updated);
      window.requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  const lineCount = useMemo(() => {
    return activeContent.split('\n').length;
  }, [activeContent]);

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-[var(--text-muted)]">
        Generating Terraform architecture…
      </div>
    );
  }

  return (
    <div
      data-testid="terraform-dock-tab"
      className="flex min-h-0 flex-1 flex-col bg-[var(--bg-surface)]"
    >
      {/* Top Header Toolbar */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <FileCode2 className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.5} />
            <span className="text-[12px] font-medium text-[var(--text-primary)]">
              Terraform IaC
            </span>
            <span className="rounded-[4px] bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
              {result.resourceCount} resource{result.resourceCount === 1 ? '' : 's'}
            </span>
            {syncNotice ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--status-ok)] transition-opacity">
                <CheckCircle2 className="h-3 w-3" />
                <span>{syncNotice}</span>
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="terraform-mode-toggle"
              onClick={() => setViewMode((m) => (m === 'editor' ? 'diff' : 'editor'))}
              title={viewMode === 'editor' ? 'Switch to diff view' : 'Switch to live code editor'}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              {viewMode === 'editor' ? (
                <>
                  <History className="h-3 w-3" strokeWidth={1.5} />
                  <span>Diff</span>
                </>
              ) : (
                <>
                  <Code2 className="h-3 w-3" strokeWidth={1.5} />
                  <span>Edit</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="terraform-copy-file-btn"
              onClick={() => void handleCopyActive()}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              {copiedFile === activeFilename ? (
                <Check className="h-3 w-3 text-[var(--status-ok)]" strokeWidth={1.5} />
              ) : (
                <Copy className="h-3 w-3" strokeWidth={1.5} />
              )}
              <span>{copiedFile === activeFilename ? 'Copied' : 'Copy'}</span>
            </button>

            <button
              type="button"
              data-testid="terraform-download-zip-btn"
              disabled={zipLoading}
              onClick={() => void handleDownloadZip()}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <Download className="h-3 w-3" strokeWidth={1.5} />
              <span>ZIP</span>
            </button>

            <button
              type="button"
              data-testid="terraform-export-options-btn"
              onClick={onOpenExportModal}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] bg-[var(--accent-solid)] px-2 text-[11px] font-medium text-[var(--accent-solid-text)]"
            >
              <SlidersHorizontal className="h-3 w-3" strokeWidth={1.5} />
              <span>Export</span>
            </button>
          </div>
        </div>

        {/* File Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {result.files.map((file) => {
            const isActive = activeFilename === file.filename;
            const hasLocalDraft =
              fileDrafts[file.filename] !== undefined &&
              fileDrafts[file.filename] !== latestMapRef.current[file.filename];
            return (
              <button
                key={file.filename}
                type="button"
                data-testid={`terraform-file-tab-${file.filename}`}
                onClick={() => {
                  setActiveFilename(file.filename);
                  setSyntaxErrors([]);
                }}
                className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2 font-mono text-[11px] transition-colors ${
                  isActive
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                <span>{file.filename}</span>
                {hasLocalDraft ? (
                  <span
                    aria-label="Modified"
                    className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Syntax Error Banner */}
      {syntaxErrors.length > 0 ? (
        <div
          data-testid="terraform-syntax-error"
          className="flex shrink-0 flex-col gap-1 border-b border-[rgba(229,72,77,0.3)] bg-[rgba(229,72,77,0.08)] px-3 py-2 text-[12px] text-[var(--status-overloaded)]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} />
              <div>
                <div className="font-medium text-[var(--status-overloaded)]">
                  Terraform Syntax Error
                </div>
                <div className="font-mono text-[11px] text-[var(--text-secondary)]">
                  {syntaxErrors[0]?.message} (Line {syntaxErrors[0]?.line}:{syntaxErrors[0]?.column}
                  )
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleResetToGenerated}
              title="Revert edits to match current canvas"
              className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-[rgba(229,72,77,0.4)] px-1.5 text-[10px] text-[var(--text-secondary)] hover:bg-[rgba(229,72,77,0.12)] hover:text-[var(--text-primary)]"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">
            Canvas updates paused until syntax errors are resolved.
          </div>
        </div>
      ) : null}

      {/* Unsupported resources notification if any */}
      {result.unsupportedNodes.length > 0 && syntaxErrors.length === 0 ? (
        <div
          data-testid="terraform-unsupported-badge"
          className="flex shrink-0 items-center justify-between border-b border-[rgba(229,160,13,0.2)] bg-[rgba(229,160,13,0.08)] px-3 py-1.5 text-[11px] text-[var(--status-warm)]"
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>
              {result.unsupportedNodes.length} resource
              {result.unsupportedNodes.length === 1 ? '' : 's'} stubbed (no provider mapping)
            </span>
          </div>
        </div>
      ) : null}

      {/* Main Content Area */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {viewMode === 'diff' ? (
          <div data-testid="terraform-dock-code-view" className="h-full">
            <HclCodeView
              content={activeContent}
              previousContent={prevFileMap[activeFilename]}
              language={activeLanguage}
              testId="terraform-dock-code-view"
            />
          </div>
        ) : (
          <div
            data-testid="terraform-dock-code-view"
            className="flex h-full overflow-hidden bg-[var(--bg-sunken)]"
          >
            {/* Line Numbers Gutter */}
            <div
              aria-hidden="true"
              className="w-10 select-none overflow-hidden border-r border-[var(--border-hairline)] bg-[var(--bg-surface)] py-3 pr-2 text-right font-mono text-[11px] leading-[20px] text-[var(--text-muted)]"
            >
              {Array.from({ length: lineCount }, (_, i) => {
                const lineNo = i + 1;
                const isErrorLine = syntaxErrors.some((err) => err.line === lineNo);
                return (
                  <div
                    key={lineNo}
                    className={
                      isErrorLine
                        ? 'font-bold text-[var(--status-overloaded)]'
                        : 'text-[var(--text-muted)]'
                    }
                  >
                    {lineNo}
                  </div>
                );
              })}
            </div>

            {/* Editable Textarea */}
            <textarea
              data-testid="terraform-hcl-editor"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={activeContent}
              onChange={(e) => handleEditorChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-full w-full resize-none overflow-auto bg-transparent p-3 font-mono text-[11px] leading-[20px] text-[var(--text-primary)] outline-none focus:ring-0"
            />
          </div>
        )}
      </div>
    </div>
  );
}
