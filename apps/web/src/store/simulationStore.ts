import { create } from 'zustand';
import type { Design, LogEntry, SimFrame, SimulationResult } from '@infrasim/shared-types';
import { type SimRunnerHandle, createSimRunner } from '../lib/simRunner';
import { SimulationAbortedError } from '../lib/simWorkerCore';

export const MAX_LOG_RING_BUFFER = 50_000;

/** Appends new log entries into a bounded FIFO ring buffer preserving the latest `cap` rows. */
export function appendLogsToRingBuffer(
  existing: readonly LogEntry[],
  incoming: readonly LogEntry[],
  cap = MAX_LOG_RING_BUFFER,
): LogEntry[] {
  if (incoming.length === 0) {
    return existing.length <= cap
      ? (existing as LogEntry[])
      : existing.slice(existing.length - cap);
  }
  const safeCap = Math.max(1, cap);
  if (incoming.length >= safeCap) {
    return incoming.slice(incoming.length - safeCap);
  }
  const overflow = existing.length + incoming.length - safeCap;
  if (overflow <= 0) {
    return existing.length === 0 ? [...incoming] : [...existing, ...incoming];
  }
  return [...existing.slice(overflow), ...incoming];
}

export type SimSpeed = '1' | '5' | '20' | 'max';
export type SimRunStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'error';

export function hasLoadGeneratorNode(design: Design): boolean {
  return design.nodes.some(
    (n) => n.serviceId === 'generic.client' || n.serviceId === 'generic.users',
  );
}

/**
 * Chooses the best initial inspection frame after a `'max'` speed run completes:
 * if any frame had an overloaded node while the final frame recovered cleanly (e.g. a mid-run spike),
 * jumps directly to peak overload so the user sees the failure immediately.
 */
export function pickLandingFrameIndex(frames: readonly SimFrame[]): number {
  if (frames.length === 0) {
    return -1;
  }
  const lastIdx = frames.length - 1;
  const lastFrame = frames[lastIdx]!;
  const lastHasOverload = Object.values(lastFrame.nodes).some((nf) => nf.health === 'overloaded');
  if (lastHasOverload) {
    return lastIdx;
  }

  let peakIdx = -1;
  let peakScore = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    let overloadedCount = 0;
    let utilSum = 0;
    for (const nf of Object.values(f.nodes)) {
      if (nf.health === 'overloaded') {
        overloadedCount += 1;
      }
      utilSum += nf.utilization;
    }
    if (overloadedCount > 0) {
      const score = overloadedCount * 100 + utilSum;
      if (score > peakScore) {
        peakScore = score;
        peakIdx = i;
      }
    }
  }

  return peakIdx >= 0 ? peakIdx : lastIdx;
}

export interface SimulationStoreState {
  status: SimRunStatus;
  errorMessage: string | null;
  frames: SimFrame[];
  playbackIdx: number;
  virtualPlayheadMs: number;
  playing: boolean;
  speed: SimSpeed;
  durationS: number;
  elapsedWallMs: number | null;
  result: SimulationResult | null;
  previousResult: SimulationResult | null;
  logs: LogEntry[];
  missingClientPromptOpen: boolean;
  lastRunDesignId: string | null;

  appendLogs: (entries: readonly LogEntry[]) => void;
  clearLogs: () => void;

  runSimulation: (
    design: Design,
    scenarioId: string,
    opts?: { allowMissingClient?: boolean; seedOverride?: number },
  ) => Promise<{ started: boolean; reason?: 'no-client' | 'no-nodes' | 'aborted' | 'error' }>;
  cancelRun: () => void;
  stopPlayback: () => void;
  togglePausePlayback: () => void;
  scrubTo: (idx: number) => void;
  seekToTimeS: (tS: number) => void;
  advancePlayback: (deltaWallMs: number) => void;
  setSpeed: (speed: SimSpeed) => void;
  dismissMissingClientPrompt: () => void;
  resetSimulation: (clearPrevious?: boolean) => void;
}

let activeRunner: SimRunnerHandle | null = null;
let activeAbortController: AbortController | null = null;
let activeRunToken = 0;

function getRunner(): SimRunnerHandle {
  if (!activeRunner) {
    activeRunner = createSimRunner();
  }
  return activeRunner;
}

/** Replaces the simulation runner factory in unit tests and cleans up any prior handle. */
export function setSimRunnerForTests(customRunner: SimRunnerHandle | null): void {
  if (activeRunner) {
    activeRunner.terminate();
  }
  activeRunner = customRunner;
}

export const useSimulationStore = create<SimulationStoreState>((set, get) => ({
  status: 'idle',
  errorMessage: null,
  frames: [],
  playbackIdx: -1,
  virtualPlayheadMs: 0,
  playing: false,
  speed: 'max',
  durationS: 60,
  elapsedWallMs: null,
  result: null,
  previousResult: null,
  logs: [],
  missingClientPromptOpen: false,
  lastRunDesignId: null,

  appendLogs: (entries) => {
    if (entries.length === 0) return;
    set((state) => ({
      logs: appendLogsToRingBuffer(state.logs, entries),
    }));
  },

  clearLogs: () => set({ logs: [] }),

  runSimulation: async (design, scenarioId, opts) => {
    if (design.nodes.length === 0) {
      set({ missingClientPromptOpen: true });
      return { started: false, reason: 'no-nodes' };
    }

    if (!opts?.allowMissingClient && !hasLoadGeneratorNode(design)) {
      set({ missingClientPromptOpen: true });
      return { started: false, reason: 'no-client' };
    }

    if (activeAbortController) {
      activeAbortController.abort();
      getRunner().cancel();
    }

    const token = ++activeRunToken;
    const controller = new AbortController();
    activeAbortController = controller;

    const scenario = design.scenarios.find((s) => s.id === scenarioId) ?? design.scenarios[0];
    const durationS = Math.max(1, scenario?.durationS ?? 60);
    const prevResult = get().lastRunDesignId === design.id ? get().result : null;

    set({
      missingClientPromptOpen: false,
      status: 'running',
      errorMessage: null,
      frames: [],
      playbackIdx: -1,
      virtualPlayheadMs: 0,
      playing: false,
      durationS,
      elapsedWallMs: null,
      previousResult: prevResult,
      result: null,
      logs: [],
      lastRunDesignId: design.id,
    });

    const t0 = performance.now();
    try {
      const simResult = await getRunner().run(
        {
          design: structuredClone(design),
          scenarioId: scenario?.id ?? scenarioId,
          ...(opts?.seedOverride !== undefined ? { seed: opts.seedOverride } : {}),
        },
        (batch) => {
          if (token !== activeRunToken || batch.length === 0) {
            return;
          }
          const batchLogs: LogEntry[] = [];
          for (const frame of batch) {
            if (frame.newLogs.length > 0) {
              batchLogs.push(...frame.newLogs);
            }
          }
          set((state) => {
            const nextFrames = state.frames.length === 0 ? batch : [...state.frames, ...batch];
            const nextIdx =
              state.speed === 'max' ? nextFrames.length - 1 : Math.max(0, state.playbackIdx);
            return {
              frames: nextFrames,
              playbackIdx: nextIdx,
              virtualPlayheadMs: nextFrames[nextIdx]?.tVirtualMs ?? 0,
              logs:
                batchLogs.length > 0 ? appendLogsToRingBuffer(state.logs, batchLogs) : state.logs,
            };
          });
        },
        controller.signal,
      );

      if (token !== activeRunToken) {
        return { started: false, reason: 'aborted' };
      }

      const elapsedWallMs = Math.round(performance.now() - t0);
      const { frames, speed } = get();
      const shouldAnimatePlayback = speed !== 'max' && frames.length > 1;
      const landingIdx = shouldAnimatePlayback ? 0 : pickLandingFrameIndex(frames);

      set({
        status: 'completed',
        result: simResult,
        elapsedWallMs,
        playbackIdx: landingIdx,
        virtualPlayheadMs: landingIdx >= 0 ? (frames[landingIdx]?.tVirtualMs ?? 0) : 0,
        playing: shouldAnimatePlayback,
      });

      return { started: true };
    } catch (err) {
      if (token !== activeRunToken) {
        return { started: false, reason: 'aborted' };
      }
      if (
        err instanceof SimulationAbortedError ||
        (err instanceof Error && err.name === 'SimulationAbortedError') ||
        controller.signal.aborted
      ) {
        set({
          status: 'cancelled',
          playing: false,
        });
        return { started: false, reason: 'aborted' };
      }

      const message = err instanceof Error ? err.message : 'Simulation failed unexpectedly';
      set({
        status: 'error',
        errorMessage: message,
        playing: false,
      });
      return { started: false, reason: 'error' };
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
    }
  },

  cancelRun: () => {
    activeRunToken += 1;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    getRunner().cancel();
    set({
      status: 'cancelled',
      playing: false,
    });
  },

  stopPlayback: () => {
    const { status, playing } = get();
    if (status === 'running') {
      get().cancelRun();
      return;
    }
    if (playing) {
      set({ playing: false });
    }
  },

  togglePausePlayback: () => {
    const { status, playing, frames, playbackIdx, speed } = get();
    if (status === 'running') {
      get().cancelRun();
      return;
    }
    if (frames.length === 0) {
      return;
    }
    if (playing) {
      set({ playing: false });
      return;
    }
    const atEnd = playbackIdx >= frames.length - 1 || playbackIdx < 0;
    const restartIdx = atEnd ? 0 : playbackIdx;
    set({
      playbackIdx: restartIdx,
      virtualPlayheadMs: frames[restartIdx]?.tVirtualMs ?? 0,
      speed: speed === 'max' ? '1' : speed,
      playing: true,
    });
  },

  scrubTo: (idx) => {
    const { frames } = get();
    if (frames.length === 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(frames.length - 1, Math.round(idx)));
    set({
      playbackIdx: clamped,
      virtualPlayheadMs: frames[clamped]?.tVirtualMs ?? 0,
      playing: false,
    });
  },

  seekToTimeS: (tS) => {
    const { frames } = get();
    if (frames.length === 0) {
      return;
    }
    const targetMs = Math.max(0, tS * 1000);
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid]!.tVirtualMs < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let bestIdx = lo;
    if (lo > 0) {
      const prevDiff = Math.abs(targetMs - frames[lo - 1]!.tVirtualMs);
      const currDiff = Math.abs(frames[lo]!.tVirtualMs - targetMs);
      if (prevDiff < currDiff) {
        bestIdx = lo - 1;
      }
    }
    set({
      playbackIdx: bestIdx,
      virtualPlayheadMs: frames[bestIdx]?.tVirtualMs ?? 0,
      playing: false,
    });
  },

  advancePlayback: (deltaWallMs) => {
    const { playing, frames, playbackIdx, speed, virtualPlayheadMs } = get();
    if (!playing || frames.length === 0) {
      return;
    }
    if (speed === 'max') {
      const landingIdx = pickLandingFrameIndex(frames);
      set({
        playbackIdx: landingIdx,
        virtualPlayheadMs: frames[landingIdx]?.tVirtualMs ?? 0,
        playing: false,
      });
      return;
    }
    const mult = Number(speed);
    const nextVirtualMs = Math.max(
      frames[Math.max(0, playbackIdx)]?.tVirtualMs ?? 0,
      virtualPlayheadMs + Math.max(1, deltaWallMs) * mult,
    );
    let nextIdx = Math.max(0, playbackIdx);
    while (nextIdx + 1 < frames.length && frames[nextIdx + 1]!.tVirtualMs <= nextVirtualMs) {
      nextIdx += 1;
    }
    const reachedEnd = nextIdx >= frames.length - 1;
    set({
      playbackIdx: nextIdx,
      virtualPlayheadMs: nextVirtualMs,
      playing: !reachedEnd,
    });
  },

  setSpeed: (speed) => set({ speed }),

  dismissMissingClientPrompt: () => set({ missingClientPromptOpen: false }),

  resetSimulation: (clearPrevious = false) => {
    activeRunToken += 1;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    getRunner().cancel();
    set((state) => ({
      status: 'idle',
      errorMessage: null,
      frames: [],
      playbackIdx: -1,
      virtualPlayheadMs: 0,
      playing: false,
      elapsedWallMs: null,
      result: null,
      logs: [],
      missingClientPromptOpen: false,
      previousResult: clearPrevious ? null : state.previousResult,
    }));
  },
}));
