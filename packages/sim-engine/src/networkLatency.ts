import type { EdgeInstance, LatencyModel, NodeInstance } from '@infrasim/shared-types';
import { sampleLatency } from './latency.js';
import type { SeededRng } from './prng.js';

export type EdgeLocality = 'same-az' | 'cross-az' | 'cross-region';

/** Determines geographic locality between source and target nodes. */
export function inferEdgeLocality(
  source: NodeInstance | undefined,
  target: NodeInstance | undefined,
): EdgeLocality {
  if (!source || !target) {
    return 'same-az';
  }
  if (source.region && target.region && source.region !== target.region) {
    return 'cross-region';
  }
  if (source.az && target.az && source.az !== target.az) {
    return 'cross-az';
  }
  return 'same-az';
}

const DEFAULT_EDGE_LATENCY_BY_LOCALITY: Record<EdgeLocality, LatencyModel> = {
  'same-az': { distribution: 'lognormal', p50: 0.4, p95: 1.2 },
  'cross-az': { distribution: 'lognormal', p50: 1.5, p95: 3.5 },
  'cross-region': { distribution: 'lognormal', p50: 45, p95: 70 },
};

/**
 * Samples one-way network transport latency for an edge based on user override or placement locality,
 * plus optional payload transmission time (~10 Gbps internal link).
 */
export function sampleEdgeTransportLatency(
  edge: EdgeInstance,
  source: NodeInstance | undefined,
  target: NodeInstance | undefined,
  rng: SeededRng,
): { latencyMs: number; locality: EdgeLocality } {
  const locality = inferEdgeLocality(source, target);
  const model = edge.networkLatency ?? DEFAULT_EDGE_LATENCY_BY_LOCALITY[locality];
  const baseMs = sampleLatency(model, rng);
  const payloadBytes = edge.payloadBytes ?? 1024;
  // 1.25 MB/ms ~= 10 Gbps NIC serialization overhead
  const serializationMs = payloadBytes / 1_250_000;
  return { latencyMs: baseMs + serializationMs, locality };
}
