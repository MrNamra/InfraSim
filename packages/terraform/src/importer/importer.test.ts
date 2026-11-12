import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { exportDesignToTerraform, exportTerraformZip } from '../exporter.js';
import { validateHclSyntax } from '../hcl/validator.js';
import { importTerraformJson } from './index.js';
import { parseAndSanitizeTerraformJson } from './sanitizer.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(THIS_DIR, '../__fixtures__');

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf8');
}

function assertNonOverlappingSiblings(design: Design): void {
  const byParent = new Map<string, Design['nodes']>();
  for (const node of design.nodes) {
    const key = node.parentGroupId ?? '__root__';
    const arr = byParent.get(key) ?? [];
    arr.push(node);
    byParent.set(key, arr);
  }
  for (const [, siblings] of byParent) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i]!.position;
        const b = siblings[j]!.position;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        expect(dx >= 40 || dy >= 40).toBe(true);
      }
    }
  }
  for (const node of design.nodes) {
    if (!node.parentGroupId) continue;
    const parent = design.groups.find((g) => g.id === node.parentGroupId);
    expect(parent).toBeDefined();
    expect(parent?.position).toBeDefined();
    expect(parent?.size).toBeDefined();
    const gp = parent!.position!;
    const gs = parent!.size!;
    expect(node.position.x).toBeGreaterThanOrEqual(gp.x);
    expect(node.position.y).toBeGreaterThanOrEqual(gp.y);
    expect(node.position.x).toBeLessThanOrEqual(gp.x + gs.width);
    expect(node.position.y).toBeLessThanOrEqual(gp.y + gs.height);
  }
}

/**
 * Lightweight HCL-to-synthetic-plan-JSON helper that extracts top-level `resource "<type>" "<name>"`
 * blocks, primitive/flat attributes, and symbolic resource references from exported `.tf` content
 * so tests can verify automated round-trips without running a `terraform` binary.
 */
function exportedHclToSyntheticPlan(files: Array<{ filename: string; content: string }>) {
  const hclText = files
    .filter((f) => f.filename.endsWith('.tf'))
    .map((f) => f.content)
    .join('\n');

  const plannedResources: Array<{
    address: string;
    mode: 'managed';
    type: string;
    name: string;
    provider_name: string;
    values: Record<string, unknown>;
  }> = [];
  const configResources: Array<{
    address: string;
    expressions: Record<string, { references?: string[]; constant_value?: unknown }>;
  }> = [];

  const headerRegex = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
  const headers: Array<{ type: string; name: string; bodyStart: number; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(hclText)) !== null) {
    headers.push({
      type: match[1]!,
      name: match[2]!,
      start: match.index,
      bodyStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    // Find matching closing brace at column 0 / brace depth 0
    let depth = 1;
    let pos = h.bodyStart;
    while (pos < hclText.length && depth > 0) {
      const ch = hclText[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }
    const body = hclText.slice(h.bodyStart, Math.max(h.bodyStart, pos - 1));
    const address = `${h.type}.${h.name}`;
    const values: Record<string, unknown> = {};
    const expressions: Record<string, { references?: string[]; constant_value?: unknown }> = {};

    // Extract references from both single-line and multi-line HCL attributes/nested blocks
    const refRegex = /\b((?:aws|google|azurerm|oci)_[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)/g;
    let activeListKey: string | null = null;
    const listRefs: string[] = [];

    const lines = body.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('depends_on')) continue;

      if (activeListKey) {
        for (const rm of line.matchAll(refRegex)) {
          listRefs.push(rm[1]!);
        }
        if (line.includes(']')) {
          if (listRefs.length > 0) {
            expressions[activeListKey] = { references: [...listRefs] };
          }
          activeListKey = null;
          listRefs.length = 0;
        }
        continue;
      }

      const kvMatch = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (!kvMatch) continue;
      const key = kvMatch[1]!;
      const rhs = kvMatch[2]!;
      if (rhs.startsWith('[') && !rhs.includes(']')) {
        activeListKey = key;
        for (const rm of rhs.matchAll(refRegex)) {
          listRefs.push(rm[1]!);
        }
        continue;
      }
      const refMatches = [...rhs.matchAll(refRegex)].map((m) => m[1]!);
      if (refMatches.length > 0) {
        expressions[key] = { references: refMatches };
      } else if (rhs.startsWith('"') && rhs.endsWith('"')) {
        values[key] = rhs.slice(1, -1);
        expressions[key] = { constant_value: values[key] };
      } else if (rhs === 'true' || rhs === 'false') {
        values[key] = rhs === 'true';
        expressions[key] = { constant_value: values[key] };
      } else if (/^-?\d+(\.\d+)?$/.test(rhs)) {
        values[key] = Number(rhs);
        expressions[key] = { constant_value: values[key] };
      } else if (rhs.startsWith('[') && rhs.endsWith(']')) {
        const strItems = [...rhs.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        if (strItems.length > 0) {
          values[key] = strItems;
        }
      }
    }

    // Extract Name tag if present inside tags = { ... }
    const tagNameMatch = /Name\s*=\s*"([^"]+)"/.exec(body);
    if (tagNameMatch) {
      values.tags = { Name: tagNameMatch[1]! };
    }

    // Extract references from nested blocks (e.g., default_action { target_group_arn = ... })
    if (h.type === 'aws_lb_listener') {
      const tgMatch = /\b(aws_lb_target_group\.[a-z0-9_]+\.arn)\b/.exec(body);
      if (tgMatch) {
        (expressions as Record<string, unknown>).default_action = {
          target_group_arn: { references: [tgMatch[1]!] },
        };
      }
    }

    // Synthetic DB subnet group resolution -> point direct subnet ref too when exported via aws_db_subnet_group
    plannedResources.push({
      address,
      mode: 'managed',
      type: h.type,
      name: h.name,
      provider_name: 'registry.terraform.io/hashicorp/aws',
      values,
    });
    configResources.push({ address, expressions });
  }

  return {
    format_version: '1.2',
    terraform_version: '1.8.5',
    planned_values: {
      root_module: { resources: plannedResources },
    },
    configuration: {
      root_module: { resources: configResources },
    },
  };
}

describe('@infrasim/terraform Phase 5 round-trip, fixtures, sanitizer & limits (T5.6)', () => {
  it('round-trips a supported AWS 3-tier design losslessly via export -> synthetic plan JSON -> import', async () => {
    const original = createEmptyDesign('rt-aws-3tier', 'Roundtrip AWS 3-Tier');
    original.settings.primaryProvider = 'aws';
    original.groups = [
      {
        id: 'vpc-main',
        kind: 'vpc',
        provider: 'aws',
        region: 'us-east-1',
        label: 'App VPC',
        cidr: '10.0.0.0/16',
      },
      {
        id: 'sub-pub-a',
        kind: 'subnet',
        provider: 'aws',
        label: 'Public Edge A',
        cidr: '10.0.1.0/24',
        public: true,
        parentGroupId: 'vpc-main',
      },
      {
        id: 'sub-pub-b',
        kind: 'subnet',
        provider: 'aws',
        label: 'Public Edge B',
        cidr: '10.0.2.0/24',
        public: true,
        parentGroupId: 'vpc-main',
      },
      {
        id: 'sub-priv',
        kind: 'subnet',
        provider: 'aws',
        label: 'Private App',
        cidr: '10.0.10.0/24',
        public: false,
        parentGroupId: 'vpc-main',
      },
    ];
    original.nodes = [
      {
        id: 'alb',
        serviceId: 'aws.alb',
        label: 'Public ALB',
        parentGroupId: 'sub-pub-a',
        position: { x: 80, y: 120 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'aws.ec2',
        label: 'Orders API',
        parentGroupId: 'sub-priv',
        position: { x: 320, y: 120 },
        config: { instances: 2, instanceType: 't3.small', operations: {} },
      },
      {
        id: 'db',
        serviceId: 'aws.rds_postgres',
        label: 'Orders PG',
        parentGroupId: 'sub-priv',
        position: { x: 560, y: 120 },
        config: { instances: 1, instanceType: 'db.t3.small', storageGb: 80, operations: {} },
      },
    ];
    original.edges = [
      {
        id: 'e-alb-api',
        from: 'alb',
        to: 'api',
        protocol: 'http',
        port: 8080,
        callType: 'sync',
        weight: 1,
      },
      {
        id: 'e-api-db',
        from: 'api',
        to: 'db',
        protocol: 'sql',
        port: 5432,
        callType: 'sync',
        weight: 1,
      },
    ];

    const exported = exportDesignToTerraform(original);
    expect(exported.unsupportedNodes).toEqual([]);
    for (const file of exported.files) {
      if (file.language === 'hcl') {
        expect(validateHclSyntax(file.content, file.filename).errors).toEqual([]);
      }
    }

    const syntheticPlan = exportedHclToSyntheticPlan(exported.files);
    const reimported = await importTerraformJson(syntheticPlan, { designName: original.name });
    const dst = reimported.design;

    // 1. Groups match kinds, CIDRs, public/private flags, and VPC containment
    const origVpcs = original.groups.filter((g) => g.kind === 'vpc');
    const dstVpcs = dst.groups.filter((g) => g.kind === 'vpc');
    expect(dstVpcs).toHaveLength(origVpcs.length);
    expect(dstVpcs[0]?.cidr).toBe('10.0.0.0/16');

    const dstSubs = dst.groups.filter((g) => g.kind === 'subnet');
    expect(dstSubs).toHaveLength(3);
    expect(dstSubs.every((s) => s.parentGroupId === dstVpcs[0]!.id)).toBe(true);
    expect(dstSubs.map((s) => s.cidr).sort()).toEqual([
      '10.0.1.0/24',
      '10.0.10.0/24',
      '10.0.2.0/24',
    ]);
    expect(dstSubs.find((s) => s.cidr === '10.0.1.0/24')?.public).toBe(true);
    expect(dstSubs.find((s) => s.cidr === '10.0.2.0/24')?.public).toBe(true);
    expect(dstSubs.find((s) => s.cidr === '10.0.10.0/24')?.public).toBe(false);

    // 2. Service IDs and subnet containment hierarchy preserved
    expect(dst.nodes.map((n) => n.serviceId).sort()).toEqual([
      'aws.alb',
      'aws.ec2',
      'aws.rds_postgres',
    ]);
    const reAlb = dst.nodes.find((n) => n.serviceId === 'aws.alb')!;
    const reApi = dst.nodes.find((n) => n.serviceId === 'aws.ec2')!;
    const reDb = dst.nodes.find((n) => n.serviceId === 'aws.rds_postgres')!;

    expect(dstSubs.find((s) => s.id === reAlb.parentGroupId)?.public).toBe(true);
    expect(dstSubs.find((s) => s.id === reApi.parentGroupId)?.cidr).toBe('10.0.10.0/24');
    expect(dstSubs.find((s) => s.id === reDb.parentGroupId)?.cidr).toBe('10.0.10.0/24');

    // 3. Topology edges preserved (ALB -> EC2 and EC2 -> RDS PG on sql:5432)
    expect(dst.edges.some((e) => e.from === reAlb.id && e.to === reApi.id)).toBe(true);
    const apiToDb = dst.edges.find((e) => e.from === reApi.id && e.to === reDb.id);
    expect(apiToDb).toBeDefined();
    expect(apiToDb?.protocol).toBe('sql');
    expect(apiToDb?.port).toBe(5432);
  });

  it('produces byte-identical snapshots and valid ZIP archives across repeated & permuted runs', () => {
    const design = createEmptyDesign('snap-multi', 'Deterministic Snapshot');
    design.groups = [
      { id: 'v1', kind: 'vpc', provider: 'aws', label: 'Main VPC', cidr: '10.0.0.0/16' },
      {
        id: 's1',
        kind: 'subnet',
        provider: 'aws',
        parentGroupId: 'v1',
        label: 'App',
        cidr: '10.0.1.0/24',
        public: false,
      },
    ];
    design.nodes = [
      {
        id: 'n1',
        serviceId: 'aws.alb',
        label: 'ALB',
        parentGroupId: 's1',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'n2',
        serviceId: 'aws.ec2',
        label: 'API',
        parentGroupId: 's1',
        position: { x: 200, y: 0 },
        config: { instances: 2, instanceType: 't3.medium', operations: {} },
      },
      {
        id: 'n3',
        serviceId: 'gcp.pubsub',
        label: 'Events',
        position: { x: 400, y: 0 },
        config: { instances: 1, operations: {} },
      },
    ];
    design.edges = [
      { id: 'e1', from: 'n1', to: 'n2', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    ];

    const permuted = structuredClone(design);
    permuted.nodes.reverse();
    permuted.groups.reverse();

    const first = exportDesignToTerraform(design);
    const second = exportDesignToTerraform(permuted);
    expect(second.files).toEqual(first.files);

    const zipBytesA = exportTerraformZip(first);
    const zipBytesB = exportTerraformZip(second);
    expect(Buffer.from(zipBytesA).equals(Buffer.from(zipBytesB))).toBe(true);
    expect(Object.keys(unzipSync(zipBytesA)).length).toBe(first.files.length);
  });

  it('imports synthetic AWS plan JSON cleanly, strips all secrets, and keeps unsupported Redshift as custom node', async () => {
    const raw = readFixture('aws-plan.synthetic.json');
    const result = await importTerraformJson(raw, { designName: 'AWS Synthetic' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('SYNTHETIC_SECRET_VALUE');
    expect(serialized).not.toContain('SYNTHETIC_TOKEN');
    expect(result.report.strippedSensitiveCount).toBeGreaterThanOrEqual(2);

    expect(result.report.providersDetected).toEqual(['aws']);
    expect(result.report.groupCount).toBe(3);
    expect(result.report.mappedCount).toBe(5);
    expect(result.report.unsupported).toHaveLength(1);
    expect(result.report.unsupported[0]!.type).toBe('aws_redshift_cluster');

    const customNode = result.design.nodes.find(
      (n) => n.serviceId === 'custom.tf_aws_redshift_cluster',
    );
    expect(customNode).toBeDefined();

    const alb = result.design.nodes.find((n) => n.serviceId === 'aws.alb')!;
    const api = result.design.nodes.find((n) => n.serviceId === 'aws.ec2')!;
    const db = result.design.nodes.find((n) => n.serviceId === 'aws.rds_postgres')!;
    const sqs = result.design.nodes.find((n) => n.serviceId === 'aws.sqs')!;
    const fn = result.design.nodes.find((n) => n.serviceId === 'aws.lambda')!;

    expect(result.design.edges.some((e) => e.from === alb.id && e.to === api.id)).toBe(true);
    expect(result.design.edges.some((e) => e.from === api.id && e.to === db.id)).toBe(true);
    expect(
      result.design.edges.some(
        (e) => e.from === sqs.id && e.to === fn.id && e.callType === 'async',
      ),
    ).toBe(true);

    assertNonOverlappingSiblings(result.design);
  });

  it('imports synthetic GCP plan JSON with Cloud Run masked env, Cloud SQL link, and PubSub push', async () => {
    const raw = readFixture('gcp-plan.synthetic.json');
    const result = await importTerraformJson(raw, { designName: 'GCP Synthetic' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('SYNTHETIC_ACCESS_KEY');
    expect(result.report.strippedSensitiveCount).toBeGreaterThanOrEqual(1);
    expect(result.report.providersDetected).toEqual(['gcp']);

    const lb = result.design.nodes.find((n) => n.serviceId === 'gcp.lb_https')!;
    const mig = result.design.nodes.find((n) => n.serviceId === 'gcp.compute_engine')!;
    const run = result.design.nodes.find((n) => n.serviceId === 'gcp.cloud_run')!;
    const sql = result.design.nodes.find((n) => n.serviceId === 'gcp.cloud_sql_postgres')!;
    const pubsub = result.design.nodes.find((n) => n.serviceId === 'gcp.pubsub')!;

    expect(lb && mig && run && sql && pubsub).toBeTruthy();
    expect(mig.config.instances).toBe(2);
    expect(result.design.edges.some((e) => e.from === lb.id && e.to === mig.id)).toBe(true);
    expect(result.design.edges.some((e) => e.from === run.id && e.to === sql.id)).toBe(true);
    expect(
      result.design.edges.some(
        (e) => e.from === pubsub.id && e.to === run.id && e.callType === 'async',
      ),
    ).toBe(true);

    assertNonOverlappingSiblings(result.design);
  });

  it('imports synthetic Azure plan JSON with Cognitive OpenAI model label and masked client secret', async () => {
    const raw = readFixture('azure-plan.synthetic.json');
    const result = await importTerraformJson(raw, { designName: 'Azure Synthetic' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('SYNTHETIC_CLIENT_SECRET');
    expect(result.report.strippedSensitiveCount).toBeGreaterThanOrEqual(1);
    expect(result.report.providersDetected).toEqual(['azure']);

    const vm = result.design.nodes.find((n) => n.serviceId === 'azure.vm')!;
    const app = result.design.nodes.find((n) => n.serviceId === 'azure.app_service')!;
    const pg = result.design.nodes.find((n) => n.serviceId === 'azure.postgres_flexible')!;
    const aoai = result.design.nodes.find((n) => n.serviceId === 'azure.openai')!;

    expect(vm.parentGroupId).toBeTruthy();
    expect(aoai.config.ai?.modelLabel).toBe('gpt-4o-mini');
    expect(result.design.edges.some((e) => e.from === app.id && e.to === pg.id)).toBe(true);
    assertNonOverlappingSiblings(result.design);
  });

  it('imports synthetic OCI plan JSON with Flex VM shape, oci_psql_db_system vCPU/memory, and NSG rules', async () => {
    const raw = readFixture('oci-plan.synthetic.json');
    const result = await importTerraformJson(raw, { designName: 'OCI Synthetic' });

    expect(result.report.providersDetected).toEqual(['oci']);
    const vm = result.design.nodes.find((n) => n.serviceId === 'oci.compute')!;
    const pg = result.design.nodes.find((n) => n.serviceId === 'oci.postgres')!;
    const bucket = result.design.nodes.find((n) => n.serviceId === 'oci.object_storage')!;

    // OCI Flex x86 E4 maps 1 OCPU -> 2 vCPUs (2 OCPUs -> 4 vCPUs)
    expect(vm.config.vcpu).toBe(4);
    expect(vm.config.memoryGb).toBe(16);
    expect(pg.config.vcpu).toBe(4);
    expect(pg.config.memoryGb).toBe(32);
    expect(bucket).toBeDefined();
    expect(result.design.edges.some((e) => e.from === vm.id && e.to === pg.id)).toBe(true);
    assertNonOverlappingSiblings(result.design);
  });

  it('enforces 5 MB max input size and 10 s timeout guard safely', async () => {
    const oversized = JSON.stringify({
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_vpc.huge',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'huge',
              provider_name: 'aws',
              values: { cidr_block: '10.0.0.0/16', padding: 'x'.repeat(5 * 1024 * 1024 + 512) },
            },
          ],
        },
      },
    });
    expect(() => parseAndSanitizeTerraformJson(oversized)).toThrow(/5 MB/i);

    let tick = 0;
    const rawAws = readFixture('aws-plan.synthetic.json');
    await expect(
      importTerraformJson(rawAws, {
        timeoutMs: 10_000,
        nowMs: () => {
          tick += 6_000;
          return tick;
        },
      }),
    ).rejects.toThrow(/time limit/i);
  });
});
