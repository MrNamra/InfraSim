import type { GroupInstance } from '@infrasim/shared-types';
import {
  hclAttr,
  hclBlock,
  hclBlockStmt,
  hclCommentStmt,
  hclList,
  hclLit,
  hclRaw,
  hclRef,
} from '../hcl/ast.js';
import { snakeCaseSlug } from '../naming.js';
import type { TerraformExportContext } from './types.js';

const VCN_HOSTED_OCI = new Set([
  'oci.compute',
  'oci.load_balancer',
  'oci.network_lb',
  'oci.oke',
  'oci.mysql_heatwave',
  'oci.postgres',
  'oci.nat_gw',
  'oci.internet_gw',
  'oci.service_gw',
  'oci.api_gateway',
]);

const INTERNET_CALLERS = new Set(['generic.client', 'generic.users', 'oci.internet_gw']);
const PUBLIC_ENTRY_OCI = new Set([
  'oci.load_balancer',
  'oci.network_lb',
  'oci.api_gateway',
  'oci.waf',
]);

function commentIf(ctx: TerraformExportContext, lines: string[]): { comments?: string[] } {
  return ctx.includeComments ? { comments: lines } : {};
}

/** Exports the Oracle Cloud Infrastructure (OCI) subset of a Design into `ctx.buckets`. */
export function mapOciToTerraform(ctx: TerraformExportContext): void {
  const { design, allocator, network, buckets } = ctx;

  const ociNodes = [...design.nodes]
    .filter((n) => n.serviceId.startsWith('oci.'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const ociNetworks = [...network.networks]
    .filter((n) => n.provider === 'oci')
    .sort((a, b) => a.id.localeCompare(b.id));

  const ociVcnGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'vpc' &&
        (g.provider === 'oci' || (!g.provider && design.settings.primaryProvider === 'oci')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const ociSubnetGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'subnet' &&
        (g.provider === 'oci' || (!g.provider && design.settings.primaryProvider === 'oci')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const ociNetworkIds = new Set(ociNetworks.map((n) => n.id));
  const ociSubnets = [...network.subnets]
    .filter((s) => ociNetworkIds.has(s.networkId))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (
    ociNodes.length === 0 &&
    ociNetworks.length === 0 &&
    ociVcnGroups.length === 0 &&
    ociSubnetGroups.length === 0
  ) {
    return;
  }

  const ociRegionVar = ctx.addVariable({
    name: 'oci_region',
    type: 'string',
    defaultValue: ctx.regions.oci,
    description: 'OCI home/target region identifier (e.g. us-ashburn-1).',
  });
  const compartmentVar = ctx.addVariable({
    name: 'oci_compartment_id',
    type: 'string',
    description: 'TODO: OCID of the target OCI compartment.',
  });

  buckets.providers.push(
    hclBlockStmt(
      hclBlock('provider', {
        labels: ['oci'],
        ...commentIf(ctx, [
          'Oracle Cloud Infrastructure provider (auth supplied via OCI CLI/env).',
        ]),
        attributes: [hclAttr('region', hclRef(`var.${ociRegionVar}`))],
      }),
    ),
  );

  allocator.preallocate([
    ...ociVcnGroups.map((g) => ({
      scope: 'oci_vcn',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'vcn',
    })),
    ...ociNetworks.map((n) => ({
      scope: 'oci_vcn',
      entityId: n.id,
      rawLabel: n.name || 'vcn',
      fallback: 'vcn',
    })),
    ...ociSubnetGroups.map((g) => ({
      scope: 'oci_subnet',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'subnet',
    })),
    ...ociSubnets.map((s) => ({
      scope: 'oci_subnet',
      entityId: s.id,
      rawLabel: s.id.replace(/^sub-/, ''),
      fallback: 'subnet',
    })),
    ...ociNodes.map((n) => ({
      scope: 'oci_node',
      entityId: n.id,
      rawLabel: n.label,
      fallback: snakeCaseSlug(n.serviceId.replace(/^oci\./, ''), 'service'),
    })),
  ]);

  const vcnRefByNetworkId = new Map<string, string>();
  const vcnRefByGroupId = new Map<string, string>();
  const subRefBySubnetId = new Map<string, string>();
  const subRefByGroupId = new Map<string, string>();
  const allVcns: string[] = [];
  const allSubs: string[] = [];
  const emittedVcns = new Set<string>();
  const emittedSubs = new Set<string>();

  for (const netObj of ociNetworks) {
    const gId = netObj.id.startsWith('net-') ? netObj.id.slice(4) : netObj.id;
    const matched = ociVcnGroups.find((g) => g.id === gId);
    const vcnName = allocator.allocate(
      'oci_vcn',
      matched ? matched.id : netObj.id,
      netObj.name || matched?.label || 'vcn',
      'vcn',
    );
    vcnRefByNetworkId.set(netObj.id, vcnName);
    if (matched) {
      vcnRefByGroupId.set(matched.id, vcnName);
      ctx.recordAddress(matched.id, `oci_core_vcn.${vcnName}`);
    }
    if (!emittedVcns.has(vcnName)) {
      emittedVcns.add(vcnName);
      allVcns.push(vcnName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['oci_core_vcn', vcnName],
            attributes: [
              hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              hclAttr('cidr_blocks', hclList(netObj.cidrs.map((c) => hclLit(c)))),
              hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${vcnName}"`)),
              hclAttr('dns_label', hclLit(vcnName.replace(/_/g, '').slice(0, 15) || 'mainvcn')),
            ],
          }),
        ),
      );
    }
  }

  for (const g of ociVcnGroups) {
    if (vcnRefByGroupId.has(g.id)) continue;
    const vcnName = allocator.allocate('oci_vcn', g.id, g.label, 'vcn');
    vcnRefByGroupId.set(g.id, vcnName);
    ctx.recordAddress(g.id, `oci_core_vcn.${vcnName}`);
    if (!emittedVcns.has(vcnName)) {
      emittedVcns.add(vcnName);
      allVcns.push(vcnName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['oci_core_vcn', vcnName],
            attributes: [
              hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              hclAttr('cidr_blocks', hclList([hclLit(g.cidr?.trim() || '10.30.0.0/16')])),
              hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${vcnName}"`)),
              hclAttr('dns_label', hclLit(vcnName.replace(/_/g, '').slice(0, 15) || 'mainvcn')),
            ],
          }),
        ),
      );
    }
  }

  if (allVcns.length === 0 && ociNodes.some((n) => VCN_HOSTED_OCI.has(n.serviceId))) {
    const vcnName = allocator.allocate('oci_vcn', '__implicit_oci_vcn__', 'main_vcn', 'vcn');
    allVcns.push(vcnName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['oci_core_vcn', vcnName],
          attributes: [
            hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
            hclAttr('cidr_blocks', hclList([hclLit('10.30.0.0/16')])),
            hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${vcnName}"`)),
          ],
        }),
      ),
    );
    const subName = allocator.allocate(
      'oci_subnet',
      '__implicit_oci_sub__',
      'regional_sub',
      'subnet',
    );
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['oci_core_subnet', subName],
          attributes: [
            hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
            hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnName}.id`)),
            hclAttr('cidr_block', hclLit('10.30.1.0/24')),
            hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
          ],
        }),
      ),
    );
  }

  const defaultVcn = allVcns[0] ?? null;

  for (const sub of ociSubnets) {
    const gId = sub.id.startsWith('sub-') ? sub.id.slice(4) : sub.id;
    const matched = ociSubnetGroups.find((g) => g.id === gId);
    const subName = allocator.allocate(
      'oci_subnet',
      matched ? matched.id : sub.id,
      matched?.label ?? sub.id.replace(/^sub-/, ''),
      'subnet',
    );
    const vcnRef = vcnRefByNetworkId.get(sub.networkId) ?? defaultVcn;
    subRefBySubnetId.set(sub.id, subName);
    if (matched) {
      subRefByGroupId.set(matched.id, subName);
      ctx.recordAddress(matched.id, `oci_core_subnet.${subName}`);
    }
    if (!vcnRef || emittedSubs.has(subName)) continue;
    emittedSubs.add(subName);
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['oci_core_subnet', subName],
          attributes: [
            hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
            hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
            hclAttr('cidr_block', hclLit(sub.cidr)),
            hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            ...(sub.autoAssignPublicIp === false
              ? [hclAttr('prohibit_public_ip_on_vnic', hclLit(true))]
              : []),
          ],
        }),
      ),
    );
  }

  const resolveVcnForGroup = (g: GroupInstance): string | null => {
    let cur: GroupInstance | undefined = g;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === 'vpc' && vcnRefByGroupId.has(cur.id)) {
        return vcnRefByGroupId.get(cur.id)!;
      }
      cur = cur.parentGroupId ? ctx.groupsById.get(cur.parentGroupId) : undefined;
    }
    return defaultVcn;
  };

  for (const sg of ociSubnetGroups) {
    if (subRefByGroupId.has(sg.id)) continue;
    const subName = allocator.allocate('oci_subnet', sg.id, sg.label, 'subnet');
    subRefByGroupId.set(sg.id, subName);
    ctx.recordAddress(sg.id, `oci_core_subnet.${subName}`);
    const vcnRef = resolveVcnForGroup(sg);
    if (!vcnRef || emittedSubs.has(subName)) continue;
    emittedSubs.add(subName);
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['oci_core_subnet', subName],
          attributes: [
            hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
            hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
            hclAttr('cidr_block', hclLit(sg.cidr?.trim() || '10.30.2.0/24')),
            hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
          ],
        }),
      ),
    );
  }

  const defaultSub = allSubs[0] ?? null;

  // Emit NSGs + edge-driven NSG rules for OCI nodes
  const nodeTfName = new Map<string, string>();
  const nodeNsgMap = new Map<string, string>();
  const nodeSubMap = new Map<string, string>();
  const nodeVcnMap = new Map<string, string>();

  for (const node of ociNodes) {
    const tfName = allocator.allocate(
      'oci_node',
      node.id,
      node.label,
      snakeCaseSlug(node.serviceId.replace(/^oci\./, ''), 'service'),
    );
    nodeTfName.set(node.id, tfName);
    const anc = ctx.resolveNodeAncestry(node);
    const attachedSubId = network.attachments.find((a) => a.nodeId === node.id)?.subnetId;
    const subRef =
      (anc.subnetGroup ? subRefByGroupId.get(anc.subnetGroup.id) : undefined) ??
      (attachedSubId ? subRefBySubnetId.get(attachedSubId) : undefined) ??
      defaultSub;
    const vcnRef = (anc.vpcGroup ? vcnRefByGroupId.get(anc.vpcGroup.id) : undefined) ?? defaultVcn;
    if (subRef) nodeSubMap.set(node.id, subRef);
    if (vcnRef) nodeVcnMap.set(node.id, vcnRef);
    if (vcnRef && VCN_HOSTED_OCI.has(node.serviceId)) {
      const nsgName = allocator.allocate('oci_nsg', `nsg-${node.id}`, `${tfName}_nsg`, 'nsg');
      nodeNsgMap.set(node.id, nsgName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['oci_core_network_security_group', nsgName],
            attributes: [
              hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
              hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${nsgName}"`)),
            ],
          }),
        ),
      );
    }
  }

  const sortedEdges = [...design.edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of sortedEdges) {
    const fromNode = ctx.nodesById.get(edge.from);
    const toNode = ctx.nodesById.get(edge.to);
    if (!fromNode || !toNode || !toNode.serviceId.startsWith('oci.')) continue;
    const toNsg = nodeNsgMap.get(toNode.id);
    if (!toNsg) continue;
    const fromNsg = nodeNsgMap.get(fromNode.id);
    const isFromInternet =
      INTERNET_CALLERS.has(fromNode.serviceId) || PUBLIC_ENTRY_OCI.has(toNode.serviceId);
    const port =
      edge.port ?? (edge.protocol === 'sql' ? 5432 : edge.protocol === 'http' ? 80 : 443);
    const ruleName = allocator.allocate(
      'oci_nsg_rule',
      `${edge.id}-${toNode.id}`,
      `${toNsg}_in_${port}`,
      'rule',
    );
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['oci_core_network_security_group_security_rule', ruleName],
          attributes: [
            hclAttr(
              'network_security_group_id',
              hclRef(`oci_core_network_security_group.${toNsg}.id`),
            ),
            hclAttr('direction', hclLit('INGRESS')),
            hclAttr('protocol', hclLit('6')),
            hclAttr('source_type', hclLit(fromNsg ? 'NETWORK_SECURITY_GROUP' : 'CIDR_BLOCK')),
            hclAttr(
              'source',
              fromNsg
                ? hclRef(`oci_core_network_security_group.${fromNsg}.id`)
                : hclLit(isFromInternet ? '0.0.0.0/0' : '10.30.0.0/16'),
            ),
          ],
          blocks: [
            hclBlock('tcp_options', {
              blocks: [
                hclBlock('destination_port_range', {
                  attributes: [hclAttr('min', hclLit(port)), hclAttr('max', hclLit(port))],
                }),
              ],
            }),
          ],
        }),
      ),
    );
  }

  // Emit Route Tables and Gateways present in network config
  for (const gw of [...network.gateways].sort((a, b) => a.id.localeCompare(b.id))) {
    const vcnRef = gw.networkId ? vcnRefByNetworkId.get(gw.networkId) : defaultVcn;
    if (!vcnRef) continue;
    if (gw.kind === 'igw') {
      const igwName = allocator.allocate('oci_igw', gw.id, 'igw', 'igw');
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['oci_core_internet_gateway', igwName],
            attributes: [
              hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
              hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${igwName}"`)),
            ],
          }),
        ),
      );
    } else if (gw.kind === 'service-gw') {
      const sgwName = allocator.allocate('oci_sgw', gw.id, 'service_gw', 'sgw');
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['oci_core_service_gateway', sgwName],
            attributes: [
              hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
              hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${sgwName}"`)),
            ],
          }),
        ),
      );
    }
  }

  for (const node of ociNodes) {
    const name = nodeTfName.get(node.id)!;
    const subRef = nodeSubMap.get(node.id);
    const vcnRef = nodeVcnMap.get(node.id);
    const nsgName = nodeNsgMap.get(node.id);
    const instances = Math.max(1, Math.round(node.config.instances || 1));

    switch (node.serviceId) {
      case 'oci.internet_gw':
        if (vcnRef) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_internet_gateway', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_core_internet_gateway.${name}`);
        }
        break;

      case 'oci.nat_gw':
        if (vcnRef) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_nat_gateway', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_core_nat_gateway.${name}`);
        }
        break;

      case 'oci.service_gw':
        if (vcnRef) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_service_gateway', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_core_service_gateway.${name}`);
        }
        break;

      case 'oci.drg':
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_core_drg', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_core_drg.${name}`);
        break;

      case 'oci.dns': {
        const domainVar = ctx.addVariable({
          name: `${name}_zone_name`,
          type: 'string',
          description: `TODO: OCI DNS zone name for ${node.label} (e.g. example.com)`,
        });
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_dns_zone', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclRef(`var.${domainVar}`)),
                hclAttr('zone_type', hclLit('PRIMARY')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_dns_zone.${name}`);
        break;
      }

      case 'oci.compute': {
        const adVar = ctx.addVariable({
          name: 'oci_availability_domain',
          type: 'string',
          description:
            'TODO: OCI availability domain name (from data.oci_identity_availability_domains).',
        });
        const imgVar = ctx.addVariable({
          name: 'oci_image_id',
          type: 'string',
          description: 'TODO: OCI Oracle Linux / Ubuntu image OCID in this region.',
        });
        const ocpus = Math.max(1, (node.config.vcpu ?? 2) / 2);
        const memGb = Math.max(1, node.config.memoryGb ?? 8);
        const shape = node.config.instanceType || 'VM.Standard.E4.Flex';
        if (node.config.autoscaling) {
          const cfgName = `${name}_cfg`;
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_instance_configuration', cfgName],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${cfgName}"`)),
                ],
                blocks: [
                  hclBlock('instance_details', {
                    attributes: [hclAttr('instance_type', hclLit('compute'))],
                    blocks: [
                      hclBlock('launch_details', {
                        attributes: [
                          hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                          hclAttr('shape', hclLit(shape)),
                        ],
                        blocks: [
                          hclBlock('shape_config', {
                            attributes: [
                              hclAttr('ocpus', hclLit(ocpus)),
                              hclAttr('memory_in_gbs', hclLit(memGb)),
                            ],
                          }),
                          hclBlock('source_details', {
                            attributes: [
                              hclAttr('source_type', hclLit('image')),
                              hclAttr('image_id', hclRef(`var.${imgVar}`)),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ),
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_instance_pool', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr(
                    'instance_configuration_id',
                    hclRef(`oci_core_instance_configuration.${cfgName}.id`),
                  ),
                  hclAttr('size', hclLit(Math.max(node.config.autoscaling.min, instances))),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
                blocks: [
                  hclBlock('placement_configurations', {
                    attributes: [
                      hclAttr('availability_domain', hclRef(`var.${adVar}`)),
                      ...(subRef
                        ? [hclAttr('primary_subnet_id', hclRef(`oci_core_subnet.${subRef}.id`))]
                        : []),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_core_instance_pool.${name}`);
        } else {
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_core_instance', name],
                attributes: [
                  ...(instances > 1 ? [hclAttr('count', hclLit(instances))] : []),
                  hclAttr('availability_domain', hclRef(`var.${adVar}`)),
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('shape', hclLit(shape)),
                ],
                blocks: [
                  hclBlock('shape_config', {
                    attributes: [
                      hclAttr('ocpus', hclLit(ocpus)),
                      hclAttr('memory_in_gbs', hclLit(memGb)),
                    ],
                  }),
                  hclBlock('source_details', {
                    attributes: [
                      hclAttr('source_type', hclLit('image')),
                      hclAttr('source_id', hclRef(`var.${imgVar}`)),
                    ],
                  }),
                  ...(subRef
                    ? [
                        hclBlock('create_vnic_details', {
                          attributes: [
                            hclAttr('subnet_id', hclRef(`oci_core_subnet.${subRef}.id`)),
                            ...(nsgName
                              ? [
                                  hclAttr(
                                    'nsg_ids',
                                    hclList([
                                      hclRef(`oci_core_network_security_group.${nsgName}.id`),
                                    ]),
                                  ),
                                ]
                              : []),
                          ],
                        }),
                      ]
                    : []),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_core_instance.${name}`);
        }
        break;
      }

      case 'oci.load_balancer': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_load_balancer_load_balancer', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('shape', hclLit('flexible')),
                hclAttr(
                  'subnet_ids',
                  hclList(subRef ? [hclRef(`oci_core_subnet.${subRef}.id`)] : []),
                ),
                ...(nsgName
                  ? [
                      hclAttr(
                        'network_security_group_ids',
                        hclList([hclRef(`oci_core_network_security_group.${nsgName}.id`)]),
                      ),
                    ]
                  : []),
              ],
              blocks: [
                hclBlock('shape_details', {
                  attributes: [
                    hclAttr('minimum_bandwidth_in_mbps', hclLit(10)),
                    hclAttr('maximum_bandwidth_in_mbps', hclLit(100)),
                  ],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_load_balancer_backend_set', `${name}_bs`],
              attributes: [
                hclAttr('load_balancer_id', hclRef(`oci_load_balancer_load_balancer.${name}.id`)),
                hclAttr('name', hclLit(`${name}_backend`)),
                hclAttr('policy', hclLit('ROUND_ROBIN')),
              ],
              blocks: [
                hclBlock('health_checker', {
                  attributes: [hclAttr('protocol', hclLit('HTTP')), hclAttr('port', hclLit(8080))],
                }),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_load_balancer_listener', `${name}_listener`],
              attributes: [
                hclAttr('load_balancer_id', hclRef(`oci_load_balancer_load_balancer.${name}.id`)),
                hclAttr('name', hclLit(`${name}_http`)),
                hclAttr(
                  'default_backend_set_name',
                  hclRef(`oci_load_balancer_backend_set.${name}_bs.name`),
                ),
                hclAttr('port', hclLit(80)),
                hclAttr('protocol', hclLit('HTTP')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_load_balancer_load_balancer.${name}`);
        break;
      }

      case 'oci.network_lb': {
        if (subRef) {
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_network_load_balancer_network_load_balancer', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('subnet_id', hclRef(`oci_core_subnet.${subRef}.id`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_network_load_balancer_network_load_balancer.${name}`);
        }
        break;
      }

      case 'oci.functions': {
        const appName = `${name}_app`;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_functions_application', appName],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${appName}"`)),
                hclAttr(
                  'subnet_ids',
                  hclList(subRef ? [hclRef(`oci_core_subnet.${subRef}.id`)] : []),
                ),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_functions_function', name],
              attributes: [
                hclAttr('application_id', hclRef(`oci_functions_application.${appName}.id`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr(
                  'memory_in_mbs',
                  hclLit(String(Math.max(128, Math.round((node.config.memoryGb ?? 0.5) * 1024)))),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_functions_function.${name}`);
        break;
      }

      case 'oci.oke': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_containerengine_cluster', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('kubernetes_version', hclLit('v1.30.1')),
                ...(vcnRef ? [hclAttr('vcn_id', hclRef(`oci_core_vcn.${vcnRef}.id`))] : []),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_containerengine_node_pool', `${name}_pool`],
              attributes: [
                hclAttr('cluster_id', hclRef(`oci_containerengine_cluster.${name}.id`)),
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclLit('default-pool')),
                hclAttr('node_shape', hclLit(node.config.instanceType || 'VM.Standard.E4.Flex')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_containerengine_cluster.${name}`);
        break;
      }

      case 'oci.api_gateway': {
        if (subRef) {
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_apigateway_gateway', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('endpoint_type', hclLit('PUBLIC')),
                  hclAttr('subnet_id', hclRef(`oci_core_subnet.${subRef}.id`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_apigateway_gateway.${name}`);
        }
        break;
      }

      case 'oci.object_storage':
      case 'oci.archive_storage': {
        const nsVar = ctx.addVariable({
          name: 'oci_object_namespace',
          type: 'string',
          description: 'TODO: OCI Object Storage tenancy namespace.',
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_objectstorage_bucket', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('namespace', hclRef(`var.${nsVar}`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_objectstorage_bucket.${name}`);
        break;
      }

      case 'oci.block_volume': {
        const adVar = ctx.addVariable({
          name: 'oci_availability_domain',
          type: 'string',
          description: 'TODO: OCI availability domain name.',
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_core_volume', name],
              attributes: [
                hclAttr('availability_domain', hclRef(`var.${adVar}`)),
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr(
                  'size_in_gbs',
                  hclLit(Math.max(50, Math.round(node.config.storageGb ?? 50))),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_core_volume.${name}`);
        break;
      }

      case 'oci.autonomous_atp':
      case 'oci.autonomous_adw': {
        const passVar = ctx.addVariable({
          name: `${name}_admin_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for OCI Autonomous Database (${node.label}).`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_database_autonomous_database', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr(
                  'db_name',
                  hclLit(name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 14) || 'infrasimdb'),
                ),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr(
                  'db_workload',
                  hclLit(node.serviceId === 'oci.autonomous_atp' ? 'OLTP' : 'DW'),
                ),
                hclAttr('admin_password', hclRef(`var.${passVar}`)),
                hclAttr('compute_model', hclLit('ECPU')),
                hclAttr('compute_count', hclLit(2)),
                hclAttr('data_storage_size_in_tbs', hclLit(1)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_database_autonomous_database.${name}`);
        break;
      }

      case 'oci.mysql_heatwave': {
        const adVar = ctx.addVariable({
          name: 'oci_availability_domain',
          type: 'string',
          description: 'TODO: OCI availability domain name.',
        });
        const passVar = ctx.addVariable({
          name: `${name}_admin_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for OCI MySQL HeatWave (${node.label}).`,
        });
        if (subRef) {
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_mysql_mysql_db_system', name],
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('availability_domain', hclRef(`var.${adVar}`)),
                  hclAttr(
                    'shape_name',
                    hclLit(node.config.instanceType || 'MySQL.VM.Standard.E4.1.8GB'),
                  ),
                  hclAttr('subnet_id', hclRef(`oci_core_subnet.${subRef}.id`)),
                  hclAttr('admin_username', hclLit('admin')),
                  hclAttr('admin_password', hclRef(`var.${passVar}`)),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_mysql_mysql_db_system.${name}`);
        }
        break;
      }

      case 'oci.postgres': {
        const passVar = ctx.addVariable({
          name: `${name}_admin_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for OCI Database with PostgreSQL (${node.label}).`,
        });
        if (subRef) {
          buckets.data.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['oci_psql_db_system', name],
                ...commentIf(ctx, [
                  'Verified oracle/oci provider resource for OCI Database with PostgreSQL.',
                ]),
                attributes: [
                  hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                  hclAttr('db_version', hclLit('15')),
                  hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('shape', hclLit(node.config.instanceType || 'VM.Standard.E4.Flex')),
                  hclAttr('instance_ocpu_count', hclLit(2)),
                  hclAttr('instance_memory_size_in_gbs', hclLit(16)),
                ],
                blocks: [
                  hclBlock('network_details', {
                    attributes: [hclAttr('subnet_id', hclRef(`oci_core_subnet.${subRef}.id`))],
                  }),
                  hclBlock('storage_details', {
                    attributes: [
                      hclAttr('is_regionally_durable', hclLit(true)),
                      hclAttr('system_type', hclLit('OCI_OPTIMIZED_STORAGE')),
                    ],
                  }),
                  hclBlock('credentials', {
                    attributes: [hclAttr('username', hclLit('pgadmin'))],
                    blocks: [
                      hclBlock('password_details', {
                        attributes: [
                          hclAttr('password_type', hclLit('PLAIN_TEXT')),
                          hclAttr('password', hclRef(`var.${passVar}`)),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `oci_psql_db_system.${name}`);
        }
        break;
      }

      case 'oci.nosql': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_nosql_table', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclRaw(`"\${replace(var.name_prefix, "-", "_")}_${name}"`)),
                hclAttr(
                  'ddl_statement',
                  hclLit(`CREATE TABLE IF NOT EXISTS ${name} (id STRING, PRIMARY KEY(id))`),
                ),
              ],
              blocks: [
                hclBlock('table_limits', {
                  attributes: [
                    hclAttr('max_read_units', hclLit(50)),
                    hclAttr('max_write_units', hclLit(50)),
                    hclAttr('max_storage_in_gbs', hclLit(25)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_nosql_table.${name}`);
        break;
      }

      case 'oci.streaming': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_streaming_stream', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('partitions', hclLit(instances)),
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_streaming_stream.${name}`);
        break;
      }

      case 'oci.queue': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_queue_queue', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_queue_queue.${name}`);
        break;
      }

      case 'oci.notifications': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_ons_notification_topic', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_ons_notification_topic.${name}`);
        break;
      }

      case 'oci.vault_secrets': {
        const vaultVar = ctx.addVariable({
          name: `${name}_vault_id`,
          type: 'string',
          description: `TODO: OCI Vault OCID for secret ${node.label}.`,
        });
        const keyVar = ctx.addVariable({
          name: `${name}_key_id`,
          type: 'string',
          description: `TODO: OCI Vault master encryption key OCID for ${node.label}.`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_vault_secret', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('secret_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('vault_id', hclRef(`var.${vaultVar}`)),
                hclAttr('key_id', hclRef(`var.${keyVar}`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_vault_secret.${name}`);
        break;
      }

      case 'oci.genai': {
        const clusterName = `${name}_cluster`;
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_generative_ai_dedicated_ai_cluster', clusterName],
              ...commentIf(ctx, [
                `Dedicated OCI Generative AI cluster + endpoint for ${node.label}.`,
              ]),
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${clusterName}"`)),
                hclAttr('type', hclLit('HOSTING')),
                hclAttr('unit_count', hclLit(Math.max(1, node.config.ai?.provisionedUnits ?? 1))),
                hclAttr('unit_shape', hclLit('LARGE_COHERE')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['oci_generative_ai_endpoint', name],
              attributes: [
                hclAttr('compartment_id', hclRef(`var.${compartmentVar}`)),
                hclAttr(
                  'dedicated_ai_cluster_id',
                  hclRef(`oci_generative_ai_dedicated_ai_cluster.${clusterName}.id`),
                ),
                hclAttr('model_id', hclLit(node.config.ai?.modelLabel || 'cohere.command-r-plus')),
                hclAttr('display_name', hclRaw(`"\${var.name_prefix}-${name}"`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `oci_generative_ai_dedicated_ai_cluster.${clusterName}`);
        ctx.recordAddress(node.id, `oci_generative_ai_endpoint.${name}`);
        break;
      }

      default: {
        buckets.compute.push(
          hclCommentStmt(`InfraSim: no Terraform mapping for ${node.serviceId} (${node.label})`),
        );
        ctx.addUnsupported(node, `No v1 OCI Terraform resource mapping for ${node.serviceId}`);
        break;
      }
    }
  }
}
