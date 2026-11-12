import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type LogEntry, type SimFrame } from '@infrasim/shared-types';
import { analyzeDesignNetwork, applyNetworkPatch } from '@infrasim/network-analyzer';
import { runSimulationBatchWithDiagnosis } from './simWorkerCore';

function makeNetworkSimDesign() {
  const design = createEmptyDesign('net-sim-test', 'Net Sim Test');
  design.settings.primaryProvider = 'aws';
  design.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      position: { x: 200, y: 0 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'DB',
      position: { x: 400, y: 0 },
      config: { instances: 1, operations: {} },
    },
  ];
  design.edges = [
    {
      id: 'e-c-api',
      from: 'client',
      to: 'api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
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
  design.scenarios = [
    {
      id: 'scen-1',
      name: 'Load',
      durationS: 3,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 10 },
      flows: [{ id: 'f-1', name: 'Req', weight: 1, steps: [{ method: 'GET', path: '/' }] }],
      chaos: [],
    },
  ];
  design.network = {
    networks: [
      { id: 'vpc', provider: 'aws', region: 'us-east-1', cidrs: ['10.0.0.0/16'], name: 'VPC' },
    ],
    subnets: [
      {
        id: 'sub-pub',
        networkId: 'vpc',
        cidr: '10.0.1.0/24',
        routeTableId: 'rt-pub',
        autoAssignPublicIp: true,
      },
    ],
    routeTables: [
      {
        id: 'rt-pub',
        routes: [
          { dest: '10.0.0.0/16', target: { kind: 'local' } },
          { dest: '0.0.0.0/0', target: { kind: 'igw' } },
        ],
      },
    ],
    gateways: [{ id: 'igw', kind: 'igw', networkId: 'vpc' }],
    firewalls: [
      {
        id: 'sg-api',
        kind: 'sg',
        stateful: true,
        rules: [
          {
            id: 'api-in',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 8080,
            portTo: 8080,
            source: { cidr: '0.0.0.0/0' },
          },
          {
            id: 'api-out',
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
        rules: [
          // Missing inbound 5432 rule initially -> SG_NO_INGRESS (timeout)
          {
            id: 'db-out',
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
        nodeId: 'api',
        subnetId: 'sub-pub',
        privateIp: '10.0.1.10',
        publicIp: '198.51.100.10',
        firewallIds: ['sg-api'],
      },
      {
        nodeId: 'db',
        subnetId: 'sub-pub',
        privateIp: '10.0.1.20',
        firewallIds: ['sg-db'],
      },
    ],
  };
  return design;
}

describe('network failure modes and fix recovery in sim engine', () => {
  it('emits ETIMEDOUT for SG drop, fixes cleanly on patch apply, and makes traffic flow', async () => {
    const broken = makeNetworkSimDesign();
    const logs: LogEntry[] = [];
    const resBroken = await runSimulationBatchWithDiagnosis(
      { design: broken, scenarioId: 'scen-1', seed: 42 },
      (frames: SimFrame[]) => {
        for (const f of frames) {
          if (f.newLogs) logs.push(...f.newLogs);
        }
      },
    );

    expect(resBroken.summary.success).toBe(0);
    expect(
      logs.some((l) => l.message.includes('ETIMEDOUT') && l.message.includes('SG_NO_INGRESS')),
    ).toBe(true);
    expect(resBroken.insights.some((ins) => ins.ruleId === 'network-edge-blocked')).toBe(true);

    const netAnalysis = analyzeDesignNetwork(broken);
    const fix = netAnalysis.edges['e-api-db']?.fixes[0];
    expect(fix).toBeDefined();

    const fixed = applyNetworkPatch(broken, fix!.patch);
    const logsAfter: LogEntry[] = [];
    const resFixed = await runSimulationBatchWithDiagnosis(
      { design: fixed, scenarioId: 'scen-1', seed: 42 },
      (frames: SimFrame[]) => {
        for (const f of frames) {
          if (f.newLogs) logsAfter.push(...f.newLogs);
        }
      },
    );
    expect(resFixed.summary.success).toBeGreaterThan(0);
    expect(logsAfter.some((l) => l.message.includes('ETIMEDOUT'))).toBe(false);
  });

  it('distinguishes ECONNREFUSED (port closed) and ENOTFOUND (DNS unresolved) in logs', async () => {
    const refusedDesign = makeNetworkSimDesign();
    // Open SG-DB on 5432, but make DB listen only on 3306
    refusedDesign.network
      .firewalls!.find((f) => f.id === 'sg-db')!
      .rules.push({
        id: 'db-in',
        direction: 'ingress',
        action: 'allow',
        protocol: 'tcp',
        portFrom: 5432,
        portTo: 5432,
        source: { firewallId: 'sg-api' },
      });
    refusedDesign.nodes[2]!.config.listeningPorts = [{ protocol: 'tcp', port: 3306 }];

    const refusedLogs: LogEntry[] = [];
    const refusedRes = await runSimulationBatchWithDiagnosis(
      { design: refusedDesign, scenarioId: 'scen-1', seed: 7 },
      (frames: SimFrame[]) => {
        for (const f of frames) {
          if (f.newLogs) refusedLogs.push(...f.newLogs);
        }
      },
    );
    expect(refusedRes.summary.success).toBe(0);
    expect(
      refusedLogs.some(
        (l) => l.message.includes('ECONNREFUSED') && l.message.includes('PORT_NOT_LISTENING'),
      ),
    ).toBe(true);

    // Explicitly supply a DNS-failure network analysis to verify ENOTFOUND log wording
    const dnsAnalysis = analyzeDesignNetwork(refusedDesign);
    dnsAnalysis.edges['e-api-db'] = {
      ...dnsAnalysis.edges['e-api-db']!,
      reachable: false,
      reasonCode: 'DNS_UNRESOLVED',
      failureMode: 'dns',
      explanation: { short: 'db.internal did not resolve', deep: '' },
      fixes: [],
    };
    const dnsLogs: LogEntry[] = [];
    const dnsRes = await runSimulationBatchWithDiagnosis(
      { design: refusedDesign, scenarioId: 'scen-1', seed: 7, network: dnsAnalysis },
      (frames: SimFrame[]) => {
        for (const f of frames) {
          if (f.newLogs) dnsLogs.push(...f.newLogs);
        }
      },
    );
    expect(dnsRes.summary.success).toBe(0);
    expect(
      dnsLogs.some((l) => l.message.includes('ENOTFOUND') && l.message.includes('DNS_UNRESOLVED')),
    ).toBe(true);
  });

  it('propagates viaNat, viaPrivateLink, and extraLatencyMs from NetworkAnalysis into counters and latency', async () => {
    const design = makeNetworkSimDesign();
    design.network
      .firewalls!.find((f) => f.id === 'sg-db')!
      .rules.push({
        id: 'db-in',
        direction: 'ingress',
        action: 'allow',
        protocol: 'tcp',
        portFrom: 5432,
        portTo: 5432,
        source: { firewallId: 'sg-api' },
      });

    const baseRes = await runSimulationBatchWithDiagnosis(
      { design, scenarioId: 'scen-1', seed: 11 },
      () => {},
    );

    const netWithLatency = analyzeDesignNetwork(design);
    netWithLatency.edges['e-api-db'] = {
      ...netWithLatency.edges['e-api-db']!,
      reachable: true,
      viaNat: true,
      viaEndpoint: true,
      crossAz: true,
      extraLatencyMs: 25,
    };

    const extraRes = await runSimulationBatchWithDiagnosis(
      { design, scenarioId: 'scen-1', seed: 11, network: netWithLatency },
      () => {},
    );

    expect(extraRes.counters.perEdge['e-api-db']?.viaNat).toBe(true);
    expect(extraRes.counters.perEdge['e-api-db']?.viaPrivateLink).toBe(true);
    expect(extraRes.counters.perEdge['e-api-db']?.crossAz).toBe(true);
    expect(extraRes.summary.p50).toBeGreaterThan(baseRes.summary.p50 + 20);
  });
});
