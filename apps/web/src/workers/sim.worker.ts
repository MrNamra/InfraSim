import * as Comlink from 'comlink';
import type { SimFrame, SimulationResult } from '@infrasim/shared-types';
import type { RunInput } from '@infrasim/sim-engine';
import { createLiveCodeExecutor } from '../lib/liveCodeExecutor';
import { runSimulationBatchWithDiagnosis } from '../lib/simWorkerCore';

let activeController: AbortController | null = null;

/** Comlink worker RPC surface exposed by `sim.worker.ts`. */
export interface SimWorkerApi {
  run: (input: RunInput, onFrameBatch: (frames: SimFrame[]) => void) => Promise<SimulationResult>;
  cancel: () => void;
}

const workerApi: SimWorkerApi = {
  async run(input, onFrameBatch) {
    if (activeController) {
      activeController.abort();
    }
    const controller = new AbortController();
    activeController = controller;

    try {
      const enrichedInput: RunInput =
        input.options?.liveCode && !input.liveCodeExecutor
          ? { ...input, liveCodeExecutor: createLiveCodeExecutor(input.design) }
          : input;
      return await runSimulationBatchWithDiagnosis(enrichedInput, onFrameBatch, controller.signal);
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  },

  cancel() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  },
};

Comlink.expose(workerApi);
