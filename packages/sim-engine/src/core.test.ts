import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import type { NodeInstance } from '@infrasim/shared-types';
import {
  MinHeap,
  acquireCoreOrQueue,
  advanceStationIntegrals,
  consumeStationWindowIntegrals,
  createRng,
  createStationState,
  createTokenBucket,
  hashSeed,
  releaseCoreAndDequeue,
  releaseSlotAndDequeue,
  resolveNodeCapacities,
  sampleLatency,
  tryAcquireOrEnqueueSlot,
  tryConsumeToken,
} from './index.js';

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

describe('@infrasim/sim-engine T1.5 core primitives', () => {
  it('generates deterministic isolated RNG streams per node and purpose', () => {
    const sA1 = hashSeed(42, 'node-a', 'latency');
    const sA2 = hashSeed(42, 'node-a', 'latency');
    const sB = hashSeed(42, 'node-b', 'latency');
    const sAErr = hashSeed(42, 'node-a', 'error');

    expect(sA1).toBe(sA2);
    expect(sA1).not.toBe(sB);
    expect(sA1).not.toBe(sAErr);

    const r1 = createRng(sA1);
    const r2 = createRng(sA2);
    const seq1 = Array.from({ length: 10 }, () => r1.next());
    const seq2 = Array.from({ length: 10 }, () => r2.next());
    expect(seq1).toEqual(seq2);
  });

  it('orders DES heap events strictly by timestamp and monotonic sequence', () => {
    interface TestEv {
      t: number;
      seq: number;
      label: string;
    }
    const heap = new MinHeap<TestEv>((a, b) => a.t - b.t || a.seq - b.seq);
    heap.push({ t: 50, seq: 3, label: 'c' });
    heap.push({ t: 10, seq: 1, label: 'a' });
    heap.push({ t: 10, seq: 2, label: 'b' });
    heap.push({ t: 25, seq: 4, label: 'd' });

    const popped: string[] = [];
    while (!heap.isEmpty()) {
      popped.push(heap.pop()!.label);
    }
    expect(popped).toEqual(['a', 'b', 'd', 'c']);
  });

  it('fits lognormal latency accurately at p50 and p95 with clamping and bimodal support', () => {
    const rng = createRng(hashSeed(42, 'lat-test', 'latency'));
    const samples: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const val = sampleLatency({ distribution: 'lognormal', p50: 20, p95: 80 }, rng);
      expect(Number.isFinite(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(0.01);
      expect(val).toBeLessThanOrEqual(600_000);
      samples.push(val);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    expect(p50).toBeGreaterThan(18.5);
    expect(p50).toBeLessThan(21.5);
    expect(p95).toBeGreaterThan(75);
    expect(p95).toBeLessThan(85);

    // Fixed returns exact p50
    expect(sampleLatency({ distribution: 'fixed', p50: 12, p95: 40 }, rng)).toBe(12);

    // Bimodal includes slow tail samples
    const biSamples = Array.from({ length: 1000 }, () =>
      sampleLatency(
        {
          distribution: 'bimodal',
          p50: 5,
          p95: 10,
          mode2: { weight: 0.2, p50: 500, p95: 700 },
        },
        rng,
      ),
    );
    const slowCount = biSamples.filter((s) => s > 200).length;
    expect(slowCount).toBeGreaterThan(150);
    expect(slowCount).toBeLessThan(260);
  });

  it('models compute two-constraint separation, queue eviction policy, and token bucket limits', () => {
    const ec2 = getService('aws.ec2');
    const phpNode: NodeInstance = {
      id: 'app-php',
      serviceId: 'aws.ec2',
      label: 'PHP API',
      position: { x: 0, y: 0 },
      config: {
        instances: 1,
        vcpu: 2,
        runtimePreset: 'php-fpm',
        maxInFlightPerInstance: 2,
        queue: { maxLength: 1, policy: 'drop-oldest' },
        operations: {},
      },
    };
    const caps = resolveNodeCapacities(phpNode, ec2, 1);
    expect(caps.totalSlots).toBe(2);
    expect(caps.totalCores).toBe(2);

    const station = createStationState<string, string, string>('app-php', caps, 0);

    // Two slots acquired immediately; third queues; fourth evicts oldest ("req-3")
    expect(tryAcquireOrEnqueueSlot(station, 'req-1', 0)).toEqual({ status: 'acquired' });
    expect(tryAcquireOrEnqueueSlot(station, 'req-2', 0)).toEqual({ status: 'acquired' });
    expect(tryAcquireOrEnqueueSlot(station, 'req-3', 0)).toEqual({ status: 'queued' });
    const evRes = tryAcquireOrEnqueueSlot(station, 'req-4', 50);
    expect(evRes.status).toBe('queued');
    if (evRes.status === 'queued') {
      expect(evRes.evicted?.req).toBe('req-3');
    }

    // Core released during downstream I/O wait even while slots remain occupied
    expect(acquireCoreOrQueue(station, 'req-1', 10, 50).acquired).toBe(true);
    expect(station.busyCores).toBe(1);
    expect(releaseCoreAndDequeue(station, 60)).toBeUndefined();
    expect(station.busyCores).toBe(0);
    expect(station.inFlight).toBe(2); // Slots still held

    // Releasing slot promotes req-4 directly
    expect(releaseSlotAndDequeue(station, 100)?.req).toBe('req-4');
    advanceStationIntegrals(station, 1000);
    const windowMetrics = consumeStationWindowIntegrals(station, 1000, 1000);
    expect(windowMetrics.slotUtil).toBe(1);
    expect(windowMetrics.cpuUtil).toBeCloseTo(0.005, 4);

    // Token bucket enforces burst and refills over time
    const bucket = createTokenBucket(100, 2, 0);
    expect(tryConsumeToken(bucket, 0)).toBe(true);
    expect(tryConsumeToken(bucket, 0)).toBe(true);
    expect(tryConsumeToken(bucket, 0)).toBe(false);
    expect(tryConsumeToken(bucket, 15)).toBe(true); // +1.5 tokens refilled after 15 ms
  });
});
