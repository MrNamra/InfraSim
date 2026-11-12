import { createEmptyDesign, type Design } from '@infrasim/shared-types';

export interface StarterTemplate {
  id: string;
  title: string;
  summary: string;
  lesson: string;
  topologySummary: string;
  scenarioSummary: string;
  design: Design;
}

function buildThreeTierTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-3tier', 'Simple 3-tier web app');
  d.description = 'ALB → single-instance EC2 API → RDS PostgreSQL under a spike profile.';
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 48, y: 176 },
      config: {
        instances: 1,
        operations: {},
      },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      position: { x: 400, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 8 },
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API Server',
      position: { x: 752, y: 176 },
      config: {
        instances: 1,
        vcpu: 1,
        memoryGb: 2,
        cluster: false,
        runtimePreset: 'node',
        cpuMsPerRequest: 10,
        maxInFlightPerInstance: 20,
        queue: { maxLength: 50, policy: 'reject' },
        timeoutMs: 3000,
        latency: { distribution: 'lognormal', p50: 15, p95: 45 },
        errorRate: 0.0005,
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'PostgreSQL',
      position: { x: 1104, y: 176 },
      config: {
        instances: 1,
        connections: { max: 40 },
        readRatio: 0.85,
        writeLatencyMultiplier: 1.5,
        connectionWaitMs: 500,
        latency: { distribution: 'lognormal', p50: 8, p95: 25 },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-client-alb',
      from: 'client',
      to: 'alb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-alb-api',
      from: 'alb',
      to: 'api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-api-db',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-spike',
      name: 'Traffic spike',
      durationS: 30,
      entryNodeId: 'client',
      profile: {
        kind: 'spike',
        baseRps: 40,
        peakRps: 150,
        atS: 4,
        widthS: 26,
      },
      flows: [
        {
          id: 'flow-orders',
          name: 'GET /orders',
          weight: 1,
          steps: [{ method: 'GET', path: '/orders' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildAddCacheTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-cache', 'Add a cache');
  d.description = 'Read-through Redis cache shielding PostgreSQL from 400 RPS read traffic.';
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 48, y: 176 },
      config: {
        instances: 1,
        operations: {},
      },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      position: { x: 400, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 6 },
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Read API',
      position: { x: 752, y: 176 },
      config: {
        instances: 4,
        vcpu: 4,
        memoryGb: 8,
        cluster: true,
        runtimePreset: 'node',
        cpuMsPerRequest: 2,
        maxInFlightPerInstance: 100,
        queue: { maxLength: 500, policy: 'reject' },
        timeoutMs: 3000,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        errorRate: 0.0002,
        operations: {},
      },
    },
    {
      id: 'cache',
      serviceId: 'aws.elasticache_redis',
      label: 'Redis Cache',
      position: { x: 1104, y: 176 },
      config: {
        instances: 1,
        cacheHitRatio: 0.85,
        maxInFlightPerInstance: 1000,
        latency: { distribution: 'lognormal', p50: 1, p95: 3 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'PostgreSQL',
      position: { x: 1456, y: 176 },
      config: {
        instances: 1,
        connections: { max: 12 },
        readRatio: 0.9,
        writeLatencyMultiplier: 1.5,
        connectionWaitMs: 300,
        latency: { distribution: 'lognormal', p50: 45, p95: 110 },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-client-alb',
      from: 'client',
      to: 'alb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-alb-api',
      from: 'alb',
      to: 'api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-api-cache',
      from: 'api',
      to: 'cache',
      protocol: 'redis',
      port: 6379,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-cache-db',
      from: 'cache',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-read-heavy',
      name: 'Read-heavy 400 RPS',
      durationS: 30,
      entryNodeId: 'client',
      profile: {
        kind: 'constant',
        rps: 400,
      },
      flows: [
        {
          id: 'flow-catalog',
          name: 'GET /catalog/items',
          weight: 1,
          steps: [{ method: 'GET', path: '/catalog/items' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildRagChatbotTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-rag-chatbot', 'RAG chatbot');
  d.description =
    'Client → API → Embeddings → Vector Search → LLM pipeline demonstrating TTFT + decode dominance vs retrieval latency.';
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 48, y: 176 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      position: { x: 352, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 8 },
        lb: {
          algorithm: 'round-robin',
          idleTimeoutMs: 60_000,
        },
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Chat API',
      position: { x: 656, y: 176 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 6,
        maxInFlightPerInstance: 200,
        timeoutMs: 30_000,
        scriptId: 'scr-rag-handler',
        operations: {},
      },
    },
    {
      id: 'embed',
      serviceId: 'aws.bedrock',
      label: 'Embed Model',
      position: { x: 960, y: 80 },
      config: {
        instances: 1,
        ai: { profile: 'embedding', dimensions: 1024 },
        operations: {},
      },
    },
    {
      id: 'vec',
      serviceId: 'aws.bedrock_kb',
      label: 'Vector Search',
      position: { x: 960, y: 272 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 90, p95: 240 },
        ai: {
          topK: 3,
          passages: [
            {
              id: 'rag-1',
              text: 'Use streaming responses so callers see the first token at TTFT rather than waiting full decode time.',
              score: 0.96,
            },
            {
              id: 'rag-2',
              text: 'Cache repeated semantic queries and embeddings to bypass LLM token cost on FAQ traffic.',
              score: 0.91,
            },
            {
              id: 'rag-3',
              text: 'Protect TPM quotas with a queue or model fallback chain when bursts hit HTTP 429.',
              score: 0.86,
            },
          ],
        },
        operations: {},
      },
    },
    {
      id: 'llm',
      serviceId: 'aws.bedrock',
      label: 'LLM Generation',
      position: { x: 1264, y: 176 },
      config: {
        instances: 1,
        rateLimit: { tpm: 120_000, rpm: 120, maxContextTokens: 200_000, maxOutputTokens: 512 },
        ai: {
          profile: 'balanced',
          capacityMode: 'on-demand',
          responseMode: 'template',
          responseShape: 'provider',
          chunkTokens: 4,
        },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-rag-client-alb',
      from: 'client',
      to: 'alb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-rag-alb-api',
      from: 'alb',
      to: 'api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-rag-api-embed',
      from: 'api',
      to: 'embed',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-rag-api-vec',
      from: 'api',
      to: 'vec',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-rag-api-llm',
      from: 'api',
      to: 'llm',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scripts = [
    {
      id: 'scr-rag-handler',
      name: 'rag-chat.ts',
      kind: 'handler',
      language: 'typescript',
      entry: 'handler',
      memoryMb: 256,
      timeoutMs: 15_000,
      env: {},
      source: `import { BedrockRuntimeClient, ConverseStreamCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });

export async function handler(event: any) {
  const question = event?.body ? JSON.parse(event.body)?.q || 'Explain caching' : 'Explain caching';
  await client.send(new InvokeModelCommand({
    modelId: 'embed-mock-v1',
    body: JSON.stringify({ inputText: question }),
  }));
  const ctx = await cloud.call('aws.bedrock_kb', 'Search', { query: question, topK: 3 });
  const streamRes = await client.send(new ConverseStreamCommand({
    modelId: 'llm-balanced-mock',
    messages: [{ role: 'user', content: [{ text: question + ' ' + JSON.stringify(ctx.passages) }] }],
  }));
  let reply = '';
  for await (const chunk of streamRes.stream) {
    if (chunk.contentBlockDelta?.delta?.text) reply += chunk.contentBlockDelta.delta.text;
  }
  return { statusCode: 200, body: JSON.stringify({ reply }) };
}
`,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-rag-chat',
      name: 'RAG steady load',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 10 },
      flows: [
        {
          id: 'flow-ask',
          name: 'POST /chat',
          weight: 1,
          steps: [{ method: 'POST', path: '/chat', bodyBytes: 1024 }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

/** Built-in Phase 1 starter architectures (Spec 16 §8: Templates 1–2) plus Phase 3 RAG template. */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'tpl-3tier',
    title: 'Simple 3-tier web app',
    summary: 'Application Load Balancer in front of a single-core Node.js API and PostgreSQL.',
    lesson:
      'Watch CPU saturation turn the API red under a traffic spike, then scale instances via Why? and re-run to clear queue drops.',
    topologySummary: 'Client → ALB → EC2 API (1× 1 vCPU) → RDS PostgreSQL',
    scenarioSummary: 'Spike 40 → 150 req/s · 30 s',
    design: buildThreeTierTemplateDesign(),
  },
  {
    id: 'tpl-cache',
    title: 'Add a cache',
    summary: 'Read-heavy API protected by ElastiCache Redis in front of a tight PostgreSQL pool.',
    lesson:
      'Redis absorbs 85% of reads so PostgreSQL (12 connections, 45 ms p50) stays cool at 400 req/s. Lower the cache hit ratio to 0% to see connection-pool starvation.',
    topologySummary: 'Client → ALB → API (4×) → Redis (85% hit) → PostgreSQL (12 conn)',
    scenarioSummary: 'Constant 400 req/s · 30 s',
    design: buildAddCacheTemplateDesign(),
  },
  {
    id: 'tpl-rag-chatbot',
    title: 'RAG chatbot',
    summary:
      'Embeddings + vector search + streaming LLM pipeline with TPM quota and idle timeout modeling.',
    lesson:
      'Compare sub-second embedding + retrieval hops against multi-second LLM TTFT + decode spans, and watch TPM quota 429s appear as RPS grows.',
    topologySummary: 'Client → ALB → Chat API → Embed + Vector Search → LLM (120k TPM)',
    scenarioSummary: 'Constant 10 req/s · 30 s',
    design: buildRagChatbotTemplateDesign(),
  },
];

/** Returns a starter template by ID, if found. */
export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}
