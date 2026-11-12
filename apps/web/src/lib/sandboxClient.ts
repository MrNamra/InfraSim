'use client';

import * as Comlink from 'comlink';
import type {
  DryRunInput,
  DryRunResult,
  FixtureSuiteReport,
  RunFixtureSuiteInput,
} from '@infrasim/sandbox';
import type { SandboxWorkerApi } from '../workers/sandbox.worker';

export const DEFAULT_WORKER_WATCHDOG_MS = 10_000;

export interface SandboxClientOptions {
  watchdogTimeoutMs?: number;
  createWorker?: () => {
    ping: () => Promise<number>;
    dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
    runSuite?: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
    terminate: () => void;
  };
}

export interface SandboxClientHandle {
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  runSuite: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
  terminate: () => void;
}

interface WorkerInstance {
  ping: () => Promise<number>;
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  runSuite?: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
  terminate: () => void;
}

/**
 * Creates a resilient Web Worker client for QuickJS-WASM guest execution.
 * Includes a 10 s heartbeat watchdog that terminates unresponsive workers and
 * spawns a fresh worker transparently. Falls back to dynamic `@infrasim/sandbox` import in SSR/tests.
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
      runSuite: (input) => remote.runSuite(input),
      terminate: () => {
        remote[Comlink.releaseProxy]();
        rawWorker.terminate();
      },
    };
    return currentWorker;
  };

  const runWithWatchdog = <T>(
    worker: WorkerInstance,
    op: () => Promise<T>,
    onTimeout: (message: string) => T,
    onCrash: (message: string) => T,
  ): Promise<T> => {
    let lastHeartbeat = Date.now();
    let abortedByWatchdog = false;

    return new Promise<T>((resolve) => {
      const failWithTimeout = (message: string) => {
        if (abortedByWatchdog) return;
        abortedByWatchdog = true;
        destroyWorker();
        resolve(onTimeout(message));
      };

      const pingIntervalMs = Math.min(2_000, Math.max(25, Math.floor(watchdogTimeoutMs / 4)));
      heartbeatTimer = setInterval(() => {
        void worker
          .ping()
          .then(() => {
            lastHeartbeat = Date.now();
          })
          .catch(() => {
            // Worker exited or failed to respond; watchdog handles teardown
          });
        if (Date.now() - lastHeartbeat > watchdogTimeoutMs) {
          failWithTimeout(
            `Sandbox worker stopped responding (>${Math.round(watchdogTimeoutMs / 1000)} s heartbeat timeout) and was restarted.`,
          );
        }
      }, pingIntervalMs);

      inFlightWatchdog = setTimeout(() => {
        if (Date.now() - lastHeartbeat >= watchdogTimeoutMs) {
          failWithTimeout(
            `Sandbox worker stopped responding (>${Math.round(watchdogTimeoutMs / 1000)} s heartbeat timeout) and was restarted.`,
          );
        }
      }, watchdogTimeoutMs + 50);

      op()
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
            resolve(onCrash(msg));
          }
        });
    });
  };

  return {
    async dryRun(input) {
      const worker = spawnWorker();
      if (!worker) {
        const mod = await import('@infrasim/sandbox');
        return mod.executeInSandbox(input);
      }

      return runWithWatchdog(
        worker,
        () => worker.dryRun(input),
        (message) => ({
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
        }),
        (msg) => ({
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
        }),
      );
    },

    async runSuite(input) {
      const worker = spawnWorker();
      if (!worker || !worker.runSuite) {
        const mod = await import('@infrasim/sandbox');
        return mod.runFixtureSuite(input);
      }
      return runWithWatchdog(
        worker,
        () => worker.runSuite!(input),
        (message) => ({
          total: input.fixtures.length,
          passed: 0,
          failed: input.fixtures.length,
          results: input.fixtures.map((f) => ({
            fixtureId: f.id,
            fixtureName: f.name,
            passed: false,
            reason: message,
            virtualDurationMs: 0,
            dryRunResult: {
              ok: false,
              seed: input.seed ?? 42,
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
            },
          })),
        }),
        (msg) => ({
          total: input.fixtures.length,
          passed: 0,
          failed: input.fixtures.length,
          results: input.fixtures.map((f) => ({
            fixtureId: f.id,
            fixtureName: f.name,
            passed: false,
            reason: msg,
            virtualDurationMs: 0,
            dryRunResult: {
              ok: false,
              seed: input.seed ?? 42,
              virtualDurationMs: 0,
              billedDurationMs: 1,
              guestCpuMs: 0,
              memoryPeakBytes: 0,
              logs: [],
              calls: [],
            },
          })),
        }),
      );
    },

    terminate: destroyWorker,
  };
}

let sharedClient: SandboxClientHandle | null = null;

/** Returns a reusable warm Web Worker sandbox client for the UI CodeTab. */
export function getSharedSandboxClient(): SandboxClientHandle {
  if (!sharedClient) {
    sharedClient = createSandboxClient();
  }
  return sharedClient;
}
