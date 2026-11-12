'use client';

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Network as NetworkIcon,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
} from 'lucide-react';
import { allocateIpFromCidr } from '@infrasim/network-analyzer/cidr';
import { getEffectiveListeningPorts } from '@infrasim/network-analyzer/defaults';
import {
  createEmptyNetworkConfig,
  type Design,
  type DnsZone,
  type FirewallObject,
  type FirewallRule,
  type GroupInstance,
  type NetworkAnalysis,
  type NodeConfig,
  type NodeInstance,
  type RouteTarget,
  type ServiceDefinition,
} from '@infrasim/shared-types';

type ListeningPort = NonNullable<NodeConfig['listeningPorts']>[number];
import { Button } from '@infrasim/ui-kit';

export interface NetworkTabProps {
  design: Design;
  node: NodeInstance | null;
  service?: ServiceDefinition;
  group: GroupInstance | null;
  analysis: NetworkAnalysis | null;
  onApplyPatchedDesign: (nextDesign: Design, changeLabel?: string) => void;
  onOpenReachabilityDock: (edgeId?: string) => void;
}

function cloneDesignWithNetwork(design: Design) {
  const next = structuredClone(design);
  const base = createEmptyNetworkConfig();
  next.network = {
    networks: next.network?.networks ?? base.networks,
    subnets: next.network?.subnets ?? base.subnets,
    routeTables: next.network?.routeTables ?? base.routeTables,
    gateways: next.network?.gateways ?? base.gateways,
    firewalls: next.network?.firewalls ?? base.firewalls,
    peerings: next.network?.peerings ?? base.peerings,
    dnsZones: next.network?.dnsZones ?? base.dnsZones,
    endpoints: next.network?.endpoints ?? base.endpoints,
    attachments: next.network?.attachments ?? base.attachments,
  };
  return {
    next,
    net: next.network as Required<NonNullable<Design['network']>>,
  };
}

function formatSelectorLabel(rule: FirewallRule): string {
  const sel = rule.direction === 'ingress' ? rule.source : rule.destination;
  if (!sel) return '0.0.0.0/0';
  if ('any' in sel && sel.any) return 'any';
  if ('cidr' in sel) return sel.cidr;
  if ('firewallId' in sel) return `fw:${sel.firewallId}`;
  if ('tag' in sel) return `tag:${sel.tag}`;
  return 'any';
}

function formatRouteTargetLabel(target: RouteTarget): string {
  if (target.kind === 'local' || target.kind === 'igw' || target.kind === 'blackhole') {
    return target.kind;
  }
  if (target.kind === 'nat') return `nat:${target.gatewayId}`;
  if (target.kind === 'appliance') return `appliance:${target.nodeId}`;
  return `${target.kind}:${target.id}`;
}

/** Right-side Network inspector for node attachments, listening ports, firewalls, subnet routes, peerings, DNS, and endpoints. */
export function NetworkTab({
  design,
  node,
  service,
  group,
  analysis,
  onApplyPatchedDesign,
  onOpenReachabilityDock,
}: NetworkTabProps) {
  const net = design.network;
  const subnets = net?.subnets ?? [];
  const networks = net?.networks ?? [];
  const routeTables = net?.routeTables ?? [];
  const gateways = net?.gateways ?? [];
  const firewalls = net?.firewalls ?? [];
  const peerings = net?.peerings ?? [];
  const dnsZones = net?.dnsZones ?? [];
  const endpoints = net?.endpoints ?? [];
  const attachments = net?.attachments ?? [];

  const [newPortProto, setNewPortProto] = useState<'tcp' | 'udp'>('tcp');
  const [newPortNum, setNewPortNum] = useState('443');
  const [newAllowCidr, setNewAllowCidr] = useState('10.0.0.0/16');

  // Inline add-firewall-rule state
  const [ruleDirection, setRuleDirection] = useState<'ingress' | 'egress'>('ingress');
  const [ruleAction, setRuleAction] = useState<'allow' | 'deny'>('allow');
  const [ruleProtocol, setRuleProtocol] = useState<'tcp' | 'udp' | 'icmp' | 'any'>('tcp');
  const [rulePort, setRulePort] = useState('443');
  const [rulePriority, setRulePriority] = useState('100');
  const [ruleSelectorKind, setRuleSelectorKind] = useState<'cidr' | 'firewallId' | 'tag' | 'any'>(
    'cidr',
  );
  const [ruleSelectorVal, setRuleSelectorVal] = useState('10.0.0.0/16');

  // Inline add-route state
  const [routeDest, setRouteDest] = useState('0.0.0.0/0');
  const [routeTargetKind, setRouteTargetKind] = useState<
    'local' | 'igw' | 'nat' | 'peering' | 'endpoint' | 'blackhole'
  >('igw');
  const [routeTargetId, setRouteTargetId] = useState('');

  // Inline add-peering / endpoint / DNS state
  const [peerA, setPeerA] = useState(networks[0]?.id ?? '');
  const [peerB, setPeerB] = useState(networks[1]?.id ?? networks[0]?.id ?? '');
  const [epSubnetId, setEpSubnetId] = useState(subnets[0]?.id ?? '');
  const [epServiceId, setEpServiceId] = useState('aws.dynamodb');
  const [epPrivateDns, setEpPrivateDns] = useState(true);
  const [dnsZoneName, setDnsZoneName] = useState('privatelink.internal');
  const [dnsRecName, setDnsRecName] = useState('db.privatelink.internal');
  const [dnsRecVal, setDnsRecVal] = useState('10.0.2.20');

  const nodeAttachment = useMemo(
    () => (node ? attachments.find((a) => a.nodeId === node.id) : undefined),
    [attachments, node],
  );
  const nodeBlockedEdges = useMemo(() => {
    if (!node || !analysis) return [];
    return design.edges.filter(
      (e) => (e.from === node.id || e.to === node.id) && analysis.edges[e.id]?.reachable === false,
    );
  }, [analysis, design.edges, node]);

  const effectivePorts = useMemo(
    () => (node ? getEffectiveListeningPorts(service, node.config) : []),
    [node, service],
  );

  const attachedFirewalls = useMemo(() => {
    if (!node) return [];
    const ids = new Set(nodeAttachment?.firewallIds ?? []);
    const nodeTags = new Set(nodeAttachment?.tags ?? []);
    return firewalls.filter(
      (fw) =>
        ids.has(fw.id) ||
        fw.attachedTo?.nodeIds?.includes(node.id) ||
        fw.attachedTo?.tags?.some((t) => nodeTags.has(t)),
    );
  }, [firewalls, node, nodeAttachment]);

  const selectedSubnet = useMemo(
    () => (group?.kind === 'subnet' ? subnets.find((s) => s.id === group.id) : undefined),
    [group, subnets],
  );
  const selectedSubnetRt = useMemo(
    () =>
      selectedSubnet ? routeTables.find((r) => r.id === selectedSubnet.routeTableId) : undefined,
    [routeTables, selectedSubnet],
  );
  const selectedSubnetFirewalls = useMemo(() => {
    if (!selectedSubnet) return [];
    const ids = new Set(selectedSubnet.firewallIds ?? []);
    return firewalls.filter(
      (fw) => ids.has(fw.id) || fw.attachedTo?.subnetIds?.includes(selectedSubnet.id),
    );
  }, [firewalls, selectedSubnet]);

  const handleChangeNodeSubnet = (subnetId: string) => {
    if (!node) return;
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const targetNode = next.nodes.find((n) => n.id === node.id);
    if (!targetNode) return;
    targetNode.parentGroupId = subnetId || undefined;

    let att = nextNet.attachments.find((a) => a.nodeId === node.id);
    if (!subnetId) {
      if (att) {
        delete att.subnetId;
        delete att.privateIp;
      }
      onApplyPatchedDesign(next, `Detached ${node.label} from subnet`);
      return;
    }

    const sub = nextNet.subnets.find((s) => s.id === subnetId);
    const usedIps = new Set(
      nextNet.attachments
        .filter((a) => a.subnetId === subnetId && a.nodeId !== node.id)
        .map((a) => a.privateIp)
        .filter((ip): ip is string => Boolean(ip)),
    );
    const nextIp = sub ? allocateIpFromCidr(sub.cidr, usedIps) : undefined;
    if (!att) {
      att = { nodeId: node.id, firewallIds: [] };
      nextNet.attachments.push(att);
    }
    att.subnetId = subnetId;
    if (nextIp) att.privateIp = nextIp;
    onApplyPatchedDesign(next, `Moved ${node.label} to subnet ${subnetId}`);
  };

  const handleUpdateAttachmentField = (
    patch: Partial<{ privateIp: string; publicIp: string; tags: string[] }>,
  ) => {
    if (!node) return;
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    let att = nextNet.attachments.find((a) => a.nodeId === node.id);
    if (!att) {
      att = { nodeId: node.id, firewallIds: [] };
      nextNet.attachments.push(att);
    }
    if ('privateIp' in patch) {
      if (patch.privateIp) att.privateIp = patch.privateIp;
      else delete att.privateIp;
    }
    if ('publicIp' in patch) {
      if (patch.publicIp) att.publicIp = patch.publicIp;
      else delete att.publicIp;
    }
    if ('tags' in patch) {
      att.tags = patch.tags;
    }
    onApplyPatchedDesign(next, `Updated ${node.label} network attachment`);
  };

  const handleAddPort = () => {
    if (!node) return;
    const portNum = Math.round(Number(newPortNum));
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) return;
    const { next } = cloneDesignWithNetwork(design);
    const targetNode = next.nodes.find((n) => n.id === node.id);
    if (!targetNode) return;
    const base: ListeningPort[] = targetNode.config.listeningPorts
      ? [...targetNode.config.listeningPorts]
      : [...effectivePorts];
    if (!base.some((p) => p.protocol === newPortProto && p.port === portNum)) {
      base.push({ protocol: newPortProto, port: portNum });
    }
    targetNode.config.listeningPorts = base;
    onApplyPatchedDesign(next, `Added ${newPortProto}:${portNum} listener on ${node.label}`);
  };

  const handleRemovePort = (proto: ListeningPort['protocol'], port: number) => {
    if (!node) return;
    const { next } = cloneDesignWithNetwork(design);
    const targetNode = next.nodes.find((n) => n.id === node.id);
    if (!targetNode) return;
    const base: ListeningPort[] = targetNode.config.listeningPorts
      ? [...targetNode.config.listeningPorts]
      : [...effectivePorts];
    targetNode.config.listeningPorts = base.filter(
      (p) => !(p.protocol === proto && p.port === port),
    );
    onApplyPatchedDesign(next, `Closed ${proto}:${port} on ${node.label}`);
  };

  const handleResetPorts = () => {
    if (!node) return;
    const { next } = cloneDesignWithNetwork(design);
    const targetNode = next.nodes.find((n) => n.id === node.id);
    if (!targetNode) return;
    delete targetNode.config.listeningPorts;
    onApplyPatchedDesign(next, `Reset ${node.label} listening ports to catalog default`);
  };

  const handleAddRuleToFirewall = (fwId: string) => {
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const fw = nextNet.firewalls.find((f) => f.id === fwId);
    if (!fw) return;
    const portVal =
      ruleProtocol === 'any' || ruleProtocol === 'icmp' ? undefined : Number(rulePort);
    const priorityVal = Number(rulePriority);
    const sel =
      ruleSelectorKind === 'any'
        ? ({ any: true } as const)
        : ruleSelectorKind === 'firewallId'
          ? ({ firewallId: ruleSelectorVal.trim() || fwId } as const)
          : ruleSelectorKind === 'tag'
            ? ({ tag: ruleSelectorVal.trim() || 'web' } as const)
            : ({ cidr: ruleSelectorVal.trim() || '10.0.0.0/16' } as const);

    const newRule: FirewallRule = {
      id: `rule-${Date.now().toString(36)}`,
      direction: ruleDirection,
      action: ruleAction,
      ...(Number.isFinite(priorityVal) && priorityVal > 0 ? { priority: priorityVal } : {}),
      protocol: ruleProtocol,
      ...(portVal && Number.isFinite(portVal) ? { portFrom: portVal, portTo: portVal } : {}),
      ...(ruleDirection === 'ingress' ? { source: sel } : { destination: sel }),
    };
    fw.rules.push(newRule);
    onApplyPatchedDesign(next, `Added ${ruleAction} rule to ${fwId}`);
  };

  const handleDeleteRule = (fwId: string, ruleId: string) => {
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const fw = nextNet.firewalls.find((f) => f.id === fwId);
    if (!fw) return;
    fw.rules = fw.rules.filter((r) => r.id !== ruleId);
    onApplyPatchedDesign(next, `Removed rule ${ruleId} from ${fwId}`);
  };

  const handleShiftRulePriority = (fwId: string, ruleId: string, delta: number) => {
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const fw = nextNet.firewalls.find((f) => f.id === fwId);
    if (!fw) return;
    const idx = fw.rules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return;
    const r = fw.rules[idx]!;
    if (r.priority !== undefined) {
      r.priority = Math.max(1, r.priority + delta * 10);
    } else {
      const targetIdx = idx + delta;
      if (targetIdx >= 0 && targetIdx < fw.rules.length) {
        fw.rules.splice(idx, 1);
        fw.rules.splice(targetIdx, 0, r);
      }
    }
    onApplyPatchedDesign(next, `Reordered rule ${ruleId}`);
  };

  const handleCreateFirewallForNode = () => {
    if (!node) return;
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const sub = nodeAttachment?.subnetId
      ? nextNet.subnets.find((s) => s.id === nodeAttachment.subnetId)
      : undefined;
    const parentNet = sub ? nextNet.networks.find((n) => n.id === sub.networkId) : undefined;
    const prov = parentNet?.provider ?? design.settings.primaryProvider;
    const kind: FirewallObject['kind'] =
      prov === 'gcp' ? 'gcp-fw' : prov === 'azure' ? 'nsg' : prov === 'oci' ? 'oci-nsg' : 'sg';
    const fwId = `fw-${node.id}-${nextNet.firewalls.length + 1}`;
    nextNet.firewalls.push({
      id: fwId,
      kind,
      stateful: true,
      rules: [
        {
          id: `${fwId}-egress`,
          direction: 'egress',
          action: 'allow',
          protocol: 'any',
          destination: { any: true },
        },
      ],
    });
    let att = nextNet.attachments.find((a) => a.nodeId === node.id);
    if (!att) {
      att = { nodeId: node.id, firewallIds: [] };
      nextNet.attachments.push(att);
    }
    att.firewallIds.push(fwId);
    onApplyPatchedDesign(next, `Created ${fwId}`);
  };

  const handleAddRoute = (rtId: string) => {
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const rt = nextNet.routeTables.find((r) => r.id === rtId);
    if (!rt) return;
    let target: RouteTarget = { kind: 'local' };
    if (routeTargetKind === 'igw') target = { kind: 'igw' };
    else if (routeTargetKind === 'blackhole') target = { kind: 'blackhole' };
    else if (routeTargetKind === 'nat') {
      target = {
        kind: 'nat',
        gatewayId: routeTargetId || gateways.find((g) => g.kind === 'nat')?.id || 'nat-1',
      };
    } else if (routeTargetKind === 'peering') {
      target = { kind: 'peering', id: routeTargetId || peerings[0]?.id || 'peer-1' };
    } else if (routeTargetKind === 'endpoint') {
      target = { kind: 'endpoint', id: routeTargetId || endpoints[0]?.id || 'vpce-1' };
    }
    rt.routes.push({ dest: routeDest.trim() || '0.0.0.0/0', target });
    onApplyPatchedDesign(next, `Added route ${routeDest} in ${rtId}`);
  };

  const handleRemoveRoute = (rtId: string, idx: number) => {
    const { next, net: nextNet } = cloneDesignWithNetwork(design);
    const rt = nextNet.routeTables.find((r) => r.id === rtId);
    if (!rt) return;
    rt.routes.splice(idx, 1);
    onApplyPatchedDesign(next, `Removed route from ${rtId}`);
  };

  const renderFirewallCard = (fw: FirewallObject) => {
    const sortedRules = [...fw.rules].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));
    return (
      <div
        key={fw.id}
        data-testid={`firewall-card-${fw.id}`}
        className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.5} />
            <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
              {fw.id}
            </span>
          </div>
          <span className="rounded-[4px] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {fw.kind} · {fw.stateful ? 'stateful' : 'stateless'}
          </span>
        </div>

        <div className="mt-2 space-y-1">
          {sortedRules.length === 0 ? (
            <div className="text-[11px] text-[var(--text-muted)]">
              No rules configured (implicit deny).
            </div>
          ) : (
            sortedRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between gap-1.5 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[10px]"
              >
                <div className="min-w-0 flex-1 font-mono tabular-nums text-[var(--text-secondary)]">
                  {rule.priority !== undefined ? `#${rule.priority} ` : ''}
                  <span
                    className={
                      rule.action === 'allow'
                        ? 'text-[var(--status-ok)]'
                        : 'text-[var(--status-overloaded)]'
                    }
                  >
                    {rule.action}
                  </span>{' '}
                  {rule.direction === 'ingress' ? 'in' : 'out'} {rule.protocol}
                  {rule.portFrom !== undefined
                    ? `:${rule.portFrom}${rule.portTo && rule.portTo !== rule.portFrom ? `-${rule.portTo}` : ''}`
                    : ''}{' '}
                  {rule.direction === 'ingress' ? 'from' : 'to'} {formatSelectorLabel(rule)}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Move rule higher priority"
                    onClick={() => handleShiftRulePriority(fw.id, rule.id, -1)}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
                  >
                    <ArrowUp className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move rule lower priority"
                    onClick={() => handleShiftRulePriority(fw.id, rule.id, 1)}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
                  >
                    <ArrowDown className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove firewall rule"
                    onClick={() => handleDeleteRule(fw.id, rule.id)}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-2 grid grid-cols-4 gap-1 border-t border-[var(--border-hairline)] pt-2">
          <select
            aria-label="Rule direction"
            value={ruleDirection}
            onChange={(e) => setRuleDirection(e.target.value as 'ingress' | 'egress')}
            className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 text-[10px] text-[var(--text-primary)]"
          >
            <option value="ingress">ingress</option>
            <option value="egress">egress</option>
          </select>
          <select
            aria-label="Rule action"
            value={ruleAction}
            onChange={(e) => setRuleAction(e.target.value as 'allow' | 'deny')}
            className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 text-[10px] text-[var(--text-primary)]"
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
          <select
            aria-label="Rule protocol"
            value={ruleProtocol}
            onChange={(e) => setRuleProtocol(e.target.value as 'tcp' | 'udp' | 'icmp' | 'any')}
            className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 text-[10px] text-[var(--text-primary)]"
          >
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
            <option value="any">any</option>
            <option value="icmp">icmp</option>
          </select>
          <input
            type="text"
            aria-label="Port"
            placeholder="443"
            value={rulePort}
            onChange={(e) => setRulePort(e.target.value)}
            className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] tabular-nums text-[var(--text-primary)]"
          />
          <select
            aria-label="Selector kind"
            value={ruleSelectorKind}
            onChange={(e) =>
              setRuleSelectorKind(e.target.value as 'cidr' | 'firewallId' | 'tag' | 'any')
            }
            className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 text-[10px] text-[var(--text-primary)]"
          >
            <option value="cidr">CIDR</option>
            <option value="firewallId">SG ref</option>
            <option value="tag">Tag</option>
            <option value="any">Any</option>
          </select>
          <input
            type="text"
            aria-label="Selector value"
            placeholder="10.0.0.0/16"
            disabled={ruleSelectorKind === 'any'}
            value={ruleSelectorVal}
            onChange={(e) => setRuleSelectorVal(e.target.value)}
            className="col-span-2 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)] disabled:opacity-40"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleAddRuleToFirewall(fw.id)}
            className="h-7 px-1.5 text-[10px]"
          >
            <Plus className="h-3 w-3" strokeWidth={1.5} />
            <span>Rule</span>
          </Button>
          {!fw.stateful || fw.kind === 'gcp-fw' || fw.kind === 'nsg' ? (
            <input
              type="number"
              aria-label="Rule priority"
              value={rulePriority}
              onChange={(e) => setRulePriority(e.target.value)}
              placeholder="Priority"
              className="col-span-2 h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] tabular-nums text-[var(--text-primary)]"
            />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div data-testid="inspector-network-tab" className="space-y-4 p-4 text-[12px]">
      {node ? (
        <>
          {nodeBlockedEdges.length > 0 ? (
            <div className="rounded-[8px] border border-[var(--status-overloaded)] bg-[rgba(229,72,77,0.08)] p-2.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--status-overloaded)]">
                <span>
                  {nodeBlockedEdges.length} blocked path{nodeBlockedEdges.length > 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenReachabilityDock(nodeBlockedEdges[0]?.id)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
                >
                  <NetworkIcon className="h-3 w-3" strokeWidth={1.5} />
                  <span>Inspect in Reachability</span>
                </button>
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                {analysis?.edges[nodeBlockedEdges[0]!.id]?.explanation.short}
              </p>
            </div>
          ) : null}

          {/* Subnet & IP attachment */}
          <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
            <div className="text-[11px] font-medium text-[var(--text-secondary)]">
              Interface & subnet attachment
            </div>
            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Subnet</span>
              <select
                aria-label="Attached subnet"
                value={nodeAttachment?.subnetId ?? ''}
                onChange={(e) => handleChangeNodeSubnet(e.target.value)}
                className="mt-1 h-8 w-full rounded-[6px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
              >
                <option value="">Unattached (managed / public endpoint)</option>
                {subnets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} ({s.cidr})
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Private IP</span>
                <input
                  type="text"
                  value={nodeAttachment?.privateIp ?? ''}
                  placeholder="10.0.1.10"
                  onChange={(e) => handleUpdateAttachmentField({ privateIp: e.target.value })}
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>

              <label className="block">
                <span className="text-[11px] text-[var(--text-muted)]">Public IP</span>
                <input
                  type="text"
                  value={nodeAttachment?.publicIp ?? ''}
                  placeholder="None"
                  onChange={(e) => handleUpdateAttachmentField({ publicIp: e.target.value })}
                  className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-[11px] text-[var(--text-muted)]">Tags (comma-separated)</span>
              <input
                type="text"
                value={(nodeAttachment?.tags ?? []).join(', ')}
                placeholder="api, backend"
                onChange={(e) =>
                  handleUpdateAttachmentField({
                    tags: e.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-1 h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
              />
            </label>
          </div>

          {/* Listening ports */}
          <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                Listening ports
              </span>
              {node.config.listeningPorts !== undefined ? (
                <button
                  type="button"
                  onClick={handleResetPorts}
                  className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
                >
                  <RotateCcw className="h-3 w-3" strokeWidth={1.5} />
                  <span>Reset default</span>
                </button>
              ) : (
                <span className="text-[10px] text-[var(--text-muted)]">
                  Typical default — edit me
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {effectivePorts.length === 0 ? (
                <span className="text-[11px] text-[var(--text-muted)]">
                  No open ports (inbound connections fail with ECONNREFUSED).
                </span>
              ) : (
                effectivePorts.map((p) => (
                  <span
                    key={`${p.protocol}-${p.port}`}
                    className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
                  >
                    <span>
                      {p.protocol}/{p.port}
                    </span>
                    <button
                      type="button"
                      aria-label={`Close port ${p.protocol} ${p.port}`}
                      onClick={() => handleRemovePort(p.protocol, p.port)}
                      className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>

            <div className="flex items-center gap-1.5 pt-1">
              <select
                aria-label="New port protocol"
                value={newPortProto}
                onChange={(e) => setNewPortProto(e.target.value as 'tcp' | 'udp')}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[11px] text-[var(--text-primary)]"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
              <input
                type="number"
                min={1}
                max={65535}
                value={newPortNum}
                onChange={(e) => setNewPortNum(e.target.value)}
                className="h-7 w-20 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] tabular-nums text-[var(--text-primary)]"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddPort}
                className="h-7 px-2 text-[11px]"
              >
                <Plus className="h-3 w-3" strokeWidth={1.5} />
                <span>Add port</span>
              </Button>
            </div>
          </div>

          {/* Service firewall allowlist */}
          {!nodeAttachment?.subnetId || node.config.firewallAllowlist !== undefined ? (
            <div className="space-y-2 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Service firewall IP allowlist
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(node.config.firewallAllowlist ?? []).length === 0 ? (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Unrestricted (allows all if endpoint is public).
                  </span>
                ) : (
                  (node.config.firewallAllowlist ?? []).map((cidr, i) => (
                    <span
                      key={`${cidr}-${i}`}
                      className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-primary)]"
                    >
                      <span>{cidr}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const { next } = cloneDesignWithNetwork(design);
                          const n = next.nodes.find((x) => x.id === node.id);
                          if (!n) return;
                          const rem = (n.config.firewallAllowlist ?? []).filter(
                            (_, idx) => idx !== i,
                          );
                          n.config.firewallAllowlist = rem;
                          onApplyPatchedDesign(next, `Updated allowlist on ${node.label}`);
                        }}
                        className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newAllowCidr}
                  onChange={(e) => setNewAllowCidr(e.target.value)}
                  className="h-7 flex-1 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[11px] text-[var(--text-primary)]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const cidr = newAllowCidr.trim();
                    if (!cidr) return;
                    const { next } = cloneDesignWithNetwork(design);
                    const n = next.nodes.find((x) => x.id === node.id);
                    if (!n) return;
                    n.config.firewallAllowlist = [...(n.config.firewallAllowlist ?? []), cidr];
                    onApplyPatchedDesign(next, `Allowed ${cidr} on ${node.label}`);
                  }}
                  className="h-7 px-2 text-[11px]"
                >
                  Add CIDR
                </Button>
              </div>
            </div>
          ) : null}

          {/* Attached instance firewalls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                Instance firewalls ({attachedFirewalls.length})
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCreateFirewallForNode}
                className="h-7 px-2 text-[10px]"
              >
                <Plus className="h-3 w-3" strokeWidth={1.5} />
                <span>New firewall</span>
              </Button>
            </div>
            {attachedFirewalls.length === 0 ? (
              <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5 text-[11px] text-[var(--text-muted)]">
                No firewalls attached. Place in a subnet or create a firewall.
              </div>
            ) : (
              attachedFirewalls.map(renderFirewallCard)
            )}
          </div>
        </>
      ) : null}

      {/* Selected subnet route table & NACL */}
      {selectedSubnet ? (
        <div className="space-y-3">
          <div className="rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                Subnet {selectedSubnet.id}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                {selectedSubnet.cidr}
              </span>
            </div>
            {selectedSubnetRt ? (
              <div className="mt-2.5 space-y-1.5">
                <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Route table ({selectedSubnetRt.id})
                </div>
                {selectedSubnetRt.routes.map((rt, i) => (
                  <div
                    key={`${rt.dest}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono text-[10px]"
                  >
                    <span className="tabular-nums text-[var(--text-primary)]">{rt.dest}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[var(--text-secondary)]">
                        → {formatRouteTargetLabel(rt.target)}
                      </span>
                      <button
                        type="button"
                        aria-label="Delete route"
                        onClick={() => handleRemoveRoute(selectedSubnetRt.id, i)}
                        className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                      >
                        <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
                <div className="grid grid-cols-3 gap-1 pt-1">
                  <input
                    type="text"
                    value={routeDest}
                    onChange={(e) => setRouteDest(e.target.value)}
                    placeholder="0.0.0.0/0"
                    className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                  />
                  <select
                    aria-label="Route target kind"
                    value={routeTargetKind}
                    onChange={(e) =>
                      setRouteTargetKind(
                        e.target.value as
                          'local' | 'igw' | 'nat' | 'peering' | 'endpoint' | 'blackhole',
                      )
                    }
                    className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 text-[10px] text-[var(--text-primary)]"
                  >
                    <option value="igw">igw</option>
                    <option value="nat">nat</option>
                    <option value="peering">peering</option>
                    <option value="endpoint">endpoint</option>
                    <option value="local">local</option>
                    <option value="blackhole">blackhole</option>
                  </select>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAddRoute(selectedSubnetRt.id)}
                    className="h-7 px-2 text-[10px]"
                  >
                    Add route
                  </Button>
                </div>
                {routeTargetKind === 'nat' ||
                routeTargetKind === 'peering' ||
                routeTargetKind === 'endpoint' ? (
                  <input
                    type="text"
                    placeholder="Target gateway / peering / endpoint ID"
                    value={routeTargetId}
                    onChange={(e) => setRouteTargetId(e.target.value)}
                    className="h-7 w-full rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 font-mono text-[10px] text-[var(--text-primary)]"
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {selectedSubnetFirewalls.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                Subnet firewalls / NACLs
              </div>
              {selectedSubnetFirewalls.map(renderFirewallCard)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Topology-wide Peerings, Endpoints & DNS */}
      <div className="space-y-3 border-t border-[var(--border-hairline)] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            Topology networking ({networks.length} VPCs, {peerings.length} peerings,{' '}
            {endpoints.length} endpoints)
          </span>
          <button
            type="button"
            onClick={() => onOpenReachabilityDock()}
            className="text-[11px] font-medium text-[var(--accent)] hover:underline"
          >
            Reachability
          </button>
        </div>

        {/* Peerings */}
        <div className="space-y-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">VPC peerings</div>
          {peerings.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono text-[10px]"
            >
              <span className="text-[var(--text-primary)]">
                {p.a} ↔ {p.b}
              </span>
              <button
                type="button"
                aria-label={`Delete peering ${p.id}`}
                onClick={() => {
                  const { next, net: nextNet } = cloneDesignWithNetwork(design);
                  nextNet.peerings = nextNet.peerings.filter((x) => x.id !== p.id);
                  onApplyPatchedDesign(next, `Removed peering ${p.id}`);
                }}
                className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
              >
                <Trash2 className="h-3 w-3" strokeWidth={1.5} />
              </button>
            </div>
          ))}
          {networks.length >= 2 ? (
            <div className="grid grid-cols-3 gap-1 pt-1">
              <select
                value={peerA || networks[0]?.id}
                onChange={(e) => setPeerA(e.target.value)}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 font-mono text-[10px] text-[var(--text-primary)]"
              >
                {networks.map((nw) => (
                  <option key={nw.id} value={nw.id}>
                    {nw.name || nw.id}
                  </option>
                ))}
              </select>
              <select
                value={peerB || networks[1]?.id}
                onChange={(e) => setPeerB(e.target.value)}
                className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 font-mono text-[10px] text-[var(--text-primary)]"
              >
                {networks.map((nw) => (
                  <option key={nw.id} value={nw.id}>
                    {nw.name || nw.id}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const a = peerA || networks[0]?.id;
                  const b = peerB || networks[1]?.id;
                  if (!a || !b || a === b) return;
                  const { next, net: nextNet } = cloneDesignWithNetwork(design);
                  nextNet.peerings.push({
                    id: `peer-${a}-${b}`,
                    a,
                    b,
                    routedA: true,
                    routedB: true,
                    transitive: false,
                  });
                  onApplyPatchedDesign(next, `Added peering ${a} <-> ${b}`);
                }}
                className="h-7 px-2 text-[10px]"
              >
                Peer
              </Button>
            </div>
          ) : null}
        </div>

        {/* Private Endpoints */}
        <div className="space-y-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            Private endpoints & Service GW
          </div>
          {endpoints.map((ep) => (
            <div
              key={ep.id}
              className="flex items-center justify-between gap-2 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[10px]"
            >
              <div className="min-w-0 font-mono text-[var(--text-primary)]">
                {ep.id} · {ep.serviceId}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={Boolean(ep.privateDns)}
                    onChange={(e) => {
                      const { next, net: nextNet } = cloneDesignWithNetwork(design);
                      const target = nextNet.endpoints.find((x) => x.id === ep.id);
                      if (target) target.privateDns = e.target.checked;
                      onApplyPatchedDesign(next, `Toggled private DNS on ${ep.id}`);
                    }}
                  />
                  <span>DNS</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const { next, net: nextNet } = cloneDesignWithNetwork(design);
                    nextNet.endpoints = nextNet.endpoints.filter((x) => x.id !== ep.id);
                    onApplyPatchedDesign(next, `Removed endpoint ${ep.id}`);
                  }}
                  className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
          {networks.length > 0 && subnets.length > 0 ? (
            <div className="space-y-1 pt-1">
              <div className="grid grid-cols-2 gap-1">
                <input
                  type="text"
                  value={epServiceId}
                  onChange={(e) => setEpServiceId(e.target.value)}
                  placeholder="aws.dynamodb"
                  className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                />
                <select
                  aria-label="Endpoint subnet"
                  value={epSubnetId || subnets[0]?.id}
                  onChange={(e) => setEpSubnetId(e.target.value)}
                  className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 font-mono text-[10px] text-[var(--text-primary)]"
                >
                  {subnets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={epPrivateDns}
                    onChange={(e) => setEpPrivateDns(e.target.checked)}
                  />
                  <span>Private DNS</span>
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const subObj = subnets.find((s) => s.id === (epSubnetId || subnets[0]?.id));
                    const nwId = subObj?.networkId ?? networks[0]?.id;
                    const subId = subObj?.id;
                    if (!nwId || !subId || !epServiceId.trim()) return;
                    const { next, net: nextNet } = cloneDesignWithNetwork(design);
                    const epId = `ep-${nextNet.endpoints.length + 1}`;
                    nextNet.endpoints.push({
                      id: epId,
                      networkId: nwId,
                      subnetId: subId,
                      serviceId: epServiceId.trim(),
                      privateDns: epPrivateDns,
                    });
                    onApplyPatchedDesign(next, `Added endpoint for ${epServiceId}`);
                  }}
                  className="h-7 px-2 text-[10px]"
                >
                  Add endpoint
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Private DNS zones */}
        <div className="space-y-1.5 rounded-[8px] border border-[var(--border-hairline)] bg-[var(--bg-sunken)] p-2.5">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">DNS zones</div>
          {dnsZones.map((z) => (
            <div
              key={z.id}
              className="rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1.5 text-[10px]"
            >
              <div className="flex items-center justify-between font-mono">
                <span className="text-[var(--text-primary)]">
                  {z.name} ({z.private ? 'private' : 'public'})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const { next, net: nextNet } = cloneDesignWithNetwork(design);
                    nextNet.dnsZones = nextNet.dnsZones.filter((x) => x.id !== z.id);
                    onApplyPatchedDesign(next, `Removed DNS zone ${z.name}`);
                  }}
                  className="text-[var(--text-muted)] hover:text-[var(--status-overloaded)]"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                </button>
              </div>
              {z.records.map((rec, ri) => (
                <div
                  key={`${rec.name}-${ri}`}
                  className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]"
                >
                  {rec.name} {rec.type} → {rec.value}
                </div>
              ))}
            </div>
          ))}
          <div className="grid grid-cols-3 gap-1 pt-1">
            <input
              type="text"
              value={dnsZoneName}
              onChange={(e) => setDnsZoneName(e.target.value)}
              placeholder="internal"
              className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
            />
            <input
              type="text"
              value={dnsRecName}
              onChange={(e) => setDnsRecName(e.target.value)}
              placeholder="db.internal"
              className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
            />
            <input
              type="text"
              value={dnsRecVal}
              onChange={(e) => setDnsRecVal(e.target.value)}
              placeholder="10.0.1.20"
              className="h-7 rounded-[5px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 font-mono text-[10px] text-[var(--text-primary)]"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const { next, net: nextNet } = cloneDesignWithNetwork(design);
              const newZone: DnsZone = {
                id: `dns-${nextNet.dnsZones.length + 1}`,
                name: dnsZoneName.trim() || 'internal',
                private: true,
                networkIds: networks.map((nw) => nw.id),
                records: [
                  {
                    name: dnsRecName.trim() || 'db.internal',
                    type: 'A',
                    value: dnsRecVal.trim() || '10.0.1.20',
                  },
                ],
              };
              nextNet.dnsZones.push(newZone);
              onApplyPatchedDesign(next, `Added private DNS zone ${newZone.name}`);
            }}
            className="h-7 w-full text-[10px]"
          >
            Add private DNS zone
          </Button>
        </div>
      </div>
    </div>
  );
}
