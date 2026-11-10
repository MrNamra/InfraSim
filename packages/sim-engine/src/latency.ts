import type { LatencyModel } from '@infrasim/shared-types';
import type { SeededRng } from './prng.js';

export const MIN_LATENCY_MS = 0.01;
export const MAX_LATENCY_MS = 600_000;
const Z_95 = 1.6448536269514722;

interface CompiledParams {
  p50: number;
  p95: number;
  mu: number;
  sigma: number;
  isDegenerate: boolean;
}

const logParamsCache = new WeakMap<
  object,
  { primary: CompiledParams; secondary?: CompiledParams }
>();

function compileLognormal(p50: number, p95: number): CompiledParams {
  const safeP50 = Number.isFinite(p50) ? Math.max(MIN_LATENCY_MS, p50) : MIN_LATENCY_MS;
  if (!Number.isFinite(p95) || p95 <= safeP50) {
    return { p50: clampLatencyMs(safeP50), p95: safeP50, mu: 0, sigma: 0, isDegenerate: true };
  }
  const mu = Math.log(safeP50);
  const sigma = (Math.log(p95) - mu) / Z_95;
  return { p50: safeP50, p95, mu, sigma, isDegenerate: false };
}

function getCompiled(model: LatencyModel): {
  primary: CompiledParams;
  secondary?: CompiledParams;
} {
  let cached = logParamsCache.get(model);
  if (
    cached &&
    cached.primary.p50 === Math.max(MIN_LATENCY_MS, model.p50) &&
    cached.primary.p95 === model.p95
  ) {
    return cached;
  }
  cached = {
    primary: compileLognormal(model.p50, model.p95),
    ...(model.mode2 ? { secondary: compileLognormal(model.mode2.p50, model.mode2.p95) } : {}),
  };
  logParamsCache.set(model, cached);
  return cached;
}

/** Clamps a latency sample cleanly inside `[0.01 ms, 10 min]` without NaN or Infinity. */
export function clampLatencyMs(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_LATENCY_MS;
  }
  if (value < MIN_LATENCY_MS) {
    return MIN_LATENCY_MS;
  }
  if (value > MAX_LATENCY_MS) {
    return MAX_LATENCY_MS;
  }
  return value;
}

function sampleFromCompiled(c: CompiledParams, rng: SeededRng): number {
  if (c.isDegenerate) {
    return c.p50;
  }
  return clampLatencyMs(Math.exp(c.mu + c.sigma * rng.nextGaussian()));
}

/**
 * Samples a synthetic service or network latency duration from a `LatencyModel`.
 * Supports `fixed`, `lognormal`, `normal`, and `bimodal` distributions.
 */
export function sampleLatency(model: LatencyModel, rng: SeededRng): number {
  const safeP50 = Number.isFinite(model.p50) ? Math.max(MIN_LATENCY_MS, model.p50) : MIN_LATENCY_MS;

  switch (model.distribution) {
    case 'fixed':
      return clampLatencyMs(safeP50);

    case 'normal': {
      if (!Number.isFinite(model.p95) || model.p95 <= safeP50) {
        return clampLatencyMs(safeP50);
      }
      const sigma = (model.p95 - safeP50) / Z_95;
      return clampLatencyMs(safeP50 + sigma * rng.nextGaussian());
    }

    case 'bimodal': {
      const compiled = getCompiled(model);
      const m2 = model.mode2;
      if (m2 && compiled.secondary && m2.weight > 0 && rng.chance(m2.weight)) {
        return sampleFromCompiled(compiled.secondary, rng);
      }
      return sampleFromCompiled(compiled.primary, rng);
    }

    case 'lognormal':
    default: {
      const compiled = getCompiled(model);
      return sampleFromCompiled(compiled.primary, rng);
    }
  }
}
