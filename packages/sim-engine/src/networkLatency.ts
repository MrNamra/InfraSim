import type {
  EdgeInstance,
  GroupInstance,
  LatencyModel,
  MockKind,
  NodeInstance,
} from '@infrasim/shared-types';
import { sampleLatency } from './latency.js';
import type { SeededRng } from './prng.js';

/** Canonical placement locality tiers from spec 06 §7. */
export type EdgeLocality =
  | 'same-host'
  | 'same-az'
  | 'cross-az'
  | 'cross-region-same-continent'
  | 'cross-region-intercontinental'
  | 'client-to-cdn'
  | 'client-to-origin-same-continent'
  | 'client-to-origin-intercontinental';

/** Coarse continental bucket used to separate intra-continental from intercontinental links. */
export type ContinentCode = 'NA' | 'SA' | 'EU' | 'AS' | 'OC' | 'AF' | 'ME';

/** Default bandwidth (Gbps) used to compute serialization delay on edges when omitted. */
export const DEFAULT_EDGE_BANDWIDTH_GBPS = 1;

const CLIENT_SERVICE_IDS = new Set(['generic.client', 'generic.users']);
const CDN_SERVICE_IDS = new Set(['aws.cloudfront', 'gcp.cloud_cdn', 'azure.front_door']);

const REGION_TO_CONTINENT: Record<string, ContinentCode> = {
  // AWS
  'us-east-1': 'NA',
  'us-east-2': 'NA',
  'us-west-1': 'NA',
  'us-west-2': 'NA',
  'us-gov-east-1': 'NA',
  'us-gov-west-1': 'NA',
  'ca-central-1': 'NA',
  'ca-west-1': 'NA',
  'mx-central-1': 'NA',
  'sa-east-1': 'SA',
  'eu-west-1': 'EU',
  'eu-west-2': 'EU',
  'eu-west-3': 'EU',
  'eu-central-1': 'EU',
  'eu-central-2': 'EU',
  'eu-north-1': 'EU',
  'eu-south-1': 'EU',
  'eu-south-2': 'EU',
  'ap-south-1': 'AS',
  'ap-south-2': 'AS',
  'ap-southeast-1': 'AS',
  'ap-southeast-2': 'OC',
  'ap-southeast-3': 'AS',
  'ap-southeast-4': 'OC',
  'ap-southeast-5': 'AS',
  'ap-southeast-7': 'AS',
  'ap-northeast-1': 'AS',
  'ap-northeast-2': 'AS',
  'ap-northeast-3': 'AS',
  'ap-east-1': 'AS',
  'cn-north-1': 'AS',
  'cn-northwest-1': 'AS',
  'me-south-1': 'ME',
  'me-central-1': 'ME',
  'il-central-1': 'ME',
  'af-south-1': 'AF',
  // GCP
  'us-east1': 'NA',
  'us-east4': 'NA',
  'us-east5': 'NA',
  'us-central1': 'NA',
  'us-south1': 'NA',
  'us-west1': 'NA',
  'us-west2': 'NA',
  'us-west3': 'NA',
  'us-west4': 'NA',
  'northamerica-northeast1': 'NA',
  'northamerica-northeast2': 'NA',
  'southamerica-east1': 'SA',
  'southamerica-west1': 'SA',
  'europe-west1': 'EU',
  'europe-west2': 'EU',
  'europe-west3': 'EU',
  'europe-west4': 'EU',
  'europe-west6': 'EU',
  'europe-west8': 'EU',
  'europe-west9': 'EU',
  'europe-west10': 'EU',
  'europe-west12': 'EU',
  'europe-north1': 'EU',
  'europe-central2': 'EU',
  'europe-southwest1': 'EU',
  'asia-south1': 'AS',
  'asia-south2': 'AS',
  'asia-southeast1': 'AS',
  'asia-southeast2': 'AS',
  'asia-east1': 'AS',
  'asia-east2': 'AS',
  'asia-northeast1': 'AS',
  'asia-northeast2': 'AS',
  'asia-northeast3': 'AS',
  'australia-southeast1': 'OC',
  'australia-southeast2': 'OC',
  'me-west1': 'ME',
  'me-central1': 'ME',
  'me-central2': 'ME',
  'africa-south1': 'AF',
  // Azure
  eastus: 'NA',
  eastus2: 'NA',
  westus: 'NA',
  westus2: 'NA',
  westus3: 'NA',
  centralus: 'NA',
  northcentralus: 'NA',
  southcentralus: 'NA',
  westcentralus: 'NA',
  canadacentral: 'NA',
  canadaeast: 'NA',
  mexicocentral: 'NA',
  brazilsouth: 'SA',
  brazilsoutheast: 'SA',
  chilecentral: 'SA',
  uksouth: 'EU',
  ukwest: 'EU',
  northeurope: 'EU',
  westeurope: 'EU',
  francecentral: 'EU',
  francesouth: 'EU',
  germanywestcentral: 'EU',
  germanynorth: 'EU',
  switzerlandnorth: 'EU',
  switzerlandwest: 'EU',
  swedencentral: 'EU',
  norwayeast: 'EU',
  norwaywest: 'EU',
  polandcentral: 'EU',
  spaincentral: 'EU',
  italynorth: 'EU',
  austriaeast: 'EU',
  centralindia: 'AS',
  southindia: 'AS',
  westindia: 'AS',
  southeastasia: 'AS',
  eastasia: 'AS',
  japaneast: 'AS',
  japanwest: 'AS',
  koreacentral: 'AS',
  koreasouth: 'AS',
  indonesiacentral: 'AS',
  malaysiawest: 'AS',
  australiaeast: 'OC',
  australiasoutheast: 'OC',
  australiacentral: 'OC',
  newzealandnorth: 'OC',
  uaenorth: 'ME',
  uaecentral: 'ME',
  qatarcentral: 'ME',
  israelcentral: 'ME',
  southafricanorth: 'AF',
  southafricawest: 'AF',
  // OCI
  'us-ashburn-1': 'NA',
  'us-phoenix-1': 'NA',
  'us-sanjose-1': 'NA',
  'us-chicago-1': 'NA',
  'ca-toronto-1': 'NA',
  'ca-montreal-1': 'NA',
  'sa-saopaulo-1': 'SA',
  'sa-vinhedo-1': 'SA',
  'sa-santiago-1': 'SA',
  'sa-bogota-1': 'SA',
  'uk-london-1': 'EU',
  'uk-cardiff-1': 'EU',
  'eu-frankfurt-1': 'EU',
  'eu-zurich-1': 'EU',
  'eu-amsterdam-1': 'EU',
  'eu-paris-1': 'EU',
  'eu-marseille-1': 'EU',
  'eu-milan-1': 'EU',
  'eu-stockholm-1': 'EU',
  'eu-madrid-1': 'EU',
  'ap-mumbai-1': 'AS',
  'ap-hyderabad-1': 'AS',
  'ap-singapore-1': 'AS',
  'ap-singapore-2': 'AS',
  'ap-tokyo-1': 'AS',
  'ap-osaka-1': 'AS',
  'ap-seoul-1': 'AS',
  'ap-chuncheon-1': 'AS',
  'ap-sydney-1': 'OC',
  'ap-melbourne-1': 'OC',
  'me-dubai-1': 'ME',
  'me-abudhabi-1': 'ME',
  'me-jeddah-1': 'ME',
  'me-riyadh-1': 'ME',
  'il-jerusalem-1': 'ME',
  'af-johannesburg-1': 'AF',
};

const BASE_PLACEMENT_LATENCY: Record<EdgeLocality, { p50: number; p95: number }> = {
  'same-host': { p50: 0.1, p95: 0.3 },
  'same-az': { p50: 0.4, p95: 1.2 },
  'cross-az': { p50: 1.2, p95: 3.0 },
  'cross-region-same-continent': { p50: 30, p95: 80 },
  'cross-region-intercontinental': { p50: 120, p95: 250 },
  'client-to-cdn': { p50: 20, p95: 80 },
  'client-to-origin-same-continent': { p50: 50, p95: 150 },
  'client-to-origin-intercontinental': { p50: 150, p95: 350 },
};

const LOCALITY_LABELS: Record<EdgeLocality, string> = {
  'same-host': 'Same host / pod',
  'same-az': 'Same AZ',
  'cross-az': 'Cross-AZ (same region)',
  'cross-region-same-continent': 'Cross-region (same continent)',
  'cross-region-intercontinental': 'Cross-region (intercontinental)',
  'client-to-cdn': 'Client <-> edge CDN POP',
  'client-to-origin-same-continent': 'Client <-> origin (same continent)',
  'client-to-origin-intercontinental': 'Client <-> origin (intercontinental)',
};

/** Effective inherited placement resolved by walking node properties and GroupInstance parents. */
export interface ResolvedNodePlacement {
  region?: string;
  az?: string;
  hostGroupId?: string;
  ancestorGroupIds: string[];
}

/** Optional group/service metadata used to resolve edge placement and transport timing. */
export interface EdgePlacementContext {
  groupsById?: ReadonlyMap<string, GroupInstance>;
  sourceKind?: MockKind;
  targetKind?: MockKind;
  sourcePlacement?: ResolvedNodePlacement;
  targetPlacement?: ResolvedNodePlacement;
  resolvedPlacement?: InferredEdgePlacement;
}

/** Complete placement inference output for simulation routing, cost transfer flags, and EdgePopover UI. */
export interface InferredEdgePlacement {
  locality: EdgeLocality;
  label: string;
  model: LatencyModel;
  crossAz: boolean;
  crossRegion: boolean;
  viaPrivateLink: boolean;
  viaVpn: boolean;
  bandwidthGbps: number;
  sourceRegion?: string;
  targetRegion?: string;
  sourceAz?: string;
  targetAz?: string;
}

/** Maps a cloud region identifier across AWS, GCP, Azure, and OCI to its continent code. */
export function getRegionContinent(region?: string): ContinentCode | undefined {
  if (!region) {
    return undefined;
  }
  const key = region.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  const exact = REGION_TO_CONTINENT[key];
  if (exact) {
    return exact;
  }
  if (key.startsWith('australia') || key.startsWith('newzealand')) {
    return 'OC';
  }
  if (
    key.startsWith('us-') ||
    key.startsWith('ca-') ||
    key.startsWith('mx-') ||
    key.startsWith('northamerica-') ||
    key.endsWith('us') ||
    key.endsWith('us2') ||
    key.endsWith('us3') ||
    key.startsWith('canada') ||
    key.startsWith('mexico')
  ) {
    return 'NA';
  }
  if (
    key.startsWith('sa-') ||
    key.startsWith('southamerica-') ||
    key.startsWith('brazil') ||
    key.startsWith('chile')
  ) {
    return 'SA';
  }
  if (
    key.startsWith('eu-') ||
    key.startsWith('uk-') ||
    key.startsWith('europe-') ||
    key.startsWith('uk') ||
    key.endsWith('europe') ||
    key.startsWith('france') ||
    key.startsWith('germany') ||
    key.startsWith('switzerland') ||
    key.startsWith('sweden') ||
    key.startsWith('norway') ||
    key.startsWith('poland') ||
    key.startsWith('spain') ||
    key.startsWith('italy') ||
    key.startsWith('austria')
  ) {
    return 'EU';
  }
  if (
    key.startsWith('me-') ||
    key.startsWith('il-') ||
    key.startsWith('uae') ||
    key.startsWith('qatar') ||
    key.startsWith('israel')
  ) {
    return 'ME';
  }
  if (key.startsWith('af-') || key.startsWith('africa-') || key.startsWith('southafrica')) {
    return 'AF';
  }
  if (
    key.startsWith('ap-') ||
    key.startsWith('asia-') ||
    key.startsWith('cn-') ||
    key.endsWith('india') ||
    key.endsWith('asia') ||
    key.startsWith('japan') ||
    key.startsWith('korea') ||
    key.startsWith('indonesia') ||
    key.startsWith('malaysia')
  ) {
    return 'AS';
  }
  return undefined;
}

function isLikelyRegionLabel(label: string | undefined): string | undefined {
  if (!label) {
    return undefined;
  }
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (REGION_TO_CONTINENT[trimmed]) {
    return trimmed;
  }
  if (
    /^(us|ca|sa|eu|ap|af|me|il|uk|cn|northamerica|southamerica|europe|asia|australia)-[a-z0-9-]+$/.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return undefined;
}

/**
 * Resolves a node's effective region, AZ, and cluster host group by inheriting down the GroupInstance chain.
 * Explicit properties set on the node itself always take precedence over inherited group values.
 */
export function resolveNodePlacement(
  node: NodeInstance | undefined,
  groupsById?: ReadonlyMap<string, GroupInstance>,
): ResolvedNodePlacement {
  if (!node) {
    return { ancestorGroupIds: [] };
  }

  let region = node.region?.trim() || undefined;
  let az = node.az?.trim() || undefined;
  const importedHost =
    typeof node.importedAttrs?.sameHostGroup === 'string'
      ? node.importedAttrs.sameHostGroup.trim()
      : '';
  let hostGroupId: string | undefined = importedHost || undefined;

  const ancestorGroupIds: string[] = [];
  if (groupsById && node.parentGroupId) {
    const visited = new Set<string>();
    let curId: string | undefined = node.parentGroupId;
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      const grp = groupsById.get(curId);
      if (!grp) {
        break;
      }
      ancestorGroupIds.push(grp.id);
      if (!region) {
        if (grp.region?.trim()) {
          region = grp.region.trim();
        } else if (grp.kind === 'region') {
          region = isLikelyRegionLabel(grp.label);
        }
      }
      if (!az && (grp.kind === 'az' || grp.kind === 'zone')) {
        az = grp.label.trim() || grp.id;
      }
      if (!hostGroupId && grp.kind === 'cluster') {
        hostGroupId = grp.id;
      }
      curId = grp.parentGroupId;
    }
  }

  return {
    ...(region ? { region } : {}),
    ...(az ? { az } : {}),
    ...(hostGroupId ? { hostGroupId } : {}),
    ancestorGroupIds,
  };
}

function isClientNode(node: NodeInstance | undefined, kind?: MockKind): boolean {
  if (!node) return false;
  return CLIENT_SERVICE_IDS.has(node.serviceId) || kind === ('client' as MockKind);
}

function isCdnNode(node: NodeInstance | undefined, kind?: MockKind): boolean {
  if (!node) return false;
  return kind === 'cdn' || CDN_SERVICE_IDS.has(node.serviceId);
}

/**
 * Infers placement locality tier, default lognormal transport latency (plus optional PrivateLink/VPN extra),
 * cross-AZ/cross-region transfer billing flags, and effective link bandwidth for an edge.
 */
export function inferEdgePlacement(
  edge: EdgeInstance | undefined,
  source: NodeInstance | undefined,
  target: NodeInstance | undefined,
  context: EdgePlacementContext = {},
): InferredEdgePlacement {
  const srcPlacement = context.sourcePlacement ?? resolveNodePlacement(source, context.groupsById);
  const tgtPlacement = context.targetPlacement ?? resolveNodePlacement(target, context.groupsById);

  const srcRegion = srcPlacement.region;
  const tgtRegion = tgtPlacement.region;
  const srcAz = srcPlacement.az;
  const tgtAz = tgtPlacement.az;

  const srcIsClient = isClientNode(source, context.sourceKind);
  const tgtIsClient = isClientNode(target, context.targetKind);
  const srcIsCdn = isCdnNode(source, context.sourceKind);
  const tgtIsCdn = isCdnNode(target, context.targetKind);

  let locality: EdgeLocality;
  let crossAz = false;
  let crossRegion = false;

  if ((srcIsClient && tgtIsCdn) || (tgtIsClient && srcIsCdn)) {
    locality = 'client-to-cdn';
  } else if (srcIsClient || tgtIsClient) {
    const cSrc = getRegionContinent(srcRegion);
    const cTgt = getRegionContinent(tgtRegion);
    locality =
      cSrc && cTgt && cSrc !== cTgt
        ? 'client-to-origin-intercontinental'
        : 'client-to-origin-same-continent';
  } else if (srcRegion && tgtRegion && srcRegion !== tgtRegion) {
    const cSrc = getRegionContinent(srcRegion);
    const cTgt = getRegionContinent(tgtRegion);
    locality =
      cSrc && cTgt && cSrc !== cTgt
        ? 'cross-region-intercontinental'
        : 'cross-region-same-continent';
    crossRegion = true;
  } else if (srcAz && tgtAz && srcAz !== tgtAz) {
    locality = 'cross-az';
    crossAz = true;
  } else if (
    srcPlacement.hostGroupId &&
    tgtPlacement.hostGroupId &&
    srcPlacement.hostGroupId === tgtPlacement.hostGroupId
  ) {
    locality = 'same-host';
  } else {
    locality = 'same-az';
  }

  const base = BASE_PLACEMENT_LATENCY[locality];
  const tunnel = edge?.tunnel ?? 'none';
  const viaPrivateLink = tunnel === 'privatelink';
  const viaVpn = tunnel === 'vpn';

  const extraP50 = viaPrivateLink ? 0.3 : viaVpn ? 10 : 0;
  const extraP95 = viaPrivateLink ? 0.8 : viaVpn ? 30 : 0;

  const model: LatencyModel = {
    distribution: 'lognormal',
    p50: Number((base.p50 + extraP50).toFixed(2)),
    p95: Number((base.p95 + extraP95).toFixed(2)),
  };

  const bandwidthGbps =
    edge?.bandwidthGbps !== undefined &&
    Number.isFinite(edge.bandwidthGbps) &&
    edge.bandwidthGbps > 0
      ? edge.bandwidthGbps
      : DEFAULT_EDGE_BANDWIDTH_GBPS;

  return {
    locality,
    label: LOCALITY_LABELS[locality],
    model,
    crossAz,
    crossRegion,
    viaPrivateLink,
    viaVpn,
    bandwidthGbps,
    ...(srcRegion ? { sourceRegion: srcRegion } : {}),
    ...(tgtRegion ? { targetRegion: tgtRegion } : {}),
    ...(srcAz ? { sourceAz: srcAz } : {}),
    ...(tgtAz ? { targetAz: tgtAz } : {}),
  };
}

/** Determines geographic locality tier between source and target nodes. */
export function inferEdgeLocality(
  source: NodeInstance | undefined,
  target: NodeInstance | undefined,
  context: EdgePlacementContext = {},
): EdgeLocality {
  return inferEdgePlacement(undefined, source, target, context).locality;
}

/**
 * Samples one-way network transport latency for an edge based on user override or placement locality,
 * plus payload serialization delay from `edge.bandwidthGbps` (1 Gbps default = 125,000 bytes/ms).
 */
export function sampleEdgeTransportLatency(
  edge: EdgeInstance,
  source: NodeInstance | undefined,
  target: NodeInstance | undefined,
  rng: SeededRng,
  context: EdgePlacementContext = {},
): { latencyMs: number; locality: EdgeLocality } {
  const resolved = context.resolvedPlacement ?? inferEdgePlacement(edge, source, target, context);
  const model = edge.networkLatency ?? resolved.model;
  const baseMs = sampleLatency(model, rng);
  const payloadBytes = edge.payloadBytes ?? 1024;
  // 1 Gbps = 1e9 bits/s = 125e6 bytes/s = 125,000 bytes/ms
  const bytesPerMs = resolved.bandwidthGbps * 125_000;
  const serializationMs = bytesPerMs > 0 ? payloadBytes / bytesPerMs : 0;
  return { latencyMs: baseMs + serializationMs, locality: resolved.locality };
}
