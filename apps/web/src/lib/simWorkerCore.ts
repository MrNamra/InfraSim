import { CATALOG_SERVICES } from '@infrasim/catalog';
import { diagnose } from '@infrasim/diagnosis';
import { analyzeDesignNetwork } from '@infrasim/network-analyzer';
import type { SimFrame, SimulationResult } from '@infrasim/shared-types';
import { type RunInput, SimulationAbortedError, runSimulation } from '@infrasim/sim-engine';

/** Default frame batch throttle window (100 ms => at most 10 worker IPC batches/sec). */
export const WORKER_FRAME_BATCH_MS = 100;

export { SimulationAbortedError };

/**
 * Executes a simulation cleanly, buffering emitted `SimFrame` snapshots into at most
 * 10 batches per second and attaching deterministic `Why?` diagnostic insights on completion.
 */
export async function runSimulationBatchWithDiagnosis(
  input: RunInput,
  onFrameBatch: (frames: SimFrame[]) => void,
  signal?: AbortSignal,
  batchWindowMs = WORKER_FRAME_BATCH_MS,
): Promise<SimulationResult> {
  let batch: SimFrame[] = [];
  let lastFlushMs = performance.now();

  const flushBatch = () => {
    if (batch.length === 0) {
      return;
    }
    const out = batch;
    batch = [];
    lastFlushMs = performance.now();
    onFrameBatch(out);
  };

  let effectiveInput = input;
  if (input.options?.liveCode && !input.liveCodeExecutor) {
    const { createLiveCodeExecutor } = await import('./liveCodeExecutor');
    effectiveInput = {
      ...input,
      liveCodeExecutor: createLiveCodeExecutor(input.design),
    };
  }

  const catalog = [...CATALOG_SERVICES, ...(input.design.customServices ?? [])];
  const network =
    input.network ??
    analyzeDesignNetwork(input.design, {
      customServices: input.design.customServices,
    });
  effectiveInput = {
    ...effectiveInput,
    network,
  };

  const result = await runSimulation(
    effectiveInput,
    (frame) => {
      batch.push(frame);
      if (performance.now() - lastFlushMs >= batchWindowMs) {
        flushBatch();
      }
    },
    signal,
  );

  flushBatch();

  const insights = diagnose({ design: input.design, result, catalog, network });
  return {
    ...result,
    insights,
  };
}
