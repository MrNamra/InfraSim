import { describe, expect, it } from 'vitest';
import type { TrafficProfile } from '@infrasim/shared-types';
import {
  createArrivalStream,
  createRng,
  estimateProfileTotalRequests,
  evaluateProfileRps,
  hashSeed,
  pickWeightedUserFlow,
  sampleProfileCurve,
} from './index.js';

describe('@infrasim/sim-engine T1.6 traffic profiles', () => {
  it('evaluates constant, ramp, spike, steps, diurnal, and custom curves accurately', () => {
    expect(evaluateProfileRps({ kind: 'constant', rps: 150 }, 10, 60)).toBe(150);

    const ramp: TrafficProfile = { kind: 'ramp', fromRps: 0, toRps: 200 };
    expect(evaluateProfileRps(ramp, 0, 60)).toBe(0);
    expect(evaluateProfileRps(ramp, 30, 60)).toBeCloseTo(100, 6);
    expect(evaluateProfileRps(ramp, 60, 60)).toBe(200);

    const spike: TrafficProfile = {
      kind: 'spike',
      baseRps: 50,
      peakRps: 500,
      atS: 20,
      widthS: 10,
    };
    expect(evaluateProfileRps(spike, 15, 60)).toBe(50);
    expect(evaluateProfileRps(spike, 25, 60)).toBe(500);
    expect(evaluateProfileRps(spike, 30, 60)).toBe(50);

    const steps: TrafficProfile = {
      kind: 'steps',
      steps: [
        { atS: 20, rps: 300 },
        { atS: 0, rps: 50 },
      ],
    };
    expect(evaluateProfileRps(steps, 10, 60)).toBe(50);
    expect(evaluateProfileRps(steps, 25, 60)).toBe(300);

    const diurnal: TrafficProfile = {
      kind: 'diurnal',
      meanRps: 100,
      amplitude: 50,
      periodS: 60,
    };
    expect(evaluateProfileRps(diurnal, 15, 60)).toBeCloseTo(150, 4);

    const custom: TrafficProfile = {
      kind: 'custom',
      points: [
        { tS: 0, rps: 10 },
        { tS: 10, rps: 110 },
      ],
    };
    expect(evaluateProfileRps(custom, 5, 60)).toBeCloseTo(60, 4);
    expect(sampleProfileCurve(custom, 20, 10)).toHaveLength(10);
  });

  it('produces unbiased scaled non-homogeneous Poisson arrival counts', () => {
    const spike: TrafficProfile = {
      kind: 'spike',
      baseRps: 100,
      peakRps: 600,
      atS: 10,
      widthS: 10,
    };
    const expectedTotal = estimateProfileTotalRequests(spike, 30);
    // 20s * 100 + 10s * 600 = 8,000 requests
    expect(expectedTotal).toBeCloseTo(8000, -1);

    const rng = createRng(hashSeed(42, 'client', 'arrivals'));
    const nextMs = createArrivalStream(spike, 30, 1, rng);
    let count = 0;
    let prev = -1;
    let inSpikeCount = 0;
    for (;;) {
      const t = nextMs();
      if (t === null) break;
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThan(30_000);
      prev = t;
      count += 1;
      if (t >= 10_000 && t < 20_000) {
        inSpikeCount += 1;
      }
    }

    expect(count).toBeGreaterThan(7500);
    expect(count).toBeLessThan(8500);
    expect(inSpikeCount).toBeGreaterThan(5600);
  });

  it('selects user flows proportionally by weight', () => {
    const rng = createRng(77);
    const flows = [
      { id: 'read', name: 'Read', weight: 9, steps: [{ method: 'GET', path: '/' }] },
      { id: 'write', name: 'Write', weight: 1, steps: [{ method: 'POST', path: '/' }] },
    ];
    let reads = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickWeightedUserFlow(flows, rng)?.id === 'read') {
        reads += 1;
      }
    }
    expect(reads).toBeGreaterThan(850);
    expect(reads).toBeLessThan(950);
  });
});
