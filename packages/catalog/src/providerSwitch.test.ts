import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { analyzeProviderSwitch, applyProviderSwitch } from './providerSwitch.js';

function makeSampleAwsDesign(): Design {
  const d = createEmptyDesign('d-switch', 'Three tier AWS');
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'g-reg',
      kind: 'region',
      label: 'us-east-1',
      provider: 'aws',
      region: 'us-east-1',
      position: { x: 0, y: 0 },
      size: { width: 800, height: 400 },
    },
  ];
  d.nodes = [
    {
      id: 'n-client',
      serviceId: 'generic.client',
      label: 'Load Generator',
      position: { x: 40, y: 120 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'n-cdn',
      serviceId: 'aws.cloudfront',
      label: 'CloudFront Edge',
      position: { x: 180, y: 120 },
      region: 'us-east-1',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'n-alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      position: { x: 320, y: 120 },
      parentGroupId: 'g-reg',
      region: 'us-east-1',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'n-api',
      serviceId: 'aws.ec2',
      label: 'API Servers',
      position: { x: 480, y: 120 },
      parentGroupId: 'g-reg',
      region: 'us-east-1',
      config: {
        instances: 2,
        instanceType: 't3.medium',
        vcpu: 2,
        memoryGb: 4,
        latency: { distribution: 'lognormal', p50: 14, p95: 42 },
        operations: {},
      },
    },
    {
      id: 'n-db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      position: { x: 640, y: 120 },
      parentGroupId: 'g-reg',
      region: 'us-east-1',
      config: {
        instances: 1,
        instanceType: 'db.t3.medium',
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e1',
      from: 'n-client',
      to: 'n-cdn',
      protocol: 'https',
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e2',
      from: 'n-cdn',
      to: 'n-alb',
      protocol: 'https',
      callType: 'sync',
      weight: 1,
    },
  ];
  return d;
}

describe('providerSwitch', () => {
  it('maps AWS nodes to GCP equivalents while keeping generic nodes and preserving topology', () => {
    const awsDesign = makeSampleAwsDesign();
    const { design: gcpDesign, plan } = applyProviderSwitch(awsDesign, 'gcp', {
      resolveRegion: (_fromProv, fromReg, toProv) =>
        fromReg === 'us-east-1' && toProv === 'gcp'
          ? { targetRegion: 'us-east4', label: 'US East' }
          : undefined,
      resolveInstanceType: (targetProvider, _cfg, _src, targetSvc) =>
        targetProvider === 'gcp' && targetSvc.id === 'gcp.compute_engine'
          ? 'e2-standard-2'
          : undefined,
    });

    expect(plan.approximateMapping).toBe(true);
    expect(plan.mappedCount).toBe(4);
    expect(plan.unmappedCount).toBe(0);
    expect(plan.keptCount).toBe(1);
    expect(gcpDesign.settings.primaryProvider).toBe('gcp');

    const byId = new Map(gcpDesign.nodes.map((n) => [n.id, n]));
    expect(byId.get('n-client')?.serviceId).toBe('generic.client');
    expect(byId.get('n-cdn')?.serviceId).toBe('gcp.cloud_cdn');
    expect(byId.get('n-alb')?.serviceId).toBe('gcp.lb_https');
    expect(byId.get('n-api')?.serviceId).toBe('gcp.compute_engine');
    expect(byId.get('n-api')?.config.instanceType).toBe('e2-standard-2');
    expect(byId.get('n-api')?.config.latency).toEqual({
      distribution: 'lognormal',
      p50: 14,
      p95: 42,
    });
    expect(byId.get('n-db')?.serviceId).toBe('gcp.cloud_sql_postgres');
    expect(byId.get('n-db')?.config.instanceType).toBeUndefined();
    expect(gcpDesign.groups[0]?.region).toBe('us-east4');
    expect(gcpDesign.groups[0]?.label).toBe('us-east4');
    expect(gcpDesign.edges).toEqual(awsDesign.edges);
  });

  it('flags unmapped CloudFront on OCI and supports keeping or converting to custom block', () => {
    const awsDesign = makeSampleAwsDesign();

    const preview = analyzeProviderSwitch(awsDesign, 'oci');
    expect(preview.unmappedCount).toBe(1);
    const cdnDiff = preview.nodeDiffs.find((d) => d.nodeId === 'n-cdn');
    expect(cdnDiff?.status).toBe('unmapped');
    expect(cdnDiff?.suggestCustomBlock).toBe(true);
    expect(cdnDiff?.behaviorNotes[0]).toContain('OCI');

    const converted = applyProviderSwitch(awsDesign, 'oci', {
      unmappedAction: 'convert-to-custom',
    });
    const cdnNode = converted.design.nodes.find((n) => n.id === 'n-cdn');
    expect(cdnNode?.serviceId).toMatch(/^custom\.aws_cloudfront/);
    expect(converted.design.customServices?.some((c) => c.id === cdnNode?.serviceId)).toBe(true);
  });
});
