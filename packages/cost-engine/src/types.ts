import type {
  CostAssumptions,
  CostLine,
  CustomServiceDefinition,
  KnownUnavailablePriceEntry,
  PriceSkuMappingEntry,
  Provider,
} from './typesInternal.js';

export type { CostAssumptions, CostLine };

/** Normalized price row returned by backend price snapshot APIs or test fixtures. */
export interface NormalizedPriceRow {
  provider: Provider;
  serviceId: string;
  skuKey: string;
  region: string;
  unit: string;
  unitRole?: string;
  unitPrice: number;
  currency: string;
  tierMin?: number | null;
  tierMax?: number | null;
  attrs?: Record<string, unknown>;
}

/** Provider-level metadata attached to a published price snapshot. */
export interface ProviderSnapshotMeta {
  snapshotId?: string;
  fetchedAt: string;
  sourceUrl?: string;
  rawHash?: string;
  stale?: boolean;
}

/** Snapshot payload consumed by the pure TypeScript cost engine. */
export interface PriceSnapshot {
  version?: number;
  generatedAt?: string;
  staleAfterDays?: number;
  providers?: Partial<Record<Provider, ProviderSnapshotMeta>>;
  prices: NormalizedPriceRow[];
  knownUnavailable?: KnownUnavailablePriceEntry[];
}

/** Optional deterministic overrides and catalog extensions for cost estimation. */
export interface EstimateCostOptions {
  /** Reference ISO timestamp for snapshot staleness checks (defaults to snapshot.generatedAt). */
  nowIso?: string;
  /** Number of days after which a snapshot emits a staleness warning (default 7). */
  staleAfterDays?: number;
  /** Fallback cloud region if a node and its ancestor groups lack a region attribute. */
  defaultRegion?: string;
  /** Additional custom service definitions not embedded on design.customServices. */
  customServices?: CustomServiceDefinition[];
}

/** Default cost calculation assumptions matching specification §6. */
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  hoursPerMonth: 730,
  traffic: { mode: 'run-average' },
  instanceCountMode: 'average',
  includeFreeTier: false,
  currency: 'USD',
};

/** Top single billable driver entry ranked by monthly cost impact. */
export interface CostDriver {
  scope: 'node' | 'transfer';
  nodeId?: string;
  label: string;
  dimension: string;
  amount: number;
  percentOfTotal: number;
  unit: string;
  quantity: number;
  source: CostLine['source'];
}

/** Supplemental provider, FX, and availability metrics derived from a CostReport. */
export interface CostBreakdownMeta {
  byProvider: Record<string, number>;
  transferTotal: number;
  usdMonthlyTotal: number;
  monthlyRequests: number;
  unavailableCount: number;
}

/** Quick client-side what-if inputs evaluated against an existing simulation report. */
export interface WhatIfCostParams {
  rpsMultiplier?: number;
  targetAvgRps?: number;
  instanceOverrides?: Record<string, number>;
}

/** Instant linear re-estimate result tagged as an approximation until re-run. */
export interface WhatIfCostResult {
  monthlyTotal: number;
  usdMonthlyTotal: number;
  currency: string;
  byNode: Record<string, number>;
  transferTotal: number;
  rpsFactor: number;
  estimateOnly: true;
  note: string;
}

export type SkuMappingRef = PriceSkuMappingEntry;
