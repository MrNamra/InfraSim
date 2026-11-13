'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Compass, X } from 'lucide-react';
import { Button } from '@infrasim/ui-kit';

export interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
  onNavigateStep?: (stepIndex: number) => void;
}

interface TourStep {
  step: number;
  title: string;
  badge: string;
  description: string;
  shortcut?: string;
  targetArea: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    step: 1,
    title: 'Add cloud services',
    badge: 'Palette',
    description:
      'Drag or double-click services from the left catalog onto your canvas. Pick from AWS, GCP, Azure, OCI, or generic provider-neutral blocks.',
    shortcut: 'Double-click to place',
    targetArea: 'Left palette panel',
  },
  {
    step: 2,
    title: 'Wire traffic edges',
    badge: 'Canvas',
    description:
      'Connect services by dragging between handles, or select any node and press E to wire via the keyboard connect bar.',
    shortcut: 'Press E on selected node',
    targetArea: 'Main architecture canvas',
  },
  {
    step: 3,
    title: 'Tune latency & mock logic',
    badge: 'Inspector',
    description:
      'Configure p50/p95 latency distributions, instance scaling, and queue limits in the right inspector, or write custom TypeScript mock handlers.',
    shortcut: 'Enter on node opens Inspector',
    targetArea: 'Right inspector panel',
  },
  {
    step: 4,
    title: 'Run discrete-event simulation',
    badge: 'Simulation',
    description:
      'Click Run in the top bar to simulate 30 seconds of live traffic. Observe animated request flow, queue buildup, and real-time node saturation.',
    shortcut: 'Space or click Run',
    targetArea: 'Top bar playback controls',
  },
  {
    step: 5,
    title: 'Diagnose bottlenecks with Why?',
    badge: 'Insights',
    description:
      'When nodes turn red or drop requests, open the Why? tab in the bottom dock to review ranked root causes and apply 1-click architecture fixes.',
    shortcut: 'Click Why? in bottom dock',
    targetArea: 'Bottom dock Insights tab',
  },
];

export function OnboardingTour({ open, onClose, onNavigateStep }: OnboardingTourProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setCurrentStepIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
        return;
      }
      if (e.key === 'ArrowRight' && currentStepIndex < TOUR_STEPS.length - 1) {
        e.preventDefault();
        goToStep(currentStepIndex + 1);
        return;
      }
      if (e.key === 'ArrowLeft' && currentStepIndex > 0) {
        e.preventDefault();
        goToStep(currentStepIndex - 1);
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, currentStepIndex]);

  if (!open) return null;

  const currentStep = TOUR_STEPS[currentStepIndex]!;
  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex === TOUR_STEPS.length - 1;

  const handleDismiss = () => {
    try {
      localStorage.setItem('infrasim.tourCompleted', 'true');
    } catch {
      // Storage unavailable
    }
    onClose();
  };

  const goToStep = (index: number) => {
    setCurrentStepIndex(index);
    onNavigateStep?.(index);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome onboarding tour"
      data-testid="onboarding-tour-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-lg rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-floating)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--accent)]">
              <Compass className="h-4 w-4" strokeWidth={1.5} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                  Step {currentStep.step} of {TOUR_STEPS.length}
                </span>
                <span className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                  {currentStep.badge}
                </span>
              </div>
              <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--text-primary)]">
                {currentStep.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            data-testid="tour-close-btn"
            aria-label="Close tour"
            onClick={handleDismiss}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Body content */}
        <div className="mt-4 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-4">
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {currentStep.description}
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-3 text-[11px]">
            <span className="text-[var(--text-muted)]">
              Target:{' '}
              <strong className="font-medium text-[var(--text-secondary)]">
                {currentStep.targetArea}
              </strong>
            </span>
            {currentStep.shortcut ? (
              <span className="font-mono text-[var(--accent)]">{currentStep.shortcut}</span>
            ) : null}
          </div>
        </div>

        {/* Progress indicator pills */}
        <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden="true">
          {TOUR_STEPS.map((s, idx) => (
            <button
              key={s.step}
              type="button"
              aria-label={`Go to step ${s.step}`}
              onClick={() => goToStep(idx)}
              className={`h-1.5 rounded-full transition-all ${
                idx === currentStepIndex
                  ? 'w-6 bg-[var(--accent)]'
                  : idx < currentStepIndex
                    ? 'w-2.5 bg-[var(--text-muted)]'
                    : 'w-2 bg-[var(--border-strong)]'
              }`}
            />
          ))}
        </div>

        {/* Footer controls */}
        <div className="mt-6 flex items-center justify-between gap-3 border-t border-[var(--border-hairline)] pt-4">
          <button
            type="button"
            data-testid="tour-skip-btn"
            onClick={handleDismiss}
            className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Skip tour
          </button>

          <div className="flex items-center gap-2">
            {!isFirst ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="tour-prev-btn"
                onClick={() => goToStep(currentStepIndex - 1)}
                className="gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                Back
              </Button>
            ) : null}

            {!isLast ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="tour-next-btn"
                onClick={() => goToStep(currentStepIndex + 1)}
                className="gap-1.5"
              >
                Next
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                data-testid="tour-finish-btn"
                onClick={handleDismiss}
                className="gap-1.5"
              >
                <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                Finish tour
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
