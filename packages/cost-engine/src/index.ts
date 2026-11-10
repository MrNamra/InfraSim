export {
  CURATED_INSTANCE_SPECS,
  CURATED_REGION_MAP,
  DEFAULT_HOURS_PER_MONTH,
  KNOWN_UNAVAILABLE_SERVICES,
  PRICE_SKU_MAPPINGS,
  findEquivalentRegion,
  getInstanceSpec,
  getKnownUnavailableReason,
  getRegionMapping,
  listInstanceSpecs,
  listRegionsForProvider,
  type CloudProvider,
  type InstanceSpecEntry,
  type KnownUnavailablePriceEntry,
  type PriceSkuMappingEntry,
  type RegionEquivalenceEntry,
} from './costDataHelpers.js';

export {
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type CostBreakdownMeta,
  type CostDriver,
  type CostLine,
  type EstimateCostOptions,
  type NormalizedPriceRow,
  type PriceSnapshot,
  type ProviderSnapshotMeta,
  type SkuMappingRef,
  type WhatIfCostParams,
  type WhatIfCostResult,
} from './types.js';

export {
  estimateMonthlyCost,
  estimateWhatIfCost,
  getTopCostDrivers,
  summarizeCostBreakdown,
} from './estimator.js';

export { exportCostCsv, exportCostMarkdown } from './export.js';
