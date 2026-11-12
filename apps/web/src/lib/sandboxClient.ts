'use client';

import * as Comlink from 'comlink';
import { executeInSandbox, type DryRunInput, type DryRunResult } from '@infrasim/sandbox';
import type { SandboxWorkerApi } from '../workers/sandbox.worker';

export const DEFAULT_WORKER_WATCHDOG_MS = 10_000;

export interface SandboxClientOptions {
  watchdogTimeoutMs?: number;
  createWorker?: () => {
    ping: () => Promise<number>;
    dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
    terminate: () => void;
  };
}

export interface SandboxClientHandle {
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  terminate: () => void;
}

interface WorkerInstance {
  ping: () => Promise<number>;
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  terminate: () => void;
}

/**
 * Creates a resilient Web Worker client for QuickJS-WASM guest execution.
 * Includes a 10 s heartbeat watchdog that terminates unresponsive workers and
 * spawns a fresh worker transparently. Falls back to `executeInSandbox` in SSR/tests.
 */
export function createSandboxClient(options: SandboxClientOptions = {}): SandboxClientHandle {
  const watchdogTimeoutMs = options.watchdogTimeoutMs ?? DEFAULT_WORKER_WATCHDOG_MS;
  let currentWorker: WorkerInstance | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inFlightWatchdog: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (inFlightWatchdog !== null) {
      clearTimeout(inFlightWatchdog);
      inFlightWatchdog = null;
    }
  };

  const destroyWorker = () => {
    stopHeartbeat();
    if (currentWorker) {
      try {
        currentWorker.terminate();
      } finally {
        currentWorker = null;
      }
    }
  };

  const spawnWorker = (): WorkerInstance | null => {
    if (currentWorker) {
      return currentWorker;
    }
    if (options.createWorker) {
      currentWorker = options.createWorker();
      return currentWorker;
    }
    if (typeof Worker === 'undefined') {
      return null;
    }
    const rawWorker = new Worker(new URL('../workers/sandbox.worker.ts', import.meta.url), {
      type: 'module',
    });
    const remote = Comlink.wrap<SandboxWorkerApi>(rawWorker);
    currentWorker = {
      ping: () => remote.ping(),
      dryRun: (input) => remote.dryRun(input),
      terminate: () => {
        remote[Comlink.releaseProxy]();
        rawWorker.terminate();
      },
    };
    return currentWorker;
  };

  return {
    async dryRun(input) {
      const worker = spawnWorker();
      if (!worker) {
        return executeInSandbox(input);
      }

      let lastHeartbeat = Date.now();
      let abortedByWatchdog = false;

      return new Promise<DryRunResult>((resolve) => {
        const failWithTimeout = (message: string) => {
          if (abortedByWatchdog) return;
          abortedByWatchdog = true;
          destroyWorker();
          resolve({
            ok: false,
            seed: input.seed ?? input.design?.settings.seed ?? 42,
            virtualDurationMs: 0,
            billedDurationMs: 1,
            guestCpuMs: watchdogTimeoutMs,
            memoryPeakBytes: 0,
            logs: [],
            calls: [],
            error: {
              category: 'CpuBudgetExceeded',
              name: 'WorkerWatchdogTimeout',
              message,
            },
          });
        };

        // Periodic heartbeat ping while synchronous WASM work runs on the worker thread
        const pingIntervalMs = Math.min(2_000, Math.max(25, Math.floor(watchdogTimeoutMs / 4)));
        heartbeatTimer = setInterval(() => {
          void worker
            .ping()
            .then(() => {
              lastHeartbeat = Date.now();
            })
            .catch(() => {
              // Worker exited or failed to respond; watchdog timer handles teardown
            });
          if (Date.now() - lastHeartbeat > watchdogTimeoutMs) {
            failWithTimeout(
              `Sandbox worker stopped responding (>${Math.round(watchdogTimeoutMs / 1000)} s heartbeat timeout) and was restarted.`,
            );
          }
        }, pingIntervalMs);

        // Hard backstop in case event loop timers drift past deadline
        inFlightWatchdog = setTimeout(() => {
          if (Date.now() - lastHeartbeat >= watchdogTimeoutMs) {
            failWithTimeout(
              `Sandbox worker stopped responding (>${Math.round(watchdogTimeoutMs / 1000)} s heartbeat timeout) and was restarted.`,
            );
          }
        }, watchdogTimeoutMs + 50);

        worker
          .dryRun(input)
          .then((res) => {
            if (!abortedByWatchdog) {
              stopHeartbeat();
              resolve(res);
            }
          })
          .catch((err: unknown) => {
            if (!abortedByWatchdog) {
              stopHeartbeat();
              destroyWorker();
              const msg = err instanceof Error ? err.message : String(err);
              resolve({
                ok: false,
                seed: input.seed ?? input.design?.settings.seed ?? 42,
                virtualDurationMs: 0,
                billedDurationMs: 1,
                guestCpuMs: 0,
                memoryPeakBytes: 0,
                logs: [],
                calls: [],
                error: {
                  category: 'UserCodeError',
                  name: 'WorkerCrashError',
                  message: `Sandbox worker terminated unexpectedly (${msg}). Ready for next run.`,
                },
              });
            }
          });
      });
    },

    terminate: destroyWorker,
  };
}
