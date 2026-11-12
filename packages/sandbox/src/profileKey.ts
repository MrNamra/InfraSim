import type {
  Design,
  EdgeInstance,
  NodeInstance,
  PayloadFixture,
  ScriptAsset,
  ServiceDefinition,
} from '@infrasim/shared-types';

/** Lightweight input used to compute a deterministic cache key for a handler CallPlan. */
export interface ProfileCacheKeyInput {
  script: Pick<
    ScriptAsset,
    'id' | 'source' | 'entry' | 'language' | 'timeoutMs' | 'memoryMb' | 'env'
  >;
  designScripts?: readonly Pick<ScriptAsset, 'id' | 'source' | 'entry' | 'language'>[];
  fixtures?: readonly Pick<
    PayloadFixture,
    'id' | 'name' | 'event' | 'context' | 'expectedStatus' | 'weight'
  >[];
  design?: Pick<Design, 'nodes' | 'edges' | 'customServices'>;
  node?: Pick<NodeInstance, 'id' | 'serviceId' | 'label' | 'region' | 'config'>;
  customServices?: readonly Pick<ServiceDefinition, 'id' | 'operations' | 'latency' | 'failure'>[];
  seed?: number;
  iterations?: number;
  cpuScale?: number;
  env?: Record<string, string>;
}

function stableJsonValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => stableJsonValue(item));
  }
  const obj = val as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined && typeof v !== 'function') {
      sorted[key] = stableJsonValue(v);
    }
  }
  return sorted;
}

function collectReachableMockScope(
  design: Pick<Design, 'nodes' | 'edges'>,
  startNodeId: string,
): {
  nodes: Pick<NodeInstance, 'id' | 'serviceId' | 'label' | 'region' | 'config'>[];
  edges: EdgeInstance[];
} {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, EdgeInstance[]>();
  for (const e of design.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e);
    adj.set(e.from, list);
  }
  const visited = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  const relNodes: Pick<NodeInstance, 'id' | 'serviceId' | 'label' | 'region' | 'config'>[] = [];
  const relEdges: EdgeInstance[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of adj.get(id) ?? []) {
      relEdges.push(edge);
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        const target = byId.get(edge.to);
        if (target) {
          relNodes.push(target);
        }
        queue.push(edge.to);
      }
    }
  }

  return {
    nodes: relNodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: relEdges.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function hashFnv1a32(str: string, seedInit: number): number {
  let h = seedInit >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Computes a pure-TypeScript deterministic cache key from script source, fixtures,
 * downstream mock configuration, and simulation seed. Ignores `cpuMsPerRequest` and UI layout.
 */
export function computeProfileCacheKey(input: ProfileCacheKeyInput): string {
  const scope =
    input.design && input.node
      ? collectReachableMockScope(input.design, input.node.id)
      : { nodes: input.design?.nodes ?? [], edges: input.design?.edges ?? [] };

  const stripNode = (
    n: Pick<NodeInstance, 'id' | 'serviceId' | 'label' | 'region' | 'config'>,
  ) => ({
    id: n.id,
    serviceId: n.serviceId,
    label: n.label,
    region: n.region,
    config: {
      latency: n.config.latency,
      errorRate: n.config.errorRate,
      rateLimit: n.config.rateLimit,
      operations: n.config.operations,
      mockEnv: n.config.mockEnv,
      httpAliases: n.config.httpAliases,
      ai: n.config.ai,
    },
  });

  const payload = {
    script: {
      id: input.script.id,
      source: input.script.source,
      entry: input.script.entry,
      language: input.script.language,
      timeoutMs: input.script.timeoutMs,
      memoryMb: input.script.memoryMb,
      env: input.script.env,
    },
    designScripts: [...(input.designScripts ?? [])]
      .filter((s) => s.id !== input.script.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({ id: s.id, source: s.source, entry: s.entry, language: s.language })),
    fixtures: [...(input.fixtures ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        event: f.event,
        context: f.context,
        weight: f.weight ?? 1,
        expectedStatus: f.expectedStatus,
      })),
    node: input.node ? stripNode(input.node) : null,
    reachableNodes: scope.nodes.map(stripNode),
    reachableEdges: scope.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      weight: e.weight,
      callType: e.callType,
      protocol: e.protocol,
      label: e.label,
    })),
    customServices: [...(input.customServices ?? []), ...(input.design?.customServices ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({
        id: s.id,
        latency: s.latency,
        failure: s.failure,
        operations: s.operations,
      })),
    env: input.env ?? {},
    seed: input.seed ?? 42,
    iterations: Math.max(1, Math.min(500, Math.round(input.iterations ?? 50))),
    cpuScale: input.cpuScale ?? 0.1,
  };

  const canonical = JSON.stringify(stableJsonValue(payload));
  const h1 = hashFnv1a32(canonical, 0x811c9dc5).toString(16).padStart(8, '0');
  const h2 = hashFnv1a32(canonical, 0x9e3779b9).toString(16).padStart(8, '0');
  return `pk-${h1}${h2}-v1`;
}
