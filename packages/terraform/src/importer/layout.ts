import type { Design, GroupInstance, NodeInstance } from '@infrasim/shared-types';
import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import ELKBundled from 'elkjs/lib/elk.bundled.js';

const GRID_STEP = 16;
const SERVICE_NODE_WIDTH = 216;
const SERVICE_NODE_HEIGHT = 84;
const GROUP_MIN_WIDTH = 256;
const GROUP_MIN_HEIGHT = 176;

function snapGrid(value: number): number {
  return Math.round(value / GRID_STEP) * GRID_STEP;
}

function createElkInstance(): ELK {
  const ctorCandidate = ELKBundled as unknown as { default?: new () => ELK } | (new () => ELK);
  if (typeof ctorCandidate === 'function') {
    return new ctorCandidate();
  }
  if (ctorCandidate && typeof ctorCandidate.default === 'function') {
    return new ctorCandidate.default();
  }
  throw new Error('Unable to initialize ELK layout engine.');
}

/**
 * Runs deterministic hierarchical layered auto-layout via `elkjs` and returns a new Design
 * with world coordinates & group sizes updated and snapped to the 16 px canvas grid.
 */
export async function layoutDesignWithElk(design: Design): Promise<Design> {
  const groupsSorted = [...design.groups].sort((a, b) => a.id.localeCompare(b.id));
  const nodesSorted = [...design.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edgesSorted = [...design.edges].sort((a, b) => a.id.localeCompare(b.id));

  if (groupsSorted.length === 0 && nodesSorted.length === 0) {
    return design;
  }

  const groupIds = new Set(groupsSorted.map((g) => g.id));
  const nodeIds = new Set(nodesSorted.map((n) => n.id));

  const childGroupsByParent = new Map<string, GroupInstance[]>();
  const childNodesByParent = new Map<string, NodeInstance[]>();

  for (const g of groupsSorted) {
    const key = g.parentGroupId && groupIds.has(g.parentGroupId) ? g.parentGroupId : '__root__';
    const list = childGroupsByParent.get(key) ?? [];
    list.push(g);
    childGroupsByParent.set(key, list);
  }
  for (const n of nodesSorted) {
    const key = n.parentGroupId && groupIds.has(n.parentGroupId) ? n.parentGroupId : '__root__';
    const list = childNodesByParent.get(key) ?? [];
    list.push(n);
    childNodesByParent.set(key, list);
  }

  const buildElkGroupNode = (group: GroupInstance): ElkNode => {
    const nestedGroups = (childGroupsByParent.get(group.id) ?? []).map(buildElkGroupNode);
    const nestedLeaves: ElkNode[] = (childNodesByParent.get(group.id) ?? []).map((n) => ({
      id: `node:${n.id}`,
      width: SERVICE_NODE_WIDTH,
      height: SERVICE_NODE_HEIGHT,
    }));
    const children = [...nestedGroups, ...nestedLeaves];
    return {
      id: `group:${group.id}`,
      ...(children.length > 0
        ? { children }
        : {
            width: Math.max(GROUP_MIN_WIDTH, group.size?.width ?? 320),
            height: Math.max(GROUP_MIN_HEIGHT, group.size?.height ?? 208),
          }),
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.padding': '[top=48,left=28,bottom=28,right=28]',
        'elk.spacing.nodeNode': '40',
        'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      },
    };
  };

  const rootChildren: ElkNode[] = [
    ...(childGroupsByParent.get('__root__') ?? []).map(buildElkGroupNode),
    ...(childNodesByParent.get('__root__') ?? []).map((n) => ({
      id: `node:${n.id}`,
      width: SERVICE_NODE_WIDTH,
      height: SERVICE_NODE_HEIGHT,
    })),
  ];

  const elkEdges: ElkExtendedEdge[] = edgesSorted
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({
      id: `edge:${e.id}`,
      sources: [`node:${e.from}`],
      targets: [`node:${e.to}`],
    }));

  const rootGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=48,left=48,bottom=48,right=48]',
      'elk.spacing.nodeNode': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': '88',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '64',
    },
    children: rootChildren,
    edges: elkEdges,
  };

  const elk = createElkInstance();
  const laidOut = await elk.layout(rootGraph);

  const worldGroupRects = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  const worldNodePositions = new Map<string, { x: number; y: number }>();

  const walkOutput = (elkNode: ElkNode, parentOffsetX: number, parentOffsetY: number) => {
    const absX = parentOffsetX + (elkNode.x ?? 0);
    const absY = parentOffsetY + (elkNode.y ?? 0);

    if (elkNode.id.startsWith('group:')) {
      const gid = elkNode.id.slice('group:'.length);
      worldGroupRects.set(gid, {
        x: snapGrid(absX),
        y: snapGrid(absY),
        width: Math.max(GROUP_MIN_WIDTH, snapGrid(elkNode.width ?? GROUP_MIN_WIDTH)),
        height: Math.max(GROUP_MIN_HEIGHT, snapGrid(elkNode.height ?? GROUP_MIN_HEIGHT)),
      });
    } else if (elkNode.id.startsWith('node:')) {
      const nid = elkNode.id.slice('node:'.length);
      worldNodePositions.set(nid, {
        x: snapGrid(absX),
        y: snapGrid(absY),
      });
    }

    for (const child of elkNode.children ?? []) {
      walkOutput(child, elkNode.id === 'root' ? 0 : absX, elkNode.id === 'root' ? 0 : absY);
    }
  };

  walkOutput(laidOut, 0, 0);

  return {
    ...design,
    groups: design.groups.map((g) => {
      const rect = worldGroupRects.get(g.id);
      if (!rect) return g;
      return {
        ...g,
        position: { x: rect.x, y: rect.y },
        size: { width: rect.width, height: rect.height },
      };
    }),
    nodes: design.nodes.map((n) => {
      const pos = worldNodePositions.get(n.id);
      if (!pos) return n;
      return {
        ...n,
        position: pos,
      };
    }),
  };
}
