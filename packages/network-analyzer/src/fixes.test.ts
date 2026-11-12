import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { checkReachability } from './analyzer.js';
import { applyNetworkPatch, formatPatchDiffLines } from './fixes.js';

function makeSgBlockedDesign(): Design {
  const d = createEmptyDesign('fix-sg', 'SG Fix Test');
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'DB',
      position: { x: 200, y: 0 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-1',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      { id: 'vpc-1', provider: 'aws', region: 'us-east-1', cidrs: ['10.0.0.0/16'], name: 'Main' },
    ],
    subnets: [{ id: 'sub-1', networkId: 'vpc-1', cidr: '10.0.1.0/24', routeTableId: 'rt-1' }],
    routeTables: [{ id: 'rt-1', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] }],
    gateways: [],
    firewalls: [
      {
        id: 'sg-api',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['api'] },
        rules: [
          {
            id: 'egr-all',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-db',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['db'] },
        rules: [],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      { nodeId: 'api', subnetId: 'sub-1', privateIp: '10.0.1.10', firewallIds: ['sg-api'] },
      { nodeId: 'db', subnetId: 'sub-1', privateIp: '10.0.1.20', firewallIds: ['sg-db'] },
    ],
  };
  return d;
}

describe('T4.5 least-privilege fix patches and diff preview', () => {
  it('generates SG-to-SG least-privilege patch (never 0.0.0.0/0), formats diff preview, and applies immutably', () => {
    const broken = makeSgBlockedDesign();
    const before = checkReachability(broken, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(before.reachable).toBe(false);
    expect(before.reasonCode).toBe('SG_NO_INGRESS');
    expect(before.fixes.length).toBeGreaterThan(0);

    const fix = before.fixes[0]!;
    const diff = formatPatchDiffLines(fix.patch);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff[0]!.kind).toBe('add');
    expect(diff[0]!.path).toContain('/network/firewalls/1/rules');
    expect(diff[0]!.summary).toContain('sg-api');
    expect(diff[0]!.summary).not.toContain('0.0.0.0/0');

    const snapshotBefore = JSON.stringify(broken);
    const patched = applyNetworkPatch(broken, fix.patch);
    expect(JSON.stringify(broken)).toBe(snapshotBefore);

    const after = checkReachability(patched, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(after.reachable).toBe(true);
    expect(after.failureMode).toBe('none');
  });

  it('formats add, replace, and remove operations cleanly in diff lines', () => {
    const lines = formatPatchDiffLines([
      { op: 'add', path: '/network/gateways/-', value: { id: 'nat-1', kind: 'nat' } },
      { op: 'replace', path: '/network/endpoints/0/privateDns', value: true },
      { op: 'remove', path: '/network/attachments/0/publicIp' },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['add', 'replace', 'remove']);
    expect(lines[0]!.summary.startsWith('+ ')).toBe(true);
    expect(lines[1]!.summary.startsWith('~ ')).toBe(true);
    expect(lines[2]!.summary.startsWith('- ')).toBe(true);
  });

  it('produces working patches for closed listener port and missing private endpoint', () => {
    // 1. PORT_NOT_LISTENING
    const closedPort = makeSgBlockedDesign();
    closedPort.network.firewalls![1]!.rules.push({
      id: 'in-5432',
      direction: 'ingress',
      action: 'allow',
      protocol: 'tcp',
      portFrom: 5432,
      portTo: 5432,
      source: { firewallId: 'sg-api' },
    });
    closedPort.nodes[1]!.config.listeningPorts = [{ protocol: 'tcp', port: 3306 }];
    const portBlocked = checkReachability(closedPort, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(portBlocked.reasonCode).toBe('PORT_NOT_LISTENING');
    const portDiff = formatPatchDiffLines(portBlocked.fixes[0]!.patch);
    expect(portDiff.some((l) => l.path.includes('/listeningPorts'))).toBe(true);
    const portFixed = applyNetworkPatch(closedPort, portBlocked.fixes[0]!.patch);
    expect(
      checkReachability(portFixed, {
        srcNodeId: 'api',
        dstNodeId: 'db',
        protocol: 'tcp',
        port: 5432,
      }).reachable,
    ).toBe(true);

    // 2. ENDPOINT_MISSING for Lambda in VPC -> DynamoDB
    const epDesign = createEmptyDesign('ep-test', 'Lambda DDB');
    epDesign.nodes = [
      {
        id: 'fn',
        serviceId: 'aws.lambda',
        label: 'Fn',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'ddb',
        serviceId: 'aws.dynamodb',
        label: 'DynamoDB',
        position: { x: 200, y: 0 },
        config: { instances: 1, operations: {} },
      },
    ];
    epDesign.network = {
      networks: [{ id: 'vpc-a', provider: 'aws', cidrs: ['10.0.0.0/16'], name: 'A' }],
      subnets: [
        { id: 'sub-priv', networkId: 'vpc-a', cidr: '10.0.1.0/24', routeTableId: 'rt-priv' },
      ],
      routeTables: [
        { id: 'rt-priv', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] },
      ],
      gateways: [],
      firewalls: [
        {
          id: 'sg-fn',
          kind: 'sg',
          stateful: true,
          attachedTo: { nodeIds: ['fn'] },
          rules: [
            {
              id: 'egr',
              direction: 'egress',
              action: 'allow',
              protocol: 'any',
              destination: { any: true },
            },
          ],
        },
      ],
      peerings: [],
      dnsZones: [],
      endpoints: [],
      attachments: [
        { nodeId: 'fn', subnetId: 'sub-priv', privateIp: '10.0.1.5', firewallIds: ['sg-fn'] },
      ],
    };
    const epBlocked = checkReachability(epDesign, {
      srcNodeId: 'fn',
      dstNodeId: 'ddb',
      protocol: 'tcp',
      port: 443,
    });
    expect(epBlocked.reasonCode).toBe('ENDPOINT_MISSING');
    const epFixed = applyNetworkPatch(epDesign, epBlocked.fixes[0]!.patch);
    expect(
      checkReachability(epFixed, { srcNodeId: 'fn', dstNodeId: 'ddb', protocol: 'tcp', port: 443 })
        .reachable,
    ).toBe(true);
  });
});
