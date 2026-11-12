import type {
  Attachment,
  Design,
  DnsZone,
  FirewallObject,
  FirewallRule,
  FixSuggestion,
  Gateway,
  JsonPatchOp,
  Network,
  Peering,
  PrivateEndpoint,
  ReasonCode,
  RouteTable,
  Selector,
  ServiceDefinition,
  Subnet,
} from '@infrasim/shared-types';
import { allocateIpFromCidr } from './cidr.js';
import {
  getEffectiveListeningPorts,
  inferSubnetPublicness,
  resolveServiceDef,
} from './defaults.js';

export interface FixBuildContext {
  design: Design;
  reasonCode: ReasonCode;
  srcNodeId: string;
  dstNodeId: string;
  srcIp?: string;
  dstIp?: string;
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  port: number;
  srcSubnet?: Subnet;
  dstSubnet?: Subnet;
  srcNetwork?: Network;
  dstNetwork?: Network;
  srcAttachment?: Attachment;
  dstAttachment?: Attachment;
  srcPrimarySg?: FirewallObject;
  dstPrimarySg?: FirewallObject;
  blockingObjectKind?: string;
  blockingObjectId?: string;
  blockingRuleId?: string;
  blockedDirection?: 'ingress' | 'egress';
  customServices?: readonly ServiceDefinition[];
}

function appendArrayOp(
  currentArray: readonly unknown[] | undefined,
  basePath: string,
  item: unknown,
): JsonPatchOp {
  if (!currentArray) {
    return { op: 'add', path: basePath, value: [item] };
  }
  return { op: 'add', path: `${basePath}/-`, value: item };
}

function decodePointer(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

export interface PatchOpLike {
  op: string;
  path: string;
  value?: unknown;
  from?: string;
}

/**
 * Pure RFC 6902 patch executor against a cloned Design or document object.
 * Safely creates missing `/network` containers if needed without mutating input.
 */
export function applyNetworkPatch<T>(doc: T, ops: readonly PatchOpLike[]): T {
  const copy = structuredClone(doc);
  for (const op of ops) {
    if (!op.path.startsWith('/')) {
      throw new Error(`Invalid JSON Patch pointer "${op.path}"`);
    }
    const parts = op.path.slice(1).split('/').map(decodePointer);
    let cursor: unknown = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (Array.isArray(cursor)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
          throw new Error(`Invalid array index "${seg}" in patch "${op.path}"`);
        }
        cursor = cursor[idx];
      } else if (cursor && typeof cursor === 'object') {
        const obj = cursor as Record<string, unknown>;
        if (!(seg in obj) || obj[seg] === undefined) {
          obj[seg] = {};
        }
        cursor = obj[seg];
      } else {
        throw new Error(`Cannot traverse "${seg}" in patch "${op.path}"`);
      }
    }
    const key = parts[parts.length - 1]!;
    if (Array.isArray(cursor)) {
      if (op.op === 'add') {
        if (key === '-') {
          cursor.push(structuredClone(op.value));
        } else {
          const idx = Number(key);
          cursor.splice(idx, 0, structuredClone(op.value));
        }
      } else if (op.op === 'replace') {
        const idx = Number(key);
        cursor[idx] = structuredClone(op.value);
      } else if (op.op === 'remove') {
        const idx = Number(key);
        cursor.splice(idx, 1);
      }
    } else if (cursor && typeof cursor === 'object') {
      const obj = cursor as Record<string, unknown>;
      if (op.op === 'add' || op.op === 'replace') {
        obj[key] = structuredClone(op.value);
      } else if (op.op === 'remove') {
        delete obj[key];
      }
    }
  }
  return copy;
}

export interface PatchDiffLine {
  kind: 'add' | 'replace' | 'remove';
  path: string;
  summary: string;
}

/** Converts JSON Patch ops into concise human-readable diff lines for confirmation UIs. */
export function formatPatchDiffLines(ops: readonly PatchOpLike[]): PatchDiffLine[] {
  return ops.map((op) => {
    const valStr = op.value !== undefined ? JSON.stringify(op.value) : '';
    const clipped = valStr.length > 140 ? `${valStr.slice(0, 137)}...` : valStr;
    if (op.op === 'add') {
      return { kind: 'add', path: op.path, summary: `+ ${op.path} = ${clipped}` };
    }
    if (op.op === 'replace') {
      return { kind: 'replace', path: op.path, summary: `~ ${op.path} = ${clipped}` };
    }
    return { kind: 'remove', path: op.path, summary: `- ${op.path}` };
  });
}

function buildPeerSourceSelector(ctx: FixBuildContext): Selector {
  if (
    ctx.srcPrimarySg &&
    ctx.dstPrimarySg &&
    ctx.srcPrimarySg.kind === 'sg' &&
    ctx.dstPrimarySg.kind === 'sg' &&
    ctx.srcNetwork?.id === ctx.dstNetwork?.id
  ) {
    return { firewallId: ctx.srcPrimarySg.id };
  }
  if (ctx.srcIp && ctx.srcIp !== 'internet') {
    return { cidr: `${ctx.srcIp}/32` };
  }
  if (ctx.srcSubnet?.cidr) {
    return { cidr: ctx.srcSubnet.cidr };
  }
  return { cidr: '10.0.0.0/16' };
}

/** Generates minimal, least-privilege JSON Patch remediation options for a blocked network query. */
export function buildReachabilityFixes(ctx: FixBuildContext): FixSuggestion[] {
  const net = ctx.design.network ?? {};
  const firewalls = net.firewalls ?? [];
  const routeTables = net.routeTables ?? [];
  const gateways = net.gateways ?? [];
  const subnets = net.subnets ?? [];
  const attachments = net.attachments ?? [];
  const endpoints = net.endpoints ?? [];
  const dnsZones = net.dnsZones ?? [];
  const peerings = net.peerings ?? [];

  const proto = ctx.protocol;
  const port = ctx.port;

  switch (ctx.reasonCode) {
    case 'SG_NO_INGRESS': {
      const targetFwId = ctx.blockingObjectId ?? ctx.dstPrimarySg?.id;
      const fwIdx = targetFwId ? firewalls.findIndex((f) => f.id === targetFwId) : -1;
      const sourceSel = buildPeerSourceSelector(ctx);
      const newRule: FirewallRule = {
        id: `fix-ing-${ctx.srcNodeId}-${ctx.dstNodeId}-${port}`,
        direction: 'ingress',
        action: 'allow',
        protocol: proto,
        portFrom: port,
        portTo: port,
        source: sourceSel,
        description: `Allow ${proto.toUpperCase()} ${port} from ${ctx.srcNodeId}`,
      };
      if (fwIdx >= 0) {
        return [
          {
            label: `Add ${proto.toUpperCase()} ${port} inbound rule to ${firewalls[fwIdx]!.id}`,
            patch: [
              appendArrayOp(firewalls[fwIdx]!.rules, `/network/firewalls/${fwIdx}/rules`, newRule),
            ],
          },
        ];
      }
      return [];
    }

    case 'SG_NO_EGRESS': {
      const targetFwId = ctx.blockingObjectId ?? ctx.srcPrimarySg?.id;
      const fwIdx = targetFwId ? firewalls.findIndex((f) => f.id === targetFwId) : -1;
      if (fwIdx < 0) return [];
      const destSel: Selector =
        ctx.dstPrimarySg &&
        ctx.srcPrimarySg?.kind === 'sg' &&
        ctx.dstPrimarySg.kind === 'sg' &&
        ctx.srcNetwork?.id === ctx.dstNetwork?.id
          ? { firewallId: ctx.dstPrimarySg.id }
          : ctx.dstIp
            ? { cidr: `${ctx.dstIp}/32` }
            : { cidr: '0.0.0.0/0' };
      const newRule: FirewallRule = {
        id: `fix-egr-${ctx.srcNodeId}-${ctx.dstNodeId}-${port}`,
        direction: 'egress',
        action: 'allow',
        protocol: proto,
        portFrom: port,
        portTo: port,
        destination: destSel,
        description: `Allow ${proto.toUpperCase()} ${port} outbound to ${ctx.dstNodeId}`,
      };
      return [
        {
          label: `Add ${proto.toUpperCase()} ${port} outbound rule to ${firewalls[fwIdx]!.id}`,
          patch: [
            appendArrayOp(firewalls[fwIdx]!.rules, `/network/firewalls/${fwIdx}/rules`, newRule),
          ],
        },
      ];
    }

    case 'NACL_DENY':
    case 'NSG_DENY':
    case 'GCP_FW_DENY':
    case 'OCI_SL_NO_RULE': {
      const fwId = ctx.blockingObjectId;
      const fwIdx = fwId ? firewalls.findIndex((f) => f.id === fwId) : -1;
      if (fwIdx < 0) return [];
      const fw = firewalls[fwIdx]!;
      const blockingRule = ctx.blockingRuleId
        ? fw.rules.find((r) => r.id === ctx.blockingRuleId)
        : undefined;
      const blockingIdx = ctx.blockingRuleId
        ? fw.rules.findIndex((r) => r.id === ctx.blockingRuleId)
        : -1;

      const isEgress =
        blockingRule?.direction === 'egress' || ctx.blockingObjectId?.includes('egr');
      const blockPriority = blockingRule?.priority ?? 100;

      // Check if an allow rule exists in the same direction that simply has worse priority
      const existingAllowIdx = fw.rules.findIndex(
        (r) =>
          r.action === 'allow' &&
          r.direction === (blockingRule?.direction ?? 'ingress') &&
          (r.portFrom === undefined || (port >= r.portFrom && port <= (r.portTo ?? r.portFrom))),
      );

      // Special case: GCP tag mismatch fix
      if (
        ctx.reasonCode === 'GCP_FW_DENY' &&
        blockingRule?.action === 'allow' &&
        fw.attachedTo?.tags?.length &&
        ctx.dstAttachment
      ) {
        const attIdx = attachments.findIndex((a) => a.nodeId === ctx.dstNodeId);
        if (attIdx >= 0) {
          const targetTag = fw.attachedTo.tags[0]!;
          const curTags = attachments[attIdx]!.tags ?? [];
          if (!curTags.includes(targetTag)) {
            return [
              {
                label: `Add tag "${targetTag}" to ${ctx.dstNodeId}`,
                patch: [
                  {
                    op: 'replace',
                    path: `/network/attachments/${attIdx}/tags`,
                    value: [...curTags, targetTag],
                  },
                ],
              },
            ];
          }
        }
      }

      if (existingAllowIdx >= 0 && blockingRule?.action === 'deny' && blockingIdx >= 0) {
        const targetPriority = Math.max(1, blockPriority - 10);
        return [
          {
            label: `Move allow rule priority (${targetPriority}) above deny rule ${blockingRule.id} (${blockPriority})`,
            patch: [
              {
                op: 'replace',
                path: `/network/firewalls/${fwIdx}/rules/${existingAllowIdx}/priority`,
                value: targetPriority,
              },
            ],
          },
        ];
      }

      const direction = blockingRule?.direction ?? (isEgress ? 'egress' : 'ingress');
      const newPriority = Math.max(1, blockPriority - 10);
      const srcSel = buildPeerSourceSelector(ctx);
      const dstSel: Selector =
        ctx.dstIp && ctx.dstIp !== 'internet' ? { cidr: `${ctx.dstIp}/32` } : { cidr: '0.0.0.0/0' };
      const allowRule: FirewallRule = {
        id: `fix-${fw.id}-${direction}-${port}-${newPriority}`,
        direction,
        action: 'allow',
        priority: newPriority,
        protocol: proto,
        portFrom: port,
        portTo: port,
        ...(direction === 'ingress' ? { source: srcSel } : { destination: dstSel }),
        description: `Allow ${proto.toUpperCase()} ${port}`,
      };
      const ops: JsonPatchOp[] = [
        appendArrayOp(fw.rules, `/network/firewalls/${fwIdx}/rules`, allowRule),
      ];
      // Also align GCP tag if rule exists cleanly on target tags
      if (ctx.reasonCode === 'GCP_FW_DENY' && fw.attachedTo?.tags?.length && ctx.dstAttachment) {
        const attIdx = attachments.findIndex((a) => a.nodeId === ctx.dstNodeId);
        const needTag = fw.attachedTo.tags[0]!;
        if (attIdx >= 0 && !(ctx.dstAttachment.tags ?? []).includes(needTag)) {
          ops.push({
            op: 'replace',
            path: `/network/attachments/${attIdx}/tags`,
            value: [...(ctx.dstAttachment.tags ?? []), needTag],
          });
        }
      }
      return [
        {
          label: `Add allow ${proto.toUpperCase()} ${port} rule (priority ${newPriority}) to ${fw.id}`,
          patch: ops,
        },
      ];
    }

    case 'EPHEMERAL_PORTS_BLOCKED': {
      const fwId = ctx.blockingObjectId;
      const fwIdx = fwId ? firewalls.findIndex((f) => f.id === fwId) : -1;
      if (fwIdx < 0) return [];
      const fw = firewalls[fwIdx]!;
      const blockingRule = ctx.blockingRuleId
        ? fw.rules.find((r) => r.id === ctx.blockingRuleId)
        : undefined;
      const direction =
        ctx.blockedDirection ??
        blockingRule?.direction ??
        (ctx.dstSubnet?.firewallIds?.includes(fw.id) ? 'egress' : 'ingress');
      const priority = Math.max(1, (blockingRule?.priority ?? 100) - 10);
      const allowEphemeral: FirewallRule = {
        id: `fix-ephemeral-${fw.id}-${direction}`,
        direction,
        action: 'allow',
        priority,
        protocol: 'tcp',
        portFrom: 1024,
        portTo: 65535,
        ...(direction === 'ingress'
          ? { source: { cidr: '0.0.0.0/0' } }
          : { destination: { cidr: '0.0.0.0/0' } }),
        description: 'Allow ephemeral return ports (1024-65535)',
      };
      return [
        {
          label: `Allow TCP 1024-65535 return traffic in ${fw.id}`,
          patch: [appendArrayOp(fw.rules, `/network/firewalls/${fwIdx}/rules`, allowEphemeral)],
        },
      ];
    }

    case 'PORT_NOT_LISTENING': {
      const dstNodeIdx = ctx.design.nodes.findIndex((n) => n.id === ctx.dstNodeId);
      if (dstNodeIdx < 0) return [];
      const dstNode = ctx.design.nodes[dstNodeIdx]!;
      const dstSvc = resolveServiceDef(dstNode.serviceId, ctx.customServices ?? []);
      const existing = getEffectiveListeningPorts(dstSvc, dstNode.config);
      const nextPorts = [...existing, { protocol: proto === 'any' ? 'tcp' : proto, port }];
      return [
        {
          label: `Listen on ${proto.toUpperCase()} ${port} on ${dstNode.label}`,
          patch: [
            {
              op: dstNode.config.listeningPorts !== undefined ? 'replace' : 'add',
              path: `/nodes/${dstNodeIdx}/config/listeningPorts`,
              value: nextPorts,
            },
          ],
        },
      ];
    }

    case 'NO_NAT': {
      if (!ctx.srcSubnet || !ctx.srcNetwork) return [];
      const rtIdx = routeTables.findIndex((r) => r.id === ctx.srcSubnet!.routeTableId);
      if (rtIdx < 0) return [];
      // Prefer an existing NAT in a public subnet; else find or create a public subnet NAT
      const existingValidNat = gateways.find((g) => {
        if (g.kind !== 'nat' || g.networkId !== ctx.srcNetwork!.id) return false;
        const gSub = subnets.find((s) => s.id === g.subnetId);
        return gSub ? inferSubnetPublicness(gSub, net) : false;
      });
      if (existingValidNat) {
        return [
          {
            label: `Add 0.0.0.0/0 -> NAT (${existingValidNat.id}) route to ${ctx.srcSubnet.routeTableId}`,
            patch: [
              appendArrayOp(routeTables[rtIdx]!.routes, `/network/routeTables/${rtIdx}/routes`, {
                dest: '0.0.0.0/0',
                target: { kind: 'nat', gatewayId: existingValidNat.id },
              }),
            ],
          },
        ];
      }

      const publicSub = subnets.find(
        (s) => s.networkId === ctx.srcNetwork!.id && inferSubnetPublicness(s, net),
      );
      const natId = `nat-${ctx.srcNetwork.id}`;
      const ops: JsonPatchOp[] = [];
      let targetSubId = publicSub?.id;

      if (!targetSubId) {
        const pubSubId = `sub-pub-${ctx.srcNetwork.id}`;
        const pubRtId = `rt-pub-${ctx.srcNetwork.id}`;
        const igwExists = gateways.some(
          (g) => g.kind === 'igw' && g.networkId === ctx.srcNetwork!.id,
        );
        if (!igwExists) {
          const igw: Gateway = {
            id: `igw-${ctx.srcNetwork.id}`,
            kind: 'igw',
            networkId: ctx.srcNetwork.id,
          };
          ops.push(appendArrayOp(net.gateways, '/network/gateways', igw));
        }
        const pubRt: RouteTable = {
          id: pubRtId,
          routes: [
            { dest: ctx.srcNetwork.cidrs[0] ?? '10.0.0.0/16', target: { kind: 'local' } },
            { dest: '0.0.0.0/0', target: { kind: 'igw' } },
          ],
        };
        ops.push(appendArrayOp(net.routeTables, '/network/routeTables', pubRt));
        const pubSubnet: Subnet = {
          id: pubSubId,
          networkId: ctx.srcNetwork.id,
          cidr: '10.0.250.0/24',
          routeTableId: pubRtId,
          autoAssignPublicIp: true,
        };
        ops.push(appendArrayOp(net.subnets, '/network/subnets', pubSubnet));
        targetSubId = pubSubId;
      }

      const natGw: Gateway = {
        id: natId,
        kind: 'nat',
        networkId: ctx.srcNetwork.id,
        subnetId: targetSubId,
        publicIp: true,
      };
      ops.push(appendArrayOp(net.gateways, '/network/gateways', natGw));
      ops.push(
        appendArrayOp(routeTables[rtIdx]!.routes, `/network/routeTables/${rtIdx}/routes`, {
          dest: '0.0.0.0/0',
          target: { kind: 'nat', gatewayId: natId },
        }),
      );
      return [
        {
          label: `Add NAT gateway in ${targetSubId} and route 0.0.0.0/0 from ${ctx.srcSubnet.routeTableId}`,
          patch: ops,
        },
      ];
    }

    case 'NAT_NOT_IN_PUBLIC_SUBNET': {
      const natId = ctx.blockingObjectId;
      const gwIdx = natId ? gateways.findIndex((g) => g.id === natId) : -1;
      if (gwIdx < 0 || !ctx.srcNetwork) return [];
      const publicSub = subnets.find(
        (s) => s.networkId === ctx.srcNetwork!.id && inferSubnetPublicness(s, net),
      );
      if (publicSub) {
        return [
          {
            label: `Move NAT gateway ${natId} into public subnet ${publicSub.id}`,
            patch: [
              {
                op: 'replace',
                path: `/network/gateways/${gwIdx}/subnetId`,
                value: publicSub.id,
              },
            ],
          },
        ];
      }
      const natSub = subnets.find((s) => s.id === gateways[gwIdx]!.subnetId);
      const natRtIdx = natSub ? routeTables.findIndex((r) => r.id === natSub.routeTableId) : -1;
      if (natRtIdx >= 0) {
        const ops: JsonPatchOp[] = [];
        if (!gateways.some((g) => g.kind === 'igw' && g.networkId === ctx.srcNetwork!.id)) {
          ops.push(
            appendArrayOp(net.gateways, '/network/gateways', {
              id: `igw-${ctx.srcNetwork.id}`,
              kind: 'igw',
              networkId: ctx.srcNetwork.id,
            }),
          );
        }
        ops.push(
          appendArrayOp(routeTables[natRtIdx]!.routes, `/network/routeTables/${natRtIdx}/routes`, {
            dest: '0.0.0.0/0',
            target: { kind: 'igw' },
          }),
        );
        return [
          {
            label: `Add IGW route 0.0.0.0/0 to NAT subnet route table ${natSub!.routeTableId}`,
            patch: ops,
          },
        ];
      }
      return [];
    }

    case 'NO_PUBLIC_IP': {
      const attIdx = attachments.findIndex((a) => a.nodeId === ctx.srcNodeId);
      if (attIdx < 0) return [];
      return [
        {
          label: `Assign a public IP to ${ctx.srcNodeId}`,
          patch: [
            {
              op: 'add',
              path: `/network/attachments/${attIdx}/publicIp`,
              value: '198.51.100.10',
            },
          ],
        },
      ];
    }

    case 'NO_ROUTE': {
      if (!ctx.srcSubnet) return [];
      const rtIdx = routeTables.findIndex((r) => r.id === ctx.srcSubnet!.routeTableId);
      if (rtIdx < 0) return [];
      const dstCidr = ctx.dstNetwork?.cidrs[0] ?? '0.0.0.0/0';
      const matchingPeer =
        ctx.srcNetwork && ctx.dstNetwork
          ? peerings.find(
              (p) =>
                (p.a === ctx.srcNetwork!.id && p.b === ctx.dstNetwork!.id) ||
                (p.b === ctx.srcNetwork!.id && p.a === ctx.dstNetwork!.id),
            )
          : undefined;
      if (matchingPeer) {
        return [
          {
            label: `Add peering route ${dstCidr} -> ${matchingPeer.id} to ${ctx.srcSubnet.routeTableId}`,
            patch: [
              appendArrayOp(routeTables[rtIdx]!.routes, `/network/routeTables/${rtIdx}/routes`, {
                dest: dstCidr,
                target: { kind: 'peering', id: matchingPeer.id },
              }),
            ],
          },
        ];
      }
      return [
        {
          label: `Add default IGW route 0.0.0.0/0 to ${ctx.srcSubnet.routeTableId}`,
          patch: [
            appendArrayOp(routeTables[rtIdx]!.routes, `/network/routeTables/${rtIdx}/routes`, {
              dest: '0.0.0.0/0',
              target: { kind: 'igw' },
            }),
          ],
        },
      ];
    }

    case 'MISSING_RETURN_ROUTE':
    case 'PEERING_NOT_ROUTED': {
      if (!ctx.dstSubnet || !ctx.srcNetwork) return [];
      const dstRtIdx = routeTables.findIndex((r) => r.id === ctx.dstSubnet!.routeTableId);
      if (dstRtIdx < 0) return [];
      const srcCidr = ctx.srcNetwork.cidrs[0] ?? '10.0.0.0/16';
      const peering = ctx.dstNetwork
        ? peerings.find(
            (p) =>
              (p.a === ctx.srcNetwork!.id && p.b === ctx.dstNetwork!.id) ||
              (p.b === ctx.srcNetwork!.id && p.a === ctx.dstNetwork!.id),
          )
        : undefined;
      const target: RouteTable['routes'][number]['target'] = peering
        ? { kind: 'peering', id: peering.id }
        : { kind: 'igw' };
      const ops: JsonPatchOp[] = [
        appendArrayOp(routeTables[dstRtIdx]!.routes, `/network/routeTables/${dstRtIdx}/routes`, {
          dest: srcCidr,
          target,
        }),
      ];
      if (peering) {
        const pIdx = peerings.findIndex((p) => p.id === peering.id);
        if (pIdx >= 0) {
          ops.push({
            op: 'replace',
            path: `/network/peerings/${pIdx}/${peering.a === ctx.dstNetwork?.id ? 'routedA' : 'routedB'}`,
            value: true,
          });
        }
      }
      return [
        {
          label: `Add return route ${srcCidr} to ${ctx.dstSubnet.routeTableId}`,
          patch: ops,
        },
      ];
    }

    case 'TRANSITIVE_PEERING_UNSUPPORTED': {
      if (!ctx.srcNetwork || !ctx.dstNetwork || !ctx.srcSubnet || !ctx.dstSubnet) return [];
      const srcRtIdx = routeTables.findIndex((r) => r.id === ctx.srcSubnet!.routeTableId);
      const dstRtIdx = routeTables.findIndex((r) => r.id === ctx.dstSubnet!.routeTableId);
      if (srcRtIdx < 0 || dstRtIdx < 0) return [];
      const newPeerId = `peer-${ctx.srcNetwork.id}-${ctx.dstNetwork.id}`;
      const newPeering: Peering = {
        id: newPeerId,
        a: ctx.srcNetwork.id,
        b: ctx.dstNetwork.id,
        routedA: true,
        routedB: true,
        transitive: false,
      };
      return [
        {
          label: `Create direct peering ${ctx.srcNetwork.name} <-> ${ctx.dstNetwork.name} with symmetric routes`,
          patch: [
            appendArrayOp(net.peerings, '/network/peerings', newPeering),
            appendArrayOp(
              routeTables[srcRtIdx]!.routes,
              `/network/routeTables/${srcRtIdx}/routes`,
              {
                dest: ctx.dstNetwork.cidrs[0] ?? '10.2.0.0/16',
                target: { kind: 'peering', id: newPeerId },
              },
            ),
            appendArrayOp(
              routeTables[dstRtIdx]!.routes,
              `/network/routeTables/${dstRtIdx}/routes`,
              {
                dest: ctx.srcNetwork.cidrs[0] ?? '10.0.0.0/16',
                target: { kind: 'peering', id: newPeerId },
              },
            ),
          ],
        },
      ];
    }

    case 'ENDPOINT_MISSING': {
      if (!ctx.srcNetwork || !ctx.srcSubnet) return [];
      const dstNode = ctx.design.nodes.find((n) => n.id === ctx.dstNodeId);
      if (!dstNode) return [];
      const epId = `ep-${ctx.srcNetwork.id}-${dstNode.id}`;
      const endpoint: PrivateEndpoint = {
        id: epId,
        networkId: ctx.srcNetwork.id,
        subnetId: ctx.srcSubnet.id,
        serviceId: dstNode.serviceId,
        privateDns: true,
      };
      const ops: JsonPatchOp[] = [appendArrayOp(net.endpoints, '/network/endpoints', endpoint)];
      const rtIdx = routeTables.findIndex((r) => r.id === ctx.srcSubnet!.routeTableId);
      if (rtIdx >= 0) {
        ops.push(
          appendArrayOp(routeTables[rtIdx]!.routes, `/network/routeTables/${rtIdx}/routes`, {
            dest: '0.0.0.0/0',
            target: { kind: 'endpoint', id: epId },
          }),
        );
      }
      return [
        {
          label: `Create Private Endpoint / Service Gateway for ${dstNode.label} in ${ctx.srcSubnet.id}`,
          patch: ops,
        },
      ];
    }

    case 'PRIVATE_DNS_MISSING': {
      const epIdx = endpoints.findIndex((ep) => ep.id === ctx.blockingObjectId);
      if (epIdx >= 0) {
        return [
          {
            label: `Enable private DNS on endpoint ${endpoints[epIdx]!.id}`,
            patch: [
              {
                op: 'replace',
                path: `/network/endpoints/${epIdx}/privateDns`,
                value: true,
              },
            ],
          },
        ];
      }
      const zIdx = dnsZones.findIndex((z) => z.id === ctx.blockingObjectId);
      if (zIdx >= 0 && ctx.srcNetwork) {
        return [
          {
            label: `Link private DNS zone ${dnsZones[zIdx]!.name} to ${ctx.srcNetwork.name}`,
            patch: [
              appendArrayOp(
                dnsZones[zIdx]!.networkIds,
                `/network/dnsZones/${zIdx}/networkIds`,
                ctx.srcNetwork.id,
              ),
            ],
          },
        ];
      }
      return [];
    }

    case 'DNS_UNRESOLVED': {
      if (!ctx.srcNetwork) return [];
      const newZone: DnsZone = {
        id: `dns-${ctx.dstNodeId}`,
        name: 'internal.local',
        private: true,
        networkIds: [ctx.srcNetwork.id],
        records: [
          {
            name: ctx.dstNodeId,
            type: 'A',
            value: ctx.dstIp ?? '10.0.1.20',
          },
        ],
      };
      return [
        {
          label: `Add private DNS record for ${ctx.dstNodeId}`,
          patch: [appendArrayOp(net.dnsZones, '/network/dnsZones', newZone)],
        },
      ];
    }

    case 'SERVICE_NOT_IN_VPC': {
      if (!ctx.dstSubnet) return [];
      const usedIps = new Set(attachments.filter((a) => a.privateIp).map((a) => a.privateIp!));
      const newAtt: Attachment = {
        nodeId: ctx.srcNodeId,
        subnetId: ctx.dstSubnet.id,
        privateIp: allocateIpFromCidr(ctx.dstSubnet.cidr, usedIps),
        firewallIds: ctx.srcPrimarySg ? [ctx.srcPrimarySg.id] : [],
      };
      const existingAttIdx = attachments.findIndex((a) => a.nodeId === ctx.srcNodeId);
      return [
        {
          label: `Attach ${ctx.srcNodeId} to subnet ${ctx.dstSubnet.id}`,
          patch: [
            existingAttIdx >= 0
              ? {
                  op: 'replace',
                  path: `/network/attachments/${existingAttIdx}`,
                  value: newAtt,
                }
              : appendArrayOp(net.attachments, '/network/attachments', newAtt),
          ],
        },
      ];
    }

    case 'SERVICE_FIREWALL_BLOCK': {
      const dstNodeIdx = ctx.design.nodes.findIndex((n) => n.id === ctx.dstNodeId);
      if (dstNodeIdx < 0) return [];
      const curList = ctx.design.nodes[dstNodeIdx]!.config.firewallAllowlist ?? [];
      const ipToAllow = ctx.srcIp && ctx.srcIp !== 'internet' ? `${ctx.srcIp}/32` : '10.0.0.0/16';
      return [
        {
          label: `Allow ${ipToAllow} in ${ctx.design.nodes[dstNodeIdx]!.label} service firewall`,
          patch: [
            {
              op:
                ctx.design.nodes[dstNodeIdx]!.config.firewallAllowlist !== undefined
                  ? 'replace'
                  : 'add',
              path: `/nodes/${dstNodeIdx}/config/firewallAllowlist`,
              value: [...curList, ipToAllow],
            },
          ],
        },
      ];
    }

    case 'DIFFERENT_REGION_NO_CONNECTIVITY': {
      if (!ctx.srcNetwork || !ctx.dstNetwork || !ctx.srcSubnet || !ctx.dstSubnet) return [];
      const srcRtIdx = routeTables.findIndex((r) => r.id === ctx.srcSubnet!.routeTableId);
      const dstRtIdx = routeTables.findIndex((r) => r.id === ctx.dstSubnet!.routeTableId);
      if (srcRtIdx < 0 || dstRtIdx < 0) return [];
      const peerId = `peer-xregion-${ctx.srcNetwork.id}-${ctx.dstNetwork.id}`;
      return [
        {
          label: `Create cross-region peering ${ctx.srcNetwork.name} <-> ${ctx.dstNetwork.name}`,
          patch: [
            appendArrayOp(net.peerings, '/network/peerings', {
              id: peerId,
              a: ctx.srcNetwork.id,
              b: ctx.dstNetwork.id,
              routedA: true,
              routedB: true,
              transitive: false,
            }),
            appendArrayOp(
              routeTables[srcRtIdx]!.routes,
              `/network/routeTables/${srcRtIdx}/routes`,
              {
                dest: ctx.dstNetwork.cidrs[0] ?? '10.1.0.0/16',
                target: { kind: 'peering', id: peerId },
              },
            ),
            appendArrayOp(
              routeTables[dstRtIdx]!.routes,
              `/network/routeTables/${dstRtIdx}/routes`,
              {
                dest: ctx.srcNetwork.cidrs[0] ?? '10.0.0.0/16',
                target: { kind: 'peering', id: peerId },
              },
            ),
          ],
        },
      ];
    }

    default:
      return [];
  }
}
