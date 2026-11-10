# 13 — Networking & Reachability ("Why can't A reach B?")

Package: `packages/network-analyzer`. Deterministic **rule evaluation**, not packet simulation. Input: a `Design`. Output: reachability per edge (and per ad-hoc query) with the exact blocking rule and a suggested fix.

## 1. Goals

1. Users configure networks virtually (CIDRs, subnets, routes, gateways, firewall rules, DNS).
2. For any pair (source, destination, port, protocol) the tool answers **reachable / blocked** and **why**, naming the object and rule.
3. Every blocked answer includes **fix suggestions** that can be applied as a patch with one click.
4. Results feed the simulation: blocked edges produce realistic connection errors (file 05 §6.9).
5. Works across AWS, GCP, Azure and OCI using a **common abstraction** plus provider-specific semantics.

## 2. Common resource model

```ts
export interface NetworkConfig {
  networks: Network[];                // VPC / VNet / VCN
  subnets: Subnet[];
  routeTables: RouteTable[];
  gateways: Gateway[];
  firewalls: FirewallObject[];        // SG / NSG / NACL / GCP firewall / OCI SL
  peerings: Peering[];
  dnsZones: DnsZone[];
  endpoints: PrivateEndpoint[];       // PrivateLink / PSC / Private Endpoint / Service GW
  attachments: Attachment[];          // which node uses which subnet, firewall, public IP
}

export interface Network { id: string; provider: Provider; region?: string; global?: boolean; cidrs: string[]; name: string }
export interface Subnet  { id: string; networkId: string; cidr: string; az?: string; regional?: boolean; routeTableId: string; autoAssignPublicIp?: boolean; firewallIds?: string[] /* NACL / OCI SL / Azure NSG on subnet */ }
export interface RouteTable { id: string; routes: { dest: string; target: RouteTarget }[] }
export type RouteTarget =
  | { kind: 'local' } | { kind: 'igw' } | { kind: 'nat'; gatewayId: string }
  | { kind: 'peering'; id: string } | { kind: 'tgw' | 'drg' | 'vpn' | 'interconnect'; id: string }
  | { kind: 'endpoint'; id: string } | { kind: 'appliance'; nodeId: string } | { kind: 'blackhole' };

export interface Gateway { id: string; kind: 'igw' | 'nat' | 'vpn' | 'tgw' | 'drg' | 'interconnect' | 'service-gw'; networkId?: string; subnetId?: string; publicIp?: boolean }

export interface FirewallObject {
  id: string; kind: 'sg' | 'nacl' | 'gcp-fw' | 'nsg' | 'oci-sl' | 'oci-nsg';
  stateful: boolean;
  rules: FirewallRule[];
  attachedTo?: { subnetIds?: string[]; nodeIds?: string[]; tags?: string[] };
}
export interface FirewallRule {
  id: string; direction: 'ingress' | 'egress'; action: 'allow' | 'deny';
  priority?: number;                   // lower = earlier (NACL number, GCP/Azure priority)
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  portFrom?: number; portTo?: number;
  source?: Selector; destination?: Selector;  // CIDR | firewallId (SG ref) | tag | service tag | any
  description?: string;
}
export type Selector = { cidr: string } | { firewallId: string } | { tag: string } | { any: true };

export interface Attachment { nodeId: string; subnetId?: string; privateIp?: string; publicIp?: string; firewallIds: string[]; tags?: string[] }
export interface Peering { id: string; a: string; b: string; routedA?: boolean; routedB?: boolean; transitive?: false }
export interface DnsZone { id: string; name: string; private: boolean; networkIds: string[]; records: { name: string; type: string; value: string }[] }
export interface PrivateEndpoint { id: string; networkId: string; subnetId: string; serviceId: string; privateDns?: boolean }
```

Nodes expose **listening ports** (`ServiceDefinition.ports` or node override). The analyzer treats a destination with no listener on the port as **port closed**.

## 3. Provider semantics (what differs)

| Concept | AWS | GCP | Azure | OCI |
|---|---|---|---|---|
| Network scope | VPC is **regional** | VPC is **global**, subnets regional | VNet is regional | VCN is regional |
| Subnet scope | One AZ | Region (all zones) | Region-wide (zones optional) | Regional (recommended) or AD |
| "Public" subnet | Route to IGW + public IP | External IP on instance + default route | Public IP + NSG allows | Public subnet flag + IGW route + public IP |
| Instance firewall | **Security Group** (stateful, allow-only, SG-to-SG refs) | **VPC firewall rule** (stateful, allow/deny, priority, tags/SA targets) | **NSG** (stateful, allow/deny, priority) on NIC/subnet | **NSG** (VNIC) + **Security List** (subnet), stateful by default, allow-only |
| Subnet firewall | **NACL** (stateless, numbered, allow/deny) | — | NSG on subnet | Security List |
| Default inbound | Deny (SG has no rules) | Deny (implied) | Deny from internet; allow VNet | Deny except default list (SSH/ICMP) |
| Default outbound | Allow all (SG) | Allow (implied) | Allow | Allow (default list) |
| Internet egress for private | NAT Gateway | Cloud NAT | NAT Gateway / outbound rules | NAT Gateway |
| Cross-network | VPC Peering (non-transitive), TGW | VPC Peering (non-transitive), NCC | VNet Peering (non-transitive), vWAN | DRG (and LPG legacy) |
| Private access to PaaS | VPC endpoints / PrivateLink | Private Google Access / PSC | Private Endpoint (+ private DNS) | Service Gateway |

The analyzer reads `Network.provider` to pick the rule-evaluation flavor (e.g. AWS evaluates SG **and** NACL; GCP evaluates priority-ordered allow/deny rules with default implied rules).

## 4. Evaluation algorithm

Query: `reach(srcNodeId, dstNodeId, protocol, port) → ReachabilityResult`.

```
1. RESOLVE endpoints
   - dst may be a node, a DNS name, an IP, or "internet".
   - If dst is a DNS name: resolve via zones visible to src's network (private zones first). Fail → DNS_UNRESOLVED.
   - Choose destination address: private IP if same network/peered/routed; else public IP (needs src egress to internet).

2. SOURCE-SIDE
   a. Source firewall EGRESS (SG/NSG/GCP/OCI NSG). Stateful: remember allowed flow for return.
   b. Source subnet firewall EGRESS (NACL / NSG-on-subnet / OCI SL): stateless → also check return later.

3. ROUTING (src subnet's route table)
   - Longest-prefix match on destination address.
   - local            → same network: continue to dest-side
   - igw              → requires src public IP (or NAT for private): else NO_PUBLIC_IP
   - nat              → NAT must sit in a public subnet with IGW route: else NAT_NOT_IN_PUBLIC_SUBNET
   - peering/tgw/drg  → check route exists on **both** sides (return path): else PEERING_NOT_ROUTED / MISSING_RETURN_ROUTE
   - endpoint         → private endpoint to service; check endpoint SG + private DNS
   - blackhole/no match → NO_ROUTE
   - Transitive peering (A–B, B–C, A→C) → TRANSITIVE_PEERING_UNSUPPORTED
   - Overlapping CIDRs across peered networks → CIDR_OVERLAP

4. DESTINATION-SIDE
   a. Dest subnet firewall INGRESS (NACL: ordered by rule number, first match wins; stateless).
   b. Dest instance firewall INGRESS (SG: any allow matches; SG-reference selectors resolve to attached nodes).
      GCP: highest priority (lowest number) matching rule wins; allow/deny; implied deny ingress.
      Azure NSG: priority order, first match; default rules apply last.
   c. Listener check: dest node listens on (protocol, port)? Else PORT_NOT_LISTENING (conn refused).

5. RETURN PATH (stateless components only)
   - NACL/OCI stateless rules/subnet NSG without state: check **ephemeral port range** egress (1024–65535) from dest subnet and ingress at source subnet. Else EPHEMERAL_PORTS_BLOCKED.
   - Asymmetric routing (return route missing) → MISSING_RETURN_ROUTE.

6. REGION/GLOBAL checks
   - Different regions with no peering/TGW/VPN → DIFFERENT_REGION_NO_CONNECTIVITY.
   - Serverless not attached to a network trying to reach a private IP → SERVICE_NOT_IN_VPC.
   - PaaS public endpoint blocked by service firewall (allowlist) → SERVICE_FIREWALL_BLOCK.

→ Return {reachable, hops[], blockedAt?, reasonCode, explanation, fixes[]}
```

### Result type

```ts
export interface ReachabilityResult {
  reachable: boolean;
  hops: Hop[];                         // ordered path with each check and verdict
  blockedAt?: { objectKind: string; objectId: string; ruleId?: string };
  reasonCode?: ReasonCode;
  failureMode?: 'timeout' | 'refused' | 'dns' | 'none';   // maps to conn_timeout / conn_refused / dns error
  explanation: { short: string; deep: string };
  fixes: FixSuggestion[];              // JSON-patch ops against Design (file 04)
}
export interface Hop { step: string; objectId: string; verdict: 'allow' | 'deny' | 'n/a'; detail: string }
export type ReasonCode =
  | 'NO_ROUTE' | 'NO_PUBLIC_IP' | 'NO_NAT' | 'NAT_NOT_IN_PUBLIC_SUBNET' | 'MISSING_RETURN_ROUTE'
  | 'SG_NO_INGRESS' | 'SG_NO_EGRESS' | 'NACL_DENY' | 'NSG_DENY' | 'GCP_FW_DENY' | 'OCI_SL_NO_RULE'
  | 'EPHEMERAL_PORTS_BLOCKED' | 'PORT_NOT_LISTENING' | 'DNS_UNRESOLVED' | 'PRIVATE_DNS_MISSING'
  | 'PEERING_NOT_ROUTED' | 'TRANSITIVE_PEERING_UNSUPPORTED' | 'CIDR_OVERLAP'
  | 'DIFFERENT_REGION_NO_CONNECTIVITY' | 'SERVICE_NOT_IN_VPC' | 'SERVICE_FIREWALL_BLOCK' | 'ENDPOINT_MISSING';
```

### Failure modes (matters for realism)

| Cause | What the app sees | `failureMode` |
|---|---|---|
| Firewall/route **drop** (SG, NACL, NSG deny, no route) | Hangs until connect timeout (`ETIMEDOUT`) | `timeout` |
| Host reachable, **nothing listening** | Immediate `ECONNREFUSED` | `refused` |
| DNS cannot resolve | `ENOTFOUND` / `EAI_AGAIN` after DNS timeout | `dns` |

Teach the difference: "timeout usually means a firewall or route; refused means the port is closed".

## 5. Explanation format (examples)

**SG missing ingress** — short: *"`api` can't reach `db` on TCP 5432."*
deep:
```
Path: api (10.0.1.12) → db (10.0.2.34:5432)
✔ api egress (sg-app): allows all outbound
✔ route: 10.0.2.0/24 → local
✔ db subnet NACL inbound: rule 100 allows 10.0.0.0/16
✘ db instance firewall (sg-db): no inbound rule allows TCP 5432 from sg-app
Fix: add inbound rule to sg-db: TCP 5432 from sg-app
```
**No NAT** — *"`worker` (private subnet) can't reach the internet. Route table `rt-private` has no `0.0.0.0/0` route. Add a NAT gateway in a public subnet and a route."*

**Peering route missing**, **Azure private endpoint DNS**, **GCP tag mismatch** ("firewall rule targets tag `web`; instance has tag `api`"), **OCI Service Gateway route missing** have their own templates. Each reason code has a short and deep template in `packages/network-analyzer/templates/*.md`.

## 6. Fix suggestions (one-click patches)

Each fix is a list of JSON Patch ops against `design.network` (and attachments). Examples:
- Add SG ingress rule (port, source SG).
- Add route `0.0.0.0/0 → nat` and create NAT in a public subnet.
- Add Internet Gateway + public route + assign public IP.
- Add return route on peering side B.
- Add listener port to node.
- Add private DNS zone link / endpoint.
- Change NACL rule order (move allow above deny).
Fixes MUST be minimal and least-privilege (e.g. SG-to-SG, not `0.0.0.0/0`), and the UI shows the diff before applying.

## 7. Integration with the canvas

- **Edge states** (file 16): green = reachable; red dashed with ✖ badge = blocked (hover shows reason); amber = reachable but risky (e.g. DB exposed publicly).
- **Reachability panel**: pick source, destination, protocol/port → result with hop list and fixes. Also "Check all edges" button that lists every blocked edge with reason.
- **Auto-derived edges**: placing a node in a subnet auto-attaches default firewall objects per provider; edges between nodes inherit `protocol/port` from the destination service's `ports` default.
- **Security smells** (feed insights, file 17): DB in public subnet, `0.0.0.0/0` ingress on non-web ports, SSH open to the world, no egress restriction (info), cross-AZ chatty traffic (cost), NAT as hot path (cost).
- Run reachability on each design edit (debounced 150 ms; < 50 ms for ≤ 200 nodes).

## 8. Latency, bandwidth and cost hooks

- Hop latency adds: `igw 0`, `nat +1 ms`, `peering +0.3`, `tgw +1`, `vpn +10`, `endpoint +0.3`, firewall appliance `+1` (editable).
- Mark traffic on each edge as `crossAz`, `crossRegion`, `viaNat`, `viaEndpoint` for the cost engine (file 14).

## 9. Starter lessons (templates with intentionally broken networks)

1. "My DB is unreachable" — missing SG ingress.
2. "Private subnet can't call Stripe" — missing NAT.
3. "Lambda in a VPC can't call DynamoDB" — missing endpoint/NAT.
4. "Peering that doesn't work" — missing route on one side.
5. "Timeout vs refused" — compare firewall drop vs closed port.
6. "GCP tag mismatch" — firewall rule targets wrong tag.
7. "Azure private endpoint resolves to public IP" — missing private DNS zone link.
8. "OCI private bucket access" — missing Service Gateway route.
Each lesson ships a broken design, a goal, and the expected fix; it is checkable by the analyzer (used by challenge mode).

## 10. Golden tests (must pass)

1. Same subnet, SG allows 5432 from SG-ref → reachable.
2. Remove the SG rule → `SG_NO_INGRESS`, `failureMode = timeout`, fix adds the rule.
3. Port not listening, firewall open → `PORT_NOT_LISTENING`, `failureMode = refused`.
4. Private subnet → internet, no NAT route → `NO_NAT`; with NAT in private subnet → `NAT_NOT_IN_PUBLIC_SUBNET`; with correct NAT → reachable.
5. NACL deny rule 90 above allow 100 → `NACL_DENY`; reorder fix works.
6. Stateless NACL without ephemeral return range → `EPHEMERAL_PORTS_BLOCKED`.
7. Peering A–B, route only on A → `MISSING_RETURN_ROUTE`.
8. A–B and B–C peered, A→C → `TRANSITIVE_PEERING_UNSUPPORTED`.
9. Overlapping CIDRs peered → `CIDR_OVERLAP`.
10. GCP firewall priority: deny(100) vs allow(200) → denied; swap priorities → allowed.
11. Azure NSG default rule allows VNet-to-VNet but deny rule at priority 100 wins.
12. Serverless without VPC attachment → private IP → `SERVICE_NOT_IN_VPC`.
13. Private DNS missing for a private endpoint → `PRIVATE_DNS_MISSING`.
14. Property test: a design where every firewall allows any and every subnet routes local is always reachable for same-network pairs.
