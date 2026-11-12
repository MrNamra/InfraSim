import { create } from 'zustand';
import type { Challenge, ChallengeAttemptResult, Design } from '@infrasim/shared-types';
import type { ChallengeProgressSummary } from '../lib/api';

const STORAGE_KEY = 'infrasim.challengeProgress.v1';

function readStoredProgress(): Record<string, ChallengeProgressSummary> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ChallengeProgressSummary>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredProgress(progress: Record<string, ChallengeProgressSummary>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Ignore storage quota issues cleanly
  }
}

export interface ChallengeStoreState {
  activeChallenge: Challenge | null;
  lastEvaluation: ChallengeAttemptResult | null;
  evalSource: 'server' | 'local' | null;
  evalError: string | null;
  evaluating: boolean;
  revealedSolution: { design: Design; whatThisTeaches: string } | null;
  progressBySlug: Record<string, ChallengeProgressSummary>;

  hydrateProgress: () => void;
  mergeRemoteProgress: (remote: Record<string, ChallengeProgressSummary | null>) => void;
  startChallenge: (challenge: Challenge) => void;
  exitChallenge: () => void;
  setEvaluating: (evaluating: boolean) => void;
  recordEvaluation: (
    slug: string,
    result: ChallengeAttemptResult,
    source: 'server' | 'local',
    serverAttemptsCount?: number,
    revealed?: { design: Design; whatThisTeaches: string } | null,
  ) => void;
  setEvalError: (error: string | null) => void;
  setRevealedSolution: (solution: { design: Design; whatThisTeaches: string } | null) => void;
}

export const useChallengeStore = create<ChallengeStoreState>((set, get) => ({
  activeChallenge: null,
  lastEvaluation: null,
  evalSource: null,
  evalError: null,
  evaluating: false,
  revealedSolution: null,
  progressBySlug: {},

  hydrateProgress: () => {
    set({ progressBySlug: readStoredProgress() });
  },

  mergeRemoteProgress: (remote) => {
    const current = { ...get().progressBySlug };
    for (const [slug, summary] of Object.entries(remote)) {
      if (!summary) continue;
      const existing = current[slug];
      if (!existing) {
        current[slug] = summary;
      } else {
        const bestScore =
          existing.bestScore !== null && summary.bestScore !== null
            ? Math.max(existing.bestScore, summary.bestScore)
            : (summary.bestScore ?? existing.bestScore);
        current[slug] = {
          attempts: Math.max(existing.attempts, summary.attempts),
          bestScore,
          passed: existing.passed || summary.passed,
        };
      }
    }
    writeStoredProgress(current);
    set({ progressBySlug: current });
  },

  startChallenge: (challenge) => {
    set({
      activeChallenge: challenge,
      lastEvaluation: null,
      evalSource: null,
      evalError: null,
      evaluating: false,
      revealedSolution: null,
    });
  },

  exitChallenge: () => {
    set({
      activeChallenge: null,
      lastEvaluation: null,
      evalSource: null,
      evalError: null,
      evaluating: false,
      revealedSolution: null,
    });
  },

  setEvaluating: (evaluating) => set({ evaluating }),

  recordEvaluation: (slug, result, source, serverAttemptsCount, revealed) => {
    const prevMap = { ...get().progressBySlug };
    const existing = prevMap[slug] ?? { attempts: 0, bestScore: null, passed: false };
    const nextAttempts =
      typeof serverAttemptsCount === 'number' ? serverAttemptsCount : existing.attempts + 1;
    const nextBest =
      existing.bestScore === null ? result.score : Math.max(existing.bestScore, result.score);
    prevMap[slug] = {
      attempts: nextAttempts,
      bestScore: nextBest,
      passed: existing.passed || result.passed,
    };
    writeStoredProgress(prevMap);

    set((state) => ({
      lastEvaluation: result,
      evalSource: source,
      evalError: null,
      evaluating: false,
      progressBySlug: prevMap,
      revealedSolution: revealed !== undefined ? revealed : state.revealedSolution,
    }));
  },

  setEvalError: (evalError) => set({ evalError, evaluating: false }),

  setRevealedSolution: (revealedSolution) => set({ revealedSolution }),
}));
