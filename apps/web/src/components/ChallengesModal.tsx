'use client';

import { useEffect, useMemo, useState } from 'react';
import { Award, Check, ChevronRight, Lock, Trophy, X } from 'lucide-react';
import type { Challenge, ChallengeDifficulty } from '@infrasim/shared-types';
import { Button } from '@infrasim/ui-kit';
import {
  fetchChallengeLeaderboardApi,
  fetchChallengesApi,
  type ChallengeLeaderboardEntry,
  type ChallengeProgressSummary,
} from '../lib/api';

export interface ChallengesModalProps {
  open: boolean;
  token: string | null;
  activeSlug: string | null;
  progressBySlug: Record<string, ChallengeProgressSummary>;
  onClose: () => void;
  onStartChallenge: (challenge: Challenge) => void;
  onMergeRemoteProgress: (remote: Record<string, ChallengeProgressSummary | null>) => void;
}

const DIFFICULTY_LABELS: Record<ChallengeDifficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

/** Modal gallery listing the 10 starter challenges, progress, and opt-in leaderboard. */
export function ChallengesModal({
  open,
  token,
  activeSlug,
  progressBySlug,
  onClose,
  onStartChallenge,
  onMergeRemoteProgress,
}: ChallengesModalProps) {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(false);
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | ChallengeDifficulty>('all');
  const [leaderboardSlug, setLeaderboardSlug] = useState<string | null>(null);
  const [leaderboardSort, setLeaderboardSort] = useState<'score' | 'cost'>('score');
  const [leaderboardRows, setLeaderboardRows] = useState<ChallengeLeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);

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
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const localMod = await import('@infrasim/diagnosis/challenges');
      if (cancelled) return;

      try {
        const remote = await fetchChallengesApi(token);
        if (cancelled) return;
        if (remote.length > 0) {
          const remoteMap: Record<string, ChallengeProgressSummary | null> = {};
          const merged = remote.map((r) => {
            remoteMap[r.slug] = r.myProgress;
            return {
              ...r.definition,
              // Keep local starter design/scenarios clean if API omitted fields
              starterDesign: r.definition.starterDesign,
            };
          });
          onMergeRemoteProgress(remoteMap);
          setChallenges(merged);
          setLoading(false);
          return;
        }
      } catch {
        // Offline or backend challenges not yet seeded: load canonical client list cleanly
      }

      if (!cancelled) {
        setChallenges([...localMod.STARTER_CHALLENGES]);
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, token, onMergeRemoteProgress]);

  useEffect(() => {
    if (!open || !leaderboardSlug) return;
    let cancelled = false;
    setLeaderboardLoading(true);
    void fetchChallengeLeaderboardApi(leaderboardSlug, leaderboardSort)
      .then((rows) => {
        if (!cancelled) {
          setLeaderboardRows(rows);
          setLeaderboardLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLeaderboardRows([]);
          setLeaderboardLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, leaderboardSlug, leaderboardSort]);

  const filtered = useMemo(() => {
    if (difficultyFilter === 'all') return challenges;
    return challenges.filter((c) => c.difficulty === difficultyFilter);
  }, [challenges, difficultyFilter]);

  const solvedCount = useMemo(
    () => challenges.filter((c) => progressBySlug[c.slug]?.passed).length,
    [challenges, progressBySlug],
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Architecture challenges"
      data-testid="challenges-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-hairline)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Trophy className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.5} />
            <div>
              <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                Architecture challenges
              </h2>
              <p className="text-[12px] text-[var(--text-muted)]">
                Repair overloaded, insecure, or costly designs under deterministic load profiles
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              data-testid="challenges-solved-count"
              className="rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-2.5 py-1 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]"
            >
              {solvedCount}/{challenges.length || 10} solved
            </span>
            <button
              type="button"
              aria-label="Close challenges modal"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sunken)] px-5 py-2">
          <div className="flex items-center gap-1.5">
            {(['all', 'beginner', 'intermediate', 'advanced'] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                data-testid={`challenge-filter-${tier}`}
                onClick={() => setDifficultyFilter(tier)}
                className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  difficultyFilter === tier
                    ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {tier === 'all' ? 'All challenges' : DIFFICULTY_LABELS[tier]}
              </button>
            ))}
          </div>

          {!token ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span>Local verification active — sign in to save leaderboard scores</span>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
              Loading challenges...
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filtered.map((ch) => {
                const prog = progressBySlug[ch.slug];
                const isActive = activeSlug === ch.slug;
                return (
                  <article
                    key={ch.slug}
                    data-testid={`challenge-card-${ch.slug}`}
                    className={`flex flex-col justify-between rounded-[8px] border p-4 transition-colors ${
                      isActive
                        ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-sunken)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {prog?.passed ? (
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] bg-[var(--bg-surface)] text-[var(--status-ok)]"
                              title="Solved"
                            >
                              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </span>
                          ) : (
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] bg-[var(--bg-surface)] text-[var(--text-muted)]"
                              title="Not solved yet"
                            >
                              <Award className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </span>
                          )}
                          <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
                            {ch.title}
                          </h3>
                        </div>
                        <span className="shrink-0 rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                          {DIFFICULTY_LABELS[ch.difficulty]}
                        </span>
                      </div>

                      <p className="text-[12px] leading-5 text-[var(--text-secondary)]">
                        {ch.story}
                      </p>

                      <ul className="space-y-1 border-t border-[var(--border-hairline)] pt-2 text-[11px] text-[var(--text-muted)]">
                        {ch.learningGoals.map((goal) => (
                          <li key={goal} className="flex items-start gap-1.5">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--text-muted)]" />
                            <span>{goal}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-3">
                      <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                        <span>
                          {prog?.bestScore !== null && prog?.bestScore !== undefined
                            ? `Best ${prog.bestScore.toFixed(1)}`
                            : 'No runs'}
                        </span>
                        {prog && prog.attempts > 0 ? (
                          <span>
                            · {prog.attempts} {prog.attempts === 1 ? 'attempt' : 'attempts'}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setLeaderboardSlug((prev) => (prev === ch.slug ? null : ch.slug))
                          }
                          className="h-8 rounded-[6px] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
                        >
                          {leaderboardSlug === ch.slug ? 'Hide scores' : 'Leaderboard'}
                        </button>
                        <Button
                          variant={isActive ? 'secondary' : 'primary'}
                          size="sm"
                          data-testid={`start-challenge-${ch.slug}`}
                          onClick={() => {
                            onStartChallenge(ch);
                            onClose();
                          }}
                          className="h-8 px-3 text-[12px]"
                        >
                          <span>{isActive ? 'Reload starter' : 'Start'}</span>
                          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </Button>
                      </div>
                    </div>

                    {leaderboardSlug === ch.slug ? (
                      <div className="mt-3 rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11px]">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-medium text-[var(--text-primary)]">
                            Verified leaderboard
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setLeaderboardSort('score')}
                              className={`rounded-[4px] px-1.5 py-0.5 ${
                                leaderboardSort === 'score'
                                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-muted)]'
                              }`}
                            >
                              Score
                            </button>
                            <button
                              type="button"
                              onClick={() => setLeaderboardSort('cost')}
                              className={`rounded-[4px] px-1.5 py-0.5 ${
                                leaderboardSort === 'cost'
                                  ? 'bg-[var(--bg-raised)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-muted)]'
                              }`}
                            >
                              Lowest cost
                            </button>
                          </div>
                        </div>

                        {leaderboardLoading ? (
                          <div className="py-2 text-[var(--text-muted)]">Loading scores...</div>
                        ) : leaderboardRows.length === 0 ? (
                          <div className="py-2 text-[var(--text-muted)]">
                            No verified solves recorded yet
                          </div>
                        ) : (
                          <div className="space-y-1 font-mono text-[10px] tabular-nums">
                            {leaderboardRows.slice(0, 5).map((entry, idx) => (
                              <div
                                key={`${entry.displayName}-${idx}`}
                                className="flex items-center justify-between gap-2 text-[var(--text-secondary)]"
                              >
                                <span className="truncate">
                                  #{idx + 1} {entry.displayName}
                                </span>
                                <span className="shrink-0">
                                  {entry.score.toFixed(1)} ·{' '}
                                  {entry.monthlyCostUsd !== null
                                    ? `$${entry.monthlyCostUsd.toFixed(2)}/mo`
                                    : 'cost n/a'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
