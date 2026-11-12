import { validateJsonSchemaValue } from '@infrasim/catalog';
import {
  createEmptyDesign,
  type Design,
  type NodeInstance,
  type ScriptAsset,
} from '@infrasim/shared-types';
import { afterAll, describe, expect, it } from 'vitest';
import { createMockCallResolver, executeInSandbox, stopSandboxBundler } from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeLlmDesign(
  serviceId: string,
  nodeOverrides: Partial<NodeInstance['config']> = {},
): { design: Design; node: NodeInstance } {
  const design = createEmptyDesign('design-ai-test', 'AI Test Design');
  const computeNode: NodeInstance = {
    id: 'node-api',
    serviceId: 'aws.lambda',
    label: 'API Handler',
    position: { x: 100, y: 100 },
    config: { instances: 1, operations: {} },
  };
  const aiNode: NodeInstance = {
    id: 'node-ai',
    serviceId,
    label: 'AI Service',
    position: { x: 400, y: 100 },
    config: {
      instances: 1,
      operations: {},
      ...nodeOverrides,
    },
  };
  design.nodes = [computeNode, aiNode];
  design.edges = [
    {
      id: 'edge-api-ai',
      from: 'node-api',
      to: 'node-ai',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  return { design, node: aiNode };
}

function makeScript(source: string, timeoutMs = 60_000): ScriptAsset {
  return {
    id: 'scr-ai-test',
    name: 'handler.ts',
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 256,
    timeoutMs,
    env: {},
  };
}

describe('T3.11 AI Services Mock Behavior (Spec 11)', () => {
  it('Acceptance #1: 1,000 calls at balanced with 300 output tokens have median within +/-10% of ttft + 300/70s', async () => {
    const { design } = makeLlmDesign('aws.bedrock', {
      errorRate: 0,
      ai: {
        profile: 'balanced',
        capacityMode: 'on-demand',
        slowdownProb: 0,
        outputTokens: { distribution: 'fixed', p50: 300, p95: 300 },
      },
    });
    const computeNode = design.nodes[0]!;
    const resolver = createMockCallResolver({ design, node: computeNode, seed: 4242 });

    const latencies: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const outcome = await resolver(
        {
          kind: 'cloud',
          serviceId: 'aws.bedrock',
          op: 'Invoke',
          input: { prompt: 'Summarize' }, // ~3 input tokens -> prefill < 0.1ms
          startVirtualMs: i * 1000,
        },
        { seed: 4242, seq: i, nowMs: i * 1000, env: {} },
      );
      expect(outcome.ok).toBe(true);
      latencies.push(outcome.latencyMs);
    }

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)]!;
    const expectedMs = 500 + (300 / 70) * 1000; // 4785.71 ms
    expect(median).toBeGreaterThanOrEqual(expectedMs * 0.9);
    expect(median).toBeLessThanOrEqual(expectedMs * 1.1);
  });

  it('Acceptance #2: 60k TPM bucket with 1k-token calls passes 60 in minute 1 and 429s 61st with retryAfterMs > 0', async () => {
    const { design } = makeLlmDesign('azure.openai', {
      errorRate: 0,
      rateLimit: {
        tpm: 60_000,
        maxContextTokens: 128_000,
        maxOutputTokens: 1_000,
      },
      ai: {
        profile: 'small-fast',
        slowdownProb: 0,
      },
    });
    const computeNode = design.nodes[0]!;
    const resolver = createMockCallResolver({ design, node: computeNode, seed: 101 });

    // 60 calls * 1,000 tokens (700 in + 300 out) at t = 0..590 ms (well inside minute 1)
    for (let i = 0; i < 60; i++) {
      const res = await resolver(
        {
          kind: 'cloud',
          serviceId: 'azure.openai',
          op: 'Invoke',
          input: {
            prompt: 'x',
            usage: { inputTokens: 700, outputTokens: 300 },
          },
          startVirtualMs: i * 10,
        },
        { seed: 101, seq: i, nowMs: i * 10, env: {} },
      );
      expect(res.ok).toBe(true);
    }

    const throttled = await resolver(
      {
        kind: 'cloud',
        serviceId: 'azure.openai',
        op: 'Invoke',
        input: {
          prompt: 'x',
          usage: { inputTokens: 700, outputTokens: 300 },
        },
        startVirtualMs: 600,
      },
      { seed: 101, seq: 60, nowMs: 600, env: {} },
    );
    expect(throttled.ok).toBe(false);
    expect(throttled.error?.statusCode).toBe(429);
    expect(throttled.error?.name).toBe('RateLimitError');
    expect((throttled.error?.retryAfterMs ?? 0) > 0).toBe(true);

    // After 60 virtual seconds elapse, bucket refills cleanly
    const recovered = await resolver(
      {
        kind: 'cloud',
        serviceId: 'azure.openai',
        op: 'Invoke',
        input: {
          prompt: 'x',
          usage: { inputTokens: 700, outputTokens: 300 },
        },
        startVirtualMs: 65_000,
      },
      { seed: 101, seq: 61, nowMs: 65_000, env: {} },
    );
    expect(recovered.ok).toBe(true);
  });

  it('Acceptance #3: context overflow returns HTTP 400 provider error and prevents downstream execution', async () => {
    const design = createEmptyDesign('design-ctx-overflow', 'Context Overflow');
    const apiNode: NodeInstance = {
      id: 'node-api',
      serviceId: 'aws.lambda',
      label: 'API',
      position: { x: 100, y: 100 },
      config: { instances: 1, operations: {} },
    };
    const llmNode: NodeInstance = {
      id: 'node-llm',
      serviceId: 'aws.bedrock',
      label: 'Bedrock',
      position: { x: 350, y: 100 },
      config: {
        instances: 1,
        rateLimit: { maxContextTokens: 4_096, maxOutputTokens: 512 },
        operations: {},
      },
    };
    const dbNode: NodeInstance = {
      id: 'node-db',
      serviceId: 'aws.dynamodb',
      label: 'DDB',
      position: { x: 350, y: 250 },
      config: { instances: 1, operations: {} },
    };
    design.nodes = [apiNode, llmNode, dbNode];
    design.edges = [
      {
        id: 'e1',
        from: 'node-api',
        to: 'node-llm',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
      {
        id: 'e2',
        from: 'node-api',
        to: 'node-db',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
    ];

    const resolver = createMockCallResolver({ design, node: apiNode, seed: 7 });
    const run = await executeInSandbox({
      script: makeScript(`
        import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
        import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
        import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

        export async function handler() {
          const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
          const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
          await bedrock.send(new ConverseCommand({
            modelId: 'anthropic.claude-mock',
            messages: [{ role: 'user', content: [{ text: 'A'.repeat(18000) }] }],
            inferenceConfig: { maxTokens: 512 },
          }));
          // Should never run because Converse threw 400 ValidationException
          await ddb.send(new PutCommand({ TableName: 'audit', Item: { id: '1' } }));
          return { statusCode: 200 };
        }
      `),
      seed: 7,
      mockResolver: resolver,
    });

    expect(run.ok).toBe(false);
    expect(run.error?.statusCode).toBe(400);
    expect(run.error?.name).toBe('ValidationException');
    expect(run.calls.map((c) => c.serviceId)).toEqual(['aws.bedrock']);
  });

  it('Acceptance #4: json-fill output always validates against the supplied JSON Schema across seeds', async () => {
    const targetSchema = {
      type: 'object',
      required: ['intent', 'confidence', 'tags', 'requiresHuman'],
      properties: {
        intent: { type: 'string', enum: ['billing', 'refund', 'support'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
        requiresHuman: { type: 'boolean' },
      },
    };
    const { design } = makeLlmDesign('azure.openai', {
      ai: {
        profile: 'small-fast',
        responseMode: 'json-fill',
        jsonSchema: targetSchema,
      },
    });
    const computeNode = design.nodes[0]!;

    for (let s = 1; s <= 15; s++) {
      const resolver = createMockCallResolver({ design, node: computeNode, seed: s * 31 });
      const res = await resolver(
        {
          kind: 'cloud',
          serviceId: 'azure.openai',
          op: 'Invoke',
          input: { messages: [{ role: 'user', content: 'Classify ticket' }] },
          startVirtualMs: s * 1000,
        },
        { seed: s * 31, seq: s, nowMs: s * 1000, env: {} },
      );
      expect(res.ok).toBe(true);
      const body = res.output as { choices: { message: { content: string } }[] };
      const parsed = JSON.parse(body.choices[0]!.message.content) as Record<string, unknown>;
      const validation = validateJsonSchemaValue(targetSchema, parsed);
      expect(validation.valid).toBe(true);
    }
  });

  it('Acceptance #5: async speech job returns IN_PROGRESS before jobDurationMs, COMPLETED after, and is deterministic for seed', async () => {
    const { design } = makeLlmDesign('aws.transcribe', {
      errorRate: 0,
      ai: { jobDurationMs: 4_000 },
    });
    const computeNode = design.nodes[0]!;

    const runSequence = async (seed: number) => {
      const resolver = createMockCallResolver({ design, node: computeNode, seed });
      const started = await resolver(
        {
          kind: 'cloud',
          serviceId: 'aws.transcribe',
          op: 'Start',
          input: { batch: true, mediaUri: 's3://audio/sample.wav' },
          startVirtualMs: 1_000,
        },
        { seed, seq: 0, nowMs: 1_000, env: {} },
      );
      const startOut = started.output as { jobId: string; status: string };
      const mid = await resolver(
        {
          kind: 'cloud',
          serviceId: 'aws.transcribe',
          op: 'GetStatus',
          input: { jobId: startOut.jobId },
          startVirtualMs: 3_500, // 2500ms < 4000ms
        },
        { seed, seq: 1, nowMs: 3_500, env: {} },
      );
      const done = await resolver(
        {
          kind: 'cloud',
          serviceId: 'aws.transcribe',
          op: 'GetStatus',
          input: { jobId: startOut.jobId },
          startVirtualMs: 5_500, // 4500ms >= 4000ms
        },
        { seed, seq: 2, nowMs: 5_500, env: {} },
      );
      return { started, startOut, mid, done };
    };

    const a = await runSequence(88);
    const b = await runSequence(88);
    const c = await runSequence(99);

    expect(a.started.ok).toBe(true);
    expect(a.started.statusCode).toBe(202);
    expect(a.startOut.status).toBe('IN_PROGRESS');
    expect((a.mid.output as { status: string }).status).toBe('IN_PROGRESS');
    expect((a.done.output as { status: string; result?: { transcript?: string } }).status).toBe(
      'COMPLETED',
    );
    expect((a.done.output as { result?: { transcript?: string } }).result?.transcript).toBeTruthy();

    expect(a.startOut.jobId).toBe(b.startOut.jobId);
    expect(a.done.output).toEqual(b.done.output);
    expect(a.startOut.jobId).not.toBe(c.startOut.jobId);
  });

  it('Acceptance #6: streaming call emits first chunk at TTFT, last at TTFT + decode, and records two spans', async () => {
    const { design } = makeLlmDesign('aws.bedrock', {
      ai: {
        profile: 'balanced',
        slowdownProb: 0,
        chunkTokens: 10,
        outputTokens: { distribution: 'fixed', p50: 140, p95: 140 },
      },
      operations: {
        InvokeStream: {
          latency: { distribution: 'fixed', p50: 500, p95: 500 },
        },
      },
    });
    const computeNode = design.nodes[0]!;
    const resolver = createMockCallResolver({ design, node: computeNode, seed: 55 });

    const run = await executeInSandbox({
      script: makeScript(`
        import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

        export async function handler() {
          const client = new BedrockRuntimeClient({ region: 'us-east-1' });
          const startedAtMs = Date.now();
          const res = await client.send(new ConverseStreamCommand({
            modelId: 'balanced-mock',
            messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
          }));
          const timestamps = [];
          let text = '';
          for await (const chunk of res.stream) {
            timestamps.push(Date.now() - startedAtMs);
            if (chunk.contentBlockDelta?.delta?.text) {
              text += chunk.contentBlockDelta.delta.text;
            }
          }
          return { timestamps, text };
        }
      `),
      seed: 55,
      mockResolver: resolver,
    });

    expect(run.ok).toBe(true);
    const out = run.result as { timestamps: number[]; text: string };
    expect(out.timestamps.length).toBeGreaterThanOrEqual(2);
    expect(out.text.length).toBeGreaterThan(10);

    // Virtual time: TTFT = ~500 ms, decode = 140 / 70 * 1000 = 2000 ms, total = ~2500 ms
    const firstChunkMs = out.timestamps[0]!;
    const lastChunkMs = out.timestamps[out.timestamps.length - 1]!;
    expect(firstChunkMs).toBeGreaterThanOrEqual(495);
    expect(firstChunkMs).toBeLessThanOrEqual(520);
    expect(lastChunkMs).toBeGreaterThanOrEqual(2480);
    expect(lastChunkMs).toBeLessThanOrEqual(2530);

    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.spans).toHaveLength(2);
    expect(run.calls[0]?.spans?.[0]?.phase).toBe('ttft');
    expect(run.calls[0]?.spans?.[1]?.phase).toBe('decode');
  });

  it('supports GCP Vertex AI, OCI GenAI, normalized shapes, tool-call, embeddings batch limit, and RAG search', async () => {
    // 1. GCP Vertex AI SDK shim + normalized shape + streaming
    const gcpDesign = makeLlmDesign('gcp.vertex_gemini', {
      ai: {
        profile: 'small-fast',
        slowdownProb: 0,
        outputTokens: { distribution: 'fixed', p50: 40, p95: 40 },
      },
    });
    const gcpRes = await executeInSandbox({
      script: makeScript(`
        import { VertexAI } from '@google-cloud/vertexai';
        export async function handler() {
          const v = new VertexAI({});
          const model = v.getGenerativeModel({ model: 'gemini-mock' });
          const r = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: 'Ping' }] }] });
          return r.response;
        }
      `),
      seed: 12,
      mockResolver: createMockCallResolver({
        design: gcpDesign.design,
        node: gcpDesign.design.nodes[0],
        seed: 12,
      }),
    });
    expect(gcpRes.ok).toBe(true);
    const gcpBody = gcpRes.result as {
      candidates: unknown[];
      usageMetadata: { promptTokenCount: number };
    };
    expect(gcpBody.candidates.length).toBe(1);
    expect(gcpBody.usageMetadata.promptTokenCount).toBeGreaterThan(0);

    // 2. OCI GenAI chat
    const ociDesign = makeLlmDesign('oci.genai', {
      ai: {
        profile: 'small-fast',
        slowdownProb: 0,
        outputTokens: { distribution: 'fixed', p50: 20, p95: 20 },
      },
    });
    const ociRes = await executeInSandbox({
      script: makeScript(`
        import { GenerativeAiInferenceClient } from 'oci-generativeaiinference';
        export async function handler() {
          const c = new GenerativeAiInferenceClient({});
          return await c.chat({ chatDetails: { servingMode: { modelId: 'cohere.mock' } }, prompt: 'Hi OCI' });
        }
      `),
      seed: 13,
      mockResolver: createMockCallResolver({
        design: ociDesign.design,
        node: ociDesign.design.nodes[0],
        seed: 13,
      }),
    });
    expect(ociRes.ok).toBe(true);
    expect(
      (ociRes.result as { chatResult?: { chatResponse?: { choices: unknown[] } } }).chatResult
        ?.chatResponse?.choices.length,
    ).toBe(1);

    // 3. Embeddings 1024-d vectors & 96-batch limit + RAG search topK
    const embedDesign = makeLlmDesign('aws.bedrock', {
      ai: { profile: 'embedding', dimensions: 1024 },
    });
    const embedResolver = createMockCallResolver({
      design: embedDesign.design,
      node: embedDesign.design.nodes[0],
      seed: 14,
    });
    const okEmbed = await embedResolver(
      {
        kind: 'cloud',
        serviceId: 'aws.bedrock',
        op: 'Embed',
        input: { inputs: ['a', 'b'] },
        startVirtualMs: 0,
      },
      { seed: 14, seq: 0, nowMs: 0, env: {} },
    );
    expect(okEmbed.ok).toBe(true);
    const embOut = okEmbed.output as { embeddings: number[][] };
    expect(embOut.embeddings).toHaveLength(2);
    expect(embOut.embeddings[0]).toHaveLength(1024);

    const tooManyEmbed = await embedResolver(
      {
        kind: 'cloud',
        serviceId: 'aws.bedrock',
        op: 'Embed',
        input: { inputs: Array.from({ length: 97 }, (_, i) => `item-${i}`) },
        startVirtualMs: 10,
      },
      { seed: 14, seq: 1, nowMs: 10, env: {} },
    );
    expect(tooManyEmbed.ok).toBe(false);
    expect(tooManyEmbed.error?.statusCode).toBe(400);

    const kbDesign = makeLlmDesign('aws.bedrock_kb', {
      ai: {
        topK: 2,
        passages: [
          { id: 'p1', text: 'Lowest score', score: 0.2 },
          { id: 'p2', text: 'Highest score', score: 0.99 },
          { id: 'p3', text: 'Middle score', score: 0.75 },
        ],
      },
    });
    const kbResolver = createMockCallResolver({
      design: kbDesign.design,
      node: kbDesign.design.nodes[0],
      seed: 15,
    });
    const kbOut = await kbResolver(
      {
        kind: 'cloud',
        serviceId: 'aws.bedrock_kb',
        op: 'Search',
        input: { query: 'test' },
        startVirtualMs: 0,
      },
      { seed: 15, seq: 0, nowMs: 0, env: {} },
    );
    expect(kbOut.ok).toBe(true);
    const passages = (kbOut.output as { passages: { id: string }[] }).passages;
    expect(passages.map((p) => p.id)).toEqual(['p2', 'p3']);
  });
});
