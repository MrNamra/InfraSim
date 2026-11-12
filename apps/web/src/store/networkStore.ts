import { create } from 'zustand';
import type { NetworkAnalysis } from '@infrasim/shared-types';

export interface NetworkStoreState {
  analysis: NetworkAnalysis | null;
  focusedEdgeId: string | null;
  lastAnalysisMs: number | null;
  setAnalysis: (analysis: NetworkAnalysis | null, durationMs?: number) => void;
  setFocusedEdgeId: (edgeId: string | null) => void;
}

/** Zustand store caching debounced reachability analysis and focused edge selection for canvas & dock UIs. */
export const useNetworkStore = create<NetworkStoreState>((set) => ({
  analysis: null,
  focusedEdgeId: null,
  lastAnalysisMs: null,
  setAnalysis: (analysis, durationMs) =>
    set({
      analysis,
      ...(durationMs !== undefined ? { lastAnalysisMs: durationMs } : {}),
    }),
  setFocusedEdgeId: (focusedEdgeId) => set({ focusedEdgeId }),
}));
