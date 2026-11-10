import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design, type SimulationResult } from '@infrasim/shared-types';
import {
  DEFAULT_HOURS_PER_MONTH,
  estimateMonthlyCost,
  estimateWhatIfCost,
  exportCostCsv,
  exportCostMarkdown,
  getTopCostDrivers,
  summarizeCostBreakdown,
  type PriceSnapshot,
} from './index.js';

/** Synthetic test-only prices used strictly inside unit tests (never shipped). */
const TEST_ONLY_PRICES: PriceSnapshot = {
  version: 1,
  generatedAt: '2026-11-10T00:00:00Z',
  staleAfterDays: 7,
  providers: {
    aws: { fetchedAt: '2026-11-09T00:00:00Z', stale: false },
    gcp: { fetchedAt: '2026-11-09T00:00:00Z', stale: false },
    oci: { fetchedAt: '2026-11-09T00:00:00Z', stale: false },
  },
  prices: [
    // AWS EC2
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.micro',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0104,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 1 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 'm5.large',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.096,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 8 },
    },
    // AWS Lambda (requests per 1M + GB-s)
    {
      provider: 'aws',
      serviceId: 'aws.lambda',
      skuKey: 'requests',
      region: 'us-east-1',
      unit: '1M Requests',
      unitRole: 'requests',
      unitPrice: 0.2,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.lambda',
      skuKey: 'duration',
      region: 'us-east-1',
      unit: 'GB-Seconds',
      unitRole: 'gb_second',
      unitPrice: 0.0000166667,
      currency: 'USD',
    },
    // AWS S3 tiered storage (mix)
    {
      provider: 'aws',
      serviceId: 'aws.s3',
      skuKey: 'Standard',
      region: 'us-east-1',
      unit: 'GB-Mo',
      unitRole: 'storage_gb_month',
      unitPrice: 0.023,
      currency: 'USD',
      tierMin: 0,
      tierMax: 51200,
    },
    {
      provider: 'aws',
      serviceId: 'aws.s3',
      skuKey: 'Standard',
      region: 'us-east-1',
      unit: 'GB-Mo',
      unitRole: 'storage_gb_month',
      unitPrice: 0.022,
      currency: 'USD',
      tierMin: 51200,
      tierMax: 512000,
    },
    {
      provider: 'aws',
      serviceId: 'aws.s3',
      skuKey: 'Standard',
      region: 'us-east-1',
      unit: 'GB-Mo',
      unitRole: 'storage_gb_month',
      unitPrice: 0.021,
      currency: 'USD',
      tierMin: 512000,
      tierMax: null,
    },
    {
      provider: 'aws',
      serviceId: 'aws.s3',
      skuKey: 'GET-Requests',
      region: 'us-east-1',
      unit: '1K Requests',
      unitRole: 'requests',
      unitPrice: 0.0004,
      currency: 'USD',
    },
    // AWS DynamoDB RCU / WCU
    {
      provider: 'aws',
      serviceId: 'aws.dynamodb',
      skuKey: 'PayPerRequest-Read',
      region: 'us-east-1',
      unit: '1M Read Units',
      unitRole: 'rcu_hour',
      unitPrice: 0.25,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.dynamodb',
      skuKey: 'PayPerRequest-Write',
      region: 'us-east-1',
      unit: '1M Write Units',
      unitRole: 'wcu_hour',
      unitPrice: 1.25,
      currency: 'USD',
    },
    // AWS Bedrock Tokens
    {
      provider: 'aws',
      serviceId: 'aws.bedrock',
      skuKey: 'Claude-Input',
      region: 'us-east-1',
      unit: '1M Tokens',
      unitRole: 'tokens_1m_in',
      unitPrice: 3.0,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.bedrock',
      skuKey: 'Claude-Output',
      region: 'us-east-1',
      unit: '1M Tokens',
      unitRole: 'tokens_1m_out',
      unitPrice: 15.0,
      currency: 'USD',
    },
    // AWS Transfer SKUs
    {
      provider: 'aws',
      serviceId: 'transfer.internet_egress',
      skuKey: 'AWS-DataTransfer-Out',
      region: 'us-east-1',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0.09,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'transfer.inter_az',
      skuKey: 'AWS-InterAZ-Regional',
      region: 'us-east-1',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0.01,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'transfer.nat_processing',
      skuKey: 'AWS-NatGateway-Bytes',
      region: 'us-east-1',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0.045,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'transfer.privatelink',
      skuKey: 'AWS-VpcEndpoint-Bytes',
      region: 'us-east-1',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0.01,
      currency: 'USD',
    },
    // GCP Compute Engine per-core + per-RAM
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'N2-Core',
      region: 'us-east4',
      unit: 'vCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.0316,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'N2-Ram',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.0042,
      currency: 'USD',
    },
    // OCI Compute OCPU + RAM under region = 'global'
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'B93113',
      region: 'global',
      unit: 'OCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.03,
      currency: 'USD',
    },
    {
      provider: 'oci',
      serviceId: 'oci.compute',
      skuKey: 'B93114',
      region: 'global',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.0015,
      currency: 'USD',
    },
    // OCI Outbound transfer with 10 TB (10240 GB) free band
    {
      provider: 'oci',
      serviceId: 'transfer.internet_egress',
      skuKey: 'B88327',
      region: 'global',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0,
      currency: 'USD',
      tierMin: 0,
      tierMax: 10240,
    },
    {
      provider: 'oci',
      serviceId: 'transfer.internet_egress',
      skuKey: 'B88327',
      region: 'global',
      unit: 'GB',
      unitRole: 'data_transfer_gb',
      unitPrice: 0.0085,
      currency: 'USD',
      tierMin: 10240,
      tierMax: null,
    },
  ],
};

function makeSimResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    runId: 'run-1',
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
    counters: { perNode: {}, perEdge: {} },
    insights: [],
    ...overrides,
  };
}

describe('@infrasim/cost-engine estimator & exports', () => {
  it('uses 730 hours per month by default', () => {
    expect(DEFAULT_HOURS_PER_MONTH).toBe(730);
  });

  it('scales a 60 s run at 100 RPS to exact monthly requests (262,800,000)', () => {
    const design: Design = {
      ...createEmptyDesign('d-scale', 'Scale check'),
      nodes: [
        {
          id: 'fn1',
          serviceId: 'aws.lambda',
          label: 'Worker',
          position: { x: 0, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, memoryGb: 0.5, operations: {} },
        },
      ],
    };
    const sim = makeSimResult({
      durationS: 60,
      summary: {
        totalRequests: 6000,
        success: 6000,
        errors: {},
        p50: 15,
        p95: 30,
        p99: 45,
        throughputRps: 100,
      },
      counters: {
        perNode: {
          fn1: { requests: 6000, instanceSeconds: 60, bytesIn: 0, bytesOut: 0, gbSeconds: 300 },
        },
        perEdge: {},
      },
    });

    const report = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES);
    const meta = summarizeCostBreakdown(design, report, sim);

    // 100 RPS * 730 hours * 3600 sec/hr = 262,800,000 monthly requests
    expect(meta.monthlyRequests).toBe(262_800_000);
    // 262.8M * $0.20/1M = $52.56 requests + (300 * 43800 = 13,140,000 GB-s * $0.0000166667 = $219.000438)
    const reqLine = report.perNode.fn1!.lines.find((l) => l.dimension === 'requests');
    expect(reqLine?.quantity).toBeCloseTo(262.8, 4);
    expect(reqLine?.amount).toBeCloseTo(52.56, 2);
    expect(report.warnings).toHaveLength(0);
  });

  it('applies progressive tiered pricing across tier boundaries and honors includeFreeTier', () => {
    const design: Design = {
      ...createEmptyDesign('d-tiers', 'Tiered storage'),
      nodes: [
        {
          id: 'client',
          serviceId: 'generic.client',
          label: 'Client',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 's3',
          serviceId: 'aws.s3',
          label: 'Data Lake',
          position: { x: 200, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, storageGb: 100_000, operations: {} },
        },
        {
          id: 'ociNode',
          serviceId: 'oci.compute',
          label: 'OCI App',
          position: { x: 400, y: 0 },
          region: 'us-ashburn-1',
          config: {
            instances: 1,
            instanceType: 'VM.Standard.E4.Flex',
            vcpu: 2,
            memoryGb: 16,
            operations: {},
          },
        },
      ],
      edges: [
        {
          id: 'e-oci-out',
          from: 'ociNode',
          to: 'client',
          protocol: 'https',
          callType: 'sync',
          weight: 1,
        },
      ],
    };

    const sim = makeSimResult({
      durationS: 60,
      counters: {
        perNode: {
          s3: { requests: 1000, instanceSeconds: 60, bytesIn: 0, bytesOut: 0 },
          ociNode: { requests: 0, instanceSeconds: 60, bytesIn: 0, bytesOut: 0 },
        },
        perEdge: {
          // 1 GB per minute * 43800 = 43,800 GB/mo over OCI 10,240 GB free band
          'e-oci-out': {
            bytes: 1024 ** 3,
            crossAz: false,
            crossRegion: false,
            viaNat: false,
          },
        },
      },
    });

    const paidOnly = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES, {
      includeFreeTier: false,
    });
    const withFree = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES, {
      includeFreeTier: true,
    });

    const s3Storage = paidOnly.perNode.s3!.lines.find((l) => l.dimension === 'storage');
    // 51,200 * $0.023 ($1177.60) + 48,800 * $0.022 ($1073.60) = $2251.20
    expect(s3Storage?.amount).toBeCloseTo(2251.2, 2);

    const ociXferNoFree = paidOnly.transfer.find((l) => l.dimension === 'Internet egress');
    const ociXferWithFree = withFree.transfer.find((l) => l.dimension === 'Internet egress');
    // Without free tier: all 43,800 GB @ $0.0085 = $372.30
    expect(ociXferNoFree?.amount).toBeCloseTo(43800 * 0.0085, 2);
    // With free tier: first 10,240 GB free, remaining 33,560 GB @ $0.0085 = $285.26
    expect(ociXferWithFree?.amount).toBeCloseTo((43800 - 10240) * 0.0085, 2);
  });

  it('converts vcpu-gb-hr correctly for GCP per-core/per-RAM and OCI x86 vs Arm OCPU rules', () => {
    const design: Design = {
      ...createEmptyDesign('d-vcpu', 'GCP + OCI compute'),
      nodes: [
        {
          id: 'gcpVm',
          serviceId: 'gcp.compute_engine',
          label: 'GCP VM',
          position: { x: 0, y: 0 },
          region: 'us-east4',
          config: { instances: 2, vcpu: 4, memoryGb: 16, operations: {} },
        },
        {
          id: 'ociX86',
          serviceId: 'oci.compute',
          label: 'OCI x86',
          position: { x: 200, y: 0 },
          region: 'us-ashburn-1',
          config: {
            instances: 1,
            instanceType: 'VM.Standard.E4.Flex',
            vcpu: 4,
            memoryGb: 16,
            operations: {},
          },
        },
        {
          id: 'ociArm',
          serviceId: 'oci.compute',
          label: 'OCI Arm',
          position: { x: 400, y: 0 },
          region: 'us-ashburn-1',
          config: {
            instances: 1,
            instanceType: 'VM.Standard.A1.Flex',
            vcpu: 4,
            memoryGb: 16,
            operations: {},
          },
        },
      ],
    };

    const report = estimateMonthlyCost(design, null, TEST_ONLY_PRICES);
    // GCP: 2 inst * 4 vCPU * 730 hr * 0.0316 + 2 inst * 16 GB * 730 hr * 0.0042 = $184.544 + $98.112 = $282.656
    expect(report.perNode.gcpVm!.subtotal).toBeCloseTo(282.656, 2);

    // OCI x86: 4 vCPU / 2 = 2 OCPU * 730 * 0.03 ($43.80) + 16 GB * 730 * 0.0015 ($17.52) = $61.32
    expect(report.perNode.ociX86!.subtotal).toBeCloseTo(61.32, 2);

    // OCI Arm (A1.Flex): 4 vCPU / 1 = 4 OCPU * 730 * 0.03 ($87.60) + 16 GB * 730 * 0.0015 ($17.52) = $105.12
    expect(report.perNode.ociArm!.subtotal).toBeCloseTo(105.12, 2);
  });

  it('distinguishes average vs peak autoscaled instance counts', () => {
    const design: Design = {
      ...createEmptyDesign('d-autoscale', 'Autoscaling cost'),
      nodes: [
        {
          id: 'api',
          serviceId: 'aws.ec2',
          label: 'API Fleet',
          position: { x: 0, y: 0 },
          region: 'us-east-1',
          config: { instances: 2, instanceType: 'm5.large', operations: {} },
        },
      ],
    };
    const buckets = [
      {
        tS: 1,
        rpsIn: 50,
        throughputRps: 50,
        errorRate: 0,
        p50: 10,
        p95: 20,
        p99: 30,
        perNode: {
          api: {
            rpsIn: 50,
            rpsOut: 50,
            errors: 0,
            drops: 0,
            utilization: 0.2,
            cpuUtilization: 0.1,
            queueDepth: 0,
            inFlight: 1,
            instancesActive: 2,
            p50: 10,
            p95: 20,
            p99: 30,
          },
        },
      },
      {
        tS: 2,
        rpsIn: 300,
        throughputRps: 300,
        errorRate: 0,
        p50: 12,
        p95: 25,
        p99: 40,
        perNode: {
          api: {
            rpsIn: 300,
            rpsOut: 300,
            errors: 0,
            drops: 0,
            utilization: 0.7,
            cpuUtilization: 0.5,
            queueDepth: 0,
            inFlight: 5,
            instancesActive: 6,
            p50: 12,
            p95: 25,
            p99: 40,
          },
        },
      },
    ];
    const sim = makeSimResult({
      durationS: 60,
      series: { bucketSizeS: 1, buckets },
      counters: {
        perNode: {
          api: { requests: 6000, instanceSeconds: 180, bytesIn: 0, bytesOut: 0 }, // 180 / 60 = 3.0 avg instances
        },
        perEdge: {},
      },
    });

    const avgReport = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES, {
      instanceCountMode: 'average',
    });
    const peakReport = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES, {
      instanceCountMode: 'peak',
    });

    // Avg: 3 inst * 730 * 0.096 = $210.24
    expect(avgReport.perNode.api!.subtotal).toBeCloseTo(210.24, 2);
    // Peak: 6 inst * 730 * 0.096 = $420.48
    expect(peakReport.perNode.api!.subtotal).toBeCloseTo(420.48, 2);
  });

  it('picks distinct SKUs for Internet Egress, Cross-AZ, NAT, and PrivateLink while keeping same-AZ free', () => {
    const design: Design = {
      ...createEmptyDesign('d-xfer', 'Transfer SKU breakdown'),
      nodes: [
        {
          id: 'c',
          serviceId: 'generic.client',
          label: 'Users',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 'alb',
          serviceId: 'aws.alb',
          label: 'ALB',
          position: { x: 100, y: 0 },
          region: 'us-east-1',
          az: 'az-a',
          config: { instances: 1, operations: {} },
        },
        {
          id: 'appA',
          serviceId: 'aws.ec2',
          label: 'App A',
          position: { x: 200, y: 0 },
          region: 'us-east-1',
          az: 'az-a',
          config: { instances: 1, instanceType: 't3.micro', operations: {} },
        },
        {
          id: 'dbB',
          serviceId: 'aws.ec2',
          label: 'DB B',
          position: { x: 300, y: 0 },
          region: 'us-east-1',
          az: 'az-b',
          config: { instances: 1, instanceType: 't3.micro', operations: {} },
        },
        {
          id: 'nat',
          serviceId: 'aws.nat_gw',
          label: 'NAT',
          position: { x: 400, y: 0 },
          region: 'us-east-1',
          az: 'az-a',
          config: { instances: 1, operations: {} },
        },
        {
          id: 'vpce',
          serviceId: 'aws.dynamodb',
          label: 'DDB',
          position: { x: 500, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, operations: {} },
        },
      ],
      edges: [
        { id: 'e-inet', from: 'c', to: 'alb', protocol: 'https', callType: 'sync', weight: 1 },
        { id: 'e-same', from: 'alb', to: 'appA', protocol: 'http', callType: 'sync', weight: 1 },
        { id: 'e-az', from: 'appA', to: 'dbB', protocol: 'sql', callType: 'sync', weight: 1 },
        { id: 'e-nat', from: 'appA', to: 'nat', protocol: 'https', callType: 'sync', weight: 1 },
        {
          id: 'e-pl',
          from: 'appA',
          to: 'vpce',
          protocol: 'https',
          callType: 'sync',
          weight: 1,
          tunnel: 'privatelink',
        },
      ],
    };

    const oneGb = 1024 ** 3;
    const sim = makeSimResult({
      durationS: 730 * 3600, // 1:1 monthly counters (scale = 1)
      counters: {
        perNode: {
          alb: { requests: 1000, instanceSeconds: 730 * 3600, bytesIn: oneGb, bytesOut: oneGb },
          appA: { requests: 1000, instanceSeconds: 730 * 3600, bytesIn: oneGb, bytesOut: oneGb },
          dbB: { requests: 1000, instanceSeconds: 730 * 3600, bytesIn: oneGb, bytesOut: oneGb },
          nat: { requests: 1000, instanceSeconds: 730 * 3600, bytesIn: oneGb, bytesOut: oneGb },
          vpce: {
            requests: 1000,
            instanceSeconds: 730 * 3600,
            bytesIn: oneGb,
            bytesOut: oneGb,
            readUnits: 1000,
            writeUnits: 1000,
          },
        },
        perEdge: {
          'e-inet': { bytes: 10 * oneGb, crossAz: false, crossRegion: false, viaNat: false },
          'e-same': { bytes: 10 * oneGb, crossAz: false, crossRegion: false, viaNat: false },
          'e-az': { bytes: 10 * oneGb, crossAz: true, crossRegion: false, viaNat: false },
          'e-nat': { bytes: 10 * oneGb, crossAz: false, crossRegion: false, viaNat: true },
          'e-pl': {
            bytes: 10 * oneGb,
            crossAz: false,
            crossRegion: false,
            viaNat: false,
            viaPrivateLink: true,
          },
        },
      },
    });

    const report = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES);
    const byDim = new Map(report.transfer.map((t) => [t.dimension, t]));

    expect(byDim.get('Internet egress')?.skuKey).toBe('AWS-DataTransfer-Out');
    expect(byDim.get('Internet egress')?.amount).toBeCloseTo(0.9, 2);

    expect(byDim.get('Same-AZ transfer (free)')?.amount).toBe(0);

    expect(byDim.get('Inter-AZ transfer')?.skuKey).toBe('AWS-InterAZ-Regional');
    expect(byDim.get('Inter-AZ transfer')?.amount).toBeCloseTo(0.1, 2);

    expect(byDim.get('NAT processing')?.skuKey).toBe('AWS-NatGateway-Bytes');
    expect(byDim.get('NAT processing')?.amount).toBeCloseTo(0.45, 2);

    expect(byDim.get('PrivateLink data')?.skuKey).toBe('AWS-VpcEndpoint-Bytes');
    expect(byDim.get('PrivateLink data')?.amount).toBeCloseTo(0.1, 2);
  });

  it('emits unavailable line excluded from totals with warnings and honors snapshot staleness & <60s checks', () => {
    const design: Design = {
      ...createEmptyDesign('d-missing', 'Missing SKU + stale snapshot'),
      nodes: [
        {
          id: 'known',
          serviceId: 'aws.ec2',
          label: 'Known EC2',
          position: { x: 0, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, instanceType: 't3.micro', operations: {} },
        },
        {
          id: 'missing',
          serviceId: 'aws.ec2',
          label: 'Custom Size EC2',
          position: { x: 200, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, instanceType: 'c99.imaginary', operations: {} },
        },
        {
          id: 'batch',
          serviceId: 'aws.batch',
          label: 'Batch Control Plane',
          position: { x: 400, y: 0 },
          region: 'us-east-1',
          config: { instances: 1, operations: {} },
        },
      ],
    };

    const shortSim = makeSimResult({ durationS: 30 });
    const report = estimateMonthlyCost(
      design,
      shortSim,
      TEST_ONLY_PRICES,
      {},
      {
        nowIso: '2026-11-25T00:00:00Z', // > 7 days after 2026-11-09 fetchedAt
      },
    );

    // Missing and Batch lines MUST be unavailable (unitPrice: null, amount: null) and excluded from total
    expect(report.perNode.missing!.lines[0]!.source).toBe('unavailable');
    expect(report.perNode.missing!.lines[0]!.unitPrice).toBeNull();
    expect(report.perNode.missing!.lines[0]!.amount).toBeNull();
    expect(report.perNode.batch!.lines[0]!.source).toBe('unavailable');
    expect(report.perNode.batch!.subtotal).toBe(0);

    // Only Known t3.micro (730 * 0.0104 = $7.592) is summed
    expect(report.monthlyTotal).toBeCloseTo(7.592, 3);
    expect(report.warnings.some((w) => w.includes('older than 7 days'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('shorter than 60 s'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('Price unavailable'))).toBe(true);
  });

  it('converts currencies with user FX rate, ranks top-3 drivers, estimates what-if changes, and exports CSV/MD', () => {
    const design: Design = {
      ...createEmptyDesign('d-fx', 'Bedrock + FX + Drivers'),
      nodes: [
        {
          id: 'llm',
          serviceId: 'aws.bedrock',
          label: 'Bedrock',
          position: { x: 0, y: 0 },
          region: 'us-east-1',
          config: {
            instances: 1,
            rateLimit: { maxContextTokens: 1000, maxOutputTokens: 400 },
            operations: {},
          },
        },
        {
          id: 'api',
          serviceId: 'aws.ec2',
          label: 'App',
          position: { x: 200, y: 0 },
          region: 'us-east-1',
          config: { instances: 2, instanceType: 'm5.large', operations: {} },
        },
      ],
    };

    const sim = makeSimResult({
      durationS: 60,
      summary: {
        totalRequests: 600,
        success: 600,
        errors: {},
        p50: 20,
        p95: 40,
        p99: 60,
        throughputRps: 10,
      },
      counters: {
        perNode: {
          llm: { requests: 600, instanceSeconds: 60, bytesIn: 0, bytesOut: 0 },
          api: { requests: 600, instanceSeconds: 120, bytesIn: 0, bytesOut: 0 },
        },
        perEdge: {},
      },
    });

    const usdReport = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES);
    const inrReport = estimateMonthlyCost(design, sim, TEST_ONLY_PRICES, {
      currency: 'INR',
      fxRateToUSD: 84,
    });

    expect(inrReport.currency).toBe('INR');
    expect(inrReport.monthlyTotal).toBeCloseTo(usdReport.monthlyTotal * 84, 2);

    const meta = summarizeCostBreakdown(design, inrReport, sim);
    expect(meta.usdMonthlyTotal).toBeCloseTo(usdReport.monthlyTotal, 3);

    const drivers = getTopCostDrivers(usdReport, design, 3);
    expect(drivers.length).toBe(3);
    expect(drivers[0]!.amount).toBeGreaterThanOrEqual(drivers[1]!.amount);

    const whatIf = estimateWhatIfCost(usdReport, design, sim, {
      rpsMultiplier: 2,
      instanceOverrides: { api: 4 },
    });
    expect(whatIf.estimateOnly).toBe(true);
    expect(whatIf.note).toBe('Estimate until re-run');
    expect(whatIf.byNode.api).toBeCloseTo(usdReport.perNode.api!.subtotal * 2, 2);

    const csv = exportCostCsv(usdReport, design);
    expect(csv).toContain('Scope,NodeId,Label,ServiceId,Dimension');
    expect(csv).toContain('Bedrock');

    const md = exportCostMarkdown(usdReport, design);
    expect(md).toContain('# Monthly Cost Estimate');
    expect(md).toContain('On-demand list prices only');
  });
});
