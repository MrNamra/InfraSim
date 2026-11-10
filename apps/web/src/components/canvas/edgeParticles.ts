export const EDGE_PARTICLE_GLOBAL_CAP = 300;

export type ParticleStatus = 'ok' | 'warm' | 'error';

export interface EdgeParticleState {
  offsets: number[];
  cyclesPerSec: number;
  status: ParticleStatus;
}

export interface PathPoint {
  x: number;
  y: number;
}

export interface SampledEdgePath {
  pathD: string;
  length: number;
  points: PathPoint[];
}

/** Computes desired particle count along one edge under reduced-motion and budget constraints. */
export function computeEdgeTargetParticleCount(
  rps: number,
  blocked: boolean,
  reducedMotion: boolean,
): number {
  if (blocked || !Number.isFinite(rps) || rps <= 0) {
    return 0;
  }
  const raw = Math.min(4, Math.max(1, Math.ceil(Math.log10(rps + 1))));
  return reducedMotion ? Math.max(1, Math.floor(raw * 0.25)) : raw;
}

/** Smoothly scales linear pixel traversal velocity along wires from request rate. */
export function computeEdgeVelocityPxPerSec(rps: number): number {
  if (!Number.isFinite(rps) || rps <= 0) {
    return 0;
  }
  return Math.min(240, Math.max(85, 85 + Math.log10(Math.max(1, rps)) * 45));
}

/** Classifies dot color token from edge error rate and average response latency. */
export function computeEdgeParticleStatus(errorRate: number, avgLatencyMs: number): ParticleStatus {
  if (errorRate > 0.1) {
    return 'error';
  }
  if (avgLatencyMs > 250) {
    return 'warm';
  }
  return 'ok';
}

/**
 * Reconciles normalized `[0, 1)` particle offsets when target count changes
 * without resetting active particle positions (preventing timeline jumps).
 */
export function reconcileParticleOffsets(
  existing: readonly number[],
  targetCount: number,
): number[] {
  if (targetCount <= 0) {
    return [];
  }
  if (existing.length === 0) {
    return Array.from({ length: targetCount }, (_, i) => i / targetCount);
  }
  if (existing.length === targetCount) {
    return [...existing];
  }
  if (existing.length > targetCount) {
    return existing.slice(0, targetCount);
  }

  const next = [...existing];
  while (next.length < targetCount) {
    const sorted = [...next].sort((a, b) => a - b);
    let maxGap = -1;
    let insertPos = 0;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const b = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + 1;
      const gap = b - a;
      if (gap > maxGap) {
        maxGap = gap;
        insertPos = (a + gap / 2) % 1;
      }
    }
    next.push(insertPos);
  }
  return next;
}

/** Advances continuous particle phase by `dtSec` with smooth velocity easing. */
export function advanceEdgeParticleState(
  prev: EdgeParticleState | undefined,
  opts: {
    targetCount: number;
    targetCyclesPerSec: number;
    status: ParticleStatus;
    dtSec: number;
  },
): EdgeParticleState {
  const { targetCount, targetCyclesPerSec, status, dtSec } = opts;
  if (targetCount <= 0) {
    return { offsets: [], cyclesPerSec: 0, status };
  }

  const safeDt = Math.min(0.1, Math.max(0, dtSec));
  const initialSpeed =
    prev && prev.cyclesPerSec > 0 ? prev.cyclesPerSec : Math.max(0.25, targetCyclesPerSec);
  const blend = Math.min(1, safeDt * 8);
  const cyclesPerSec = initialSpeed + (targetCyclesPerSec - initialSpeed) * blend;

  const baseOffsets = reconcileParticleOffsets(prev?.offsets ?? [], targetCount);
  const delta = safeDt * cyclesPerSec;
  const offsets = baseOffsets.map((p) => {
    const advanced = p + delta;
    return advanced >= 1 ? advanced % 1 : advanced < 0 ? 0 : advanced;
  });

  return { offsets, cyclesPerSec, status };
}

/** Evaluates a cubic Bezier or straight line fallback LUT from an SVG `d` string. */
function samplePathAnalyticalFallback(pathD: string, steps: number): SampledEdgePath {
  const nums = pathD.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  if (nums.length >= 8) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = [
      nums[0]!,
      nums[1]!,
      nums[2]!,
      nums[3]!,
      nums[4]!,
      nums[5]!,
      nums[6]!,
      nums[7]!,
    ];
    const points: PathPoint[] = [];
    let length = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const x = mt ** 3 * x0 + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x3;
      const y = mt ** 3 * y0 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y3;
      if (i > 0) {
        const prev = points[i - 1]!;
        length += Math.hypot(x - prev.x, y - prev.y);
      }
      points.push({ x, y });
    }
    return { pathD, length, points };
  }

  if (nums.length >= 4) {
    const [x0, y0, x1, y1] = [nums[0]!, nums[1]!, nums[nums.length - 2]!, nums[nums.length - 1]!];
    const length = Math.hypot(x1 - x0, y1 - y0);
    const points: PathPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    }
    return { pathD, length, points };
  }

  return { pathD, length: 0, points: [{ x: 0, y: 0 }] };
}

let sharedSvgPath: SVGPathElement | null = null;

/** Samples an SVG path string into an evenly spaced polyline LUT (DOM-accelerated when available). */
export function sampleEdgePathLut(pathD: string, steps = 48): SampledEdgePath {
  if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
    try {
      if (!sharedSvgPath) {
        sharedSvgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      }
      sharedSvgPath.setAttribute('d', pathD);
      if (typeof sharedSvgPath.getTotalLength === 'function') {
        const length = sharedSvgPath.getTotalLength();
        if (Number.isFinite(length) && length > 0) {
          const points: PathPoint[] = [];
          for (let i = 0; i <= steps; i++) {
            const pt = sharedSvgPath.getPointAtLength((i / steps) * length);
            points.push({ x: pt.x, y: pt.y });
          }
          return { pathD, length, points };
        }
      }
    } catch {
      // Fallback cleanly for malformed SVG paths or mocked DOM environments
    }
  }
  return samplePathAnalyticalFallback(pathD, steps);
}

/** Linearly interpolates `(x, y)` coordinates along a sampled edge path LUT at `t ∈ [0, 1]`. */
export function interpolateLutPoint(lut: SampledEdgePath, t: number): PathPoint {
  const { points } = lut;
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  if (points.length === 1) {
    return points[0]!;
  }
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (points.length - 1);
  const idx = Math.floor(scaled);
  const frac = scaled - idx;
  const p0 = points[idx]!;
  const p1 = points[Math.min(points.length - 1, idx + 1)]!;
  return {
    x: p0.x + (p1.x - p0.x) * frac,
    y: p0.y + (p1.y - p0.y) * frac,
  };
}
