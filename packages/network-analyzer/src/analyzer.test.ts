import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createEmptyDesign, type Design } from '@infrasim/shared-types';
import { analyzeDesignNetwork, checkReachability } from './analyzer.js';
import { applyNetworkPatch } from './fixes.js';

function makeBaseTwoTierAwsDesign(): Design {
  const design = createEmptyDesign('net-test', 'AWS Two Tier');
  design.settings.primaryProvider = 'aws';
  design.nodes = [
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Postgres',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 300, y: 0 },
      config: { instances: 1, operations: {} },
    },
  ];
  design.edges = [
    {
      id: 'e-api-db',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  design.network = {
    networks: [
      {
        id: 'vpc-main',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'Main VPC',
      },
    ],
    subnets: [
      {
        id: 'sub-app',
        networkId: 'vpc-main',
        cidr: '10.0.1.0/24',
        az: 'us-east-1a',
        routeTableId: 'rt-app',
        firewallIds: ['nacl-app'],
      },
    ],
    routeTables: [
      {
        id: 'rt-app',
        routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }],
      },
    ],
    gateways: [],
    firewalls: [
      {
        id: 'nacl-app',
        kind: 'nacl',
        stateful: false,
        attachedTo: { subnetIds: ['sub-app'] },
        rules: [
          {
            id: 'in-100',
            direction: 'ingress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            source: { cidr: '0.0.0.0/0' },
          },
          {
            id: 'out-100',
            direction: 'egress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            destination: { cidr: '0.0.0.0/0' },
          },
        ],
      },
      {
        id: 'sg-api',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['api'] },
        rules: [
          {
            id: 'api-egr',
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
        rules: [
          {
            id: 'db-in-5432',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 5432,
            portTo: 5432,
            source: { firewallId: 'sg-api' },
          },
          {
            id: 'db-egr',
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
      {
        nodeId: 'api',
        subnetId: 'sub-app',
        privateIp: '10.0.1.10',
        firewallIds: ['sg-api'],
      },
      {
        nodeId: 'db',
        subnetId: 'sub-app',
        privateIp: '10.0.1.20',
        firewallIds: ['sg-db'],
      },
    ],
  };
  return design;
}

describe('network reachability analyzer — 14 golden tests + diagnostics', () => {
  it('1. Same subnet with SG-ref allowing 5432 is reachable', () => {
    const design = makeBaseTwoTierAwsDesign();
    const res = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(res.reachable).toBe(true);
    expect(res.failureMode).toBe('none');
  });

  it('2. Removing SG rule returns SG_NO_INGRESS, failureMode=timeout, and fix restores reachability', () => {
    const design = makeBaseTwoTierAwsDesign();
    const sgDb = design.network.firewalls!.find((f) => f.id === 'sg-db')!;
    sgDb.rules = sgDb.rules.filter((r) => r.id !== 'db-in-5432');

    const res = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(res.reachable).toBe(false);
    expect(res.reasonCode).toBe('SG_NO_INGRESS');
    expect(res.failureMode).toBe('timeout');
    expect(res.fixes.length).toBeGreaterThan(0);

    const fixed = applyNetworkPatch(design, res.fixes[0]!.patch);
    const afterFix = checkReachability(fixed, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(afterFix.reachable).toBe(true);
  });

  it('3. Port not listening with open firewall returns PORT_NOT_LISTENING and failureMode=refused', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.nodes[1]!.config.listeningPorts = [{ protocol: 'tcp', port: 3306 }];

    const res = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(res.reachable).toBe(false);
    expect(res.reasonCode).toBe('PORT_NOT_LISTENING');
    expect(res.failureMode).toBe('refused');
    expect(res.fixes.length).toBeGreaterThan(0);

    const fixed = applyNetworkPatch(design, res.fixes[0]!.patch);
    expect(
      checkReachability(fixed, { srcNodeId: 'api', dstNodeId: 'db', protocol: 'tcp', port: 5432 })
        .reachable,
    ).toBe(true);
  });

  it('4. Private subnet -> internet checks NO_NAT, NAT_NOT_IN_PUBLIC_SUBNET, and valid public NAT', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.nodes.push({
      id: 'ext',
      serviceId: 'generic.internet',
      label: 'Stripe API',
      position: { x: 600, y: 0 },
      config: { instances: 1, operations: {} },
    });

    // No NAT route
    const noNat = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'ext',
      protocol: 'https',
      port: 443,
    });
    expect(noNat.reachable).toBe(false);
    expect(noNat.reasonCode).toBe('NO_NAT');

    // NAT placed inside private subnet itself -> NAT_NOT_IN_PUBLIC_SUBNET
    design.network.gateways!.push({
      id: 'nat-1',
      kind: 'nat',
      networkId: 'vpc-main',
      subnetId: 'sub-app',
      publicIp: true,
    });
    design.network.routeTables![0]!.routes.push({
      dest: '0.0.0.0/0',
      target: { kind: 'nat', gatewayId: 'nat-1' },
    });
    const badNat = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'ext',
      protocol: 'https',
      port: 443,
    });
    expect(badNat.reachable).toBe(false);
    expect(badNat.reasonCode).toBe('NAT_NOT_IN_PUBLIC_SUBNET');

    // Move NAT to a valid public subnet with IGW route -> reachable
    design.network.gateways!.push({ id: 'igw-main', kind: 'igw', networkId: 'vpc-main' });
    design.network.routeTables!.push({
      id: 'rt-pub',
      routes: [
        { dest: '10.0.0.0/16', target: { kind: 'local' } },
        { dest: '0.0.0.0/0', target: { kind: 'igw' } },
      ],
    });
    design.network.subnets!.push({
      id: 'sub-pub',
      networkId: 'vpc-main',
      cidr: '10.0.2.0/24',
      routeTableId: 'rt-pub',
      autoAssignPublicIp: true,
    });
    design.network.gateways!.find((g) => g.id === 'nat-1')!.subnetId = 'sub-pub';

    const okNat = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'ext',
      protocol: 'https',
      port: 443,
    });
    expect(okNat.reachable).toBe(true);
    expect(okNat.viaNat).toBe(true);
    expect(okNat.extraLatencyMs).toBeGreaterThanOrEqual(1);
  });

  it('5. NACL deny rule 90 above allow 100 returns NACL_DENY and fix reorders priority', () => {
    const design = makeBaseTwoTierAwsDesign();
    const nacl = design.network.firewalls!.find((f) => f.id === 'nacl-app')!;
    nacl.rules.push({
      id: 'in-90-deny',
      direction: 'ingress',
      action: 'deny',
      priority: 90,
      protocol: 'tcp',
      portFrom: 5432,
      portTo: 5432,
      source: { cidr: '10.0.1.0/24' },
    });

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('NACL_DENY');

    const fixed = applyNetworkPatch(design, blocked.fixes[0]!.patch);
    expect(
      checkReachability(fixed, { srcNodeId: 'api', dstNodeId: 'db', protocol: 'tcp', port: 5432 })
        .reachable,
    ).toBe(true);
  });

  it('6. Stateless NACL without ephemeral return port rule returns EPHEMERAL_PORTS_BLOCKED', () => {
    const design = makeBaseTwoTierAwsDesign();
    const nacl = design.network.firewalls!.find((f) => f.id === 'nacl-app')!;
    // Restrict NACL egress to only port 5432 instead of 1024-65535
    nacl.rules = [
      {
        id: 'in-100',
        direction: 'ingress',
        action: 'allow',
        priority: 100,
        protocol: 'tcp',
        portFrom: 5432,
        portTo: 5432,
        source: { cidr: '0.0.0.0/0' },
      },
      {
        id: 'out-100',
        direction: 'egress',
        action: 'allow',
        priority: 100,
        protocol: 'tcp',
        portFrom: 5432,
        portTo: 5432,
        destination: { cidr: '0.0.0.0/0' },
      },
    ];

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('EPHEMERAL_PORTS_BLOCKED');

    // Apply ephemeral fix on dest egress, then check source ephemeral ingress if still missing
    let fixed = applyNetworkPatch(design, blocked.fixes[0]!.patch);
    const mid = checkReachability(fixed, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    if (!mid.reachable) {
      fixed = applyNetworkPatch(fixed, mid.fixes[0]!.patch);
    }
    expect(
      checkReachability(fixed, { srcNodeId: 'api', dstNodeId: 'db', protocol: 'tcp', port: 5432 })
        .reachable,
    ).toBe(true);
  });

  it('7. Peering A-B with route only on A returns MISSING_RETURN_ROUTE and fix repairs B', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.network.networks!.push({
      id: 'vpc-b',
      provider: 'aws',
      region: 'us-east-1',
      cidrs: ['10.1.0.0/16'],
      name: 'VPC B',
    });
    design.network.routeTables!.push({
      id: 'rt-b',
      routes: [{ dest: '10.1.0.0/16', target: { kind: 'local' } }],
    });
    design.network.subnets!.push({
      id: 'sub-b',
      networkId: 'vpc-b',
      cidr: '10.1.1.0/24',
      az: 'us-east-1a',
      routeTableId: 'rt-b',
    });
    design.network.peerings!.push({ id: 'peer-ab', a: 'vpc-main', b: 'vpc-b', routedA: true });
    design.network.routeTables![0]!.routes.push({
      dest: '10.1.0.0/16',
      target: { kind: 'peering', id: 'peer-ab' },
    });
    // Move DB into VPC B
    design.network.attachments![1] = {
      nodeId: 'db',
      subnetId: 'sub-b',
      privateIp: '10.1.1.20',
      firewallIds: ['sg-db'],
    };

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('MISSING_RETURN_ROUTE');

    const fixed = applyNetworkPatch(design, blocked.fixes[0]!.patch);
    // Add CIDR ingress on SG-DB for 10.0.1.10 if needed; note peered SG-ref across VPC in same region or update rule
    const sgDbFixed = fixed.network.firewalls!.find((f) => f.id === 'sg-db')!;
    sgDbFixed.rules[0]!.source = { cidr: '10.0.0.0/16' };
    expect(
      checkReachability(fixed, { srcNodeId: 'api', dstNodeId: 'db', protocol: 'tcp', port: 5432 })
        .reachable,
    ).toBe(true);
  });

  it('8. A-B and B-C peered -> A to C returns TRANSITIVE_PEERING_UNSUPPORTED', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.network.networks!.push(
      { id: 'vpc-b', provider: 'aws', region: 'us-east-1', cidrs: ['10.1.0.0/16'], name: 'VPC B' },
      { id: 'vpc-c', provider: 'aws', region: 'us-east-1', cidrs: ['10.2.0.0/16'], name: 'VPC C' },
    );
    design.network.routeTables!.push({
      id: 'rt-c',
      routes: [
        { dest: '10.2.0.0/16', target: { kind: 'local' } },
        { dest: '10.0.0.0/16', target: { kind: 'peering', id: 'peer-bc' } },
      ],
    });
    design.network.subnets!.push({
      id: 'sub-c',
      networkId: 'vpc-c',
      cidr: '10.2.1.0/24',
      routeTableId: 'rt-c',
    });
    design.network.peerings!.push(
      { id: 'peer-ab', a: 'vpc-main', b: 'vpc-b', routedA: true, routedB: true },
      { id: 'peer-bc', a: 'vpc-b', b: 'vpc-c', routedA: true, routedB: true },
    );
    design.network.attachments![1] = {
      nodeId: 'db',
      subnetId: 'sub-c',
      privateIp: '10.2.1.20',
      firewallIds: ['sg-db'],
    };

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('TRANSITIVE_PEERING_UNSUPPORTED');
  });

  it('9. Overlapping CIDRs peered returns CIDR_OVERLAP', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.network.networks!.push({
      id: 'vpc-b',
      provider: 'aws',
      region: 'us-east-1',
      cidrs: ['10.0.0.0/16'],
      name: 'Overlapping VPC B',
    });
    design.network.routeTables!.push({
      id: 'rt-b',
      routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }],
    });
    design.network.subnets!.push({
      id: 'sub-b',
      networkId: 'vpc-b',
      cidr: '10.0.2.0/24',
      routeTableId: 'rt-b',
    });
    design.network.peerings!.push({ id: 'peer-overlap', a: 'vpc-main', b: 'vpc-b' });
    design.network.attachments![1] = {
      nodeId: 'db',
      subnetId: 'sub-b',
      privateIp: '10.0.2.20',
      firewallIds: ['sg-db'],
    };

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('CIDR_OVERLAP');
  });

  it('10. GCP firewall priority: deny(100) beats allow(200); swapping priorities allows traffic', () => {
    const design = createEmptyDesign('gcp-prio', 'GCP Priority');
    design.settings.primaryProvider = 'gcp';
    design.nodes = [
      {
        id: 'api',
        serviceId: 'gcp.compute_engine',
        label: 'GCE API',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'db',
        serviceId: 'gcp.cloud_sql_postgres',
        label: 'Cloud SQL',
        position: { x: 300, y: 0 },
        config: { instances: 1, operations: {} },
      },
    ];
    design.network = {
      networks: [
        { id: 'vpc-gcp', provider: 'gcp', global: true, cidrs: ['10.10.0.0/16'], name: 'GCP VPC' },
      ],
      subnets: [
        {
          id: 'sub-gcp',
          networkId: 'vpc-gcp',
          cidr: '10.10.1.0/24',
          regional: true,
          routeTableId: 'rt-gcp',
        },
      ],
      routeTables: [
        { id: 'rt-gcp', routes: [{ dest: '10.10.0.0/16', target: { kind: 'local' } }] },
      ],
      firewalls: [
        {
          id: 'fw-db',
          kind: 'gcp-fw',
          stateful: true,
          attachedTo: { tags: ['db'] },
          rules: [
            {
              id: 'deny-sql',
              direction: 'ingress',
              action: 'deny',
              priority: 100,
              protocol: 'tcp',
              portFrom: 5432,
              portTo: 5432,
              source: { cidr: '10.10.0.0/16' },
            },
            {
              id: 'allow-sql',
              direction: 'ingress',
              action: 'allow',
              priority: 200,
              protocol: 'tcp',
              portFrom: 5432,
              portTo: 5432,
              source: { cidr: '10.10.0.0/16' },
            },
          ],
        },
      ],
      attachments: [
        {
          nodeId: 'api',
          subnetId: 'sub-gcp',
          privateIp: '10.10.1.10',
          firewallIds: [],
          tags: ['api'],
        },
        {
          nodeId: 'db',
          subnetId: 'sub-gcp',
          privateIp: '10.10.1.20',
          firewallIds: [],
          tags: ['db'],
        },
      ],
    };

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('GCP_FW_DENY');

    // Swap priorities via patch
    const fixed = applyNetworkPatch(design, blocked.fixes[0]!.patch);
    expect(
      checkReachability(fixed, { srcNodeId: 'api', dstNodeId: 'db', protocol: 'tcp', port: 5432 })
        .reachable,
    ).toBe(true);
  });

  it('11. Azure NSG default rule allows VNet-to-VNet, but deny rule at priority 100 wins', () => {
    const design = createEmptyDesign('az-nsg', 'Azure NSG');
    design.settings.primaryProvider = 'azure';
    design.nodes = [
      {
        id: 'api',
        serviceId: 'azure.vm',
        label: 'VM API',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'db',
        serviceId: 'azure.postgres_flexible',
        label: 'Az PG',
        position: { x: 300, y: 0 },
        config: { instances: 1, operations: {} },
      },
    ];
    design.network = {
      networks: [
        { id: 'vnet', provider: 'azure', region: 'eastus', cidrs: ['10.20.0.0/16'], name: 'VNet' },
      ],
      subnets: [
        {
          id: 'sub-az',
          networkId: 'vnet',
          cidr: '10.20.1.0/24',
          regional: true,
          routeTableId: 'rt-az',
          firewallIds: ['nsg-sub'],
        },
      ],
      routeTables: [{ id: 'rt-az', routes: [{ dest: '10.20.0.0/16', target: { kind: 'local' } }] }],
      firewalls: [
        {
          id: 'nsg-sub',
          kind: 'nsg',
          stateful: true,
          attachedTo: { subnetIds: ['sub-az'] },
          rules: [
            {
              id: 'deny-db-100',
              direction: 'ingress',
              action: 'deny',
              priority: 100,
              protocol: 'tcp',
              portFrom: 5432,
              portTo: 5432,
              source: { cidr: '10.20.0.0/16' },
            },
            {
              id: 'allow-vnet-65000',
              direction: 'ingress',
              action: 'allow',
              priority: 65000,
              protocol: 'any',
              source: { cidr: '10.20.0.0/16' },
            },
          ],
        },
      ],
      attachments: [
        { nodeId: 'api', subnetId: 'sub-az', privateIp: '10.20.1.10', firewallIds: [] },
        { nodeId: 'db', subnetId: 'sub-az', privateIp: '10.20.1.20', firewallIds: [] },
      ],
    };

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('NSG_DENY');
  });

  it('12. Serverless without VPC attachment -> private IP returns SERVICE_NOT_IN_VPC', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.nodes[0] = {
      id: 'fn',
      serviceId: 'aws.lambda',
      label: 'Lambda',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    };
    // Remove Lambda's VPC attachment so it runs outside VPC
    design.network.attachments = design.network.attachments!.filter((a) => a.nodeId !== 'api');

    const blocked = checkReachability(design, {
      srcNodeId: 'fn',
      dstNodeId: 'db',
      protocol: 'tcp',
      port: 5432,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('SERVICE_NOT_IN_VPC');
  });

  it('13. Private DNS missing for a private endpoint returns PRIVATE_DNS_MISSING', () => {
    const design = makeBaseTwoTierAwsDesign();
    design.nodes[1] = {
      id: 'dynamo',
      serviceId: 'aws.dynamodb',
      label: 'DynamoDB',
      position: { x: 400, y: 0 },
      config: { instances: 1, operations: {} },
    };
    design.network.attachments = design.network.attachments!.filter((a) => a.nodeId === 'api');
    design.network.endpoints!.push({
      id: 'ep-dynamo',
      networkId: 'vpc-main',
      subnetId: 'sub-app',
      serviceId: 'aws.dynamodb',
      privateDns: false,
    });
    design.network.routeTables![0]!.routes.push({
      dest: '0.0.0.0/0',
      target: { kind: 'endpoint', id: 'ep-dynamo' },
    });

    const blocked = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'dynamo',
      protocol: 'https',
      port: 443,
    });
    expect(blocked.reachable).toBe(false);
    expect(blocked.reasonCode).toBe('PRIVATE_DNS_MISSING');

    const fixed = applyNetworkPatch(design, blocked.fixes[0]!.patch);
    expect(
      checkReachability(fixed, {
        srcNodeId: 'api',
        dstNodeId: 'dynamo',
        protocol: 'https',
        port: 443,
      }).reachable,
    ).toBe(true);
  });

  it('14. Property test: any design with permissive firewalls and local routes is reachable within the same network', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.constantFrom(80, 443, 5432, 8080),
        (subnetCount, port) => {
          const design = createEmptyDesign('prop-net', 'Prop');
          design.nodes = [
            {
              id: 'src',
              serviceId: 'aws.ec2',
              label: 'Src',
              position: { x: 0, y: 0 },
              config: { instances: 1, operations: {}, listeningPorts: [{ protocol: 'tcp', port }] },
            },
            {
              id: 'dst',
              serviceId: 'aws.ec2',
              label: 'Dst',
              position: { x: 200, y: 0 },
              config: { instances: 1, operations: {}, listeningPorts: [{ protocol: 'tcp', port }] },
            },
          ];
          const subnets = Array.from({ length: subnetCount }, (_, i) => ({
            id: `sub-${i}`,
            networkId: 'vpc-1',
            cidr: `10.0.${i + 1}.0/24`,
            routeTableId: 'rt-local',
            firewallIds: ['nacl-any'],
          }));
          design.network = {
            networks: [
              {
                id: 'vpc-1',
                provider: 'aws',
                region: 'us-east-1',
                cidrs: ['10.0.0.0/16'],
                name: 'VPC',
              },
            ],
            subnets,
            routeTables: [
              { id: 'rt-local', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] },
            ],
            firewalls: [
              {
                id: 'nacl-any',
                kind: 'nacl',
                stateful: false,
                rules: [
                  {
                    id: 'in',
                    direction: 'ingress',
                    action: 'allow',
                    priority: 100,
                    protocol: 'any',
                    source: { any: true },
                  },
                  {
                    id: 'out',
                    direction: 'egress',
                    action: 'allow',
                    priority: 100,
                    protocol: 'any',
                    destination: { any: true },
                  },
                ],
              },
              {
                id: 'sg-open',
                kind: 'sg',
                stateful: true,
                rules: [
                  {
                    id: 'in',
                    direction: 'ingress',
                    action: 'allow',
                    protocol: 'any',
                    source: { any: true },
                  },
                  {
                    id: 'out',
                    direction: 'egress',
                    action: 'allow',
                    protocol: 'any',
                    destination: { any: true },
                  },
                ],
              },
            ],
            attachments: [
              {
                nodeId: 'src',
                subnetId: subnets[0]!.id,
                privateIp: '10.0.1.10',
                firewallIds: ['sg-open'],
              },
              {
                nodeId: 'dst',
                subnetId: subnets[subnets.length - 1]!.id,
                privateIp: `10.0.${subnets.length}.20`,
                firewallIds: ['sg-open'],
              },
            ],
          };
          const res = checkReachability(design, {
            srcNodeId: 'src',
            dstNodeId: 'dst',
            protocol: 'tcp',
            port,
          });
          return res.reachable;
        },
      ),
      { numRuns: 30 },
    );
  });

  it('detects security smells, DNS failures, and evaluates 200 nodes under 50 ms', () => {
    const design = makeBaseTwoTierAwsDesign();
    // Make subnet public and open SG to 0.0.0.0/0 on 5432 to trigger security smells
    design.network.routeTables![0]!.routes.push({ dest: '0.0.0.0/0', target: { kind: 'igw' } });
    design.network.subnets![0]!.autoAssignPublicIp = true;
    design.network.firewalls!.find((f) => f.id === 'sg-db')!.rules[0]!.source = {
      cidr: '0.0.0.0/0',
    };

    const analysis = analyzeDesignNetwork(design);
    expect(analysis.edges['e-api-db']?.reachable).toBe(true);
    expect(analysis.edges['e-api-db']?.riskyReason).toBeDefined();
    expect(analysis.smells?.some((s) => s.ruleId === 'net-smell-db-public-subnet')).toBe(true);
    expect(analysis.smells?.some((s) => s.ruleId === 'net-smell-open-world-nonweb')).toBe(true);

    const dnsMiss = checkReachability(design, {
      srcNodeId: 'api',
      dstNodeId: 'missing.internal.local',
      protocol: 'https',
      port: 443,
    });
    expect(dnsMiss.reachable).toBe(false);
    expect(dnsMiss.reasonCode).toBe('DNS_UNRESOLVED');
    expect(dnsMiss.failureMode).toBe('dns');

    // 200-node design performance budget (< 50 ms)
    const bigDesign = createEmptyDesign('perf-200', 'Perf 200');
    bigDesign.network = {
      networks: [
        { id: 'vpc', provider: 'aws', region: 'us-east-1', cidrs: ['10.0.0.0/16'], name: 'VPC' },
      ],
      subnets: [{ id: 'sub', networkId: 'vpc', cidr: '10.0.0.0/16', routeTableId: 'rt' }],
      routeTables: [{ id: 'rt', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] }],
      firewalls: [
        {
          id: 'sg-all',
          kind: 'sg',
          stateful: true,
          rules: [
            {
              id: 'in',
              direction: 'ingress',
              action: 'allow',
              protocol: 'any',
              source: { any: true },
            },
            {
              id: 'out',
              direction: 'egress',
              action: 'allow',
              protocol: 'any',
              destination: { any: true },
            },
          ],
        },
      ],
      attachments: [],
    };
    for (let i = 0; i < 200; i++) {
      const id = `n-${i}`;
      bigDesign.nodes.push({
        id,
        serviceId: 'aws.ec2',
        label: `Node ${i}`,
        position: { x: i * 10, y: 0 },
        config: { instances: 1, operations: {} },
      });
      bigDesign.network.attachments!.push({
        nodeId: id,
        subnetId: 'sub',
        privateIp: `10.0.${Math.floor(i / 200) + 1}.${(i % 200) + 10}`,
        firewallIds: ['sg-all'],
      });
      if (i > 0) {
        bigDesign.edges.push({
          id: `e-${i}`,
          from: `n-${i - 1}`,
          to: id,
          protocol: 'https',
          port: 443,
          callType: 'sync',
          weight: 1,
        });
      }
    }
    const t0 = performance.now();
    const bigResult = analyzeDesignNetwork(bigDesign);
    const elapsedMs = performance.now() - t0;
    expect(Object.keys(bigResult.edges)).toHaveLength(199);
    expect(elapsedMs).toBeLessThan(50);
  });
});
