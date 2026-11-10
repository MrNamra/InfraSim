import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv, type ErrorObject } from 'ajv';
import type {
  CapacitySpec,
  ErrorKindDef,
  MockKind,
  OperationDef,
  PriceModel,
  Provider,
  QuotaSpec,
  ServiceDefinition,
} from '@infrasim/shared-types';

const VALID_MOCK_KINDS: ReadonlySet<MockKind> = new Set([
  'compute',
  'fn',
  'lb',
  'gw',
  'cdn',
  'dns',
  'net',
  'object',
  'block',
  'file',
  'sql',
  'kv',
  'doc',
  'cache',
  'graph',
  'ts',
  'olap',
  'search',
  'queue',
  'topic',
  'stream',
  'bus',
  'workflow',
  'auth',
  'secret',
  'kms',
  'email',
  'async',
  'llm',
  'ml',
  'vision',
  'speech',
  'text-ai',
  'doc-ai',
  'bot',
]);

const VALID_PRICE_MODELS: ReadonlySet<PriceModel> = new Set([
  'hr',
  'vcpu-gb-hr',
  'req',
  'fn',
  'gb-mo',
  'gb-xfer',
  'tok',
  'unit',
  'ru',
  'rcu-wcu',
  'shard-hr',
  'lcu',
  'msg',
  'query-tb',
  'acu-hr',
  'mau',
  'mix',
  'flat',
  'free',
]);

const SERVICES_HEADER = ['id', 'name', 'p50', 'p95', 'cap', 'mock', 'price'] as const;
const EXTRAS_HEADER = [
  'id',
  'cold p50',
  'cold p95',
  'default concurrency',
  'max timeout',
  'scale-out lag (s)',
  'notes',
] as const;

export const CANONICAL_PROVIDER_COUNTS: Record<'aws' | 'gcp' | 'azure' | 'oci', number> = {
  aws: 77,
  gcp: 53,
  azure: 63,
  oci: 50,
};

export interface KindDefault {
  kind: MockKind;
  description: string;
  icon?: string;
  scope: 'regional' | 'zonal' | 'global';
  ports: { protocol: string; port: number }[];
  tags: string[];
  failure: { errorRate: number; kinds: ErrorKindDef[] };
  operations: OperationDef[];
}

export interface ServiceOverride {
  description?: string;
  scope?: 'regional' | 'zonal' | 'global';
  capacity?: CapacitySpec;
  maxTimeoutS?: number;
  limits?: QuotaSpec[];
  ports?: { protocol: string; port: number }[];
  tags?: string[];
  icon?: string;
  notes?: string;
  docsUrl?: string;
}

export interface ParsedServiceRow {
  id: string;
  provider: Provider;
  name: string;
  category: string;
  p50: number;
  p95: number;
  capacity: CapacitySpec;
  kind: MockKind;
  priceModel: PriceModel;
}

export interface ParsedExtrasRow {
  id: string;
  coldStart?: { p50: number; p95: number; idleTtlS: number };
  scaleOutLagS?: number;
  maxTimeoutS?: number;
  notes?: string;
}

export interface ParsedProviderMarkdown {
  services: ParsedServiceRow[];
  extras: Map<string, ParsedExtrasRow>;
}

function splitMarkdownCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return null;
  }
  const withoutOuterPipes = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutOuterPipes.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function headersMatch(cells: string[], expected: readonly string[]): boolean {
  if (cells.length !== expected.length) {
    return false;
  }
  return cells.every((cell, idx) => cell.toLowerCase() === expected[idx]);
}

function normalizeCategoryHeading(heading: string): string {
  return heading.replace(/\s*\([^)]*mocked[^)]*\)\s*$/i, '').trim();
}

/** Parse a `Cap` cell from catalog Markdown tables into a typed `CapacitySpec`. */
export function parseCapacitySpec(raw: string, serviceId: string): CapacitySpec {
  const value = raw.trim();
  if (value === 'elastic') {
    return { type: 'elastic' };
  }
  if (value === 'slots') {
    return { type: 'slots', fromInstanceType: true };
  }
  if (value === 'units') {
    return { type: 'units', read: 1000, write: 1000 };
  }
  if (value === 'conn') {
    return { type: 'conn', default: 100 };
  }
  if (value === 'tpm') {
    return { type: 'tpm', rpm: 1000, tpm: 250000 };
  }
  if (value === 'pass') {
    return { type: 'passthrough' };
  }
  const concMatch = /^conc=(\d+)(\/queue)?$/.exec(value);
  if (concMatch) {
    const limit = Number(concMatch[1]);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Invalid conc capacity limit "${value}" for ${serviceId}`);
    }
    return { type: 'conc', limit, onLimit: concMatch[2] ? 'queue' : 'throttle' };
  }
  const rpsMatch = /^rps=(\d+)$/.exec(value);
  if (rpsMatch) {
    const limit = Number(rpsMatch[1]);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Invalid rps capacity limit "${value}" for ${serviceId}`);
    }
    return { type: 'rps', limit };
  }
  throw new Error(`Unknown Cap grammar "${value}" for ${serviceId}`);
}

function parseTimeoutSeconds(raw: string): number | undefined {
  const value = raw.trim();
  if (!value || value === '—' || value === '-') {
    return undefined;
  }
  const match = /(\d+(?:\.\d+)?)\s*(min|s|ms)\b/i.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  if (unit === 'min') {
    return Math.round(amount * 60);
  }
  if (unit === 'ms') {
    return amount / 1000;
  }
  return amount;
}

function parseScaleOutLagSeconds(raw: string): number | undefined {
  const value = raw.trim();
  if (!value || value === '—' || value === '-') {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)/.exec(value);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Parse a provider catalog Markdown document, discriminating tables strictly
 * by their header row per docs/specs/06-SERVICE-CATALOG-SPEC.md §2.
 */
export function parseProviderMarkdown(
  markdown: string,
  provider: Provider,
): ParsedProviderMarkdown {
  const services: ParsedServiceRow[] = [];
  const extras = new Map<string, ParsedExtrasRow>();

  const lines = markdown.split(/\r?\n/);
  let currentCategory = '';
  let inCodeBlock = false;
  let tableMode: 'none' | 'services' | 'extras' | 'ignore' = 'none';
  let expectingSeparator = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      tableMode = 'none';
      expectingSeparator = false;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }

    const categoryMatch = /^###\s+(.+)$/.exec(trimmed);
    if (categoryMatch) {
      currentCategory = normalizeCategoryHeading(categoryMatch[1] ?? '');
      tableMode = 'none';
      expectingSeparator = false;
      continue;
    }

    const cells = splitMarkdownCells(line);
    if (!cells) {
      tableMode = 'none';
      expectingSeparator = false;
      continue;
    }

    if (tableMode === 'none') {
      if (headersMatch(cells, SERVICES_HEADER)) {
        tableMode = 'services';
        expectingSeparator = true;
      } else if (headersMatch(cells, EXTRAS_HEADER)) {
        tableMode = 'extras';
        expectingSeparator = true;
      } else {
        tableMode = 'ignore';
        expectingSeparator = true;
      }
      continue;
    }

    if (expectingSeparator) {
      expectingSeparator = false;
      if (isSeparatorRow(cells)) {
        continue;
      }
    }

    if (tableMode === 'ignore') {
      continue;
    }

    if (tableMode === 'services') {
      if (cells.length !== SERVICES_HEADER.length) {
        throw new Error(
          `${provider} line ${i + 1}: expected ${SERVICES_HEADER.length} columns in services table, got ${cells.length}`,
        );
      }
      if (!currentCategory) {
        throw new Error(`${provider} line ${i + 1}: service row outside ### Category section`);
      }
      const [id, name, p50Str, p95Str, capStr, mockStr, priceStr] = cells as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (!id || !name) {
        throw new Error(`${provider} line ${i + 1}: empty ID or Name`);
      }
      if (!id.startsWith(`${provider}.`)) {
        throw new Error(
          `${provider} line ${i + 1}: service ID "${id}" must start with "${provider}."`,
        );
      }

      const p50 = Number(p50Str);
      const p95 = Number(p95Str);
      if (!Number.isFinite(p50) || !Number.isFinite(p95) || p50 < 0 || p95 < 0) {
        throw new Error(
          `${provider} line ${i + 1}: invalid p50/p95 "${p50Str}/${p95Str}" for ${id}`,
        );
      }
      if (p95 < p50) {
        throw new Error(`${provider} line ${i + 1}: p95 (${p95}) < p50 (${p50}) for ${id}`);
      }

      if (!VALID_MOCK_KINDS.has(mockStr as MockKind)) {
        throw new Error(`${provider} line ${i + 1}: unknown Mock kind "${mockStr}" for ${id}`);
      }
      if (!VALID_PRICE_MODELS.has(priceStr as PriceModel)) {
        throw new Error(`${provider} line ${i + 1}: unknown Price model "${priceStr}" for ${id}`);
      }

      const capacity = parseCapacitySpec(capStr, id);
      services.push({
        id,
        provider,
        name,
        category: currentCategory,
        p50,
        p95,
        capacity,
        kind: mockStr as MockKind,
        priceModel: priceStr as PriceModel,
      });
    } else if (tableMode === 'extras') {
      if (cells.length !== EXTRAS_HEADER.length) {
        throw new Error(
          `${provider} line ${i + 1}: expected ${EXTRAS_HEADER.length} columns in extras table, got ${cells.length}`,
        );
      }
      const [id, coldP50Str, coldP95Str, _concurrencyStr, maxTimeoutStr, lagStr, notesStr] =
        cells as [string, string, string, string, string, string, string];
      if (extras.has(id)) {
        throw new Error(`${provider} line ${i + 1}: duplicate extras row for "${id}"`);
      }

      let coldStart: ParsedExtrasRow['coldStart'];
      const hasColdP50 = coldP50Str !== '' && coldP50Str !== '—' && coldP50Str !== '-';
      const hasColdP95 = coldP95Str !== '' && coldP95Str !== '—' && coldP95Str !== '-';
      if (hasColdP50 !== hasColdP95) {
        throw new Error(`${provider} line ${i + 1}: incomplete coldStart bounds for "${id}"`);
      }
      if (hasColdP50 && hasColdP95) {
        const coldP50 = Number(coldP50Str);
        const coldP95 = Number(coldP95Str);
        if (
          !Number.isFinite(coldP50) ||
          !Number.isFinite(coldP95) ||
          coldP50 < 0 ||
          coldP95 < coldP50
        ) {
          throw new Error(`${provider} line ${i + 1}: invalid coldStart for "${id}"`);
        }
        coldStart = { p50: coldP50, p95: coldP95, idleTtlS: 600 };
      }

      const scaleOutLagS = parseScaleOutLagSeconds(lagStr);
      const maxTimeoutS = parseTimeoutSeconds(maxTimeoutStr);
      const notes = notesStr && notesStr !== '—' && notesStr !== '-' ? notesStr : undefined;

      extras.set(id, {
        id,
        ...(coldStart ? { coldStart } : {}),
        ...(scaleOutLagS !== undefined ? { scaleOutLagS } : {}),
        ...(maxTimeoutS !== undefined ? { maxTimeoutS } : {}),
        ...(notes ? { notes } : {}),
      });
    }
  }

  return { services, extras };
}

export interface BuildCatalogOptions {
  rootDir: string;
  specFiles?: Record<'aws' | 'gcp' | 'azure' | 'oci', string>;
  expectedCounts?: Partial<Record<'aws' | 'gcp' | 'azure' | 'oci', number>>;
  includeGeneric?: boolean;
  warn?: (message: string) => void;
}

export interface BuildCatalogResult {
  byProvider: Record<'aws' | 'gcp' | 'azure' | 'oci' | 'generic', ServiceDefinition[]>;
  kindDefaults: Record<MockKind, KindDefault>;
  counts: {
    aws: number;
    gcp: number;
    azure: number;
    oci: number;
    generic: number;
    providerTotal: number;
    total: number;
  };
  index: {
    counts: BuildCatalogResult['counts'];
    idToProvider: Record<string, Provider>;
  };
}

function loadKindDefaults(defaultsDir: string): Record<MockKind, KindDefault> {
  const result = {} as Record<MockKind, KindDefault>;
  for (const kind of VALID_MOCK_KINDS) {
    const filePath = path.join(defaultsDir, `${kind}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing kind default file: ${filePath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as KindDefault;
    if (parsed.kind !== kind) {
      throw new Error(`Kind mismatch in ${filePath}: expected "${kind}", got "${parsed.kind}"`);
    }
    if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
      throw new Error(`Kind "${kind}" default must define at least one operation`);
    }
    result[kind] = parsed;
  }
  return result;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined, label: string): string {
  if (!errors || errors.length === 0) {
    return `${label}: unknown schema error`;
  }
  return errors
    .slice(0, 10)
    .map((err) => `${label}${err.instancePath || '/'}: ${err.message ?? 'invalid'}`)
    .join('\n');
}

function loadJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function getRequiredKindDefault(
  defaults: Record<MockKind, KindDefault>,
  kind: MockKind,
): KindDefault {
  const entry = defaults[kind];
  if (!entry) {
    throw new Error(`Missing loaded kind default for "${kind}"`);
  }
  return entry;
}

/**
 * Parse catalog markdown specs (files 07–10), merge kind defaults, overrides,
 * equivalents, and generic entries, then validate every service with JSON Schema.
 */
export function buildCatalog(options: BuildCatalogOptions): BuildCatalogResult {
  const {
    rootDir,
    specFiles = {
      aws: path.join(rootDir, 'docs', 'specs', '07-CATALOG-AWS.md'),
      gcp: path.join(rootDir, 'docs', 'specs', '08-CATALOG-GCP.md'),
      azure: path.join(rootDir, 'docs', 'specs', '09-CATALOG-AZURE.md'),
      oci: path.join(rootDir, 'docs', 'specs', '10-CATALOG-OCI.md'),
    },
    expectedCounts = CANONICAL_PROVIDER_COUNTS,
    includeGeneric = true,
    warn = (msg: string) => console.warn(msg),
  } = options;

  const defaultsDir = path.join(rootDir, 'packages', 'catalog', 'defaults');
  const schemaPath = path.join(rootDir, 'packages', 'catalog', 'schemas', 'catalog.schema.json');

  const kindDefaults = loadKindDefaults(defaultsDir);
  const equivalentsMap = loadJsonFile<Record<string, Partial<Record<Provider, string>> | 'none'>>(
    path.join(defaultsDir, 'equivalents.json'),
  );
  const overridesMap = loadJsonFile<Record<string, ServiceOverride>>(
    path.join(defaultsDir, 'overrides.json'),
  );
  const genericEntriesRaw = includeGeneric
    ? loadJsonFile<
        (Partial<ServiceDefinition> & {
          id: string;
          kind: MockKind;
          name: string;
          category: string;
        })[]
      >(path.join(defaultsDir, 'generic.json'))
    : [];

  const seenIds = new Set<string>();
  const byProvider: BuildCatalogResult['byProvider'] = {
    aws: [],
    gcp: [],
    azure: [],
    oci: [],
    generic: [],
  };

  const providers: ('aws' | 'gcp' | 'azure' | 'oci')[] = ['aws', 'gcp', 'azure', 'oci'];

  for (const provider of providers) {
    const markdownPath = specFiles[provider];
    const markdown = fs.readFileSync(markdownPath, 'utf8');
    const parsed = parseProviderMarkdown(markdown, provider);

    const expectedCount = expectedCounts[provider];
    if (expectedCount !== undefined && parsed.services.length !== expectedCount) {
      throw new Error(
        `Catalog count mismatch for ${provider}: expected ${expectedCount} rows, parsed ${parsed.services.length}`,
      );
    }

    const rowIdSet = new Set(parsed.services.map((s) => s.id));
    for (const extraId of parsed.extras.keys()) {
      if (!rowIdSet.has(extraId)) {
        throw new Error(`Extras row "${extraId}" does not match any service in ${provider}`);
      }
    }

    for (const row of parsed.services) {
      if (seenIds.has(row.id)) {
        throw new Error(`Duplicate catalog service ID "${row.id}"`);
      }
      seenIds.add(row.id);

      const eq = equivalentsMap[row.id];
      if (!eq) {
        throw new Error(
          `Missing equivalents mapping for "${row.id}" (must map or be explicitly "none")`,
        );
      }

      const kindDef = getRequiredKindDefault(kindDefaults, row.kind);
      const extra = parsed.extras.get(row.id);
      const override = overridesMap[row.id] ?? {};

      let icon = override.icon ?? kindDef.icon ?? '';
      if (!icon) {
        warn(`[catalog] missing icon mapping for ${row.id}; using generic fallback`);
        icon = 'generic';
      }

      const service: ServiceDefinition = {
        id: row.id,
        provider: row.provider,
        name: row.name,
        category: row.category,
        kind: row.kind,
        description: override.description ?? `${row.name} — ${kindDef.description}`,
        scope: override.scope ?? kindDef.scope,
        latency: {
          distribution: row.p50 === 0 && row.p95 === 0 ? 'fixed' : 'lognormal',
          p50: row.p50,
          p95: row.p95,
        },
        capacity: override.capacity ?? row.capacity,
        ...(extra?.coldStart ? { coldStart: extra.coldStart } : {}),
        ...(extra?.scaleOutLagS !== undefined ? { scaleOutLagS: extra.scaleOutLagS } : {}),
        ...(override.maxTimeoutS !== undefined
          ? { maxTimeoutS: override.maxTimeoutS }
          : extra?.maxTimeoutS !== undefined
            ? { maxTimeoutS: extra.maxTimeoutS }
            : {}),
        failure: structuredClone(kindDef.failure),
        ...(override.limits ? { limits: override.limits } : {}),
        operations: structuredClone(kindDef.operations),
        pricing: { model: row.priceModel },
        equivalents: eq,
        ports: structuredClone(override.ports ?? kindDef.ports),
        tags: [...new Set([...kindDef.tags, ...(override.tags ?? [])])],
        icon,
        ...(override.docsUrl ? { docsUrl: override.docsUrl } : {}),
        ...(override.notes
          ? { notes: override.notes }
          : extra?.notes
            ? { notes: extra.notes }
            : {}),
      };

      byProvider[provider].push(service);
    }
  }

  for (const rawGeneric of genericEntriesRaw) {
    if (seenIds.has(rawGeneric.id)) {
      throw new Error(`Duplicate catalog service ID "${rawGeneric.id}"`);
    }
    seenIds.add(rawGeneric.id);
    const kindDef = getRequiredKindDefault(kindDefaults, rawGeneric.kind);
    let icon = rawGeneric.icon ?? kindDef.icon ?? '';
    if (!icon) {
      warn(`[catalog] missing icon mapping for ${rawGeneric.id}; using generic fallback`);
      icon = 'generic';
    }
    const genericService: ServiceDefinition = {
      id: rawGeneric.id,
      provider: 'generic',
      name: rawGeneric.name,
      category: rawGeneric.category,
      kind: rawGeneric.kind,
      description: rawGeneric.description ?? kindDef.description,
      scope: rawGeneric.scope ?? kindDef.scope,
      latency: rawGeneric.latency ?? { distribution: 'lognormal', p50: 10, p95: 40 },
      capacity: rawGeneric.capacity ?? { type: 'elastic' },
      failure: structuredClone(rawGeneric.failure ?? kindDef.failure),
      operations: structuredClone(rawGeneric.operations ?? kindDef.operations),
      pricing: rawGeneric.pricing ?? { model: 'free' },
      equivalents: rawGeneric.equivalents ?? 'none',
      ports: structuredClone(rawGeneric.ports ?? kindDef.ports),
      tags: rawGeneric.tags ?? [...kindDef.tags],
      icon,
    };
    byProvider.generic.push(genericService);
  }

  // Referential integrity check on equivalents
  for (const providerKey of ['aws', 'gcp', 'azure', 'oci', 'generic'] as const) {
    for (const service of byProvider[providerKey]) {
      if (service.equivalents && service.equivalents !== 'none') {
        for (const [targetProvider, targetId] of Object.entries(service.equivalents)) {
          if (!targetId || !seenIds.has(targetId)) {
            throw new Error(
              `Service "${service.id}" equivalents.${targetProvider} references unknown service "${targetId}"`,
            );
          }
        }
      }
    }
  }

  // Validate against JSON Schema
  const schema = loadJsonFile<Record<string, unknown>>(schemaPath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile<ServiceDefinition[]>(schema);

  for (const providerKey of ['aws', 'gcp', 'azure', 'oci', 'generic'] as const) {
    const valid = validate(byProvider[providerKey]);
    if (!valid) {
      throw new Error(formatAjvErrors(validate.errors, `${providerKey}.json`));
    }
  }

  const providerTotal =
    byProvider.aws.length + byProvider.gcp.length + byProvider.azure.length + byProvider.oci.length;
  const counts = {
    aws: byProvider.aws.length,
    gcp: byProvider.gcp.length,
    azure: byProvider.azure.length,
    oci: byProvider.oci.length,
    generic: byProvider.generic.length,
    providerTotal,
    total: providerTotal + byProvider.generic.length,
  };

  const idToProvider: Record<string, Provider> = {};
  for (const key of ['aws', 'gcp', 'azure', 'oci', 'generic'] as const) {
    for (const service of byProvider[key]) {
      idToProvider[service.id] = service.provider;
    }
  }

  return {
    byProvider,
    kindDefaults,
    counts,
    index: {
      counts,
      idToProvider,
    },
  };
}

function renderCatalogArtifacts(result: BuildCatalogResult): Record<string, string> {
  const files: Record<string, string> = {};
  for (const key of ['aws', 'gcp', 'azure', 'oci', 'generic'] as const) {
    files[path.join('packages', 'catalog', 'data', `${key}.json`)] =
      `${JSON.stringify(result.byProvider[key], null, 2)}\n`;
  }
  files[path.join('packages', 'catalog', 'data', 'index.json')] =
    `${JSON.stringify(result.index, null, 2)}\n`;

  const allServices: ServiceDefinition[] = [
    ...result.byProvider.aws,
    ...result.byProvider.gcp,
    ...result.byProvider.azure,
    ...result.byProvider.oci,
    ...result.byProvider.generic,
  ];

  const tsContent = [
    '// Auto-generated by scripts/build-catalog.ts. Do not edit manually.',
    "import type { MockKind, Provider, ServiceDefinition } from '@infrasim/shared-types';",
    '',
    'export interface KindDefaultSpec {',
    '  kind: MockKind;',
    '  description: string;',
    '  icon?: string;',
    "  scope: 'regional' | 'zonal' | 'global';",
    '  ports: { protocol: string; port: number }[];',
    '  tags: string[];',
    '  failure: ServiceDefinition["failure"];',
    '  operations: ServiceDefinition["operations"];',
    '}',
    '',
    `export const CATALOG_COUNTS = ${JSON.stringify(result.counts, null, 2)} as const;`,
    '',
    `export const CATALOG_ID_TO_PROVIDER: Record<string, Provider> = ${JSON.stringify(
      result.index.idToProvider,
      null,
      2,
    )};`,
    '',
    `export const KIND_DEFAULTS: Record<MockKind, KindDefaultSpec> = ${JSON.stringify(
      result.kindDefaults,
      null,
      2,
    )};`,
    '',
    `export const CATALOG_SERVICES: readonly ServiceDefinition[] = ${JSON.stringify(
      allServices,
      null,
      2,
    )};`,
    '',
  ].join('\n');

  files[path.join('packages', 'catalog', 'src', 'generated', 'catalogData.ts')] = tsContent;
  return files;
}

function runCli(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const isCheck = process.argv.includes('--check');

  const result = buildCatalog({ rootDir });
  const files = renderCatalogArtifacts(result);

  if (isCheck) {
    const stale: string[] = [];
    for (const [relPath, expected] of Object.entries(files)) {
      const absPath = path.join(rootDir, relPath);
      const actual = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
      if (actual !== expected) {
        stale.push(relPath);
      }
    }
    if (stale.length > 0) {
      console.error(
        `Catalog build artifacts are out of date:\n${stale.map((f) => `- ${f}`).join('\n')}\nRun \`pnpm catalog:build\` and commit updates.`,
      );
      process.exit(1);
    }
    console.log(
      `Catalog verified: ${result.counts.providerTotal} provider services (aws=${result.counts.aws}, gcp=${result.counts.gcp}, azure=${result.counts.azure}, oci=${result.counts.oci}) + ${result.counts.generic} generic services.`,
    );
    return;
  }

  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
  console.log(
    `Built catalog: ${result.counts.providerTotal} provider services (aws=${result.counts.aws}, gcp=${result.counts.gcp}, azure=${result.counts.azure}, oci=${result.counts.oci}) + ${result.counts.generic} generic services.`,
  );
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  runCli();
}
