export interface PlotPoint {
  x: number;
  y: number;
}

/**
 * Downsamples an ordered time series using Largest-Triangle-Three-Buckets (LTTB)
 * while preserving the first point, last point, and peak visual shape up to `threshold` points.
 */
export function downsampleLttb<T extends PlotPoint>(data: readonly T[], threshold = 500): T[] {
  const len = data.length;
  if (threshold <= 0 || len === 0) {
    return [];
  }
  if (threshold >= len || threshold < 3) {
    return data.slice(0, Math.min(len, Math.max(1, threshold)));
  }

  const sampled: T[] = new Array<T>(threshold);
  let sampledIndex = 0;
  const every = (len - 2) / (threshold - 2);

  let a = 0;
  sampled[sampledIndex++] = data[a]!;

  for (let i = 0; i < threshold - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    const avgRangeStart = Math.floor((i + 1) * every) + 1;
    let avgRangeEnd = Math.floor((i + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < len ? avgRangeEnd : len;

    const avgRangeLength = avgRangeEnd - avgRangeStart;
    if (avgRangeLength > 0) {
      for (let j = avgRangeStart; j < avgRangeEnd; j++) {
        avgX += data[j]!.x;
        avgY += data[j]!.y;
      }
      avgX /= avgRangeLength;
      avgY /= avgRangeLength;
    } else {
      avgX = data[avgRangeStart]?.x ?? data[a]!.x;
      avgY = data[avgRangeStart]?.y ?? data[a]!.y;
    }

    const rangeOffs = Math.floor(i * every) + 1;
    const rangeTo = Math.min(len - 1, Math.floor((i + 1) * every) + 1);

    const pointAx = data[a]!.x;
    const pointAy = data[a]!.y;

    let maxArea = -1;
    let nextA = rangeOffs;
    for (let k = rangeOffs; k < rangeTo; k++) {
      const area =
        Math.abs(
          (pointAx - avgX) * (data[k]!.y - pointAy) - (pointAx - data[k]!.x) * (avgY - pointAy),
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        nextA = k;
      }
    }

    sampled[sampledIndex++] = data[nextA]!;
    a = nextA;
  }

  sampled[sampledIndex] = data[len - 1]!;
  return sampled;
}
