import { describe, expect, it } from 'vitest';
import { getProviderCatalog } from '@infrasim/catalog';
import {
  CURATED_INSTANCE_SPECS,
  CURATED_REGION_MAP,
  KNOWN_UNAVAILABLE_SERVICES,
  PRICE_SKU_MAPPINGS,
  findEquivalentRegion,
  getInstanceSpec,
  getKnownUnavailableReason,
  getRegionMapping,
  listInstanceSpecs,
  listRegionsForProvider,
  type CloudProvider,
} from './index.js';

describe('@infrasim/cost-engine curated pricing & spec metadata', () => {
  it('covers 100% of non-free catalog services across all four clouds via mappings or knownUnavailable reasons', () => {
    const providers: CloudProvider[] = ['aws', 'gcp', 'azure', 'oci'];

    for (const provider of providers) {
      const services = getProviderCatalog(provider);
      const nonFree = services.filter((s) => s.pricing.model !== 'free');

      const mappedIds = new Set(
        PRICE_SKU_MAPPINGS.filter((m) => m.provider === provider).map((m) => m.serviceId),
      );
      const unavail = KNOWN_UNAVAILABLE_SERVICES.filter((u) => u.provider === provider);
      const unavailIds = new Set(unavail.map((u) => u.serviceId));

      for (const entry of unavail) {
        expect(entry.reason.trim().length).toBeGreaterThan(10);
      }

      const missing = nonFree
        .filter((svc) => !mappedIds.has(svc.id) && !unavailIds.has(svc.id))
        .map((svc) => svc.id);

      expect(missing, `Missing price coverage for ${provider}`).toEqual([]);
    }

    expect(getKnownUnavailableReason('aws.batch')).toContain('AWS Batch');
  });

  it('provides 10 equivalent regions across AWS, GCP, Azure, and OCI with verified codes', () => {
    expect(CURATED_REGION_MAP).toHaveLength(10);

    for (const provider of ['aws', 'gcp', 'azure', 'oci'] as const) {
      const regions = listRegionsForProvider(provider);
      expect(regions).toHaveLength(10);
      expect(new Set(regions.map((r) => r.code)).size).toBe(10);
    }

    const mumbaiFromAws = getRegionMapping('aws', 'ap-south-1');
    expect(mumbaiFromAws?.gcp).toBe('asia-south1');
    expect(mumbaiFromAws?.azure).toBe('centralindia');
    expect(mumbaiFromAws?.oci).toBe('ap-mumbai-1');

    const equivToOci = findEquivalentRegion('aws', 'us-east-1', 'oci');
    expect(equivToOci?.targetRegion).toBe('us-ashburn-1');
  });

  it('includes sourced instance specs with valid vCPU, memory, arch, and verification URLs', () => {
    expect(CURATED_INSTANCE_SPECS.length).toBeGreaterThanOrEqual(30);

    for (const spec of CURATED_INSTANCE_SPECS) {
      expect(spec.vcpu).toBeGreaterThan(0);
      expect(spec.memoryGb).toBeGreaterThan(0);
      expect(spec.sourceUrl.startsWith('https://')).toBe(true);
      expect(spec.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const awsMicro = getInstanceSpec('aws', 't3.micro');
    expect(awsMicro?.vcpu).toBe(2);
    expect(awsMicro?.memoryGb).toBe(1);

    const azureVm = getInstanceSpec('azure', 'Standard_D2s_v5');
    expect(azureVm?.vcpu).toBe(2);
    expect(azureVm?.memoryGb).toBe(8);

    const ociArm = getInstanceSpec('oci', 'VM.Standard.A1.Flex');
    expect(ociArm?.arch).toBe('arm64');
    expect(listInstanceSpecs('gcp', 'database').length).toBeGreaterThanOrEqual(2);
    expect(getInstanceSpec('aws', 'c99.imaginary')).toBeUndefined();
  });
});
