import * as Comlink from 'comlink';
import {
  bundleUserScript,
  executeInSandbox,
  generateAutoFillPatches,
  runFixtureSuite,
  type AutoFillDiscoveryReport,
  type BundleResult,
  type BundleScriptInput,
  type DryRunInput,
  type DryRunResult,
  type FixtureSuiteReport,
  type RunFixtureSuiteInput,
} from '@infrasim/sandbox';

/** Comlink worker RPC surface exposed by `sandbox.worker.ts`. */
export interface SandboxWorkerApi {
  ping: () => number;
  bundle: (input: Omit<BundleScriptInput, 'sdkGenerator'>) => Promise<BundleResult>;
  dryRun: (input: Omit<DryRunInput, 'mockResolver'>) => Promise<DryRunResult>;
  runSuite: (input: Omit<RunFixtureSuiteInput, 'mockResolver'>) => Promise<FixtureSuiteReport>;
  autoFill: (
    input: Omit<DryRunInput, 'mockResolver' | 'discoveryMode'>,
  ) => Promise<AutoFillDiscoveryReport>;
}

function getOrigin(): string {
  return typeof self !== 'undefined' && self.location ? self.location.origin : '';
}

const workerApi: SandboxWorkerApi = {
  ping() {
    return Date.now();
  },

  async bundle(input) {
    const origin = getOrigin();
    return bundleUserScript({
      ...input,
      esbuildWasmUrl: input.esbuildWasmUrl ?? (origin ? `${origin}/wasm/esbuild.wasm` : undefined),
    });
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

  async runSuite(input) {
    const origin = getOrigin();
    return runFixtureSuite({
      ...input,
      quickJsWasmUrl:
        input.quickJsWasmUrl ?? (origin ? `${origin}/wasm/quickjs-release-sync.wasm` : undefined),
      esbuildWasmUrl: input.esbuildWasmUrl ?? (origin ? `${origin}/wasm/esbuild.wasm` : undefined),
    });
  },

  async autoFill(input) {
    const origin = getOrigin();
    return generateAutoFillPatches({
      ...input,
      quickJsWasmUrl:
        input.quickJsWasmUrl ?? (origin ? `${origin}/wasm/quickjs-release-sync.wasm` : undefined),
      esbuildWasmUrl: input.esbuildWasmUrl ?? (origin ? `${origin}/wasm/esbuild.wasm` : undefined),
    });
  },
};

Comlink.expose(workerApi);
