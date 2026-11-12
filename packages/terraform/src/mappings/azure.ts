import type { GroupInstance, NodeInstance } from '@infrasim/shared-types';
import {
  hclAttr,
  hclBlock,
  hclBlockStmt,
  hclCommentStmt,
  hclList,
  hclLit,
  hclMap,
  hclRaw,
  hclRef,
} from '../hcl/ast.js';
import { isSecretKeyName, snakeCaseSlug } from '../naming.js';
import type { HclExpr } from '../types.js';
import type { TerraformExportContext } from './types.js';

const VNET_HOSTED_AZURE = new Set([
  'azure.vm',
  'azure.load_balancer',
  'azure.app_gateway',
  'azure.aks',
  'azure.container_apps',
  'azure.postgres_flexible',
  'azure.mysql_flexible',
  'azure.redis_cache',
  'azure.nat_gateway',
  'azure.private_link',
  'azure.firewall',
]);

const INTERNET_CALLERS = new Set([
  'generic.client',
  'generic.users',
  'azure.front_door',
  'azure.cdn',
]);
const PUBLIC_ENTRY_AZURE = new Set([
  'azure.app_gateway',
  'azure.load_balancer',
  'azure.front_door',
  'azure.apim',
  'azure.waf',
]);

function azureEnvEntries(
  ctx: TerraformExportContext,
  node: NodeInstance,
  scopeSlug: string,
): Array<[string, HclExpr]> {
  const merged: Record<string, string> = {};
  const script = node.config.scriptId
    ? ctx.design.scripts.find((s) => s.id === node.config.scriptId)
    : undefined;
  if (script?.env) Object.assign(merged, script.env);
  if (node.config.mockEnv) Object.assign(merged, node.config.mockEnv);
  return Object.entries(merged)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      if (isSecretKeyName(k)) {
        const varName = ctx.addVariable({
          name: `${scopeSlug}_env_${snakeCaseSlug(k, 'secret')}`,
          type: 'string',
          sensitive: true,
          description: `Sensitive app setting for ${node.label} (${k}).`,
        });
        return [k, hclRef(`var.${varName}`)];
      }
      return [k, hclLit(v)];
    });
}

function commentIf(ctx: TerraformExportContext, lines: string[]): { comments?: string[] } {
  return ctx.includeComments ? { comments: lines } : {};
}

/** Exports the Microsoft Azure subset of a Design into `ctx.buckets`. */
export function mapAzureToTerraform(ctx: TerraformExportContext): void {
  const { design, allocator, network, buckets } = ctx;

  const azNodes = [...design.nodes]
    .filter((n) => n.serviceId.startsWith('azure.'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const azNetworks = [...network.networks]
    .filter((n) => n.provider === 'azure')
    .sort((a, b) => a.id.localeCompare(b.id));

  const azVnetGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'vpc' &&
        (g.provider === 'azure' || (!g.provider && design.settings.primaryProvider === 'azure')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const azSubnetGroups = [...design.groups]
    .filter(
      (g) =>
        g.kind === 'subnet' &&
        (g.provider === 'azure' || (!g.provider && design.settings.primaryProvider === 'azure')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const azNetworkIds = new Set(azNetworks.map((n) => n.id));
  const azSubnets = [...network.subnets]
    .filter((s) => azNetworkIds.has(s.networkId))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (
    azNodes.length === 0 &&
    azNetworks.length === 0 &&
    azVnetGroups.length === 0 &&
    azSubnetGroups.length === 0
  ) {
    return;
  }

  const azRegionVar = ctx.addVariable({
    name: 'azure_region',
    type: 'string',
    defaultValue: ctx.regions.azure,
    description: 'Azure location for Resource Group and services.',
  });

  buckets.providers.push(
    hclBlockStmt(
      hclBlock('provider', {
        labels: ['azurerm'],
        ...commentIf(ctx, ['Microsoft Azure provider configuration.']),
        blocks: [hclBlock('features')],
      }),
    ),
  );

  const rgName = allocator.allocate('az_rg', '__rg__', 'main', 'main');
  buckets.network.push(
    hclBlockStmt(
      hclBlock('resource', {
        labels: ['azurerm_resource_group', rgName],
        attributes: [
          hclAttr('name', hclRaw(`"\${var.name_prefix}-rg"`)),
          hclAttr('location', hclRef(`var.${azRegionVar}`)),
        ],
      }),
    ),
  );

  allocator.preallocate([
    ...azVnetGroups.map((g) => ({
      scope: 'az_vnet',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'vnet',
    })),
    ...azNetworks.map((n) => ({
      scope: 'az_vnet',
      entityId: n.id,
      rawLabel: n.name || 'vnet',
      fallback: 'vnet',
    })),
    ...azSubnetGroups.map((g) => ({
      scope: 'az_subnet',
      entityId: g.id,
      rawLabel: g.label,
      fallback: 'subnet',
    })),
    ...azSubnets.map((s) => ({
      scope: 'az_subnet',
      entityId: s.id,
      rawLabel: s.id.replace(/^sub-/, ''),
      fallback: 'subnet',
    })),
    ...azNodes.map((n) => ({
      scope: 'az_node',
      entityId: n.id,
      rawLabel: n.label,
      fallback: snakeCaseSlug(n.serviceId.replace(/^azure\./, ''), 'service'),
    })),
  ]);

  const vnetRefByNetworkId = new Map<string, string>();
  const vnetRefByGroupId = new Map<string, string>();
  const subRefBySubnetId = new Map<string, string>();
  const subRefByGroupId = new Map<string, string>();
  const allVnets: string[] = [];
  const allSubs: string[] = [];
  const emittedVnets = new Set<string>();
  const emittedSubs = new Set<string>();

  for (const netObj of azNetworks) {
    const gId = netObj.id.startsWith('net-') ? netObj.id.slice(4) : netObj.id;
    const matched = azVnetGroups.find((g) => g.id === gId);
    const vnetName = allocator.allocate(
      'az_vnet',
      matched ? matched.id : netObj.id,
      netObj.name || matched?.label || 'vnet',
      'vnet',
    );
    vnetRefByNetworkId.set(netObj.id, vnetName);
    if (matched) {
      vnetRefByGroupId.set(matched.id, vnetName);
      ctx.recordAddress(matched.id, `azurerm_virtual_network.${vnetName}`);
    }
    if (!emittedVnets.has(vnetName)) {
      emittedVnets.add(vnetName);
      allVnets.push(vnetName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['azurerm_virtual_network', vnetName],
            attributes: [
              hclAttr('name', hclRaw(`"\${var.name_prefix}-${vnetName}"`)),
              hclAttr('address_space', hclList(netObj.cidrs.map((c) => hclLit(c)))),
              hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
              hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            ],
          }),
        ),
      );
    }
  }

  for (const g of azVnetGroups) {
    if (vnetRefByGroupId.has(g.id)) continue;
    const vnetName = allocator.allocate('az_vnet', g.id, g.label, 'vnet');
    vnetRefByGroupId.set(g.id, vnetName);
    ctx.recordAddress(g.id, `azurerm_virtual_network.${vnetName}`);
    if (!emittedVnets.has(vnetName)) {
      emittedVnets.add(vnetName);
      allVnets.push(vnetName);
      buckets.network.push(
        hclBlockStmt(
          hclBlock('resource', {
            labels: ['azurerm_virtual_network', vnetName],
            attributes: [
              hclAttr('name', hclRaw(`"\${var.name_prefix}-${vnetName}"`)),
              hclAttr('address_space', hclList([hclLit(g.cidr?.trim() || '10.20.0.0/16')])),
              hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
              hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            ],
          }),
        ),
      );
    }
  }

  if (allVnets.length === 0 && azNodes.some((n) => VNET_HOSTED_AZURE.has(n.serviceId))) {
    const vnetName = allocator.allocate('az_vnet', '__implicit_az_vnet__', 'main_vnet', 'vnet');
    allVnets.push(vnetName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_virtual_network', vnetName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${vnetName}"`)),
            hclAttr('address_space', hclList([hclLit('10.20.0.0/16')])),
            hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
          ],
        }),
      ),
    );
    const subName = allocator.allocate('az_subnet', '__implicit_az_sub__', 'default', 'subnet');
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_subnet', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            hclAttr('virtual_network_name', hclRef(`azurerm_virtual_network.${vnetName}.name`)),
            hclAttr('address_prefixes', hclList([hclLit('10.20.1.0/24')])),
          ],
        }),
      ),
    );
  }

  const defaultVnet = allVnets[0] ?? null;

  for (const sub of azSubnets) {
    const gId = sub.id.startsWith('sub-') ? sub.id.slice(4) : sub.id;
    const matched = azSubnetGroups.find((g) => g.id === gId);
    const subName = allocator.allocate(
      'az_subnet',
      matched ? matched.id : sub.id,
      matched?.label ?? sub.id.replace(/^sub-/, ''),
      'subnet',
    );
    const vnetRef = vnetRefByNetworkId.get(sub.networkId) ?? defaultVnet;
    subRefBySubnetId.set(sub.id, subName);
    if (matched) {
      subRefByGroupId.set(matched.id, subName);
      ctx.recordAddress(matched.id, `azurerm_subnet.${subName}`);
    }
    if (!vnetRef || emittedSubs.has(subName)) continue;
    emittedSubs.add(subName);
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_subnet', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            hclAttr('virtual_network_name', hclRef(`azurerm_virtual_network.${vnetRef}.name`)),
            hclAttr('address_prefixes', hclList([hclLit(sub.cidr)])),
          ],
        }),
      ),
    );
  }

  const resolveVnetForGroup = (g: GroupInstance): string | null => {
    let cur: GroupInstance | undefined = g;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === 'vpc' && vnetRefByGroupId.has(cur.id)) {
        return vnetRefByGroupId.get(cur.id)!;
      }
      cur = cur.parentGroupId ? ctx.groupsById.get(cur.parentGroupId) : undefined;
    }
    return defaultVnet;
  };

  for (const sg of azSubnetGroups) {
    if (subRefByGroupId.has(sg.id)) continue;
    const subName = allocator.allocate('az_subnet', sg.id, sg.label, 'subnet');
    subRefByGroupId.set(sg.id, subName);
    ctx.recordAddress(sg.id, `azurerm_subnet.${subName}`);
    const vnetRef = resolveVnetForGroup(sg);
    if (!vnetRef || emittedSubs.has(subName)) continue;
    emittedSubs.add(subName);
    allSubs.push(subName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_subnet', subName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${subName}"`)),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            hclAttr('virtual_network_name', hclRef(`azurerm_virtual_network.${vnetRef}.name`)),
            hclAttr('address_prefixes', hclList([hclLit(sg.cidr?.trim() || '10.20.2.0/24')])),
          ],
        }),
      ),
    );
  }

  const defaultSub = allSubs[0] ?? null;

  // Emit NSGs + edge-driven rules
  const nsgNameBySub = new Map<string, string>();
  for (const subName of allSubs) {
    const nsgName = allocator.allocate('az_nsg', `nsg-${subName}`, `${subName}_nsg`, 'nsg');
    nsgNameBySub.set(subName, nsgName);
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_network_security_group', nsgName],
          attributes: [
            hclAttr('name', hclRaw(`"\${var.name_prefix}-${nsgName}"`)),
            hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
          ],
        }),
      ),
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_subnet_network_security_group_association', `${nsgName}_assoc`],
          attributes: [
            hclAttr('subnet_id', hclRef(`azurerm_subnet.${subName}.id`)),
            hclAttr(
              'network_security_group_id',
              hclRef(`azurerm_network_security_group.${nsgName}.id`),
            ),
          ],
        }),
      ),
    );
  }

  const nodeTfName = new Map<string, string>();
  const nodeSubMap = new Map<string, string>();
  for (const node of azNodes) {
    const tfName = allocator.allocate(
      'az_node',
      node.id,
      node.label,
      snakeCaseSlug(node.serviceId.replace(/^azure\./, ''), 'service'),
    );
    nodeTfName.set(node.id, tfName);
    const anc = ctx.resolveNodeAncestry(node);
    const attachedSubId = network.attachments.find((a) => a.nodeId === node.id)?.subnetId;
    const subRef =
      (anc.subnetGroup ? subRefByGroupId.get(anc.subnetGroup.id) : undefined) ??
      (attachedSubId ? subRefBySubnetId.get(attachedSubId) : undefined) ??
      defaultSub;
    if (subRef) nodeSubMap.set(node.id, subRef);
  }

  const sortedEdges = [...design.edges].sort((a, b) => a.id.localeCompare(b.id));
  let rulePriority = 100;
  for (const edge of sortedEdges) {
    const fromNode = ctx.nodesById.get(edge.from);
    const toNode = ctx.nodesById.get(edge.to);
    if (!fromNode || !toNode || !toNode.serviceId.startsWith('azure.')) continue;
    const toSub = nodeSubMap.get(toNode.id);
    const nsgName = toSub ? nsgNameBySub.get(toSub) : undefined;
    if (!nsgName) continue;
    const isFromInternet =
      INTERNET_CALLERS.has(fromNode.serviceId) || PUBLIC_ENTRY_AZURE.has(toNode.serviceId);
    const port =
      edge.port ??
      (edge.protocol === 'sql'
        ? 5432
        : edge.protocol === 'redis'
          ? 6379
          : edge.protocol === 'http'
            ? 80
            : 443);
    const ruleName = allocator.allocate(
      'az_nsg_rule',
      `${edge.id}-${toNode.id}`,
      `allow_${nodeTfName.get(toNode.id)}_${port}`,
      'rule',
    );
    buckets.network.push(
      hclBlockStmt(
        hclBlock('resource', {
          labels: ['azurerm_network_security_rule', ruleName],
          attributes: [
            hclAttr('name', hclLit(ruleName)),
            hclAttr('priority', hclLit(rulePriority)),
            hclAttr('direction', hclLit('Inbound')),
            hclAttr('access', hclLit('Allow')),
            hclAttr('protocol', hclLit('Tcp')),
            hclAttr('source_port_range', hclLit('*')),
            hclAttr('destination_port_range', hclLit(String(port))),
            hclAttr('source_address_prefix', hclLit(isFromInternet ? '*' : 'VirtualNetwork')),
            hclAttr('destination_address_prefix', hclLit('*')),
            hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
            hclAttr(
              'network_security_group_name',
              hclRef(`azurerm_network_security_group.${nsgName}.name`),
            ),
          ],
        }),
      ),
    );
    rulePriority += 10;
  }

  for (const node of azNodes) {
    const name = nodeTfName.get(node.id)!;
    const subRef = nodeSubMap.get(node.id);
    const instances = Math.max(1, Math.round(node.config.instances || 1));

    switch (node.serviceId) {
      case 'azure.nat_gateway': {
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_nat_gateway', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('sku_name', hclLit('Standard')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_nat_gateway.${name}`);
        break;
      }

      case 'azure.vnet_peering': {
        if (allVnets.length >= 2) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_virtual_network_peering', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                  hclAttr(
                    'virtual_network_name',
                    hclRef(`azurerm_virtual_network.${allVnets[0]!}.name`),
                  ),
                  hclAttr(
                    'remote_virtual_network_id',
                    hclRef(`azurerm_virtual_network.${allVnets[1]!}.id`),
                  ),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `azurerm_virtual_network_peering.${name}`);
        } else if (defaultVnet) {
          const remoteVar = ctx.addVariable({
            name: `${name}_remote_vnet_id`,
            type: 'string',
            description: `TODO: remote Azure Virtual Network resource ID for peering ${node.label}.`,
          });
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_virtual_network_peering', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                  hclAttr(
                    'virtual_network_name',
                    hclRef(`azurerm_virtual_network.${defaultVnet}.name`),
                  ),
                  hclAttr('remote_virtual_network_id', hclRef(`var.${remoteVar}`)),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `azurerm_virtual_network_peering.${name}`);
        }
        break;
      }

      case 'azure.dns': {
        const domainVar = ctx.addVariable({
          name: `${name}_zone_name`,
          type: 'string',
          description: `TODO: Azure DNS zone domain name for ${node.label} (e.g. example.com)`,
        });
        buckets.network.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_dns_zone', name],
              attributes: [
                hclAttr('name', hclRef(`var.${domainVar}`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_dns_zone.${name}`);
        break;
      }

      case 'azure.private_link': {
        const targetIdVar = ctx.addVariable({
          name: `${name}_target_resource_id`,
          type: 'string',
          description: `TODO: target PaaS resource ID for Private Endpoint ${node.label}.`,
        });
        if (subRef) {
          buckets.network.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_private_endpoint', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                  hclAttr('subnet_id', hclRef(`azurerm_subnet.${subRef}.id`)),
                ],
                blocks: [
                  hclBlock('private_service_connection', {
                    attributes: [
                      hclAttr('name', hclLit(`${name}-psc`)),
                      hclAttr('private_connection_resource_id', hclRef(`var.${targetIdVar}`)),
                      hclAttr('is_manual_connection', hclLit(false)),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `azurerm_private_endpoint.${name}`);
        }
        break;
      }

      case 'azure.vm': {
        const vmSize = node.config.instanceType || 'Standard_B2s';
        const sshVar = ctx.addVariable({
          name: `${name}_ssh_public_key`,
          type: 'string',
          sensitive: true,
          description: `SSH public key for Azure Linux VM ${node.label}.`,
        });
        if (node.config.autoscaling) {
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_linux_virtual_machine_scale_set', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                  hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                  hclAttr('sku', hclLit(vmSize)),
                  hclAttr('instances', hclLit(instances)),
                  hclAttr('admin_username', hclLit('azureuser')),
                ],
                blocks: [
                  hclBlock('admin_ssh_key', {
                    attributes: [
                      hclAttr('username', hclLit('azureuser')),
                      hclAttr('public_key', hclRef(`var.${sshVar}`)),
                    ],
                  }),
                  hclBlock('source_image_reference', {
                    attributes: [
                      hclAttr('publisher', hclLit('Canonical')),
                      hclAttr('offer', hclLit('0001-com-ubuntu-server-jammy')),
                      hclAttr('sku', hclLit('22_04-lts')),
                      hclAttr('version', hclLit('latest')),
                    ],
                  }),
                  hclBlock('os_disk', {
                    attributes: [
                      hclAttr('storage_account_type', hclLit('Standard_LRS')),
                      hclAttr('caching', hclLit('ReadWrite')),
                    ],
                  }),
                  ...(subRef
                    ? [
                        hclBlock('network_interface', {
                          attributes: [
                            hclAttr('name', hclLit(`${name}-nic`)),
                            hclAttr('primary', hclLit(true)),
                          ],
                          blocks: [
                            hclBlock('ip_configuration', {
                              attributes: [
                                hclAttr('name', hclLit('internal')),
                                hclAttr('primary', hclLit(true)),
                                hclAttr('subnet_id', hclRef(`azurerm_subnet.${subRef}.id`)),
                              ],
                            }),
                          ],
                        }),
                      ]
                    : []),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `azurerm_linux_virtual_machine_scale_set.${name}`);
        } else {
          const nicName = `${name}_nic`;
          buckets.compute.push(
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_network_interface', nicName],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${nicName}"`)),
                  hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                ],
                blocks: [
                  hclBlock('ip_configuration', {
                    attributes: [
                      hclAttr('name', hclLit('internal')),
                      ...(subRef
                        ? [hclAttr('subnet_id', hclRef(`azurerm_subnet.${subRef}.id`))]
                        : []),
                      hclAttr('private_ip_address_allocation', hclLit('Dynamic')),
                    ],
                  }),
                ],
              }),
            ),
            hclBlockStmt(
              hclBlock('resource', {
                labels: ['azurerm_linux_virtual_machine', name],
                attributes: [
                  hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                  hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                  hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                  hclAttr('size', hclLit(vmSize)),
                  hclAttr('admin_username', hclLit('azureuser')),
                  hclAttr(
                    'network_interface_ids',
                    hclList([hclRef(`azurerm_network_interface.${nicName}.id`)]),
                  ),
                ],
                blocks: [
                  hclBlock('admin_ssh_key', {
                    attributes: [
                      hclAttr('username', hclLit('azureuser')),
                      hclAttr('public_key', hclRef(`var.${sshVar}`)),
                    ],
                  }),
                  hclBlock('os_disk', {
                    attributes: [
                      hclAttr('caching', hclLit('ReadWrite')),
                      hclAttr('storage_account_type', hclLit('Standard_LRS')),
                    ],
                  }),
                  hclBlock('source_image_reference', {
                    attributes: [
                      hclAttr('publisher', hclLit('Canonical')),
                      hclAttr('offer', hclLit('0001-com-ubuntu-server-jammy')),
                      hclAttr('sku', hclLit('22_04-lts')),
                      hclAttr('version', hclLit('latest')),
                    ],
                  }),
                ],
              }),
            ),
          );
          ctx.recordAddress(node.id, `azurerm_linux_virtual_machine.${name}`);
        }
        break;
      }

      case 'azure.load_balancer': {
        const pipName = `${name}_pip`;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_public_ip', pipName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${pipName}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('allocation_method', hclLit('Static')),
                hclAttr('sku', hclLit('Standard')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_lb', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('sku', hclLit('Standard')),
              ],
              blocks: [
                hclBlock('frontend_ip_configuration', {
                  attributes: [
                    hclAttr('name', hclLit('PublicIPAddress')),
                    hclAttr('public_ip_address_id', hclRef(`azurerm_public_ip.${pipName}.id`)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_lb.${name}`);
        break;
      }

      case 'azure.app_gateway': {
        const pipName = `${name}_pip`;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_public_ip', pipName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${pipName}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('allocation_method', hclLit('Static')),
                hclAttr('sku', hclLit('Standard')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_application_gateway', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
              ],
              blocks: [
                hclBlock('sku', {
                  attributes: [
                    hclAttr('name', hclLit('Standard_v2')),
                    hclAttr('tier', hclLit('Standard_v2')),
                    hclAttr('capacity', hclLit(instances)),
                  ],
                }),
                ...(subRef
                  ? [
                      hclBlock('gateway_ip_configuration', {
                        attributes: [
                          hclAttr('name', hclLit('gw-ip-cfg')),
                          hclAttr('subnet_id', hclRef(`azurerm_subnet.${subRef}.id`)),
                        ],
                      }),
                    ]
                  : []),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_application_gateway.${name}`);
        break;
      }

      case 'azure.app_service': {
        const planName = `${name}_plan`;
        const envs = azureEnvEntries(ctx, node, name);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_service_plan', planName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${planName}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('os_type', hclLit('Linux')),
                hclAttr('sku_name', hclLit('B1')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_linux_web_app', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('service_plan_id', hclRef(`azurerm_service_plan.${planName}.id`)),
                ...(envs.length > 0 ? [hclAttr('app_settings', hclMap(envs))] : []),
              ],
              blocks: [hclBlock('site_config')],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_linux_web_app.${name}`);
        break;
      }

      case 'azure.functions':
      case 'azure.functions_flex': {
        const stgName = `${name}_stg`;
        const planName = `${name}_plan`;
        const envs = azureEnvEntries(ctx, node, name);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_storage_account', stgName],
              attributes: [
                hclAttr(
                  'name',
                  hclRaw(`replace(lower("\${var.name_prefix}${name}fn"), "/[^a-z0-9]/", "")`),
                ),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('account_tier', hclLit('Standard')),
                hclAttr('account_replication_type', hclLit('LRS')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_service_plan', planName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${planName}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('os_type', hclLit('Linux')),
                hclAttr('sku_name', hclLit('Y1')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_linux_function_app', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('storage_account_name', hclRef(`azurerm_storage_account.${stgName}.name`)),
                hclAttr(
                  'storage_account_access_key',
                  hclRef(`azurerm_storage_account.${stgName}.primary_access_key`),
                ),
                hclAttr('service_plan_id', hclRef(`azurerm_service_plan.${planName}.id`)),
                ...(envs.length > 0 ? [hclAttr('app_settings', hclMap(envs))] : []),
              ],
              blocks: [hclBlock('site_config')],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_linux_function_app.${name}`);
        break;
      }

      case 'azure.container_apps': {
        const envName = `${name}_env`;
        const envs = azureEnvEntries(ctx, node, name);
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_container_app_environment', envName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${envName}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_container_app', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr(
                  'container_app_environment_id',
                  hclRef(`azurerm_container_app_environment.${envName}.id`),
                ),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('revision_mode', hclLit('Single')),
              ],
              blocks: [
                hclBlock('template', {
                  blocks: [
                    hclBlock('container', {
                      attributes: [
                        hclAttr('name', hclLit(name)),
                        hclAttr('image', hclLit('mcr.microsoft.com/k8se/quickstart:latest')),
                        hclAttr('cpu', hclLit(node.config.vcpu ?? 0.5)),
                        hclAttr('memory', hclLit(`${node.config.memoryGb ?? 1}Gi`)),
                      ],
                      blocks: envs.map(([k, v]) =>
                        hclBlock('env', {
                          attributes: [hclAttr('name', hclLit(k)), hclAttr('value', v)],
                        }),
                      ),
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_container_app.${name}`);
        break;
      }

      case 'azure.aks': {
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_kubernetes_cluster', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('dns_prefix', hclRaw(`"\${var.name_prefix}-aks"`)),
              ],
              blocks: [
                hclBlock('default_node_pool', {
                  attributes: [
                    hclAttr('name', hclLit('default')),
                    hclAttr('node_count', hclLit(instances)),
                    hclAttr('vm_size', hclLit(node.config.instanceType || 'Standard_DS2_v2')),
                    ...(subRef
                      ? [hclAttr('vnet_subnet_id', hclRef(`azurerm_subnet.${subRef}.id`))]
                      : []),
                  ],
                }),
                hclBlock('identity', { attributes: [hclAttr('type', hclLit('SystemAssigned'))] }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_kubernetes_cluster.${name}`);
        break;
      }

      case 'azure.front_door': {
        const epName = `${name}_endpoint`;
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_cdn_frontdoor_profile', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('sku_name', hclLit('Standard_AzureFrontDoor')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_cdn_frontdoor_endpoint', epName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${epName}"`)),
                hclAttr(
                  'cdn_frontdoor_profile_id',
                  hclRef(`azurerm_cdn_frontdoor_profile.${name}.id`),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_cdn_frontdoor_profile.${name}`);
        break;
      }

      case 'azure.sql_db': {
        const passVar = ctx.addVariable({
          name: `${name}_sql_admin_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for Azure SQL Server (${node.label}).`,
        });
        const srvName = `${name}_srv`;
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_mssql_server', srvName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}-srv"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('version', hclLit('12.0')),
                hclAttr('administrator_login', hclLit('sqladmin')),
                hclAttr('administrator_login_password', hclRef(`var.${passVar}`)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_mssql_database', name],
              attributes: [
                hclAttr('name', hclLit('appdb')),
                hclAttr('server_id', hclRef(`azurerm_mssql_server.${srvName}.id`)),
                hclAttr('sku_name', hclLit('S0')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_mssql_database.${name}`);
        break;
      }

      case 'azure.postgres_flexible': {
        const passVar = ctx.addVariable({
          name: `${name}_pg_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for Azure PostgreSQL Flexible Server (${node.label}).`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_postgresql_flexible_server', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('version', hclLit('16')),
                hclAttr('administrator_login', hclLit('pgadmin')),
                hclAttr('administrator_password', hclRef(`var.${passVar}`)),
                hclAttr('sku_name', hclLit(node.config.instanceType || 'B_Standard_B2s')),
                hclAttr(
                  'storage_mb',
                  hclLit(Math.max(32768, Math.round((node.config.storageGb ?? 32) * 1024))),
                ),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_postgresql_flexible_server.${name}`);
        break;
      }

      case 'azure.mysql_flexible': {
        const passVar = ctx.addVariable({
          name: `${name}_mysql_password`,
          type: 'string',
          sensitive: true,
          description: `Administrator password for Azure MySQL Flexible Server (${node.label}).`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_mysql_flexible_server', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('version', hclLit('8.0.21')),
                hclAttr('administrator_login', hclLit('mysqladmin')),
                hclAttr('administrator_password', hclRef(`var.${passVar}`)),
                hclAttr('sku_name', hclLit(node.config.instanceType || 'B_Standard_B2s')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_mysql_flexible_server.${name}`);
        break;
      }

      case 'azure.cosmos_db': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_cosmosdb_account', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('offer_type', hclLit('Standard')),
                hclAttr('kind', hclLit('GlobalDocumentDB')),
              ],
              blocks: [
                hclBlock('consistency_policy', {
                  attributes: [hclAttr('consistency_level', hclLit('Session'))],
                }),
                hclBlock('geo_location', {
                  attributes: [
                    hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                    hclAttr('failover_priority', hclLit(0)),
                  ],
                }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_cosmosdb_account.${name}`);
        break;
      }

      case 'azure.redis_cache': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_redis_cache', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('capacity', hclLit(1)),
                hclAttr('family', hclLit('C')),
                hclAttr('sku_name', hclLit('Basic')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_redis_cache.${name}`);
        break;
      }

      case 'azure.blob':
      case 'azure.blob_archive': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_storage_account', name],
              attributes: [
                hclAttr(
                  'name',
                  hclRaw(`replace(lower("\${var.name_prefix}${name}"), "/[^a-z0-9]/", "")`),
                ),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('account_tier', hclLit('Standard')),
                hclAttr('account_replication_type', hclLit('LRS')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_storage_container', `${name}_data`],
              attributes: [
                hclAttr('name', hclLit('data')),
                hclAttr('storage_account_id', hclRef(`azurerm_storage_account.${name}.id`)),
                hclAttr('container_access_type', hclLit('private')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_storage_account.${name}`);
        break;
      }

      case 'azure.service_bus': {
        const ns = `${name}_ns`;
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_servicebus_namespace', ns],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${ns}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('sku', hclLit('Standard')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_servicebus_queue', name],
              attributes: [
                hclAttr('name', hclLit(name)),
                hclAttr('namespace_id', hclRef(`azurerm_servicebus_namespace.${ns}.id`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_servicebus_queue.${name}`);
        break;
      }

      case 'azure.event_hubs': {
        const ns = `${name}_ns`;
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_eventhub_namespace', ns],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${ns}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('sku', hclLit('Standard')),
                hclAttr('capacity', hclLit(instances)),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_eventhub', name],
              attributes: [
                hclAttr('name', hclLit(name)),
                hclAttr('namespace_id', hclRef(`azurerm_eventhub_namespace.${ns}.id`)),
                hclAttr('partition_count', hclLit(2)),
                hclAttr('message_retention', hclLit(1)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_eventhub.${name}`);
        break;
      }

      case 'azure.event_grid': {
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_eventgrid_topic', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_eventgrid_topic.${name}`);
        break;
      }

      case 'azure.key_vault': {
        const tenantVar = ctx.addVariable({
          name: 'azure_tenant_id',
          type: 'string',
          description: `TODO: Azure Entra tenant ID for Key Vault ${node.label}.`,
        });
        buckets.data.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_key_vault', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('tenant_id', hclRef(`var.${tenantVar}`)),
                hclAttr('sku_name', hclLit('standard')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_key_vault.${name}`);
        break;
      }

      case 'azure.apim': {
        const emailVar = ctx.addVariable({
          name: `${name}_publisher_email`,
          type: 'string',
          description: `TODO: publisher contact email for API Management (${node.label}).`,
        });
        buckets.compute.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_api_management', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('publisher_name', hclLit('InfraSim')),
                hclAttr('publisher_email', hclRef(`var.${emailVar}`)),
                hclAttr('sku_name', hclLit('Consumption_0')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_api_management.${name}`);
        break;
      }

      case 'azure.openai': {
        const acctName = `${name}_acct`;
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_cognitive_account', acctName],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('kind', hclLit('OpenAI')),
                hclAttr('sku_name', hclLit('S0')),
              ],
            }),
          ),
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_cognitive_deployment', name],
              attributes: [
                hclAttr('name', hclLit(node.config.ai?.modelLabel || 'gpt-4o-mini')),
                hclAttr('cognitive_account_id', hclRef(`azurerm_cognitive_account.${acctName}.id`)),
              ],
              blocks: [
                hclBlock('model', {
                  attributes: [
                    hclAttr('format', hclLit('OpenAI')),
                    hclAttr('name', hclLit(node.config.ai?.modelLabel || 'gpt-4o-mini')),
                  ],
                }),
                hclBlock('sku', { attributes: [hclAttr('name', hclLit('Standard'))] }),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_cognitive_deployment.${name}`);
        break;
      }

      case 'azure.ai_search': {
        buckets.ai.push(
          hclBlockStmt(
            hclBlock('resource', {
              labels: ['azurerm_search_service', name],
              attributes: [
                hclAttr('name', hclRaw(`"\${var.name_prefix}-${name}"`)),
                hclAttr('resource_group_name', hclRef(`azurerm_resource_group.${rgName}.name`)),
                hclAttr('location', hclRef(`azurerm_resource_group.${rgName}.location`)),
                hclAttr('sku', hclLit('basic')),
              ],
            }),
          ),
        );
        ctx.recordAddress(node.id, `azurerm_search_service.${name}`);
        break;
      }

      default: {
        buckets.compute.push(
          hclCommentStmt(`InfraSim: no Terraform mapping for ${node.serviceId} (${node.label})`),
        );
        ctx.addUnsupported(node, `No v1 Azure Terraform resource mapping for ${node.serviceId}`);
        break;
      }
    }
  }
}
