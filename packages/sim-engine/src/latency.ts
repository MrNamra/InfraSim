import type { LatencyModel } from '@infrasim/shared-types';
import type { SeededRng } from './prng.js';

export const MIN_LATENCY_MS = 0.01;
export const MAX_LATENCY_MS = 600_000;
const Z_95 = 1.6448536269514722;

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

function sampleLognormalPair(p50: number, p95: number, rng: SeededRng): number {
  const safeP50 = Math.max(MIN_LATENCY_MS, p50);
  if (!Number.isFinite(p95) || p95 <= safeP50) {
    return clampLatencyMs(safeP50);
  }
  const mu = Math.log(safeP50);
  const sigma = (Math.log(p95) - mu) / Z_95;
  return clampLatencyMs(Math.exp(mu + sigma * rng.nextGaussian()));
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
      const m2 = model.mode2;
      if (m2 && m2.weight > 0 && rng.chance(m2.weight)) {
        return sampleLognormalPair(m2.p50, m2.p95, rng);
      }
      return sampleLognormalPair(safeP50, model.p95, rng);
    }

    case 'lognormal':
    default:
      return sampleLognormalPair(safeP50, model.p95, rng);
  }
}
