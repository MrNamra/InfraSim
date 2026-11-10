import {
  applyProviderSwitch,
  type CloudTargetProvider,
  type ProviderSwitchNodeDiff,
} from '@infrasim/catalog';
import type { CostAssumptions, Design, Provider, SimulationResult } from '@infrasim/shared-types';
import {
  CURATED_INSTANCE_SPECS,
  CURATED_REGION_MAP,
  findEquivalentRegion,
  getInstanceSpec,
  getRegionMapping,
  listRegionsForProvider,
  type CloudProvider,
} from './costDataHelpers.js';
import { estimateMonthlyCost, summarizeCostBreakdown } from './estimator.js';
import { DEFAULT_COST_ASSUMPTIONS, type EstimateCostOptions, type PriceSnapshot } from './types.js';

const ALL_CLOUD_PROVIDERS: readonly CloudTargetProvider[] = ['aws', 'gcp', 'azure', 'oci'];

const PROVIDER_DISPLAY_LABELS: Record<CloudTargetProvider, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Microsoft Azure',
  oci: 'Oracle Cloud (OCI)',
};

function isCloudProvider(provider: Provider | undefined): provider is CloudProvider {
  return provider === 'aws' || provider === 'gcp' || provider === 'azure' || provider === 'oci';
}

function inferDesignRegion(design: Design, provider: CloudProvider, fallback?: string): string {
  const fromNode = design.nodes.find((n) => n.region && n.region.trim() !== '')?.region?.trim();
  if (fromNode) return fromNode;
  const fromGroup = design.groups.find((g) => g.region && g.region.trim() !== '')?.region?.trim();
  if (fromGroup) return fromGroup;
  if (fallback && fallback.trim() !== '') return fallback.trim();
  return listRegionsForProvider(provider)[0]?.code ?? 'us-east-1';
}

function inferBaselineProvider(design: Design): CloudTargetProvider {
  if (isCloudProvider(design.settings.primaryProvider)) {
    return design.settings.primaryProvider;
  }
  const counts: Record<CloudTargetProvider, number> = { aws: 0, gcp: 0, azure: 0, oci: 0 };
  for (const n of design.nodes) {
    const p = n.serviceId.split('.')[0] as Provider;
    if (isCloudProvider(p)) counts[p] += 1;
  }
  let best: CloudTargetProvider = 'aws';
  let bestCount = -1;
  for (const p of ALL_CLOUD_PROVIDERS) {
    if (counts[p] > bestCount) {
      best = p;
      bestCount = counts[p];
    }
  }
  return best;
}

/** Finds the closest curated instance type on a target provider matching source vCPU, memory, and role. */
export function findBestMatchingInstanceType(
  targetProvider: CloudTargetProvider,
  vcpu: number | undefined,
  memoryGb: number | undefined,
  category: 'compute' | 'database' = 'compute',
): string | undefined {
  const candidates = CURATED_INSTANCE_SPECS.filter(
    (s) => s.provider === targetProvider && s.category === category,
  );
  const pool =
    candidates.length > 0
      ? candidates
      : CURATED_INSTANCE_SPECS.filter((s) => s.provider === targetProvider);
  if (pool.length === 0) {
    return undefined;
  }

  const targetVcpu = Math.max(1, vcpu ?? 2);
  const targetMem = Math.max(1, memoryGb ?? 4);

  let best = pool[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const cand of pool) {
    const cpuDiff = Math.abs(cand.vcpu - targetVcpu) * 4;
    const memDiff = Math.abs(cand.memoryGb - targetMem);
    const underPenalty = cand.vcpu < targetVcpu || cand.memoryGb < targetMem ? 2 : 0;
    const score = cpuDiff + memDiff + underPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best.instanceType;
}

export interface ProviderCostComparisonItem {
  provider: CloudTargetProvider;
  providerLabel: string;
  targetRegion: string;
  targetRegionLabel: string;
  isCurrent: boolean;
  approximateMapping: true;
  monthlyTotal: number;
  usdMonthlyTotal: number;
  deltaPercent: number | null;
  costPerMillionRequests: number;
  transferTotal: number;
  unavailableCount: number;
  mappedCount: number;
  unmappedCount: number;
  unmappedServices: string[];
  behaviorSummary: string[];
  warnings: string[];
  nodeDiffs: ProviderSwitchNodeDiff[];
  switchedDesign: Design;
}

export interface ProviderComparisonResult {
  baselineProvider: CloudTargetProvider;
  baselineRegion: string;
  baselineMonthlyTotal: number;
  currency: string;
  approximateMapping: true;
  items: ProviderCostComparisonItem[];
}

/**
 * Compares estimated monthly cost across AWS, GCP, Azure, and OCI using catalog `equivalents`
 * without re-running simulation (reuses `simResult` counters cleanly).
 */
export function compareProvidersCost(
  design: Design,
  simResult: SimulationResult | null,
  snapshot: PriceSnapshot | null,
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
  targetProviders: readonly CloudTargetProvider[] = ALL_CLOUD_PROVIDERS,
  options: EstimateCostOptions = {},
): ProviderComparisonResult {
  const baselineProvider = inferBaselineProvider(design);
  const baselineRegion = inferDesignRegion(design, baselineProvider, options.defaultRegion);
  const baseReport = estimateMonthlyCost(design, simResult, snapshot, assumptions, {
    ...options,
    defaultRegion: baselineRegion,
  });

  const providers = targetProviders.length > 0 ? targetProviders : ALL_CLOUD_PROVIDERS;
  const items: ProviderCostComparisonItem[] = [];

  for (const targetProvider of providers) {
    const regionEquiv = findEquivalentRegion(baselineProvider, baselineRegion, targetProvider);
    const targetRegion =
      regionEquiv?.targetRegion ??
      listRegionsForProvider(targetProvider)[0]?.code ??
      baselineRegion;
    const targetRegionLabel = regionEquiv?.label ?? targetRegion;

    const switched =
      targetProvider === baselineProvider
        ? {
            design: structuredClone(design),
            plan: {
              sourceProvider: baselineProvider,
              targetProvider,
              approximateMapping: true as const,
              mappedCount: 0,
              unmappedCount: 0,
              keptCount: design.nodes.length,
              nodeDiffs: [],
              groupChanges: [],
              behaviorSummary: [],
            },
          }
        : applyProviderSwitch(design, targetProvider, {
            customServices: options.customServices,
            defaultSourceRegion: baselineRegion,
            defaultTargetRegion: targetRegion,
            resolveRegion: (fromProv, fromReg, toProv) => {
              const effFrom = isCloudProvider(fromProv) ? fromProv : baselineProvider;
              return findEquivalentRegion(effFrom, fromReg, toProv);
            },
            resolveInstanceType: (tgtProv, srcCfg, srcSvc, tgtSvc) => {
              const srcProvider =
                srcSvc && isCloudProvider(srcSvc.provider) ? srcSvc.provider : baselineProvider;
              const srcSpec = srcCfg.instanceType
                ? getInstanceSpec(srcProvider, srcCfg.instanceType)
                : undefined;
              const vcpu = srcCfg.vcpu ?? srcSpec?.vcpu;
              const memGb = srcCfg.memoryGb ?? srcSpec?.memoryGb;
              const roleCategory =
                tgtSvc.kind === 'sql' || tgtSvc.kind === 'cache' ? 'database' : 'compute';
              if (tgtSvc.kind !== 'compute' && tgtSvc.kind !== 'sql' && tgtSvc.kind !== 'cache') {
                return undefined;
              }
              return findBestMatchingInstanceType(tgtProv, vcpu, memGb, roleCategory);
            },
          });

    const report = estimateMonthlyCost(switched.design, simResult, snapshot, assumptions, {
      ...options,
      defaultRegion: targetRegion,
    });
    const meta = summarizeCostBreakdown(switched.design, report, simResult, {
      customServices: options.customServices,
    });

    const deltaPercent =
      baseReport.monthlyTotal > 0
        ? ((report.monthlyTotal - baseReport.monthlyTotal) / baseReport.monthlyTotal) * 100
        : null;

    const unmappedServices = switched.plan.nodeDiffs
      .filter((d) => d.status === 'unmapped')
      .map((d) => `${d.nodeLabel} (${d.sourceServiceName})`);

    items.push({
      provider: targetProvider,
      providerLabel: PROVIDER_DISPLAY_LABELS[targetProvider],
      targetRegion,
      targetRegionLabel,
      isCurrent: targetProvider === baselineProvider,
      approximateMapping: true,
      monthlyTotal: report.monthlyTotal,
      usdMonthlyTotal: meta.usdMonthlyTotal,
      deltaPercent,
      costPerMillionRequests: report.costPerMillionRequests,
      transferTotal: meta.transferTotal,
      unavailableCount: meta.unavailableCount,
      mappedCount: switched.plan.mappedCount,
      unmappedCount: switched.plan.unmappedCount,
      unmappedServices,
      behaviorSummary: switched.plan.behaviorSummary,
      warnings: report.warnings,
      nodeDiffs: switched.plan.nodeDiffs,
      switchedDesign: switched.design,
    });
  }

  return {
    baselineProvider,
    baselineRegion,
    baselineMonthlyTotal: baseReport.monthlyTotal,
    currency: baseReport.currency,
    approximateMapping: true,
    items,
  };
}

export interface RegionCostComparisonItem {
  regionKey: string;
  regionCode: string;
  regionLabel: string;
  provider: CloudProvider;
  isCurrent: boolean;
  monthlyTotal: number;
  usdMonthlyTotal: number;
  deltaPercent: number | null;
  unavailableCount: number;
  missingServices: string[];
  latencyNote: string;
  regionNote?: string;
  warnings: string[];
}

export interface RegionComparisonResult {
  provider: CloudProvider;
  currentRegion: string;
  baselineMonthlyTotal: number;
  currency: string;
  items: RegionCostComparisonItem[];
}

function buildRegionLatencyNote(
  currentRegionCode: string,
  candidateRegionCode: string,
  provider: CloudProvider,
  currentKey?: string,
  candidateKey?: string,
): string {
  if (candidateRegionCode.toLowerCase() === currentRegionCode.toLowerCase()) {
    return 'Current region (same-AZ ~0.4 ms, cross-AZ ~1.2 ms)';
  }
  const sameContinentPrefix = (key?: string): string => {
    if (!key) return 'other';
    if (key.startsWith('us-')) return 'americas-north';
    if (key.startsWith('eu-') || key.startsWith('uk-')) return 'europe';
    if (key.startsWith('in-') || key === 'sg' || key.startsWith('jp-') || key.startsWith('au-')) {
      return 'apac';
    }
    return key;
  };
  if (
    currentKey &&
    candidateKey &&
    sameContinentPrefix(currentKey) === sameContinentPrefix(candidateKey)
  ) {
    return `Cross-region vs ${currentRegionCode} (same continent ~30 ms p50; ${provider.toUpperCase()} SKU prices vary)`;
  }
  return `Intercontinental vs ${currentRegionCode} (~120 ms p50 RTT if clients remain remote)`;
}

/**
 * Compares estimated monthly cost of the current Design across curated cloud regions
 * without modifying service IDs or re-running simulation.
 */
export function compareRegionsCost(
  design: Design,
  simResult: SimulationResult | null,
  snapshot: PriceSnapshot | null,
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
  regionCodesOrKeys?: readonly string[],
  options: EstimateCostOptions = {},
): RegionComparisonResult {
  const provider = inferBaselineProvider(design);
  const currentRegion = inferDesignRegion(design, provider, options.defaultRegion);
  const currentMapping = getRegionMapping(provider, currentRegion);

  const baselineReport = estimateMonthlyCost(design, simResult, snapshot, assumptions, {
    ...options,
    defaultRegion: currentRegion,
  });

  const candidateEntries =
    regionCodesOrKeys && regionCodesOrKeys.length > 0
      ? CURATED_REGION_MAP.filter((entry) => {
          const targetCode = entry[provider].toLowerCase();
          return regionCodesOrKeys.some(
            (r) =>
              r.trim().toLowerCase() === entry.key.toLowerCase() ||
              r.trim().toLowerCase() === targetCode,
          );
        })
      : [...CURATED_REGION_MAP];

  const items: RegionCostComparisonItem[] = [];

  for (const entry of candidateEntries) {
    const regionCode = entry[provider];
    const cloned = structuredClone(design);
    for (const g of cloned.groups) {
      if (g.kind === 'region' || g.region) {
        g.region = regionCode;
      }
    }
    for (const n of cloned.nodes) {
      n.region = regionCode;
    }

    const report = estimateMonthlyCost(cloned, simResult, snapshot, assumptions, {
      ...options,
      defaultRegion: regionCode,
    });
    const meta = summarizeCostBreakdown(cloned, report, simResult, {
      customServices: options.customServices,
    });

    const missingServices: string[] = [];
    for (const node of cloned.nodes) {
      const nodeLines = report.perNode[node.id]?.lines ?? [];
      if (nodeLines.some((line) => line.source === 'unavailable')) {
        missingServices.push(node.label);
      }
    }

    const deltaPercent =
      baselineReport.monthlyTotal > 0
        ? ((report.monthlyTotal - baselineReport.monthlyTotal) / baselineReport.monthlyTotal) * 100
        : null;

    items.push({
      regionKey: entry.key,
      regionCode,
      regionLabel: entry.label,
      provider,
      isCurrent: regionCode.toLowerCase() === currentRegion.toLowerCase(),
      monthlyTotal: report.monthlyTotal,
      usdMonthlyTotal: meta.usdMonthlyTotal,
      deltaPercent,
      unavailableCount: meta.unavailableCount,
      missingServices,
      latencyNote: buildRegionLatencyNote(
        currentRegion,
        regionCode,
        provider,
        currentMapping?.key,
        entry.key,
      ),
      ...(entry.note ? { regionNote: entry.note } : {}),
      warnings: report.warnings,
    });
  }

  return {
    provider,
    currentRegion,
    baselineMonthlyTotal: baselineReport.monthlyTotal,
    currency: baselineReport.currency,
    items,
  };
}
