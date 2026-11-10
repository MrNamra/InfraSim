import type { Provider } from '@infrasim/shared-types';
import {
  CURATED_INSTANCE_SPECS,
  CURATED_REGION_MAP,
  KNOWN_UNAVAILABLE_SERVICES,
  PRICE_SKU_MAPPINGS,
  type InstanceSpecEntry,
  type KnownUnavailablePriceEntry,
  type PriceSkuMappingEntry,
  type RegionEquivalenceEntry,
} from './generated/costData.js';

export {
  CURATED_INSTANCE_SPECS,
  CURATED_REGION_MAP,
  KNOWN_UNAVAILABLE_SERVICES,
  PRICE_SKU_MAPPINGS,
  type InstanceSpecEntry,
  type KnownUnavailablePriceEntry,
  type PriceSkuMappingEntry,
  type RegionEquivalenceEntry,
};

/** Default number of hours per month used by cost estimates. */
export const DEFAULT_HOURS_PER_MONTH = 730;

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'oci';

function isCloudProvider(provider: Provider | undefined): provider is CloudProvider {
  return provider === 'aws' || provider === 'gcp' || provider === 'azure' || provider === 'oci';
}

/** List curated compute/database instance specifications, optionally filtered by provider and category. */
export function listInstanceSpecs(
  provider?: Provider,
  category?: 'compute' | 'database',
): InstanceSpecEntry[] {
  return CURATED_INSTANCE_SPECS.filter((entry) => {
    if (provider && entry.provider !== provider) {
      return false;
    }
    if (category && entry.category !== category) {
      return false;
    }
    return true;
  });
}

/** Look up a curated instance specification by provider and exact instance type string. */
export function getInstanceSpec(
  provider: Provider,
  instanceType: string,
): InstanceSpecEntry | undefined {
  if (!isCloudProvider(provider)) {
    return undefined;
  }
  const needle = instanceType.trim();
  if (!needle) {
    return undefined;
  }
  return CURATED_INSTANCE_SPECS.find(
    (entry) =>
      entry.provider === provider && entry.instanceType.toLowerCase() === needle.toLowerCase(),
  );
}

/** Find the curated cross-cloud region mapping entry matching a provider and region code. */
export function getRegionMapping(
  provider: Provider,
  regionCode: string,
): RegionEquivalenceEntry | undefined {
  if (!isCloudProvider(provider)) {
    return undefined;
  }
  const needle = regionCode.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return CURATED_REGION_MAP.find((entry) => entry[provider].toLowerCase() === needle);
}

/** List all curated regions for a given cloud provider. */
export function listRegionsForProvider(
  provider: Provider,
): Array<{ key: string; code: string; label: string; note?: string }> {
  if (!isCloudProvider(provider)) {
    return [];
  }
  return CURATED_REGION_MAP.map((entry) => ({
    key: entry.key,
    code: entry[provider],
    label: entry.label,
    ...(entry.note ? { note: entry.note } : {}),
  }));
}

/** Map a source provider region code to its closest curated equivalent region in a target cloud provider. */
export function findEquivalentRegion(
  fromProvider: Provider,
  fromRegion: string,
  toProvider: Provider,
): (RegionEquivalenceEntry & { targetRegion: string }) | undefined {
  if (!isCloudProvider(fromProvider) || !isCloudProvider(toProvider)) {
    return undefined;
  }
  const entry = getRegionMapping(fromProvider, fromRegion);
  if (!entry) {
    return undefined;
  }
  return {
    ...entry,
    targetRegion: entry[toProvider],
  };
}

/** Return the documented reason if a catalog service has no standalone billable SKU in public price APIs. */
export function getKnownUnavailableReason(serviceId: string): string | undefined {
  return KNOWN_UNAVAILABLE_SERVICES.find((item) => item.serviceId === serviceId)?.reason;
}
