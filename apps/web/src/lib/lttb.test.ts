import { describe, expect, it } from 'vitest';
import { downsampleLttb } from './lttb';

describe('downsampleLttb chart decimation', () => {
  it('returns input unmodified when length <= threshold', () => {
    const pts = Array.from({ length: 120 }, (_, i) => ({ x: i, y: Math.sin(i * 0.1) * 50 }));
    const out = downsampleLttb(pts, 500);
    expect(out).toEqual(pts);
  });

  it('caps large time series to <= 500 points while keeping endpoints and sharp spike peaks', () => {
    const pts = Array.from({ length: 3600 }, (_, i) => ({
      x: i,
      y: i === 1800 ? 950 : 10 + (i % 7),
    }));
    const out = downsampleLttb(pts, 500);
    expect(out.length).toBe(500);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(Math.max(...out.map((p) => p.y))).toBe(950);
  });
});
