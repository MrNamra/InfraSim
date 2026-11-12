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

function buildGcpReferenceDesign(): Design {
  const d = createEmptyDesign('gcp-ref', 'GCP SaaS Stack');
  d.settings.primaryProvider = 'gcp';
  d.groups = [
    {
      id: 'gcp-vpc',
      kind: 'vpc',
      label: 'Core Network',
      provider: 'gcp',
      region: 'us-central1',
    },
    {
      id: 'gcp-sub',
      kind: 'subnet',
      label: 'App Subnet',
      provider: 'gcp',
      parentGroupId: 'gcp-vpc',
      cidr: '10.10.1.0/24',
    },
  ];
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Browser',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'lb',
      serviceId: 'gcp.lb_https',
      label: 'Global LB',
      position: { x: 180, y: 0 },
      parentGroupId: 'gcp-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'run',
      serviceId: 'gcp.cloud_run',
      label: 'API Service',
      position: { x: 360, y: 0 },
      parentGroupId: 'gcp-sub',
      config: {
        instances: 2,
        mockEnv: { API_SECRET: 'super-secret-gcp-token', MODE: 'prod' },
        operations: {},
      },
    },
    {
      id: 'gce',
      serviceId: 'gcp.compute_engine',
      label: 'Worker VM',
      position: { x: 360, y: 120 },
      parentGroupId: 'gcp-sub',
      config: { instances: 2, instanceType: 'e2-standard-2', operations: {} },
    },
    {
      id: 'sql',
      serviceId: 'gcp.cloud_sql_postgres',
      label: 'Core PG',
      position: { x: 560, y: 0 },
      parentGroupId: 'gcp-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'pubsub',
      serviceId: 'gcp.pubsub',
      label: 'Events Bus',
      position: { x: 560, y: 120 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'ai',
      serviceId: 'gcp.vertex_endpoint',
      label: 'Ranker Endpoint',
      position: { x: 760, y: 0 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'ge1',
      from: 'client',
      to: 'lb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    { id: 'ge2', from: 'lb', to: 'gce', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'ge3', from: 'gce', to: 'sql', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
    {
      id: 'ge4',
      from: 'pubsub',
      to: 'run',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
  ];
  return d;
}

function buildAzureReferenceDesign(): Design {
  const d = createEmptyDesign('az-ref', 'Azure Platform');
  d.settings.primaryProvider = 'azure';
  d.groups = [
    { id: 'az-vnet', kind: 'vpc', label: 'Core VNet', provider: 'azure', cidr: '10.20.0.0/16' },
    {
      id: 'az-sub',
      kind: 'subnet',
      label: 'App Tier',
      provider: 'azure',
      parentGroupId: 'az-vnet',
      cidr: '10.20.1.0/24',
    },
  ];
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Users',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'agw',
      serviceId: 'azure.app_gateway',
      label: 'App Gateway',
      position: { x: 180, y: 0 },
      parentGroupId: 'az-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'vm',
      serviceId: 'azure.vm',
      label: 'Backend VM',
      position: { x: 360, y: 0 },
      parentGroupId: 'az-sub',
      config: { instances: 2, instanceType: 'Standard_D2s_v3', operations: {} },
    },
    {
      id: 'fn',
      serviceId: 'azure.functions',
      label: 'Async Func',
      position: { x: 360, y: 120 },
      parentGroupId: 'az-sub',
      config: { instances: 1, mockEnv: { CLIENT_SECRET: 'az-secret-xyz' }, operations: {} },
    },
    {
      id: 'pg',
      serviceId: 'azure.postgres_flexible',
      label: 'Orders PG',
      position: { x: 560, y: 0 },
      parentGroupId: 'az-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'aoai',
      serviceId: 'azure.openai',
      label: 'Copilot LLM',
      position: { x: 560, y: 120 },
      config: { instances: 1, ai: { modelLabel: 'gpt-4o-mini' }, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'ae1',
      from: 'client',
      to: 'agw',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    { id: 'ae2', from: 'agw', to: 'vm', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'ae3', from: 'vm', to: 'pg', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
  ];
  return d;
}

function buildOciReferenceDesign(): Design {
  const d = createEmptyDesign('oci-ref', 'OCI Workload');
  d.settings.primaryProvider = 'oci';
  d.groups = [
    { id: 'oci-vcn', kind: 'vpc', label: 'Core VCN', provider: 'oci', cidr: '10.30.0.0/16' },
    {
      id: 'oci-sub',
      kind: 'subnet',
      label: 'App Subnet',
      provider: 'oci',
      parentGroupId: 'oci-vcn',
      cidr: '10.30.1.0/24',
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
      id: 'lb',
      serviceId: 'oci.load_balancer',
      label: 'OCI LB',
      position: { x: 180, y: 0 },
      parentGroupId: 'oci-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'vm',
      serviceId: 'oci.compute',
      label: 'App Pool',
      position: { x: 360, y: 0 },
      parentGroupId: 'oci-sub',
      config: {
        instances: 2,
        vcpu: 4,
        memoryGb: 16,
        autoscaling: {
          min: 2,
          max: 6,
          metric: 'cpu',
          target: 70,
          scaleOutCooldownS: 60,
          scaleInCooldownS: 120,
          warmupS: 30,
          checkIntervalS: 15,
        },
        operations: {},
      },
    },
    {
      id: 'psql',
      serviceId: 'oci.postgres',
      label: 'OCI PG',
      position: { x: 560, y: 0 },
      parentGroupId: 'oci-sub',
      config: { instances: 1, operations: {} },
    },
    {
      id: 'genai',
      serviceId: 'oci.genai',
      label: 'Cohere Endpoint',
      position: { x: 560, y: 120 },
      config: { instances: 1, ai: { provisionedUnits: 2 }, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'oe1',
      from: 'client',
      to: 'lb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    { id: 'oe2', from: 'lb', to: 'vm', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'oe3', from: 'vm', to: 'psql', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
  ];
  return d;
}

describe('@infrasim/terraform GCP, Azure, OCI & Multi-cloud export', () => {
  it('exports valid GCP HCL with project_id variable, Cloud Run, Vertex AI, and least-privilege firewall rules', () => {
    const res = exportDesignToTerraform(buildGcpReferenceDesign());
    for (const file of res.files) {
      if (file.language === 'hcl') {
        expect(validateHclSyntax(file.content, file.filename).errors).toEqual([]);
      }
    }
    const varsTf = res.files.find((f) => f.filename === 'variables.tf')!.content;
    const netTf = res.files.find((f) => f.filename === 'network.tf')!.content;
    const compTf = res.files.find((f) => f.filename === 'compute.tf')!.content;
    const aiTf = res.files.find((f) => f.filename === 'ai.tf')!.content;

    expect(varsTf).toContain('variable "gcp_project_id"');
    expect(varsTf).toContain('variable "api_service_env_api_secret"');
    expect(varsTf).not.toContain('super-secret-gcp-token');
    expect(netTf).toContain('google_compute_firewall');
    expect(netTf).toContain('source_tags = ["svc-worker_vm"]');
    expect(compTf).toContain('google_cloud_run_v2_service');
    expect(aiTf).toContain('google_vertex_ai_endpoint');
    expect(res.unsupportedNodes).toEqual([]);
  });

  it('exports valid Azure HCL with azurerm provider, Cognitive OpenAI, and zero leaked secrets', () => {
    const res = exportDesignToTerraform(buildAzureReferenceDesign());
    for (const file of res.files) {
      if (file.language === 'hcl') {
        expect(validateHclSyntax(file.content, file.filename).errors).toEqual([]);
      }
    }
    const allContent = res.files.map((f) => f.content).join('\n');
    expect(allContent).not.toContain('az-secret-xyz');
    expect(allContent).toContain('azurerm_resource_group');
    expect(allContent).toContain('azurerm_cognitive_account');
    expect(allContent).toContain('azurerm_cognitive_deployment');
    expect(allContent).toContain('azurerm_postgresql_flexible_server');
    expect(res.unsupportedNodes).toEqual([]);
  });

  it('exports valid OCI HCL with compartment_id, instance pools, oci_psql_db_system, and OCI GenAI', () => {
    const res = exportDesignToTerraform(buildOciReferenceDesign());
    for (const file of res.files) {
      if (file.language === 'hcl') {
        expect(validateHclSyntax(file.content, file.filename).errors).toEqual([]);
      }
    }
    const varsTf = res.files.find((f) => f.filename === 'variables.tf')!.content;
    const compTf = res.files.find((f) => f.filename === 'compute.tf')!.content;
    const dataTf = res.files.find((f) => f.filename === 'data.tf')!.content;
    const aiTf = res.files.find((f) => f.filename === 'ai.tf')!.content;

    expect(varsTf).toContain('variable "oci_compartment_id"');
    expect(compTf).toContain('oci_core_instance_configuration');
    expect(compTf).toContain('oci_core_instance_pool');
    expect(dataTf).toContain('oci_psql_db_system');
    expect(aiTf).toContain('oci_generative_ai_dedicated_ai_cluster');
    expect(aiTf).toContain('oci_generative_ai_endpoint');
    expect(res.unsupportedNodes).toEqual([]);
  });

  it('emits provider-prefixed files and all required_providers for multi-cloud designs', () => {
    const aws = buildAwsReferenceDesign();
    const gcp = buildGcpReferenceDesign();
    const multi = createEmptyDesign('multi-1', 'Multi Cloud');
    multi.groups = [...aws.groups, ...gcp.groups];
    multi.nodes = [
      ...aws.nodes.filter((n) => n.id === 'alb' || n.id === 'db'),
      ...gcp.nodes.filter((n) => n.id === 'run' || n.id === 'sql'),
    ];
    multi.edges = [
      {
        id: 'me1',
        from: 'alb',
        to: 'run',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
    ];

    const res = exportDesignToTerraform(multi);
    expect(res.providersIncluded).toEqual(['aws', 'gcp']);
    const filenames = res.files.map((f) => f.filename);
    expect(filenames).toContain('providers.tf');
    expect(filenames).toContain('aws_network.tf');
    expect(filenames).toContain('gcp_network.tf');
    expect(filenames).toContain('aws_data.tf');
    expect(filenames).toContain('gcp_compute.tf');

    const providersTf = res.files.find((f) => f.filename === 'providers.tf')!.content;
    expect(providersTf).toContain('provider "aws"');
    expect(providersTf).toContain('provider "google"');

    for (const file of res.files) {
      if (file.language === 'hcl') {
        expect(validateHclSyntax(file.content, file.filename).errors).toEqual([]);
      }
    }
  });
});
