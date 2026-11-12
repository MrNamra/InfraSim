import {
  type QuickJSWASMModule,
  RELEASE_SYNC,
  getQuickJS,
  newQuickJSWASMModule,
  newVariant,
} from 'quickjs-emscripten';
import type { LogEntry, NodeInstance } from '@infrasim/shared-types';
import { bundleUserScript } from './bundler.js';
import { buildGuestPrelude } from './guestPrelude.js';
import { createMockCallResolver } from './mockResolver.js';
import { attachProviderPlatformLogs } from './platformLogs.js';
import { createSeededPrng, hashSeedParts } from './prng.js';
import { SourceMapTranslator } from './sourceMap.js';
import {
  DEFAULT_DRY_RUN_LIMITS,
  type DetectedCallRecord,
  type DryRunInput,
  type DryRunResult,
  MAX_GUEST_MEMORY_MB,
  type MockCallInvocation,
  type MockCallOutcome,
  type MockCallResolver,
  type SandboxErrorReport,
  type SandboxLimits,
  type SourceLocation,
} from './types.js';

interface VirtualEvent {
  atMs: number;
  seq: number;
  kind: 'timer' | 'mock';
  timerId?: number;
  repeatMs?: number;
  callId?: number;
  callOk?: boolean;
  payloadJson?: string;
}

const textEncoder = new TextEncoder();

const cachedModules = new Map<string, Promise<QuickJSWASMModule>>();

/** Loads (and caches per WASM URL) the isolated QuickJS WASM module for Node or Web Workers. */
export async function loadQuickJsModule(wasmUrl?: string): Promise<QuickJSWASMModule> {
  const cacheKey = wasmUrl ?? '__default__';
  const existing = cachedModules.get(cacheKey);
  if (existing) {
    return existing;
  }
  const loader = wasmUrl
    ? newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmLocation: wasmUrl }))
    : getQuickJS();
  cachedModules.set(cacheKey, loader);
  return loader;
}

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function truncateUtf8(str: string, maxBytes: number): string {
  const bytes = textEncoder.encode(str);
  if (bytes.length <= maxBytes) {
    return str;
  }
  const suffix = ' ...[truncated]';
  const target = Math.max(0, maxBytes - suffix.length);
  let cut = Math.min(str.length, target);
  while (cut > 0 && textEncoder.encode(str.slice(0, cut)).length > target) {
    cut = Math.floor(cut * 0.9);
  }
  return str.slice(0, cut) + suffix;
}

function buildEffectiveEnv(
  node: NodeInstance | undefined,
  scriptEnv: Record<string, string> | undefined,
  overrideEnv: Record<string, string> | undefined,
): Record<string, string> {
  const region = node?.region || 'us-east-1';
  const provider = node?.serviceId.split('.')[0] ?? 'aws';
  return {
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    GCP_PROJECT: `infrasim-${provider}`,
    GCP_REGION: region,
    AZURE_REGION: region,
    OCI_REGION: region,
    NODE_ENV: 'simulation',
    ...(node?.config.mockEnv ?? {}),
    ...(scriptEnv ?? {}),
    ...(overrideEnv ?? {}),
  };
}

function parseFirstSiteFromStack(
  stack: string | undefined,
  translator: SourceMapTranslator,
): SourceLocation | undefined {
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    const match = /\(?bundle\.js:(\d+)(?::(\d+))?\)?/.exec(line);
    if (match) {
      return translator.resolve(Number(match[1]), match[2] ? Number(match[2]) : 1);
    }
  }
  return undefined;
}

function normalizeQuickJsError(
  errObj: unknown,
  limits: SandboxLimits,
  translator: SourceMapTranslator,
  defaultCategory: SandboxErrorReport['category'] = 'UserCodeError',
  oomInterrupted = false,
): SandboxErrorReport {
  const rawName =
    errObj && typeof errObj === 'object' && 'name' in errObj
      ? String((errObj as { name: unknown }).name)
      : 'Error';
  const rawMessage =
    errObj && typeof errObj === 'object' && 'message' in errObj
      ? String((errObj as { message: unknown }).message)
      : String(errObj ?? 'Unknown error');
  const rawStack =
    errObj &&
    typeof errObj === 'object' &&
    'stack' in errObj &&
    (errObj as { stack?: unknown }).stack
      ? String((errObj as { stack?: unknown }).stack)
      : undefined;

  const { stack, firstSite } = translator.rewriteStack(rawStack, 'bundle.js');

  const lowerMsg = rawMessage.toLowerCase();
  if (oomInterrupted || lowerMsg.includes('out of memory')) {
    return {
      category: 'OutOfMemory',
      name: 'OutOfMemory',
      message: `Memory limit exceeded (${limits.memoryMb} MB)`,
      ...(stack ? { stack } : {}),
      ...(firstSite ? { site: firstSite } : {}),
    };
  }

  if (
    lowerMsg.includes('interrupted') ||
    rawName === 'CpuBudgetExceeded' ||
    lowerMsg.includes('cpu budget')
  ) {
    return {
      category: 'CpuBudgetExceeded',
      name: 'CpuBudgetExceeded',
      message: 'Possible infinite loop — stopped',
      ...(stack ? { stack } : {}),
      ...(firstSite ? { site: firstSite } : {}),
    };
  }

  if (lowerMsg.includes('stack overflow')) {
    return {
      category: 'UserCodeError',
      name: 'RangeError',
      message: 'Maximum call stack size exceeded (1 MB stack limit)',
      ...(stack ? { stack } : {}),
      ...(firstSite ? { site: firstSite } : {}),
    };
  }

  const extraCategory =
    errObj && typeof errObj === 'object' && 'category' in errObj
      ? String((errObj as { category: unknown }).category)
      : undefined;
  const statusCode =
    errObj &&
    typeof errObj === 'object' &&
    typeof (errObj as { statusCode?: unknown }).statusCode === 'number'
      ? (errObj as { statusCode: number }).statusCode
      : errObj &&
          typeof errObj === 'object' &&
          (errObj as { $metadata?: { httpStatusCode?: unknown } }).$metadata &&
          typeof (errObj as { $metadata?: { httpStatusCode?: unknown } }).$metadata
            ?.httpStatusCode === 'number'
        ? (errObj as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode
        : undefined;

  let category = defaultCategory;
  if (extraCategory === 'MockNotConfigured') category = 'MockNotConfigured';
  else if (extraCategory === 'MockServiceError') category = 'MockServiceError';
  else if (extraCategory === 'ValidationError') category = 'ValidationError';
  else if (extraCategory === 'UnsupportedModule') category = 'UnsupportedModule';

  const details =
    errObj && typeof errObj === 'object' && 'details' in errObj
      ? ((errObj as { details?: Record<string, unknown> }).details ?? undefined)
      : undefined;

  return {
    category,
    name: rawName,
    message: rawMessage,
    ...(stack ? { stack } : {}),
    ...(firstSite ? { site: firstSite } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * Runs a single user handler invocation inside an isolated QuickJS-WASM runtime
 * using deterministic virtual time, resource limits, and seeded randomness.
 */
export async function executeInSandbox(input: DryRunInput): Promise<DryRunResult> {
  const seed = input.seed ?? input.design?.settings.seed ?? 42;
  const seq = input.seq ?? 1;
  const prng = createSeededPrng(hashSeedParts(seed, seq, input.script.id));

  const memoryMb = Math.min(
    MAX_GUEST_MEMORY_MB,
    Math.max(
      16,
      input.limits?.memoryMb ?? input.script.memoryMb ?? DEFAULT_DRY_RUN_LIMITS.memoryMb,
    ),
  );
  const limits: SandboxLimits = {
    ...DEFAULT_DRY_RUN_LIMITS,
    ...input.limits,
    memoryMb,
    timeoutMs: Math.max(
      10,
      input.limits?.timeoutMs ?? input.script.timeoutMs ?? DEFAULT_DRY_RUN_LIMITS.timeoutMs,
    ),
  };

  // Source size check before spawning WASM VM
  const sourceBytes = textEncoder.encode(input.script.source).length;
  if (sourceBytes > limits.maxSourceBytes) {
    return {
      ok: false,
      seed,
      virtualDurationMs: 0,
      billedDurationMs: 1,
      guestCpuMs: 0,
      memoryPeakBytes: 0,
      logs: [],
      calls: [],
      error: {
        category: 'UserCodeError',
        name: 'SourceLimitError',
        message: `Script size (${Math.round(sourceBytes / 1024)} KB) exceeds 200 KB limit`,
      },
    };
  }
  if (input.designScripts && input.designScripts.length > 0) {
    const totalDesignBytes = input.designScripts.reduce(
      (sum, s) => sum + textEncoder.encode(s.source).length,
      0,
    );
    if (totalDesignBytes > limits.maxDesignSourceBytes) {
      return {
        ok: false,
        seed,
        virtualDurationMs: 0,
        billedDurationMs: 1,
        guestCpuMs: 0,
        memoryPeakBytes: 0,
        logs: [],
        calls: [],
        error: {
          category: 'UserCodeError',
          name: 'SourceLimitError',
          message: `Design script bundle size (${Math.round(totalDesignBytes / 1024)} KB) exceeds 1 MB limit`,
        },
      };
    }
  }

  let bundledCode = input.prebuiltBundle?.code;
  let sourceMapJson = input.prebuiltBundle?.sourceMapJson;

  if (!bundledCode) {
    const bundleRes = await bundleUserScript({
      entryScript: input.script,
      ...(input.designScripts ? { designScripts: input.designScripts } : {}),
      ...(input.esbuildWasmUrl ? { esbuildWasmUrl: input.esbuildWasmUrl } : {}),
    });
    if (!bundleRes.ok || !bundleRes.code) {
      const firstErr = bundleRes.errors?.[0] ?? {
        category: 'UserCodeError' as const,
        name: 'BuildError',
        message: 'Failed to bundle handler script',
      };
      return {
        ok: false,
        seed,
        virtualDurationMs: 0,
        billedDurationMs: 1,
        guestCpuMs: 0,
        memoryPeakBytes: 0,
        logs: [],
        calls: [],
        error: firstErr,
      };
    }
    bundledCode = bundleRes.code;
    sourceMapJson = bundleRes.sourceMapJson;
  }

  const effectiveEnv = buildEffectiveEnv(input.node, input.script.env, input.env);
  const prelude = buildGuestPrelude({
    baseEpochMs: 1_700_000_000_000,
    env: effectiveEnv,
    tmpFsMaxBytes: limits.tmpFsMaxBytes,
    memoryLimitBytes: limits.memoryMb * 1024 * 1024,
    discoveryMode: Boolean(input.discoveryMode),
  });

  const preludeLineCount = 0;
  const translator = new SourceMapTranslator(sourceMapJson, preludeLineCount);

  const qjs = await loadQuickJsModule(input.quickJsWasmUrl);
  const rt = qjs.newRuntime();
  rt.setMemoryLimit(limits.memoryMb * 1024 * 1024);
  // Clamp QuickJS JS stack below ~384 KB so infinite recursion triggers QuickJS's clean
  // 'stack overflow' error before unwinding the host Emscripten/V8 WASM call stack.
  rt.setMaxStackSize(Math.min(limits.stackBytes, 256 * 1024));

  let guestCpuElapsedMs = 0;
  let cpuSliceStartMs = 0;
  let cpuInterrupted = false;
  let oomInterrupted = false;
  let interruptTicks = 0;
  const maxMemoryBytes = limits.memoryMb * 1024 * 1024;
  rt.setInterruptHandler(() => {
    const slice = nowPerfMs() - cpuSliceStartMs;
    if (guestCpuElapsedMs + slice > limits.cpuBudgetMs) {
      cpuInterrupted = true;
      return true;
    }
    if (++interruptTicks % 4 === 0) {
      try {
        const memH = rt.computeMemoryUsage();
        const memInfo = ctx.dump(memH) as { memory_used_size?: number };
        memH.dispose();
        if (typeof memInfo?.memory_used_size === 'number') {
          memoryPeakBytes = Math.max(memoryPeakBytes, memInfo.memory_used_size);
          if (memInfo.memory_used_size > maxMemoryBytes) {
            oomInterrupted = true;
            return true;
          }
        }
      } catch {
        // Ignore measurement errors during shutdown
      }
    }
    return false;
  });

  const ctx = rt.newContext();

  let virtualNowMs = 0;
  let seqCounter = 0;
  let nextTimerId = 1;
  let nextCallId = 1;
  let mockCallCount = 0;
  let logIdCounter = 1;
  let turnCounter = 1;
  let turnGroupId = `g-${turnCounter}`;
  const eventQueue: VirtualEvent[] = [];
  const clearedTimers = new Set<number>();
  const logs: LogEntry[] = [];
  const calls: DetectedCallRecord[] = [];
  const discoveredMap = new Map<string, Set<string>>();
  let memoryPeakBytes = 0;

  const eventPayload = input.event ?? input.fixture?.event ?? {};
  const requestId = input.requestId ?? prng.uuid();
  const shouldEmitPlatformLogs = input.emitPlatformLogs ?? Boolean(input.node);

  const extractEventMethod = (): string => {
    if (eventPayload && typeof eventPayload === 'object') {
      const ev = eventPayload as Record<string, unknown>;
      const rc = ev.requestContext as Record<string, unknown> | undefined;
      const rcHttp = rc?.http as Record<string, unknown> | undefined;
      const m = ev.httpMethod ?? ev.method ?? rcHttp?.method;
      if (typeof m === 'string' && m.trim()) {
        return m.trim().toUpperCase();
      }
    }
    return 'POST';
  };

  const finalizeResult = (partial: Omit<DryRunResult, 'logs'>): DryRunResult => {
    const finalLogs = shouldEmitPlatformLogs
      ? attachProviderPlatformLogs(logs, {
          serviceId: input.service?.id ?? input.node?.serviceId ?? 'aws.lambda',
          ...(input.node?.id ? { nodeId: input.node.id } : {}),
          nodeLabel: input.node?.label ?? input.script.name,
          requestId,
          ...(input.traceId ? { traceId: input.traceId } : {}),
          durationMs: partial.virtualDurationMs,
          billedDurationMs: partial.billedDurationMs,
          memoryMb: limits.memoryMb,
          memoryPeakBytes: partial.memoryPeakBytes,
          coldStart: Boolean(input.coldStart),
          initDurationMs: input.initDurationMs ?? input.node?.config.coldStart?.p50 ?? 231.5,
          ...(partial.httpStatus !== undefined
            ? { statusCode: partial.httpStatus }
            : partial.error?.statusCode !== undefined
              ? { statusCode: partial.error.statusCode }
              : {}),
          method: extractEventMethod(),
          ok: partial.ok,
          ...(partial.error?.message ? { errorMessage: partial.error.message } : {}),
          startVirtualMs: 0,
          endVirtualMs: partial.virtualDurationMs,
        })
      : logs;
    return {
      ...partial,
      logs: finalLogs,
    };
  };

  const sampleMem = () => {
    try {
      const h = rt.computeMemoryUsage();
      const d = ctx.dump(h) as { memory_used_size?: number };
      h.dispose();
      if (typeof d?.memory_used_size === 'number') {
        memoryPeakBytes = Math.max(memoryPeakBytes, d.memory_used_size);
      }
    } catch {
      // Ignore memory measurement errors during OOM teardown
    }
  };

  const pushEvent = (ev: Omit<VirtualEvent, 'seq'>) => {
    eventQueue.push({ ...ev, seq: ++seqCounter });
    eventQueue.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  };

  const appendUserLog = (
    level: LogEntry['level'],
    rawMsg: string,
    dataJson: string,
    rawStack: string,
  ) => {
    if (logs.length >= limits.maxLogLines) {
      if (logs.length === limits.maxLogLines) {
        logs.push({
          id: logIdCounter++,
          tVirtualMs: Number(virtualNowMs.toFixed(2)),
          level: 'warn',
          source: 'platform',
          ...(input.node?.id ? { nodeId: input.node.id } : {}),
          message: `Log line cap reached (${limits.maxLogLines} lines); remaining user logs suppressed`,
        });
      }
      return;
    }
    const msg = truncateUtf8(rawMsg, limits.maxLogLineBytes);
    let parsedData: unknown;
    if (dataJson) {
      try {
        parsedData = JSON.parse(dataJson);
      } catch {
        parsedData = dataJson;
      }
    }
    const site = parseFirstSiteFromStack(rawStack, translator);
    logs.push({
      id: logIdCounter++,
      tVirtualMs: Number(virtualNowMs.toFixed(2)),
      level,
      source: 'user',
      ...(input.node?.id ? { nodeId: input.node.id } : {}),
      requestId,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      message: msg,
      ...(parsedData !== undefined ? { data: parsedData } : {}),
      ...(site ? { site: { file: site.file, line: site.line, col: site.column } } : {}),
    });
  };

  const resolveMock: MockCallResolver =
    input.mockResolver ??
    createMockCallResolver({
      ...(input.design ? { design: input.design } : {}),
      ...(input.node ? { node: input.node } : {}),
      ...(input.customServices ? { customServices: input.customServices } : {}),
      seed,
      env: effectiveEnv,
    });

  // Register strict JSON/primitive-only host bindings on globalThis inside QuickJS
  const registerGlobals = () => {
    const bindFn = (name: string, fn: Parameters<typeof ctx.newFunction>[1]) => {
      const h = ctx.newFunction(name, fn);
      ctx.setProp(ctx.global, name, h);
      h.dispose();
    };

    bindFn('__infrasimNowMs', () => ctx.newNumber(virtualNowMs));
    bindFn('__infrasimRandom', () => ctx.newNumber(prng.next()));
    bindFn('__infrasimRandomUuid', () => ctx.newString(prng.uuid()));
    bindFn('__infrasimLog', (lvlH, msgH, dataH, stackH) => {
      const levelRaw = ctx.getString(lvlH);
      const level: LogEntry['level'] =
        levelRaw === 'warn' || levelRaw === 'error' || levelRaw === 'debug' ? levelRaw : 'info';
      const msg = ctx.getString(msgH);
      const dataJson = ctx.getString(dataH);
      const stack = ctx.getString(stackH);
      appendUserLog(level, msg, dataJson, stack);
    });
    bindFn('__infrasimScheduleTimer', (delayH, repeatH) => {
      const delayMs = Math.max(0, ctx.getNumber(delayH));
      const repeat = Boolean(ctx.dump(repeatH));
      const id = nextTimerId++;
      pushEvent({
        atMs: virtualNowMs + delayMs,
        kind: 'timer',
        timerId: id,
        ...(repeat ? { repeatMs: Math.max(1, delayMs) } : {}),
      });
      return ctx.newNumber(id);
    });
    bindFn('__infrasimClearTimer', (idH) => {
      clearedTimers.add(Math.trunc(ctx.getNumber(idH)));
    });
    bindFn('__infrasimRecordDiscovery', (svcH, opH, pathH) => {
      const key = `${ctx.getString(svcH)}::${ctx.getString(opH)}`;
      const p = ctx.getString(pathH);
      if (!p) return;
      let set = discoveredMap.get(key);
      if (!set) {
        set = new Set<string>();
        discoveredMap.set(key, set);
      }
      set.add(p);
    });
    bindFn('__infrasimMockCall', (reqJsonH) => {
      const callId = nextCallId++;
      mockCallCount += 1;
      const reqStr = ctx.getString(reqJsonH);
      let reqParsed: MockCallInvocation & { siteStack?: string };
      try {
        reqParsed = JSON.parse(reqStr) as MockCallInvocation & { siteStack?: string };
      } catch {
        reqParsed = {
          kind: 'cloud',
          serviceId: 'unknown',
          op: 'Call',
          startVirtualMs: virtualNowMs,
        };
      }

      if (mockCallCount > limits.maxMockCalls) {
        pushEvent({
          atMs: virtualNowMs,
          kind: 'mock',
          callId,
          callOk: false,
          payloadJson: JSON.stringify({
            name: 'MockServiceError',
            category: 'MockServiceError',
            message: `Max mock calls per invocation exceeded (${limits.maxMockCalls})`,
            statusCode: 429,
          }),
        });
        return ctx.newNumber(callId);
      }

      const site = parseFirstSiteFromStack(reqParsed.siteStack, translator);
      const invocation: MockCallInvocation = {
        ...reqParsed,
        startVirtualMs: virtualNowMs,
        parallelGroup: turnGroupId,
        ...(input.discoveryMode ? { discoveryMode: true } : {}),
        ...(site ? { site } : {}),
      };

      const outcomeSyncOrPromise = resolveMock(invocation, {
        seed,
        seq: mockCallCount,
        nowMs: virtualNowMs,
        env: effectiveEnv,
      });

      const handleOutcome = (outcome: MockCallOutcome) => {
        const latencyMs = Math.max(0, Number(outcome.latencyMs) || 0);
        const inputBytes = reqParsed.input
          ? textEncoder.encode(JSON.stringify(reqParsed.input)).length
          : 0;
        const outputBytes = outcome.output
          ? textEncoder.encode(JSON.stringify(outcome.output)).length
          : 0;

        const record: DetectedCallRecord = {
          index: calls.length + 1,
          serviceId: outcome.serviceId,
          op: outcome.op,
          ...(outcome.targetNodeId ? { targetNodeId: outcome.targetNodeId } : {}),
          input: reqParsed.input ?? reqParsed.body ?? {},
          ...(outcome.ok ? { output: outcome.output } : {}),
          ...(outcome.error
            ? {
                error: {
                  name: outcome.error.name,
                  message: outcome.error.message,
                  ...(outcome.error.code ? { code: outcome.error.code } : {}),
                  ...(outcome.error.statusCode !== undefined
                    ? { statusCode: outcome.error.statusCode }
                    : {}),
                  ...(outcome.error.retryAfterMs !== undefined
                    ? { retryAfterMs: outcome.error.retryAfterMs }
                    : {}),
                },
              }
            : {}),
          startVirtualMs: Number(virtualNowMs.toFixed(2)),
          latencyMs: Number(latencyMs.toFixed(2)),
          payloadBytes: inputBytes,
          responseBytes: outputBytes,
          parallelGroup: turnGroupId,
          ...(reqParsed.stream ? { streamed: true } : {}),
          ...(outcome.spans ? { spans: outcome.spans } : {}),
          ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
          ...(reqParsed.url ? { httpUrl: reqParsed.url } : {}),
          ...(reqParsed.alias ? { alias: reqParsed.alias } : {}),
          ...(site ? { site } : {}),
        };
        calls.push(record);

        if (outcome.ok) {
          let resolvePayload = outcome.output;
          if (reqParsed.stream && outcome.streamChunks && outcome.streamChunks.length > 0) {
            const firstDelay = outcome.streamChunks[0]!.delayOffsetMs;
            const chunks = outcome.streamChunks.map((c, i) => {
              const prevDelay = i === 0 ? firstDelay : outcome.streamChunks![i - 1]!.delayOffsetMs;
              return {
                delayMs: i === 0 ? 0 : Math.max(0, c.delayOffsetMs - prevDelay),
                data: c.data,
              };
            });
            resolvePayload = { __streamChunks: chunks };
            pushEvent({
              atMs: virtualNowMs + firstDelay,
              kind: 'mock',
              callId,
              callOk: true,
              payloadJson: JSON.stringify(resolvePayload),
            });
            return;
          }
          const settlePayload = input.discoveryMode
            ? { __discoveryProxyTarget: { serviceId: outcome.serviceId, op: outcome.op } }
            : (resolvePayload ?? null);
          pushEvent({
            atMs: virtualNowMs + latencyMs,
            kind: 'mock',
            callId,
            callOk: true,
            payloadJson: JSON.stringify(settlePayload),
          });
        } else {
          const err = outcome.error ?? {
            category: 'MockServiceError' as const,
            name: 'MockServiceError',
            message: 'Mock service error',
            statusCode: 500,
          };
          const reqId = prng.uuid();
          pushEvent({
            atMs: virtualNowMs + latencyMs,
            kind: 'mock',
            callId,
            callOk: false,
            payloadJson: JSON.stringify({
              name: err.name,
              message: err.message,
              code: err.code ?? err.name,
              category: err.category,
              statusCode: err.statusCode ?? 500,
              $metadata: { httpStatusCode: err.statusCode ?? 500, requestId: reqId },
              ...(err.retryable
                ? { $retryable: { throttling: (err.statusCode ?? 500) === 429 } }
                : {}),
              ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
              ...(err.details ? { details: err.details } : {}),
            }),
          });
        }
      };

      if (
        outcomeSyncOrPromise &&
        typeof (outcomeSyncOrPromise as Promise<MockCallOutcome>).then === 'function'
      ) {
        throw new Error(
          'MockCallResolver inside synchronous QuickJS loop must resolve synchronously',
        );
      }
      handleOutcome(outcomeSyncOrPromise as MockCallOutcome);
      return ctx.newNumber(callId);
    });
  };

  const runTimed = <T>(fn: () => T): T => {
    cpuSliceStartMs = nowPerfMs();
    try {
      return fn();
    } finally {
      guestCpuElapsedMs += nowPerfMs() - cpuSliceStartMs;
    }
  };

  try {
    registerGlobals();

    const errToReport = (
      errObj: unknown,
      defaultCat: SandboxErrorReport['category'] = 'UserCodeError',
    ) => normalizeQuickJsError(errObj, limits, translator, defaultCat, oomInterrupted);

    const evalPrelude = runTimed(() => ctx.evalCode(prelude, 'prelude.js'));
    if (evalPrelude.error) {
      const errObj = ctx.dump(evalPrelude.error);
      evalPrelude.error.dispose();
      return {
        ok: false,
        seed,
        virtualDurationMs: 0,
        billedDurationMs: 1,
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        logs,
        calls,
        error: errToReport(errObj),
      };
    }
    evalPrelude.value.dispose();

    const evalBundle = runTimed(() => ctx.evalCode(bundledCode, 'bundle.js'));
    if (evalBundle.error) {
      const errObj = ctx.dump(evalBundle.error);
      evalBundle.error.dispose();
      sampleMem();
      return {
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        logs,
        calls,
        error: errToReport(errObj),
      };
    }
    evalBundle.value.dispose();

    // Invoke entrypoint (Lambda handler | Web Fetch | Express req,res)
    const entryName = input.script.entry || 'handler';
    const invokeScript = `
;(function() {
  const __exports = globalThis.__infrasimModuleExports || {};
  const __entryName = ${JSON.stringify(entryName)};
  const __event = ${JSON.stringify(eventPayload)};
  const __customCtx = ${JSON.stringify(input.context ?? {})};
  const __timeoutMs = ${limits.timeoutMs};
  const __fnName = ${JSON.stringify(input.node?.label ?? input.script.name ?? 'handler')};
  const __memMb = ${limits.memoryMb};
  const __region = ${JSON.stringify(effectiveEnv.AWS_REGION ?? 'us-east-1')};

  // Detect Web-fetch style export: export default { fetch(req, env, ctx) } or export async function fetch(...)
  const __defaultObj = __exports.default && typeof __exports.default === 'object' ? __exports.default : null;
  const __fetchFn = (__defaultObj && typeof __defaultObj.fetch === 'function')
    ? __defaultObj.fetch.bind(__defaultObj)
    : (typeof __exports.fetch === 'function' ? __exports.fetch : null);

  const __handlerFn = typeof __exports[__entryName] === 'function'
    ? __exports[__entryName]
    : (typeof __exports.handler === 'function'
        ? __exports.handler
        : (typeof __exports.default === 'function' ? __exports.default : null));

  let __expressResult = null;

  if (!__handlerFn && __fetchFn) {
    const method = (__event.httpMethod || __event.requestContext?.http?.method || __event.method || 'GET').toUpperCase();
    const rawPath = __event.path || __event.rawPath || __event.url || '/';
    const headersObj = __event.headers || {};
    const urlStr = rawPath.startsWith('http') ? rawPath : 'https://sandbox.local' + (rawPath.startsWith('/') ? rawPath : '/' + rawPath);
    const reqObj = new Request(urlStr, {
      method,
      headers: headersObj,
      body: method !== 'GET' && method !== 'HEAD' ? __event.body : undefined,
    });
    const waitPromises = [];
    const ctxObj = {
      waitUntil: (p) => waitPromises.push(Promise.resolve(p)),
      passThroughOnException: () => {},
    };
    return Promise.resolve(__fetchFn(reqObj, process.env, ctxObj)).then(async (resp) => {
      if (resp instanceof Response || (resp && typeof resp.text === 'function')) {
        const text = await resp.text();
        return {
          statusCode: resp.status ?? 200,
          headers: resp.headers?.toJSON ? resp.headers.toJSON() : (resp.headers || {}),
          body: text,
        };
      }
      return resp;
    });
  }

  if (!__handlerFn) {
    throw new Error('Entry function "' + __entryName + '" not exported from script');
  }

  const __lambdaContext = {
    awsRequestId: ${JSON.stringify(requestId)},
    functionName: __fnName,
    functionVersion: '$LATEST',
    memoryLimitInMB: String(__memMb),
    invokedFunctionArn: 'arn:aws:lambda:' + __region + ':000000000000:function:' + __fnName,
    logGroupName: '/aws/lambda/' + __fnName,
    logStreamName: '2026/11/12/[$LATEST]' + ${JSON.stringify(requestId.slice(0, 8))},
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => Math.max(0, Math.round(__timeoutMs - globalThis.performance.now())),
    ...__customCtx,
  };

  // Express-like response helpers attached carefully so Lambda handlers never collide
  const __resHeaders = {};
  let __resStatus = 200;
  let __usedExpressRes = false;
  __lambdaContext.status = function(code) { __usedExpressRes = true; __resStatus = Number(code) || 200; return __lambdaContext; };
  __lambdaContext.set = function(k, v) { __usedExpressRes = true; __resHeaders[String(k).toLowerCase()] = String(v); return __lambdaContext; };
  __lambdaContext.header = __lambdaContext.set;
  __lambdaContext.json = function(body) {
    __usedExpressRes = true;
    __expressResult = { statusCode: __resStatus, headers: { 'content-type': 'application/json', ...__resHeaders }, body: JSON.stringify(body) };
    return __expressResult;
  };
  __lambdaContext.send = function(body) {
    __usedExpressRes = true;
    __expressResult = { statusCode: __resStatus, headers: __resHeaders, body: typeof body === 'string' ? body : JSON.stringify(body) };
    return __expressResult;
  };
  __lambdaContext.end = function(body = '') {
    return __lambdaContext.send(body);
  };

  const __ret = __handlerFn(__event, __lambdaContext);
  return Promise.resolve(__ret).then((val) => (__usedExpressRes && __expressResult ? __expressResult : val));
})();
`;

    const callEval = runTimed(() => ctx.evalCode(invokeScript, 'invoke.js'));
    if (callEval.error) {
      const errObj = ctx.dump(callEval.error);
      callEval.error.dispose();
      sampleMem();
      return {
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        logs,
        calls,
        error: errToReport(errObj),
      };
    }

    const promiseHandle = callEval.value;
    let settledResult:
      { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown } | null =
      null;

    // Attach settlement watcher inside guest
    const settleWatcherCode = `
(function(p) {
  globalThis.__infrasimDone = null;
  const __sanitize = globalThis.__infrasimSafeJson || ((x) => x);
  p.then(
    (v) => { globalThis.__infrasimDone = { status: 'fulfilled', value: v === undefined ? null : __sanitize(v) }; },
    (e) => { globalThis.__infrasimDone = { status: 'rejected', error: { name: e?.name || 'Error', message: e?.message || String(e), code: e?.code, stack: e?.stack, category: e?.category, statusCode: e?.statusCode, $metadata: e?.$metadata, details: e?.details } }; }
  );
})`;
    const watcherFnRes = runTimed(() => ctx.evalCode(settleWatcherCode, 'watcher.js'));
    if (watcherFnRes.error) {
      const errObj = ctx.dump(watcherFnRes.error);
      watcherFnRes.error.dispose();
      promiseHandle.dispose();
      return {
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        logs,
        calls,
        error: errToReport(errObj),
      };
    }
    const watcherFn = watcherFnRes.value;
    const attachRes = runTimed(() => ctx.callFunction(watcherFn, ctx.undefined, promiseHandle));
    watcherFn.dispose();
    promiseHandle.dispose();
    if (attachRes.error) {
      const errObj = ctx.dump(attachRes.error);
      attachRes.error.dispose();
      return {
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        logs,
        calls,
        error: errToReport(errObj),
      };
    }
    attachRes.value.dispose();

    const checkDone = () => {
      const doneProp = ctx.getProp(ctx.global, '__infrasimDone');
      const dumped = ctx.dump(doneProp) as
        { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown } | null;
      doneProp.dispose();
      return dumped;
    };

    // Deterministic virtual-time event loop
    let loopGuard = 0;
    while (loopGuard++ < 100_000) {
      const jobRes = runTimed(() => rt.executePendingJobs());
      if (jobRes.error) {
        const errObj = ctx.dump(jobRes.error);
        jobRes.error.dispose();
        sampleMem();
        return finalizeResult({
          ok: false,
          seed,
          virtualDurationMs: Number(virtualNowMs.toFixed(2)),
          billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
          guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
          memoryPeakBytes,
          calls,
          error: errToReport(errObj),
        });
      }

      if (oomInterrupted) {
        sampleMem();
        return finalizeResult({
          ok: false,
          seed,
          virtualDurationMs: Number(virtualNowMs.toFixed(2)),
          billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
          guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
          memoryPeakBytes,
          calls,
          error: {
            category: 'OutOfMemory',
            name: 'OutOfMemory',
            message: `Memory limit exceeded (${limits.memoryMb} MB)`,
          },
        });
      }

      if (cpuInterrupted) {
        sampleMem();
        return finalizeResult({
          ok: false,
          seed,
          virtualDurationMs: Number(virtualNowMs.toFixed(2)),
          billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
          guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
          memoryPeakBytes,
          calls,
          error: {
            category: 'CpuBudgetExceeded',
            name: 'CpuBudgetExceeded',
            message: 'Possible infinite loop — stopped',
          },
        });
      }

      settledResult = checkDone();
      if (settledResult) {
        break;
      }

      // Remove cleared timers before checking next wake event
      while (
        eventQueue.length > 0 &&
        eventQueue[0]!.kind === 'timer' &&
        clearedTimers.has(eventQueue[0]!.timerId!)
      ) {
        eventQueue.shift();
      }

      if (eventQueue.length === 0) {
        // Handler returned unresolved Promise with no pending timers/mock calls
        break;
      }

      const nextEv = eventQueue[0]!;
      if (nextEv.atMs > limits.timeoutMs) {
        virtualNowMs = limits.timeoutMs;
        sampleMem();
        const timeoutSecs = (limits.timeoutMs / 1000).toFixed(2);
        return finalizeResult({
          ok: false,
          seed,
          virtualDurationMs: Number(virtualNowMs.toFixed(2)),
          billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
          guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
          memoryPeakBytes,
          calls,
          error: {
            category: 'Timeout',
            name: 'TaskTimedOut',
            message: `Task timed out after ${timeoutSecs} seconds`,
            statusCode: 504,
          },
        });
      }

      virtualNowMs = Math.max(virtualNowMs, nextEv.atMs);
      turnCounter += 1;
      turnGroupId = `g-${turnCounter}`;

      // Fire all events due at or before current virtualNowMs
      while (eventQueue.length > 0 && eventQueue[0]!.atMs <= virtualNowMs) {
        const ev = eventQueue.shift()!;
        if (ev.kind === 'timer') {
          if (clearedTimers.has(ev.timerId!)) {
            continue;
          }
          if (ev.repeatMs !== undefined) {
            pushEvent({
              atMs: virtualNowMs + ev.repeatMs,
              kind: 'timer',
              timerId: ev.timerId,
              repeatMs: ev.repeatMs,
            });
          }
          const fireCode = `globalThis.__infrasimFireTimer(${ev.timerId});`;
          const fireRes = runTimed(() => ctx.evalCode(fireCode, 'timer.js'));
          if (fireRes.error) {
            const errObj = ctx.dump(fireRes.error);
            fireRes.error.dispose();
            sampleMem();
            return {
              ok: false,
              seed,
              virtualDurationMs: Number(virtualNowMs.toFixed(2)),
              billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
              guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
              memoryPeakBytes,
              logs,
              calls,
              error: errToReport(errObj),
            };
          }
          fireRes.value.dispose();
        } else if (ev.kind === 'mock') {
          const settleCode = `globalThis.__infrasimSettleMock(${ev.callId}, ${ev.callOk ? 'true' : 'false'}, ${JSON.stringify(ev.payloadJson ?? 'null')});`;
          const settleRes = runTimed(() => ctx.evalCode(settleCode, 'mock-callback.js'));
          if (settleRes.error) {
            const errObj = ctx.dump(settleRes.error);
            settleRes.error.dispose();
            sampleMem();
            return {
              ok: false,
              seed,
              virtualDurationMs: Number(virtualNowMs.toFixed(2)),
              billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
              guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
              memoryPeakBytes,
              logs,
              calls,
              error: errToReport(errObj),
            };
          }
          settleRes.value.dispose();
        }
      }
    }

    sampleMem();

    const discoveredPaths: Record<string, string[]> = {};
    for (const [k, set] of discoveredMap.entries()) {
      discoveredPaths[k] = Array.from(set).sort();
    }

    if (!settledResult) {
      return finalizeResult({
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        calls,
        ...(input.discoveryMode ? { discoveredPaths } : {}),
        error: {
          category: 'UnhandledRejection',
          name: 'UnresolvedPromiseError',
          message: 'Handler returned an unsettled Promise that never resolved',
        },
      });
    }

    if (settledResult.status === 'rejected') {
      return finalizeResult({
        ok: false,
        seed,
        virtualDurationMs: Number(virtualNowMs.toFixed(2)),
        billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
        guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
        memoryPeakBytes,
        calls,
        ...(input.discoveryMode ? { discoveredPaths } : {}),
        error: errToReport(settledResult.error, 'UnhandledRejection'),
      });
    }

    const retVal = settledResult.value;
    const httpStatus =
      retVal &&
      typeof retVal === 'object' &&
      typeof (retVal as { statusCode?: unknown }).statusCode === 'number'
        ? (retVal as { statusCode: number }).statusCode
        : undefined;

    return finalizeResult({
      ok: true,
      seed,
      result: retVal,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      virtualDurationMs: Number(virtualNowMs.toFixed(2)),
      billedDurationMs: Math.max(1, Math.ceil(virtualNowMs)),
      guestCpuMs: Number(guestCpuElapsedMs.toFixed(2)),
      memoryPeakBytes,
      calls,
      ...(input.discoveryMode ? { discoveredPaths } : {}),
    });
  } finally {
    // Lift memory limit before teardown so QuickJS never fails internal cleanup on OOM, then dispose.
    try {
      rt.setMemoryLimit(-1);
      ctx.dispose();
      rt.dispose();
    } catch {
      cachedModules.delete(input.quickJsWasmUrl ?? '__default__');
    }
  }
}
