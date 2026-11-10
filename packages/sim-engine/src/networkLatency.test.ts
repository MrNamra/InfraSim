import { describe, expect, it } from 'vitest';
import {
  createEmptyDesign,
  type EdgeInstance,
  type GroupInstance,
  type NodeInstance,
} from '@infrasim/shared-types';
import { createRng } from './prng.js';
import {
  getRegionContinent,
  inferEdgePlacement,
  resolveNodePlacement,
  sampleEdgeTransportLatency,
} from './networkLatency.js';
import { runSimulation } from './engine.js';

function makeNode(
  id: string,
  serviceId: string,
  overrides: Partial<NodeInstance> = {},
): NodeInstance {
  return {
    id,
    serviceId,
    label: id,
    position: { x: 0, y: 0 },
    config: { instances: 1, operations: {} },
    ...overrides,
  };
}

function makeEdge(from: string, to: string, overrides: Partial<EdgeInstance> = {}): EdgeInstance {
  return {
    id: `${from}->${to}`,
    from,
    to,
    protocol: 'https',
    callType: 'sync',
    weight: 1,
    ...overrides,
  };
}

describe('@infrasim/sim-engine T2.5 placement latency matrix and group inheritance', () => {
  it('maps AWS, GCP, Azure, and OCI regions to accurate continents', () => {
    expect(getRegionContinent('us-east-1')).toBe('NA');
    expect(getRegionContinent('europe-west3')).toBe('EU');
    expect(getRegionContinent('germanywestcentral')).toBe('EU');
    expect(getRegionContinent('centralindia')).toBe('AS');
    expect(getRegionContinent('ap-mumbai-1')).toBe('AS');
    expect(getRegionContinent('australia-southeast1')).toBe('OC');
    expect(getRegionContinent('ap-sydney-1')).toBe('OC');
    expect(getRegionContinent('sa-east-1')).toBe('SA');
  });

  it('produces exact spec 06 §7 default latency bounds and flags across all 8 placement tiers', () => {
    const clusterGroups = new Map<string, GroupInstance>([
      ['pod', { id: 'pod', kind: 'cluster', label: 'api-pod' }],
    ]);

    const cases: Array<{
      name: string;
      edge: EdgeInstance;
      src: NodeInstance;
      tgt: NodeInstance;
      groups?: Map<string, GroupInstance>;
      locality: string;
      p50: number;
      p95: number;
      crossAz: boolean;
      crossRegion: boolean;
    }> = [
      {
        name: 'same-host cluster pods',
        edge: makeEdge('a', 'b'),
        src: makeNode('a', 'aws.ec2', { parentGroupId: 'pod' }),
        tgt: makeNode('b', 'aws.ec2', { parentGroupId: 'pod' }),
        groups: clusterGroups,
        locality: 'same-host',
        p50: 0.1,
        p95: 0.3,
        crossAz: false,
        crossRegion: false,
      },
      {
        name: 'same-az default cloud nodes',
        edge: makeEdge('a', 'b'),
        src: makeNode('a', 'aws.ec2', { region: 'us-east-1', az: 'us-east-1a' }),
        tgt: makeNode('b', 'aws.rds_postgres', { region: 'us-east-1', az: 'us-east-1a' }),
        locality: 'same-az',
        p50: 0.4,
        p95: 1.2,
        crossAz: false,
        crossRegion: false,
      },
      {
        name: 'cross-az same region',
        edge: makeEdge('a', 'b'),
        src: makeNode('a', 'aws.ec2', { region: 'us-east-1', az: 'us-east-1a' }),
        tgt: makeNode('b', 'aws.rds_postgres', { region: 'us-east-1', az: 'us-east-1b' }),
        locality: 'cross-az',
        p50: 1.2,
        p95: 3.0,
        crossAz: true,
        crossRegion: false,
      },
      {
        name: 'cross-region same continent',
        edge: makeEdge('a', 'b'),
        src: makeNode('a', 'aws.ec2', { region: 'us-east-1' }),
        tgt: makeNode('b', 'gcp.cloud_sql_postgres', { region: 'us-west1' }),
        locality: 'cross-region-same-continent',
        p50: 30,
        p95: 80,
        crossAz: false,
        crossRegion: true,
      },
      {
        name: 'cross-region intercontinental',
        edge: makeEdge('a', 'b'),
        src: makeNode('a', 'aws.ec2', { region: 'us-east-1' }),
        tgt: makeNode('b', 'aws.rds_postgres', { region: 'ap-south-1' }),
        locality: 'cross-region-intercontinental',
        p50: 120,
        p95: 250,
        crossAz: false,
        crossRegion: true,
      },
      {
        name: 'client to CDN POP',
        edge: makeEdge('c', 'cdn'),
        src: makeNode('c', 'generic.client', { region: 'us-east-1' }),
        tgt: makeNode('cdn', 'aws.cloudfront', { region: 'eu-central-1' }),
        locality: 'client-to-cdn',
        p50: 20,
        p95: 80,
        crossAz: false,
        crossRegion: false,
      },
      {
        name: 'client to origin same continent',
        edge: makeEdge('c', 'alb'),
        src: makeNode('c', 'generic.client', { region: 'us-east-1' }),
        tgt: makeNode('alb', 'aws.alb', { region: 'us-west-2' }),
        locality: 'client-to-origin-same-continent',
        p50: 50,
        p95: 150,
        crossAz: false,
        crossRegion: false,
      },
      {
        name: 'client to origin intercontinental',
        edge: makeEdge('c', 'alb'),
        src: makeNode('c', 'generic.client', { region: 'us-east-1' }),
        tgt: makeNode('alb', 'aws.alb', { region: 'ap-south-1' }),
        locality: 'client-to-origin-intercontinental',
        p50: 150,
        p95: 350,
        crossAz: false,
        crossRegion: false,
      },
    ];

    for (const c of cases) {
      const inferred = inferEdgePlacement(c.edge, c.src, c.tgt, { groupsById: c.groups });
      expect(inferred.locality, c.name).toBe(c.locality);
      expect(inferred.model.p50, c.name).toBe(c.p50);
      expect(inferred.model.p95, c.name).toBe(c.p95);
      expect(inferred.crossAz, c.name).toBe(c.crossAz);
      expect(inferred.crossRegion, c.name).toBe(c.crossRegion);
    }
  });

  it('adds PrivateLink (+0.3/+0.8 ms) and VPN (+10/+30 ms) tunnel penalties', () => {
    const a = makeNode('a', 'aws.ec2', { region: 'us-east-1', az: 'us-east-1a' });
    const b = makeNode('b', 'aws.s3', { region: 'us-east-1', az: 'us-east-1a' });

    const pl = inferEdgePlacement(makeEdge('a', 'b', { tunnel: 'privatelink' }), a, b);
    expect(pl.model.p50).toBeCloseTo(0.7, 5);
    expect(pl.model.p95).toBeCloseTo(2.0, 5);
    expect(pl.viaPrivateLink).toBe(true);

    const vpn = inferEdgePlacement(makeEdge('a', 'b', { tunnel: 'vpn' }), a, b);
    expect(vpn.model.p50).toBeCloseTo(10.4, 5);
    expect(vpn.model.p95).toBeCloseTo(31.2, 5);
    expect(vpn.viaVpn).toBe(true);
  });

  it('resolves GroupInstance inheritance chains, prefers explicit node placement, and guards cycles', () => {
    const groups: GroupInstance[] = [
      { id: 'reg-eu', kind: 'region', label: 'Frankfurt', region: 'eu-central-1' },
      { id: 'vpc-1', kind: 'vpc', label: 'prod-vpc', parentGroupId: 'reg-eu' },
      { id: 'az-a', kind: 'az', label: 'eu-central-1a', parentGroupId: 'vpc-1' },
      { id: 'az-b', kind: 'az', label: 'eu-central-1b', parentGroupId: 'vpc-1' },
      { id: 'sub-a', kind: 'subnet', label: 'app-a', parentGroupId: 'az-a' },
      { id: 'sub-b', kind: 'subnet', label: 'db-b', parentGroupId: 'az-b' },
      // Cycle guard check
      { id: 'cyc-1', kind: 'custom', label: 'cyc-1', parentGroupId: 'cyc-2' },
      { id: 'cyc-2', kind: 'custom', label: 'cyc-2', parentGroupId: 'cyc-1' },
    ];
    const groupsById = new Map(groups.map((g) => [g.id, g]));

    const app = makeNode('app', 'aws.ec2', { parentGroupId: 'sub-a' });
    const db = makeNode('db', 'aws.rds_postgres', { parentGroupId: 'sub-b' });
    const overrideNode = makeNode('ext', 'aws.ec2', {
      parentGroupId: 'sub-a',
      region: 'us-east-1',
    });
    const cycNode = makeNode('cyc', 'aws.ec2', { parentGroupId: 'cyc-1' });

    expect(resolveNodePlacement(app, groupsById)).toEqual({
      region: 'eu-central-1',
      az: 'eu-central-1a',
      ancestorGroupIds: ['sub-a', 'az-a', 'vpc-1', 'reg-eu'],
    });
    expect(resolveNodePlacement(overrideNode, groupsById).region).toBe('us-east-1');
    expect(resolveNodePlacement(cycNode, groupsById).ancestorGroupIds).toEqual(['cyc-1', 'cyc-2']);

    const edge = makeEdge('app', 'db');
    const inferred = inferEdgePlacement(edge, app, db, { groupsById });
    expect(inferred.locality).toBe('cross-az');
    expect(inferred.crossAz).toBe(true);
    expect(inferred.sourceRegion).toBe('eu-central-1');
  });

  it('computes 1 Gbps default serialization delay and scales with editable bandwidthGbps', () => {
    const src = makeNode('a', 'aws.ec2');
    const tgt = makeNode('b', 'aws.ec2');
    const edge1Gbps = makeEdge('a', 'b', {
      payloadBytes: 12_500_000, // 100 ms serialization at 1 Gbps (125,000 B/ms)
      networkLatency: { distribution: 'fixed', p50: 1, p95: 1 },
    });
    const edge10Gbps = makeEdge('a', 'b', {
      payloadBytes: 12_500_000, // 10 ms serialization at 10 Gbps
      bandwidthGbps: 10,
      networkLatency: { distribution: 'fixed', p50: 1, p95: 1 },
    });

    const sample1 = sampleEdgeTransportLatency(edge1Gbps, src, tgt, createRng(7));
    const sample10 = sampleEdgeTransportLatency(edge10Gbps, src, tgt, createRng(7));

    expect(sample1.latencyMs).toBeCloseTo(101, 4);
    expect(sample10.latencyMs).toBeCloseTo(11, 4);
  });

  it('propagates group inheritance into sim-engine cost flags and AZ outage chaos events', async () => {
    const d = createEmptyDesign('net-inherit', 'Network Inheritance Sim');
    d.settings.seed = 42;
    d.groups = [
      { id: 'r-us', kind: 'region', label: 'N. Virginia', region: 'us-east-1' },
      { id: 'az-a', kind: 'az', label: 'us-east-1a', parentGroupId: 'r-us' },
      { id: 'az-b', kind: 'az', label: 'us-east-1b', parentGroupId: 'r-us' },
    ];
    d.nodes = [
      makeNode('client', 'generic.client', {
        config: { instances: 1, operations: {} },
      }),
      makeNode('appA', 'generic.app', {
        parentGroupId: 'az-a',
        config: {
          instances: 1,
          vcpu: 4,
          latency: { distribution: 'fixed', p50: 2, p95: 2 },
          operations: {},
        },
      }),
      makeNode('dbB', 'generic.db', {
        parentGroupId: 'az-b',
        config: {
          instances: 1,
          latency: { distribution: 'fixed', p50: 2, p95: 2 },
          operations: {},
        },
      }),
    ];
    d.edges = [
      makeEdge('client', 'appA'),
      makeEdge('appA', 'dbB', { tunnel: 'privatelink', protocol: 'sql' }),
    ];
    d.scenarios = [
      {
        id: 's1',
        name: 'AZ inheritance & outage',
        durationS: 10,
        entryNodeId: 'client',
        profile: { kind: 'constant', rps: 20 },
        flows: [{ id: 'f1', name: 'Read', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
        chaos: [{ atS: 4, durationS: 3, kind: 'az-outage', az: 'us-east-1b' }],
      },
    ];

    const res = await runSimulation({ design: d, scenarioId: 's1' }, () => {});

    expect(res.counters.perEdge['appA->dbB']?.crossAz).toBe(true);
    expect(res.counters.perEdge['appA->dbB']?.crossRegion).toBe(false);
    expect(res.counters.perEdge['appA->dbB']?.viaPrivateLink).toBe(true);
    expect(res.counters.perEdge['client->appA']?.crossRegion).toBe(false);

    // During t=4..6s, dbB (inheriting az us-east-1b from parentGroupId) goes down -> 0 active instances & errors spike
    const outageBuckets = res.series.buckets.slice(4, 7);
    expect(outageBuckets.every((b) => b.perNode.dbB?.instancesActive === 0)).toBe(true);
    expect(outageBuckets.every((b) => b.errorRate > 0.5)).toBe(true);
  });
});
