import type {
  EdgeInstance,
  GroupInstance,
  NodeInstance,
  ServiceDefinition,
} from '@infrasim/shared-types';

export const GRID_SIZE = 16;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_GROUP_SIZE: Record<GroupInstance['kind'], { width: number; height: number }> =
  {
    region: { width: 640, height: 448 },
    compartment: { width: 576, height: 416 },
    vpc: { width: 512, height: 352 },
    az: { width: 256, height: 320 },
    subnet: { width: 256, height: 224 },
    cluster: { width: 288, height: 224 },
    zone: { width: 256, height: 256 },
    custom: { width: 320, height: 240 },
  };

/** Snaps a coordinate scalar onto the nearest grid step (default 16px). */
export function snapValue(value: number, gridSize = GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}

/** Snaps a 2D point onto the nearest grid step (default 16px). */
export function snapPoint(
  point: { x: number; y: number },
  gridSize = GRID_SIZE,
): { x: number; y: number } {
  return {
    x: snapValue(point.x, gridSize),
    y: snapValue(point.y, gridSize),
  };
}

/** Returns world-space bounds for a GroupInstance. */
export function getGroupRect(group: GroupInstance): Rect {
  const fallback = DEFAULT_GROUP_SIZE[group.kind];
  return {
    x: group.position?.x ?? 0,
    y: group.position?.y ?? 0,
    width: group.size?.width ?? fallback.width,
    height: group.size?.height ?? fallback.height,
  };
}

/** Computes world coordinates for a group by walking parent groups if stored relative, or returning stored position. */
export function getGroupWorldPosition(
  group: GroupInstance,
  _groupsById: ReadonlyMap<string, GroupInstance>,
): { x: number; y: number } {
  return {
    x: group.position?.x ?? 0,
    y: group.position?.y ?? 0,
  };
}

/** Finds the smallest-area containing GroupInstance whose world bounds enclose the given point. */
export function findDeepestContainingGroup(
  worldPoint: { x: number; y: number },
  groups: readonly GroupInstance[],
  excludeGroupIds: ReadonlySet<string> = new Set(),
): GroupInstance | undefined {
  let best: GroupInstance | undefined;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const group of groups) {
    if (excludeGroupIds.has(group.id)) {
      continue;
    }
    const rect = getGroupRect(group);
    const inside =
      worldPoint.x >= rect.x &&
      worldPoint.x <= rect.x + rect.width &&
      worldPoint.y >= rect.y &&
      worldPoint.y <= rect.y + rect.height;
    if (inside) {
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = group;
        bestArea = area;
      }
    }
  }
  return best;
}

/** Collects an ancestor-safe topologically sorted order of groups (parents before children). */
export function sortGroupsParentsFirst(groups: readonly GroupInstance[]): GroupInstance[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const depthCache = new Map<string, number>();

  const computeDepth = (group: GroupInstance, visiting = new Set<string>()): number => {
    const cached = depthCache.get(group.id);
    if (cached !== undefined) {
      return cached;
    }
    if (!group.parentGroupId || !byId.has(group.parentGroupId) || visiting.has(group.id)) {
      depthCache.set(group.id, 0);
      return 0;
    }
    visiting.add(group.id);
    const parentDepth = computeDepth(byId.get(group.parentGroupId)!, visiting);
    const depth = parentDepth + 1;
    depthCache.set(group.id, depth);
    return depth;
  };

  return [...groups].sort((a, b) => computeDepth(a) - computeDepth(b));
}

/** Converts world-space coordinates to React Flow position relative to an optional parent group. */
export function worldToFlowPosition(
  worldPos: { x: number; y: number },
  parentGroup: GroupInstance | undefined,
): { x: number; y: number } {
  if (!parentGroup) {
    return { x: worldPos.x, y: worldPos.y };
  }
  const parentRect = getGroupRect(parentGroup);
  return {
    x: worldPos.x - parentRect.x,
    y: worldPos.y - parentRect.y,
  };
}

/** Converts React Flow position back to canonical world-space coordinates. */
export function flowToWorldPosition(
  flowPos: { x: number; y: number },
  parentGroup: GroupInstance | undefined,
): { x: number; y: number } {
  if (!parentGroup) {
    return { x: flowPos.x, y: flowPos.y };
  }
  const parentRect = getGroupRect(parentGroup);
  return {
    x: flowPos.x + parentRect.x,
    y: flowPos.y + parentRect.y,
  };
}

/** Resolves effective region and AZ tags by walking parent group ancestry. */
export function resolveInheritedPlacement(
  parentGroupId: string | undefined,
  groupsById: ReadonlyMap<string, GroupInstance>,
): { region?: string; az?: string } {
  let region: string | undefined;
  let az: string | undefined;
  let cursor = parentGroupId ? groupsById.get(parentGroupId) : undefined;
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (!az && (cursor.kind === 'az' || cursor.kind === 'zone')) {
      az = cursor.label;
    }
    if (!region && (cursor.region || cursor.kind === 'region')) {
      region = cursor.region ?? cursor.label;
    }
    cursor = cursor.parentGroupId ? groupsById.get(cursor.parentGroupId) : undefined;
  }

  return {
    ...(region ? { region } : {}),
    ...(az ? { az } : {}),
  };
}

/** Infers protocol, port, and sync/async callType for a new edge from target service metadata. */
export function inferEdgeDefaults(
  _sourceService: ServiceDefinition | undefined,
  targetService: ServiceDefinition | undefined,
): Pick<EdgeInstance, 'protocol' | 'port' | 'callType'> {
  const targetKind = targetService?.kind;
  const isAsync =
    targetKind === 'queue' ||
    targetKind === 'topic' ||
    targetKind === 'stream' ||
    targetKind === 'bus' ||
    targetKind === 'async';

  const firstPort = targetService?.ports?.[0];
  const validProtocols: ReadonlySet<EdgeInstance['protocol']> = new Set([
    'http',
    'https',
    'grpc',
    'tcp',
    'udp',
    'amqp',
    'kafka',
    'sql',
    'redis',
    'dns',
    'internal',
  ]);
  const inferredProtocol: EdgeInstance['protocol'] =
    firstPort && validProtocols.has(firstPort.protocol as EdgeInstance['protocol'])
      ? (firstPort.protocol as EdgeInstance['protocol'])
      : targetKind === 'sql'
        ? 'sql'
        : targetKind === 'cache'
          ? 'redis'
          : targetKind === 'dns'
            ? 'dns'
            : 'https';

  const inferredPort =
    firstPort?.port ??
    (inferredProtocol === 'http'
      ? 80
      : inferredProtocol === 'sql'
        ? 5432
        : inferredProtocol === 'redis'
          ? 6379
          : inferredProtocol === 'dns'
            ? 53
            : 443);

  return {
    protocol: inferredProtocol,
    port: inferredPort,
    callType: isAsync ? 'async' : 'sync',
  };
}

/** Generates a concise non-colliding label when placing additional instances of the same service. */
export function nextNodeLabel(baseName: string, existingNodes: readonly NodeInstance[]): string {
  const cleanBase = baseName.replace(/\s*\([^)]*\)\s*$/g, '').trim() || baseName;
  const used = new Set(existingNodes.map((n) => n.label));
  if (!used.has(cleanBase)) {
    return cleanBase;
  }
  let idx = 2;
  while (used.has(`${cleanBase} ${idx}`)) {
    idx++;
  }
  return `${cleanBase} ${idx}`;
}
