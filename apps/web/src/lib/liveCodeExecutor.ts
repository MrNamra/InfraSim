import type { Design } from '@infrasim/shared-types';
import type { LiveCodeExecutor } from '@infrasim/sim-engine';
import type * as SandboxModule from '@infrasim/sandbox';

function getWorkerOrigin(): string {
  return typeof self !== 'undefined' && self.location ? self.location.origin : '';
}

/**
 * Creates a cached `LiveCodeExecutor` backed by QuickJS-WASM and esbuild-wasm.
 * Bundles each handler script once per simulation run and executes every invocation deterministically.
 */
export function createLiveCodeExecutor(design: Design): LiveCodeExecutor {
  const origin = getWorkerOrigin();
  const quickJsWasmUrl = origin ? `${origin}/wasm/quickjs-release-sync.wasm` : undefined;
  const esbuildWasmUrl = origin ? `${origin}/wasm/esbuild.wasm` : undefined;

  const bundleCache = new Map<
    string,
    Promise<{ code: string; sourceMapJson?: string } | { errorMessage: string }>
  >();
  let sandboxModPromise: Promise<typeof SandboxModule> | null = null;

  const getSandbox = () => {
    if (!sandboxModPromise) {
      sandboxModPromise = import('@infrasim/sandbox');
    }
    return sandboxModPromise;
  };

  const getOrCompile = (scriptId: string) => {
    const existing = bundleCache.get(scriptId);
    if (existing) return existing;

    const script = design.scripts.find((s) => s.id === scriptId);
    if (!script) {
      const missing = Promise.resolve({ errorMessage: `Script "${scriptId}" not found` });
      bundleCache.set(scriptId, missing);
      return missing;
    }

    const compiling = getSandbox().then(async ({ bundleUserScript }) => {
      const res = await bundleUserScript({
        entryScript: script,
        designScripts: design.scripts,
        ...(esbuildWasmUrl ? { esbuildWasmUrl } : {}),
      });
      if (!res.ok || !res.code) {
        return { errorMessage: res.errors?.[0]?.message ?? 'Failed to compile script' };
      }
      return {
        code: res.code,
        ...(res.sourceMapJson ? { sourceMapJson: res.sourceMapJson } : {}),
      };
    });
    bundleCache.set(scriptId, compiling);
    return compiling;
  };

  return async (params) => {
    const { executeInSandbox } = await getSandbox();
    const script = params.design.scripts.find((s) => s.id === params.scriptId);
    if (!script) {
      return {
        ok: false,
        cpuMs: 0.2,
        virtualDurationMs: 0,
        errorKind: 'user_code',
        errorMessage: `Script "${params.scriptId}" not found`,
        logs: [],
        calls: [],
      };
    }

    const compiled = await getOrCompile(params.scriptId);
    if ('errorMessage' in compiled) {
      return {
        ok: false,
        cpuMs: 0.2,
        virtualDurationMs: 0,
        errorKind: 'user_code',
        errorMessage: compiled.errorMessage,
        logs: [],
        calls: [],
      };
    }

    const res = await executeInSandbox({
      script,
      designScripts: params.design.scripts,
      design: params.design,
      node: params.node,
      ...(params.design.customServices ? { customServices: params.design.customServices } : {}),
      seed: params.seed,
      seq: params.seq,
      event: params.event,
      coldStart: params.coldStart,
      emitPlatformLogs: params.emitPlatformLogs,
      requestId: params.requestId,
      ...(params.traceId ? { traceId: params.traceId } : {}),
      prebuiltBundle: compiled,
      ...(quickJsWasmUrl ? { quickJsWasmUrl } : {}),
      ...(esbuildWasmUrl ? { esbuildWasmUrl } : {}),
    });

    return {
      ok: res.ok,
      cpuMs: res.guestCpuMs,
      virtualDurationMs: res.virtualDurationMs,
      ...(res.error ? { errorKind: 'user_code' as const, errorMessage: res.error.message } : {}),
      logs: res.logs,
      calls: res.calls.map((c) => ({
        serviceId: c.serviceId,
        op: c.op,
        ...(c.targetNodeId ? { targetNodeId: c.targetNodeId } : {}),
        latencyMs: c.latencyMs,
        payloadBytes: c.payloadBytes,
        responseBytes: c.responseBytes,
        ...(c.parallelGroup ? { parallelGroup: c.parallelGroup } : {}),
        ...(c.alias ? { alias: c.alias } : {}),
        ...(c.error ? { errorKind: 'server' as const } : {}),
      })),
    };
  };
}
