import { createEmptyDesign, type Design, type EdgeInstance } from '@infrasim/shared-types';
import { TERRAFORM_MAX_INPUT_BYTES } from '../types.js';
import { classifyTerraformResources } from './classifier.js';
import { inferTerraformEdges } from './edgeInference.js';
import { layoutDesignWithElk } from './layout.js';
import { flattenTerraformModules } from './parser.js';
import { parseAndSanitizeTerraformJson } from './sanitizer.js';
import { buildTopologyAndNetwork } from './topology.js';
import type {
  TerraformImportOptions,
  TerraformImportReport,
  TerraformImportResult,
  TerraformUnsupportedResourceInfo,
  UnknownInstanceTypeNotice,
} from './types.js';

export const DEFAULT_TERRAFORM_IMPORT_TIMEOUT_MS = 10_000;

const ENTRY_SERVICE_PRIORITY = [
  'aws.route53',
  'gcp.cloud_dns',
  'azure.dns',
  'oci.dns',
  'aws.cloudfront',
  'azure.front_door',
  'aws.waf',
  'aws.apigw_http',
  'aws.apigw_rest',
  'azure.apim',
  'oci.api_gateway',
  'aws.alb',
  'aws.nlb',
  'gcp.lb_https',
  'azure.app_gateway',
  'azure.load_balancer',
  'oci.load_balancer',
  'oci.network_lb',
];

function selectImportedEntryNodeId(nodes: Design['nodes'], edges: EdgeInstance[]): string {
  if (nodes.length === 0) return '';
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    outDegree.set(n.id, 0);
  }
  for (const e of edges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const rootsWithOut = nodes.filter(
    (n) => (inDegree.get(n.id) ?? 0) === 0 && (outDegree.get(n.id) ?? 0) > 0,
  );
  const candidates =
    rootsWithOut.length > 0 ? rootsWithOut : nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const pool = candidates.length > 0 ? candidates : nodes;

  for (const svcId of ENTRY_SERVICE_PRIORITY) {
    const hit = pool.find((n) => n.serviceId === svcId);
    if (hit) return hit.id;
  }
  return pool[0]!.id;
}

/**
 * Parses and sanitizes `terraform show -json` (plan or state), reconstructs containment,
 * NetworkConfig, conservatively inferred edges, and compound ELK layout, returning a runnable Design + Import Report.
 */
export async function importTerraformJson(
  rawInput: string | Record<string, unknown>,
  options: TerraformImportOptions = {},
): Promise<TerraformImportResult> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const startedAt = nowMs();
  const maxBytes = options.maxBytes ?? TERRAFORM_MAX_INPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERRAFORM_IMPORT_TIMEOUT_MS;

  const assertWithinTimeout = () => {
    const elapsed = nowMs() - startedAt;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Terraform import exceeded ${Math.round(timeoutMs / 1000)}s time limit (${elapsed}ms).`,
      );
    }
  };

  const sanitized = parseAndSanitizeTerraformJson(rawInput, maxBytes);
  assertWithinTimeout();

  const flattened = flattenTerraformModules(sanitized);
  assertWithinTimeout();

  const classified = classifyTerraformResources(flattened);
  assertWithinTimeout();

  const topology = buildTopologyAndNetwork(classified);
  assertWithinTimeout();

  const inferred = inferTerraformEdges(classified, topology);
  assertWithinTimeout();

  const warnings = [...sanitized.warnings];
  const unsupported: TerraformUnsupportedResourceInfo[] = [];
  const unknownInstanceTypes: UnknownInstanceTypeNotice[] = [];
  const ignoredTypesSet = new Set<string>();
  let mappedCount = 0;
  let groupCount = 0;
  let networkObjectCount = 0;
  let ignoredCount = 0;
  let needsRuntimePrompt = false;

  for (const item of classified) {
    if (item.classification === 'node') {
      mappedCount++;
      const nodeId = topology.addressToEntityId.get(item.resource.address) ?? '';
      if (item.nodeConfig?.runtimePreset === 'custom') {
        needsRuntimePrompt = true;
      }
      if (item.unknownInstanceType && nodeId) {
        unknownInstanceTypes.push({
          nodeId,
          ...item.unknownInstanceType,
        });
        warnings.push(
          `Unknown instance type "${item.unknownInstanceType.instanceType}" on ${item.unknownInstanceType.nodeLabel}; verify vCPU & memory in Config.`,
        );
      }
    } else if (item.classification === 'group') {
      groupCount++;
    } else if (item.classification === 'networkObject') {
      networkObjectCount++;
    } else if (item.classification === 'unsupported') {
      const nodeId = topology.addressToEntityId.get(item.resource.address) ?? '';
      unsupported.push({
        address: item.resource.address,
        nodeId,
        type: item.resource.type,
        providerName: item.provider ?? item.resource.providerName,
        label: item.label,
      });
    } else if (item.classification === 'ignored') {
      ignoredCount++;
      ignoredTypesSet.add(item.resource.type);
    }
  }

  if (inferred.edges.length > 0) {
    warnings.push(
      `Inferred ${inferred.edges.length} connection${inferred.edges.length === 1 ? '' : 's'} from Terraform references (shown dashed until confirmed).`,
    );
  }
  if (needsRuntimePrompt) {
    warnings.push(
      'Imported compute/function nodes default to runtimePreset "custom" with typical concurrency limits; pick a language preset in Config before stress-testing.',
    );
  }

  const primaryProvider = sanitized.providersDetected[0] ?? 'aws';
  const entryNodeId = selectImportedEntryNodeId(topology.nodes, inferred.edges);

  const baseDesign = createEmptyDesign(
    `tf-import-${Math.abs(
      Array.from(sanitized.formatVersion + topology.nodes.map((n) => n.id).join(',')).reduce(
        (acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0,
        7,
      ),
    ).toString(36)}`,
    options.designName?.trim() || 'Imported Terraform architecture',
  );
  baseDesign.groups = topology.groups;
  baseDesign.nodes = topology.nodes;
  baseDesign.edges = inferred.edges;
  baseDesign.network = topology.network;
  baseDesign.settings = {
    ...baseDesign.settings,
    primaryProvider,
  };
  baseDesign.scenarios = [
    {
      id: 'scenario-imported',
      name: 'Imported baseline load',
      durationS: 30,
      entryNodeId,
      profile: { kind: 'constant', rps: 50 },
      flows: [
        {
          id: 'flow-imported-default',
          name: 'Primary request',
          weight: 1,
          steps: [{ method: 'GET', path: '/' }],
        },
      ],
      chaos: [],
    },
  ];

  const laidOutDesign = await layoutDesignWithElk(baseDesign);
  assertWithinTimeout();

  const elapsedMs = Math.max(0, Math.round(nowMs() - startedAt));
  const report: TerraformImportReport = {
    sourceKind: sanitized.sourceKind,
    formatVersion: sanitized.formatVersion,
    providersDetected: sanitized.providersDetected,
    mappedCount,
    groupCount,
    networkObjectCount,
    unsupported,
    ignoredCount,
    ignoredTypes: [...ignoredTypesSet].sort(),
    warnings,
    inferredEdges: inferred.reportInfos,
    unknownInstanceTypes,
    needsRuntimePrompt,
    strippedSensitiveCount: sanitized.strippedSensitiveCount,
    elapsedMs,
  };

  return {
    design: laidOutDesign,
    report,
  };
}
