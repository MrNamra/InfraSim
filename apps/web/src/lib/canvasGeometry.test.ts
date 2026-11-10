import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import type { GroupInstance } from '@infrasim/shared-types';
import {
  findDeepestContainingGroup,
  flowToWorldPosition,
  inferEdgeDefaults,
  nextNodeLabel,
  resolveInheritedPlacement,
  snapPoint,
  sortGroupsParentsFirst,
  worldToFlowPosition,
} from './canvasGeometry';

describe('canvasGeometry helpers', () => {
  it('snaps coordinates onto the 16px grid', () => {
    expect(snapPoint({ x: 17, y: 31 })).toEqual({ x: 16, y: 32 });
    expect(snapPoint({ x: -9, y: 7 })).toEqual({ x: -16, y: 0 });
  });

  it('resolves deepest nested group and parent-first sort order', () => {
    const groups: GroupInstance[] = [
      {
        id: 'subnet-1',
        kind: 'subnet',
        label: 'Private Subnet',
        parentGroupId: 'vpc-1',
        public: false,
        position: { x: 120, y: 120 },
        size: { width: 200, height: 180 },
      },
      {
        id: 'vpc-1',
        kind: 'vpc',
        label: 'Main VPC',
        parentGroupId: 'reg-1',
        position: { x: 60, y: 60 },
        size: { width: 480, height: 340 },
      },
      {
        id: 'reg-1',
        kind: 'region',
        label: 'us-east-1',
        region: 'us-east-1',
        position: { x: 20, y: 20 },
        size: { width: 640, height: 460 },
      },
    ];

    const sorted = sortGroupsParentsFirst(groups);
    expect(sorted.map((g) => g.id)).toEqual(['reg-1', 'vpc-1', 'subnet-1']);

    const insideSubnet = findDeepestContainingGroup({ x: 160, y: 160 }, groups);
    expect(insideSubnet?.id).toBe('subnet-1');

    const insideVpcOnly = findDeepestContainingGroup({ x: 400, y: 160 }, groups);
    expect(insideVpcOnly?.id).toBe('vpc-1');

    const outsideAll = findDeepestContainingGroup({ x: 900, y: 900 }, groups);
    expect(outsideAll).toBeUndefined();

    const groupsById = new Map(groups.map((g) => [g.id, g]));
    expect(resolveInheritedPlacement('subnet-1', groupsById)).toEqual({ region: 'us-east-1' });

    const rel = worldToFlowPosition({ x: 160, y: 180 }, insideSubnet);
    expect(rel).toEqual({ x: 40, y: 60 });
    expect(flowToWorldPosition(rel, insideSubnet)).toEqual({ x: 160, y: 180 });
  });

  it('infers edge defaults from target catalog service kind & ports', () => {
    const ec2 = getService('aws.ec2');
    const rds = getService('aws.rds_postgres');
    const sqs = getService('aws.sqs');
    const redis = getService('aws.elasticache_redis');

    expect(inferEdgeDefaults(ec2, rds)).toEqual({
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
    });
    expect(inferEdgeDefaults(ec2, sqs)).toEqual({
      protocol: 'https',
      port: 443,
      callType: 'async',
    });
    expect(inferEdgeDefaults(ec2, redis)).toEqual({
      protocol: 'redis',
      port: 6379,
      callType: 'sync',
    });
  });

  it('generates clean sequential labels without collisions', () => {
    expect(nextNodeLabel('RDS PostgreSQL (simple query)', [])).toBe('RDS PostgreSQL');
    expect(
      nextNodeLabel('EC2 instance (runs your code)', [
        {
          id: 'n1',
          serviceId: 'aws.ec2',
          label: 'EC2 instance',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
      ]),
    ).toBe('EC2 instance 2');
  });
});
