import {
  SCHEMA_VERSION,
  type MockKind,
  type Provider,
  type ServiceDefinition,
} from '@infrasim/shared-types';
import {
  CATALOG_COUNTS,
  CATALOG_ID_TO_PROVIDER,
  CATALOG_SERVICES,
  KIND_DEFAULTS,
  type KindDefaultSpec,
} from './generated/catalogData.js';

export {
  CATALOG_COUNTS,
  CATALOG_ID_TO_PROVIDER,
  CATALOG_SERVICES,
  KIND_DEFAULTS,
  type KindDefaultSpec,
};

export {
  MAX_TEMPLATE_OUTPUT_BYTES,
  evaluateResponseTemplate,
  renderMockOperationPreview,
  validateResponseTemplate,
  type MockOperationPreview,
  type TemplateContext,
  type TemplateDiagnostic,
  type TemplateEvalResult,
  type TemplateValidationResult,
} from './templateEngine.js';

export {
  validateJsonSchemaDefinition,
  validateJsonSchemaValue,
  type SchemaValidationError,
  type SchemaValidationResult,
} from './schemaValidator.js';

const serviceById = new Map<string, ServiceDefinition>(
  CATALOG_SERVICES.map((service) => [service.id, service]),
);

const SEARCH_ALIASES: Record<string, string[]> = {
  db: ['sql', 'kv', 'doc', 'cache', 'rds', 'database', 'postgres', 'mysql'],
  database: ['sql', 'kv', 'doc', 'graph', 'ts', 'olap'],
  nosql: ['kv', 'doc', 'dynamodb', 'firestore', 'cosmos'],
  llm: ['llm', 'genai', 'bedrock', 'gemini', 'openai', 'ai'],
  ai: ['llm', 'ml', 'vision', 'speech', 'text-ai', 'doc-ai', 'bot'],
  queue: ['queue', 'sqs', 'tasks', 'service bus', 'messaging'],
  cache: ['cache', 'redis', 'memcached', 'cdn', 'memory'],
  serverless: ['fn', 'lambda', 'cloud run', 'functions'],
  vm: ['compute', 'ec2', 'compute engine', 'virtual machine'],
  container: ['compute', 'fn', 'fargate', 'ecs', 'eks', 'gke', 'aks', 'oke', 'cloud run'],
  storage: ['object', 'block', 'file', 's3', 'blob', 'gcs'],
};

/** Returns the shared schema version supported by the built catalog. */
export function getCatalogSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/** Returns all built-in catalog service definitions (243 cloud + 8 generic). */
export function getCatalog(customServices: readonly ServiceDefinition[] = []): ServiceDefinition[] {
  return [...CATALOG_SERVICES, ...customServices];
}

/** Returns catalog services filtered by provider. */
export function getProviderCatalog(
  provider: Provider,
  customServices: readonly ServiceDefinition[] = [],
): ServiceDefinition[] {
  if (provider === 'custom') {
    return [...customServices];
  }
  return CATALOG_SERVICES.filter((service) => service.provider === provider);
}

/** Looks up a service definition by ID across built-in and optional custom services. */
export function getService(
  id: string,
  customServices: readonly ServiceDefinition[] = [],
): ServiceDefinition | undefined {
  return serviceById.get(id) ?? customServices.find((service) => service.id === id);
}

/** Returns default operations, ports, failure modes, and metadata for a MockKind. */
export function getKindDefault(kind: MockKind): KindDefaultSpec {
  return KIND_DEFAULTS[kind];
}

/** Lists ordered distinct catalog categories for a provider filter. */
export function getCatalogCategories(
  provider: Provider | 'all' = 'all',
  customServices: readonly ServiceDefinition[] = [],
): string[] {
  const pool =
    provider === 'all' ? getCatalog(customServices) : getProviderCatalog(provider, customServices);
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const service of pool) {
    if (!seen.has(service.category)) {
      seen.add(service.category);
      categories.push(service.category);
    }
  }
  return categories;
}

export interface SearchServicesOptions {
  provider?: Provider | 'all';
  category?: string;
  customServices?: readonly ServiceDefinition[];
}

/** Searches services by query across name, ID, category, kind, description, tags, and aliases. */
export function searchServices(
  query: string,
  options: SearchServicesOptions = {},
): ServiceDefinition[] {
  const { provider = 'all', category, customServices = [] } = options;

  let pool: ServiceDefinition[];
  if (provider === 'all') {
    pool = getCatalog(customServices);
  } else {
    pool = getProviderCatalog(provider, customServices);
  }

  if (category && category !== 'all') {
    pool = pool.filter((service) => service.category === category);
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return pool;
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const scored: { service: ServiceDefinition; score: number }[] = [];

  for (const service of pool) {
    const idLower = service.id.toLowerCase();
    const nameLower = service.name.toLowerCase();
    const kindLower = service.kind.toLowerCase();
    const categoryLower = service.category.toLowerCase();
    const descLower = service.description.toLowerCase();
    const tagsLower = (service.tags ?? []).map((t) => t.toLowerCase());

    let totalScore = 0;
    let matchedAllTokens = true;

    for (const token of tokens) {
      let tokenScore = 0;
      if (nameLower === token || idLower === token) {
        tokenScore = 100;
      } else if (nameLower.startsWith(token) || idLower.startsWith(token)) {
        tokenScore = 70;
      } else if (nameLower.includes(token) || idLower.includes(token)) {
        tokenScore = 50;
      } else if (kindLower === token || tagsLower.includes(token)) {
        tokenScore = 40;
      } else if (tagsLower.some((tag) => tag.includes(token)) || categoryLower.includes(token)) {
        tokenScore = 25;
      } else if (descLower.includes(token)) {
        tokenScore = 15;
      } else {
        const aliasTerms = SEARCH_ALIASES[token];
        if (
          aliasTerms &&
          aliasTerms.some(
            (term) =>
              kindLower === term ||
              tagsLower.includes(term) ||
              nameLower.includes(term) ||
              categoryLower.includes(term),
          )
        ) {
          tokenScore = 20;
        }
      }

      if (tokenScore === 0) {
        matchedAllTokens = false;
        break;
      }
      totalScore += tokenScore;
    }

    if (matchedAllTokens) {
      scored.push({ service, score: totalScore });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name));
  return scored.map((item) => item.service);
}

/** Resolves the closest cross-cloud equivalent ServiceDefinition for a target provider. */
export function findEquivalent(
  serviceId: string,
  targetProvider: Provider,
  customServices: readonly ServiceDefinition[] = [],
): ServiceDefinition | undefined {
  const source = getService(serviceId, customServices);
  if (!source) {
    return undefined;
  }
  if (source.provider === targetProvider) {
    return source;
  }
  if (!source.equivalents || source.equivalents === 'none') {
    return undefined;
  }
  const targetId = source.equivalents[targetProvider];
  if (!targetId) {
    return undefined;
  }
  return getService(targetId, customServices);
}
