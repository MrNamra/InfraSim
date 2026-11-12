import type {
  Design,
  LatencyModel,
  LogEntry,
  NodeInstance,
  PlanStep,
} from '@infrasim/shared-types';
import { bundleUserScript } from './bundler.js';
import { computeProfileCacheKey } from './profileKey.js';
import { createSeededPrng, hashSeedParts } from './prng.js';
import { executeInSandbox } from './runtime.js';
import {
  DEFAULT_DRY_RUN_LIMITS,
  DEFAULT_PROFILE_CPU_BUDGET_MS,
  type DetectedCallRecord,
  type ProfileHandlerInput,
  type ProfileRunSummary,
} from './types.js';

interface SingleCallTemplate {
  serviceId: string;
  op: string;
  count: number;
  payloadBytes?: number;
  alias?: string;
}

type AtomicBlock =
  | {
      kind: 'sleep';
      key: string;
      ms: number;
    }
  | {
      kind: 'call';
      key: string;
      steps: SingleCallTemplate[];
      parallel: boolean;
    };

function nowPerfMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function interpolateQuantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function fitLatencyModel(samples: readonly number[], minMs = 0.01): LatencyModel {
  if (samples.length === 0) {
    const val = Number(minMs.toFixed(2));
    return { distribution: 'lognormal', p50: val, p95: val };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = Math.max(minMs, Number(interpolateQuantile(sorted, 0.5).toFixed(2)));
  const p95 = Math.max(p50, Number(interpolateQuantile(sorted, 0.95).toFixed(2)));
  return {
    distribution: 'lognormal',
    p50,
    p95,
  };
}

function shouldPinTargetNodeAlias(
  design: Design | undefined,
  node: NodeInstance | undefined,
  serviceId: string,
): boolean {
  if (!design || !node) return false;
  const targetsById = new Map(design.nodes.map((n) => [n.id, n]));
  let sameServiceTargets = 0;
  for (const edge of design.edges) {
    if (edge.from !== node.id) continue;
    if (targetsById.get(edge.to)?.serviceId === serviceId) {
      sameServiceTargets += 1;
      if (sameServiceTargets > 1) return true;
    }
  }
  return false;
}

function extractTurnBlocks(
  calls: readonly DetectedCallRecord[],
  ok: boolean,
  virtualDurationMs: number,
  design: Design | undefined,
  sourceNode: NodeInstance | undefined,
): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  let cursorMs = 0;

  let i = 0;
  while (i < calls.length) {
    const turnGroup = calls[i]!.parallelGroup ?? `single-${i}`;
    const turnCalls: DetectedCallRecord[] = [];
    while (i < calls.length && (calls[i]!.parallelGroup ?? `single-${i}`) === turnGroup) {
      turnCalls.push(calls[i]!);
      i += 1;
    }

    const startMs = turnCalls[0]!.startVirtualMs;
    const sleepGap = startMs - cursorMs;
    if (sleepGap > 0.5) {
      blocks.push({
        kind: 'sleep',
        key: `sleep:${Math.round(sleepGap)}`,
        ms: Number(sleepGap.toFixed(2)),
      });
    }

    let maxEnd = startMs;
    for (const c of turnCalls) {
      maxEnd = Math.max(maxEnd, c.startVirtualMs + c.latencyMs);
    }
    cursorMs = Math.max(cursorMs, maxEnd);

    // Coalesce identical calls launched inside the SAME synchronous turn (Promise.all semantics)
    const merged = new Map<
      string,
      { serviceId: string; op: string; alias?: string; count: number; bytesSum: number }
    >();
    for (const c of turnCalls) {
      const resolvedAlias =
        c.alias ??
        (c.targetNodeId && shouldPinTargetNodeAlias(design, sourceNode, c.serviceId)
          ? c.targetNodeId
          : undefined);
      const mergeKey = `${c.serviceId}::${c.op}::${resolvedAlias ?? ''}`;
      const existing = merged.get(mergeKey);
      if (existing) {
        existing.count += 1;
        existing.bytesSum += c.payloadBytes;
      } else {
        merged.set(mergeKey, {
          serviceId: c.serviceId,
          op: c.op,
          ...(resolvedAlias ? { alias: resolvedAlias } : {}),
          count: 1,
          bytesSum: c.payloadBytes,
        });
      }
    }

    const steps: SingleCallTemplate[] = [];
    for (const item of merged.values()) {
      const avgBytes = Math.round(item.bytesSum / item.count);
      steps.push({
        serviceId: item.serviceId,
        op: item.op,
        count: item.count,
        ...(avgBytes > 0 ? { payloadBytes: avgBytes } : {}),
        ...(item.alias ? { alias: item.alias } : {}),
      });
    }

    const isParallel = turnCalls.length > 1 || (steps[0]?.count ?? 1) > 1;
    const stepSig = steps
      .map((s) => `${s.serviceId}.${s.op}@${s.alias ?? ''}x${s.count}`)
      .join(',');
    blocks.push({
      kind: 'call',
      key: `${isParallel ? 'pg' : 'seq'}:${stepSig}`,
      steps,
      parallel: isParallel,
    });
  }

  if (calls.length === 0 && ok && virtualDurationMs > 0.5) {
    blocks.push({
      kind: 'sleep',
      key: `sleep:${Math.round(virtualDurationMs)}`,
      ms: Number(virtualDurationMs.toFixed(2)),
    });
  }

  return blocks;
}

function materializeBlock(
  blocksAtIndex: readonly AtomicBlock[],
  pgCounter: { next: number },
): PlanStep[] {
  const first = blocksAtIndex[0]!;
  if (first.kind === 'sleep') {
    let sumMs = 0;
    for (const b of blocksAtIndex) {
      if (b.kind === 'sleep') sumMs += b.ms;
    }
    return [{ kind: 'sleep', ms: Number((sumMs / blocksAtIndex.length).toFixed(2)) }];
  }

  const pgId = first.parallel ? `pg-${pgCounter.next++}` : undefined;
  return first.steps.map((tmpl, stepIdx) => {
    let bytesSum = 0;
    let bytesCount = 0;
    for (const b of blocksAtIndex) {
      if (b.kind === 'call' && b.steps[stepIdx]?.payloadBytes !== undefined) {
        bytesSum += b.steps[stepIdx]!.payloadBytes!;
        bytesCount += 1;
      }
    }
    const avgBytes = bytesCount > 0 ? Math.round(bytesSum / bytesCount) : tmpl.payloadBytes;
    return {
      kind: 'call',
      serviceId: tmpl.serviceId,
      op: tmpl.op,
      count: tmpl.count,
      ...(avgBytes !== undefined && avgBytes > 0 ? { payloadBytes: avgBytes } : {}),
      ...(pgId ? { parallelGroup: pgId } : {}),
      ...(tmpl.alias ? { alias: tmpl.alias } : {}),
    };
  });
}

function buildPlanStepsFromTraces(
  traces: readonly AtomicBlock[][],
  pgCounter: { next: number },
): PlanStep[] {
  if (traces.length === 0) return [];

  let minLen = traces[0]!.length;
  for (let r = 1; r < traces.length; r++) {
    minLen = Math.min(minLen, traces[r]!.length);
  }

  let prefixLen = 0;
  while (prefixLen < minLen) {
    const key = traces[0]![prefixLen]!.key;
    let allMatch = true;
    for (let r = 1; r < traces.length; r++) {
      if (traces[r]![prefixLen]!.key !== key) {
        allMatch = false;
        break;
      }
    }
    if (!allMatch) break;
    prefixLen += 1;
  }

  const out: PlanStep[] = [];
  for (let k = 0; k < prefixLen; k++) {
    out.push(
      ...materializeBlock(
        traces.map((t) => t[k]!),
        pgCounter,
      ),
    );
  }

  const tails = traces.map((t) => t.slice(prefixLen));
  if (tails.every((t) => t.length === 0)) {
    return out;
  }

  let minTailLen = tails[0]!.length;
  for (let r = 1; r < tails.length; r++) {
    minTailLen = Math.min(minTailLen, tails[r]!.length);
  }

  let suffixLen = 0;
  while (suffixLen < minTailLen) {
    const key = tails[0]![tails[0]!.length - 1 - suffixLen]!.key;
    let allMatch = true;
    for (let r = 1; r < tails.length; r++) {
      const tr = tails[r]!;
      if (tr[tr.length - 1 - suffixLen]!.key !== key) {
        allMatch = false;
        break;
      }
    }
    if (!allMatch) break;
    suffixLen += 1;
  }

  const cores = tails.map((t) => t.slice(0, t.length - suffixLen));
  const nonEmptyCore = cores.some((c) => c.length > 0);

  if (nonEmptyCore) {
    const buckets = new Map<string, AtomicBlock[][]>();
    for (const c of cores) {
      const key = c[0]?.key ?? '__END__';
      const arr = buckets.get(key) ?? [];
      arr.push(c);
      buckets.set(key, arr);
    }

    const sortedBuckets = Array.from(buckets.entries())
      .map(([key, items]) => ({ key, items }))
      .sort((a, b) => {
        if (a.key === '__END__') return 1;
        if (b.key === '__END__') return -1;
        return a.items.length - b.items.length || a.key.localeCompare(b.key);
      });

    const buildBranchChain = (
      remaining: { key: string; items: AtomicBlock[][] }[],
      totalCount: number,
    ): PlanStep => {
      const first = remaining[0]!;
      const rest = remaining.slice(1);
      const prob = Number((first.items.length / Math.max(1, totalCount)).toFixed(4));
      const thenSteps =
        first.key === '__END__' ? [] : buildPlanStepsFromTraces(first.items, pgCounter);
      let elseSteps: PlanStep[];
      if (rest.length === 0) {
        elseSteps = [];
      } else if (rest.length === 1) {
        elseSteps =
          rest[0]!.key === '__END__' ? [] : buildPlanStepsFromTraces(rest[0]!.items, pgCounter);
      } else {
        elseSteps = [buildBranchChain(rest, totalCount - first.items.length)];
      }
      return {
        kind: 'branch',
        probability: prob,
        then: thenSteps,
        else: elseSteps,
      };
    };

    if (sortedBuckets.length === 1) {
      const only = sortedBuckets[0]!;
      if (only.key !== '__END__') {
        out.push(...buildPlanStepsFromTraces(only.items, pgCounter));
      }
    } else if (sortedBuckets.length >= 2) {
      out.push(buildBranchChain(sortedBuckets, cores.length));
    }
  }

  for (let s = suffixLen; s >= 1; s--) {
    out.push(
      ...materializeBlock(
        tails.map((t) => t[t.length - s]!),
        pgCounter,
      ),
    );
  }

  return out;
}

/** Recursively counts conditional `branch` steps inside a CallPlan step tree. */
export function countPlanBranches(steps: readonly PlanStep[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.kind === 'branch') {
      count += 1 + countPlanBranches(step.then) + countPlanBranches(step.else);
    }
  }
  return count;
}

function pickWeightedFixture<T extends { weight?: number }>(
  fixtures: readonly T[],
  nextRand: () => number,
): T {
  let total = 0;
  for (const f of fixtures) {
    total += Math.max(0.01, f.weight ?? 1);
  }
  let cursor = nextRand() * total;
  for (const f of fixtures) {
    cursor -= Math.max(0.01, f.weight ?? 1);
    if (cursor <= 0) return f;
  }
  return fixtures[fixtures.length - 1]!;
}

/**
 * Executes a handler N times (default 50, max 500) over weighted fixtures inside QuickJS-WASM,
 * builds a deterministic `CallPlan` with branch probabilities and parallel groups, fits lognormal CPU times,
 * and captures sampled user logs for load replay.
 */
export async function profileHandlerScript(input: ProfileHandlerInput): Promise<ProfileRunSummary> {
  const startWallMs = nowPerfMs();
  const seed = input.seed ?? input.design?.settings.seed ?? 42;
  const iterations = Math.max(1, Math.min(500, Math.round(input.iterations ?? 50)));
  const cpuScale = Math.max(0.01, Math.min(10, input.cpuScale ?? 0.1));
  const cpuBudgetMs = Math.max(500, input.cpuBudgetMs ?? DEFAULT_PROFILE_CPU_BUDGET_MS);
  const maxSampledLogRuns = Math.max(0, Math.min(500, Math.round(input.maxSampledLogRuns ?? 64)));

  const cacheKey = computeProfileCacheKey({
    script: input.script,
    designScripts: input.designScripts,
    fixtures: input.fixtures,
    design: input.design,
    node: input.node,
    customServices: input.customServices,
    seed,
    iterations,
    cpuScale,
    env: input.env,
  });

  const bundleRes = await bundleUserScript({
    entryScript: input.script,
    ...(input.designScripts ? { designScripts: input.designScripts } : {}),
    ...(input.esbuildWasmUrl ? { esbuildWasmUrl: input.esbuildWasmUrl } : {}),
  });

  if (!bundleRes.ok || !bundleRes.code) {
    const firstErr = bundleRes.errors?.[0] ?? {
      category: 'UserCodeError' as const,
      name: 'BuildError',
      message: 'Failed to bundle handler script for profiling',
    };
    const defaultCpu = Number(Math.max(0.2, 4).toFixed(2));
    return {
      callPlan: {
        scriptId: input.script.id,
        cpuMs: { distribution: 'lognormal', p50: defaultCpu, p95: defaultCpu },
        throwProbability: 0,
        steps: [],
      },
      sampleCount: 0,
      measuredGuestCpuMs: { distribution: 'lognormal', p50: 0, p95: 0 },
      scaledCpuMs: { distribution: 'lognormal', p50: defaultCpu, p95: defaultCpu },
      cpuScale,
      branchCount: 0,
      throwProbability: 0,
      sampledLogs: [],
      wallDurationMs: Math.round(nowPerfMs() - startWallMs),
      truncatedByBudget: false,
      cacheKey,
      error: firstErr,
    };
  }

  const prebuiltBundle = {
    code: bundleRes.code,
    ...(bundleRes.sourceMapJson ? { sourceMapJson: bundleRes.sourceMapJson } : {}),
  };

  const guestCpuSamples: number[] = [];
  const okTraces: AtomicBlock[][] = [];
  const allTraces: AtomicBlock[][] = [];
  const sampledLogs: LogEntry[][] = [];
  let failCount = 0;
  let executedRuns = 0;
  let truncatedByBudget = false;
  let firstErrorReport = undefined as ProfileRunSummary['error'];

  const fixtures = input.fixtures ?? [];

  for (let i = 1; i <= iterations; i++) {
    const elapsedWall = nowPerfMs() - startWallMs;
    if (i > 1 && elapsedWall >= cpuBudgetMs) {
      truncatedByBudget = true;
      break;
    }

    const fixtureRng = createSeededPrng(hashSeedParts(seed, 'profile-fixture', i, input.script.id));
    const chosenFixture =
      fixtures.length > 0 ? pickWeightedFixture(fixtures, fixtureRng.next) : undefined;

    const remainingBudgetMs = Math.max(200, Math.floor(cpuBudgetMs - elapsedWall));
    const res = await executeInSandbox({
      script: input.script,
      ...(input.designScripts ? { designScripts: input.designScripts } : {}),
      ...(chosenFixture ? { fixture: chosenFixture } : { event: {} }),
      ...(input.design ? { design: input.design } : {}),
      ...(input.node ? { node: input.node } : {}),
      ...(input.customServices ? { customServices: input.customServices } : {}),
      emitPlatformLogs: false,
      seed,
      seq: i,
      ...(input.env ? { env: input.env } : {}),
      prebuiltBundle,
      limits: {
        timeoutMs: input.script.timeoutMs,
        cpuBudgetMs: Math.min(DEFAULT_DRY_RUN_LIMITS.cpuBudgetMs, remainingBudgetMs),
      },
      ...(input.mockResolver ? { mockResolver: input.mockResolver } : {}),
      ...(input.quickJsWasmUrl ? { quickJsWasmUrl: input.quickJsWasmUrl } : {}),
    });

    executedRuns += 1;
    guestCpuSamples.push(Math.max(0.05, res.guestCpuMs));

    const userLogs = res.logs.filter((l) => l.source === 'user');
    if (userLogs.length > 0 && sampledLogs.length < maxSampledLogRuns) {
      sampledLogs.push(userLogs);
    }

    const blocks = extractTurnBlocks(
      res.calls,
      res.ok,
      res.virtualDurationMs,
      input.design,
      input.node,
    );
    allTraces.push(blocks);
    if (res.ok) {
      okTraces.push(blocks);
    } else {
      failCount += 1;
      if (!firstErrorReport && res.error) {
        firstErrorReport = res.error;
      }
    }
  }

  const measuredGuestCpuMs = fitLatencyModel(guestCpuSamples, 0.05);
  const scaledSamples = guestCpuSamples.map((ms) => Math.max(0.2, ms * cpuScale));
  const scaledCpuMs = fitLatencyModel(scaledSamples, 0.2);

  const tracesForPlan = okTraces.length > 0 ? okTraces : allTraces;
  const pgCounter = { next: 0 };
  const steps = buildPlanStepsFromTraces(tracesForPlan, pgCounter);
  const throwProbability = executedRuns > 0 ? Number((failCount / executedRuns).toFixed(4)) : 0;

  return {
    callPlan: {
      scriptId: input.script.id,
      cpuMs: scaledCpuMs,
      throwProbability,
      steps,
    },
    sampleCount: executedRuns,
    measuredGuestCpuMs,
    scaledCpuMs,
    cpuScale,
    branchCount: countPlanBranches(steps),
    throwProbability,
    sampledLogs,
    wallDurationMs: Math.round(nowPerfMs() - startWallMs),
    truncatedByBudget,
    cacheKey,
    ...(firstErrorReport && okTraces.length === 0 ? { error: firstErrorReport } : {}),
  };
}
