import { describe, expect, it } from 'vitest';
import {
  advanceEdgeParticleState,
  computeEdgeParticleStatus,
  computeEdgeTargetParticleCount,
  computeEdgeVelocityPxPerSec,
  interpolateLutPoint,
  reconcileParticleOffsets,
  sampleEdgePathLut,
} from './edgeParticles';

describe('edgeParticles continuous animation helpers', () => {
  it('computes desired particle count respecting blocked wires and reduced motion', () => {
    expect(computeEdgeTargetParticleCount(0, false, false)).toBe(0);
    expect(computeEdgeTargetParticleCount(250, true, false)).toBe(0);
    expect(computeEdgeTargetParticleCount(80, false, false)).toBe(2);
    expect(computeEdgeTargetParticleCount(1200, false, false)).toBe(4);
    expect(computeEdgeTargetParticleCount(1200, false, true)).toBe(1);
  });

  it('preserves active particle phases when target count changes dynamically', () => {
    const initial = [0.23, 0.73];
    const grown = reconcileParticleOffsets(initial, 3);
    expect(grown).toHaveLength(3);
    expect(grown[0]).toBeCloseTo(0.23, 5);
    expect(grown[1]).toBeCloseTo(0.73, 5);
    // Inserted midpoint in one of the 0.50 gaps (~0.48 or ~0.98)
    expect(grown[2] === 0.48 || Math.abs(grown[2]! - 0.98) < 1e-6).toBe(true);

    const shrunk = reconcileParticleOffsets(grown, 2);
    expect(shrunk).toEqual([0.23, 0.73]);
  });

  it('advances particle phase smoothly without resets when RPS spikes mid-run', () => {
    const step1 = advanceEdgeParticleState(undefined, {
      targetCount: 2,
      targetCyclesPerSec: 0.7,
      status: 'ok',
      dtSec: 0.016,
    });
    expect(step1.offsets[0]).toBeGreaterThan(0);

    // Spike bumps RPS -> target count changes 2 -> 3 and target velocity doubles; existing dots never reset to 0
    const step2 = advanceEdgeParticleState(step1, {
      targetCount: 3,
      targetCyclesPerSec: 1.5,
      status: 'warm',
      dtSec: 0.016,
    });
    expect(step2.offsets).toHaveLength(3);
    expect(step2.offsets[0]!).toBeGreaterThan(step1.offsets[0]!);
    expect(step2.offsets[1]!).toBeGreaterThan(step1.offsets[1]!);
    expect(step2.cyclesPerSec).toBeGreaterThan(step1.cyclesPerSec);
    expect(step2.cyclesPerSec).toBeLessThan(1.5); // smoothly eased, not snapped
  });

  it('evaluates SVG cubic Bezier path LUTs accurately', () => {
    const lut = sampleEdgePathLut('M 0,100 C 50,100 150,200 200,200', 32);
    expect(lut.length).toBeGreaterThan(200);
    const start = interpolateLutPoint(lut, 0);
    const end = interpolateLutPoint(lut, 1);
    const mid = interpolateLutPoint(lut, 0.5);

    expect(start.x).toBeCloseTo(0, 2);
    expect(start.y).toBeCloseTo(100, 2);
    expect(end.x).toBeCloseTo(200, 2);
    expect(end.y).toBeCloseTo(200, 2);
    expect(mid.x).toBeCloseTo(100, 1);
    expect(mid.y).toBeCloseTo(150, 1);
  });

  it('scales velocity and status semantics deterministically', () => {
    expect(computeEdgeVelocityPxPerSec(10)).toBeLessThan(computeEdgeVelocityPxPerSec(1000));
    expect(computeEdgeParticleStatus(0, 10)).toBe('ok');
    expect(computeEdgeParticleStatus(0.02, 300)).toBe('warm');
    expect(computeEdgeParticleStatus(0.25, 20)).toBe('error');
  });
});
