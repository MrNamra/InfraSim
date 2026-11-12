import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportDesignToTerraform, exportTerraformZip } from './exporter.js';
import { validateHclSyntax } from './hcl/validator.js';
import { TERRAFORM_PROVIDERS_CONFIG } from './providersConfig.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

function buildAwsReferenceDesign(): Design {
  const d = createEmptyDesign('aws-ref', 'Order Platform');
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'grp-vpc',
      kind: 'vpc',
      label: 'Primary VPC',
      provider: 'aws',
      region: 'us-east-1',
      cidr: '10.0.0.0/16',
    },
    {
      id: 'grp-pub',
      kind: 'subnet',
      label: 'Public A',
      provider: 'aws',
      parentGroupId: 'grp-vpc',
      cidr: '10.0.1.0/24',
      public: true,
    },
    {
      id: 'grp-priv',
      kind: 'subnet',
      label: 'Private A',
      provider: 'aws',
      parentGroupId: 'grp-vpc',
      cidr: '10.0.2.0/24',
      public: false,
    },
  ];
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'Public ALB',
      position: { x: 200, y: 0 },
      parentGroupId: 'grp-pub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Orders API',
      position: { x: 400, y: 0 },
      parentGroupId: 'grp-priv',
      config: {
        instances: 2,
        instanceType: 't3.small',
        mockEnv: {
          LOG_LEVEL: 'info',
          STRIPE_API_KEY: 'sk_live_SUPER_SECRET_VALUE',
        },
        operations: {},
      },
    },
    {
      id: 'fn',
      serviceId: 'aws.lambda',
      label: 'Order Worker',
      position: { x: 400, y: 120 },
      parentGroupId: 'grp-priv',
      config: {
        instances: 1,
        memoryGb: 0.5,
        mockEnv: {
          DB_PASSWORD: 'do-not-leak-password',
          QUEUE_MODE: 'batch',
        },
        operations: {},
      },
    },
    {
      id: 'sqs',
      serviceId: 'aws.sqs',
      label: 'Orders Queue',
      position: { x: 600, y: 120 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      position: { x: 600, y: 0 },
      parentGroupId: 'grp-priv',
      config: { instances: 2, instanceType: 'db.t3.medium', storageGb: 100, operations: {} },
    },
    {
      id: 'redis',
      serviceId: 'aws.elasticache_redis',
      label: 'Session Cache',
      position: { x: 600, y: 240 },
      parentGroupId: 'grp-priv',
      config: { instances: 2, instanceType: 'cache.t3.micro', operations: {} },
    },
    {
      id: 's3',
      serviceId: 'aws.s3',
      label: 'Invoices Bucket',
      position: { x: 800, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'sm',
      serviceId: 'aws.sagemaker_endpoint',
      label: 'Fraud Scorer',
      position: { x: 800, y: 120 },
      config: { instances: 1, instanceType: 'ml.m5.large', operations: {} },
    },
    {
      id: 'custom',
      serviceId: 'custom.legacy_gw',
      label: 'Mainframe Bridge',
      position: { x: 800, y: 240 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e1',
      from: 'client',
      to: 'alb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e2',
      from: 'alb',
      to: 'api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e3',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e4',
      from: 'sqs',
      to: 'fn',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
  ];
  return d;
}

describe('@infrasim/terraform AWS export', () => {
  it('matches config/providers.json version constraints', () => {
    const raw = JSON.parse(
      readFileSync(resolve(THIS_DIR, '../config/providers.json'), 'utf8'),
    ) as unknown;
    expect(TERRAFORM_PROVIDERS_CONFIG).toEqual(raw);
  });

  it('produces valid HCL across all generated .tf files and README.md', () => {
    const res = exportDesignToTerraform(buildAwsReferenceDesign());
    const names = res.files.map((f) => f.filename);
    expect(names).toEqual([
      'providers.tf',
      'variables.tf',
      'network.tf',
      'compute.tf',
      'data.tf',
      'ai.tf',
      'outputs.tf',
      'README.md',
    ]);

    for (const file of res.files) {
      expect(file.content).toContain('Generated by InfraSim for learning');
      if (file.language === 'hcl') {
        const parsed = validateHclSyntax(file.content, file.filename);
        expect(parsed.errors, `HCL errors in ${file.filename}`).toEqual([]);
        expect(parsed.valid).toBe(true);
      }
    }

    const computeTf = res.files.find((f) => f.filename === 'compute.tf')!.content;
    expect(computeTf).toContain('data "aws_ssm_parameter" "al2023_ami"');
    expect(computeTf).not.toMatch(/ami-[0-9a-f]{8,}/);
    expect(computeTf).toContain('aws_lambda_event_source_mapping');
    expect(computeTf).toContain(
      '# InfraSim: no Terraform mapping for custom.legacy_gw (Mainframe Bridge)',
    );

    expect(res.unsupportedNodes).toHaveLength(1);
    expect(res.unsupportedNodes[0]!.serviceId).toBe('custom.legacy_gw');
  });

  it('never leaks literal secrets and emits sensitive variables without defaults', () => {
    const res = exportDesignToTerraform(buildAwsReferenceDesign());
    const allContent = res.files.map((f) => f.content).join('\n');

    expect(allContent).not.toContain('sk_live_SUPER_SECRET_VALUE');
    expect(allContent).not.toContain('do-not-leak-password');

    const varsTf = res.files.find((f) => f.filename === 'variables.tf')!.content;
    expect(varsTf).toContain('sensitive   = true');
    expect(varsTf).toContain('variable "orders_db_master_password"');
    expect(varsTf).toContain('variable "order_worker_env_db_password"');
    expect(varsTf).toContain('variable "orders_api_env_stripe_api_key"');
    expect(varsTf).not.toMatch(/orders_api_env_stripe_api_key[^}]*default\s*=/);
    expect(varsTf).not.toMatch(/orders_db_master_password[^}]*default\s*=/);
  });

  it('enforces least-privilege security group rules (SG ref for internal hops, 0.0.0.0/0 only from internet)', () => {
    const res = exportDesignToTerraform(buildAwsReferenceDesign());
    const networkTf = res.files.find((f) => f.filename === 'network.tf')!.content;

    // Internet -> ALB gets 0.0.0.0/0 on 443
    expect(networkTf).toContain('cidr_ipv4         = "0.0.0.0/0"');
    // Internal ALB -> API and API -> DB use referenced_security_group_id
    expect(networkTf).toContain('referenced_security_group_id = aws_security_group.public_alb.id');
    expect(networkTf).toContain('referenced_security_group_id = aws_security_group.orders_api.id');
    // No 0.0.0.0/0 ingress on port 5432
    expect(networkTf).not.toMatch(/5432[\s\S]{0,160}0\.0\.0\.0\/0/);
  });

  it('is deterministic and order-independent when nodes, groups, and edges are reordered', () => {
    const base = buildAwsReferenceDesign();
    const reordered = structuredClone(base);
    reordered.nodes = [...reordered.nodes].reverse();
    reordered.groups = [...reordered.groups].reverse();
    reordered.edges = [...reordered.edges].reverse();

    const a = exportDesignToTerraform(base);
    const b = exportDesignToTerraform(reordered);

    expect(b.files).toEqual(a.files);

    const zipA = exportTerraformZip(a);
    const zipB = exportTerraformZip(b);
    expect(Buffer.from(zipA).equals(Buffer.from(zipB))).toBe(true);

    const extracted = unzipSync(zipA);
    expect(Object.keys(extracted).sort()).toEqual(
      a.files.map((f) => `terraform/${f.filename}`).sort(),
    );
    expect(strFromU8(extracted['terraform/providers.tf']!)).toBe(a.files[0]!.content);
  });
});
