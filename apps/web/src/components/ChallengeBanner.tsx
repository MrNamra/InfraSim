'use client';

import { useState } from 'react';
import { Check, Eye, HelpCircle, Play, RotateCcw, Trophy, X } from 'lucide-react';
import type { Challenge, ChallengeAttemptResult, Design } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';

export interface ChallengeBannerProps {
  challenge: Challenge;
  evaluation: ChallengeAttemptResult | null;
  evalSource: 'server' | 'local' | null;
  evalError: string | null;
  evaluating: boolean;
  attemptsCount: number;
  revealedSolution: { design: Design; whatThisTeaches: string } | null;
  onVerifyRun: () => void;
  onResetStarter: () => void;
  onRevealSolution: () => Promise<void>;
  onApplyRevealedSolution: (solutionDesign: Design) => void;
  onExitChallenge: () => void;
}

/** Compact live challenge HUD bar anchored above the canvas with real-time constraints and hints. */
export function ChallengeBanner({
  challenge,
  evaluation,
  evalSource,
  evalError,
  evaluating,
  attemptsCount,
  revealedSolution,
  onVerifyRun,
  onResetStarter,
  onRevealSolution,
  onApplyRevealedSolution,
  onExitChallenge,
}: ChallengeBannerProps) {
  const [hintsOpen, setHintsOpen] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [revealing, setRevealing] = useState(false);

  const unlockedHints = challenge.hints.filter((h) => attemptsCount >= h.afterAttempts);
  const nextLockedHint = challenge.hints.find((h) => attemptsCount < h.afterAttempts);

  const handleConfirmReveal = async () => {
    setRevealing(true);
    try {
      await onRevealSolution();
      setConfirmReveal(false);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section
      data-testid="challenge-banner"
      aria-label={`Active challenge: ${challenge.title}`}
      className="shrink-0 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Trophy
            className={`h-4 w-4 shrink-0 ${
              evaluation?.passed ? 'text-[var(--status-ok)]' : 'text-[var(--text-secondary)]'
            }`}
            strokeWidth={1.5}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                {challenge.title}
              </span>
              <span className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                {challenge.difficulty}
              </span>
              <span
                data-testid="challenge-attempts-badge"
                className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]"
              >
                {attemptsCount} {attemptsCount === 1 ? 'attempt' : 'attempts'}
              </span>
              {evaluation ? (
                <span
                  data-testid="challenge-score-badge"
                  className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums ${
                    evaluation.passed
                      ? 'bg-[var(--bg-raised)] text-[var(--status-ok)]'
                      : 'bg-[var(--bg-raised)] text-[var(--status-overloaded)]'
                  }`}
                >
                  {evaluation.passed ? 'Pass' : 'Fail'} · {evaluation.score.toFixed(1)}/100
                  {evalSource ? ` (${evalSource})` : ''}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-[var(--text-muted)]">{challenge.story}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            data-testid="challenge-verify-btn"
            disabled={evaluating}
            onClick={onVerifyRun}
            className="h-7 px-2.5 text-[11px]"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>{evaluating ? 'Checking...' : 'Run & verify'}</span>
          </Button>

          <button
            type="button"
            data-testid="challenge-hints-btn"
            onClick={() => setHintsOpen((prev) => !prev)}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <HelpCircle className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>
              Hints ({unlockedHints.length}/{challenge.hints.length})
            </span>
          </button>

          <button
            type="button"
            data-testid="challenge-reset-btn"
            onClick={onResetStarter}
            title="Restore broken starter design"
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
            <span>Reset</span>
          </button>

          {confirmReveal ? (
            <div className="flex items-center gap-1 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-sunken)] px-2 py-0.5 text-[11px]">
              <span className="text-[var(--text-secondary)]">Show solution?</span>
              <button
                type="button"
                data-testid="challenge-confirm-reveal-btn"
                disabled={revealing}
                onClick={() => void handleConfirmReveal()}
                className="rounded-[4px] bg-[var(--accent)] px-1.5 py-0.5 font-medium text-[var(--bg-canvas)] disabled:opacity-50"
              >
                {revealing ? 'Loading...' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmReveal(false)}
                className="px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="challenge-reveal-btn"
              onClick={() => setConfirmReveal(true)}
              className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-raised)] px-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <Eye className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.5} />
              <span>Reveal solution</span>
            </button>
          )}

          <button
            type="button"
            data-testid="challenge-exit-btn"
            aria-label="Exit challenge mode"
            onClick={onExitChallenge}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Live constraint checklist chips */}
      <div
        data-testid="challenge-constraints-list"
        className="mt-2 flex flex-wrap items-center gap-1.5"
      >
        {evaluation ? (
          evaluation.checks.map((chk) => (
            <span
              key={chk.id}
              data-testid={`challenge-check-${chk.id}`}
              data-passed={chk.passed ? 'true' : 'false'}
              className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-0.5 text-[11px] ${
                chk.passed
                  ? 'border-[var(--border-hairline)] bg-[var(--bg-sunken)] text-[var(--text-primary)]'
                  : 'border-[var(--status-overloaded)] bg-[var(--bg-sunken)] text-[var(--text-primary)]'
              }`}
            >
              {chk.passed ? (
                <Check className="h-3 w-3 shrink-0 text-[var(--status-ok)]" strokeWidth={1.5} />
              ) : (
                <X className="h-3 w-3 shrink-0 text-[var(--status-overloaded)]" strokeWidth={1.5} />
              )}
              <span>{chk.label}</span>
              {chk.actual ? (
                <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                  ({chk.actual})
                </span>
              ) : null}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">
            Run simulation to evaluate all hard constraints
          </span>
        )}
      </div>

      {evalError ? (
        <div
          data-testid="challenge-eval-error"
          className="mt-2 rounded-[6px] border border-[var(--status-overloaded)] bg-[var(--bg-sunken)] px-2.5 py-1.5 text-[11px] text-[var(--status-overloaded)]"
        >
          {evalError}
        </div>
      ) : null}

      {hintsOpen ? (
        <div
          data-testid="challenge-hints-drawer"
          className="mt-2 space-y-1 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[11px]"
        >
          {unlockedHints.length > 0 ? (
            unlockedHints.map((hint, idx) => (
              <div key={idx} className="text-[var(--text-primary)]">
                Hint {idx + 1}: {hint.text}
              </div>
            ))
          ) : (
            <div className="text-[var(--text-muted)]">No hints unlocked yet</div>
          )}
          {nextLockedHint ? (
            <div className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
              Next hint unlocks after {nextLockedHint.afterAttempts}{' '}
              {nextLockedHint.afterAttempts === 1 ? 'attempt' : 'attempts'}
            </div>
          ) : null}
        </div>
      ) : null}

      {evaluation?.passed || revealedSolution ? (
        <div
          data-testid="challenge-debrief-box"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-3 py-2 text-[11px]"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium text-[var(--text-primary)]">
              What this teaches:{' '}
              <span className="font-normal text-[var(--text-secondary)]">
                {revealedSolution?.whatThisTeaches || challenge.whatThisTeaches}
              </span>
            </div>
            {evaluation ? (
              <div className="flex flex-wrap gap-3 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                <span>Latency {evaluation.subScores.latency}</span>
                <span>Cost {evaluation.subScores.cost}</span>
                <span>Resilience {evaluation.subScores.resilience}</span>
                <span>Security {evaluation.subScores.security}</span>
                <span>Simplicity {evaluation.subScores.simplicity}</span>
              </div>
            ) : null}
          </div>

          {revealedSolution ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="challenge-apply-solution-btn"
              onClick={() => onApplyRevealedSolution(revealedSolution.design)}
              className="h-7 shrink-0 px-2.5 text-[11px]"
            >
              Load reference solution onto canvas
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
