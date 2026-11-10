import { getService } from '@infrasim/catalog';
import type {
  CostAssumptions,
  CostLine,
  CostReport,
  CustomServiceDefinition,
  Design,
  EdgeInstance,
  GroupInstance,
  MockKind,
  NodeInstance,
  Provider,
  ServiceDefinition,
  SimulationResult,
} from '@infrasim/shared-types';
import {
  DEFAULT_HOURS_PER_MONTH,
  PRICE_SKU_MAPPINGS,
  getInstanceSpec,
  getKnownUnavailableReason,
  type InstanceSpecEntry,
  type PriceSkuMappingEntry,
} from './costDataHelpers.js';
import {
  DEFAULT_COST_ASSUMPTIONS,
  type CostBreakdownMeta,
  type CostDriver,
  type EstimateCostOptions,
  type NormalizedPriceRow,
  type PriceSnapshot,
  type WhatIfCostParams,
  type WhatIfCostResult,
} from './types.js';

const BYTES_PER_GB = 1024 ** 3;
const BYTES_PER_TB = 1024 ** 4;
const MS_PER_DAY = 86_400_000;

const PROVIDER_DEFAULT_REGIONS: Record<'aws' | 'gcp' | 'azure' | 'oci', string> = {
  aws: 'us-east-1',
  gcp: 'us-east4',
  azure: 'eastus',
  oci: 'global',
};

const COST_CATEGORIES = ['compute', 'database', 'network', 'storage', 'ai', 'other'] as const;
type CostCategory = (typeof COST_CATEGORIES)[number];

const KIND_TO_COST_CATEGORY: Record<MockKind, CostCategory> = {
  compute: 'compute',
  fn: 'compute',
  sql: 'database',
  kv: 'database',
  doc: 'database',
  graph: 'database',
  ts: 'database',
  olap: 'database',
  search: 'database',
  cache: 'database',
  object: 'storage',
  block: 'storage',
  file: 'storage',
  lb: 'network',
  gw: 'network',
  cdn: 'network',
  dns: 'network',
  net: 'network',
  llm: 'ai',
  ml: 'ai',
  vision: 'ai',
  speech: 'ai',
  'text-ai': 'ai',
  'doc-ai': 'ai',
  bot: 'ai',
  queue: 'other',
  topic: 'other',
  stream: 'other',
  bus: 'other',
  workflow: 'other',
  auth: 'other',
  secret: 'other',
  kms: 'other',
  email: 'other',
  async: 'other',
};

const BURSTABLE_PREFIXES = [
  't2.',
  't3.',
  't4g.',
  'standard_b',
  'e2-micro',
  'e2-small',
  'e2-medium',
];

function isCloudProvider(
  provider: Provider | undefined,
): provider is 'aws' | 'gcp' | 'azure' | 'oci' {
  return provider === 'aws' || provider === 'gcp' || provider === 'azure' || provider === 'oci';
}

function resolveNodeRegion(
  node: NodeInstance,
  groupsById: ReadonlyMap<string, GroupInstance>,
): string | undefined {
  if (node.region && node.region.trim() !== '') {
    return node.region.trim();
  }
  const visited = new Set<string>();
  let curId = node.parentGroupId;
  while (curId && !visited.has(curId)) {
    visited.add(curId);
    const group = groupsById.get(curId);
    if (!group) break;
    if (group.region && group.region.trim() !== '') {
      return group.region.trim();
    }
    curId = group.parentGroupId;
  }
  return undefined;
}

function unitScaleDivisor(unit: string): number {
  const lower = unit.trim().toLowerCase();
  if (lower.startsWith('1m ')) return 1_000_000;
  if (lower.startsWith('100k ')) return 100_000;
  if (lower.startsWith('10k ')) return 10_000;
  if (lower.startsWith('1k ')) return 1_000;
  if (lower.startsWith('100 ')) return 100;
  return 1;
}

function defaultUnitForPriceModel(model: string | undefined): string {
  switch (model) {
    case 'hr':
    case 'vcpu-gb-hr':
      return 'Hours';
    case 'req':
    case 'fn':
      return '1M Requests';
    case 'gb-mo':
      return 'GB-Mo';
    case 'gb-xfer':
      return 'GB';
    case 'tok':
      return '1M Tokens';
    case 'msg':
      return '1M Messages';
    case 'query-tb':
      return 'TB Scanned';
    case 'acu-hr':
      return 'ACU-Hours';
    case 'lcu':
      return 'LCU-Hours';
    case 'shard-hr':
      return 'Shard-Hours';
    case 'ru':
      return '100 RU/s-Hours';
    case 'rcu-wcu':
      return '1M Read Units';
    case 'mau':
      return 'MAU';
    case 'flat':
      return 'Month';
    default:
      return 'Units';
  }
}

function formatRoleDimension(role: string): string {
  switch (role) {
    case 'instance_hour':
      return 'compute hours';
    case 'vcpu_hour':
      return 'vCPU hours';
    case 'memory_gb_hour':
      return 'memory GB-hours';
    case 'flat_month':
      return 'monthly base';
    case 'requests':
      return 'requests';
    case 'gb_second':
      return 'compute GB-seconds';
    case 'data_transfer_gb':
      return 'data processed';
    case 'lcu_hour':
      return 'capacity units';
    case 'storage_gb_month':
      return 'storage';
    case 'acu_hour':
      return 'ACU hours';
    case 'rcu_hour':
      return 'read units';
    case 'wcu_hour':
      return 'write units';
    case 'tb_scanned':
      return 'data scanned';
    case 'messages':
      return 'messages';
    case 'shard_hour':
      return 'shard hours';
    case 'mau':
      return 'monthly active users';
    case 'tokens_1m_in':
      return 'input tokens';
    case 'tokens_1m_out':
      return 'output tokens';
    case 'ru_hour':
      return 'throughput RU/s-hours';
    default:
      return role.replace(/_/g, ' ');
  }
}

function buildFallbackMappings(service: ServiceDefinition): PriceSkuMappingEntry[] {
  const provider = isCloudProvider(service.provider) ? service.provider : 'aws';
  const model = service.pricing.model;
  const make = (unitRole: string, unit: string): PriceSkuMappingEntry => ({
    serviceId: service.id,
    provider,
    unitRole,
    unit,
    filter: {},
  });

  switch (model) {
    case 'free':
      return [];
    case 'hr':
      return [make('instance_hour', 'Hours')];
    case 'vcpu-gb-hr':
      return [
        make('vcpu_hour', provider === 'oci' ? 'OCPU-Hours' : 'vCPU-Hours'),
        make('memory_gb_hour', 'GB-Hours'),
      ];
    case 'req':
      return [make('requests', '1M Requests')];
    case 'fn':
      return [make('requests', '1M Requests'), make('gb_second', 'GB-Seconds')];
    case 'gb-mo':
      return [make('storage_gb_month', 'GB-Mo')];
    case 'gb-xfer':
      return [make('data_transfer_gb', 'GB')];
    case 'tok':
      return [make('tokens_1m_in', '1M Tokens'), make('tokens_1m_out', '1M Tokens')];
    case 'ru':
      return [make('ru_hour', '100 RU/s-Hours')];
    case 'rcu-wcu':
      return [make('rcu_hour', '1M Read Units'), make('wcu_hour', '1M Write Units')];
    case 'shard-hr':
      return [make('shard_hour', 'Shard-Hours')];
    case 'lcu':
      return [make('lcu_hour', 'LCU-Hours')];
    case 'msg':
      return [make('messages', '1M Messages')];
    case 'query-tb':
      return [make('tb_scanned', 'TB Scanned')];
    case 'acu-hr':
      return [make('acu_hour', 'ACU-Hours')];
    case 'mau':
      return [make('mau', 'MAU')];
    case 'flat':
      return [make('flat_month', 'Month')];
    case 'mix':
    case 'unit':
    default:
      return [make('unit', 'Units')];
  }
}

function getRowUnitRole(row: NormalizedPriceRow): string {
  if (row.unitRole && row.unitRole.trim() !== '') {
    return row.unitRole;
  }
  const attrRole = row.attrs?.unitRole;
  return typeof attrRole === 'string' ? attrRole : '';
}

interface ResolvedTierResult {
  amountUsd: number;
  blendedUnitPriceUsd: number;
  unit: string;
  skuKey: string;
  note?: string;
}

function computeProgressiveTiers(
  rawBands: NormalizedPriceRow[],
  quantity: number,
  includeFreeTier: boolean,
): ResolvedTierResult {
  const sorted = [...rawBands].sort((a, b) => (a.tierMin ?? 0) - (b.tierMin ?? 0));

  let bands = sorted.map((b) => ({
    tierMin: b.tierMin ?? 0,
    tierMax: b.tierMax ?? null,
    unitPrice: b.unitPrice,
    unit: b.unit,
    skuKey: b.skuKey,
  }));

  // Strip leading $0 free-tier bands unless user toggled includeFreeTier ON.
  if (!includeFreeTier && bands.length > 1) {
    let shift = 0;
    let firstPaidIdx = 0;
    while (
      firstPaidIdx < bands.length - 1 &&
      bands[firstPaidIdx]!.unitPrice === 0 &&
      bands[firstPaidIdx]!.tierMax !== null &&
      bands[firstPaidIdx]!.tierMax! > 0
    ) {
      shift = bands[firstPaidIdx]!.tierMax!;
      firstPaidIdx += 1;
    }
    if (firstPaidIdx > 0 && bands[firstPaidIdx]!.unitPrice > 0) {
      bands = bands.slice(firstPaidIdx).map((b, idx) => ({
        ...b,
        tierMin: idx === 0 ? 0 : Math.max(0, b.tierMin - shift),
        tierMax: b.tierMax !== null ? Math.max(0, b.tierMax - shift) : null,
      }));
    }
  }

  let amountUsd = 0;
  let bandsApplied = 0;
  if (quantity > 0) {
    for (const band of bands) {
      const upper = band.tierMax ?? Number.POSITIVE_INFINITY;
      if (quantity <= band.tierMin) {
        continue;
      }
      const span = Math.min(quantity, upper) - band.tierMin;
      if (span > 0) {
        amountUsd += span * band.unitPrice;
        bandsApplied += 1;
      }
    }
  }

  const head = bands[0]!;
  const blendedUnitPriceUsd = quantity > 0 ? amountUsd / quantity : head.unitPrice;
  const note =
    bandsApplied > 1
      ? `Progressive across ${bands.length} bands (blended rate)`
      : bands.length > 1 && includeFreeTier && bands[0]!.unitPrice === 0
        ? `Includes free tier up to ${bands[0]!.tierMax?.toLocaleString() ?? 0} ${head.unit}`
        : undefined;

  return {
    amountUsd,
    blendedUnitPriceUsd,
    unit: head.unit,
    skuKey: head.skuKey,
    ...(note ? { note } : {}),
  };
}

interface PriceLookupOutcome {
  bands: NormalizedPriceRow[] | null;
  regionMissing?: string;
  skuMissing?: string;
}

function lookupSnapshotPriceBands(
  snapshot: PriceSnapshot | null,
  params: {
    provider: Provider;
    serviceId: string;
    region: string;
    unitRole: string;
    preferredSkuKey?: string;
    requireSkuMatch?: boolean;
  },
): PriceLookupOutcome {
  if (!snapshot || snapshot.prices.length === 0) {
    return { bands: null };
  }

  const forService = snapshot.prices.filter(
    (p) => p.provider === params.provider && p.serviceId === params.serviceId,
  );
  if (forService.length === 0) {
    return { bands: null };
  }

  const roleMatches = forService.filter((p) => getRowUnitRole(p) === params.unitRole);
  const poolAfterRole = roleMatches.length > 0 ? roleMatches : forService;

  const targetRegionLower = params.region.trim().toLowerCase();
  let regionRows = poolAfterRole.filter((p) => p.region.toLowerCase() === targetRegionLower);

  if (regionRows.length === 0) {
    const globalRows = poolAfterRole.filter((p) => p.region.toLowerCase() === 'global');
    if (globalRows.length > 0) {
      regionRows = globalRows;
    } else {
      return { bands: null, regionMissing: params.region };
    }
  }

  let selectedRows = regionRows;
  if (params.preferredSkuKey) {
    const skuLower = params.preferredSkuKey.trim().toLowerCase();
    const exactSkuRows = regionRows.filter((p) => p.skuKey.toLowerCase() === skuLower);
    if (exactSkuRows.length > 0) {
      selectedRows = exactSkuRows;
    } else if (params.requireSkuMatch) {
      return { bands: null, skuMissing: params.preferredSkuKey };
    }
  } else {
    // Group by primary deterministic skuKey when multiple SKUs coexist for the same role
    const firstSkuKey = selectedRows[0]?.skuKey;
    if (firstSkuKey) {
      selectedRows = selectedRows.filter((p) => p.skuKey === firstSkuKey);
    }
  }

  if (selectedRows.length === 0) {
    return { bands: null };
  }

  return { bands: selectedRows };
}

function resolveActiveInstances(
  node: NodeInstance,
  simResult: SimulationResult | null,
  mode: 'average' | 'peak',
  runDurationS: number,
): number {
  const baseline = Math.max(0, node.config.instances ?? 1);
  if (!simResult) {
    return baseline;
  }

  if (mode === 'peak') {
    const bucketValues: number[] = [];
    for (const bucket of simResult.series.buckets) {
      const nb = bucket.perNode[node.id];
      if (nb) {
        bucketValues.push(nb.instancesActive);
      }
    }
    if (bucketValues.length > 0) {
      return Math.max(...bucketValues);
    }
  }

  const counter = simResult.counters.perNode[node.id];
  if (counter && runDurationS > 0 && counter.instanceSeconds >= 0) {
    return counter.instanceSeconds / runDurationS;
  }

  if (simResult.series.buckets.length > 0) {
    let sum = 0;
    let count = 0;
    for (const bucket of simResult.series.buckets) {
      const nb = bucket.perNode[node.id];
      if (nb) {
        sum += nb.instancesActive;
        count += 1;
      }
    }
    if (count > 0) {
      return sum / count;
    }
  }

  return baseline;
}

function resolveOciOcpuDivisor(
  node: NodeInstance,
  spec: InstanceSpecEntry | undefined,
): { divisor: number; label: string } {
  if (spec?.family && spec.family.includes('1 OCPU = 1 vCPU')) {
    return { divisor: 1, label: 'Arm ÷ 1' };
  }
  if (spec?.family && spec.family.includes('1 OCPU = 2 vCPU')) {
    return { divisor: 2, label: spec.arch === 'arm64' ? 'AmpereOne ÷ 2' : 'x86 ÷ 2' };
  }
  const attrArch = typeof node.importedAttrs?.arch === 'string' ? node.importedAttrs.arch : '';
  const arch = attrArch || spec?.arch || '';
  if (arch.toLowerCase() === 'arm64') {
    return { divisor: 1, label: 'Arm ÷ 1' };
  }
  return { divisor: 2, label: 'x86 ÷ 2' };
}

function computeRawQuantityForRole(params: {
  unitRole: string;
  unit: string;
  node: NodeInstance;
  service: ServiceDefinition;
  spec: InstanceSpecEntry | undefined;
  activeInstances: number;
  hoursPerMonth: number;
  scaledRequests: number;
  scaledBytesIn: number;
  scaledBytesOut: number;
  scaledReadUnits: number;
  scaledWriteUnits: number;
  scaledGbSeconds: number;
  matchedAttrs?: Record<string, unknown>;
}): { quantity: number; note?: string } {
  const {
    unitRole,
    unit,
    node,
    service,
    spec,
    activeInstances,
    hoursPerMonth,
    scaledRequests,
    scaledBytesIn,
    scaledBytesOut,
    scaledReadUnits,
    scaledWriteUnits,
    scaledGbSeconds,
    matchedAttrs,
  } = params;

  const unitLower = unit.trim().toLowerCase();
  const scaleDiv = unitScaleDivisor(unit);
  const vcpu =
    node.config.vcpu ??
    spec?.vcpu ??
    (typeof matchedAttrs?.vcpu === 'number' ? matchedAttrs.vcpu : undefined) ??
    2;
  const memoryGb =
    node.config.memoryGb ??
    spec?.memoryGb ??
    (typeof matchedAttrs?.memoryGb === 'number' ? matchedAttrs.memoryGb : undefined) ??
    4;

  switch (unitRole) {
    case 'instance_hour': {
      if (unitLower === 'day' || unitLower === 'days') {
        return { quantity: (hoursPerMonth / 24) * activeInstances };
      }
      return { quantity: hoursPerMonth * activeInstances };
    }

    case 'vcpu_hour': {
      if (service.provider === 'oci' || unitLower.startsWith('ocpu')) {
        const ocpu = resolveOciOcpuDivisor(node, spec);
        const ocpuCount = vcpu / ocpu.divisor;
        return {
          quantity: hoursPerMonth * activeInstances * ocpuCount,
          note: `${vcpu} vCPU = ${ocpuCount} OCPU (${ocpu.label})`,
        };
      }
      return {
        quantity: hoursPerMonth * activeInstances * vcpu,
        note: `${vcpu} vCPU × ${activeInstances.toFixed(1).replace(/\.0$/, '')} inst`,
      };
    }

    case 'memory_gb_hour': {
      return {
        quantity: hoursPerMonth * activeInstances * memoryGb,
        note: `${memoryGb} GB RAM × ${activeInstances.toFixed(1).replace(/\.0$/, '')} inst`,
      };
    }

    case 'flat_month':
      return { quantity: activeInstances };

    case 'requests':
    case 'messages': {
      if (unitLower.includes('requests-hr')) {
        return { quantity: hoursPerMonth * activeInstances };
      }
      if (unitLower.includes('tps-hours')) {
        const avgRps = hoursPerMonth > 0 ? scaledRequests / (hoursPerMonth * 3600) : 0;
        return { quantity: avgRps > 0 ? Math.max(1, avgRps) * hoursPerMonth : 0 };
      }
      return { quantity: scaledRequests / scaleDiv };
    }

    case 'gb_second': {
      if (scaledGbSeconds > 0) {
        return { quantity: scaledGbSeconds };
      }
      if (scaledRequests > 0) {
        const avgMs = node.config.latency?.p50 ?? service.latency.p50 ?? 50;
        const estGb = Math.max(0.128, memoryGb / 8);
        return { quantity: scaledRequests * (avgMs / 1000) * estGb };
      }
      return { quantity: 0 };
    }

    case 'storage_gb_month': {
      const storageGb =
        node.config.storageGb ??
        (typeof node.importedAttrs?.allocatedStorageGb === 'number'
          ? node.importedAttrs.allocatedStorageGb
          : 0);
      if (unitLower.includes('day')) {
        return { quantity: storageGb * (hoursPerMonth / 24) };
      }
      return { quantity: storageGb };
    }

    case 'tb_scanned': {
      const bytes = node.config.scannedBytes ?? 0;
      if (unitLower.startsWith('gb')) {
        return { quantity: bytes / BYTES_PER_GB };
      }
      return { quantity: bytes / BYTES_PER_TB };
    }

    case 'data_transfer_gb': {
      if (unitLower.includes('gb-mo')) {
        return { quantity: (scaledBytesIn + scaledBytesOut) / BYTES_PER_GB };
      }
      return { quantity: Math.max(scaledBytesIn, scaledBytesOut) / BYTES_PER_GB };
    }

    case 'acu_hour': {
      const acus = Math.max(0.5, vcpu / 2) * activeInstances;
      return {
        quantity: hoursPerMonth * acus,
        note: `${acus} ACU (${vcpu} vCPU eq.)`,
      };
    }

    case 'lcu_hour': {
      const totalGb = (scaledBytesIn + scaledBytesOut) / BYTES_PER_GB;
      if (unitLower === 'gb') {
        return { quantity: totalGb };
      }
      if (unitLower.includes('mbps-hours')) {
        const avgMbps = hoursPerMonth > 0 ? (totalGb * 8192) / (hoursPerMonth * 3600) : 0;
        return { quantity: hoursPerMonth * Math.max(10 * activeInstances, avgMbps) };
      }
      const avgGbPerHr = hoursPerMonth > 0 ? totalGb / hoursPerMonth : 0;
      const avgRps = hoursPerMonth > 0 ? scaledRequests / (hoursPerMonth * 3600) : 0;
      const lcuPerHr = scaledRequests > 0 ? Math.max(1, avgGbPerHr, avgRps / 25) : 0;
      return { quantity: lcuPerHr * hoursPerMonth };
    }

    case 'rcu_hour': {
      if (unitLower.endsWith('-mo')) {
        const readUnits =
          scaledReadUnits > 0 ? scaledReadUnits : scaledRequests * (node.config.readRatio ?? 0.8);
        return { quantity: readUnits / 1000 };
      }
      const readUnits =
        scaledReadUnits > 0 ? scaledReadUnits : scaledRequests * (node.config.readRatio ?? 0.8);
      return { quantity: readUnits / scaleDiv };
    }

    case 'wcu_hour': {
      if (unitLower.endsWith('-mo')) {
        const writeUnits =
          scaledWriteUnits > 0
            ? scaledWriteUnits
            : scaledRequests * (1 - (node.config.readRatio ?? 0.8));
        return { quantity: writeUnits / 1000 };
      }
      const writeUnits =
        scaledWriteUnits > 0
          ? scaledWriteUnits
          : scaledRequests * (1 - (node.config.readRatio ?? 0.8));
      return { quantity: writeUnits / scaleDiv };
    }

    case 'ru_hour': {
      const avgRps = hoursPerMonth > 0 ? scaledRequests / (hoursPerMonth * 3600) : 0;
      const rusNeeded = scaledRequests > 0 ? Math.max(400, Math.ceil(avgRps * 10)) : 400;
      return {
        quantity: (rusNeeded / scaleDiv) * hoursPerMonth,
        note: `${rusNeeded} RU/s provisioned baseline`,
      };
    }

    case 'shard_hour':
      return { quantity: Math.max(1, activeInstances) * hoursPerMonth };

    case 'mau': {
      const attrMau =
        typeof node.importedAttrs?.mau === 'number' ? node.importedAttrs.mau : undefined;
      if (attrMau !== undefined) {
        return { quantity: attrMau };
      }
      return {
        quantity: scaledRequests > 0 ? Math.max(1, Math.round(scaledRequests / 100)) : 0,
        ...(scaledRequests > 0 ? { note: 'Estimated ~100 req/MAU' } : {}),
      };
    }

    case 'tokens_1m_in': {
      const avgIn = Math.max(
        100,
        Math.round((node.config.rateLimit?.maxContextTokens ?? 1000) * 0.5),
      );
      return {
        quantity: (scaledRequests * avgIn) / 1_000_000,
        ...(scaledRequests > 0 ? { note: `${avgIn} avg input tokens/req` } : {}),
      };
    }

    case 'tokens_1m_out': {
      const avgOut = Math.max(50, node.config.rateLimit?.maxOutputTokens ?? 250);
      return {
        quantity: (scaledRequests * avgOut) / 1_000_000,
        ...(scaledRequests > 0 ? { note: `${avgOut} avg output tokens/req` } : {}),
      };
    }

    case 'unit':
    default: {
      if (unitLower.includes('secret-month') || unitLower === 'month') {
        return { quantity: activeInstances };
      }
      if (unitLower === 'day') {
        return { quantity: (hoursPerMonth / 24) * activeInstances };
      }
      if (unitLower.includes('ocu-hours') || unitLower.includes('ecpu-hours')) {
        return { quantity: hoursPerMonth * activeInstances * Math.max(1, vcpu / 2) };
      }
      if (unitLower.includes('mbps-hours')) {
        return { quantity: hoursPerMonth * activeInstances * 10 };
      }
      return { quantity: scaledRequests / scaleDiv };
    }
  }
}

type TransferCategory =
  'internet_egress' | 'inter_az' | 'inter_region' | 'nat_processing' | 'privatelink' | 'same_az';

function resolveTransferCategory(
  edge: EdgeInstance,
  edgeCounter: SimulationResult['counters']['perEdge'][string],
  fromNode: NodeInstance,
  toNode: NodeInstance,
  fromService: ServiceDefinition | undefined,
  toService: ServiceDefinition | undefined,
): TransferCategory {
  const fromGeneric = fromService?.provider === 'generic';
  const toGeneric = toService?.provider === 'generic';

  if (fromGeneric !== toGeneric) {
    return 'internet_egress';
  }
  if (edgeCounter.viaPrivateLink || edge.tunnel === 'privatelink') {
    return 'privatelink';
  }
  if (edgeCounter.viaNat || fromService?.kind === 'net' || toService?.kind === 'net') {
    return 'nat_processing';
  }
  if (edgeCounter.crossRegion) {
    return 'inter_region';
  }
  if (edgeCounter.crossAz) {
    return 'inter_az';
  }
  if (fromNode.region && toNode.region && fromNode.region !== toNode.region) {
    return 'inter_region';
  }
  if (fromNode.az && toNode.az && fromNode.az !== toNode.az) {
    return 'inter_az';
  }
  return 'same_az';
}

function transferServiceIdForCategory(cat: Exclude<TransferCategory, 'same_az'>): string {
  switch (cat) {
    case 'internet_egress':
      return 'transfer.internet_egress';
    case 'inter_az':
      return 'transfer.inter_az';
    case 'inter_region':
      return 'transfer.inter_region';
    case 'nat_processing':
      return 'transfer.nat_processing';
    case 'privatelink':
      return 'transfer.privatelink';
  }
}

function transferLabelForCategory(cat: TransferCategory): string {
  switch (cat) {
    case 'internet_egress':
      return 'Internet egress';
    case 'inter_az':
      return 'Inter-AZ transfer';
    case 'inter_region':
      return 'Inter-region transfer';
    case 'nat_processing':
      return 'NAT processing';
    case 'privatelink':
      return 'PrivateLink data';
    case 'same_az':
      return 'Same-AZ transfer (free)';
  }
}

/** Estimates monthly cloud cost across all nodes and edges from synced public price lists and simulation usage counters. */
export function estimateMonthlyCost(
  design: Design,
  simResult: SimulationResult | null,
  priceSnapshot: PriceSnapshot | null,
  assumptionsInput?: Partial<CostAssumptions>,
  options: EstimateCostOptions = {},
): CostReport {
  const assumptions: CostAssumptions = {
    hoursPerMonth: Math.max(1, assumptionsInput?.hoursPerMonth ?? DEFAULT_HOURS_PER_MONTH),
    traffic: assumptionsInput?.traffic ?? DEFAULT_COST_ASSUMPTIONS.traffic,
    instanceCountMode:
      assumptionsInput?.instanceCountMode ?? DEFAULT_COST_ASSUMPTIONS.instanceCountMode,
    includeFreeTier: assumptionsInput?.includeFreeTier ?? design.settings.includeFreeTier ?? false,
    currency: assumptionsInput?.currency ?? design.settings.currency ?? 'USD',
    ...(assumptionsInput?.fxRateToUSD !== undefined
      ? { fxRateToUSD: assumptionsInput.fxRateToUSD }
      : design.settings.fxRateToUSD !== undefined
        ? { fxRateToUSD: design.settings.fxRateToUSD }
        : {}),
  };

  const warnings: string[] = [];
  const addWarning = (msg: string) => {
    if (!warnings.includes(msg)) {
      warnings.push(msg);
    }
  };

  const customServices = [...(design.customServices ?? []), ...(options.customServices ?? [])];
  const groupsById = new Map(design.groups.map((g) => [g.id, g]));
  const nodesById = new Map(design.nodes.map((n) => [n.id, n]));

  const runDurationS = Math.max(1, simResult?.durationS ?? design.scenarios[0]?.durationS ?? 60);
  const monthSeconds = assumptions.hoursPerMonth * 3600;
  const runRequests = simResult ? Math.max(0, simResult.summary.totalRequests) : 0;

  let monthlyRequests = 0;
  let requestScaleFactor = 0;

  if (assumptions.traffic.mode === 'custom-monthly-requests') {
    monthlyRequests = Math.max(0, assumptions.traffic.value ?? 0);
    requestScaleFactor = runRequests > 0 ? monthlyRequests / runRequests : 0;
  } else if (assumptions.traffic.mode === 'custom-avg-rps') {
    monthlyRequests = Math.max(0, assumptions.traffic.value ?? 0) * monthSeconds;
    requestScaleFactor = runRequests > 0 ? monthlyRequests / runRequests : 0;
  } else {
    requestScaleFactor = simResult ? monthSeconds / runDurationS : 0;
    monthlyRequests = runRequests * requestScaleFactor;
  }

  // Snapshot freshness and metadata checks
  let asOf = options.nowIso ?? 'unsynced';
  if (priceSnapshot) {
    const providerDates = Object.values(priceSnapshot.providers ?? {})
      .map((m) => m?.fetchedAt)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    asOf = priceSnapshot.generatedAt ?? providerDates[0] ?? options.nowIso ?? 'synced';
  }

  if (!simResult) {
    addWarning(
      'No simulation run yet — fixed hourly capacities shown; request & transfer costs require a run.',
    );
  } else if (simResult.durationS < 60 && assumptions.traffic.mode === 'run-average') {
    addWarning(
      `Run shorter than 60 s (${simResult.durationS}s) — monthly extrapolation unreliable.`,
    );
  }
  if (assumptions.traffic.mode !== 'run-average' && simResult) {
    addWarning(`Traffic scaled proportionally using ${assumptions.traffic.mode}.`);
  }
  if (assumptions.includeFreeTier) {
    addWarning('Free-tier allowances included — eligibility depends on your cloud account.');
  }
  if (!priceSnapshot) {
    addWarning(
      'No synced price snapshot available — prices shown as unavailable unless entered manually.',
    );
  }

  // Evaluate snapshot staleness (> 7 days)
  const staleThresholdDays = options.staleAfterDays ?? priceSnapshot?.staleAfterDays ?? 7;
  const referenceNowIso = options.nowIso ?? priceSnapshot?.generatedAt;
  const referenceNowMs = referenceNowIso ? Date.parse(referenceNowIso) : Number.NaN;

  const usedCloudProviders = new Set<'aws' | 'gcp' | 'azure' | 'oci'>();
  for (const n of design.nodes) {
    const svc = getService(n.serviceId, customServices);
    if (svc && isCloudProvider(svc.provider)) {
      usedCloudProviders.add(svc.provider);
    }
  }

  if (priceSnapshot?.providers) {
    for (const [provKey, meta] of Object.entries(priceSnapshot.providers)) {
      if (!meta) continue;
      if (usedCloudProviders.size > 0 && !usedCloudProviders.has(provKey as 'aws')) {
        continue;
      }
      const fetchedMs = Date.parse(meta.fetchedAt);
      const exceededAge =
        Number.isFinite(referenceNowMs) &&
        Number.isFinite(fetchedMs) &&
        (referenceNowMs - fetchedMs) / MS_PER_DAY > staleThresholdDays;
      if (meta.stale || exceededAge) {
        addWarning(
          `${provKey.toUpperCase()} price snapshot is older than ${staleThresholdDays} days (fetched ${meta.fetchedAt.slice(0, 10)}).`,
        );
      }
    }
  }

  // First pass: Data transfer lines from SimulationResult.counters.perEdge (computed before node net pass so NAT bytes aren't double-counted)
  const natNodesCoveredByTransfer = new Set<string>();
  const transferAggregates = new Map<
    string,
    {
      provider: 'aws' | 'gcp' | 'azure' | 'oci';
      region: string;
      category: TransferCategory;
      gb: number;
      edgeLabels: string[];
      nodeIds: string[];
    }
  >();

  if (simResult) {
    for (const edge of design.edges) {
      const ec = simResult.counters.perEdge[edge.id];
      if (!ec || ec.bytes <= 0) {
        continue;
      }
      const monthlyGb = (ec.bytes * requestScaleFactor) / BYTES_PER_GB;
      if (monthlyGb <= 0) {
        continue;
      }
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (!fromNode || !toNode) {
        continue;
      }
      const fromSvc = getService(fromNode.serviceId, customServices);
      const toSvc = getService(toNode.serviceId, customServices);
      const category = resolveTransferCategory(edge, ec, fromNode, toNode, fromSvc, toSvc);

      const billingNode =
        fromSvc && isCloudProvider(fromSvc.provider)
          ? fromNode
          : toSvc && isCloudProvider(toSvc.provider)
            ? toNode
            : null;
      const billingSvc = billingNode === fromNode ? fromSvc : toSvc;
      if (!billingNode || !billingSvc || !isCloudProvider(billingSvc.provider)) {
        continue;
      }

      const resolvedRegion = resolveNodeRegion(billingNode, groupsById);
      const region =
        resolvedRegion ?? options.defaultRegion ?? PROVIDER_DEFAULT_REGIONS[billingSvc.provider];
      const key = `${billingSvc.provider}|${region}|${category}`;

      const existing = transferAggregates.get(key) ?? {
        provider: billingSvc.provider,
        region,
        category,
        gb: 0,
        edgeLabels: [],
        nodeIds: [],
      };
      existing.gb += monthlyGb;
      existing.edgeLabels.push(`${fromNode.label} -> ${toNode.label}`);
      if (fromSvc?.kind === 'net') existing.nodeIds.push(fromNode.id);
      if (toSvc?.kind === 'net') existing.nodeIds.push(toNode.id);
      transferAggregates.set(key, existing);
    }
  }

  const transferLinesUsd: CostLine[] = [];
  for (const agg of transferAggregates.values()) {
    const labelList = [...new Set(agg.edgeLabels)].slice(0, 3).join(', ');
    if (agg.category === 'same_az') {
      transferLinesUsd.push({
        dimension: transferLabelForCategory('same_az'),
        quantity: agg.gb,
        unit: 'GB',
        unitPrice: 0,
        amount: 0,
        source: 'synced',
        note: `Intra-AZ traffic is free (${labelList})`,
      });
      continue;
    }

    if (agg.category === 'inter_az' && agg.provider === 'oci') {
      const reason =
        getKnownUnavailableReason('transfer.inter_az') ??
        'Inter-AZ intra-region AD transfer is free on OCI.';
      transferLinesUsd.push({
        dimension: transferLabelForCategory('inter_az'),
        quantity: agg.gb,
        unit: 'GB',
        unitPrice: 0,
        amount: 0,
        source: 'synced',
        note: reason,
      });
      continue;
    }

    const xferServiceId = transferServiceIdForCategory(agg.category);
    const lookup = lookupSnapshotPriceBands(priceSnapshot, {
      provider: agg.provider,
      serviceId: xferServiceId,
      region: agg.region,
      unitRole: 'data_transfer_gb',
    });

    if (!lookup.bands) {
      addWarning(
        `Price unavailable for ${agg.provider.toUpperCase()} ${transferLabelForCategory(agg.category)} in ${agg.region}.`,
      );
      transferLinesUsd.push({
        dimension: transferLabelForCategory(agg.category),
        quantity: agg.gb,
        unit: 'GB',
        unitPrice: null,
        amount: null,
        source: 'unavailable',
        note: `price unavailable (${agg.provider} ${agg.region}; ${labelList})`,
      });
      continue;
    }

    const resolved = computeProgressiveTiers(lookup.bands, agg.gb, assumptions.includeFreeTier);
    if (agg.category === 'nat_processing') {
      for (const nid of agg.nodeIds) {
        natNodesCoveredByTransfer.add(nid);
      }
    }

    transferLinesUsd.push({
      dimension: transferLabelForCategory(agg.category),
      quantity: agg.gb,
      unit: resolved.unit,
      unitPrice: resolved.blendedUnitPriceUsd,
      amount: resolved.amountUsd,
      skuKey: resolved.skuKey,
      source: 'synced',
      note: resolved.note ? `${resolved.note} — ${labelList}` : labelList,
    });
  }

  // Second pass: Per-node costs in USD
  const perNodeUsd: Record<
    string,
    { lines: CostLine[]; subtotal: number; category: CostCategory }
  > = {};

  for (const node of design.nodes) {
    const service = getService(node.serviceId, customServices);
    if (!service) {
      if (node.config.pricing?.manualUnitPrice !== undefined) {
        const hrs = assumptions.hoursPerMonth * Math.max(1, node.config.instances);
        const amount = hrs * node.config.pricing.manualUnitPrice;
        perNodeUsd[node.id] = {
          lines: [
            {
              dimension: 'manual unit price',
              quantity: hrs,
              unit: node.config.pricing.manualUnit ?? 'Hours',
              unitPrice: node.config.pricing.manualUnitPrice,
              amount,
              skuKey: node.config.pricing.skuKey,
              source: 'manual',
            },
          ],
          subtotal: amount,
          category: 'other',
        };
      } else {
        addWarning(
          `Price unavailable for unrecognized service "${node.serviceId}" (${node.label}).`,
        );
        perNodeUsd[node.id] = {
          lines: [
            {
              dimension: 'unknown service',
              quantity: 0,
              unit: 'Units',
              unitPrice: null,
              amount: null,
              source: 'unavailable',
              note: 'price unavailable',
            },
          ],
          subtotal: 0,
          category: 'other',
        };
      }
      continue;
    }

    const category = KIND_TO_COST_CATEGORY[service.kind] ?? 'other';
    const counter = simResult?.counters.perNode[node.id];
    const scaledRequests = (counter?.requests ?? 0) * requestScaleFactor;
    const scaledBytesIn = (counter?.bytesIn ?? 0) * requestScaleFactor;
    const scaledBytesOut = (counter?.bytesOut ?? 0) * requestScaleFactor;
    const scaledReadUnits = (counter?.readUnits ?? 0) * requestScaleFactor;
    const scaledWriteUnits = (counter?.writeUnits ?? 0) * requestScaleFactor;
    const scaledGbSeconds = (counter?.gbSeconds ?? 0) * requestScaleFactor;
    const activeInstances = resolveActiveInstances(
      node,
      simResult,
      assumptions.instanceCountMode,
      runDurationS,
    );

    if (
      node.config.instanceType &&
      BURSTABLE_PREFIXES.some((p) => node.config.instanceType!.toLowerCase().startsWith(p))
    ) {
      addWarning(`CPU burstable credits for ${node.config.instanceType} are not modeled.`);
    }

    // Generic or free services
    if (service.provider === 'generic' || service.pricing.model === 'free') {
      if (node.config.pricing?.manualUnitPrice !== undefined) {
        const hrs = assumptions.hoursPerMonth * activeInstances;
        const unit = node.config.pricing.manualUnit ?? 'Hours';
        const qty = unit.toLowerCase().includes('req')
          ? scaledRequests / unitScaleDivisor(unit)
          : hrs;
        const amount = qty * node.config.pricing.manualUnitPrice;
        perNodeUsd[node.id] = {
          lines: [
            {
              dimension: 'manual override',
              quantity: qty,
              unit,
              unitPrice: node.config.pricing.manualUnitPrice,
              amount,
              skuKey: node.config.pricing.skuKey,
              source: 'manual',
            },
          ],
          subtotal: amount,
          category,
        };
      } else {
        perNodeUsd[node.id] = { lines: [], subtotal: 0, category };
      }
      continue;
    }

    // Known unavailable services (e.g. control planes / free orchestration services)
    const knownUnavailable = getKnownUnavailableReason(service.id);
    if (knownUnavailable && node.config.pricing?.manualUnitPrice === undefined) {
      addWarning(`Price unavailable for ${node.label}: ${knownUnavailable}`);
      perNodeUsd[node.id] = {
        lines: [
          {
            dimension: formatRoleDimension(service.pricing.model),
            quantity: assumptions.hoursPerMonth * activeInstances,
            unit: defaultUnitForPriceModel(service.pricing.model),
            unitPrice: null,
            amount: null,
            source: 'unavailable',
            note: `price unavailable — ${knownUnavailable}`,
          },
        ],
        subtotal: 0,
        category,
      };
      continue;
    }

    // Custom services (custom.*)
    if (service.provider === 'custom') {
      const customDef = customServices.find((c) => c.id === service.id) as
        CustomServiceDefinition | undefined;
      const manualPrice = node.config.pricing?.manualUnitPrice ?? customDef?.manualUnitPrice;
      const manualUnit = node.config.pricing?.manualUnit ?? customDef?.manualUnit ?? 'Hours';

      if (manualPrice !== undefined && Number.isFinite(manualPrice)) {
        const unitLower = manualUnit.toLowerCase();
        const div = unitScaleDivisor(manualUnit);
        const qty = unitLower.includes('req')
          ? scaledRequests / div
          : unitLower.includes('gb-mo')
            ? (node.config.storageGb ?? 0)
            : unitLower.includes('month')
              ? activeInstances
              : assumptions.hoursPerMonth * activeInstances;
        const amount = qty * manualPrice;
        perNodeUsd[node.id] = {
          lines: [
            {
              dimension: 'custom service rate',
              quantity: qty,
              unit: manualUnit,
              unitPrice: manualPrice,
              amount,
              skuKey: node.config.pricing?.skuKey ?? 'custom',
              source: 'manual',
            },
          ],
          subtotal: amount,
          category,
        };
      } else {
        addWarning(`Price unavailable for custom service "${node.label}" — enter a manual rate.`);
        perNodeUsd[node.id] = {
          lines: [
            {
              dimension: 'custom service rate',
              quantity: assumptions.hoursPerMonth * activeInstances,
              unit: manualUnit,
              unitPrice: null,
              amount: null,
              source: 'unavailable',
              note: 'price unavailable — enter manual unit price',
            },
          ],
          subtotal: 0,
          category,
        };
      }
      continue;
    }

    // Explicit manual price override on a cloud node
    if (node.config.pricing?.manualUnitPrice !== undefined) {
      const unit =
        node.config.pricing.manualUnit ?? defaultUnitForPriceModel(service.pricing.model);
      const lower = unit.toLowerCase();
      const qty = lower.includes('req')
        ? scaledRequests / unitScaleDivisor(unit)
        : lower.includes('gb-mo')
          ? (node.config.storageGb ?? 0)
          : lower.includes('month')
            ? activeInstances
            : assumptions.hoursPerMonth * activeInstances;
      const amount = qty * node.config.pricing.manualUnitPrice;
      perNodeUsd[node.id] = {
        lines: [
          {
            dimension: 'manual rate',
            quantity: qty,
            unit,
            unitPrice: node.config.pricing.manualUnitPrice,
            amount,
            ...(node.config.pricing.skuKey ? { skuKey: node.config.pricing.skuKey } : {}),
            source: 'manual',
          },
        ],
        subtotal: amount,
        category,
      };
      continue;
    }

    // Built-in cloud service: resolve region + planned billing dimensions from PRICE_SKU_MAPPINGS
    const provider = isCloudProvider(service.provider) ? service.provider : 'aws';
    const resolvedRegion = resolveNodeRegion(node, groupsById);
    const region = resolvedRegion ?? options.defaultRegion ?? PROVIDER_DEFAULT_REGIONS[provider];
    const mappings = PRICE_SKU_MAPPINGS.filter(
      (m) => m.serviceId === service.id && m.provider === provider,
    );
    const plan = mappings.length > 0 ? mappings : buildFallbackMappings(service);
    const preferredSkuKey = node.config.pricing?.skuKey ?? node.config.instanceType;
    const spec = node.config.instanceType
      ? getInstanceSpec(provider, node.config.instanceType)
      : undefined;

    const lines: CostLine[] = [];
    let subtotal = 0;

    for (const dimMapping of plan) {
      if (
        dimMapping.unitRole === 'data_transfer_gb' &&
        service.kind === 'net' &&
        natNodesCoveredByTransfer.has(node.id)
      ) {
        continue;
      }

      const requireSkuMatch = Boolean(
        preferredSkuKey &&
        (dimMapping.filter.keyBy === 'instanceType' ||
          dimMapping.filter.keyBy === 'armSkuName' ||
          dimMapping.filter.keyBy === 'machineType' ||
          Boolean(node.config.pricing?.skuKey)),
      );

      const lookup = lookupSnapshotPriceBands(priceSnapshot, {
        provider,
        serviceId: service.id,
        region,
        unitRole: dimMapping.unitRole,
        preferredSkuKey,
        requireSkuMatch,
      });

      if (!lookup.bands) {
        const missingReason = lookup.regionMissing
          ? `no price in region ${lookup.regionMissing}`
          : lookup.skuMissing
            ? `SKU "${lookup.skuMissing}" not in snapshot`
            : 'not in synced snapshot';
        addWarning(
          `Price unavailable for ${node.label} (${dimMapping.unitRole}): ${missingReason}.`,
        );

        const estQty = computeRawQuantityForRole({
          unitRole: dimMapping.unitRole,
          unit: dimMapping.unit,
          node,
          service,
          spec,
          activeInstances,
          hoursPerMonth: assumptions.hoursPerMonth,
          scaledRequests,
          scaledBytesIn,
          scaledBytesOut,
          scaledReadUnits,
          scaledWriteUnits,
          scaledGbSeconds,
        });

        lines.push({
          dimension: formatRoleDimension(dimMapping.unitRole),
          quantity: estQty.quantity,
          unit: dimMapping.unit,
          unitPrice: null,
          amount: null,
          ...(preferredSkuKey ? { skuKey: preferredSkuKey } : {}),
          source: 'unavailable',
          note: `price unavailable — ${missingReason}`,
        });
        continue;
      }

      const sampleRow = lookup.bands[0]!;
      const qtyResult = computeRawQuantityForRole({
        unitRole: dimMapping.unitRole,
        unit: sampleRow.unit || dimMapping.unit,
        node,
        service,
        spec,
        activeInstances,
        hoursPerMonth: assumptions.hoursPerMonth,
        scaledRequests,
        scaledBytesIn,
        scaledBytesOut,
        scaledReadUnits,
        scaledWriteUnits,
        scaledGbSeconds,
        matchedAttrs: sampleRow.attrs,
      });

      const resolved = computeProgressiveTiers(
        lookup.bands,
        qtyResult.quantity,
        assumptions.includeFreeTier,
      );
      subtotal += resolved.amountUsd;

      const noteParts = [qtyResult.note, resolved.note].filter(Boolean);
      lines.push({
        dimension: formatRoleDimension(dimMapping.unitRole),
        quantity: qtyResult.quantity,
        unit: resolved.unit,
        unitPrice: resolved.blendedUnitPriceUsd,
        amount: resolved.amountUsd,
        skuKey: resolved.skuKey,
        source: 'synced',
        ...(noteParts.length > 0 ? { note: noteParts.join(' · ') } : {}),
      });
    }

    perNodeUsd[node.id] = { lines, subtotal, category };
  }

  // Compute totals & category buckets in USD first
  const byCategoryUsd: Record<string, number> = {
    compute: 0,
    database: 0,
    network: 0,
    storage: 0,
    ai: 0,
    other: 0,
  };

  let monthlyTotalUsd = 0;
  for (const nodeEntry of Object.values(perNodeUsd)) {
    monthlyTotalUsd += nodeEntry.subtotal;
    byCategoryUsd[nodeEntry.category] =
      (byCategoryUsd[nodeEntry.category] ?? 0) + nodeEntry.subtotal;
  }
  for (const xferLine of transferLinesUsd) {
    if (xferLine.amount !== null) {
      monthlyTotalUsd += xferLine.amount;
      byCategoryUsd.network = (byCategoryUsd.network ?? 0) + xferLine.amount;
    }
  }

  // Apply manual currency conversion if valid FX rate provided (no invented/live FX rates)
  let outputCurrency: CostAssumptions['currency'] = assumptions.currency;
  let fxMult = 1;
  if (assumptions.currency !== 'USD') {
    if (
      typeof assumptions.fxRateToUSD === 'number' &&
      Number.isFinite(assumptions.fxRateToUSD) &&
      assumptions.fxRateToUSD > 0
    ) {
      fxMult = assumptions.fxRateToUSD;
    } else {
      addWarning(
        `Manual FX rate required for ${assumptions.currency} — displaying USD until rate is entered.`,
      );
      outputCurrency = 'USD';
    }
  }

  const convertLine = (line: CostLine): CostLine => ({
    ...line,
    unitPrice: line.unitPrice !== null ? line.unitPrice * fxMult : null,
    amount: line.amount !== null ? line.amount * fxMult : null,
  });

  const perNode: CostReport['perNode'] = {};
  for (const [nodeId, entry] of Object.entries(perNodeUsd)) {
    perNode[nodeId] = {
      lines: entry.lines.map(convertLine),
      subtotal: entry.subtotal * fxMult,
    };
  }

  const transfer = transferLinesUsd.map(convertLine);
  const byCategory: Record<string, number> = {};
  for (const cat of COST_CATEGORIES) {
    byCategory[cat] = (byCategoryUsd[cat] ?? 0) * fxMult;
  }

  const monthlyTotal = monthlyTotalUsd * fxMult;
  const costPerMillionRequests =
    monthlyRequests > 0 ? (monthlyTotal / monthlyRequests) * 1_000_000 : 0;

  return {
    currency: outputCurrency,
    asOf,
    monthlyTotal,
    perNode,
    transfer,
    byCategory,
    costPerMillionRequests,
    warnings,
    assumptions: {
      ...assumptions,
      currency: outputCurrency,
    },
  };
}

/** Derives supplemental provider split, transfer sum, and baseline USD figures from a CostReport. */
export function summarizeCostBreakdown(
  design: Design,
  report: CostReport,
  simResult: SimulationResult | null,
  options: Pick<EstimateCostOptions, 'customServices'> = {},
): CostBreakdownMeta {
  const customServices = [...(design.customServices ?? []), ...(options.customServices ?? [])];
  const fxDivisor =
    report.currency !== 'USD' &&
    report.assumptions.fxRateToUSD &&
    report.assumptions.fxRateToUSD > 0
      ? report.assumptions.fxRateToUSD
      : 1;

  const byProvider: Record<string, number> = {};
  let unavailableCount = 0;

  for (const node of design.nodes) {
    const entry = report.perNode[node.id];
    if (!entry) continue;
    const svc = getService(node.serviceId, customServices);
    const provider = svc?.provider ?? 'custom';
    byProvider[provider] = (byProvider[provider] ?? 0) + entry.subtotal;
    for (const line of entry.lines) {
      if (line.source === 'unavailable') {
        unavailableCount += 1;
      }
    }
  }

  let transferTotal = 0;
  for (const line of report.transfer) {
    if (line.amount !== null) {
      transferTotal += line.amount;
    } else if (line.source === 'unavailable') {
      unavailableCount += 1;
    }
  }

  const monthSeconds = report.assumptions.hoursPerMonth * 3600;
  const runDurS = Math.max(1, simResult?.durationS ?? 60);
  const monthlyRequests =
    report.assumptions.traffic.mode === 'custom-monthly-requests'
      ? Math.max(0, report.assumptions.traffic.value ?? 0)
      : report.assumptions.traffic.mode === 'custom-avg-rps'
        ? Math.max(0, report.assumptions.traffic.value ?? 0) * monthSeconds
        : simResult
          ? (simResult.summary.totalRequests * monthSeconds) / runDurS
          : 0;

  return {
    byProvider,
    transferTotal,
    usdMonthlyTotal: report.monthlyTotal / fxDivisor,
    monthlyRequests,
    unavailableCount,
  };
}

/** Returns the top N individual cost drivers ranked descending by monthly spend. */
export function getTopCostDrivers(report: CostReport, design: Design, limit = 3): CostDriver[] {
  const nodesById = new Map(design.nodes.map((n) => [n.id, n]));
  const total = Math.max(0, report.monthlyTotal);
  const drivers: CostDriver[] = [];

  for (const [nodeId, entry] of Object.entries(report.perNode)) {
    const node = nodesById.get(nodeId);
    const label = node?.label ?? nodeId;
    for (const line of entry.lines) {
      if (line.amount !== null && line.amount > 0) {
        drivers.push({
          scope: 'node',
          nodeId,
          label,
          dimension: line.dimension,
          amount: line.amount,
          percentOfTotal: total > 0 ? (line.amount / total) * 100 : 0,
          unit: line.unit,
          quantity: line.quantity,
          source: line.source,
        });
      }
    }
  }

  for (const line of report.transfer) {
    if (line.amount !== null && line.amount > 0) {
      drivers.push({
        scope: 'transfer',
        label: line.dimension,
        dimension: line.dimension,
        amount: line.amount,
        percentOfTotal: total > 0 ? (line.amount / total) * 100 : 0,
        unit: line.unit,
        quantity: line.quantity,
        source: line.source,
      });
    }
  }

  drivers.sort((a, b) => b.amount - a.amount);
  return drivers.slice(0, Math.max(0, limit));
}

const HOUR_DIMENSIONS = new Set([
  'compute hours',
  'vCPU hours',
  'memory GB-hours',
  'monthly base',
  'ACU hours',
  'shard hours',
  'throughput RU/s-hours',
]);

/** Instantly approximates updated monthly cost when adjusting RPS or instance counts without re-simulating. */
export function estimateWhatIfCost(
  baseReport: CostReport,
  design: Design,
  simResult: SimulationResult | null,
  params: WhatIfCostParams,
): WhatIfCostResult {
  const runDurS = Math.max(1, simResult?.durationS ?? 60);
  const baseAvgRps = simResult && runDurS > 0 ? simResult.summary.totalRequests / runDurS : 0;

  let rpsFactor = params.rpsMultiplier ?? 1;
  if (params.targetAvgRps !== undefined && baseAvgRps > 0) {
    rpsFactor = Math.max(0, params.targetAvgRps / baseAvgRps);
  } else if (params.targetAvgRps !== undefined && baseAvgRps === 0) {
    rpsFactor = params.targetAvgRps > 0 ? 1 : 0;
  }
  rpsFactor = Math.max(0, rpsFactor);

  const byNode: Record<string, number> = {};
  let monthlyTotal = 0;

  for (const node of design.nodes) {
    const entry = baseReport.perNode[node.id];
    if (!entry) {
      byNode[node.id] = 0;
      continue;
    }

    const baseInstances = Math.max(1, node.config.instances);
    const targetInstances = params.instanceOverrides?.[node.id];
    const instanceRatio =
      targetInstances !== undefined ? Math.max(0, targetInstances) / baseInstances : 1;

    let nodeSum = 0;
    for (const line of entry.lines) {
      if (line.amount === null) continue;
      if (HOUR_DIMENSIONS.has(line.dimension)) {
        nodeSum += line.amount * instanceRatio;
      } else if (line.dimension === 'storage') {
        nodeSum += line.amount;
      } else {
        nodeSum += line.amount * rpsFactor;
      }
    }
    byNode[node.id] = nodeSum;
    monthlyTotal += nodeSum;
  }

  let transferTotal = 0;
  for (const line of baseReport.transfer) {
    if (line.amount !== null) {
      transferTotal += line.amount * rpsFactor;
    }
  }
  monthlyTotal += transferTotal;

  const fxDiv =
    baseReport.currency !== 'USD' &&
    baseReport.assumptions.fxRateToUSD &&
    baseReport.assumptions.fxRateToUSD > 0
      ? baseReport.assumptions.fxRateToUSD
      : 1;

  return {
    monthlyTotal,
    usdMonthlyTotal: monthlyTotal / fxDiv,
    currency: baseReport.currency,
    byNode,
    transferTotal,
    rpsFactor,
    estimateOnly: true,
    note: 'Estimate until re-run',
  };
}
