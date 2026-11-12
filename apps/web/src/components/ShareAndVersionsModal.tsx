'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  History,
  Link2,
  RotateCcw,
  Share2,
  X,
} from 'lucide-react';
import type { Design } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import {
  createDesignApi,
  DesignVersionConflictError,
  fetchDesignVersionsApi,
  listDesignsApi,
  shareDesignApi,
  updateDesignApi,
  type CloudDesignSummary,
  type CloudDesignVersion,
} from '../lib/api';
import { encodeSharedDesignFragment } from '../lib/shareEncoding';

export interface ShareAndVersionsModalProps {
  open: boolean;
  token: string | null;
  design: Design;
  onClose: () => void;
  onRestoreDesign: (doc: Design) => void;
  onNotice: (msg: string) => void;
}

/** Modal providing read-only share links, cloud save snapshots, optimistic version conflict resolution, and version history. */
export function ShareAndVersionsModal({
  open,
  token,
  design,
  onClose,
  onRestoreDesign,
  onNotice,
}: ShareAndVersionsModalProps) {
  const [tab, setTab] = useState<'share' | 'versions'>('share');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cloudDesigns, setCloudDesigns] = useState<CloudDesignSummary[]>([]);
  const [activeCloudId, setActiveCloudId] = useState<string | null>(null);
  const [activeCloudVersion, setActiveCloudVersion] = useState<number>(1);
  const [versions, setVersions] = useState<CloudDesignVersion[]>([]);
  const [conflictState, setConflictState] = useState<{
    currentVersion: number;
    latestDoc: Design;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConflictState(null);
    setCopied(false);

    // Pre-populate self-contained offline read-only link immediately
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const fragment = encodeSharedDesignFragment(design);
    setShareUrl(`${origin}/shared/inline#${fragment}`);

    if (!token) {
      setCloudDesigns([]);
      setVersions([]);
      return;
    }

    let cancelled = false;
    void listDesignsApi(token)
      .then((list) => {
        if (cancelled) return;
        setCloudDesigns(list);
        const match = list.find((d) => d.id === design.id);
        if (match) {
          setActiveCloudId(match.id);
          setActiveCloudVersion(match.version);
          if (match.shareToken) {
            setShareUrl(`${origin}/shared/${match.shareToken}`);
          }
          void fetchDesignVersionsApi(token, match.id)
            .then((vers) => {
              if (!cancelled) setVersions(vers);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open, token, design]);

  const handleCopy = async () => {
    if (!shareUrl || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      onNotice('Copy failed — select and copy the URL directly');
    }
  };

  const handleSaveCloudVersion = async (forceVersion?: number): Promise<string | null> => {
    if (!token) {
      setError('Sign in first to save cloud design versions.');
      return null;
    }
    setBusy(true);
    setError(null);
    setConflictState(null);

    try {
      let saved;
      if (activeCloudId) {
        saved = await updateDesignApi(
          token,
          activeCloudId,
          forceVersion ?? activeCloudVersion,
          design,
        );
      } else {
        saved = await createDesignApi(token, design);
      }
      setActiveCloudId(saved.id);
      setActiveCloudVersion(saved.version);
      const [vers, list] = await Promise.all([
        fetchDesignVersionsApi(token, saved.id),
        listDesignsApi(token),
      ]);
      setVersions(vers);
      setCloudDesigns(list);
      onNotice(`Saved "${saved.name}" (v${saved.version})`);
      return saved.id;
    } catch (err) {
      if (err instanceof DesignVersionConflictError) {
        setConflictState({
          currentVersion: err.currentVersion,
          latestDoc: err.latestDoc,
        });
      } else {
        setError(err instanceof Error ? err.message : 'Unable to save cloud design.');
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCloudShare = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      let targetId = activeCloudId;
      if (!targetId) {
        targetId = await handleSaveCloudVersion();
      }
      if (!targetId) return;

      const shared = await shareDesignApi(token, targetId, false);
      if (shared.shareToken) {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        setShareUrl(`${origin}/shared/${shared.shareToken}`);
        onNotice('Published unlisted read-only share link');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish share link.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectCloudDesign = async (summary: CloudDesignSummary) => {
    if (!token) return;
    setActiveCloudId(summary.id);
    setActiveCloudVersion(summary.version);
    const vers = await fetchDesignVersionsApi(token, summary.id).catch(() => []);
    setVersions(vers);
    if (vers[0]?.doc) {
      onRestoreDesign(structuredClone(vers[0].doc));
      onNotice(`Loaded "${summary.name}" v${summary.version}`);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share and design versions"
      data-testid="share-versions-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Share2 className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.5} />
            <div>
              <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                Share & design versions
              </h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                Create read-only snapshots (env secrets stripped) or manage saved cloud versions
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-label="Close share modal"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-5 py-2">
          <button
            type="button"
            data-testid="share-tab-link"
            onClick={() => setTab('share')}
            className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
              tab === 'share'
                ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Read-only link</span>
          </button>
          <button
            type="button"
            data-testid="share-tab-versions"
            onClick={() => setTab('versions')}
            className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
              tab === 'versions'
                ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <History className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>Versions & cloud save</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 text-[12px]">
          {error ? (
            <div className="rounded-[8px] border border-[var(--status-overloaded)] bg-[var(--bg-sunken)] px-3 py-2 text-[var(--status-overloaded)]">
              {error}
            </div>
          ) : null}

          {tab === 'share' ? (
            <div className="space-y-3">
              <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-[var(--text-primary)]">
                    Read-only viewer URL
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    Secrets removed automatically
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    data-testid="share-url-input"
                    aria-label="Read-only share URL"
                    value={shareUrl}
                    className="h-8 min-w-0 flex-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 font-mono text-[11px] text-[var(--text-secondary)] focus:outline-none"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="share-copy-btn"
                    onClick={() => void handleCopy()}
                    className="h-8 shrink-0 px-2.5 text-[11px]"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-[var(--status-ok)]" strokeWidth={1.5} />
                    ) : (
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  {token ? (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="share-publish-cloud-btn"
                      disabled={busy}
                      onClick={() => void handleCreateCloudShare()}
                      className="h-8 px-3 text-[11px]"
                    >
                      <Cloud className="h-3.5 w-3.5" strokeWidth={1.5} />
                      <span>{busy ? 'Publishing...' : 'Publish cloud share token'}</span>
                    </Button>
                  ) : (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Portable snapshot URL ready — sign in to issue a short server link
                    </span>
                  )}

                  {shareUrl ? (
                    <a
                      href={shareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="share-open-viewer-link"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
                    >
                      <span>Open read-only view</span>
                      <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {conflictState ? (
                <div
                  data-testid="version-conflict-banner"
                  className="space-y-2 rounded-[8px] border border-[var(--status-warm)] bg-[var(--bg-sunken)] p-3"
                >
                  <div className="font-medium text-[var(--text-primary)]">
                    Version conflict: server has v{conflictState.currentVersion}
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Choose whether to load the newer cloud snapshot or overwrite with your current
                    canvas.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        onRestoreDesign(structuredClone(conflictState.latestDoc));
                        setActiveCloudVersion(conflictState.currentVersion);
                        setConflictState(null);
                        onNotice(`Loaded server v${conflictState.currentVersion}`);
                      }}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      Load server v{conflictState.currentVersion}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSaveCloudVersion(conflictState.currentVersion)}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      Overwrite as v{conflictState.currentVersion + 1}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between">
                <div className="text-[12px] text-[var(--text-secondary)]">
                  {activeCloudId ? (
                    <span>
                      Linked cloud design ·{' '}
                      <span className="font-mono tabular-nums">v{activeCloudVersion}</span>
                    </span>
                  ) : (
                    <span>Local design — save to create v1 in cloud storage</span>
                  )}
                </div>

                <Button
                  variant="primary"
                  size="sm"
                  data-testid="save-cloud-version-btn"
                  disabled={!token || busy}
                  onClick={() => void handleSaveCloudVersion()}
                  className="h-8 px-3 text-[11px]"
                >
                  <Cloud className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>
                    {busy ? 'Saving...' : activeCloudId ? 'Save new version' : 'Save to cloud'}
                  </span>
                </Button>
              </div>

              {versions.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Version history
                  </div>
                  <div className="divide-y divide-[var(--border-hairline)] rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)]">
                    {versions.map((ver) => (
                      <div
                        key={ver.id}
                        className="flex items-center justify-between px-3 py-2 text-[11px]"
                      >
                        <div className="flex items-center gap-2 font-mono tabular-nums">
                          <span className="font-medium text-[var(--text-primary)]">
                            v{ver.version}
                          </span>
                          <span className="text-[var(--text-muted)]">
                            {ver.createdAt ? new Date(ver.createdAt).toLocaleString() : 'Saved'}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onRestoreDesign(structuredClone(ver.doc));
                            onNotice(`Restored snapshot v${ver.version}`);
                            onClose();
                          }}
                          className="inline-flex items-center gap-1 rounded-[4px] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
                        >
                          <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
                          <span>Restore</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {cloudDesigns.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Your cloud designs
                  </div>
                  <div className="divide-y divide-[var(--border-hairline)] rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)]">
                    {cloudDesigns.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => void handleSelectCloudDesign(row)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] hover:bg-[var(--bg-raised)]"
                      >
                        <span className="truncate font-medium text-[var(--text-primary)]">
                          {row.name}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-[var(--text-muted)]">
                          v{row.version} · {row.nodeCount} nodes
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
