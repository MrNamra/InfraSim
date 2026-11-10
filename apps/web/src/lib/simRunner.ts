'use client';

import * as Comlink from 'comlink';
import type { SimFrame, SimulationResult } from '@infrasim/shared-types';
import type { RunInput } from '@infrasim/sim-engine';
import type { SimWorkerApi } from '../workers/sim.worker';
import { runSimulationBatchWithDiagnosis } from './simWorkerCore';

export interface SimRunnerHandle {
  run: (
    input: RunInput,
    onFrameBatch: (frames: SimFrame[]) => void,
    signal?: AbortSignal,
  ) => Promise<SimulationResult>;
  cancel: () => void;
  terminate: () => void;
}

/**
 * Instantiates a Comlink-wrapped Web Worker client for off-thread discrete-event simulation.
 * Falls back gracefully to in-process async execution only in non-Worker environments (SSR/Node tests).
 */
export function createSimRunner(): SimRunnerHandle {
  let worker: Worker | null = null;
  let proxy: Comlink.Remote<SimWorkerApi> | null = null;
  let fallbackController: AbortController | null = null;

  const ensureWorker = (): Comlink.Remote<SimWorkerApi> | null => {
    if (typeof Worker === 'undefined') {
      return null;
    }
    if (!worker) {
      worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), {
        type: 'module',
      });
      proxy = Comlink.wrap<SimWorkerApi>(worker);
    }
    return proxy;
  };

  const cancel = () => {
    if (fallbackController) {
      fallbackController.abort();
      fallbackController = null;
    }
    if (proxy) {
      void proxy.cancel();
    }
  };

  const terminate = () => {
    cancel();
    if (proxy) {
      proxy[Comlink.releaseProxy]();
      proxy = null;
    }
    if (worker) {
      worker.terminate();
      worker = null;
    }
  };

  return {
    async run(input, onFrameBatch, signal) {
      const remote = ensureWorker();
      if (!remote) {
        fallbackController = new AbortController();
        if (signal) {
          if (signal.aborted) {
            fallbackController.abort();
          } else {
            signal.addEventListener('abort', () => fallbackController?.abort(), { once: true });
          }
        }
        return runSimulationBatchWithDiagnosis(input, onFrameBatch, fallbackController.signal);
      }

      const abortListener = () => {
        void remote.cancel();
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      try {
        return await remote.run(input, Comlink.proxy(onFrameBatch));
      } finally {
        signal?.removeEventListener('abort', abortListener);
      }
    },
    cancel,
    terminate,
  };
}
