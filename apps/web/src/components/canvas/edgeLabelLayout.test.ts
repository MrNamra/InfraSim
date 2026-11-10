import { describe, expect, it } from 'vitest';
import { computeEdgeLabelPlacement } from './edgeLabelLayout';

describe('computeEdgeLabelPlacement', () => {
  it('keeps label inline along wire midpoint when horizontal gap fits comfortably', () => {
    const out = computeEdgeLabelPlacement({
      sourceX: 264,
      sourceY: 220,
      targetX: 400,
      targetY: 220,
      labelX: 332,
      labelY: 220,
      labelTextLength: 14, // ~105px width -> 136px gap fits easily
    });

    expect(out.isOffset).toBe(false);
    expect(out.x).toBe(332);
    expect(out.y).toBe(220);
    expect(out.stemHeight).toBe(0);
  });

  it('lifts label cleanly above card band when horizontal service gap is too tight', () => {
    const out = computeEdgeLabelPlacement({
      sourceX: 280,
      sourceY: 220,
      targetX: 320,
      targetY: 220,
      labelX: 300,
      labelY: 220,
      labelTextLength: 16, // "https:443 · 80/s"
    });

    expect(out.isOffset).toBe(true);
    expect(out.x).toBe(300);
    expect(out.y).toBeLessThan(220 - 50);
    expect(out.stemHeight).toBeGreaterThan(20);
  });

  it('lifts label when horizontally overlapping or back-looping in the same vertical row', () => {
    const out = computeEdgeLabelPlacement({
      sourceX: 340,
      sourceY: 220,
      targetX: 280,
      targetY: 232,
      labelX: 310,
      labelY: 226,
      labelTextLength: 10,
    });

    expect(out.isOffset).toBe(true);
    expect(out.y).toBe(220 - 62);
  });

  it('keeps live RPS edge label inline across 136px starter template wire gap without hopping', () => {
    const out = computeEdgeLabelPlacement({
      sourceX: 264,
      sourceY: 220,
      targetX: 400,
      targetY: 220,
      labelX: 332,
      labelY: 220,
      labelTextLength: 17, // "https:443 · 160/s"
    });

    expect(out.isOffset).toBe(false);
    expect(out.x).toBe(332);
    expect(out.y).toBe(220);
  });

  it('keeps label inline when vertical distance clears the sibling node cards', () => {
    const out = computeEdgeLabelPlacement({
      sourceX: 300,
      sourceY: 160,
      targetX: 340,
      targetY: 320,
      labelX: 320,
      labelY: 240,
      labelTextLength: 14,
    });

    expect(out.isOffset).toBe(false);
    expect(out.x).toBe(320);
    expect(out.y).toBe(240);
  });
});
