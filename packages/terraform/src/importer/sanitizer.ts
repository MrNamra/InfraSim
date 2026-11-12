import type { CloudProviderId } from '../mappings/types.js';
import { isSecretKeyName } from '../naming.js';
import { TERRAFORM_MAX_INPUT_BYTES } from '../types.js';
import type {
  RawTerraformConfigModule,
  RawTerraformModule,
  RawTerraformResource,
  SanitizedTerraformDocument,
} from './types.js';

const CORE_PROVIDER_ALIASES = new Map<string, CloudProviderId>([
  ['aws', 'aws'],
  ['hashicorp/aws', 'aws'],
  ['registry.terraform.io/hashicorp/aws', 'aws'],
  ['google', 'gcp'],
  ['google-beta', 'gcp'],
  ['hashicorp/google', 'gcp'],
  ['hashicorp/google-beta', 'gcp'],
  ['registry.terraform.io/hashicorp/google', 'gcp'],
  ['registry.terraform.io/hashicorp/google-beta', 'gcp'],
  ['azurerm', 'azure'],
  ['hashicorp/azurerm', 'azure'],
  ['registry.terraform.io/hashicorp/azurerm', 'azure'],
  ['oci', 'oci'],
  ['oracle/oci', 'oci'],
  ['hashicorp/oci', 'oci'],
  ['registry.terraform.io/oracle/oci', 'oci'],
  ['registry.terraform.io/hashicorp/oci', 'oci'],
]);

const BENIGN_UTILITY_PROVIDERS = new Set([
  'null',
  'random',
  'time',
  'local',
  'tls',
  'archive',
  'external',
  'http',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a Terraform `provider_name` or `provider_config_key` to a known InfraSim CloudProviderId. */
export function normalizeTerraformProviderName(providerName?: string): {
  cloudProvider?: CloudProviderId;
  utility: boolean;
  shortName: string;
} {
  if (!providerName) {
    return { utility: false, shortName: '' };
  }
  const lower = providerName.trim().toLowerCase();
  const direct = CORE_PROVIDER_ALIASES.get(lower);
  if (direct) {
    return { cloudProvider: direct, utility: false, shortName: direct };
  }
  const parts = lower.split('/');
  const last = parts[parts.length - 1] ?? lower;
  const byLast = CORE_PROVIDER_ALIASES.get(last);
  if (byLast) {
    return { cloudProvider: byLast, utility: false, shortName: byLast };
  }
  if (BENIGN_UTILITY_PROVIDERS.has(last)) {
    return { utility: true, shortName: last };
  }
  return { utility: false, shortName: last };
}

interface SanitizeCounters {
  strippedCount: number;
}

/**
 * Recursively strips any field flagged by `sensitive_values` OR matching the secret key deny-list.
 * Also handles `{ name: "DB_PASSWORD", value: "..." }` environment arrays common in cloud providers.
 */
function sanitizeValueNode(
  value: unknown,
  sensitiveMask: unknown,
  counters: SanitizeCounters,
  parentKey?: string,
): unknown {
  if (sensitiveMask === true) {
    counters.strippedCount++;
    return undefined;
  }
  if (parentKey && isSecretKeyName(parentKey) && value !== undefined && value !== null) {
    counters.strippedCount++;
    return undefined;
  }

  if (Array.isArray(value)) {
    const maskArr = Array.isArray(sensitiveMask) ? sensitiveMask : undefined;
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const cleaned = sanitizeValueNode(value[i], maskArr?.[i], counters);
      if (cleaned !== undefined) {
        out.push(cleaned);
      }
    }
    return out;
  }

  if (isPlainObject(value)) {
    // Cloud container env entries frequently take `{ name: "API_SECRET", value: "..." }` shape.
    if (
      typeof value.name === 'string' &&
      isSecretKeyName(value.name) &&
      Object.prototype.hasOwnProperty.call(value, 'value')
    ) {
      counters.strippedCount++;
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'value') continue;
        const cleaned = sanitizeValueNode(v, undefined, counters, k);
        if (cleaned !== undefined) copy[k] = cleaned;
      }
      return copy;
    }

    const maskObj = isPlainObject(sensitiveMask) ? sensitiveMask : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = sanitizeValueNode(v, maskObj?.[k], counters, k);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    }
    return out;
  }

  return value;
}

function sanitizeModuleTree(
  rawMod: RawTerraformModule,
  counters: SanitizeCounters,
  providersOut: Set<CloudProviderId>,
  unknownProviders: Set<string>,
): RawTerraformModule {
  const resources: RawTerraformResource[] = [];
  for (const res of rawMod.resources ?? []) {
    if (!isPlainObject(res)) continue;
    if (typeof res.provider_name === 'string') {
      const norm = normalizeTerraformProviderName(res.provider_name);
      if (norm.cloudProvider) {
        providersOut.add(norm.cloudProvider);
      } else if (!norm.utility && norm.shortName) {
        unknownProviders.add(res.provider_name);
      }
    } else if (typeof res.type === 'string') {
      if (res.type.startsWith('aws_')) providersOut.add('aws');
      else if (res.type.startsWith('google_')) providersOut.add('gcp');
      else if (res.type.startsWith('azurerm_')) providersOut.add('azure');
      else if (res.type.startsWith('oci_')) providersOut.add('oci');
    }

    const cleanedValues = isPlainObject(res.values)
      ? (sanitizeValueNode(res.values, res.sensitive_values, counters) as Record<string, unknown>)
      : {};

    resources.push({
      ...(typeof res.address === 'string' ? { address: res.address } : {}),
      ...(res.mode === 'data' || res.mode === 'managed' ? { mode: res.mode } : {}),
      ...(typeof res.type === 'string' ? { type: res.type } : {}),
      ...(typeof res.name === 'string' ? { name: res.name } : {}),
      ...(typeof res.index === 'string' || typeof res.index === 'number'
        ? { index: res.index }
        : {}),
      ...(typeof res.provider_name === 'string' ? { provider_name: res.provider_name } : {}),
      values: cleanedValues,
    });
  }

  const childModules: RawTerraformModule[] = (rawMod.child_modules ?? [])
    .filter((child): child is RawTerraformModule => isPlainObject(child))
    .map((child) => sanitizeModuleTree(child, counters, providersOut, unknownProviders));

  return {
    ...(typeof rawMod.address === 'string' ? { address: rawMod.address } : {}),
    resources,
    child_modules: childModules,
  };
}

function sanitizeConfigurationModule(
  mod: RawTerraformConfigModule,
  counters: SanitizeCounters,
): RawTerraformConfigModule {
  const resources = (mod.resources ?? []).map((r) => {
    const cleanedExprs = isPlainObject(r.expressions)
      ? (sanitizeExpressions(r.expressions, counters) as Record<string, unknown>)
      : undefined;
    return {
      ...r,
      ...(cleanedExprs ? { expressions: cleanedExprs } : {}),
    };
  });

  const moduleCalls: Record<string, { module?: RawTerraformConfigModule }> | undefined =
    isPlainObject(mod.module_calls)
      ? Object.fromEntries(
          Object.entries(mod.module_calls).map(([key, call]) => [
            key,
            {
              ...(call?.module
                ? { module: sanitizeConfigurationModule(call.module, counters) }
                : {}),
            },
          ]),
        )
      : undefined;

  return {
    resources,
    ...(moduleCalls ? { module_calls: moduleCalls } : {}),
  };
}

function sanitizeExpressions(node: unknown, counters: SanitizeCounters, attrKey?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeExpressions(item, counters, attrKey));
  }
  if (!isPlainObject(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'constant_value' && attrKey && isSecretKeyName(attrKey)) {
      counters.strippedCount++;
      continue;
    }
    if (isSecretKeyName(k)) {
      counters.strippedCount++;
      continue;
    }
    out[k] = sanitizeExpressions(v, counters, k === 'constant_value' ? attrKey : k);
  }
  return out;
}

/**
 * Validates size, parses `terraform show -json` (plan or state), and strips every sensitive or secret field.
 */
export function parseAndSanitizeTerraformJson(
  rawInput: string | Record<string, unknown>,
  maxBytes = TERRAFORM_MAX_INPUT_BYTES,
): SanitizedTerraformDocument {
  let doc: unknown;
  if (typeof rawInput === 'string') {
    const byteLength = new TextEncoder().encode(rawInput).byteLength;
    if (byteLength > maxBytes) {
      throw new Error(
        `Terraform JSON exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB safety limit (${(byteLength / (1024 * 1024)).toFixed(2)} MB).`,
      );
    }
    if (!rawInput.trim()) {
      throw new Error('Terraform JSON input is empty.');
    }
    try {
      doc = JSON.parse(rawInput);
    } catch (err) {
      throw new Error(
        `Invalid JSON syntax: ${err instanceof Error ? err.message : 'failed to parse file'}.`,
      );
    }
  } else {
    const serializedBytes = new TextEncoder().encode(JSON.stringify(rawInput)).byteLength;
    if (serializedBytes > maxBytes) {
      throw new Error(
        `Terraform JSON exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`,
      );
    }
    doc = rawInput;
  }

  if (!isPlainObject(doc)) {
    throw new Error('Expected a JSON object produced by `terraform show -json`.');
  }

  const formatVersion = doc.format_version;
  if (typeof formatVersion !== 'string' || !formatVersion.trim()) {
    throw new Error(
      'Missing `format_version`. Export a Terraform plan or state via `terraform show -json`.',
    );
  }

  const plannedRoot =
    isPlainObject(doc.planned_values) && isPlainObject(doc.planned_values.root_module)
      ? (doc.planned_values.root_module as RawTerraformModule)
      : undefined;
  const stateRoot =
    isPlainObject(doc.values) && isPlainObject(doc.values.root_module)
      ? (doc.values.root_module as RawTerraformModule)
      : undefined;

  if (!plannedRoot && !stateRoot) {
    throw new Error(
      'Neither `planned_values.root_module` (plan JSON) nor `values.root_module` (state JSON) was found.',
    );
  }

  const sourceKind: 'plan' | 'state' = plannedRoot ? 'plan' : 'state';
  const rawRoot = (plannedRoot ?? stateRoot)!;

  const counters: SanitizeCounters = { strippedCount: 0 };
  const providersSet = new Set<CloudProviderId>();
  const unknownProviders = new Set<string>();

  const rootModule = sanitizeModuleTree(rawRoot, counters, providersSet, unknownProviders);
  const configurationRoot =
    isPlainObject(doc.configuration) && isPlainObject(doc.configuration.root_module)
      ? sanitizeConfigurationModule(
          doc.configuration.root_module as RawTerraformConfigModule,
          counters,
        )
      : undefined;

  const warnings: string[] = [];
  for (const prov of [...unknownProviders].sort()) {
    warnings.push(
      `Provider "${prov}" is not part of the native AWS/GCP/Azure/OCI subset; resources will be retained as unsupported nodes.`,
    );
  }

  return {
    sourceKind,
    formatVersion,
    ...(typeof doc.terraform_version === 'string'
      ? { terraformVersion: doc.terraform_version }
      : {}),
    rootModule,
    ...(configurationRoot ? { configurationRoot } : {}),
    providersDetected: [...providersSet].sort(),
    warnings,
    strippedSensitiveCount: counters.strippedCount,
  };
}
