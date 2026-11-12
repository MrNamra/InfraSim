import * as Comlink from 'comlink';
import { executeInSandbox, type DryRunInput, type DryRunResult } from '@infrasim/sandbox';

/** Comlink worker RPC surface exposed by `sandbox.worker.ts`. */
export interface SandboxWorkerApi {
  ping: () => number;
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
}

function getOrigin(): string {
  return typeof self !== 'undefined' && self.location ? self.location.origin : '';
}

const workerApi: SandboxWorkerApi = {
  ping() {
    return Date.now();
  },

  async dryRun(input) {
    const origin = getOrigin();
    return executeInSandbox({
      ...input,
      quickJsWasmUrl:
        input.quickJsWasmUrl ?? (origin ? `${origin}/wasm/quickjs-release-sync.wasm` : undefined),
      esbuildWasmUrl: input.esbuildWasmUrl ?? (origin ? `${origin}/wasm/esbuild.wasm` : undefined),
    });
  },
};

Comlink.expose(workerApi);
