import { renderMockOperationPreview, validateJsonSchemaValue } from '@infrasim/catalog';
import type {
  LatencyModel,
  NodeInstance,
  OperationDef,
  OperationOverride,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { AI_MODEL_PROFILES, type AiProfileId } from './aiProfiles.js';
import { type AiMockHook, registerAiMockHook } from './mockResolver.js';
import type { SeededPrng } from './prng.js';
import type { MockCallInvocation, MockCallOutcome } from './types.js';

const PLACEHOLDER_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'do',
  'eiusmod',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'et',
  'dolore',
  'magna',
  'aliqua',
  'enim',
  'minim',
  'veniam',
  'quis',
  'nostrud',
  'exercitation',
  'ullamco',
  'laboris',
  'nisi',
  'aliquip',
  'commodo',
  'consequat',
];

const DEFAULT_RAG_PASSAGES = [
  {
    id: 'doc-1',
    text: 'Vector similarity retrieves top matching knowledge chunks before LLM synthesis.',
    score: 0.94,
  },
  {
    id: 'doc-2',
    text: 'Caching repeated embeddings and answers removes the slowest hop on hot queries.',
    score: 0.89,
  },
  {
    id: 'doc-3',
    text: 'Streaming chunks reduce perceived time-to-first-token while total decode stays bounded by tokens/s.',
    score: 0.84,
  },
  {
    id: 'doc-4',
    text: 'Token bucket quotas limit both requests per minute and total input plus output tokens per minute.',
    score: 0.78,
  },
];

interface AiBucketState {
  tokens: number;
  lastMs: number;
}

interface AiJobRecord {
  jobId: string;
  serviceId: string;
  startMs: number;
  durationMs: number;
  shouldFail: boolean;
  result: Record<string, unknown>;
}

interface AiNodeRuntimeState {
  rpmBucket?: AiBucketState;
  tpmBucket?: AiBucketState;
  activeEndsMs: number[];
  sequenceCursor: number;
  jobs: Map<string, AiJobRecord>;
}

function getNodeState(stateMap: Map<string, unknown>, key: string): AiNodeRuntimeState {
  let entry = stateMap.get(key) as AiNodeRuntimeState | undefined;
  if (!entry) {
    entry = {
      activeEndsMs: [],
      sequenceCursor: 0,
      jobs: new Map(),
    };
    stateMap.set(key, entry);
  }
  return entry;
}

function refillBucket(
  state: AiNodeRuntimeState,
  kind: 'rpm' | 'tpm',
  perMinLimit: number,
  nowMs: number,
): AiBucketState {
  const capacity = Math.max(1, perMinLimit);
  const existing = kind === 'rpm' ? state.rpmBucket : state.tpmBucket;
  const bucket: AiBucketState = existing ?? { tokens: capacity, lastMs: nowMs };
  const elapsedMin = Math.max(0, (nowMs - bucket.lastMs) / 60_000);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMin * perMinLimit);
  bucket.lastMs = nowMs;
  if (kind === 'rpm') state.rpmBucket = bucket;
  else state.tpmBucket = bucket;
  return bucket;
}

function sampleLognormalDeterministic(p50: number, p95: number, rng: SeededPrng): number {
  const med = Math.max(0.01, p50 || 1);
  const hi = Math.max(med, p95 || med);
  if (hi <= med) return med;
  const u1 = Math.max(1e-9, rng.next());
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log(med);
  const sigma = (Math.log(hi) - mu) / 1.6448536269514722;
  return Math.min(600_000, Math.max(0.01, Math.exp(mu + sigma * z)));
}

function sampleLatencyFromModel(model: LatencyModel, rng: SeededPrng): number {
  const p50 = Math.max(0.01, model.p50 || 1);
  const p95 = Math.max(p50, model.p95 || p50);
  if (model.distribution === 'fixed' || p95 <= p50) return p50;
  if (model.distribution === 'normal') {
    const u1 = Math.max(1e-9, rng.next());
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const sigma = (p95 - p50) / 1.6448536269514722;
    return Math.min(600_000, Math.max(0.01, p50 + sigma * z));
  }
  if (model.distribution === 'bimodal' && model.mode2 && rng.next() < model.mode2.weight) {
    return sampleLognormalDeterministic(model.mode2.p50, model.mode2.p95, rng);
  }
  return sampleLognormalDeterministic(p50, p95, rng);
}

function generatePlaceholderTokensText(tokenCount: number, rng: SeededPrng): string {
  const targetWords = Math.max(1, Math.round(tokenCount * 0.75));
  const words: string[] = [];
  for (let i = 0; i < targetWords; i++) {
    const w = PLACEHOLDER_WORDS[Math.floor(rng.next() * PLACEHOLDER_WORDS.length)]!;
    words.push(i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w);
  }
  return `[mock] ${words.join(' ')}.`;
}

function expandTokensTag(
  template: string,
  rng: SeededPrng,
): { text: string; requestedTokens?: number } {
  let requestedTokens: number | undefined;
  const text = template.replace(/\{\{\s*tokens\(\s*(\d+)\s*\)\s*\}\}/gi, (_m, nStr: string) => {
    const count = Math.max(1, Math.min(8192, Number(nStr) || 16));
    requestedTokens = (requestedTokens ?? 0) + count;
    return generatePlaceholderTokensText(count, rng);
  });
  return requestedTokens !== undefined ? { text, requestedTokens } : { text };
}

function extractPromptChars(payload: Record<string, unknown>): {
  chars: number;
  lastUserText: string;
} {
  if (typeof payload.prompt === 'string') {
    return { chars: payload.prompt.length, lastUserText: payload.prompt };
  }
  if (typeof payload.inputText === 'string') {
    return { chars: payload.inputText.length, lastUserText: payload.inputText };
  }
  if (typeof payload.text === 'string') {
    return { chars: payload.text.length, lastUserText: payload.text };
  }
  if (typeof payload.input === 'string') {
    return { chars: payload.input.length, lastUserText: payload.input };
  }
  if (Array.isArray(payload.input)) {
    const parts = payload.input.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const joined = parts.join(' ');
    return { chars: joined.length, lastUserText: parts[parts.length - 1] ?? '' };
  }
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    let chars = 0;
    let lastUserText = '';
    for (const msg of payload.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const content = m.content;
      if (typeof content === 'string') {
        chars += content.length;
        lastUserText = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            const t = (block as { text: string }).text;
            chars += t.length;
            lastUserText = t;
          }
        }
      }
    }
    return { chars, lastUserText };
  }
  if (Array.isArray(payload.contents) && payload.contents.length > 0) {
    const serialized = JSON.stringify(payload.contents);
    return { chars: serialized.length, lastUserText: serialized.slice(0, 160) };
  }
  if (payload.contents && typeof payload.contents === 'object') {
    return extractPromptChars(payload.contents as Record<string, unknown>);
  }
  const jsonLen = JSON.stringify(payload).length;
  return { chars: jsonLen, lastUserText: '' };
}

function readRequestedMaxOutputTokens(payload: Record<string, unknown>): number | undefined {
  const nestedContents =
    payload.contents && typeof payload.contents === 'object' && !Array.isArray(payload.contents)
      ? (payload.contents as Record<string, unknown>)
      : undefined;
  const candidates = [
    payload.max_tokens,
    payload.max_completion_tokens,
    payload.maxOutputTokens,
    payload.maxTokens,
    (payload.inferenceConfig as Record<string, unknown> | undefined)?.maxTokens,
    (payload.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
    nestedContents?.maxOutputTokens,
    (nestedContents?.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return Math.round(c);
    }
  }
  return undefined;
}

function buildAiProviderError(
  kind: 'throttle' | 'context_overflow' | 'validation' | 'server',
  service: ServiceDefinition,
  opName: string,
  reqUuid: string,
  retryAfterMs?: number,
  messageOverride?: string,
): NonNullable<MockCallOutcome['error']> {
  const p = service.provider;
  if (kind === 'throttle') {
    if (p === 'azure') {
      return {
        category: 'MockServiceError',
        name: 'RateLimitError',
        code: '429',
        message: messageOverride ?? `Requests to ${service.id}.${opName} exceeded quota.`,
        statusCode: 429,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        details: {
          provider: p,
          requestId: reqUuid,
          headers: { 'Retry-After': String(Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000))) },
        },
      };
    }
    if (p === 'gcp') {
      return {
        category: 'MockServiceError',
        name: 'GoogleGenerativeAIError',
        code: 'RESOURCE_EXHAUSTED',
        message:
          messageOverride ?? `Quota exceeded (RESOURCE_EXHAUSTED) for ${service.id}.${opName}.`,
        statusCode: 429,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        details: { provider: p, status: 'RESOURCE_EXHAUSTED', requestId: reqUuid },
      };
    }
    if (p === 'oci') {
      return {
        category: 'MockServiceError',
        name: 'OciError',
        code: 'TooManyRequests',
        message: messageOverride ?? `TooManyRequests on ${service.id}.${opName}.`,
        statusCode: 429,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        details: { provider: p, serviceCode: 'TooManyRequests', opcRequestId: reqUuid },
      };
    }
    return {
      category: 'MockServiceError',
      name: 'ThrottlingException',
      code: 'ThrottlingException',
      message: messageOverride ?? `ThrottlingException: Rate exceeded for ${service.id}.${opName}.`,
      statusCode: 429,
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      details: { provider: p, requestId: reqUuid },
    };
  }

  if (kind === 'context_overflow' || kind === 'validation') {
    if (p === 'azure') {
      return {
        category: 'ValidationError',
        name: 'BadRequestError',
        code: kind === 'context_overflow' ? 'context_length_exceeded' : 'invalid_request_error',
        message:
          messageOverride ??
          (kind === 'context_overflow'
            ? "This model's maximum context length exceeded (context_length_exceeded)."
            : `Invalid request parameters for ${service.id}.${opName}`),
        statusCode: 400,
        retryable: false,
        details: {
          provider: p,
          code: kind === 'context_overflow' ? 'context_length_exceeded' : 'invalid_request_error',
        },
      };
    }
    if (p === 'gcp') {
      return {
        category: 'ValidationError',
        name: 'GoogleGenerativeAIError',
        code: 'INVALID_ARGUMENT',
        message:
          messageOverride ?? `INVALID_ARGUMENT: context limit exceeded on ${service.id}.${opName}.`,
        statusCode: 400,
        retryable: false,
        details: { provider: p, status: 'INVALID_ARGUMENT' },
      };
    }
    if (p === 'oci') {
      return {
        category: 'ValidationError',
        name: 'OciError',
        code: 'InvalidParameter',
        message:
          messageOverride ??
          `InvalidParameter: request exceeds model limits for ${service.id}.${opName}.`,
        statusCode: 400,
        retryable: false,
        details: { provider: p, opcRequestId: reqUuid },
      };
    }
    return {
      category: 'ValidationError',
      name: 'ValidationException',
      code: 'ValidationException',
      message:
        messageOverride ??
        `ValidationException: input length and maxTokens exceed context window for ${service.id}.${opName}.`,
      statusCode: 400,
      retryable: false,
      details: { provider: p, requestId: reqUuid },
    };
  }

  return {
    category: 'MockServiceError',
    name: p === 'aws' ? 'ServiceUnavailableException' : 'InternalServerError',
    code: p === 'gcp' ? 'INTERNAL' : 'ServiceUnavailableException',
    message: messageOverride ?? `Simulated service failure from ${service.id}.${opName}`,
    statusCode: 500,
    retryable: true,
    details: { provider: p, requestId: reqUuid },
  };
}

/**
 * Deterministically synthesizes a schema-valid JSON value from a JSON Schema subset
 * using the seeded PRNG (used by `responseMode: 'json-fill'` and `'tool-call'`).
 */
export function fillValueFromJsonSchema(
  schema: Record<string, unknown> | undefined,
  rng: SeededPrng,
  depth = 0,
): unknown {
  if (!schema || depth > 8) {
    return 'mock-value';
  }
  if ('const' in schema) {
    return schema.const;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[Math.floor(rng.next() * schema.enum.length)];
  }

  const rawType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const inferredType =
    typeof rawType === 'string'
      ? rawType
      : schema.properties
        ? 'object'
        : schema.items
          ? 'array'
          : 'string';

  switch (inferredType) {
    case 'null':
      return null;
    case 'boolean':
      return rng.next() >= 0.5;
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 1;
      const max = typeof schema.maximum === 'number' ? Math.max(min, schema.maximum) : min + 100;
      const val = min + rng.next() * (max - min);
      return inferredType === 'integer' ? Math.round(val) : Number(val.toFixed(2));
    }
    case 'string': {
      const fmt = typeof schema.format === 'string' ? schema.format : undefined;
      if (fmt === 'uuid') return rng.uuid();
      if (fmt === 'email') return `user-${rng.int(100, 999)}@example.com`;
      if (fmt === 'date-time') return '2026-01-15T12:00:00.000Z';
      const minLen = typeof schema.minLength === 'number' ? Math.max(1, schema.minLength) : 3;
      const maxLen = typeof schema.maxLength === 'number' ? Math.max(minLen, schema.maxLength) : 32;
      let base = `${PLACEHOLDER_WORDS[Math.floor(rng.next() * PLACEHOLDER_WORDS.length)]}-${rng.int(10, 99)}`;
      while (base.length < minLen) base += '-mock';
      if (base.length > maxLen) base = base.slice(0, maxLen);
      return base;
    }
    case 'array': {
      const minItems = typeof schema.minItems === 'number' ? Math.max(0, schema.minItems) : 1;
      const maxItems =
        typeof schema.maxItems === 'number'
          ? Math.max(minItems, schema.maxItems)
          : Math.max(minItems, 3);
      const count = Math.min(8, minItems + Math.floor(rng.next() * (maxItems - minItems + 1)));
      const itemSchema =
        schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
          ? (schema.items as Record<string, unknown>)
          : undefined;
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        arr.push(fillValueFromJsonSchema(itemSchema, rng, depth + 1));
      }
      return arr;
    }
    case 'object':
    default: {
      const props =
        schema.properties && typeof schema.properties === 'object'
          ? (schema.properties as Record<string, Record<string, unknown>>)
          : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      const out: Record<string, unknown> = {};
      for (const [k, propSchema] of Object.entries(props)) {
        if (required.has(k) || rng.next() < 0.85) {
          out[k] = fillValueFromJsonSchema(propSchema, rng, depth + 1);
        }
      }
      if (Object.keys(out).length === 0 && required.size === 0 && !schema.properties) {
        out.summary = PLACEHOLDER_WORDS[Math.floor(rng.next() * PLACEHOLDER_WORDS.length)] ?? 'ok';
        out.confidence = Number((0.7 + rng.next() * 0.25).toFixed(2));
      }
      return out;
    }
  }
}

function buildProviderLlmBody(params: {
  service: ServiceDefinition;
  node?: NodeInstance;
  responseShape: 'provider' | 'normalized';
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  latencyMs: number;
  nowMs: number;
  rng: SeededPrng;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}): Record<string, unknown> {
  const {
    service,
    node,
    responseShape,
    text,
    inputTokens,
    outputTokens,
    finishReason,
    latencyMs,
    nowMs,
    rng,
    toolCall,
  } = params;
  const totalTokens = inputTokens + outputTokens;

  if (responseShape === 'normalized') {
    return {
      text,
      ...(toolCall ? { toolCalls: [toolCall] } : {}),
      usage: { inputTokens, outputTokens },
      finishReason,
    };
  }

  const modelLabel = node?.config.ai?.modelLabel || `${service.id}-mock`;
  switch (service.provider) {
    case 'azure': {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: toolCall ? null : text,
        ...(toolCall
          ? {
              tool_calls: [
                {
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.arguments),
                  },
                },
              ],
            }
          : {}),
      };
      return {
        id: `chatcmpl-${rng.uuid().replace(/-/g, '').slice(0, 12)}`,
        object: 'chat.completion',
        created: Math.floor(nowMs / 1000),
        model: modelLabel,
        choices: [
          {
            index: 0,
            message: msg,
            finish_reason: toolCall
              ? 'tool_calls'
              : finishReason === 'content_filter'
                ? 'content_filter'
                : 'stop',
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: totalTokens,
        },
      };
    }
    case 'gcp': {
      const part: Record<string, unknown> = toolCall
        ? { functionCall: { name: toolCall.name, args: toolCall.arguments } }
        : { text };
      return {
        candidates: [
          {
            content: { role: 'model', parts: [part] },
            finishReason: finishReason === 'content_filter' ? 'SAFETY' : 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: totalTokens,
        },
      };
    }
    case 'oci': {
      const content = toolCall
        ? [{ type: 'TEXT', text: JSON.stringify(toolCall) }]
        : [{ type: 'TEXT', text }];
      return {
        modelId: modelLabel,
        chatResponse: {
          choices: [
            {
              message: { role: 'ASSISTANT', content },
              finishReason: finishReason === 'content_filter' ? 'content_filter' : 'stop',
            },
          ],
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens,
          },
        },
      };
    }
    case 'aws':
    default: {
      const content = toolCall
        ? [{ toolUse: { toolUseId: toolCall.id, name: toolCall.name, input: toolCall.arguments } }]
        : [{ text }];
      return {
        output: {
          message: {
            role: 'assistant',
            content,
          },
        },
        stopReason: toolCall
          ? 'tool_use'
          : finishReason === 'content_filter'
            ? 'content_filtered'
            : 'end_turn',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        metrics: {
          latencyMs: Math.round(latencyMs),
        },
      };
    }
  }
}

function buildStreamChunks(params: {
  service: ServiceDefinition;
  node?: NodeInstance;
  text: string;
  ttftMs: number;
  decodeMs: number;
  outputTokens: number;
  inputTokens: number;
  chunkTokens: number;
  rng: SeededPrng;
}): { delayOffsetMs: number; data: unknown }[] {
  const { service, node, text, ttftMs, decodeMs, outputTokens, inputTokens, chunkTokens, rng } =
    params;
  const totalChunks = Math.max(1, Math.ceil(outputTokens / Math.max(1, chunkTokens)));
  const charsPerChunk = Math.max(1, Math.ceil(text.length / totalChunks));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += charsPerChunk) {
    pieces.push(text.slice(i, i + charsPerChunk));
  }
  if (pieces.length === 0) pieces.push('');

  const n = pieces.length;
  const spanStep = n > 1 ? decodeMs / (n - 1) : decodeMs;
  const streamId = `chatcmpl-${rng.uuid().replace(/-/g, '').slice(0, 12)}`;
  const modelName = node?.config.ai?.modelLabel || `${service.id}-mock`;
  const usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };

  return pieces.map((piece, idx) => {
    const isLast = idx === n - 1;
    const delayOffsetMs =
      n === 1 ? ttftMs + decodeMs : Number((ttftMs + idx * spanStep).toFixed(3));

    if (service.provider === 'azure') {
      return {
        delayOffsetMs,
        data: {
          id: streamId,
          object: 'chat.completion.chunk',
          model: modelName,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: isLast ? 'stop' : null }],
          ...(isLast
            ? {
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                },
              }
            : {}),
        },
      };
    }
    if (service.provider === 'gcp') {
      return {
        delayOffsetMs,
        data: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: piece }] },
              ...(isLast ? { finishReason: 'STOP' } : {}),
            },
          ],
          ...(isLast
            ? {
                usageMetadata: {
                  promptTokenCount: inputTokens,
                  candidatesTokenCount: outputTokens,
                  totalTokenCount: inputTokens + outputTokens,
                },
              }
            : {}),
        },
      };
    }
    if (service.provider === 'aws') {
      if (isLast) {
        return {
          delayOffsetMs,
          data: {
            contentBlockDelta: { contentBlockIndex: 0, delta: { text: piece } },
            messageStop: { stopReason: 'end_turn' },
            metadata: { usage, metrics: { latencyMs: Math.round(ttftMs + decodeMs) } },
          },
        };
      }
      return {
        delayOffsetMs,
        data: {
          contentBlockDelta: { contentBlockIndex: 0, delta: { text: piece } },
        },
      };
    }
    return {
      delayOffsetMs,
      data: { delta: piece, index: idx, ...(isLast ? { finishReason: 'stop', usage } : {}) },
    };
  });
}

function handleLlmOrEmbed(params: {
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
  stateMap: Map<string, unknown>;
}): MockCallOutcome {
  const {
    invocation,
    service,
    node,
    opName,
    operation,
    override,
    nowMs,
    seq,
    seed,
    env,
    rng,
    stateMap,
  } = params;
  const effectiveOp = invocation.op || opName;
  const reqUuid = rng.uuid();
  const payload = ((invocation.input ?? invocation.body ?? {}) as Record<string, unknown>) || {};
  const isEmbed =
    effectiveOp === 'Embed' ||
    service.id === 'oci.genai_embed' ||
    node?.config.ai?.profile === 'embedding';

  const profileId: AiProfileId = isEmbed ? 'embedding' : (node?.config.ai?.profile ?? 'balanced');
  const profile = AI_MODEL_PROFILES[profileId] ?? AI_MODEL_PROFILES.balanced;

  // Token counting
  const { chars: promptChars, lastUserText } = extractPromptChars(payload);
  const nestedContents =
    payload.contents && typeof payload.contents === 'object' && !Array.isArray(payload.contents)
      ? (payload.contents as Record<string, unknown>)
      : undefined;
  const explicitUsage = (payload.usage ?? nestedContents?.usage) as
    Record<string, unknown> | undefined;
  const explicitInputTokens =
    typeof explicitUsage?.inputTokens === 'number'
      ? explicitUsage.inputTokens
      : typeof payload.inputTokens === 'number'
        ? payload.inputTokens
        : typeof nestedContents?.inputTokens === 'number'
          ? nestedContents.inputTokens
          : undefined;
  const explicitOutputTokens =
    typeof explicitUsage?.outputTokens === 'number'
      ? explicitUsage.outputTokens
      : typeof payload.outputTokens === 'number'
        ? payload.outputTokens
        : typeof nestedContents?.outputTokens === 'number'
          ? nestedContents.outputTokens
          : undefined;
  const inputTokens =
    explicitInputTokens !== undefined
      ? Math.max(1, Math.round(explicitInputTokens))
      : Math.max(1, Math.ceil(promptChars / 4));

  const maxContextTokens = node?.config.rateLimit?.maxContextTokens ?? profile.contextWindow;
  const configuredMaxOut = node?.config.rateLimit?.maxOutputTokens;
  const reqMaxOutput = readRequestedMaxOutputTokens(payload);
  const reserveMaxOut = reqMaxOutput ?? configuredMaxOut ?? (isEmbed ? 0 : 256);

  // Context length check (HTTP 400 validation error)
  if (inputTokens + reserveMaxOut > maxContextTokens) {
    return {
      ok: false,
      latencyMs: 2,
      serviceId: service.id,
      op: opName,
      ...(node ? { targetNodeId: node.id } : {}),
      error: buildAiProviderError(
        'context_overflow',
        service,
        opName,
        reqUuid,
        undefined,
        `Prompt (${inputTokens} tokens) + maxOutputTokens (${reserveMaxOut}) exceeds context window (${maxContextTokens}).`,
      ),
    };
  }

  // Embeddings batch validation
  if (isEmbed) {
    const inputsList = Array.isArray(payload.inputs)
      ? payload.inputs
      : Array.isArray(payload.input)
        ? payload.input
        : [payload.inputText ?? payload.input ?? 'mock text'];
    if (inputsList.length > 96) {
      return {
        ok: false,
        latencyMs: 2,
        serviceId: service.id,
        op: opName,
        ...(node ? { targetNodeId: node.id } : {}),
        error: buildAiProviderError(
          'validation',
          service,
          opName,
          reqUuid,
          undefined,
          `Embedding batch size ${inputsList.length} exceeds limit of 96 inputs.`,
        ),
      };
    }
    const baseMs = sampleLatencyFromModel(
      override?.latency ??
        node?.config.latency ?? {
          distribution: 'lognormal',
          p50: profile.ttftP50Ms,
          p95: profile.ttftP95Ms,
        },
      rng,
    );
    const embedLatencyMs = Number((baseMs + 0.5 * inputsList.length).toFixed(2));
    const dims = Math.max(8, Math.min(4096, Math.round(node?.config.ai?.dimensions ?? 1024)));
    const vecs = inputsList.map(() => {
      const arr: number[] = [];
      for (let i = 0; i < dims; i++) {
        arr.push(Number((rng.next() * 2 - 1).toFixed(5)));
      }
      return arr;
    });
    return {
      ok: true,
      latencyMs: embedLatencyMs,
      serviceId: service.id,
      op: opName,
      ...(node ? { targetNodeId: node.id } : {}),
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      tokens: { in: inputTokens, out: 0 },
      output: {
        embedding: vecs[0],
        embeddings: vecs,
        usage: { inputTokens },
      },
    };
  }

  // Determine response output mode & output tokens before quota deduction
  const nodeState = getNodeState(stateMap, node?.id ?? service.id);
  const responseMode =
    node?.config.ai?.responseMode ?? (override?.responseTemplate ? 'template' : 'template');
  const responseShape = node?.config.ai?.responseShape ?? 'provider';

  let generatedText = '';
  let generatedToolCall:
    { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  let requestedTokensHint: number | undefined;

  if (responseMode === 'json-fill') {
    const reqFmt = payload.response_format as Record<string, unknown> | undefined;
    const genCfg = payload.generationConfig as Record<string, unknown> | undefined;
    const rawSchema =
      node?.config.ai?.jsonSchema ??
      ((reqFmt?.json_schema as Record<string, unknown> | undefined)?.schema as
        Record<string, unknown> | undefined) ??
      (genCfg?.responseSchema as Record<string, unknown> | undefined);
    const filled = fillValueFromJsonSchema(rawSchema, rng);
    if (rawSchema) {
      const check = validateJsonSchemaValue(rawSchema, filled);
      if (!check.valid) {
        return {
          ok: false,
          latencyMs: 2,
          serviceId: service.id,
          op: opName,
          ...(node ? { targetNodeId: node.id } : {}),
          error: buildAiProviderError(
            'validation',
            service,
            opName,
            reqUuid,
            undefined,
            check.errors[0]?.message,
          ),
        };
      }
    }
    generatedText = JSON.stringify(filled);
  } else if (responseMode === 'tool-call') {
    const tools =
      (Array.isArray(payload.tools) ? payload.tools : undefined) ??
      ((payload.toolConfig as Record<string, unknown> | undefined)?.tools as
        unknown[] | undefined) ??
      (Array.isArray(payload.functions) ? payload.functions : undefined);
    const firstTool = (tools?.[0] as Record<string, unknown> | undefined) ?? {};
    const fnObj =
      (firstTool.function as Record<string, unknown> | undefined) ??
      (firstTool.toolSpec as Record<string, unknown> | undefined) ??
      firstTool;
    const toolName = typeof fnObj.name === 'string' ? fnObj.name : 'lookup_record';
    const paramSchema =
      (fnObj.parameters as Record<string, unknown> | undefined) ??
      ((fnObj.inputSchema as Record<string, unknown> | undefined)?.json as
        Record<string, unknown> | undefined) ??
      node?.config.ai?.jsonSchema;
    const argsRaw = fillValueFromJsonSchema(paramSchema, rng);
    const args =
      argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : { query: 'mock' };
    generatedToolCall = {
      id: `call_${rng.uuid().slice(0, 8)}`,
      name: toolName,
      arguments: args,
    };
    generatedText = JSON.stringify(args);
  } else if (responseMode === 'sequence' && node?.config.ai?.sequenceResponses?.length) {
    const list = node.config.ai.sequenceResponses;
    const picked = list[nodeState.sequenceCursor % list.length]!;
    nodeState.sequenceCursor += 1;
    const expanded = expandTokensTag(picked, rng);
    generatedText = expanded.text;
    requestedTokensHint = expanded.requestedTokens;
  } else if (responseMode === 'echo') {
    generatedText = lastUserText || 'Echo: empty prompt';
  } else if (responseMode === 'fixed') {
    generatedText = 'Mock response generated by InfraSim.';
  } else {
    const tpl = override?.responseTemplate;
    if (tpl) {
      const expanded = expandTokensTag(tpl, rng);
      requestedTokensHint = expanded.requestedTokens;
      const preview = renderMockOperationPreview(
        operation,
        { ...override, responseTemplate: expanded.text },
        { input: payload, env, seq, nowMs, seed },
      );
      generatedText =
        typeof preview.body === 'string' ? preview.body : JSON.stringify(preview.body);
    } else {
      const targetTok =
        explicitOutputTokens !== undefined
          ? Math.max(1, Math.round(explicitOutputTokens))
          : node?.config.ai?.outputTokens
            ? Math.max(1, Math.round(sampleLatencyFromModel(node.config.ai.outputTokens, rng)))
            : Math.max(1, Math.round(sampleLognormalDeterministic(180, 420, rng)));
      generatedText = generatePlaceholderTokensText(targetTok, rng);
      requestedTokensHint = targetTok;
    }
  }

  let outputTokens =
    requestedTokensHint !== undefined
      ? requestedTokensHint
      : explicitOutputTokens !== undefined
        ? Math.max(1, Math.round(explicitOutputTokens))
        : node?.config.ai?.outputTokens
          ? Math.max(1, Math.round(sampleLatencyFromModel(node.config.ai.outputTokens, rng)))
          : Math.max(1, Math.ceil(generatedText.length / 4));

  const effectiveMaxOut =
    reqMaxOutput !== undefined && configuredMaxOut !== undefined
      ? Math.min(reqMaxOutput, configuredMaxOut)
      : (reqMaxOutput ?? configuredMaxOut);
  if (effectiveMaxOut !== undefined && outputTokens > effectiveMaxOut) {
    outputTokens = Math.max(1, effectiveMaxOut);
  }

  const thinkingTokens =
    profileId === 'reasoning'
      ? Math.max(32, Math.round(sampleLognormalDeterministic(400, 1400, rng)))
      : 0;
  const billedOutputTokens = outputTokens + thinkingTokens;

  // Quotas: Concurrency, RPM, TPM (1 minute burst by default)
  nodeState.activeEndsMs = nodeState.activeEndsMs.filter((t) => t > nowMs);
  const concurrencyLimit = node?.config.rateLimit?.concurrency;
  if (
    concurrencyLimit !== undefined &&
    concurrencyLimit > 0 &&
    nodeState.activeEndsMs.length >= concurrencyLimit
  ) {
    const earliestEnd = Math.min(...nodeState.activeEndsMs);
    return {
      ok: false,
      latencyMs: 1,
      serviceId: service.id,
      op: opName,
      ...(node ? { targetNodeId: node.id } : {}),
      error: buildAiProviderError(
        'throttle',
        service,
        opName,
        reqUuid,
        Math.max(10, Math.ceil(earliestEnd - nowMs)),
      ),
    };
  }

  const rpm = node?.config.rateLimit?.rpm;
  const tpm = node?.config.rateLimit?.tpm;
  const countUpfront = Boolean(
    node?.config.rateLimit?.countMaxTokensUpfront ?? node?.config.ai?.countMaxTokensUpfront,
  );
  const tokensNeeded = countUpfront
    ? inputTokens + (effectiveMaxOut ?? billedOutputTokens)
    : inputTokens + billedOutputTokens;

  let rpmBucket: AiBucketState | undefined;
  let tpmBucket: AiBucketState | undefined;

  if (rpm !== undefined && rpm >= 0) {
    rpmBucket = refillBucket(nodeState, 'rpm', Math.max(0.0001, rpm), nowMs);
    if (rpm === 0 || rpmBucket.tokens < 1) {
      const retryAfterMs =
        rpm === 0 ? 60_000 : Math.max(1, Math.ceil(((1 - rpmBucket.tokens) / rpm) * 60_000));
      return {
        ok: false,
        latencyMs: 1,
        serviceId: service.id,
        op: opName,
        ...(node ? { targetNodeId: node.id } : {}),
        error: buildAiProviderError('throttle', service, opName, reqUuid, retryAfterMs),
      };
    }
  }

  if (tpm !== undefined && tpm >= 0) {
    tpmBucket = refillBucket(nodeState, 'tpm', Math.max(0.0001, tpm), nowMs);
    if (tpm === 0 || tpmBucket.tokens < tokensNeeded) {
      const deficit = tokensNeeded - tpmBucket.tokens;
      const retryAfterMs = tpm === 0 ? 60_000 : Math.max(1, Math.ceil((deficit / tpm) * 60_000));
      return {
        ok: false,
        latencyMs: 1,
        serviceId: service.id,
        op: opName,
        ...(node ? { targetNodeId: node.id } : {}),
        error: buildAiProviderError('throttle', service, opName, reqUuid, retryAfterMs),
      };
    }
  }

  if (rpmBucket) rpmBucket.tokens -= 1;
  if (tpmBucket) tpmBucket.tokens -= tokensNeeded;

  // Probabilistic failure injection
  const errRate = Math.max(
    0,
    Math.min(1, override?.errorRate ?? node?.config.errorRate ?? service.failure.errorRate),
  );
  if (errRate > 0 && rng.next() < errRate) {
    return {
      ok: false,
      latencyMs: 5,
      serviceId: service.id,
      op: opName,
      ...(node ? { targetNodeId: node.id } : {}),
      error: buildAiProviderError('server', service, opName, reqUuid),
    };
  }

  // Latency computation: TTFT + decode + capacity mode
  const ttftBaseModel: LatencyModel = override?.latency
    ? override.latency
    : { distribution: 'lognormal', p50: profile.ttftP50Ms, p95: profile.ttftP95Ms };
  const prefillMs = inputTokens * profile.prefillMsPerToken;
  let ttftMs = sampleLatencyFromModel(ttftBaseModel, rng) + prefillMs;

  const isProvisioned = node?.config.ai?.capacityMode === 'provisioned';
  let effectiveTps = profile.tokensPerSec > 0 ? profile.tokensPerSec : 70;
  if (isProvisioned) {
    const units = Math.max(1, node?.config.ai?.provisionedUnits ?? 1);
    const tpsPerUnit = Math.max(1, node?.config.ai?.tokensPerSecPerUnit ?? effectiveTps);
    const totalPoolTps = units * tpsPerUnit;
    const activeStreams = nodeState.activeEndsMs.length + 1;
    effectiveTps = activeStreams > units ? totalPoolTps / activeStreams : tpsPerUnit;
    if (activeStreams > units * 4) {
      return {
        ok: false,
        latencyMs: 2,
        serviceId: service.id,
        op: opName,
        ...(node ? { targetNodeId: node.id } : {}),
        error: buildAiProviderError(
          'throttle',
          service,
          opName,
          reqUuid,
          500,
          'Provisioned throughput queue saturated.',
        ),
      };
    }
  } else {
    const slowdownProb = Math.max(0, Math.min(1, node?.config.ai?.slowdownProb ?? 0.02));
    if (slowdownProb > 0 && rng.next() < slowdownProb) {
      const mult = 2 + rng.next() * 2;
      ttftMs *= mult;
      effectiveTps /= mult;
    }
  }

  const decodeMs = ((outputTokens + thinkingTokens) / Math.max(1, effectiveTps)) * 1000;
  const totalMs = Number((ttftMs + decodeMs).toFixed(2));
  nodeState.activeEndsMs.push(nowMs + totalMs);

  // Content filter
  const filterRate = Math.max(0, Math.min(1, node?.config.ai?.contentFilterRate ?? 0));
  const finishReason = filterRate > 0 && rng.next() < filterRate ? 'content_filter' : 'stop';

  const outputObj = buildProviderLlmBody({
    service,
    node,
    responseShape,
    text: generatedText,
    inputTokens,
    outputTokens,
    finishReason,
    latencyMs: totalMs,
    nowMs,
    rng,
    toolCall: generatedToolCall,
  });

  const isStream = Boolean(invocation.stream) || effectiveOp === 'InvokeStream';
  const ttftRounded = Number(ttftMs.toFixed(2));
  const decodeRounded = Number(decodeMs.toFixed(2));
  const spans = isStream
    ? [
        { phase: 'ttft' as const, startMs: 0, durationMs: ttftRounded },
        { phase: 'decode' as const, startMs: ttftRounded, durationMs: decodeRounded },
      ]
    : undefined;

  const streamChunks = isStream
    ? buildStreamChunks({
        service,
        node,
        text: generatedText,
        ttftMs: ttftRounded,
        decodeMs: decodeRounded,
        outputTokens,
        inputTokens,
        chunkTokens: Math.max(1, node?.config.ai?.chunkTokens ?? 4),
        rng,
      })
    : undefined;

  return {
    ok: true,
    latencyMs: totalMs,
    serviceId: service.id,
    op: opName,
    ...(node ? { targetNodeId: node.id } : {}),
    statusCode: 200,
    headers: { 'content-type': isStream ? 'text/event-stream' : 'application/json' },
    output: outputObj,
    ...(streamChunks ? { streamChunks } : {}),
    ...(spans ? { spans } : {}),
    tokens: {
      in: inputTokens,
      out: billedOutputTokens,
      ...(thinkingTokens > 0 ? { thinking: thinkingTokens } : {}),
    },
  };
}

function handleOtherAiKinds(params: {
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
  stateMap: Map<string, unknown>;
}): MockCallOutcome | null {
  const {
    invocation,
    service,
    node,
    opName,
    operation,
    override,
    nowMs,
    seq,
    seed,
    env,
    rng,
    stateMap,
  } = params;
  const effectiveOp = invocation.op || opName;
  const payload = ((invocation.input ?? invocation.body ?? {}) as Record<string, unknown>) || {};
  const kind = service.kind;
  const reqUuid = rng.uuid();
  const nodeState = getNodeState(stateMap, node?.id ?? service.id);
  const errRate = Math.max(
    0,
    Math.min(1, override?.errorRate ?? node?.config.errorRate ?? service.failure.errorRate),
  );

  // Search (RAG / vector search)
  if (kind === 'search') {
    const isVectorOrRag =
      effectiveOp.toLowerCase() === 'search' ||
      service.id === 'aws.bedrock_kb' ||
      Boolean(node?.config.ai?.passages?.length) ||
      Array.isArray(payload.vector) ||
      Array.isArray(payload.embedding) ||
      typeof payload.query === 'string';
    if (!isVectorOrRag) {
      return null;
    }
    const baseMs = sampleLatencyFromModel(
      override?.latency ?? node?.config.latency ?? operation.latency ?? service.latency,
      rng,
    );
    if (errRate > 0 && rng.next() < errRate) {
      return {
        ok: false,
        latencyMs: baseMs,
        serviceId: service.id,
        op: effectiveOp,
        ...(node ? { targetNodeId: node.id } : {}),
        error: buildAiProviderError('server', service, effectiveOp, reqUuid),
      };
    }
    const sourcePassages =
      node?.config.ai?.passages && node.config.ai.passages.length > 0
        ? node.config.ai.passages
        : DEFAULT_RAG_PASSAGES;
    const topK =
      typeof payload.topK === 'number' && payload.topK > 0
        ? Math.round(payload.topK)
        : Math.max(1, node?.config.ai?.topK ?? 3);
    const sorted = [...sourcePassages].sort((a, b) => b.score - a.score).slice(0, topK);
    return {
      ok: true,
      latencyMs: baseMs,
      serviceId: service.id,
      op: effectiveOp,
      ...(node ? { targetNodeId: node.id } : {}),
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      output: {
        passages: sorted,
        hits: sorted,
        totalHits: sourcePassages.length,
      },
    };
  }

  // Async batch / speech async job protocol (Start / GetStatus)
  const isAsyncJobOp =
    kind === 'async' ||
    effectiveOp === 'Start' ||
    effectiveOp === 'GetStatus' ||
    (kind === 'speech' && payload.batch === true);
  if (
    isAsyncJobOp &&
    (effectiveOp === 'GetStatus' || effectiveOp === 'Start' || kind === 'async')
  ) {
    const baseMs = sampleLatencyFromModel(
      override?.latency ?? node?.config.latency ?? { distribution: 'lognormal', p50: 25, p95: 80 },
      rng,
    );
    if (effectiveOp === 'GetStatus') {
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      const job = nodeState.jobs.get(jobId);
      if (!job) {
        return {
          ok: false,
          latencyMs: baseMs,
          serviceId: service.id,
          op: effectiveOp,
          ...(node ? { targetNodeId: node.id } : {}),
          error: buildAiProviderError(
            'validation',
            service,
            effectiveOp,
            reqUuid,
            undefined,
            `Unknown jobId: ${jobId}`,
          ),
        };
      }
      const elapsed = nowMs - job.startMs;
      if (elapsed < job.durationMs) {
        return {
          ok: true,
          latencyMs: baseMs,
          serviceId: service.id,
          op: effectiveOp,
          ...(node ? { targetNodeId: node.id } : {}),
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          output: {
            jobId: job.jobId,
            status: 'IN_PROGRESS',
            progressPct: Math.min(
              99,
              Math.max(1, Math.round((elapsed / Math.max(1, job.durationMs)) * 100)),
            ),
          },
        };
      }
      return {
        ok: true,
        latencyMs: baseMs,
        serviceId: service.id,
        op: effectiveOp,
        ...(node ? { targetNodeId: node.id } : {}),
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        output: {
          jobId: job.jobId,
          status: job.shouldFail ? 'FAILED' : 'COMPLETED',
          progressPct: 100,
          ...(job.shouldFail ? { error: 'Simulated batch job failure' } : { result: job.result }),
        },
      };
    }

    // Start async job
    const jobId = `job-${rng.uuid().slice(0, 8)}`;
    const jobDurationMs = Math.max(100, node?.config.ai?.jobDurationMs ?? 5_000);
    const shouldFail = errRate > 0 && rng.next() < errRate;
    const jobResult =
      kind === 'speech'
        ? { transcript: generatePlaceholderTokensText(24, rng), confidence: 0.94 }
        : { completedAtMs: nowMs + jobDurationMs, artifacts: [`s3://mock-output/${jobId}.json`] };
    nodeState.jobs.set(jobId, {
      jobId,
      serviceId: service.id,
      startMs: nowMs,
      durationMs: jobDurationMs,
      shouldFail,
      result: jobResult,
    });
    return {
      ok: true,
      latencyMs: baseMs,
      serviceId: service.id,
      op: effectiveOp,
      ...(node ? { targetNodeId: node.id } : {}),
      statusCode: 202,
      headers: { 'content-type': 'application/json' },
      output: { jobId, status: 'IN_PROGRESS' },
    };
  }

  // Remaining AI kinds (`ml`, `vision`, `doc-ai`, `text-ai`, `speech` sync, `bot`)
  const baseMs = sampleLatencyFromModel(
    override?.latency ?? node?.config.latency ?? operation.latency ?? service.latency,
    rng,
  );
  let totalMs = baseMs;
  if (kind === 'ml') {
    const payloadBytes = JSON.stringify(payload).length;
    totalMs += (payloadBytes / (10 * 1024 * 1024)) * 1000;
  } else if (kind === 'vision') {
    const imageSizeMb =
      typeof payload.imageSizeMB === 'number'
        ? Math.max(0.01, payload.imageSizeMB)
        : Math.max(0.1, JSON.stringify(payload).length / (1024 * 1024));
    totalMs += 40 * imageSizeMb;
  } else if (kind === 'doc-ai') {
    const pages = typeof payload.pages === 'number' && payload.pages > 0 ? payload.pages : 1;
    totalMs += 400 * pages;
  } else if (kind === 'text-ai') {
    const textChars =
      typeof payload.text === 'string'
        ? payload.text.length
        : typeof payload.chars === 'number'
          ? payload.chars
          : JSON.stringify(payload).length;
    totalMs += 0.02 * textChars;
  } else if (kind === 'speech') {
    const audioSec =
      typeof payload.audioSeconds === 'number' && payload.audioSeconds > 0
        ? payload.audioSeconds
        : 5;
    totalMs = Math.max(baseMs, 0.3 * audioSec * 1000);
  }

  if (errRate > 0 && rng.next() < errRate) {
    return {
      ok: false,
      latencyMs: Number(totalMs.toFixed(2)),
      serviceId: service.id,
      op: opName,
      ...(node ? { targetNodeId: node.id } : {}),
      error: buildAiProviderError('server', service, opName, reqUuid),
    };
  }

  const expandedTemplate = override?.responseTemplate
    ? expandTokensTag(override.responseTemplate, rng).text
    : undefined;
  const preview = renderMockOperationPreview(
    operation,
    expandedTemplate ? { ...override, responseTemplate: expandedTemplate } : override,
    { input: payload, env, seq, nowMs, seed },
  );

  return {
    ok: preview.statusCode < 400,
    latencyMs: Number(totalMs.toFixed(2)),
    serviceId: service.id,
    op: opName,
    ...(node ? { targetNodeId: node.id } : {}),
    statusCode: preview.statusCode,
    headers: preview.headers,
    output: preview.body,
  };
}

/**
 * Evaluates AI, ML, vision, speech, doc-ai, text-ai, bot, async-job, and RAG search calls
 * inside the sandbox using deterministic seeded latencies, token quotas, and response shapes.
 */
export const evaluateAiMockCall: AiMockHook = (ctx) => {
  if (ctx.service.kind === 'llm') {
    return handleLlmOrEmbed(ctx);
  }
  return handleOtherAiKinds(ctx);
};

// Auto-register hook whenever `@infrasim/sandbox` loads
registerAiMockHook(evaluateAiMockCall);
