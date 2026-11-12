/** Deterministic 32-bit PRNG (Mulberry32) used across the code sandbox. */
export interface SeededPrng {
  next(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  uuid(): string;
  hex(len: number): string;
}

/** FNV-1a 32-bit hash helper combining seed inputs deterministically. */
export function hashSeedParts(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const str = String(part);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Creates a deterministic seeded PRNG. */
export function createSeededPrng(seedInput: number): SeededPrng {
  let state = seedInput >>> 0 || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const hex = (len: number) => {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(next() * 16) % 16]!;
    }
    return out;
  };

  const uuid = () => {
    const p1 = hex(8);
    const p2 = hex(4);
    const p3 = `4${hex(3)}`;
    const variant = ['8', '9', 'a', 'b'][Math.floor(next() * 4) % 4]!;
    const p4 = `${variant}${hex(3)}`;
    const p5 = hex(12);
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
  };

  return {
    next,
    int(min: number, max: number) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(probability: number) {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return next() < probability;
    },
    uuid,
    hex,
  };
}
