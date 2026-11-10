/** Seeded deterministic pseudo-random generator stream. */
export interface SeededRng {
  /** Uniform float in `[0, 1)`. */
  next: () => number;
  /** Standard normal sample `N(0, 1)`. */
  nextGaussian: () => number;
  /** Uniform float in `[min, max)`. */
  range: (min: number, max: number) => number;
  /** True with probability `p`. */
  chance: (p: number) => boolean;
}

/**
 * Computes a deterministic 32-bit unsigned seed hash from `(seed, nodeId, purpose)`.
 * Ensures each node and purpose uses an isolated RNG stream unaffected by edits to other nodes.
 */
export function hashSeed(seed: number, nodeId: string, purpose: string): number {
  let h = (seed | 0) ^ 0x811c9dc5;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);

  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= 0x9e3779b9;
  for (let i = 0; i < purpose.length; i++) {
    h ^= purpose.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  // Finalizer avalanche mix
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Creates a deterministic Mulberry32 PRNG seeded with a 32-bit integer.
 * Zero `Math.random()` usage anywhere.
 */
export function createRng(seed: number): SeededRng {
  let state = seed >>> 0 || 0x6d2b79f5;
  let spareGaussian: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const nextGaussian = (): number => {
    if (spareGaussian !== null) {
      const value = spareGaussian;
      spareGaussian = null;
      return value;
    }
    const u1 = Math.max(1e-12, next());
    const u2 = next();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const angle = 2.0 * Math.PI * u2;
    spareGaussian = mag * Math.sin(angle);
    return mag * Math.cos(angle);
  };

  const range = (min: number, max: number): number => min + (max - min) * next();
  const chance = (p: number): boolean => (p <= 0 ? false : p >= 1 ? true : next() < p);

  return { next, nextGaussian, range, chance };
}
