import { beforeEach, describe, expect, it } from 'vitest';
import { validateDesign } from '@infrasim/shared-types';
import { MAX_HISTORY_STEPS, createStarterEmptyDesign, useDesignStore } from './designStore';

describe('useDesignStore', () => {
  beforeEach(() => {
    useDesignStore.getState().loadDesign(createStarterEmptyDesign('test-design', 'Test'), true);
  });

  it('adds service nodes, snaps to 16px, connects edges cleanly, and passes schema validation', () => {
    const store = useDesignStore.getState();
    const clientId = store.addServiceNode('generic.client', { x: 15, y: 17 });
    const albId = store.addServiceNode('aws.alb', { x: 240, y: 17 });
    expect(clientId).toBeTruthy();
    expect(albId).toBeTruthy();

    const edgeId = store.connectEdge(clientId!, albId!);
    expect(edgeId).toBeTruthy();

    const { design } = useDesignStore.getState();
    expect(design.nodes[0]?.position).toEqual({ x: 16, y: 16 });
    expect(design.edges[0]?.protocol).toBe('https');
    expect(design.edges[0]?.port).toBe(443);
    expect(design.scenarios[0]?.entryNodeId).toBe(clientId);

    const validation = validateDesign(design);
    expect(validation.valid).toBe(true);
  });

  it('supports >= 100 undo/redo steps without corruption', () => {
    const store = useDesignStore.getState();
    const nodeId = store.addServiceNode('aws.ec2', { x: 64, y: 64 })!;

    for (let i = 1; i <= 115; i++) {
      useDesignStore.getState().updateNodeLabel(nodeId, `EC2-${i}`);
    }
    expect(useDesignStore.getState().design.nodes[0]?.label).toBe('EC2-115');
    expect(useDesignStore.getState().past.length).toBeLessThanOrEqual(MAX_HISTORY_STEPS);

    // Undo 105 steps
    for (let i = 0; i < 105; i++) {
      useDesignStore.getState().undo();
    }
    expect(useDesignStore.getState().design.nodes[0]?.label).toBe('EC2-10');

    // Redo 10 steps
    for (let i = 0; i < 10; i++) {
      useDesignStore.getState().redo();
    }
    expect(useDesignStore.getState().design.nodes[0]?.label).toBe('EC2-20');
  });

  it('updates parentGroupId when moving nodes in/out of groups and cascades deletions', () => {
    const store = useDesignStore.getState();
    const groupId = store.addGroup('subnet', { x: 64, y: 64 }, 'Subnet A');
    const nodeId = store.addServiceNode('aws.rds_postgres', { x: 128, y: 128 })!;
    expect(useDesignStore.getState().design.nodes[0]?.parentGroupId).toBe(groupId);

    useDesignStore.getState().moveNodeWorldPosition(nodeId, { x: 800, y: 800 });
    expect(useDesignStore.getState().design.nodes[0]?.parentGroupId).toBeUndefined();

    useDesignStore.getState().duplicateSelection();
    expect(useDesignStore.getState().design.nodes).toHaveLength(2);

    const [n1, n2] = useDesignStore.getState().design.nodes;
    useDesignStore.getState().connectEdge(n1!.id, n2!.id);
    expect(useDesignStore.getState().design.edges).toHaveLength(1);

    useDesignStore.getState().deleteElements({ nodeIds: [n1!.id] });
    expect(useDesignStore.getState().design.nodes).toHaveLength(1);
    expect(useDesignStore.getState().design.edges).toHaveLength(0);
  });

  it('applyPatchedDesign pushes undoable history while keeping selectedNodeId intact', () => {
    const store = useDesignStore.getState();
    const apiId = store.addServiceNode('aws.ec2', { x: 160, y: 128 })!;
    store.selectNode(apiId);

    const patched = structuredClone(useDesignStore.getState().design);
    patched.nodes[0]!.config.instances = 4;

    useDesignStore.getState().applyPatchedDesign(patched);
    expect(useDesignStore.getState().design.nodes[0]?.config.instances).toBe(4);
    expect(useDesignStore.getState().selectedNodeId).toBe(apiId);

    useDesignStore.getState().undo();
    expect(useDesignStore.getState().design.nodes[0]?.config.instances).toBe(1);
  });
});
