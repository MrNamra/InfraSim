import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design, type SimulationResult } from '@infrasim/shared-types';
import { DEFAULT_COST_ASSUMPTIONS, type PriceSnapshot } from './types.js';
import {
  compareProvidersCost,
  compareRegionsCost,
  findBestMatchingInstanceType,
} from './compare.js';

function makeTestDesign(): Design {
  const d = createEmptyDesign('d-cmp', 'Compare Test');
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'n-api',
      serviceId: 'aws.ec2',
      label: 'API Compute',
      region: 'us-east-1',
      position: { x: 100, y: 100 },
      config: {
        instances: 2,
        instanceType: 't3.medium',
        vcpu: 2,
        memoryGb: 4,
        operations: {},
      },
    },
    {
      id: 'n-cdn',
      serviceId: 'aws.cloudfront',
      label: 'Edge CDN',
      region: 'us-east-1',
      position: { x: 20, y: 100 },
      config: { instances: 1, operations: {} },
    },
  ];
  return d;
}

const MOCK_SIM_RESULT: SimulationResult = {
  runId: 'run-cmp',
  seed: 42,
  durationS: 60,
  scaled: null,
  summary: {
    totalRequests: 6000,
    success: 6000,
    errors: {},
    p50: 10,
    p95: 25,
    p99: 40,
    throughputRps: 100,
  },
  perNode: {},
  series: { bucketSizeS: 1, buckets: [] },
  traces: [],
  counters: {
    perNode: {
      'n-api': { requests: 6000, instanceSeconds: 120, bytesIn: 0, bytesOut: 0 },
      'n-cdn': { requests: 6000, instanceSeconds: 60, bytesIn: 0, bytesOut: 10_000_000 },
    },
    perEdge: {},
  },
  insights: [],
};

const TEST_ONLY_PRICES: PriceSnapshot = {
  generatedAt: '2026-11-10T00:00:00Z',
  prices: [
    // AWS us-east-1 + ap-south-1
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.medium',
      region: 'us-east-1',
      unit: 'Hours',
      unitPrice: 0.0416,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.medium',
      region: 'ap-south-1',
      unit: 'Hours',
      unitPrice: 0.052,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.cloudfront',
      skuKey: 'requests',
      region: 'us-east-1',
      unit: '1M Requests',
      unitPrice: 1.0,
      currency: 'USD',
    },
    // GCP us-east4
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'core',
      region: 'us-east4',
      unit: 'Hours',
      unitPrice: 0.02,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'ram',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitPrice: 0.003,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.cloud_cdn',
      skuKey: 'requests',
      region: 'us-east4',
      unit: '1M Requests',
      unitPrice: 0.75,
      currency: 'USD',
    },
    // OCI global (region-independent compute model)
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'ocpu',
      region: 'global',
      unit: 'Hours',
      unitPrice: 0.03,
      currency: 'USD',
    },
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'memory',
      region: 'global',
      unit: 'GB-Hours',
      unitPrice: 0.0015,
      currency: 'USD',
    },
  ],
};

describe('compareProvidersCost & compareRegionsCost', () => {
  it('matches closest instance types by vCPU & RAM for each cloud', () => {
    expect(findBestMatchingInstanceType('gcp', 2, 4, 'compute')).toBe('e2-medium');
    expect(findBestMatchingInstanceType('azure', 2, 4, 'compute')).toBe('Standard_B2s');
    expect(findBestMatchingInstanceType('oci', 2, 4, 'compute')).toContain('VM.Standard');
  });

  it('compares AWS vs GCP vs OCI without re-simulating and flags unmapped CloudFront on OCI', () => {
    const res = compareProvidersCost(
      makeTestDesign(),
      MOCK_SIM_RESULT,
      TEST_ONLY_PRICES,
      DEFAULT_COST_ASSUMPTIONS,
      ['aws', 'gcp', 'oci'],
      { nowIso: '2026-11-10T01:00:00Z' },
    );

    expect(res.approximateMapping).toBe(true);
    expect(res.items).toHaveLength(3);

    const aws = res.items.find((i) => i.provider === 'aws')!;
    const gcp = res.items.find((i) => i.provider === 'gcp')!;
    const oci = res.items.find((i) => i.provider === 'oci')!;

    expect(aws.isCurrent).toBe(true);
    expect(aws.monthlyTotal).toBeGreaterThan(60);

    expect(gcp.targetRegion).toBe('us-east4');
    expect(gcp.mappedCount).toBe(2);
    expect(gcp.monthlyTotal).toBeGreaterThan(0);
    expect(gcp.deltaPercent).not.toBeNull();
    expect(gcp.behaviorSummary.some((n) => n.includes('GCP Compute Engine'))).toBe(true);

    // CloudFront has equivalents === 'none' on OCI -> flagged unmapped
    expect(oci.unmappedCount).toBe(1);
    expect(oci.unmappedServices[0]).toContain('Edge CDN');
  });

  it('compares regions on the same cloud and reports unavailable SKUs cleanly', () => {
    const res = compareRegionsCost(
      makeTestDesign(),
      MOCK_SIM_RESULT,
      TEST_ONLY_PRICES,
      DEFAULT_COST_ASSUMPTIONS,
      ['us-east-1', 'ap-south-1'],
      { nowIso: '2026-11-10T01:00:00Z' },
    );

    expect(res.items).toHaveLength(2);
    const east = res.items.find((r) => r.regionCode === 'us-east-1')!;
    const mumbai = res.items.find((r) => r.regionCode === 'ap-south-1')!;

    expect(east.isCurrent).toBe(true);
    expect(east.unavailableCount).toBe(0);

    expect(mumbai.isCurrent).toBe(false);
    // ap-south-1 EC2 rate (0.052) > us-east-1 (0.0416), and CloudFront has 2 unmapped SKU lines (requests + egress) in ap-south-1
    expect(mumbai.unavailableCount).toBe(2);
    expect(mumbai.missingServices).toEqual(['Edge CDN']);
    expect(mumbai.latencyNote).toContain('Intercontinental');
  });
});
