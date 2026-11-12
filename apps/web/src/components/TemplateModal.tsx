'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Layers, X } from 'lucide-react';
import { Button } from '@infrasim/ui-kit';
import { STARTER_TEMPLATES, type StarterTemplate } from '../lib/templates';

export interface TemplateModalProps {
  open: boolean;
  onClose: () => void;
  onSelectTemplate: (template: StarterTemplate) => void;
}

/** Modal gallery presenting starter architectures and Phase 4 networking lessons. */
export function TemplateModal({ open, onClose, onSelectTemplate }: TemplateModalProps) {
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'starter' | 'network'>('all');

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

  const starterCount = useMemo(
    () => STARTER_TEMPLATES.filter((t) => (t.category ?? 'starter') === 'starter').length,
    [],
  );
  const networkCount = useMemo(
    () => STARTER_TEMPLATES.filter((t) => t.category === 'network').length,
    [],
  );
  const filteredTemplates = useMemo(() => {
    if (categoryFilter === 'all') return STARTER_TEMPLATES;
    return STARTER_TEMPLATES.filter((t) => (t.category ?? 'starter') === categoryFilter);
  }, [categoryFilter]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Starter templates"
      data-testid="template-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Layers className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.5} />
            <div>
              <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                Templates & networking lessons
              </h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                Load a working architecture or troubleshoot an intentionally broken multi-cloud
                network
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close templates modal"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-5 py-2">
          <button
            type="button"
            data-testid="template-filter-all"
            onClick={() => setCategoryFilter('all')}
            className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
              categoryFilter === 'all'
                ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            All ({STARTER_TEMPLATES.length})
          </button>
          <button
            type="button"
            data-testid="template-filter-starter"
            onClick={() => setCategoryFilter('starter')}
            className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
              categoryFilter === 'starter'
                ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Starter ({starterCount})
          </button>
          <button
            type="button"
            data-testid="template-filter-network"
            onClick={() => setCategoryFilter('network')}
            className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
              categoryFilter === 'network'
                ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Networking lessons ({networkCount})
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {filteredTemplates.map((tpl) => (
            <article
              key={tpl.id}
              data-testid={`template-card-${tpl.id}`}
              className="flex flex-col justify-between rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-4 transition-colors hover:border-[var(--border-strong)]"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
                    {tpl.title}
                  </h3>
                  <span className="shrink-0 rounded-[4px] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                    {tpl.design.nodes.length} nodes
                  </span>
                </div>

                <p className="text-[12px] leading-5 text-[var(--text-secondary)]">{tpl.summary}</p>

                <div className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 font-mono text-[10px] leading-4 text-[var(--text-secondary)]">
                  <div>{tpl.topologySummary}</div>
                  <div className="mt-1 tabular-nums text-[var(--text-muted)]">
                    {tpl.scenarioSummary}
                  </div>
                </div>

                <p className="text-[11px] leading-4 text-[var(--text-muted)]">{tpl.lesson}</p>
              </div>

              <div className="mt-4 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid={`load-template-${tpl.id}`}
                  onClick={() => {
                    onSelectTemplate(tpl);
                    onClose();
                  }}
                  className="h-8 px-3 text-[12px]"
                >
                  <span>Load template</span>
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </div>
            </article>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-hairline)] px-5 py-3 text-[11px] text-[var(--text-muted)]">
          <span>Additional Terraform and Challenge templates arrive in Phases 5–7.</span>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
