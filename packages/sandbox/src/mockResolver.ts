import { getService, renderMockOperationPreview, validateJsonSchemaValue } from '@infrasim/catalog';
import type {
  Design,
  LatencyModel,
  NodeInstance,
  OperationDef,
  OperationOverride,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { createSeededPrng, hashSeedParts, type SeededPrng } from './prng.js';
import type { MockCallInvocation, MockCallOutcome, MockCallResolver } from './types.js';

export type AiMockHook = (ctx: {
  invocation: MockCallInvocation;
  service: ServiceDefinition;
  node?: NodeInstance;
  opName: string;
  operation: OperationDef;
  override?: OperationOverride;
  nowMs: number;
  seq: number;
  seed: number;
  env: Record<string, string>;
  rng: SeededPrng;
}) => MockCallOutcome | null;

let activeAiMockHook: AiMockHook | null = null;

/** Registers the AI service mock evaluator hook (populated in T3.11). */
export function registerAiMockHook(hook: AiMockHook | null): void {
  activeAiMockHook = hook;
}

const SERVICE_ID_ALIASES: Record<string, string> = {
  '@aws-sdk/client-s3': 'aws.s3',
  '@aws-sdk/client-dynamodb': 'aws.dynamodb',
  '@aws-sdk/lib-dynamodb': 'aws.dynamodb',
  '@aws-sdk/client-sqs': 'aws.sqs',
  '@aws-sdk/client-sns': 'aws.sns',
  '@aws-sdk/client-eventbridge': 'aws.eventbridge',
  '@aws-sdk/client-kinesis': 'aws.kinesis',
  '@aws-sdk/client-firehose': 'aws.kinesis_firehose',
  '@aws-sdk/client-secrets-manager': 'aws.secrets_manager',
  '@aws-sdk/client-secretsmanager': 'aws.secrets_manager',
  '@aws-sdk/client-ssm': 'aws.ssm_parameter',
  '@aws-sdk/client-bedrock-runtime': 'aws.bedrock',
  '@aws-sdk/client-bedrock-agent-runtime': 'aws.bedrock_kb',
  '@aws-sdk/client-sagemaker-runtime': 'aws.sagemaker_endpoint',
  '@aws-sdk/client-lambda': 'aws.lambda',
  '@aws-sdk/client-kms': 'aws.kms',
  '@aws-sdk/client-ses': 'aws.ses',
  '@aws-sdk/client-rds-data': 'aws.rds_postgres',
  '@aws-sdk/client-sfn': 'aws.stepfunctions_std',
  '@aws-sdk/client-stepfunctions': 'aws.stepfunctions_std',
  '@aws-sdk/client-rekognition': 'aws.rekognition',
  '@aws-sdk/client-textract': 'aws.textract',
  '@aws-sdk/client-comprehend': 'aws.comprehend',
  '@aws-sdk/client-transcribe': 'aws.transcribe',
  '@aws-sdk/client-polly': 'aws.polly',
  '@aws-sdk/client-translate': 'aws.translate',
  '@aws-sdk/client-lex-runtime-v2': 'aws.lex',
  '@aws-sdk/client-kendra': 'aws.kendra',
  'aws.bedrock-runtime': 'aws.bedrock',
  'aws.secretsmanager': 'aws.secrets_manager',
  '@google-cloud/storage': 'gcp.cloud_storage',
  '@google-cloud/pubsub': 'gcp.pubsub',
  '@google-cloud/firestore': 'gcp.firestore',
  '@google-cloud/secret-manager': 'gcp.secret_manager',
  '@google-cloud/vertexai': 'gcp.vertex_gemini',
  'gcp.storage': 'gcp.cloud_storage',
  'gcp.vertexai': 'gcp.vertex_gemini',
  '@azure/storage-blob': 'azure.blob',
  '@azure/cosmos': 'azure.cosmos_db',
  '@azure/service-bus': 'azure.service_bus',
  '@azure/keyvault-secrets': 'azure.key_vault',
  'azure.storage_blob': 'azure.blob',
  'azure.blob_storage': 'azure.blob',
  'azure.cosmos': 'azure.cosmos_db',
  'azure.keyvault': 'azure.key_vault',
  openai: 'azure.openai',
  'oci-objectstorage': 'oci.object_storage',
  'oci-generativeaiinference': 'oci.genai',
  'oci-queue': 'oci.queue',
  'oci.generative_ai': 'oci.genai',
};

const HTTP_HOST_RULES: { pattern: RegExp; serviceId: string }[] = [
  { pattern: /^([^.]+\.)?s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i, serviceId: 'aws.s3' },
  { pattern: /^dynamodb\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.dynamodb' },
  { pattern: /^sqs\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.sqs' },
  { pattern: /^sns\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.sns' },
  { pattern: /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.bedrock' },
  { pattern: /^secretsmanager\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.secrets_manager' },
  { pattern: /^lambda\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.lambda' },
  { pattern: /^kinesis\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.kinesis' },
  { pattern: /^events\.[a-z0-9-]+\.amazonaws\.com$/i, serviceId: 'aws.eventbridge' },
  { pattern: /^storage\.googleapis\.com$/i, serviceId: 'gcp.cloud_storage' },
  { pattern: /^pubsub\.googleapis\.com$/i, serviceId: 'gcp.pubsub' },
  { pattern: /^firestore\.googleapis\.com$/i, serviceId: 'gcp.firestore' },
  { pattern: /^secretmanager\.googleapis\.com$/i, serviceId: 'gcp.secret_manager' },
  { pattern: /^[a-z0-9-]+-aiplatform\.googleapis\.com$/i, serviceId: 'gcp.vertex_gemini' },
  { pattern: /^[^.]+\.blob\.core\.windows\.net$/i, serviceId: 'azure.blob' },
  { pattern: /^[^.]+\.documents\.azure\.com$/i, serviceId: 'azure.cosmos_db' },
  { pattern: /^[^.]+\.servicebus\.windows\.net$/i, serviceId: 'azure.service_bus' },
  { pattern: /^[^.]+\.vault\.azure\.net$/i, serviceId: 'azure.key_vault' },
  { pattern: /^[^.]+\.openai\.azure\.com$/i, serviceId: 'azure.openai' },
  {
    pattern: /^objectstorage\.[a-z0-9-]+\.oraclecloud\.com$/i,
    serviceId: 'oci.object_storage',
  },
  {
    pattern: /^inference\.generativeai\.[a-z0-9-]+\.oci\.oraclecloud\.com$/i,
    serviceId: 'oci.genai',
  },
  {
    pattern: /^cell-[^.]+\.queue\.messaging\.[a-z0-9-]+\.oci\.oraclecloud\.com$/i,
    serviceId: 'oci.queue',
  },
];

/** Normalizes SDK aliases / package names into canonical InfraSim catalog service IDs. */
export function resolveCanonicalServiceId(rawId: string): string {
  const trimmed = rawId.trim();
  if (trimmed in SERVICE_ID_ALIASES) {
    return SERVICE_ID_ALIASES[trimmed]!;
  }
  if (trimmed.startsWith('@aws-sdk/client-')) {
    const shortName = trimmed.slice('@aws-sdk/client-'.length).replace(/-/g, '_');
    const candidate = `aws.${shortName}`;
    return SERVICE_ID_ALIASES[candidate] ?? candidate;
  }
  return trimmed;
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(candidate);
}

function collectReachableNodes(design: Design, startNodeId: string): NodeInstance[] {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const edge of design.edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }
  const visited = new Set<string>();
  const queue = [...(adj.get(startNodeId) ?? [])];
  const out: NodeInstance[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) {
      out.push(node);
    }
    for (const next of adj.get(id) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }
  return out;
}

function sampleDeterministicLatency(model: LatencyModel, rng: SeededPrng): number {
  const p50 = Math.max(0.01, model.p50 || 1);
  const p95 = Math.max(p50, model.p95 || p50);
  if (model.distribution === 'fixed' || p95 <= p50) {
    return p50;
  }
  // Box-Muller normal sample using seeded RNG
  const u1 = Math.max(1e-9, rng.next());
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  if (model.distribution === 'normal') {
    const sigma = (p95 - p50) / 1.6448536269514722;
    return Math.min(600_000, Math.max(0.01, p50 + sigma * z));
  }
  if (model.distribution === 'bimodal' && model.mode2 && rng.next() < model.mode2.weight) {
    const mu2 = Math.log(Math.max(0.01, model.mode2.p50));
    const sig2 = Math.max(
      0,
      (Math.log(Math.max(model.mode2.p50, model.mode2.p95)) - mu2) / 1.6448536269514722,
    );
    return Math.min(600_000, Math.max(0.01, Math.exp(mu2 + sig2 * z)));
  }
  const mu = Math.log(p50);
  const sigma = (Math.log(p95) - mu) / 1.6448536269514722;
  return Math.min(600_000, Math.max(0.01, Math.exp(mu + sigma * z)));
}

function inferHttpOp(method: string, urlStr: string, service: ServiceDefinition): string {
  const m = method.toUpperCase();
  const lowerUrl = urlStr.toLowerCase();
  const opNames = service.operations.map((o) => o.name);

  if (lowerUrl.includes('stream') && opNames.includes('InvokeStream')) return 'InvokeStream';
  if (lowerUrl.includes('embed') && opNames.includes('Embed')) return 'Embed';

  if (m === 'GET' || m === 'HEAD') {
    if (m === 'HEAD' && opNames.includes('HeadObject')) return 'HeadObject';
    for (const candidate of [
      'GetObject',
      'GetItem',
      'GetSecret',
      'Find',
      'Query',
      'ListObjects',
      'Receive',
      'GetStatus',
    ]) {
      if (opNames.includes(candidate)) return candidate;
    }
  } else if (m === 'DELETE') {
    for (const candidate of ['DeleteObject', 'DeleteItem', 'Delete']) {
      if (opNames.includes(candidate)) return candidate;
    }
  } else if (m === 'PUT' || m === 'POST' || m === 'PATCH') {
    for (const candidate of [
      'PutObject',
      'PutItem',
      'UpdateItem',
      'Insert',
      'Send',
      'Publish',
      'PutEvents',
      'Invoke',
    ]) {
      if (opNames.includes(candidate)) return candidate;
    }
  }
  return opNames[0] ?? 'Call';
}

function buildProviderError(
  errorKind: NonNullable<OperationOverride['errorKind']> | 'throttled',
  service: ServiceDefinition,
  opName: string,
  reqUuid: string,
  retryAfterMs?: number,
): MockCallOutcome['error'] {
  const provider = service.provider;
  const kindMap: Record<
    string,
    { name: string; statusCode: number; code: string; msg: string; retryable: boolean }
  > = {
    throttle: {
      name: provider === 'aws' ? 'ThrottlingException' : 'TooManyRequestsError',
      statusCode: 429,
      code: provider === 'gcp' ? 'RESOURCE_EXHAUSTED' : 'ThrottlingException',
      msg: `Rate exceeded for ${service.id}.${opName}`,
      retryable: true,
    },
    throttled: {
      name: provider === 'aws' ? 'ThrottlingException' : 'TooManyRequestsError',
      statusCode: 429,
      code: provider === 'gcp' ? 'RESOURCE_EXHAUSTED' : 'ThrottlingException',
      msg: `Rate exceeded for ${service.id}.${opName}`,
      retryable: true,
    },
    timeout: {
      name: 'TimeoutError',
      statusCode: 504,
      code: provider === 'gcp' ? 'DEADLINE_EXCEEDED' : 'RequestTimeout',
      msg: `Upstream timed out calling ${service.id}.${opName}`,
      retryable: true,
    },
    not_found: {
      name: provider === 'aws' ? 'ResourceNotFoundException' : 'NotFoundError',
      statusCode: 404,
      code: provider === 'gcp' ? 'NOT_FOUND' : 'ResourceNotFoundException',
      msg: `Resource not found in ${service.id}.${opName}`,
      retryable: false,
    },
    access_denied: {
      name: 'AccessDeniedException',
      statusCode: 403,
      code: provider === 'gcp' ? 'PERMISSION_DENIED' : 'AccessDeniedException',
      msg: `Access denied calling ${service.id}.${opName}`,
      retryable: false,
    },
    validation: {
      name: 'ValidationException',
      statusCode: 400,
      code: 'ValidationException',
      msg: `Validation error calling ${service.id}.${opName}`,
      retryable: false,
    },
    server: {
      name: provider === 'aws' ? 'ServiceUnavailableException' : 'InternalServerError',
      statusCode: 500,
      code: provider === 'gcp' ? 'INTERNAL' : 'ServiceUnavailableException',
      msg: `Simulated service error from ${service.id}.${opName}`,
      retryable: true,
    },
  };

  const info = kindMap[errorKind] ?? kindMap.server!;
  return {
    category: 'MockServiceError',
    name: info.name,
    message: info.msg,
    code: info.code,
    statusCode: info.statusCode,
    retryable: info.retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    details: {
      provider,
      serviceId: service.id,
      operation: opName,
      requestId: reqUuid,
      ...(provider === 'oci' ? { opcRequestId: reqUuid, serviceCode: info.code } : {}),
    },
  };
}

export interface CreateMockResolverOptions {
  design?: Design;
  node?: NodeInstance;
  customServices?: readonly ServiceDefinition[];
  seed?: number;
  env?: Record<string, string>;
}

/**
 * Creates a deterministic, stateful mock SDK & HTTP interceptor resolver for a single
 * sandbox invocation (or standalone dry run when no design context is provided).
 */
export function createMockCallResolver(options: CreateMockResolverOptions = {}): MockCallResolver {
  const seed = options.seed ?? options.design?.settings.seed ?? 42;
  const customServices = [
    ...(options.customServices ?? []),
    ...(options.design?.customServices ?? []),
  ];
  const reachableNodes =
    options.design && options.node
      ? collectReachableNodes(options.design, options.node.id)
      : (options.design?.nodes ?? []);

  // Per-node token buckets for stateful virtual-time RPS/RPM throttling
  const bucketState = new Map<string, { tokens: number; lastMs: number }>();

  const checkRateBucket = (node: NodeInstance, nowMs: number): number | null => {
    const rps =
      node.config.rateLimit?.rps ??
      (node.config.rateLimit?.rpm ? node.config.rateLimit.rpm / 60 : undefined);
    if (rps === undefined || rps < 0) return null;
    if (rps === 0) return 1000;
    const capacity = Math.max(1, node.config.rateLimit?.burst ?? Math.ceil(rps));
    const state = bucketState.get(node.id) ?? { tokens: capacity, lastMs: nowMs };
    const elapsedSec = Math.max(0, (nowMs - state.lastMs) / 1000);
    state.tokens = Math.min(capacity, state.tokens + elapsedSec * rps);
    state.lastMs = nowMs;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      bucketState.set(node.id, state);
      return null;
    }
    bucketState.set(node.id, state);
    return Math.ceil(((1 - state.tokens) / rps) * 1000);
  };

  return (invocation, ctx): MockCallOutcome => {
    const rng = createSeededPrng(
      hashSeedParts(seed, ctx.seq, invocation.serviceId ?? invocation.url ?? 'call'),
    );
    const reqUuid = rng.uuid();

    let resolvedServiceId: string | undefined;
    let targetNode: NodeInstance | undefined;
    let aliasOpHint: string | undefined;

    if (invocation.kind === 'http') {
      const urlStr = invocation.url ?? '';
      let parsedHost = '';
      try {
        parsedHost = new URL(urlStr).hostname;
      } catch {
        parsedHost = '';
      }

      // 1. Check httpAliases on reachable nodes (or design nodes)
      const aliasPool =
        options.design && options.node ? reachableNodes : (options.design?.nodes ?? []);
      for (const candidate of aliasPool) {
        const aliases = candidate.config.httpAliases ?? {};
        for (const [pattern, opHint] of Object.entries(aliases)) {
          if (globMatches(pattern, urlStr) || (parsedHost && globMatches(pattern, parsedHost))) {
            targetNode = candidate;
            resolvedServiceId = candidate.serviceId;
            if (opHint) aliasOpHint = opHint;
            break;
          }
        }
        if (targetNode) break;
      }

      // 2. Match built-in provider HTTP host patterns
      if (!resolvedServiceId && parsedHost) {
        for (const rule of HTTP_HOST_RULES) {
          if (rule.pattern.test(parsedHost)) {
            resolvedServiceId = rule.serviceId;
            break;
          }
        }
      }

      if (!resolvedServiceId) {
        return {
          ok: false,
          latencyMs: 2,
          serviceId: 'http',
          op: invocation.method ?? 'GET',
          error: {
            category: 'MockNotConfigured',
            name: 'MockNotConfigured',
            message: `No mock for ${urlStr || 'URL'}. Add a service or HTTP alias to enable it.`,
            statusCode: 502,
          },
        };
      }
    } else {
      resolvedServiceId = resolveCanonicalServiceId(invocation.serviceId ?? 'unknown');
    }

    // Resolve targetNode for cloud calls (or HTTP rule match inside design)
    if (!targetNode && options.design && options.node) {
      const matches = reachableNodes.filter((n) => {
        if (resolveCanonicalServiceId(n.serviceId) !== resolvedServiceId) return false;
        if (invocation.alias && n.label !== invocation.alias && n.id !== invocation.alias)
          return false;
        if (invocation.region && n.region && n.region !== invocation.region) return false;
        return true;
      });
      targetNode = matches[0];
      if (!targetNode) {
        return {
          ok: false,
          latencyMs: 1,
          serviceId: resolvedServiceId,
          op: invocation.op ?? 'Call',
          error: {
            category: 'MockNotConfigured',
            name: 'MockNotConfigured',
            message: `No mock for ${resolvedServiceId}. Add a service or edge to enable it.`,
            statusCode: 502,
          },
        };
      }
    }

    const service = getService(resolvedServiceId, customServices);
    if (!service) {
      return {
        ok: false,
        latencyMs: 1,
        serviceId: resolvedServiceId,
        op: invocation.op ?? 'Call',
        error: {
          category: 'MockNotConfigured',
          name: 'MockNotConfigured',
          message: `No mock for ${resolvedServiceId}. Add a service or edge to enable it.`,
          statusCode: 502,
        },
      };
    }

    // Resolve operation definition
    const rawOp =
      invocation.kind === 'http'
        ? aliasOpHint || inferHttpOp(invocation.method ?? 'GET', invocation.url ?? '', service)
        : invocation.op || service.operations[0]?.name || 'Call';

    const matchedOpDef: OperationDef = service.operations.find(
      (o) => o.name.toLowerCase() === rawOp.toLowerCase(),
    ) ??
      service.operations[0] ?? {
        name: rawOp,
        summary: rawOp,
        defaultResponse: { statusCode: 200, bodyTemplate: '{}' },
        errors: [],
      };

    const opName = matchedOpDef.name;
    const override: OperationOverride | undefined =
      targetNode?.config.operations?.[opName] ?? targetNode?.config.operations?.[rawOp];

    // Step 1: Validate input against operation inputSchema
    const effectiveSchema = override?.inputSchema ?? matchedOpDef.inputSchema;
    const payloadInput = invocation.input ?? invocation.body ?? {};
    if (effectiveSchema) {
      const validation = validateJsonSchemaValue(effectiveSchema, payloadInput);
      if (!validation.valid) {
        const firstMsg = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
        return {
          ok: false,
          latencyMs: 1,
          serviceId: service.id,
          op: opName,
          ...(targetNode ? { targetNodeId: targetNode.id } : {}),
          error: {
            category: 'ValidationError',
            name: 'ValidationException',
            code: 'ValidationException',
            message: `Input validation failed for ${service.id}.${opName}: ${firstMsg}`,
            statusCode: 400,
            retryable: false,
            details: { validationErrors: validation.errors },
          },
        };
      }
    }

    // Step 2: Check virtual-time rate limit bucket on target node
    if (targetNode) {
      const retryAfterMs = checkRateBucket(targetNode, ctx.nowMs);
      if (retryAfterMs !== null) {
        return {
          ok: false,
          latencyMs: 1,
          serviceId: service.id,
          op: opName,
          targetNodeId: targetNode.id,
          error: buildProviderError('throttle', service, opName, reqUuid, retryAfterMs),
        };
      }
    }

    // Step 3: Delegate to AI service mock evaluator if registered and service is AI kind
    if (
      activeAiMockHook &&
      ['llm', 'ml', 'vision', 'speech', 'text-ai', 'doc-ai', 'bot'].includes(service.kind)
    ) {
      const aiOutcome = activeAiMockHook({
        invocation,
        service,
        ...(targetNode ? { node: targetNode } : {}),
        opName,
        operation: matchedOpDef,
        override,
        nowMs: ctx.nowMs,
        seq: ctx.seq,
        seed,
        env: ctx.env,
        rng,
      });
      if (aiOutcome) {
        return aiOutcome;
      }
    }

    // Step 4: Sample operation latency
    const latencyModel =
      override?.latency ?? targetNode?.config.latency ?? matchedOpDef.latency ?? service.latency;
    const latencyMs = sampleDeterministicLatency(latencyModel, rng);

    // Step 5: Roll seeded errorRate (operation -> node -> catalog default)
    const errRate = Math.max(
      0,
      Math.min(1, override?.errorRate ?? targetNode?.config.errorRate ?? service.failure.errorRate),
    );
    if (errRate > 0 && (errRate >= 1 || rng.next() < errRate)) {
      let chosenKind = override?.errorKind;
      if (!chosenKind) {
        const firstKind = service.failure.kinds[0]?.kind;
        chosenKind =
          firstKind === 'throttled'
            ? 'throttle'
            : firstKind === 'timeout' || firstKind === 'conn_timeout'
              ? 'timeout'
              : 'server';
      }
      return {
        ok: false,
        latencyMs,
        serviceId: service.id,
        op: opName,
        ...(targetNode ? { targetNodeId: targetNode.id } : {}),
        error: buildProviderError(chosenKind, service, opName, reqUuid),
      };
    }

    // Step 6: Render mock response template deterministically
    const preview = renderMockOperationPreview(matchedOpDef, override, {
      input: payloadInput,
      env: ctx.env,
      seq: ctx.seq,
      nowMs: ctx.nowMs,
      seed,
    });

    if (preview.statusCode >= 400 && invocation.kind !== 'http') {
      const inferredKind =
        preview.statusCode === 429
          ? 'throttle'
          : preview.statusCode === 404
            ? 'not_found'
            : preview.statusCode === 403
              ? 'access_denied'
              : preview.statusCode === 400
                ? 'validation'
                : preview.statusCode === 504
                  ? 'timeout'
                  : 'server';
      return {
        ok: false,
        latencyMs,
        serviceId: service.id,
        op: opName,
        ...(targetNode ? { targetNodeId: targetNode.id } : {}),
        error: buildProviderError(inferredKind, service, opName, reqUuid),
      };
    }

    let parsedBody: unknown = preview.body;
    if (invocation.kind !== 'http' && typeof preview.body === 'string') {
      const trimmed = preview.body.trim();
      if (!trimmed) {
        parsedBody = {};
      } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedBody = JSON.parse(trimmed);
        } catch {
          parsedBody = preview.body;
        }
      }
    }

    if (invocation.kind === 'http') {
      return {
        ok: true,
        latencyMs,
        serviceId: service.id,
        op: opName,
        ...(targetNode ? { targetNodeId: targetNode.id } : {}),
        statusCode: preview.statusCode,
        headers: preview.headers,
        output: {
          statusCode: preview.statusCode,
          headers: preview.headers,
          body: preview.body,
        },
      };
    }

    return {
      ok: true,
      latencyMs,
      serviceId: service.id,
      op: opName,
      ...(targetNode ? { targetNodeId: targetNode.id } : {}),
      statusCode: preview.statusCode,
      headers: preview.headers,
      output: parsedBody,
    };
  };
}
