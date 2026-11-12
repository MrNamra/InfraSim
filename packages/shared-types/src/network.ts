/** Supported cloud and pseudo-cloud providers. */
export type Provider = 'aws' | 'gcp' | 'azure' | 'oci' | 'custom' | 'generic';

/** Network topology and security configuration attached to a Design. */
export interface NetworkConfig {
  networks?: Network[];
  subnets?: Subnet[];
  routeTables?: RouteTable[];
  gateways?: Gateway[];
  firewalls?: FirewallObject[];
  peerings?: Peering[];
  dnsZones?: DnsZone[];
  endpoints?: PrivateEndpoint[];
  attachments?: Attachment[];
}

/** Virtual network (VPC / VNet / VCN). */
export interface Network {
  id: string;
  provider: Provider;
  region?: string;
  global?: boolean;
  cidrs: string[];
  name: string;
}

/** Subnet inside a virtual network. */
export interface Subnet {
  id: string;
  networkId: string;
  cidr: string;
  az?: string;
  regional?: boolean;
  routeTableId: string;
  autoAssignPublicIp?: boolean;
  firewallIds?: string[];
}

/** Route table containing longest-prefix-matched routes. */
export interface RouteTable {
  id: string;
  routes: { dest: string; target: RouteTarget }[];
}

/** Destination target of a route entry. */
export type RouteTarget =
  | { kind: 'local' }
  | { kind: 'igw' }
  | { kind: 'nat'; gatewayId: string }
  | { kind: 'peering'; id: string }
  | { kind: 'tgw' | 'drg' | 'vpn' | 'interconnect'; id: string }
  | { kind: 'endpoint'; id: string }
  | { kind: 'appliance'; nodeId: string }
  | { kind: 'blackhole' };

/** Network gateway object. */
export interface Gateway {
  id: string;
  kind: 'igw' | 'nat' | 'vpn' | 'tgw' | 'drg' | 'interconnect' | 'service-gw';
  networkId?: string;
  subnetId?: string;
  publicIp?: boolean;
}

/** Security group, NACL, NSG, GCP firewall, or OCI security list. */
export interface FirewallObject {
  id: string;
  kind: 'sg' | 'nacl' | 'gcp-fw' | 'nsg' | 'oci-sl' | 'oci-nsg';
  stateful: boolean;
  rules: FirewallRule[];
  attachedTo?: { subnetIds?: string[]; nodeIds?: string[]; tags?: string[] };
}

/** Single ingress or egress rule within a firewall object. */
export interface FirewallRule {
  id: string;
  direction: 'ingress' | 'egress';
  action: 'allow' | 'deny';
  priority?: number;
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  portFrom?: number;
  portTo?: number;
  source?: Selector;
  destination?: Selector;
  description?: string;
}

/** Traffic source or destination selector in a firewall rule. */
export type Selector = { cidr: string } | { firewallId: string } | { tag: string } | { any: true };

/** Network attachment binding a node to a subnet, IPs, firewalls, and tags. */
export interface Attachment {
  nodeId: string;
  subnetId?: string;
  privateIp?: string;
  publicIp?: string;
  firewallIds: string[];
  tags?: string[];
}

/** Peering link between two virtual networks. */
export interface Peering {
  id: string;
  a: string;
  b: string;
  routedA?: boolean;
  routedB?: boolean;
  transitive?: false;
}

/** Public or private DNS zone visible to attached networks. */
export interface DnsZone {
  id: string;
  name: string;
  private: boolean;
  networkIds: string[];
  records: { name: string; type: string; value: string }[];
}

/** Private endpoint / PrivateLink / PSC / OCI Service Gateway binding. */
export interface PrivateEndpoint {
  id: string;
  networkId: string;
  subnetId: string;
  serviceId: string;
  privateDns?: boolean;
}

/** Single hop evaluation along a reachability trace. */
export interface Hop {
  step: string;
  objectId: string;
  verdict: 'allow' | 'deny' | 'n/a';
  detail: string;
}

/** Machine-readable reason why a network path is blocked. */
export type ReasonCode =
  | 'NO_ROUTE'
  | 'NO_PUBLIC_IP'
  | 'NO_NAT'
  | 'NAT_NOT_IN_PUBLIC_SUBNET'
  | 'MISSING_RETURN_ROUTE'
  | 'SG_NO_INGRESS'
  | 'SG_NO_EGRESS'
  | 'NACL_DENY'
  | 'NSG_DENY'
  | 'GCP_FW_DENY'
  | 'OCI_SL_NO_RULE'
  | 'EPHEMERAL_PORTS_BLOCKED'
  | 'PORT_NOT_LISTENING'
  | 'DNS_UNRESOLVED'
  | 'PRIVATE_DNS_MISSING'
  | 'PEERING_NOT_ROUTED'
  | 'TRANSITIVE_PEERING_UNSUPPORTED'
  | 'CIDR_OVERLAP'
  | 'DIFFERENT_REGION_NO_CONNECTIVITY'
  | 'SERVICE_NOT_IN_VPC'
  | 'SERVICE_FIREWALL_BLOCK'
  | 'ENDPOINT_MISSING';

/** Reachability query verdict and remediation patches. */
export interface ReachabilityResult {
  reachable: boolean;
  hops: Hop[];
  blockedAt?: { objectKind: string; objectId: string; ruleId?: string };
  reasonCode?: ReasonCode;
  failureMode?: 'timeout' | 'refused' | 'dns' | 'none';
  explanation: { short: string; deep: string };
  fixes: { label: string; patch: { op: string; path: string; value?: unknown; from?: string }[] }[];
}

/** Precomputed edge reachability map passed into the simulation engine. */
export interface NetworkAnalysis {
  edges: Record<
    string,
    ReachabilityResult & {
      crossAz?: boolean;
      crossRegion?: boolean;
      viaNat?: boolean;
      viaEndpoint?: boolean;
      extraLatencyMs?: number;
      riskyReason?: string;
    }
  >;
  smells?: {
    ruleId: string;
    severity: 'info' | 'warning' | 'critical';
    nodeIds: string[];
    edgeIds: string[];
    title: string;
    short: string;
    deep: string;
    fixes: {
      label: string;
      patch: { op: string; path: string; value?: unknown; from?: string }[];
    }[];
  }[];
}

/** Creates an empty NetworkConfig with initialized empty arrays. */
export function createEmptyNetworkConfig(): Required<NetworkConfig> {
  return {
    networks: [],
    subnets: [],
    routeTables: [],
    gateways: [],
    firewalls: [],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [],
  };
}
