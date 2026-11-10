import type {
  CapacitySpec,
  CustomServiceDefinition,
  LatencyModel,
  MockKind,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { getCatalog, getKindDefault, validateResponseTemplate } from '@infrasim/catalog';

export const CUSTOM_SERVICE_ID_REGEX = /^custom\.[a-z0-9][a-z0-9._-]{1,60}$/;

export const CUSTOM_SERVICE_COLORS: readonly { label: string; hex: string }[] = [
  { label: 'Steel', hex: '#3b82f6' },
  { label: 'Violet', hex: '#8b5cf6' },
  { label: 'Emerald', hex: '#10b981' },
  { label: 'Amber', hex: '#d97706' },
  { label: 'Cyan', hex: '#0891b2' },
  { label: 'Rose', hex: '#e11d48' },
  { label: 'Slate', hex: '#64748b' },
  { label: 'Indigo', hex: '#6366f1' },
];

export const CUSTOM_ICON_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'generic', label: 'Service box' },
  { id: 'compute', label: 'Compute' },
  { id: 'gw', label: 'API / HTTP' },
  { id: 'fn', label: 'Function' },
  { id: 'kv', label: 'Key-value' },
  { id: 'sql', label: 'Database' },
  { id: 'cache', label: 'Cache' },
  { id: 'queue', label: 'Queue' },
  { id: 'llm', label: 'AI / LLM' },
  { id: 'auth', label: 'Auth' },
  { id: 'object', label: 'Storage' },
  { id: 'email', label: 'Messaging' },
];

export const CUSTOM_BASE_KINDS: readonly { kind: MockKind; label: string }[] = [
  { kind: 'compute', label: 'Generic HTTP / Compute' },
  { kind: 'gw', label: 'API Gateway / Webhook' },
  { kind: 'fn', label: 'Serverless Function' },
  { kind: 'kv', label: 'Key-Value Store' },
  { kind: 'sql', label: 'Relational Database' },
  { kind: 'doc', label: 'Document Store' },
  { kind: 'cache', label: 'In-Memory Cache' },
  { kind: 'queue', label: 'Message Queue' },
  { kind: 'topic', label: 'Pub/Sub Topic' },
  { kind: 'stream', label: 'Event Stream' },
  { kind: 'auth', label: 'Auth / Identity' },
  { kind: 'object', label: 'Object Storage' },
  { kind: 'llm', label: 'LLM / AI Endpoint' },
  { kind: 'email', label: 'Email / Notification SaaS' },
  { kind: 'lb', label: 'Load Balancer' },
  { kind: 'search', label: 'Search Engine' },
];

export interface CustomServiceDraft {
  id: string;
  name: string;
  category: string;
  kind: MockKind;
  description: string;
  scope: 'regional' | 'zonal' | 'global';
  icon: string;
  color: string;
  distribution: LatencyModel['distribution'];
  p50: string;
  p95: string;
  errorRatePct: string;
  capacityType: 'elastic' | 'rps' | 'conc' | 'slots' | 'conn' | 'tpm' | 'passthrough';
  capacityLimit: string;
  capacityBurst: string;
  capacityOnLimit: 'throttle' | 'queue';
  rpmLimit: string;
  tpmLimit: string;
  protocol: string;
  port: string;
  operationName: string;
  operationSummary: string;
  statusCode: string;
  bodyTemplate: string;
  sizeBytes: string;
  manualUnitPrice: string;
  manualUnit: string;
}

/** Generates a valid `custom.<slug>` identifier matching backend validation rules. */
export function slugifyCustomServiceId(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 56);

  const suffix =
    cleaned.length >= 2 && /^[a-z0-9]/.test(cleaned)
      ? cleaned
      : cleaned.length === 1 && /^[a-z0-9]/.test(cleaned)
        ? `${cleaned}_svc`
        : 'service_block';

  return `custom.${suffix}`;
}

/** Merges multiple CustomServiceDefinition lists cleanly without duplicates; earliest list wins. */
export function mergeCustomServices(
  ...lists: readonly (readonly CustomServiceDefinition[] | undefined)[]
): CustomServiceDefinition[] {
  const seen = new Set<string>();
  const merged: CustomServiceDefinition[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }
  return merged;
}

/** Creates an editable form draft from an existing custom or built-in catalog service, or blank defaults. */
export function createCustomServiceDraft(
  source?: ServiceDefinition | CustomServiceDefinition | null,
  mode: 'create' | 'edit' | 'duplicate' = 'create',
): CustomServiceDraft {
  if (!source) {
    const kindDef = getKindDefault('compute');
    const primaryOp = kindDef.operations[0];
    return {
      id: 'custom.stripe_api',
      name: 'Stripe API',
      category: 'Custom & SaaS',
      kind: 'compute',
      description: 'External REST dependency or bespoke application service.',
      scope: 'regional',
      icon: 'gw',
      color: '#3b82f6',
      distribution: 'lognormal',
      p50: '45',
      p95: '160',
      errorRatePct: '0.2',
      capacityType: 'rps',
      capacityLimit: '500',
      capacityBurst: '100',
      capacityOnLimit: 'throttle',
      rpmLimit: '500',
      tpmLimit: '100000',
      protocol: 'https',
      port: '443',
      operationName: primaryOp?.name ?? 'Request',
      operationSummary: primaryOp?.summary ?? 'Invoke service endpoint',
      statusCode: String(primaryOp?.defaultResponse.statusCode ?? 200),
      bodyTemplate:
        primaryOp?.defaultResponse.bodyTemplate ??
        '{"id":"{{faker.uuid}}","status":"ok","seq":{{seq}}}',
      sizeBytes: String(primaryOp?.defaultResponse.sizeBytes ?? 512),
      manualUnitPrice: '',
      manualUnit: 'month',
    };
  }

  const isCustomEdit = mode === 'edit' && source.provider === 'custom';
  const duplicateName =
    mode === 'duplicate' && source.provider !== 'custom' ? `Custom ${source.name}` : source.name;
  const baseId = isCustomEdit ? source.id : slugifyCustomServiceId(duplicateName);

  const primaryOp = source.operations[0];
  const primaryPort = source.ports?.[0];
  const cap = source.capacity;

  let capacityType: CustomServiceDraft['capacityType'] = 'elastic';
  let capacityLimit = '500';
  let capacityBurst = '100';
  let capacityOnLimit: 'throttle' | 'queue' = 'throttle';
  let rpmLimit = '500';
  let tpmLimit = '100000';

  if (cap.type === 'rps') {
    capacityType = 'rps';
    capacityLimit = String(cap.limit);
    capacityBurst = String(cap.burst ?? Math.round(cap.limit * 0.2));
  } else if (cap.type === 'conc') {
    capacityType = 'conc';
    capacityLimit = String(cap.limit);
    capacityOnLimit = cap.onLimit;
  } else if (cap.type === 'slots') {
    capacityType = 'slots';
  } else if (cap.type === 'conn') {
    capacityType = 'conn';
    capacityLimit = String(cap.default);
  } else if (cap.type === 'tpm') {
    capacityType = 'tpm';
    rpmLimit = String(cap.rpm ?? 500);
    tpmLimit = String(cap.tpm ?? 100000);
  } else if (cap.type === 'passthrough') {
    capacityType = 'passthrough';
  }

  const customSource = source as Partial<CustomServiceDefinition>;

  return {
    id: baseId,
    name: duplicateName,
    category: source.provider === 'custom' ? source.category : 'Custom & SaaS',
    kind: source.kind,
    description: source.description || 'Custom infrastructure service.',
    scope: source.scope,
    icon: source.provider === 'custom' ? source.icon : (source.kind as string),
    color: customSource.color ?? '#3b82f6',
    distribution: source.latency.distribution,
    p50: String(source.latency.p50),
    p95: String(source.latency.p95),
    errorRatePct: String(Number((source.failure.errorRate * 100).toFixed(4))),
    capacityType,
    capacityLimit,
    capacityBurst,
    capacityOnLimit,
    rpmLimit,
    tpmLimit,
    protocol: primaryPort?.protocol ?? 'https',
    port: String(primaryPort?.port ?? 443),
    operationName: primaryOp?.name ?? 'Request',
    operationSummary: primaryOp?.summary ?? 'Primary custom operation',
    statusCode: String(primaryOp?.defaultResponse.statusCode ?? 200),
    bodyTemplate: primaryOp?.defaultResponse.bodyTemplate ?? '{"ok":true}',
    sizeBytes: String(primaryOp?.defaultResponse.sizeBytes ?? 512),
    manualUnitPrice:
      customSource.manualUnitPrice !== undefined ? String(customSource.manualUnitPrice) : '',
    manualUnit: customSource.manualUnit ?? 'month',
  };
}

export interface CustomServiceValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

/** Validates a CustomServiceDraft strictly against catalog, template, and API constraints. */
export function validateCustomServiceDraft(
  draft: CustomServiceDraft,
  existingCustomIds: readonly string[],
  editingServiceId?: string | null,
): CustomServiceValidationResult {
  const errors: Record<string, string> = {};

  if (!draft.name.trim()) {
    errors.name = 'Service name is required.';
  } else if (draft.name.trim().length > 100) {
    errors.name = 'Service name must be 100 characters or fewer.';
  }

  const trimmedId = draft.id.trim();
  if (!CUSTOM_SERVICE_ID_REGEX.test(trimmedId)) {
    errors.id =
      'ID must start with "custom." followed by lowercase letters, numbers, ".", "_" or "-".';
  } else {
    const builtInCollision = getCatalog().some((s) => s.id === trimmedId);
    const customCollision = existingCustomIds.some(
      (id) => id === trimmedId && id !== editingServiceId,
    );
    if (builtInCollision || customCollision) {
      errors.id = `A service with ID "${trimmedId}" already exists.`;
    }
  }

  if (!draft.description.trim()) {
    errors.description = 'Description is required.';
  }

  const p50 = Number(draft.p50);
  const p95 = Number(draft.p95);
  if (!Number.isFinite(p50) || p50 <= 0) {
    errors.p50 = 'p50 latency must be greater than 0 ms.';
  }
  if (!Number.isFinite(p95) || p95 <= 0) {
    errors.p95 = 'p95 latency must be greater than 0 ms.';
  } else if (Number.isFinite(p50) && p95 < p50) {
    errors.p95 = 'p95 latency must be greater than or equal to p50.';
  }

  const errPct = Number(draft.errorRatePct);
  if (!Number.isFinite(errPct) || errPct < 0 || errPct > 100) {
    errors.errorRatePct = 'Error rate must be between 0% and 100%.';
  }

  if (
    draft.capacityType === 'rps' ||
    draft.capacityType === 'conc' ||
    draft.capacityType === 'conn'
  ) {
    const limit = Number(draft.capacityLimit);
    if (!Number.isFinite(limit) || limit <= 0) {
      errors.capacityLimit = 'Capacity limit must be a positive number.';
    }
  }
  if (draft.capacityType === 'tpm') {
    const rpm = Number(draft.rpmLimit);
    const tpm = Number(draft.tpmLimit);
    if (!Number.isFinite(rpm) || rpm <= 0 || !Number.isFinite(tpm) || tpm <= 0) {
      errors.capacityLimit = 'RPM and TPM limits must be positive numbers.';
    }
  }

  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = 'Port must be an integer between 1 and 65535.';
  }

  if (!draft.operationName.trim()) {
    errors.operationName = 'Operation name is required.';
  }

  const statusCode = Number(draft.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    errors.statusCode = 'HTTP status code must be between 100 and 599.';
  }

  if (!draft.bodyTemplate.trim()) {
    errors.bodyTemplate = 'Response template cannot be empty.';
  } else {
    const tplCheck = validateResponseTemplate(draft.bodyTemplate);
    if (!tplCheck.valid && tplCheck.error) {
      const err = tplCheck.error;
      errors.bodyTemplate = `Line ${err.line}, col ${err.column}: ${err.message}`;
    }
  }

  if (draft.manualUnitPrice.trim() !== '') {
    const price = Number(draft.manualUnitPrice);
    if (!Number.isFinite(price) || price < 0) {
      errors.manualUnitPrice = 'Manual unit price must be zero or positive.';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/** Converts a validated CustomServiceDraft into a full CustomServiceDefinition ready for store/API/sim. */
export function buildCustomServiceDefinition(
  draft: CustomServiceDraft,
  sourceTemplate?: ServiceDefinition | CustomServiceDefinition | null,
): CustomServiceDefinition {
  const kindDefaults = getKindDefault(draft.kind);
  const p50 = Number(draft.p50);
  const p95 = Number(draft.p95);
  const errorRate = Number(draft.errorRatePct) / 100;
  const limitNum = Math.max(1, Math.round(Number(draft.capacityLimit) || 100));
  const burstNum = Math.max(0, Math.round(Number(draft.capacityBurst) || 0));

  let capacity: CapacitySpec;
  switch (draft.capacityType) {
    case 'rps':
      capacity = { type: 'rps', limit: limitNum, ...(burstNum > 0 ? { burst: burstNum } : {}) };
      break;
    case 'conc':
      capacity = { type: 'conc', limit: limitNum, onLimit: draft.capacityOnLimit };
      break;
    case 'slots':
      capacity = { type: 'slots', fromInstanceType: true };
      break;
    case 'conn':
      capacity = { type: 'conn', default: limitNum };
      break;
    case 'tpm':
      capacity = {
        type: 'tpm',
        rpm: Math.max(1, Math.round(Number(draft.rpmLimit) || 500)),
        tpm: Math.max(1, Math.round(Number(draft.tpmLimit) || 100000)),
      };
      break;
    case 'passthrough':
      capacity = { type: 'passthrough' };
      break;
    case 'elastic':
    default:
      capacity = { type: 'elastic' };
      break;
  }

  const manualPriceNum =
    draft.manualUnitPrice.trim() !== '' ? Number(draft.manualUnitPrice) : undefined;
  const manualUnitClean = draft.manualUnit.trim() || undefined;
  const sizeNum = Number(draft.sizeBytes);

  const primaryOp = {
    name: draft.operationName.trim(),
    summary: draft.operationSummary.trim() || 'Primary service operation',
    defaultResponse: {
      statusCode: Math.round(Number(draft.statusCode) || 200),
      headers: { 'content-type': 'application/json' },
      bodyTemplate: draft.bodyTemplate,
      ...(Number.isFinite(sizeNum) && sizeNum > 0 ? { sizeBytes: Math.round(sizeNum) } : {}),
    },
    errors: kindDefaults.failure.kinds,
  };

  // Preserve secondary operations when editing/duplicating so rich workflows remain intact
  const extraOps = (sourceTemplate?.operations ?? [])
    .slice(1)
    .filter((op) => op.name !== primaryOp.name);

  return {
    id: draft.id.trim(),
    provider: 'custom',
    name: draft.name.trim(),
    category: draft.category.trim() || 'Custom & SaaS',
    kind: draft.kind,
    description: draft.description.trim() || 'Custom service block.',
    scope: draft.scope,
    latency: {
      distribution: draft.distribution,
      p50,
      p95,
    },
    capacity,
    failure: {
      errorRate,
      kinds: kindDefaults.failure.kinds,
    },
    operations: [primaryOp, ...extraOps],
    pricing: {
      model: manualPriceNum !== undefined ? 'unit' : 'free',
    },
    ports: [
      {
        protocol: draft.protocol.trim() || 'https',
        port: Math.round(Number(draft.port) || 443),
      },
    ],
    tags: ['custom', draft.kind],
    icon: draft.icon || 'generic',
    color: draft.color || '#3b82f6',
    ...(manualPriceNum !== undefined ? { manualUnitPrice: manualPriceNum } : {}),
    ...(manualPriceNum !== undefined && manualUnitClean ? { manualUnit: manualUnitClean } : {}),
  };
}
