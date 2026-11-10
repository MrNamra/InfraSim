'use client';

import { useEffect } from 'react';
import { ArrowRight, Layers, X } from 'lucide-react';
import { Button } from '@infrasim/ui-kit';
import { STARTER_TEMPLATES, type StarterTemplate } from '../lib/templates';

export interface TemplateModalProps {
  open: boolean;
  onClose: () => void;
  onSelectTemplate: (template: StarterTemplate) => void;
}

/** Modal gallery presenting Phase 1 starter infrastructure designs. */
export function TemplateModal({ open, onClose, onSelectTemplate }: TemplateModalProps) {
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
      <div className="w-full max-w-2xl rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Layers className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.5} />
            <div>
              <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                Starter templates
              </h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                Load a complete simulated topology with traffic scenario and capacity defaults
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

        <div className="grid gap-3 p-5 sm:grid-cols-2">
          {STARTER_TEMPLATES.map((tpl) => (
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

        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-5 py-3 text-[11px] text-[var(--text-muted)]">
          <span>
            Additional templates (Serverless, Queue Pipeline, Retry Storm, RAG, Networking) arrive
            in Phases 2–7.
          </span>
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
