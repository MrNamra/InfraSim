import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import {
  buildPresetFromNode,
  validateErrorRatePercent,
  validateLatencyInput,
  validateRateLimitInput,
} from './inspectorValidation';
import { computeTheoreticalMaxRps } from './nodeDefaults';

describe('inspectorValidation helpers', () => {
  it('enforces p50 > 0, p95 >= p50, and bimodal mode2 constraints without clamping', () => {
    const ok = validateLatencyInput({ distribution: 'lognormal', p50: 15, p95: 60 });
    expect(ok.valid).toBe(true);
    expect(ok.errors).toEqual({});

    const badOrder = validateLatencyInput({ distribution: 'lognormal', p50: 80, p95: 40 });
    expect(badOrder.valid).toBe(false);
    expect(badOrder.errors.p95).toContain('greater than or equal to p50');

    const badBimodal = validateLatencyInput({
      distribution: 'bimodal',
      p50: 10,
      p95: 30,
      mode2Weight: 1.5,
      mode2P50: 200,
      mode2P95: 100,
    });
    expect(badBimodal.valid).toBe(false);
    expect(badBimodal.errors.mode2Weight).toBeDefined();
    expect(badBimodal.errors.mode2P95).toBeDefined();
  });

  it('validates error rate percentages and rate limit numbers', () => {
    expect(validateErrorRatePercent(0.05)).toBeNull();
    expect(validateErrorRatePercent(-1)).toContain('between 0% and 100%');
    expect(validateErrorRatePercent(101)).toContain('between 0% and 100%');

    expect(validateRateLimitInput(1000, 200)).toEqual({});
    expect(validateRateLimitInput(-5, -1)).toEqual({
      rps: 'Throttle limit must be 0 or higher.',
      burst: 'Burst must be 0 or higher.',
    });
  });

  it('builds a reusable preset snapshot and computes theoretical max RPS cleanly', () => {
    const ec2 = getService('aws.ec2')!;
    const preset = buildPresetFromNode(
      {
        id: 'n-ec2',
        serviceId: 'aws.ec2',
        label: 'API server',
        position: { x: 0, y: 0 },
        config: {
          instances: 2,
          vcpu: 2,
          runtimePreset: 'node',
          cluster: true,
          cpuMsPerRequest: 10,
          latency: { distribution: 'lognormal', p50: 25, p95: 90 },
          errorRate: 0.01,
          operations: {},
        },
      },
      ec2,
      'High-load API',
      'preset-1',
    );

    expect(preset.name).toBe('High-load API');
    expect(preset.latency?.p50).toBe(25);
    expect(preset.errorRate).toBe(0.01);

    const maxRps = computeTheoreticalMaxRps(
      {
        instances: 1,
        vcpu: 1,
        runtimePreset: 'node',
        cpuMsPerRequest: 10,
        latency: { distribution: 'lognormal', p50: 20, p95: 60 },
        operations: {},
      },
      ec2,
    );
    expect(maxRps.rps).toBe(100);
    expect(maxRps.limitingFactor).toBe('CPU cores');
  });
});
