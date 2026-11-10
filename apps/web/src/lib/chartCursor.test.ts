import { describe, expect, it } from 'vitest';
import { chartClientXToTimeS, chartTimeSToPercent } from './chartCursor';

describe('T1.14 chart cursor coordinate mapping', () => {
  it('maps SVG plot edges cleanly with horizontal padding padX', () => {
    // rectLeft=100, rectWidth=560 matches SVG units 1:1
    expect(chartClientXToTimeS(104, 100, 560, 600, 560, 4)).toBe(0);
    expect(chartClientXToTimeS(656, 100, 560, 600, 560, 4)).toBe(600);
    // Clamps outside plot borders safely
    expect(chartClientXToTimeS(50, 100, 560, 600, 560, 4)).toBe(0);
    expect(chartClientXToTimeS(800, 100, 560, 600, 560, 4)).toBe(600);
  });

  it('preserves sub-second fractional precision and matches percentage readout', () => {
    expect(chartClientXToTimeS(242, 100, 560, 30, 560, 4)).toBe(7.5);
    expect(chartClientXToTimeS(200, 100, 560, 30, 560, 4)).toBe(5.22);

    const pct0 = chartTimeSToPercent(0, 30, 560, 4);
    const pctMid = chartTimeSToPercent(15, 30, 560, 4);
    const pctEnd = chartTimeSToPercent(30, 30, 560, 4);
    expect(pct0).toBeCloseTo((4 / 560) * 100, 2);
    expect(pctMid).toBeCloseTo(50, 2);
    expect(pctEnd).toBeCloseTo((556 / 560) * 100, 2);
  });
});
