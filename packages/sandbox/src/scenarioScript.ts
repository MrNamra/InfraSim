import type { ScriptAsset, UserFlow } from '@infrasim/shared-types';
import { bundleUserScript } from './bundler.js';
import { createSeededPrng, hashSeedParts } from './prng.js';
import { loadQuickJsModule } from './runtime.js';
import { SourceMapTranslator } from './sourceMap.js';
import {
  DEFAULT_DRY_RUN_LIMITS,
  type ExtractedScenarioResult,
  type SandboxErrorReport,
} from './types.js';

export interface ExtractScenarioInput {
  script: ScriptAsset;
  designScripts?: readonly ScriptAsset[];
  seed?: number;
  iterations?: number;
  env?: Record<string, string>;
  cpuBudgetMs?: number;
  quickJsWasmUrl?: string;
  esbuildWasmUrl?: string;
}

interface RawCapturedStep {
  method: string;
  path: string;
  bodyBytes?: number;
  thinkTimeMs?: number;
  groupName?: string;
}

interface RawScenarioEvalResult {
  options?: {
    rps?: number;
    durationS?: number;
    rampUpS?: number;
    stages?: { durationS: number; targetRps: number }[];
    thresholds?: Record<string, string[]>;
  };
  runs: RawCapturedStep[][];
  checks: { name: string; expectedStatus: number }[];
  error?: { name: string; message: string; stack?: string };
}

const textEncoder = new TextEncoder();

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function normalizeHttpPath(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '/';
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    return (u.pathname || '/') + u.search;
  } catch {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}

function buildScenarioGuestScript(bundledCode: string, iterations: number, seed: number): string {
  const cleanCode = bundledCode.replace(/\/\/# sourceMappingURL=.*$/gm, '');
  return `
(function() {
  let __rngState = (${seed >>> 0}) || 1;
  Math.random = function() {
    __rngState = (__rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(__rngState ^ (__rngState >>> 15), 1 | __rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function parseDurationS(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return Math.max(1, val);
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      const m = /^(\\d+(?:\\.\\d+)?)(ms|s|m|h)?$/.exec(s);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2] || 's';
        if (unit === 'ms') return Math.max(1, n / 1000);
        if (unit === 's') return Math.max(1, n);
        if (unit === 'm') return Math.max(1, n * 60);
        if (unit === 'h') return Math.max(1, n * 3600);
      }
    }
    return undefined;
  }

  let __currentSteps = [];
  let __groupStack = [];
  const __checkDefs = new Map();

  function __byteLen(val) {
    if (val === undefined || val === null) return undefined;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    if (!str) return undefined;
    return globalThis.Buffer ? globalThis.Buffer.from(str).length : str.length;
  }

  function __recordHttp(method, url, bodyArg) {
    const step = {
      method: String(method || 'GET').toUpperCase(),
      path: String(url || '/'),
    };
    if (method !== 'GET' && bodyArg !== undefined && bodyArg !== null) {
      const b = __byteLen(bodyArg);
      if (b !== undefined) step.bodyBytes = b;
    }
    if (__groupStack.length > 0) {
      step.groupName = __groupStack[__groupStack.length - 1];
    }
    __currentSteps.push(step);
    return {
      status: 200,
      status_text: '200 OK',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      timings: { duration: 10 },
      json: function() { return {}; },
    };
  }

  globalThis.http = {
    get: function(url) { return __recordHttp('GET', url, undefined); },
    post: function(url, body) { return __recordHttp('POST', url, body); },
    put: function(url, body) { return __recordHttp('PUT', url, body); },
    del: function(url, body) { return __recordHttp('DELETE', url, body); },
    delete: function(url, body) { return __recordHttp('DELETE', url, body); },
    patch: function(url, body) { return __recordHttp('PATCH', url, body); },
    request: function(method, url, body) { return __recordHttp(method, url, body); },
  };

  globalThis.sleep = function(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    if (__currentSteps.length > 0) {
      const last = __currentSteps[__currentSteps.length - 1];
      last.thinkTimeMs = (last.thinkTimeMs || 0) + ms;
    }
  };

  globalThis.group = function(name, fn) {
    __groupStack.push(String(name || 'group'));
    try {
      if (typeof fn === 'function') fn();
    } finally {
      __groupStack.pop();
    }
  };

  const PROBE_CODES = [200, 201, 204, 400, 401, 403, 404, 429, 500, 502, 503];
  globalThis.check = function(res, checksMap) {
    let allPassed = true;
    if (checksMap && typeof checksMap === 'object') {
      for (const [name, pred] of Object.entries(checksMap)) {
        if (typeof pred !== 'function') continue;
        let expected = 200;
        let found = false;
        for (const code of PROBE_CODES) {
          try {
            if (pred({ status: code, body: '{}', headers: {} })) {
              expected = code;
              found = true;
              break;
            }
          } catch {}
        }
        if (!__checkDefs.has(name)) {
          __checkDefs.set(name, { name, expectedStatus: found ? expected : 200 });
        }
        try {
          if (!pred(res)) allPassed = false;
        } catch {
          allPassed = false;
        }
      }
    }
    return allPassed;
  };

  globalThis.__VU = 1;
  globalThis.__ITER = 0;

  globalThis.__infrasimModuleExports = undefined;
  const module = { exports: {} };
  const exports = module.exports;
  function require(id) {
    throw new Error('require not supported directly after bundle: ' + id);
  }
  ${cleanCode}
  const exported = globalThis.__infrasimModuleExports || module.exports || {};
  const fn = typeof exported === 'function' ? exported : (typeof exported.default === 'function' ? exported.default : null);
  const rawOpts = (exported && typeof exported.options === 'object' && exported.options) ? exported.options : {};

  if (!fn) {
    return JSON.stringify({
      error: { name: 'UserCodeError', message: 'Scenario script must export a default function()' },
      runs: [],
      checks: [],
    });
  }

  let parsedRps = typeof rawOpts.rps === 'number' ? rawOpts.rps : undefined;
  let parsedDurationS = parseDurationS(rawOpts.durationS ?? rawOpts.duration);
  let parsedRampUpS = typeof rawOpts.rampUpS === 'number' ? rawOpts.rampUpS : parseDurationS(rawOpts.rampUp);
  let parsedStages = undefined;

  if (Array.isArray(rawOpts.stages) && rawOpts.stages.length > 0) {
    parsedStages = [];
    let totalDur = 0;
    let peakRps = 0;
    for (const st of rawOpts.stages) {
      if (!st || typeof st !== 'object') continue;
      const d = parseDurationS(st.durationS ?? st.duration) || 10;
      const target = typeof st.targetRps === 'number' ? st.targetRps : (typeof st.target === 'number' ? st.target : 0);
      parsedStages.push({ durationS: d, targetRps: target });
      totalDur += d;
      if (target > peakRps) peakRps = target;
    }
    if (parsedDurationS === undefined && totalDur > 0) parsedDurationS = totalDur;
    if (parsedRps === undefined && peakRps > 0) parsedRps = peakRps;
  }

  if (rawOpts.scenarios && typeof rawOpts.scenarios === 'object') {
    const scList = Object.values(rawOpts.scenarios);
    for (const sc of scList) {
      if (!sc || typeof sc !== 'object') continue;
      if (typeof sc.rps === 'number') parsedRps = (parsedRps || 0) + sc.rps;
      else if (typeof sc.rate === 'number') parsedRps = (parsedRps || 0) + sc.rate;
      const scDur = parseDurationS(sc.durationS ?? sc.duration);
      if (scDur !== undefined) parsedDurationS = Math.max(parsedDurationS || 0, scDur);
      const scRamp = typeof sc.rampUpS === 'number' ? sc.rampUpS : parseDurationS(sc.rampUp);
      if (scRamp !== undefined) parsedRampUpS = Math.max(parsedRampUpS || 0, scRamp);
      if (!parsedStages && Array.isArray(sc.stages) && sc.stages.length > 0) {
        parsedStages = [];
        for (const st of sc.stages) {
          if (!st || typeof st !== 'object') continue;
          const d = parseDurationS(st.durationS ?? st.duration) || 10;
          const target = typeof st.targetRps === 'number' ? st.targetRps : (typeof st.target === 'number' ? st.target : 0);
          parsedStages.push({ durationS: d, targetRps: target });
        }
      }
    }
  }

  const normalizedThresholds = {};
  if (rawOpts.thresholds && typeof rawOpts.thresholds === 'object') {
    for (const [k, arr] of Object.entries(rawOpts.thresholds)) {
      if (Array.isArray(arr)) {
        normalizedThresholds[k] = arr.map((x) => String(x));
      }
    }
  }

  const runs = [];
  for (let i = 0; i < ${iterations}; i++) {
    __currentSteps = [];
    globalThis.__VU = (i % 10) + 1;
    globalThis.__ITER = i;
    fn();
    runs.push(__currentSteps);
  }

  return JSON.stringify({
    options: {
      ...(parsedRps !== undefined ? { rps: parsedRps } : {}),
      ...(parsedDurationS !== undefined ? { durationS: parsedDurationS } : {}),
      ...(parsedRampUpS !== undefined ? { rampUpS: parsedRampUpS } : {}),
      ...(parsedStages ? { stages: parsedStages } : {}),
      ...(Object.keys(normalizedThresholds).length > 0 ? { thresholds: normalizedThresholds } : {}),
    },
    runs,
    checks: Array.from(__checkDefs.values()),
  });
})();
`;
}

function buildFlowsFromScenarioRuns(runs: readonly RawCapturedStep[][]): UserFlow[] {
  const counts = new Map<string, { count: number; steps: RawCapturedStep[] }>();
  for (const steps of runs) {
    const clean = steps.map((s) => ({
      ...s,
      path: normalizeHttpPath(s.path),
    }));
    const sig = clean
      .map(
        (s) =>
          `${s.method}:${s.path}:${s.bodyBytes ?? 0}:${s.thinkTimeMs ?? 0}:${s.groupName ?? ''}`,
      )
      .join('->');
    const existing = counts.get(sig);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(sig, { count: 1, steps: clean });
    }
  }

  const total = Math.max(1, runs.length);
  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);

  return sorted.map(([, entry], idx) => {
    const first = entry.steps[0];
    const baseName = first
      ? entry.steps.length === 1
        ? `${first.method} ${first.path}`
        : `${entry.steps.map((s) => `${s.method} ${s.path}`).join(' → ')}`
      : `Empty flow ${idx + 1}`;
    const label =
      entry.steps[0]?.groupName && sorted.length <= 4
        ? `${entry.steps[0].groupName}: ${baseName}`
        : baseName;

    return {
      id: `flow-script-${idx + 1}`,
      name: label.slice(0, 96),
      weight: Number((entry.count / total).toFixed(4)),
      steps:
        entry.steps.length > 0
          ? entry.steps.map((s) => ({
              method: s.method,
              path: s.path,
              ...(s.bodyBytes !== undefined ? { bodyBytes: s.bodyBytes } : {}),
              ...(s.thinkTimeMs !== undefined ? { thinkTimeMs: s.thinkTimeMs } : {}),
            }))
          : [{ method: 'GET', path: '/' }],
    };
  });
}

/**
 * Executes a k6-style scenario script inside QuickJS-WASM across seeded iterations to
 * extract traffic options, thresholds, check expectations, and weighted `UserFlow[]`.
 */
export async function extractScenarioFromScript(
  input: ExtractScenarioInput,
): Promise<ExtractedScenarioResult> {
  const srcBytes = textEncoder.encode(input.script.source).length;
  if (srcBytes > DEFAULT_DRY_RUN_LIMITS.maxSourceBytes) {
    return {
      options: {},
      flows: [],
      checkDefinitions: [],
      errors: [
        {
          category: 'ValidationError',
          name: 'SourceTooLargeError',
          message: `Scenario script exceeds max size (${srcBytes} > ${DEFAULT_DRY_RUN_LIMITS.maxSourceBytes} bytes)`,
        },
      ],
    };
  }

  const bundled = await bundleUserScript({
    entryScript: input.script,
    ...(input.designScripts ? { designScripts: input.designScripts } : {}),
    ...(input.esbuildWasmUrl ? { esbuildWasmUrl: input.esbuildWasmUrl } : {}),
  });
  if (!bundled.ok || !bundled.code) {
    return {
      options: {},
      flows: [],
      checkDefinitions: [],
      errors: bundled.errors ?? [
        {
          category: 'UserCodeError',
          name: 'CompileError',
          message: 'Failed to compile scenario script',
        },
      ],
    };
  }

  const iterations = Math.max(10, Math.min(200, Math.round(input.iterations ?? 100)));
  const cpuBudgetMs = input.cpuBudgetMs ?? 5_000;
  const seed = input.seed ?? 42;
  const prng = createSeededPrng(hashSeedParts(seed, input.script.id, 'scenario'));
  const rngSeed = Math.max(1, Math.floor(prng.next() * 0x7fffffff));
  const translator = new SourceMapTranslator(bundled.sourceMapJson);

  const QuickJS = await loadQuickJsModule(input.quickJsWasmUrl);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(DEFAULT_DRY_RUN_LIMITS.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(Math.min(DEFAULT_DRY_RUN_LIMITS.stackBytes, 256 * 1024));

  const wallStartMs = nowPerfMs();
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (nowPerfMs() - wallStartMs > cpuBudgetMs) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });

  const ctx = runtime.newContext();
  try {
    // Provide lightweight Buffer + console/env stubs cleanly inside scenario runner
    const envJson = JSON.stringify(input.env ?? {});
    const prelude = `
globalThis.process = globalThis.process || { env: ${envJson} };
globalThis.console = globalThis.console || {
  log: function() {}, info: function() {}, warn: function() {}, error: function() {}, debug: function() {}
};
globalThis.Buffer = globalThis.Buffer || {
  from: function(str) {
    const s = String(str);
    return { length: s.length };
  }
};
globalThis.fetch = function(url) {
  throw new Error('fetch(' + String(url) + ') is disabled inside scenario scripts; use http.get/post.');
};
`;
    const preludeEval = ctx.evalCode(prelude, 'scenario-prelude.js');
    if (preludeEval.error) {
      const dumped = ctx.dump(preludeEval.error);
      preludeEval.error.dispose();
      throw dumped;
    }
    preludeEval.value.dispose();

    const driverCode = buildScenarioGuestScript(bundled.code, iterations, rngSeed);
    const evalRes = ctx.evalCode(driverCode, 'bundle.js');
    if (evalRes.error) {
      const dumped = ctx.dump(evalRes.error) as {
        name?: string;
        message?: string;
        stack?: string;
      };
      evalRes.error.dispose();
      const rewritten = dumped?.stack ? translator.rewriteStack(dumped.stack) : undefined;
      const report: SandboxErrorReport = cpuExceeded
        ? {
            category: 'CpuBudgetExceeded',
            name: 'CpuBudgetExceeded',
            message: 'Possible infinite loop in scenario script — stopped',
          }
        : {
            category: 'UserCodeError',
            name: dumped?.name ?? 'Error',
            message: dumped?.message ?? String(dumped),
            ...(rewritten?.stack ? { stack: rewritten.stack } : {}),
            ...(rewritten?.firstSite ? { site: rewritten.firstSite } : {}),
          };
      return {
        options: {},
        flows: [],
        checkDefinitions: [],
        errors: [report],
      };
    }

    const rawJson = ctx.getString(evalRes.value);
    evalRes.value.dispose();
    const parsed = JSON.parse(rawJson) as RawScenarioEvalResult;
    if (parsed.error) {
      return {
        options: {},
        flows: [],
        checkDefinitions: [],
        errors: [
          {
            category: 'UserCodeError',
            name: parsed.error.name,
            message: parsed.error.message,
          },
        ],
      };
    }

    return {
      options: parsed.options ?? {},
      flows: buildFlowsFromScenarioRuns(parsed.runs),
      checkDefinitions: parsed.checks,
      errors: [],
    };
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
