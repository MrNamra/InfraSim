'use client';

import * as Comlink from 'comlink';
import type {
  AutoFillDiscoveryReport,
  DryRunInput,
  DryRunResult,
  ExtractScenarioInput,
  ExtractedScenarioResult,
  FixtureSuiteReport,
  ProfileHandlerInput,
  ProfileRunSummary,
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
    autoFill?: (
      input: Omit<DryRunInput, 'mockResolver' | 'discoveryMode'>,
    ) => Promise<AutoFillDiscoveryReport>;
    profile?: (input: Omit<ProfileHandlerInput, 'mockResolver'>) => Promise<ProfileRunSummary>;
    extractScenario?: (input: ExtractScenarioInput) => Promise<ExtractedScenarioResult>;
    terminate: () => void;
  };
}

export interface SandboxClientHandle {
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  runSuite: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
  autoFill: (
    input: Omit<DryRunInput, 'mockResolver' | 'discoveryMode'>,
  ) => Promise<AutoFillDiscoveryReport>;
  profile: (input: Omit<ProfileHandlerInput, 'mockResolver'>) => Promise<ProfileRunSummary>;
  extractScenario: (input: ExtractScenarioInput) => Promise<ExtractedScenarioResult>;
  terminate: () => void;
}

interface WorkerInstance {
  ping: () => Promise<number>;
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  runSuite?: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
  autoFill?: (
    input: Omit<DryRunInput, 'mockResolver' | 'discoveryMode'>,
  ) => Promise<AutoFillDiscoveryReport>;
  profile?: (input: Omit<ProfileHandlerInput, 'mockResolver'>) => Promise<ProfileRunSummary>;
  extractScenario?: (input: ExtractScenarioInput) => Promise<ExtractedScenarioResult>;
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
      autoFill: (input) => remote.autoFill(input),
      profile: (input) => remote.profile(input),
      extractScenario: (input) => remote.extractScenario(input),
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
    overrideWatchdogMs?: number,
  ): Promise<T> => {
    const activeWatchdogMs = overrideWatchdogMs ?? watchdogTimeoutMs;
    let lastHeartbeat = Date.now();
    let abortedByWatchdog = false;

    return new Promise<T>((resolve) => {
      const failWithTimeout = (message: string) => {
        if (abortedByWatchdog) return;
        abortedByWatchdog = true;
        destroyWorker();
        resolve(onTimeout(message));
      };

      const pingIntervalMs = Math.min(2_000, Math.max(25, Math.floor(activeWatchdogMs / 4)));
      heartbeatTimer = setInterval(() => {
        void worker
          .ping()
          .then(() => {
            lastHeartbeat = Date.now();
          })
          .catch(() => {
            // Worker exited or failed to respond; watchdog handles teardown
          });
        if (Date.now() - lastHeartbeat > activeWatchdogMs) {
          failWithTimeout(
            `Sandbox worker stopped responding (>${Math.round(activeWatchdogMs / 1000)} s heartbeat timeout) and was restarted.`,
          );
        }
      }, pingIntervalMs);

      inFlightWatchdog = setTimeout(() => {
        if (Date.now() - lastHeartbeat >= activeWatchdogMs) {
          failWithTimeout(
            `Sandbox worker stopped responding (>${Math.round(activeWatchdogMs / 1000)} s heartbeat timeout) and was restarted.`,
          );
        }
      }, activeWatchdogMs + 50);

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

    async autoFill(input) {
      const worker = spawnWorker();
      if (!worker || !worker.autoFill) {
        const mod = await import('@infrasim/sandbox');
        return mod.generateAutoFillPatches(input);
      }
      return runWithWatchdog(
        worker,
        () => worker.autoFill!(input),
        (message) => ({
          ok: false,
          discoveredPaths: {},
          patches: [],
          discoveryResult: {
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
          },
        }),
        (msg) => ({
          ok: false,
          discoveredPaths: {},
          patches: [],
          discoveryResult: {
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
              message: `Auto-fill discovery crashed (${msg})`,
            },
          },
        }),
      );
    },

    async profile(input) {
      const worker = spawnWorker();
      if (!worker || !worker.profile) {
        const mod = await import('@infrasim/sandbox');
        return mod.profileHandlerScript(input);
      }
      const profileWatchdogMs = Math.max(watchdogTimeoutMs, (input.cpuBudgetMs ?? 20_000) + 5_000);
      const cpuScale = input.cpuScale ?? 0.1;
      return runWithWatchdog(
        worker,
        () => worker.profile!(input),
        (message) => ({
          callPlan: {
            scriptId: input.script.id,
            cpuMs: { distribution: 'lognormal', p50: 4, p95: 4 },
            throwProbability: 0,
            steps: [],
          },
          sampleCount: 0,
          measuredGuestCpuMs: { distribution: 'lognormal', p50: 0, p95: 0 },
          scaledCpuMs: { distribution: 'lognormal', p50: 4, p95: 4 },
          cpuScale,
          branchCount: 0,
          throwProbability: 0,
          sampledLogs: [],
          wallDurationMs: profileWatchdogMs,
          truncatedByBudget: true,
          cacheKey: '',
          error: {
            category: 'CpuBudgetExceeded',
            name: 'WorkerWatchdogTimeout',
            message,
          },
        }),
        (msg) => ({
          callPlan: {
            scriptId: input.script.id,
            cpuMs: { distribution: 'lognormal', p50: 4, p95: 4 },
            throwProbability: 0,
            steps: [],
          },
          sampleCount: 0,
          measuredGuestCpuMs: { distribution: 'lognormal', p50: 0, p95: 0 },
          scaledCpuMs: { distribution: 'lognormal', p50: 4, p95: 4 },
          cpuScale,
          branchCount: 0,
          throwProbability: 0,
          sampledLogs: [],
          wallDurationMs: 0,
          truncatedByBudget: false,
          cacheKey: '',
          error: {
            category: 'UserCodeError',
            name: 'WorkerCrashError',
            message: `Handler profiling crashed (${msg})`,
          },
        }),
        profileWatchdogMs,
      );
    },

    async extractScenario(input) {
      const worker = spawnWorker();
      if (!worker || !worker.extractScenario) {
        const mod = await import('@infrasim/sandbox');
        return mod.extractScenarioFromScript(input);
      }
      return runWithWatchdog(
        worker,
        () => worker.extractScenario!(input),
        (message) => ({
          options: {},
          flows: [],
          checkDefinitions: [],
          errors: [
            {
              category: 'CpuBudgetExceeded',
              name: 'WorkerWatchdogTimeout',
              message,
            },
          ],
        }),
        (msg) => ({
          options: {},
          flows: [],
          checkDefinitions: [],
          errors: [
            {
              category: 'UserCodeError',
              name: 'WorkerCrashError',
              message: `Scenario extraction crashed (${msg})`,
            },
          ],
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
