import type {
  CustomPreset,
  LatencyModel,
  NodeInstance,
  ServiceDefinition,
} from '@infrasim/shared-types';

export interface LatencyValidationResult {
  valid: boolean;
  errors: Partial<Record<'p50' | 'p95' | 'mode2Weight' | 'mode2P50' | 'mode2P95', string>>;
}

/** Validates latency percentile bounds (`p50 > 0`, `p95 >= p50`, and bimodal mode2 fields). */
export function validateLatencyInput(params: {
  distribution: LatencyModel['distribution'];
  p50: number;
  p95: number;
  mode2Weight?: number;
  mode2P50?: number;
  mode2P95?: number;
}): LatencyValidationResult {
  const errors: LatencyValidationResult['errors'] = {};

  if (!Number.isFinite(params.p50) || params.p50 <= 0) {
    errors.p50 = 'p50 must be greater than 0 ms.';
  } else if (params.p50 > 600_000) {
    errors.p50 = 'p50 must be at most 600,000 ms (10 min).';
  }

  if (!Number.isFinite(params.p95) || params.p95 <= 0) {
    errors.p95 = 'p95 must be greater than 0 ms.';
  } else if (Number.isFinite(params.p50) && params.p95 < params.p50) {
    errors.p95 = 'p95 must be greater than or equal to p50.';
  } else if (params.p95 > 600_000) {
    errors.p95 = 'p95 must be at most 600,000 ms (10 min).';
  }

  if (params.distribution === 'bimodal') {
    const w = params.mode2Weight;
    const m2p50 = params.mode2P50;
    const m2p95 = params.mode2P95;

    if (w === undefined || !Number.isFinite(w) || w <= 0 || w > 1) {
      errors.mode2Weight = 'Mode 2 weight must be between 0 and 1.';
    }
    if (m2p50 === undefined || !Number.isFinite(m2p50) || m2p50 <= 0) {
      errors.mode2P50 = 'Mode 2 p50 must be greater than 0 ms.';
    }
    if (m2p95 === undefined || !Number.isFinite(m2p95) || m2p95 <= 0) {
      errors.mode2P95 = 'Mode 2 p95 must be greater than 0 ms.';
    } else if (m2p50 !== undefined && Number.isFinite(m2p50) && m2p95 < m2p50) {
      errors.mode2P95 = 'Mode 2 p95 must be greater than or equal to Mode 2 p50.';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Validates percentage error rate in `[0, 100]`. */
export function validateErrorRatePercent(percent: number): string | null {
  if (!Number.isFinite(percent)) {
    return 'Enter a numeric error rate.';
  }
  if (percent < 0 || percent > 100) {
    return 'Error rate must be between 0% and 100%.';
  }
  return null;
}

/** Validates rate-limit RPS and burst inputs. */
export function validateRateLimitInput(
  rps: number | undefined,
  burst: number | undefined,
): Partial<Record<'rps' | 'burst', string>> {
  const errors: Partial<Record<'rps' | 'burst', string>> = {};
  if (rps !== undefined && (!Number.isFinite(rps) || rps < 0)) {
    errors.rps = 'Throttle limit must be 0 or higher.';
  }
  if (burst !== undefined && (!Number.isFinite(burst) || burst < 0)) {
    errors.burst = 'Burst must be 0 or higher.';
  }
  return errors;
}

/** Captures a reusable CustomPreset from a node's active latency, mock, and capacity settings. */
export function buildPresetFromNode(
  node: NodeInstance,
  service: ServiceDefinition | undefined,
  name: string,
  presetId: string,
): CustomPreset {
  const latency = node.config.latency ?? service?.latency;
  return {
    id: presetId,
    name: name.trim(),
    serviceId: node.serviceId,
    ...(service ? { kind: service.kind } : {}),
    ...(latency ? { latency: structuredClone(latency) } : {}),
    ...(node.config.errorRate !== undefined ? { errorRate: node.config.errorRate } : {}),
    ...(node.config.maxInFlightPerInstance !== undefined
      ? { maxInFlightPerInstance: node.config.maxInFlightPerInstance }
      : {}),
    ...(node.config.rateLimit
      ? {
          rateLimit: {
            ...(node.config.rateLimit.rps !== undefined ? { rps: node.config.rateLimit.rps } : {}),
            ...(node.config.rateLimit.burst !== undefined
              ? { burst: node.config.rateLimit.burst }
              : {}),
            ...(node.config.rateLimit.rpm !== undefined ? { rpm: node.config.rateLimit.rpm } : {}),
            ...(node.config.rateLimit.tpm !== undefined ? { tpm: node.config.rateLimit.tpm } : {}),
          },
        }
      : {}),
    ...(node.config.timeoutMs !== undefined ? { timeoutMs: node.config.timeoutMs } : {}),
  };
}
