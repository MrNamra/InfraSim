import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCatalog,
  CANONICAL_PROVIDER_COUNTS,
  parseCapacitySpec,
  parseProviderMarkdown,
} from './build-catalog.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('catalog markdown parser & validator', () => {
  it('parses all 243 services from docs/specs/07-10 plus 8 generic blocks and validates schemas', () => {
    const warnings: string[] = [];
    const result = buildCatalog({
      rootDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(result.counts.aws).toBe(CANONICAL_PROVIDER_COUNTS.aws);
    expect(result.counts.gcp).toBe(CANONICAL_PROVIDER_COUNTS.gcp);
    expect(result.counts.azure).toBe(CANONICAL_PROVIDER_COUNTS.azure);
    expect(result.counts.oci).toBe(CANONICAL_PROVIDER_COUNTS.oci);
    expect(result.counts.providerTotal).toBe(243);
    expect(result.counts.generic).toBe(8);
    expect(result.counts.total).toBe(251);
    expect(warnings).toEqual([]);

    const lambda = result.byProvider.aws.find((s) => s.id === 'aws.lambda');
    expect(lambda?.coldStart).toEqual({ p50: 250, p95: 900, idleTtlS: 600 });
    expect(lambda?.scaleOutLagS).toBe(0);
    expect(lambda?.maxTimeoutS).toBe(900);
    expect(lambda?.capacity).toEqual({ type: 'conc', limit: 1000, onLimit: 'throttle' });

    const cloudRun = result.byProvider.gcp.find((s) => s.id === 'gcp.cloud_run');
    expect(cloudRun?.capacity).toEqual({ type: 'conc', limit: 8000, onLimit: 'queue' });
    expect(cloudRun?.maxTimeoutS).toBe(3600);

    const s3 = result.byProvider.aws.find((s) => s.id === 'aws.s3');
    expect(s3?.limits?.length).toBeGreaterThanOrEqual(2);
    expect(s3?.operations.map((o) => o.name)).toContain('GetObject');
  });

  it('parses every Cap grammar token cleanly', () => {
    expect(parseCapacitySpec('elastic', 'x.a')).toEqual({ type: 'elastic' });
    expect(parseCapacitySpec('slots', 'x.a')).toEqual({ type: 'slots', fromInstanceType: true });
    expect(parseCapacitySpec('conc=1000', 'x.a')).toEqual({
      type: 'conc',
      limit: 1000,
      onLimit: 'throttle',
    });
    expect(parseCapacitySpec('conc=8000/queue', 'x.a')).toEqual({
      type: 'conc',
      limit: 8000,
      onLimit: 'queue',
    });
    expect(parseCapacitySpec('rps=10000', 'x.a')).toEqual({ type: 'rps', limit: 10000 });
    expect(parseCapacitySpec('units', 'x.a')).toEqual({ type: 'units', read: 1000, write: 1000 });
    expect(parseCapacitySpec('conn', 'x.a')).toEqual({ type: 'conn', default: 100 });
    expect(parseCapacitySpec('tpm', 'x.a')).toEqual({ type: 'tpm', rpm: 1000, tpm: 250000 });
    expect(parseCapacitySpec('pass', 'x.a')).toEqual({ type: 'passthrough' });
    expect(() => parseCapacitySpec('bogus=42', 'x.a')).toThrow(/Unknown Cap grammar/);
  });

  it('identifies tables strictly by header row and ignores unrelated tables', () => {
    const md = [
      '### Compute',
      '| ID | Name | p50 | p95 | Cap | Mock | Price |',
      '|---|---|---|---|---|---|---|',
      '| aws.ec2 | EC2 | 20 | 80 | slots | compute | hr |',
      '',
      '## Quotas table unrelated',
      '| ID | Quota | Value | Notes |',
      '|---|---|---|---|',
      '| aws.fake | Not a service | 999 | Ignore me |',
      '',
      '## Serverless & scaling extras',
      '| ID | Cold p50 | Cold p95 | Default concurrency | Max timeout | Scale-out lag (s) | Notes |',
      '|---|---|---|---|---|---|---|',
      '| aws.ec2 | — | — | per instance | — | 90 | Launch lag |',
    ].join('\n');

    const parsed = parseProviderMarkdown(md, 'aws');
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0]?.id).toBe('aws.ec2');
    expect(parsed.extras.get('aws.ec2')?.scaleOutLagS).toBe(90);
  });

  it('rejects p95 < p50, unknown Mock kinds, unknown Price codes, and duplicate IDs', () => {
    expect(() =>
      parseProviderMarkdown(
        [
          '### Compute',
          '| ID | Name | p50 | p95 | Cap | Mock | Price |',
          '|---|---|---|---|---|---|---|',
          '| aws.ec2 | EC2 | 100 | 50 | slots | compute | hr |',
        ].join('\n'),
        'aws',
      ),
    ).toThrow(/p95 \(50\) < p50 \(100\)/);

    expect(() =>
      parseProviderMarkdown(
        [
          '### Compute',
          '| ID | Name | p50 | p95 | Cap | Mock | Price |',
          '|---|---|---|---|---|---|---|',
          '| aws.ec2 | EC2 | 20 | 80 | slots | unknown_kind | hr |',
        ].join('\n'),
        'aws',
      ),
    ).toThrow(/unknown Mock kind/);

    expect(() =>
      parseProviderMarkdown(
        [
          '### Compute',
          '| ID | Name | p50 | p95 | Cap | Mock | Price |',
          '|---|---|---|---|---|---|---|',
          '| aws.ec2 | EC2 | 20 | 80 | slots | compute | unknown_price |',
        ].join('\n'),
        'aws',
      ),
    ).toThrow(/unknown Price model/);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infrasim-cat-dup-'));
    tempDirs.push(tmpDir);
    const dupSpec = path.join(tmpDir, 'aws.md');
    const okSpec = (id: string) =>
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        `| ${id} | Test | 20 | 80 | slots | compute | hr |`,
      ].join('\n');
    fs.writeFileSync(
      dupSpec,
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        '| aws.ec2 | EC2 | 20 | 80 | slots | compute | hr |',
        '| aws.ec2 | EC2 Dup | 20 | 80 | slots | compute | hr |',
      ].join('\n'),
      'utf8',
    );
    const gcpSpec = path.join(tmpDir, 'gcp.md');
    const azureSpec = path.join(tmpDir, 'azure.md');
    const ociSpec = path.join(tmpDir, 'oci.md');
    fs.writeFileSync(gcpSpec, okSpec('gcp.compute_engine'), 'utf8');
    fs.writeFileSync(azureSpec, okSpec('azure.vm'), 'utf8');
    fs.writeFileSync(ociSpec, okSpec('oci.compute'), 'utf8');

    expect(() =>
      buildCatalog({
        rootDir,
        specFiles: { aws: dupSpec, gcp: gcpSpec, azure: azureSpec, oci: ociSpec },
        expectedCounts: {},
      }),
    ).toThrow(/Duplicate catalog service ID "aws.ec2"/);
  });

  it('rejects services missing from equivalents.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infrasim-cat-eq-'));
    tempDirs.push(tmpDir);
    const awsSpec = path.join(tmpDir, 'aws.md');
    const gcpSpec = path.join(tmpDir, 'gcp.md');
    const azureSpec = path.join(tmpDir, 'azure.md');
    const ociSpec = path.join(tmpDir, 'oci.md');

    fs.writeFileSync(
      awsSpec,
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        '| aws.unmapped_service | Unmapped | 20 | 80 | slots | compute | hr |',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      gcpSpec,
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        '| gcp.compute_engine | VM | 20 | 80 | slots | compute | hr |',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      azureSpec,
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        '| azure.vm | VM | 20 | 80 | slots | compute | hr |',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      ociSpec,
      [
        '### Compute',
        '| ID | Name | p50 | p95 | Cap | Mock | Price |',
        '|---|---|---|---|---|---|---|',
        '| oci.compute | VM | 20 | 80 | slots | compute | hr |',
      ].join('\n'),
      'utf8',
    );

    expect(() =>
      buildCatalog({
        rootDir,
        specFiles: { aws: awsSpec, gcp: gcpSpec, azure: azureSpec, oci: ociSpec },
        expectedCounts: {},
      }),
    ).toThrow(/Missing equivalents mapping for "aws.unmapped_service"/);
  });
});
