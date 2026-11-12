import { describe, expect, it } from 'vitest';
import type { Design } from '@infrasim/shared-types';
import { classifyTerraformResources } from './classifier.js';
import { layoutDesignWithElk } from './layout.js';
import { flattenTerraformModules } from './parser.js';
import { parseAndSanitizeTerraformJson } from './sanitizer.js';
import { buildTopologyAndNetwork } from './topology.js';

describe('@infrasim/terraform topology, NetworkConfig import & ELK layout (T5.4)', () => {
  it('reconstructs VPC -> Subnet -> Node containment, indirect subnet helpers, and public vs private subnets', () => {
    const planJson = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_vpc.main',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'main',
              provider_name: 'aws',
              values: { cidr_block: '10.0.0.0/16', tags: { Name: 'Main VPC' } },
            },
            {
              address: 'aws_subnet.pub_a',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'pub_a',
              provider_name: 'aws',
              values: {
                cidr_block: '10.0.1.0/24',
                availability_zone: 'us-east-1a',
                tags: { Name: 'Public A' },
              },
            },
            {
              address: 'aws_subnet.priv_a',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'priv_a',
              provider_name: 'aws',
              values: {
                cidr_block: '10.0.11.0/24',
                availability_zone: 'us-east-1a',
                tags: { Name: 'Private A' },
              },
            },
            {
              address: 'aws_internet_gateway.igw',
              mode: 'managed',
              type: 'aws_internet_gateway',
              name: 'igw',
              provider_name: 'aws',
              values: { tags: { Name: 'Main IGW' } },
            },
            {
              address: 'aws_route_table.pub',
              mode: 'managed',
              type: 'aws_route_table',
              name: 'pub',
              provider_name: 'aws',
              values: {},
            },
            {
              address: 'aws_route.pub_default',
              mode: 'managed',
              type: 'aws_route',
              name: 'pub_default',
              provider_name: 'aws',
              values: { destination_cidr_block: '0.0.0.0/0' },
            },
            {
              address: 'aws_route_table_association.pub_a',
              mode: 'managed',
              type: 'aws_route_table_association',
              name: 'pub_a',
              provider_name: 'aws',
              values: {},
            },
            {
              address: 'aws_lb.alb',
              mode: 'managed',
              type: 'aws_lb',
              name: 'alb',
              provider_name: 'aws',
              values: { name: 'Edge ALB', load_balancer_type: 'application' },
            },
            {
              address: 'aws_db_subnet_group.db_subs',
              mode: 'managed',
              type: 'aws_db_subnet_group',
              name: 'db_subs',
              provider_name: 'aws',
              values: { name: 'db-subs' },
            },
            {
              address: 'aws_db_instance.pg',
              mode: 'managed',
              type: 'aws_db_instance',
              name: 'pg',
              provider_name: 'aws',
              values: {
                engine: 'postgres',
                instance_class: 'db.t3.small',
                allocated_storage: 50,
              },
            },
          ],
        },
      },
      configuration: {
        root_module: {
          resources: [
            {
              address: 'aws_subnet.pub_a',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_subnet.priv_a',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_internet_gateway.igw',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_route_table.pub',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_route.pub_default',
              expressions: {
                route_table_id: { references: ['aws_route_table.pub.id'] },
                gateway_id: { references: ['aws_internet_gateway.igw.id'] },
              },
            },
            {
              address: 'aws_route_table_association.pub_a',
              expressions: {
                subnet_id: { references: ['aws_subnet.pub_a.id'] },
                route_table_id: { references: ['aws_route_table.pub.id'] },
              },
            },
            {
              address: 'aws_lb.alb',
              expressions: { subnets: { references: ['aws_subnet.pub_a.id'] } },
            },
            {
              address: 'aws_db_subnet_group.db_subs',
              expressions: { subnet_ids: { references: ['aws_subnet.priv_a.id'] } },
            },
            {
              address: 'aws_db_instance.pg',
              expressions: {
                db_subnet_group_name: { references: ['aws_db_subnet_group.db_subs.name'] },
              },
            },
          ],
        },
      },
    };

    const sanitized = parseAndSanitizeTerraformJson(planJson);
    const classified = classifyTerraformResources(flattenTerraformModules(sanitized));
    const topo = buildTopologyAndNetwork(classified);

    const vpcGrp = topo.groups.find((g) => g.kind === 'vpc')!;
    const pubSubGrp = topo.groups.find((g) => g.label === 'Public A')!;
    const privSubGrp = topo.groups.find((g) => g.label === 'Private A')!;

    expect(pubSubGrp.parentGroupId).toBe(vpcGrp.id);
    expect(privSubGrp.parentGroupId).toBe(vpcGrp.id);
    expect(pubSubGrp.public).toBe(true);
    expect(privSubGrp.public).toBe(false);

    const albNode = topo.nodes.find((n) => n.serviceId === 'aws.alb')!;
    const rdsNode = topo.nodes.find((n) => n.serviceId === 'aws.rds_postgres')!;
    expect(albNode.parentGroupId).toBe(pubSubGrp.id);
    // Indirect containment resolved via aws_db_subnet_group
    expect(rdsNode.parentGroupId).toBe(privSubGrp.id);

    expect(topo.network.networks).toHaveLength(1);
    expect(topo.network.subnets).toHaveLength(2);
    expect(topo.network.gateways.some((g) => g.kind === 'igw')).toBe(true);
    expect(topo.network.attachments).toHaveLength(2);
  });

  it('imports cross-cloud firewalls (AWS SG, NACL, GCP tags, Azure NSG, OCI NSG), peerings, endpoints, and DNS zones', () => {
    const planJson = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_vpc.a',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'a',
              provider_name: 'aws',
              values: { cidr_block: '10.1.0.0/16' },
            },
            {
              address: 'aws_vpc.b',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'b',
              provider_name: 'aws',
              values: { cidr_block: '10.2.0.0/16' },
            },
            {
              address: 'aws_subnet.priv',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'priv',
              provider_name: 'aws',
              values: { cidr_block: '10.1.1.0/24' },
            },
            {
              address: 'aws_vpc_peering_connection.ab',
              mode: 'managed',
              type: 'aws_vpc_peering_connection',
              name: 'ab',
              provider_name: 'aws',
              values: {},
            },
            {
              address: 'aws_vpc_endpoint.s3',
              mode: 'managed',
              type: 'aws_vpc_endpoint',
              name: 's3',
              provider_name: 'aws',
              values: { service_name: 'com.amazonaws.us-east-1.s3', private_dns_enabled: true },
            },
            {
              address: 'aws_security_group.app',
              mode: 'managed',
              type: 'aws_security_group',
              name: 'app',
              provider_name: 'aws',
              values: { name: 'app-sg' },
            },
            {
              address: 'aws_security_group.db',
              mode: 'managed',
              type: 'aws_security_group',
              name: 'db',
              provider_name: 'aws',
              values: { name: 'db-sg' },
            },
            {
              address: 'aws_vpc_security_group_ingress_rule.db_from_app',
              mode: 'managed',
              type: 'aws_vpc_security_group_ingress_rule',
              name: 'db_from_app',
              provider_name: 'aws',
              values: { ip_protocol: 'tcp', from_port: 5432, to_port: 5432 },
            },
            {
              address: 'aws_network_acl.priv_nacl',
              mode: 'managed',
              type: 'aws_network_acl',
              name: 'priv_nacl',
              provider_name: 'aws',
              values: {},
            },
            {
              address: 'aws_route53_zone.internal',
              mode: 'managed',
              type: 'aws_route53_zone',
              name: 'internal',
              provider_name: 'aws',
              values: { name: 'internal.example.' },
            },
            {
              address: 'google_compute_network.gcp_vpc',
              mode: 'managed',
              type: 'google_compute_network',
              name: 'gcp_vpc',
              provider_name: 'google',
              values: {},
            },
            {
              address: 'google_compute_firewall.allow_worker',
              mode: 'managed',
              type: 'google_compute_firewall',
              name: 'allow_worker',
              provider_name: 'google',
              values: {
                direction: 'INGRESS',
                source_tags: ['svc-api'],
                target_tags: ['svc-worker'],
                allow: [{ protocol: 'tcp', ports: ['8080'] }],
              },
            },
            {
              address: 'google_compute_instance.worker',
              mode: 'managed',
              type: 'google_compute_instance',
              name: 'worker',
              provider_name: 'google',
              values: { machine_type: 'e2-small', tags: ['svc-worker'] },
            },
            {
              address: 'azurerm_virtual_network.vnet',
              mode: 'managed',
              type: 'azurerm_virtual_network',
              name: 'vnet',
              provider_name: 'azurerm',
              values: { address_space: ['10.20.0.0/16'] },
            },
            {
              address: 'azurerm_subnet.az_sub',
              mode: 'managed',
              type: 'azurerm_subnet',
              name: 'az_sub',
              provider_name: 'azurerm',
              values: { address_prefixes: ['10.20.1.0/24'] },
            },
            {
              address: 'azurerm_network_security_group.az_nsg',
              mode: 'managed',
              type: 'azurerm_network_security_group',
              name: 'az_nsg',
              provider_name: 'azurerm',
              values: { name: 'az-nsg' },
            },
            {
              address: 'azurerm_network_security_rule.allow_https',
              mode: 'managed',
              type: 'azurerm_network_security_rule',
              name: 'allow_https',
              provider_name: 'azurerm',
              values: {
                direction: 'Inbound',
                access: 'Allow',
                priority: 100,
                protocol: 'Tcp',
                destination_port_range: '443',
                source_address_prefix: '*',
              },
            },
            {
              address: 'azurerm_subnet_network_security_group_association.az_assoc',
              mode: 'managed',
              type: 'azurerm_subnet_network_security_group_association',
              name: 'az_assoc',
              provider_name: 'azurerm',
              values: {},
            },
            {
              address: 'oci_core_network_security_group.oci_app',
              mode: 'managed',
              type: 'oci_core_network_security_group',
              name: 'oci_app',
              provider_name: 'oci',
              values: {},
            },
            {
              address: 'oci_core_network_security_group.oci_db',
              mode: 'managed',
              type: 'oci_core_network_security_group',
              name: 'oci_db',
              provider_name: 'oci',
              values: {},
            },
            {
              address: 'oci_core_network_security_group_security_rule.oci_db_in',
              mode: 'managed',
              type: 'oci_core_network_security_group_security_rule',
              name: 'oci_db_in',
              provider_name: 'oci',
              values: {
                direction: 'INGRESS',
                protocol: '6',
                tcp_options: [{ destination_port_range: [{ min: 5432, max: 5432 }] }],
              },
            },
          ],
        },
      },
      configuration: {
        root_module: {
          resources: [
            {
              address: 'aws_subnet.priv',
              expressions: { vpc_id: { references: ['aws_vpc.a.id'] } },
            },
            {
              address: 'aws_vpc_peering_connection.ab',
              expressions: {
                vpc_id: { references: ['aws_vpc.a.id'] },
                peer_vpc_id: { references: ['aws_vpc.b.id'] },
              },
            },
            {
              address: 'aws_vpc_endpoint.s3',
              expressions: {
                vpc_id: { references: ['aws_vpc.a.id'] },
                subnet_ids: { references: ['aws_subnet.priv.id'] },
              },
            },
            {
              address: 'aws_security_group.app',
              expressions: { vpc_id: { references: ['aws_vpc.a.id'] } },
            },
            {
              address: 'aws_security_group.db',
              expressions: { vpc_id: { references: ['aws_vpc.a.id'] } },
            },
            {
              address: 'aws_vpc_security_group_ingress_rule.db_from_app',
              expressions: {
                security_group_id: { references: ['aws_security_group.db.id'] },
                referenced_security_group_id: { references: ['aws_security_group.app.id'] },
              },
            },
            {
              address: 'aws_network_acl.priv_nacl',
              expressions: { subnet_ids: { references: ['aws_subnet.priv.id'] } },
            },
            {
              address: 'aws_route53_zone.internal',
              expressions: { vpc: { vpc_id: { references: ['aws_vpc.a.id'] } } },
            },
            {
              address: 'azurerm_subnet.az_sub',
              expressions: {
                virtual_network_name: { references: ['azurerm_virtual_network.vnet.name'] },
              },
            },
            {
              address: 'azurerm_network_security_rule.allow_https',
              expressions: {
                network_security_group_name: {
                  references: ['azurerm_network_security_group.az_nsg.name'],
                },
              },
            },
            {
              address: 'azurerm_subnet_network_security_group_association.az_assoc',
              expressions: {
                subnet_id: { references: ['azurerm_subnet.az_sub.id'] },
                network_security_group_id: {
                  references: ['azurerm_network_security_group.az_nsg.id'],
                },
              },
            },
            {
              address: 'oci_core_network_security_group_security_rule.oci_db_in',
              expressions: {
                network_security_group_id: {
                  references: ['oci_core_network_security_group.oci_db.id'],
                },
                source: {
                  references: ['oci_core_network_security_group.oci_app.id'],
                },
              },
            },
          ],
        },
      },
    };

    const sanitized = parseAndSanitizeTerraformJson(planJson);
    const classified = classifyTerraformResources(flattenTerraformModules(sanitized));
    const topo = buildTopologyAndNetwork(classified);

    expect(topo.network.peerings).toHaveLength(1);
    expect(topo.network.endpoints).toHaveLength(1);
    expect(topo.network.endpoints[0]?.privateDns).toBe(true);
    expect(topo.network.dnsZones).toHaveLength(1);
    expect(topo.network.dnsZones[0]?.name).toBe('internal.example');
    expect(topo.network.dnsZones[0]?.private).toBe(true);

    const dbSg = topo.network.firewalls.find(
      (f) => f.id === topo.addressToFirewallId.get('aws_security_group.db'),
    )!;
    const appSgId = topo.addressToFirewallId.get('aws_security_group.app')!;
    expect(dbSg.rules).toHaveLength(1);
    expect(dbSg.rules[0]?.source).toEqual({ firewallId: appSgId });

    const gcpWorker = topo.nodes.find((n) => n.serviceId === 'gcp.compute_engine')!;
    const gcpFw = topo.network.firewalls.find((f) => f.kind === 'gcp-fw')!;
    expect(gcpFw.attachedTo?.nodeIds).toContain(gcpWorker.id);

    const azNsg = topo.network.firewalls.find((f) => f.kind === 'nsg')!;
    expect(azNsg.rules[0]?.portFrom).toBe(443);
    expect(azNsg.attachedTo?.subnetIds).toHaveLength(1);

    const ociDbNsg = topo.network.firewalls.find(
      (f) => f.id === topo.addressToFirewallId.get('oci_core_network_security_group.oci_db'),
    )!;
    const ociAppNsgId = topo.addressToFirewallId.get('oci_core_network_security_group.oci_app')!;
    expect(ociDbNsg.rules[0]?.source).toEqual({ firewallId: ociAppNsgId });
  });

  it('computes deterministic world-space ELK compound layout with child containment snapped to 16 px grid', async () => {
    const design: Design = {
      schemaVersion: 1,
      id: 'd-elk',
      name: 'ELK Test',
      groups: [
        {
          id: 'vpc_1',
          kind: 'vpc',
          label: 'Main VPC',
          provider: 'aws',
          cidr: '10.0.0.0/16',
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
        },
        {
          id: 'sub_pub',
          kind: 'subnet',
          label: 'Public Subnet',
          provider: 'aws',
          parentGroupId: 'vpc_1',
          public: true,
          cidr: '10.0.1.0/24',
          position: { x: 0, y: 0 },
          size: { width: 200, height: 150 },
        },
        {
          id: 'sub_priv',
          kind: 'subnet',
          label: 'Private Subnet',
          provider: 'aws',
          parentGroupId: 'vpc_1',
          public: false,
          cidr: '10.0.11.0/24',
          position: { x: 0, y: 0 },
          size: { width: 200, height: 150 },
        },
      ],
      nodes: [
        {
          id: 'n_alb',
          serviceId: 'aws.alb',
          label: 'ALB',
          parentGroupId: 'sub_pub',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 'n_api',
          serviceId: 'aws.ec2',
          label: 'API',
          parentGroupId: 'sub_priv',
          position: { x: 0, y: 0 },
          config: { instances: 2, operations: {} },
        },
        {
          id: 'n_db',
          serviceId: 'aws.rds_postgres',
          label: 'Postgres',
          parentGroupId: 'sub_priv',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
      ],
      edges: [
        {
          id: 'e1',
          from: 'n_alb',
          to: 'n_api',
          callType: 'sync',
          protocol: 'http',
          port: 8080,
          weight: 1,
        },
        {
          id: 'e2',
          from: 'n_api',
          to: 'n_db',
          callType: 'sync',
          protocol: 'sql',
          port: 5432,
          weight: 1,
        },
      ],
      network: {
        networks: [],
        subnets: [],
        routeTables: [],
        gateways: [],
        firewalls: [],
        peerings: [],
        endpoints: [],
        dnsZones: [],
        attachments: [],
      },
      scenarios: [],
      scripts: [],
      fixtures: [],
      settings: {
        seed: 42,
        primaryProvider: 'aws',
        currency: 'USD',
        includeFreeTier: true,
      },
    };

    const run1 = await layoutDesignWithElk(design);
    const run2 = await layoutDesignWithElk(design);
    expect(run1).toEqual(run2);

    const vpc = run1.groups.find((g) => g.id === 'vpc_1')!;
    const subPub = run1.groups.find((g) => g.id === 'sub_pub')!;
    const subPriv = run1.groups.find((g) => g.id === 'sub_priv')!;
    const alb = run1.nodes.find((n) => n.id === 'n_alb')!;
    const api = run1.nodes.find((n) => n.id === 'n_api')!;
    const db = run1.nodes.find((n) => n.id === 'n_db')!;

    // Grid snapping
    for (const g of [vpc, subPub, subPriv]) {
      expect(g.position!.x % 16).toBe(0);
      expect(g.position!.y % 16).toBe(0);
      expect(g.size!.width % 16).toBe(0);
      expect(g.size!.height % 16).toBe(0);
    }
    for (const n of [alb, api, db]) {
      expect(n.position.x % 16).toBe(0);
      expect(n.position.y % 16).toBe(0);
    }

    // World coordinates place subnets inside VPC
    expect(subPub.position!.x).toBeGreaterThanOrEqual(vpc.position!.x);
    expect(subPub.position!.y).toBeGreaterThanOrEqual(vpc.position!.y);
    expect(subPub.position!.x + subPub.size!.width).toBeLessThanOrEqual(
      vpc.position!.x + vpc.size!.width + 16,
    );

    // World coordinates place child nodes inside their parent subnet
    expect(alb.position.x).toBeGreaterThanOrEqual(subPub.position!.x);
    expect(alb.position.y).toBeGreaterThanOrEqual(subPub.position!.y);
    expect(api.position.x).toBeGreaterThanOrEqual(subPriv.position!.x);
    expect(api.position.y).toBeGreaterThanOrEqual(subPriv.position!.y);
    expect(db.position.x).toBeGreaterThanOrEqual(subPriv.position!.x);
    expect(db.position.y).toBeGreaterThanOrEqual(subPriv.position!.y);

    // API and DB inside same subnet do not overlap
    const overlapX =
      Math.abs(api.position.x - db.position.x) < 216 &&
      Math.abs(api.position.y - db.position.y) < 84;
    expect(overlapX).toBe(false);
  });
});
