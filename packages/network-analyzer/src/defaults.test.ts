import { describe, expect, it } from 'vitest';
import { createEmptyDesign } from '@infrasim/shared-types';
import {
  allocateIpFromCidr,
  allocateSubnetCidr,
  cidrContainsIp,
  cidrsOverlap,
  intToIp,
  ipToInt,
  isPrivateIp,
  isPublicIp,
  isValidIpv4,
  parseCidr,
  prefixLength,
} from './cidr.js';
import {
  cleanupGroupNetworkReferences,
  cleanupNodeNetworkReferences,
  ensureGroupNetworkDefaults,
  getEffectiveListeningPorts,
  inferEdgePortAndProtocol,
  inferSubnetPublicness,
  syncGroupDescendantsNetwork,
  syncNodeNetworkAttachment,
} from './defaults.js';

describe('cidr arithmetic', () => {
  it('validates and converts dotted-quad IPv4 addresses', () => {
    expect(isValidIpv4('10.0.1.15')).toBe(true);
    expect(isValidIpv4('256.0.0.1')).toBe(false);
    expect(isValidIpv4('10.0.1')).toBe(false);

    const num = ipToInt('192.168.10.42');
    expect(num).not.toBeNull();
    expect(intToIp(num!)).toBe('192.168.10.42');
  });

  it('parses CIDRs, checks membership, overlap, and private/public classification', () => {
    const parsed = parseCidr('10.0.1.55/24');
    expect(parsed).toMatchObject({ cidr: '10.0.1.0/24', prefix: 24 });
    expect(prefixLength('10.0.1.0/24')).toBe(24);
    expect(cidrContainsIp('10.0.1.0/24', '10.0.1.200')).toBe(true);
    expect(cidrContainsIp('10.0.1.0/24', '10.0.2.200')).toBe(false);
    expect(cidrsOverlap('10.0.0.0/16', '10.0.5.0/24')).toBe(true);
    expect(cidrsOverlap('10.0.0.0/16', '10.1.0.0/16')).toBe(false);
    expect(isPrivateIp('10.0.1.10')).toBe(true);
    expect(isPrivateIp('172.16.5.1')).toBe(true);
    expect(isPublicIp('198.51.100.10')).toBe(true);
    expect(isPublicIp('10.0.1.10')).toBe(false);
  });

  it('allocates non-colliding host IPs and subnet CIDRs deterministically', () => {
    const used = new Set(['10.0.1.10', '10.0.1.11']);
    expect(allocateIpFromCidr('10.0.1.0/24', used)).toBe('10.0.1.12');
    expect(allocateSubnetCidr('10.0.0.0/16', ['10.0.1.0/24'])).toBe('10.0.2.0/24');
  });
});

describe('provider network defaults and placement sync', () => {
  it('creates AWS VPC, subnet, route table, IGW, NACL, and SG attachment when placing nodes', () => {
    const design = createEmptyDesign('d-aws', 'AWS Net');
    design.settings.primaryProvider = 'aws';
    design.groups.push(
      {
        id: 'g-vpc',
        kind: 'vpc',
        label: 'Main VPC',
        cidr: '10.0.0.0/16',
        position: { x: 0, y: 0 },
        size: { width: 512, height: 352 },
      },
      {
        id: 'g-sub-pub',
        kind: 'subnet',
        label: 'Public Subnet',
        parentGroupId: 'g-vpc',
        cidr: '10.0.1.0/24',
        public: true,
        position: { x: 16, y: 32 },
        size: { width: 256, height: 224 },
      },
    );
    ensureGroupNetworkDefaults(design, 'g-vpc');
    ensureGroupNetworkDefaults(design, 'g-sub-pub');

    design.nodes.push({
      id: 'n-alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      parentGroupId: 'g-sub-pub',
      position: { x: 48, y: 80 },
      config: { instances: 1, operations: {} },
    });
    syncNodeNetworkAttachment(design, 'n-alb');

    expect(design.network.networks).toHaveLength(1);
    expect(design.network.networks![0]).toMatchObject({ id: 'net-g-vpc', provider: 'aws' });
    expect(design.network.subnets).toHaveLength(1);
    expect(inferSubnetPublicness(design.network.subnets![0]!, design.network)).toBe(true);

    const att = design.network.attachments!.find((a) => a.nodeId === 'n-alb');
    expect(att).toBeDefined();
    expect(att?.privateIp).toBe('10.0.1.10');
    expect(att?.publicIp).toMatch(/^198\.51\.100\./);
    expect(att?.firewallIds).toContain('sg-n-alb');

    const sg = design.network.firewalls!.find((f) => f.id === 'sg-n-alb');
    expect(sg?.kind).toBe('sg');
    expect(sg?.rules.some((r) => r.direction === 'ingress' && r.portFrom === 443)).toBe(true);
    expect(
      design.network.firewalls!.some((f) => f.id === 'nacl-g-sub-pub' && f.kind === 'nacl'),
    ).toBe(true);
  });

  it('generates GCP VPC tags, Azure NSG, and OCI Security List/NSG according to provider', () => {
    const design = createEmptyDesign('d-multi', 'Multi Cloud');
    design.groups.push(
      { id: 'v-gcp', kind: 'vpc', provider: 'gcp', label: 'GCP VPC', cidr: '10.10.0.0/16' },
      {
        id: 's-gcp',
        kind: 'subnet',
        provider: 'gcp',
        parentGroupId: 'v-gcp',
        label: 'GCP Sub',
        public: false,
      },
      { id: 'v-az', kind: 'vpc', provider: 'azure', label: 'Az VNet', cidr: '10.20.0.0/16' },
      {
        id: 's-az',
        kind: 'subnet',
        provider: 'azure',
        parentGroupId: 'v-az',
        label: 'Az Sub',
        public: false,
      },
      { id: 'v-oci', kind: 'vpc', provider: 'oci', label: 'OCI VCN', cidr: '10.30.0.0/16' },
      {
        id: 's-oci',
        kind: 'subnet',
        provider: 'oci',
        parentGroupId: 'v-oci',
        label: 'OCI Sub',
        public: false,
      },
    );
    for (const gid of ['v-gcp', 's-gcp', 'v-az', 's-az', 'v-oci', 's-oci']) {
      ensureGroupNetworkDefaults(design, gid);
    }

    design.nodes.push(
      {
        id: 'n-gcp',
        serviceId: 'gcp.gce',
        label: 'GCE',
        parentGroupId: 's-gcp',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'n-az',
        serviceId: 'azure.vm',
        label: 'AzVM',
        parentGroupId: 's-az',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'n-oci',
        serviceId: 'oci.compute',
        label: 'OciVM',
        parentGroupId: 's-oci',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
    );
    syncNodeNetworkAttachment(design, 'n-gcp');
    syncNodeNetworkAttachment(design, 'n-az');
    syncNodeNetworkAttachment(design, 'n-oci');

    expect(design.network.networks!.find((n) => n.id === 'net-v-gcp')?.global).toBe(true);
    expect(design.network.attachments!.find((a) => a.nodeId === 'n-gcp')?.tags).toContain(
      'svc-n-gcp',
    );
    expect(design.network.firewalls!.find((f) => f.id === 'gcp-fw-n-gcp')?.kind).toBe('gcp-fw');
    expect(design.network.firewalls!.find((f) => f.id === 'nsg-n-az')?.kind).toBe('nsg');
    expect(design.network.firewalls!.find((f) => f.id === 'oci-nsg-n-oci')?.kind).toBe('oci-nsg');
    expect(design.network.firewalls!.find((f) => f.id === 'oci-sl-s-oci')?.kind).toBe('oci-sl');
  });

  it('strips auto-managed public IP when toggling subnet private and cleans up deleted items', () => {
    const design = createEmptyDesign('d-toggle', 'Toggle');
    design.groups.push(
      { id: 'vpc1', kind: 'vpc', label: 'VPC', cidr: '10.0.0.0/16' },
      {
        id: 'sub1',
        kind: 'subnet',
        parentGroupId: 'vpc1',
        label: 'Sub',
        cidr: '10.0.1.0/24',
        public: true,
      },
    );
    design.nodes.push({
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API',
      parentGroupId: 'sub1',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {} },
    });
    syncNodeNetworkAttachment(design, 'api');
    expect(design.network.attachments![0]?.publicIp).toBeDefined();

    // Switch subnet to private and re-sync descendants
    design.groups[1]!.public = false;
    syncGroupDescendantsNetwork(design, 'sub1');
    expect(design.network.attachments![0]?.publicIp).toBeUndefined();
    expect(inferSubnetPublicness(design.network.subnets![0]!, design.network)).toBe(false);

    // Move node outside subnet
    delete design.nodes[0]!.parentGroupId;
    syncNodeNetworkAttachment(design, 'api');
    expect(design.network.attachments).toHaveLength(0);

    // Cleanup node & group
    cleanupNodeNetworkReferences(design, 'api');
    expect(design.network.firewalls!.some((f) => f.id === 'sg-api')).toBe(false);
    cleanupGroupNetworkReferences(design, 'sub1');
    expect(design.network.subnets).toHaveLength(0);
  });

  it('resolves effective listening ports and edge protocol/port inference', () => {
    expect(
      getEffectiveListeningPorts(undefined, { listeningPorts: [{ protocol: 'tcp', port: 9000 }] }),
    ).toEqual([{ protocol: 'tcp', port: 9000 }]);

    const inferred = inferEdgePortAndProtocol({ protocol: 'sql' }, undefined, {
      id: 'db',
      serviceId: 'aws.rds',
      label: 'DB',
      position: { x: 0, y: 0 },
      config: { instances: 1, operations: {}, listeningPorts: [{ protocol: 'tcp', port: 5432 }] },
    });
    expect(inferred).toEqual({ protocol: 'tcp', port: 5432 });
  });
});
