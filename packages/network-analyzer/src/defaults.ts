import { CATALOG_SERVICES } from '@infrasim/catalog';
import type {
  Attachment,
  Design,
  EdgeInstance,
  FirewallObject,
  FirewallRule,
  Gateway,
  GroupInstance,
  Network,
  NetworkConfig,
  NodeConfig,
  NodeInstance,
  Provider,
  RouteTable,
  ServiceDefinition,
  Subnet,
} from '@infrasim/shared-types';
import { createEmptyNetworkConfig } from '@infrasim/shared-types';
import { allocateIpFromCidr, allocateSubnetCidr, cidrContainsIp } from './cidr.js';

const BUILTIN_SERVICES_BY_ID = new Map<string, ServiceDefinition>(
  CATALOG_SERVICES.map((s) => [s.id, s]),
);

const INTERNET_FACING_KINDS = new Set(['lb', 'cdn', 'gw', 'dns', 'net']);

/** Ensures all optional arrays on `design.network` exist in place. */
export function ensureNetworkArrays(network: NetworkConfig): Required<NetworkConfig> {
  const empty = createEmptyNetworkConfig();
  if (!network.networks) network.networks = empty.networks;
  if (!network.subnets) network.subnets = empty.subnets;
  if (!network.routeTables) network.routeTables = empty.routeTables;
  if (!network.gateways) network.gateways = empty.gateways;
  if (!network.firewalls) network.firewalls = empty.firewalls;
  if (!network.peerings) network.peerings = empty.peerings;
  if (!network.dnsZones) network.dnsZones = empty.dnsZones;
  if (!network.endpoints) network.endpoints = empty.endpoints;
  if (!network.attachments) network.attachments = empty.attachments;
  return network as Required<NetworkConfig>;
}

/** Resolves a service definition across built-in catalog and custom services. */
export function resolveServiceDef(
  serviceId: string,
  customServices: readonly ServiceDefinition[] = [],
): ServiceDefinition | undefined {
  return BUILTIN_SERVICES_BY_ID.get(serviceId) ?? customServices.find((s) => s.id === serviceId);
}

/** Resolves effective listening ports from node overrides, catalog defaults, or service kind. */
export function getEffectiveListeningPorts(
  service: ServiceDefinition | undefined,
  nodeConfig?: Pick<NodeConfig, 'listeningPorts'>,
): { protocol: string; port: number }[] {
  if (nodeConfig?.listeningPorts) {
    return nodeConfig.listeningPorts;
  }
  if (service?.ports && service.ports.length > 0) {
    return service.ports;
  }
  switch (service?.kind) {
    case 'sql':
      return [{ protocol: 'tcp', port: 5432 }];
    case 'kv':
    case 'doc':
      return [{ protocol: 'https', port: 443 }];
    case 'cache':
      return [{ protocol: 'tcp', port: 6379 }];
    case 'dns':
      return [
        { protocol: 'udp', port: 53 },
        { protocol: 'tcp', port: 53 },
      ];
    case 'queue':
    case 'stream':
    case 'object':
    case 'fn':
    case 'llm':
    case 'ml':
    case 'doc-ai':
    case 'vision':
    case 'speech':
    case 'text-ai':
    case 'bot':
      return [{ protocol: 'https', port: 443 }];
    default:
      return [
        { protocol: 'https', port: 443 },
        { protocol: 'http', port: 80 },
        { protocol: 'tcp', port: 8080 },
      ];
  }
}

/** Normalizes edge or service transport protocol to L4 firewall protocol (`tcp`/`udp`/`icmp`/`any`). */
export function normalizeL4Protocol(protocol: string | undefined): 'tcp' | 'udp' | 'icmp' | 'any' {
  switch ((protocol ?? 'tcp').toLowerCase()) {
    case 'udp':
      return 'udp';
    case 'icmp':
      return 'icmp';
    case 'any':
    case 'all':
    case '*':
      return 'any';
    default:
      return 'tcp';
  }
}

/** Infers protocol & port to evaluate for an edge (preferring explicit edge config, else target default). */
export function inferEdgePortAndProtocol(
  edge: Pick<EdgeInstance, 'protocol' | 'port'>,
  targetService: ServiceDefinition | undefined,
  targetNode?: NodeInstance,
): { protocol: 'tcp' | 'udp' | 'icmp' | 'any'; port: number } {
  const ports = getEffectiveListeningPorts(targetService, targetNode?.config);
  if (edge.port !== undefined && Number.isFinite(edge.port) && edge.port > 0) {
    return {
      protocol: normalizeL4Protocol(edge.protocol),
      port: edge.port,
    };
  }
  const matching = ports.find(
    (p) =>
      p.protocol === edge.protocol ||
      (edge.protocol === 'https' && p.port === 443) ||
      (edge.protocol === 'http' && p.port === 80) ||
      (edge.protocol === 'sql' && p.protocol === 'tcp') ||
      (edge.protocol === 'redis' && p.protocol === 'tcp') ||
      normalizeL4Protocol(p.protocol) === normalizeL4Protocol(edge.protocol),
  );
  if (matching) {
    return {
      protocol: normalizeL4Protocol(edge.protocol === 'dns' ? matching.protocol : edge.protocol),
      port: matching.port,
    };
  }
  if (ports.length > 0) {
    return {
      protocol: normalizeL4Protocol(ports[0]!.protocol),
      port: ports[0]!.port,
    };
  }
  switch (edge.protocol) {
    case 'http':
      return { protocol: 'tcp', port: 80 };
    case 'sql':
      return { protocol: 'tcp', port: 5432 };
    case 'redis':
      return { protocol: 'tcp', port: 6379 };
    case 'dns':
      return { protocol: 'udp', port: 53 };
    case 'kafka':
      return { protocol: 'tcp', port: 9092 };
    case 'amqp':
      return { protocol: 'tcp', port: 5672 };
    default:
      return { protocol: 'tcp', port: 443 };
  }
}

/** Derives whether a subnet has an active route to an Internet Gateway (`0.0.0.0/0 -> igw`). */
export function inferSubnetPublicness(
  subnet: Subnet,
  networkConfig: NetworkConfig | undefined,
): boolean {
  const rt = (networkConfig?.routeTables ?? []).find((r) => r.id === subnet.routeTableId);
  if (!rt) {
    return Boolean(subnet.autoAssignPublicIp);
  }
  return rt.routes.some(
    (route) => (route.dest === '0.0.0.0/0' || route.dest === '::/0') && route.target.kind === 'igw',
  );
}

/** Walks `parentGroupId` ancestry for a group or node to find enclosing VPC/Subnet/Region/AZ/Provider. */
export function resolveGroupAncestry(
  startGroupId: string | undefined,
  groupsById: ReadonlyMap<string, GroupInstance>,
  fallbackProvider: Provider = 'aws',
): {
  subnetGroup?: GroupInstance;
  vpcGroup?: GroupInstance;
  regionGroup?: GroupInstance;
  azGroup?: GroupInstance;
  provider: Provider;
  region?: string;
  az?: string;
} {
  let subnetGroup: GroupInstance | undefined;
  let vpcGroup: GroupInstance | undefined;
  let regionGroup: GroupInstance | undefined;
  let azGroup: GroupInstance | undefined;
  let provider: Provider | undefined;
  let region: string | undefined;
  let az: string | undefined;

  let cursor = startGroupId ? groupsById.get(startGroupId) : undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (
      !provider &&
      cursor.provider &&
      cursor.provider !== 'generic' &&
      cursor.provider !== 'custom'
    ) {
      provider = cursor.provider;
    }
    if (cursor.kind === 'subnet' && !subnetGroup) {
      subnetGroup = cursor;
    } else if (cursor.kind === 'vpc' && !vpcGroup) {
      vpcGroup = cursor;
    } else if (cursor.kind === 'region' && !regionGroup) {
      regionGroup = cursor;
      region = cursor.region ?? cursor.label;
    } else if ((cursor.kind === 'az' || cursor.kind === 'zone') && !azGroup) {
      azGroup = cursor;
      az = cursor.label;
    }
    if (!region && cursor.region) {
      region = cursor.region;
    }
    cursor = cursor.parentGroupId ? groupsById.get(cursor.parentGroupId) : undefined;
  }

  const effectiveProvider =
    provider ??
    (fallbackProvider !== 'generic' && fallbackProvider !== 'custom' ? fallbackProvider : 'aws');

  return {
    ...(subnetGroup ? { subnetGroup } : {}),
    ...(vpcGroup ? { vpcGroup } : {}),
    ...(regionGroup ? { regionGroup } : {}),
    ...(azGroup ? { azGroup } : {}),
    provider: effectiveProvider,
    ...(region ? { region } : {}),
    ...(az ? { az } : {}),
  };
}

function defaultRegionForProvider(provider: Provider): string {
  switch (provider) {
    case 'gcp':
      return 'us-central1';
    case 'azure':
      return 'eastus';
    case 'oci':
      return 'us-ashburn-1';
    default:
      return 'us-east-1';
  }
}

/** Deterministic pseudo-public IP allocation for an instance attachment. */
function allocatePublicIp(usedPublicIps: ReadonlySet<string>): string {
  for (let i = 10; i <= 250; i++) {
    const candidate = `198.51.100.${i}`;
    if (!usedPublicIps.has(candidate)) {
      return candidate;
    }
  }
  return '198.51.100.251';
}

function ensureSubnetDefaultFirewall(
  net: Required<NetworkConfig>,
  provider: Provider,
  subnetGroup: GroupInstance,
  subnetId: string,
  vpcCidr: string,
): string | undefined {
  if (provider === 'gcp') {
    return undefined;
  }
  if (provider === 'azure') {
    const fwId = `nsg-sub-${subnetGroup.id}`;
    if (!net.firewalls.some((f) => f.id === fwId)) {
      net.firewalls.push({
        id: fwId,
        kind: 'nsg',
        stateful: true,
        attachedTo: { subnetIds: [subnetId] },
        rules: [
          {
            id: `${fwId}-allow-vnet`,
            direction: 'ingress',
            action: 'allow',
            priority: 65000,
            protocol: 'any',
            source: { cidr: vpcCidr },
            description: 'AllowVnetInBound',
          },
          {
            id: `${fwId}-allow-outbound`,
            direction: 'egress',
            action: 'allow',
            priority: 65000,
            protocol: 'any',
            destination: { any: true },
            description: 'AllowInternetOutBound',
          },
        ],
      });
    }
    return fwId;
  }
  if (provider === 'oci') {
    const fwId = `oci-sl-${subnetGroup.id}`;
    if (!net.firewalls.some((f) => f.id === fwId)) {
      net.firewalls.push({
        id: fwId,
        kind: 'oci-sl',
        stateful: true,
        attachedTo: { subnetIds: [subnetId] },
        rules: [
          {
            id: `${fwId}-ing-vcn`,
            direction: 'ingress',
            action: 'allow',
            protocol: 'any',
            source: { cidr: vpcCidr },
            description: 'Default VCN internal ingress',
          },
          {
            id: `${fwId}-egr-all`,
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
            description: 'Default VCN outbound',
          },
        ],
      });
    }
    return fwId;
  }

  // AWS stateless Network ACL default allows all (rule #100)
  const naclId = `nacl-${subnetGroup.id}`;
  if (!net.firewalls.some((f) => f.id === naclId)) {
    net.firewalls.push({
      id: naclId,
      kind: 'nacl',
      stateful: false,
      attachedTo: { subnetIds: [subnetId] },
      rules: [
        {
          id: `${naclId}-in-100`,
          direction: 'ingress',
          action: 'allow',
          priority: 100,
          protocol: 'any',
          source: { any: true },
          description: 'Default allow all ingress',
        },
        {
          id: `${naclId}-out-100`,
          direction: 'egress',
          action: 'allow',
          priority: 100,
          protocol: 'any',
          destination: { any: true },
          description: 'Default allow all egress',
        },
      ],
    });
  }
  return naclId;
}

/**
 * Ensures matching virtual `Network`, `RouteTable`, `Gateway`, `Subnet`, and default
 * subnet firewall exist in `design.network` for a canvas `vpc` or `subnet` GroupInstance.
 */
export function ensureGroupNetworkDefaults(design: Design, groupId: string): void {
  const group = design.groups.find((g) => g.id === groupId);
  if (!group || (group.kind !== 'vpc' && group.kind !== 'subnet')) {
    return;
  }
  const net = ensureNetworkArrays(design.network);
  const groupsById = new Map(design.groups.map((g) => [g.id, g]));
  const ancestry = resolveGroupAncestry(
    group.id,
    groupsById,
    design.settings.primaryProvider ?? 'aws',
  );
  const provider = ancestry.provider;
  const effectiveRegion = ancestry.region ?? defaultRegionForProvider(provider);

  if (group.kind === 'vpc') {
    const netId = `net-${group.id}`;
    const vpcCidr = group.cidr?.trim() || '10.0.0.0/16';
    group.cidr = vpcCidr;

    let networkObj = net.networks.find((n) => n.id === netId);
    if (!networkObj) {
      networkObj = {
        id: netId,
        provider,
        region: provider === 'gcp' ? undefined : effectiveRegion,
        global: provider === 'gcp',
        cidrs: [vpcCidr],
        name: group.label,
      };
      net.networks.push(networkObj);
    } else {
      networkObj.provider = provider;
      networkObj.cidrs = [vpcCidr];
      networkObj.name = group.label;
      if (provider !== 'gcp') {
        networkObj.region = effectiveRegion;
        networkObj.global = false;
      } else {
        networkObj.global = true;
      }
    }

    const mainRtId = `rt-main-${group.id}`;
    let mainRt = net.routeTables.find((r) => r.id === mainRtId);
    if (!mainRt) {
      mainRt = {
        id: mainRtId,
        routes: [{ dest: vpcCidr, target: { kind: 'local' } }],
      };
      net.routeTables.push(mainRt);
    } else {
      const localRoute = mainRt.routes.find((r) => r.target.kind === 'local');
      if (localRoute) {
        localRoute.dest = vpcCidr;
      } else {
        mainRt.routes.unshift({ dest: vpcCidr, target: { kind: 'local' } });
      }
    }
    return;
  }

  // Subnet group: ensure parent VPC network first
  let parentNetwork: Network | undefined;
  if (ancestry.vpcGroup) {
    ensureGroupNetworkDefaults(design, ancestry.vpcGroup.id);
    parentNetwork = net.networks.find((n) => n.id === `net-${ancestry.vpcGroup!.id}`);
  }
  if (!parentNetwork) {
    const implicitNetId = `net-vpc-${group.id}`;
    parentNetwork = net.networks.find((n) => n.id === implicitNetId);
    if (!parentNetwork) {
      parentNetwork = {
        id: implicitNetId,
        provider,
        region: provider === 'gcp' ? undefined : effectiveRegion,
        global: provider === 'gcp',
        cidrs: ['10.0.0.0/16'],
        name: `${group.label} VPC`,
      };
      net.networks.push(parentNetwork);
    }
  }

  const vpcCidr = parentNetwork.cidrs[0] ?? '10.0.0.0/16';
  const subnetId = `sub-${group.id}`;
  const existingSubnet = net.subnets.find((s) => s.id === subnetId);
  const siblingCidrs = net.subnets
    .filter((s) => s.networkId === parentNetwork!.id && s.id !== subnetId)
    .map((s) => s.cidr);
  const subnetCidr =
    group.cidr?.trim() || existingSubnet?.cidr || allocateSubnetCidr(vpcCidr, siblingCidrs);
  group.cidr = subnetCidr;

  const isPublic = group.public !== false;
  group.public = isPublic;

  const rtId = existingSubnet?.routeTableId || `rt-${group.id}`;
  let rt: RouteTable | undefined = net.routeTables.find((r) => r.id === rtId);
  if (!rt) {
    rt = {
      id: rtId,
      routes: [{ dest: vpcCidr, target: { kind: 'local' } }],
    };
    net.routeTables.push(rt);
  } else {
    const localRoute = rt.routes.find((r) => r.target.kind === 'local');
    if (localRoute) {
      localRoute.dest = vpcCidr;
    } else {
      rt.routes.unshift({ dest: vpcCidr, target: { kind: 'local' } });
    }
  }

  if (isPublic) {
    let igw: Gateway | undefined = net.gateways.find(
      (g) => g.kind === 'igw' && g.networkId === parentNetwork!.id,
    );
    if (!igw) {
      igw = { id: `igw-${parentNetwork.id}`, kind: 'igw', networkId: parentNetwork.id };
      net.gateways.push(igw);
    }
    if (!rt.routes.some((r) => r.dest === '0.0.0.0/0')) {
      rt.routes.push({ dest: '0.0.0.0/0', target: { kind: 'igw' } });
    }
  } else {
    rt.routes = rt.routes.filter((r) => !(r.dest === '0.0.0.0/0' && r.target.kind === 'igw'));
  }

  const defaultFwId = ensureSubnetDefaultFirewall(net, provider, group, subnetId, vpcCidr);

  if (!existingSubnet) {
    net.subnets.push({
      id: subnetId,
      networkId: parentNetwork.id,
      cidr: subnetCidr,
      ...(ancestry.az ? { az: ancestry.az } : {}),
      regional: provider === 'gcp' || provider === 'azure' || provider === 'oci',
      routeTableId: rt.id,
      autoAssignPublicIp: isPublic,
      ...(defaultFwId ? { firewallIds: [defaultFwId] } : {}),
    });
  } else {
    existingSubnet.networkId = parentNetwork.id;
    existingSubnet.cidr = subnetCidr;
    existingSubnet.autoAssignPublicIp = isPublic;
    if (ancestry.az) {
      existingSubnet.az = ancestry.az;
    }
    if (defaultFwId && !(existingSubnet.firewallIds ?? []).includes(defaultFwId)) {
      existingSubnet.firewallIds = [...(existingSubnet.firewallIds ?? []), defaultFwId];
    }
  }
}

/**
 * Re-synchronizes attachments for all nodes residing directly or transitively under `groupId`
 * after group edits (`public`, `cidr`, `region`, `provider`) or parent container reparenting.
 */
export function syncGroupDescendantsNetwork(
  design: Design,
  groupId: string,
  customServices: readonly ServiceDefinition[] = [],
): void {
  const descendantGroupIds = new Set<string>([groupId]);
  let added = true;
  while (added) {
    added = false;
    for (const g of design.groups) {
      if (
        g.parentGroupId &&
        descendantGroupIds.has(g.parentGroupId) &&
        !descendantGroupIds.has(g.id)
      ) {
        descendantGroupIds.add(g.id);
        added = true;
      }
    }
  }
  for (const gId of descendantGroupIds) {
    const g = design.groups.find((item) => item.id === gId);
    if (g && (g.kind === 'vpc' || g.kind === 'subnet')) {
      ensureGroupNetworkDefaults(design, g.id);
    }
  }
  for (const node of design.nodes) {
    if (node.parentGroupId && descendantGroupIds.has(node.parentGroupId)) {
      syncNodeNetworkAttachment(design, node.id, customServices);
    }
  }
}

function buildDefaultNodeFirewall(
  provider: Provider,
  node: NodeInstance,
  service: ServiceDefinition | undefined,
  vpcCidr: string,
  subnetIsPublic: boolean,
): FirewallObject {
  const ports = getEffectiveListeningPorts(service, node.config);
  const isEdgeEntry = service ? INTERNET_FACING_KINDS.has(service.kind) : false;

  if (provider === 'gcp') {
    const fwId = `gcp-fw-${node.id}`;
    const tag = `svc-${node.id}`;
    const rules: FirewallRule[] = ports.map((p, idx) => ({
      id: `${fwId}-in-${idx}`,
      direction: 'ingress',
      action: 'allow',
      priority: 1000,
      protocol: normalizeL4Protocol(p.protocol),
      portFrom: p.port,
      portTo: p.port,
      source: isEdgeEntry && subnetIsPublic ? { any: true } : { cidr: vpcCidr },
      description: `Default ${node.label} listener port ${p.port}`,
    }));
    rules.push({
      id: `${fwId}-egr-all`,
      direction: 'egress',
      action: 'allow',
      priority: 1000,
      protocol: 'any',
      destination: { any: true },
      description: 'Default allow egress',
    });
    return {
      id: fwId,
      kind: 'gcp-fw',
      stateful: true,
      attachedTo: { nodeIds: [node.id], tags: [tag] },
      rules,
    };
  }

  if (provider === 'azure') {
    const fwId = `nsg-${node.id}`;
    const rules: FirewallRule[] = [
      ...ports.map((p, idx): FirewallRule => ({
        id: `${fwId}-in-${idx}`,
        direction: 'ingress',
        action: 'allow',
        priority: 100 + idx,
        protocol: normalizeL4Protocol(p.protocol),
        portFrom: p.port,
        portTo: p.port,
        source: isEdgeEntry && subnetIsPublic ? { any: true } : { cidr: vpcCidr },
        description: `Allow ${node.label} port ${p.port}`,
      })),
      {
        id: `${fwId}-egr-all`,
        direction: 'egress',
        action: 'allow',
        priority: 100,
        protocol: 'any',
        destination: { any: true },
        description: 'Allow outbound',
      },
    ];
    return {
      id: fwId,
      kind: 'nsg',
      stateful: true,
      attachedTo: { nodeIds: [node.id] },
      rules,
    };
  }

  if (provider === 'oci') {
    const fwId = `oci-nsg-${node.id}`;
    const rules: FirewallRule[] = [
      ...ports.map((p, idx): FirewallRule => ({
        id: `${fwId}-in-${idx}`,
        direction: 'ingress',
        action: 'allow',
        protocol: normalizeL4Protocol(p.protocol),
        portFrom: p.port,
        portTo: p.port,
        source: isEdgeEntry && subnetIsPublic ? { any: true } : { cidr: vpcCidr },
        description: `Allow ${node.label} port ${p.port}`,
      })),
      {
        id: `${fwId}-egr-all`,
        direction: 'egress',
        action: 'allow',
        protocol: 'any',
        destination: { any: true },
        description: 'Allow outbound',
      },
    ];
    return {
      id: fwId,
      kind: 'oci-nsg',
      stateful: true,
      attachedTo: { nodeIds: [node.id] },
      rules,
    };
  }

  // AWS Security Group default
  const sgId = `sg-${node.id}`;
  const rules: FirewallRule[] = [
    ...ports.map((p, idx): FirewallRule => ({
      id: `${sgId}-in-${idx}`,
      direction: 'ingress',
      action: 'allow',
      protocol: normalizeL4Protocol(p.protocol),
      portFrom: p.port,
      portTo: p.port,
      source: isEdgeEntry && subnetIsPublic ? { any: true } : { cidr: vpcCidr },
      description: `Allow ${node.label} port ${p.port}`,
    })),
    {
      id: `${sgId}-egr-all`,
      direction: 'egress',
      action: 'allow',
      protocol: 'any',
      destination: { any: true },
      description: 'Default allow all outbound',
    },
  ];
  return {
    id: sgId,
    kind: 'sg',
    stateful: true,
    attachedTo: { nodeIds: [node.id] },
    rules,
  };
}

/**
 * Attaches or updates a node's network interface (`Attachment`) and provider firewall defaults
 * when the node enters or moves between Subnet groups on the canvas.
 */
export function syncNodeNetworkAttachment(
  design: Design,
  nodeId: string,
  customServices: readonly ServiceDefinition[] = [],
): void {
  const node = design.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return;
  }
  const net = ensureNetworkArrays(design.network);
  const groupsById = new Map(design.groups.map((g) => [g.id, g]));
  const ancestry = resolveGroupAncestry(
    node.parentGroupId,
    groupsById,
    design.settings.primaryProvider ?? 'aws',
  );

  if (!ancestry.subnetGroup) {
    // Node moved outside a subnet group: strip auto-managed subnet attachment if present
    const idx = net.attachments.findIndex((a) => a.nodeId === nodeId);
    if (idx >= 0) {
      const existing = net.attachments[idx]!;
      const autoSubPrefix = existing.subnetId?.startsWith('sub-');
      if (autoSubPrefix) {
        net.attachments.splice(idx, 1);
      }
    }
    return;
  }

  ensureGroupNetworkDefaults(design, ancestry.subnetGroup.id);
  const subnetId = `sub-${ancestry.subnetGroup.id}`;
  const subnet = net.subnets.find((s) => s.id === subnetId);
  if (!subnet) {
    return;
  }
  const parentNetwork = net.networks.find((n) => n.id === subnet.networkId);
  const vpcCidr = parentNetwork?.cidrs[0] ?? '10.0.0.0/16';
  const provider = parentNetwork?.provider ?? ancestry.provider;
  const service = resolveServiceDef(node.serviceId, customServices);

  const usedPrivateIps = new Set(
    net.attachments.filter((a) => a.nodeId !== nodeId && a.privateIp).map((a) => a.privateIp!),
  );
  const usedPublicIps = new Set(
    net.attachments.filter((a) => a.nodeId !== nodeId && a.publicIp).map((a) => a.publicIp!),
  );

  let attachment: Attachment | undefined = net.attachments.find((a) => a.nodeId === nodeId);
  const subnetPublic = inferSubnetPublicness(subnet, net);
  const privateIp =
    attachment?.privateIp && cidrContainsIp(subnet.cidr, attachment.privateIp)
      ? attachment.privateIp
      : allocateIpFromCidr(subnet.cidr, usedPrivateIps);
  const publicIp = subnetPublic
    ? attachment?.publicIp || allocatePublicIp(usedPublicIps)
    : undefined;

  // Ensure default firewall if node doesn't already reference one
  let firewallIds = attachment?.firewallIds ?? [];
  if (firewallIds.length === 0) {
    const fw = buildDefaultNodeFirewall(provider, node, service, vpcCidr, subnetPublic);
    const existingFw = net.firewalls.find((f) => f.id === fw.id);
    if (!existingFw) {
      net.firewalls.push(fw);
    }
    firewallIds = [fw.id];
  }

  const tags =
    attachment?.tags && attachment.tags.length > 0
      ? attachment.tags
      : provider === 'gcp'
        ? [`svc-${node.id}`]
        : undefined;

  if (!attachment) {
    attachment = {
      nodeId,
      subnetId,
      privateIp,
      ...(publicIp ? { publicIp } : {}),
      firewallIds,
      ...(tags ? { tags } : {}),
    };
    net.attachments.push(attachment);
  } else {
    attachment.subnetId = subnetId;
    attachment.privateIp = privateIp;
    if (publicIp) {
      attachment.publicIp = publicIp;
    } else {
      delete attachment.publicIp;
    }
    attachment.firewallIds = firewallIds;
    if (tags) {
      attachment.tags = tags;
    }
  }
}

/** Removes network attachments and auto-generated per-node firewalls when deleting a node. */
export function cleanupNodeNetworkReferences(design: Design, nodeId: string): void {
  const net = ensureNetworkArrays(design.network);
  net.attachments = net.attachments.filter((a) => a.nodeId !== nodeId);
  const autoFwIds = new Set([
    `sg-${nodeId}`,
    `gcp-fw-${nodeId}`,
    `nsg-${nodeId}`,
    `oci-nsg-${nodeId}`,
  ]);
  net.firewalls = net.firewalls.filter((f) => !autoFwIds.has(f.id));
  for (const rt of net.routeTables) {
    rt.routes = rt.routes.filter(
      (r) => !(r.target.kind === 'appliance' && r.target.nodeId === nodeId),
    );
  }
}

/** Cleans up auto-created network objects tied to a deleted group container. */
export function cleanupGroupNetworkReferences(design: Design, groupId: string): void {
  const net = ensureNetworkArrays(design.network);
  const subnetId = `sub-${groupId}`;
  const networkIdsToRemove = new Set([`net-${groupId}`, `net-vpc-${groupId}`]);

  net.subnets = net.subnets.filter(
    (s) => s.id !== subnetId && !networkIdsToRemove.has(s.networkId),
  );
  net.networks = net.networks.filter((n) => !networkIdsToRemove.has(n.id));
  net.gateways = net.gateways.filter(
    (g) => g.subnetId !== subnetId && (!g.networkId || !networkIdsToRemove.has(g.networkId)),
  );
  net.peerings = net.peerings.filter(
    (p) => !networkIdsToRemove.has(p.a) && !networkIdsToRemove.has(p.b),
  );
  net.endpoints = net.endpoints.filter(
    (e) => e.subnetId !== subnetId && !networkIdsToRemove.has(e.networkId),
  );
  net.routeTables = net.routeTables.filter(
    (rt) => rt.id !== `rt-${groupId}` && rt.id !== `rt-main-${groupId}`,
  );
  net.firewalls = net.firewalls.filter(
    (f) =>
      f.id !== `nacl-${groupId}` && f.id !== `nsg-sub-${groupId}` && f.id !== `oci-sl-${groupId}`,
  );
  for (const att of net.attachments) {
    if (att.subnetId === subnetId) {
      delete att.subnetId;
      delete att.publicIp;
    }
  }
}
