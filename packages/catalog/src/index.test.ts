import { describe, expect, it } from 'vitest';
import {
  CATALOG_COUNTS,
  findEquivalent,
  getCatalog,
  getCatalogCategories,
  getKindDefault,
  getProviderCatalog,
  getService,
  searchServices,
} from './index.js';

describe('@infrasim/catalog loader', () => {
  it('loads all 243 cloud provider services plus 8 generic blocks', () => {
    expect(CATALOG_COUNTS.aws).toBe(77);
    expect(CATALOG_COUNTS.gcp).toBe(53);
    expect(CATALOG_COUNTS.azure).toBe(63);
    expect(CATALOG_COUNTS.oci).toBe(50);
    expect(CATALOG_COUNTS.providerTotal).toBe(243);
    expect(CATALOG_COUNTS.generic).toBe(8);
    expect(getCatalog()).toHaveLength(251);

    expect(getProviderCatalog('aws')).toHaveLength(77);
    expect(getProviderCatalog('gcp')).toHaveLength(53);
    expect(getProviderCatalog('azure')).toHaveLength(63);
    expect(getProviderCatalog('oci')).toHaveLength(50);
    expect(getProviderCatalog('generic')).toHaveLength(8);
  });

  it('every service has at least one operation and valid latency bounds', () => {
    for (const service of getCatalog()) {
      expect(service.operations.length).toBeGreaterThanOrEqual(1);
      expect(service.latency.p95).toBeGreaterThanOrEqual(service.latency.p50);
      expect(service.icon.length).toBeGreaterThan(0);
    }
  });

  it('supports search by name, tag, alias, and provider filter', () => {
    const queueMatches = searchServices('queue');
    expect(queueMatches.some((s) => s.id === 'aws.sqs')).toBe(true);
    expect(queueMatches.some((s) => s.id === 'gcp.cloud_tasks')).toBe(true);
    expect(queueMatches.some((s) => s.id === 'generic.queue')).toBe(true);

    const awsDbMatches = searchServices('postgres', { provider: 'aws' });
    expect(awsDbMatches.every((s) => s.provider === 'aws')).toBe(true);
    expect(awsDbMatches.some((s) => s.id === 'aws.rds_postgres')).toBe(true);

    const llmAliasMatches = searchServices('llm', { provider: 'azure' });
    expect(llmAliasMatches.some((s) => s.id === 'azure.openai')).toBe(true);
  });

  it('resolves cross-cloud equivalents accurately', () => {
    expect(findEquivalent('aws.s3', 'gcp')?.id).toBe('gcp.cloud_storage');
    expect(findEquivalent('aws.s3', 'azure')?.id).toBe('azure.blob');
    expect(findEquivalent('aws.s3', 'oci')?.id).toBe('oci.object_storage');
    expect(findEquivalent('aws.rds_postgres', 'oci')?.id).toBe('oci.postgres');
    expect(findEquivalent('aws.cloudfront', 'oci')).toBeUndefined();
    expect(findEquivalent('aws.dax', 'gcp')).toBeUndefined();
  });

  it('returns categories and kind defaults', () => {
    const awsCats = getCatalogCategories('aws');
    expect(awsCats).toContain('Compute');
    expect(awsCats).toContain('AI & ML');
    expect(getKindDefault('sql').operations.map((o) => o.name)).toContain('Query');
    expect(getService('aws.igw')?.latency).toEqual({
      distribution: 'fixed',
      p50: 0,
      p95: 0,
    });
  });
});
