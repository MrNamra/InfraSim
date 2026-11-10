import type {
  CustomServiceDefinition,
  Design,
  GroupInstance,
  NodeConfig,
  NodeInstance,
  Provider,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { findEquivalent, getService } from './index.js';

export type CloudTargetProvider = 'aws' | 'gcp' | 'azure' | 'oci';

export interface RegionEquivalenceResolution {
  targetRegion: string;
  label?: string;
  note?: string;
}

export type RegionResolverFn = (
  fromProvider: Provider,
  fromRegion: string,
  toProvider: CloudTargetProvider,
) => RegionEquivalenceResolution | undefined;

export type InstanceTypeResolverFn = (
  targetProvider: CloudTargetProvider,
  sourceConfig: NodeConfig,
  sourceService: ServiceDefinition | undefined,
  targetService: ServiceDefinition,
) => string | undefined;

export interface ProviderSwitchOptions {
  customServices?: readonly CustomServiceDefinition[];
  resolveRegion?: RegionResolverFn;
  resolveInstanceType?: InstanceTypeResolverFn;
  defaultSourceRegion?: string;
  defaultTargetRegion?: string;
  unmappedAction?: 'keep' | 'convert-to-custom';
}

export interface ProviderSwitchNodeDiff {
  nodeId: string;
  nodeLabel: string;
  sourceServiceId: string;
  sourceServiceName: string;
  sourceProvider: Provider;
  targetServiceId: string;
  targetServiceName: string;
  targetProvider: Provider;
  status: 'mapped' | 'already-target' | 'generic-kept' | 'custom-kept' | 'unmapped';
  sourceRegion?: string;
  targetRegion?: string;
  sourceInstanceType?: string;
  targetInstanceType?: string;
  behaviorNotes: string[];
  suggestCustomBlock?: boolean;
}

export interface ProviderSwitchGroupChange {
  groupId: string;
  label: string;
  kind: GroupInstance['kind'];
  fromProvider?: Provider;
  toProvider?: Provider;
  fromRegion?: string;
  toRegion?: string;
  note?: string;
}

export interface ProviderSwitchPlan {
  sourceProvider: Provider;
  targetProvider: CloudTargetProvider;
  approximateMapping: true;
  mappedCount: number;
  unmappedCount: number;
  keptCount: number;
  nodeDiffs: ProviderSwitchNodeDiff[];
  groupChanges: ProviderSwitchGroupChange[];
  behaviorSummary: string[];
}

export interface AppliedProviderSwitch {
  design: Design;
  plan: ProviderSwitchPlan;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  aws: 'AWS',
  gcp: 'GCP',
  azure: 'Azure',
  oci: 'OCI',
  generic: 'Generic',
  custom: 'Custom',
};

function isCloudProvider(provider: Provider | undefined): provider is CloudTargetProvider {
  return provider === 'aws' || provider === 'gcp' || provider === 'azure' || provider === 'oci';
}

function buildBehaviorNotes(
  source: ServiceDefinition,
  target: ServiceDefinition | undefined,
  targetProvider: CloudTargetProvider,
): string[] {
  const notes: string[] = [];

  if (!target) {
    notes.push(
      `No direct managed equivalent for ${source.name} in ${PROVIDER_LABELS[targetProvider]} (${source.equivalents === 'none' ? 'marked none' : 'unmapped'}). Keep as-is or convert to a custom block.`,
    );
    return notes;
  }

  if (source.id === target.id) {
    return notes;
  }

  // Latency baseline drift notice
  if (
    Math.abs(source.latency.p50 - target.latency.p50) >= 2 ||
    Math.abs(source.latency.p95 - target.latency.p95) >= 5
  ) {
    notes.push(
      `Catalog default latency differs: ${source.name} (${source.latency.p50}/${source.latency.p95} ms) -> ${target.name} (${target.latency.p50}/${target.latency.p95} ms).`,
    );
  }

  // Pricing model parity differences
  if (source.pricing.model !== target.pricing.model) {
    notes.push(
      `Billing model shifts from ${source.pricing.model} to ${target.pricing.model}; inspect cost breakdown after switching.`,
    );
  }
  if (target.id === 'gcp.compute_engine') {
    notes.push(
      'GCP Compute Engine bills separately per vCPU-hour and GB RAM-hour by machine family rather than fixed instance bundles.',
    );
  } else if (target.id === 'oci.compute') {
    notes.push('OCI Compute bills per OCPU-hour (1 OCPU = 2 x86 vCPU) plus GB memory-hour.');
  }

  // Role-specific behavioral semantics (spec 06 §8)
  if (source.kind === 'fn' && target.kind === 'fn') {
    notes.push(
      'Serverless cold-start idle TTL, burst concurrency caps, and max execution timeout differ across clouds.',
    );
  } else if (source.kind === 'queue' && target.kind === 'queue') {
    if (target.id === 'gcp.cloud_tasks' || source.id === 'gcp.cloud_tasks') {
      notes.push(
        'Cloud Tasks uses push HTTP dispatch rates whereas SQS / Service Bus / OCI Queue use pull consumers with visibility timeouts.',
      );
    } else if (target.id === 'azure.service_bus' || source.id === 'azure.service_bus') {
      notes.push(
        'Azure Service Bus supports AMQP sessions and dead-letter subqueues with different lock/throughput tiers.',
      );
    }
  } else if (source.kind === 'kv' || source.kind === 'doc') {
    if (target.id === 'azure.cosmos_db' || source.id === 'azure.cosmos_db') {
      notes.push(
        'Cosmos DB scales on RU/s (request units per second) rather than DynamoDB RCU/WCU or Firestore document ops.',
      );
    }
  } else if (source.kind === 'object' && target.kind === 'object') {
    notes.push(
      'Per-prefix/partition rate limits, strong consistency guarantees, and internet egress tiers differ by cloud.',
    );
  } else if (source.kind === 'sql' && target.kind === 'sql') {
    notes.push(
      'Engine clustering, failover time, IOPS scaling, and storage billing differ across managed relational offerings.',
    );
  } else if (source.kind === 'stream' || source.kind === 'bus' || source.kind === 'topic') {
    notes.push(
      'Shard/partition throughput units and retention limits vary between Kinesis, Pub/Sub, Event Hubs, and OCI Streaming.',
    );
  }

  return notes;
}

function makeCustomIdForUnmapped(source: ServiceDefinition, existingIds: Set<string>): string {
  const base = `custom.${source.id.replace(/[^a-z0-9_]+/gi, '_').toLowerCase()}`;
  if (!existingIds.has(base)) {
    existingIds.add(base);
    return base;
  }
  let idx = 2;
  while (existingIds.has(`${base}_${idx}`)) {
    idx += 1;
  }
  const unique = `${base}_${idx}`;
  existingIds.add(unique);
  return unique;
}

function cloneAsCustomService(
  source: ServiceDefinition,
  customId: string,
  targetProvider: CloudTargetProvider,
): CustomServiceDefinition {
  return {
    id: customId,
    provider: 'custom',
    category: source.category,
    name: `${source.name} (${PROVIDER_LABELS[targetProvider]} manual)`,
    kind: source.kind,
    icon: source.icon,
    scope: source.scope,
    latency: structuredClone(source.latency),
    capacity: structuredClone(source.capacity),
    failure: structuredClone(source.failure),
    ...(source.ports ? { ports: structuredClone(source.ports) } : {}),
    operations: structuredClone(source.operations),
    pricing: {
      model: 'free',
    },
    equivalents: 'none',
    tags: [...(source.tags ?? []), 'provider-switch-fallback'],
    description: `Custom placeholder preserved from ${source.id} because ${PROVIDER_LABELS[targetProvider]} has no direct equivalent.`,
  };
}

/** Analyzes switching a Design's primary cloud provider and mapping nodes via catalog `equivalents`. */
export function analyzeProviderSwitch(
  design: Design,
  targetProvider: CloudTargetProvider,
  options: ProviderSwitchOptions = {},
): ProviderSwitchPlan {
  const customServices = [...(design.customServices ?? []), ...(options.customServices ?? [])];
  const sourceProvider: Provider = design.settings.primaryProvider ?? 'aws';
  const nodeDiffs: ProviderSwitchNodeDiff[] = [];
  const groupChanges: ProviderSwitchGroupChange[] = [];
  const summarySet = new Set<string>();

  let mappedCount = 0;
  let unmappedCount = 0;
  let keptCount = 0;

  for (const group of design.groups) {
    const groupSrcProvider = group.provider ?? sourceProvider;
    const regionRes =
      group.region && options.resolveRegion
        ? options.resolveRegion(groupSrcProvider, group.region, targetProvider)
        : undefined;
    const shouldChangeProvider =
      isCloudProvider(group.provider) && group.provider !== targetProvider;
    const nextRegion = regionRes?.targetRegion ?? group.region;
    if (shouldChangeProvider || (group.region && nextRegion !== group.region)) {
      groupChanges.push({
        groupId: group.id,
        label: group.label,
        kind: group.kind,
        fromProvider: group.provider,
        toProvider: shouldChangeProvider ? targetProvider : group.provider,
        fromRegion: group.region,
        toRegion: nextRegion,
        ...(regionRes?.note ? { note: regionRes.note } : {}),
      });
      if (regionRes?.note) {
        summarySet.add(regionRes.note);
      }
    }
  }

  for (const node of design.nodes) {
    const sourceSvc = getService(node.serviceId, customServices);
    const effectiveSourceRegion = node.region ?? options.defaultSourceRegion;

    if (!sourceSvc) {
      unmappedCount += 1;
      const note = `Unknown service "${node.serviceId}" kept unchanged.`;
      summarySet.add(note);
      nodeDiffs.push({
        nodeId: node.id,
        nodeLabel: node.label,
        sourceServiceId: node.serviceId,
        sourceServiceName: node.serviceId,
        sourceProvider,
        targetServiceId: node.serviceId,
        targetServiceName: node.serviceId,
        targetProvider: sourceProvider,
        status: 'unmapped',
        ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
        ...(effectiveSourceRegion ? { targetRegion: effectiveSourceRegion } : {}),
        behaviorNotes: [note],
      });
      continue;
    }

    const regionRes =
      effectiveSourceRegion && isCloudProvider(sourceSvc.provider) && options.resolveRegion
        ? options.resolveRegion(sourceSvc.provider, effectiveSourceRegion, targetProvider)
        : effectiveSourceRegion && options.resolveRegion
          ? options.resolveRegion(sourceProvider, effectiveSourceRegion, targetProvider)
          : undefined;
    const mappedRegion =
      regionRes?.targetRegion ?? options.defaultTargetRegion ?? effectiveSourceRegion;

    if (sourceSvc.provider === 'generic') {
      keptCount += 1;
      nodeDiffs.push({
        nodeId: node.id,
        nodeLabel: node.label,
        sourceServiceId: sourceSvc.id,
        sourceServiceName: sourceSvc.name,
        sourceProvider: 'generic',
        targetServiceId: sourceSvc.id,
        targetServiceName: sourceSvc.name,
        targetProvider: 'generic',
        status: 'generic-kept',
        ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
        ...(mappedRegion ? { targetRegion: mappedRegion } : {}),
        behaviorNotes: [],
      });
      continue;
    }

    if (sourceSvc.provider === 'custom') {
      keptCount += 1;
      nodeDiffs.push({
        nodeId: node.id,
        nodeLabel: node.label,
        sourceServiceId: sourceSvc.id,
        sourceServiceName: sourceSvc.name,
        sourceProvider: 'custom',
        targetServiceId: sourceSvc.id,
        targetServiceName: sourceSvc.name,
        targetProvider: 'custom',
        status: 'custom-kept',
        ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
        ...(mappedRegion ? { targetRegion: mappedRegion } : {}),
        behaviorNotes: [],
      });
      continue;
    }

    if (sourceSvc.provider === targetProvider) {
      keptCount += 1;
      nodeDiffs.push({
        nodeId: node.id,
        nodeLabel: node.label,
        sourceServiceId: sourceSvc.id,
        sourceServiceName: sourceSvc.name,
        sourceProvider: sourceSvc.provider,
        targetServiceId: sourceSvc.id,
        targetServiceName: sourceSvc.name,
        targetProvider,
        status: 'already-target',
        ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
        ...(effectiveSourceRegion ? { targetRegion: effectiveSourceRegion } : {}),
        ...(node.config.instanceType ? { sourceInstanceType: node.config.instanceType } : {}),
        ...(node.config.instanceType ? { targetInstanceType: node.config.instanceType } : {}),
        behaviorNotes: [],
      });
      continue;
    }

    const equiv = findEquivalent(sourceSvc.id, targetProvider, customServices);
    if (!equiv) {
      unmappedCount += 1;
      const notes = buildBehaviorNotes(sourceSvc, undefined, targetProvider);
      for (const n of notes) summarySet.add(n);
      nodeDiffs.push({
        nodeId: node.id,
        nodeLabel: node.label,
        sourceServiceId: sourceSvc.id,
        sourceServiceName: sourceSvc.name,
        sourceProvider: sourceSvc.provider,
        targetServiceId: sourceSvc.id,
        targetServiceName: sourceSvc.name,
        targetProvider: sourceSvc.provider,
        status: 'unmapped',
        ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
        ...(mappedRegion ? { targetRegion: mappedRegion } : {}),
        ...(node.config.instanceType ? { sourceInstanceType: node.config.instanceType } : {}),
        behaviorNotes: notes,
        suggestCustomBlock: true,
      });
      continue;
    }

    mappedCount += 1;
    const notes = buildBehaviorNotes(sourceSvc, equiv, targetProvider);
    for (const n of notes) summarySet.add(n);

    const resolvedInst = options.resolveInstanceType
      ? options.resolveInstanceType(targetProvider, node.config, sourceSvc, equiv)
      : undefined;

    nodeDiffs.push({
      nodeId: node.id,
      nodeLabel: node.label,
      sourceServiceId: sourceSvc.id,
      sourceServiceName: sourceSvc.name,
      sourceProvider: sourceSvc.provider,
      targetServiceId: equiv.id,
      targetServiceName: equiv.name,
      targetProvider,
      status: 'mapped',
      ...(effectiveSourceRegion ? { sourceRegion: effectiveSourceRegion } : {}),
      ...(mappedRegion ? { targetRegion: mappedRegion } : {}),
      ...(node.config.instanceType ? { sourceInstanceType: node.config.instanceType } : {}),
      ...(resolvedInst ? { targetInstanceType: resolvedInst } : {}),
      behaviorNotes: notes,
    });
  }

  return {
    sourceProvider,
    targetProvider,
    approximateMapping: true,
    mappedCount,
    unmappedCount,
    keptCount,
    nodeDiffs,
    groupChanges,
    behaviorSummary: [...summarySet],
  };
}

/** Applies a cross-cloud provider switch onto a cloned Design, returning both updated Design and diff plan. */
export function applyProviderSwitch(
  design: Design,
  targetProvider: CloudTargetProvider,
  options: ProviderSwitchOptions = {},
): AppliedProviderSwitch {
  const plan = analyzeProviderSwitch(design, targetProvider, options);
  const next = structuredClone(design);
  const customServices = [...(next.customServices ?? []), ...(options.customServices ?? [])];
  const existingCustomIds = new Set(customServices.map((c) => c.id));
  const diffByNodeId = new Map(plan.nodeDiffs.map((d) => [d.nodeId, d]));
  const groupChangeById = new Map(plan.groupChanges.map((g) => [g.groupId, g]));

  next.settings = {
    ...next.settings,
    primaryProvider: targetProvider,
  };

  next.groups = next.groups.map((group) => {
    const ch = groupChangeById.get(group.id);
    if (!ch) {
      return group;
    }
    const nextGroup: GroupInstance = { ...group };
    if (ch.toProvider) {
      nextGroup.provider = ch.toProvider;
    }
    if (ch.toRegion) {
      nextGroup.region = ch.toRegion;
      if (group.kind === 'region' && ch.fromRegion && group.label === ch.fromRegion) {
        nextGroup.label = ch.toRegion;
      }
    }
    return nextGroup;
  });

  const nextCustomList = [...(next.customServices ?? [])];
  const unmappedAction = options.unmappedAction ?? 'keep';

  next.nodes = next.nodes.map((node): NodeInstance => {
    const diff = diffByNodeId.get(node.id);
    if (!diff) {
      return node;
    }
    const updated: NodeInstance = structuredClone(node);

    if (diff.status === 'mapped') {
      updated.serviceId = diff.targetServiceId;
      if (diff.targetRegion) {
        updated.region = diff.targetRegion;
      }
      if (diff.targetInstanceType) {
        updated.config.instanceType = diff.targetInstanceType;
      } else if (updated.config.instanceType) {
        // Clear incompatible source cloud SKU string so target pricing does not fail lookup silently
        delete updated.config.instanceType;
      }
      if (updated.config.pricing?.skuKey) {
        delete updated.config.pricing.skuKey;
      }
      return updated;
    }

    if (diff.status === 'unmapped' && unmappedAction === 'convert-to-custom') {
      const sourceSvc = getService(node.serviceId, customServices);
      if (sourceSvc) {
        const customId = makeCustomIdForUnmapped(sourceSvc, existingCustomIds);
        const customDef = cloneAsCustomService(sourceSvc, customId, targetProvider);
        nextCustomList.push(customDef);
        updated.serviceId = customId;
        if (diff.targetRegion) {
          updated.region = diff.targetRegion;
        }
      }
    } else if (diff.targetRegion && diff.status !== 'already-target') {
      updated.region = diff.targetRegion;
    }

    return updated;
  });

  if (nextCustomList.length > 0) {
    next.customServices = nextCustomList;
  }

  return { design: next, plan };
}
