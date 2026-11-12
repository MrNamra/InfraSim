import type { Design, NodeConfig } from '@infrasim/shared-types';
import type { CloudProviderId } from '../mappings/types.js';

/** Raw module structure appearing in `planned_values.root_module` or `values.root_module`. */
export interface RawTerraformModule {
  address?: string;
  resources?: RawTerraformResource[];
  child_modules?: RawTerraformModule[];
}

/** Raw resource entry inside a Terraform show-JSON module tree. */
export interface RawTerraformResource {
  address?: string;
  mode?: 'managed' | 'data';
  type?: string;
  name?: string;
  index?: string | number;
  provider_name?: string;
  values?: Record<string, unknown>;
  sensitive_values?: unknown;
}

/** Raw configuration expression tree from `configuration.root_module`. */
export interface RawTerraformConfigModule {
  resources?: RawTerraformConfigResource[];
  module_calls?: Record<
    string,
    {
      module?: RawTerraformConfigModule;
    }
  >;
}

export interface RawTerraformConfigResource {
  address?: string;
  mode?: 'managed' | 'data';
  type?: string;
  name?: string;
  provider_config_key?: string;
  expressions?: Record<string, unknown>;
}

/** Result of parsing, validating, and sanitizing `terraform show -json`. */
export interface SanitizedTerraformDocument {
  sourceKind: 'plan' | 'state';
  formatVersion: string;
  terraformVersion?: string;
  rootModule: RawTerraformModule;
  configurationRoot?: RawTerraformConfigModule;
  providersDetected: CloudProviderId[];
  warnings: string[];
  strippedSensitiveCount: number;
}

/** Flattened resource record retaining full module address and extracted expression references. */
export interface NormalizedPlanResource {
  address: string;
  baseAddress: string;
  moduleAddress: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  index?: string | number;
  providerName: string;
  values: Record<string, unknown>;
  /** All Terraform expression reference strings keyed by flattened attribute path AND leaf key. */
  referencesByAttr: Record<string, string[]>;
  /** Ordered list of all reference targets mentioned in this resource's expressions. */
  allReferences: string[];
}

export type ImportedResourceClassification =
  'node' | 'group' | 'networkObject' | 'edgeSource' | 'ignored' | 'unsupported';

export interface UnknownInstanceTypeNotice {
  nodeId: string;
  nodeLabel: string;
  serviceId: string;
  provider: CloudProviderId;
  instanceType: string;
}

export interface ClassifiedResource {
  resource: NormalizedPlanResource;
  classification: ImportedResourceClassification;
  provider?: CloudProviderId;
  serviceId?: string;
  groupKind?: 'vpc' | 'subnet';
  label: string;
  region?: string;
  az?: string;
  cidr?: string;
  isPublicSubnet?: boolean;
  nodeConfig?: NodeConfig;
  importedAttrs: Record<string, unknown>;
  unknownInstanceType?: Omit<UnknownInstanceTypeNotice, 'nodeId'>;
  networkRole?: string;
  edgeRole?: string;
  ignoreReason?: string;
}

export interface TerraformUnsupportedResourceInfo {
  address: string;
  nodeId: string;
  type: string;
  providerName: string;
  label: string;
}

export interface TerraformInferredEdgeInfo {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  fromLabel: string;
  toLabel: string;
  protocol: string;
  port?: number;
  callType: 'sync' | 'async';
  confidence: number;
  reason: string;
}

/** Structured summary produced alongside the reconstructed canvas Design. */
export interface TerraformImportReport {
  sourceKind: 'plan' | 'state';
  formatVersion: string;
  providersDetected: CloudProviderId[];
  mappedCount: number;
  groupCount: number;
  networkObjectCount: number;
  unsupported: TerraformUnsupportedResourceInfo[];
  ignoredCount: number;
  ignoredTypes: string[];
  warnings: string[];
  inferredEdges: TerraformInferredEdgeInfo[];
  unknownInstanceTypes: UnknownInstanceTypeNotice[];
  needsRuntimePrompt: boolean;
  strippedSensitiveCount: number;
  elapsedMs: number;
}

/** Options controlling `importTerraformJson`. */
export interface TerraformImportOptions {
  maxBytes?: number;
  timeoutMs?: number;
  designName?: string;
  /** Optional clock override for deterministic timeout checks. */
  nowMs?: () => number;
}

/** Return value of `importTerraformJson`. */
export interface TerraformImportResult {
  design: Design;
  report: TerraformImportReport;
}
