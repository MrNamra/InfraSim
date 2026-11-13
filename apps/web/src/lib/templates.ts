import { createEmptyDesign, type Design } from '@infrasim/shared-types';

export interface StarterTemplate {
  id: string;
  title: string;
  category?: 'starter' | 'network';
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

function buildServerlessApiTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-serverless-api', 'Serverless API');
  d.description =
    'HTTP API Gateway → AWS Lambda function → Amazon DynamoDB on-demand under ramping traffic.';
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
      id: 'gateway',
      serviceId: 'aws.apigw_http',
      label: 'API Gateway (HTTP)',
      position: { x: 384, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 5 },
        operations: {},
      },
    },
    {
      id: 'fn',
      serviceId: 'aws.lambda',
      label: 'Order Handler',
      position: { x: 720, y: 176 },
      config: {
        instances: 10,
        memoryGb: 0.5,
        runtimePreset: 'node',
        cpuMsPerRequest: 8,
        timeoutMs: 5000,
        latency: { distribution: 'lognormal', p50: 12, p95: 35 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.dynamodb',
      label: 'Orders Table',
      position: { x: 1056, y: 176 },
      config: {
        instances: 1,
        readRatio: 0.7,
        latency: { distribution: 'lognormal', p50: 4, p95: 12 },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-client-gw',
      from: 'client',
      to: 'gateway',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-gw-fn',
      from: 'gateway',
      to: 'fn',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-fn-db',
      from: 'fn',
      to: 'db',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-ramp',
      name: 'Ramping traffic',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'ramp', fromRps: 10, toRps: 180 },
      flows: [
        {
          id: 'flow-checkout',
          name: 'POST /checkout',
          weight: 1,
          steps: [{ method: 'POST', path: '/checkout' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildEventPipelineTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-event-pipeline', 'Event-driven order pipeline');
  d.description =
    'ALB → Ingestion API → SQS queue buffering orders for ECS Fargate workers writing to RDS with DLQ fallback.';
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
      label: 'Ingress ALB',
      position: { x: 336, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 6 },
        operations: {},
      },
    },
    {
      id: 'ingest',
      serviceId: 'aws.ec2',
      label: 'Ingest Service',
      position: { x: 624, y: 176 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 4,
        maxInFlightPerInstance: 100,
        latency: { distribution: 'lognormal', p50: 6, p95: 18 },
        operations: {},
      },
    },
    {
      id: 'queue',
      serviceId: 'aws.sqs',
      label: 'Order Queue',
      position: { x: 912, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        operations: {},
      },
    },
    {
      id: 'workers',
      serviceId: 'aws.fargate',
      label: 'Order Processors',
      position: { x: 1200, y: 176 },
      config: {
        instances: 4,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 16,
        maxInFlightPerInstance: 15,
        latency: { distribution: 'lognormal', p50: 20, p95: 55 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      position: { x: 1488, y: 176 },
      config: {
        instances: 1,
        connections: { max: 80 },
        readRatio: 0.25,
        writeLatencyMultiplier: 1.3,
        latency: { distribution: 'lognormal', p50: 8, p95: 25 },
        operations: {},
      },
    },
    {
      id: 'dlq',
      serviceId: 'aws.sqs',
      label: 'Order DLQ',
      position: { x: 1200, y: 352 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
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
      id: 'e-alb-ingest',
      from: 'alb',
      to: 'ingest',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-ingest-queue',
      from: 'ingest',
      to: 'queue',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-queue-workers',
      from: 'queue',
      to: 'workers',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-workers-db',
      from: 'workers',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-workers-dlq',
      from: 'workers',
      to: 'dlq',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 0.01,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-burst',
      name: 'Order rush spike',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'spike', baseRps: 40, peakRps: 260, atS: 5, widthS: 22 },
      flows: [
        {
          id: 'flow-submit',
          name: 'POST /orders',
          weight: 1,
          steps: [{ method: 'POST', path: '/orders' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildMultiAzHaTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-multi-az-ha', 'Multi-AZ HA with AZ outage');
  d.description =
    'ALB balancing across dual-AZ EC2 instances with Multi-AZ RDS failover capability under simulated zone failure.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'grp-az1',
      kind: 'az',
      label: 'Availability Zone us-east-1a',
      provider: 'aws',
      region: 'us-east-1',
      position: { x: 580, y: 80 },
      size: { width: 280, height: 180 },
    },
    {
      id: 'grp-az2',
      kind: 'az',
      label: 'Availability Zone us-east-1b',
      provider: 'aws',
      region: 'us-east-1',
      position: { x: 580, y: 280 },
      size: { width: 280, height: 180 },
    },
  ];
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 48, y: 240 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'Multi-AZ ALB',
      position: { x: 320, y: 240 },
      config: {
        instances: 2,
        latency: { distribution: 'lognormal', p50: 2, p95: 5 },
        operations: {},
      },
    },
    {
      id: 'api_az1',
      serviceId: 'aws.ec2',
      label: 'API Server (AZ-A)',
      parentGroupId: 'grp-az1',
      az: 'us-east-1a',
      position: { x: 620, y: 130 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 8,
        maxInFlightPerInstance: 50,
        latency: { distribution: 'lognormal', p50: 10, p95: 30 },
        operations: {},
      },
    },
    {
      id: 'api_az2',
      serviceId: 'aws.ec2',
      label: 'API Server (AZ-B)',
      parentGroupId: 'grp-az2',
      az: 'us-east-1b',
      position: { x: 620, y: 330 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 8,
        maxInFlightPerInstance: 50,
        latency: { distribution: 'lognormal', p50: 10, p95: 30 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'RDS Multi-AZ',
      position: { x: 960, y: 240 },
      config: {
        instances: 2,
        connections: { max: 100 },
        readRatio: 0.8,
        writeLatencyMultiplier: 1.4,
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
      id: 'e-alb-az1',
      from: 'alb',
      to: 'api_az1',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 0.5,
    },
    {
      id: 'e-alb-az2',
      from: 'alb',
      to: 'api_az2',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 0.5,
    },
    {
      id: 'e-az1-db',
      from: 'api_az1',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-az2-db',
      from: 'api_az2',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-az-failover',
      name: 'AZ-A outage at 10s',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 90 },
      flows: [
        {
          id: 'flow-main',
          name: 'GET /status',
          weight: 1,
          steps: [{ method: 'GET', path: '/status' }],
        },
      ],
      chaos: [
        {
          atS: 10,
          durationS: 15,
          kind: 'kill-instances',
          nodeId: 'api_az1',
          count: 2,
        },
      ],
    },
  ];
  return d;
}

function buildRetryStormTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-retry-storm', 'Retry storm and circuit breaker');
  d.description =
    'Cascading timeout loop between edge API and downstream dependency with retry policy amplifying load.';
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
      position: { x: 336, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 5 },
        operations: {},
      },
    },
    {
      id: 'frontend',
      serviceId: 'aws.ec2',
      label: 'Storefront API',
      position: { x: 624, y: 176 },
      config: {
        instances: 3,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 6,
        maxInFlightPerInstance: 60,
        timeoutMs: 3000,
        latency: { distribution: 'lognormal', p50: 8, p95: 25 },
        operations: {},
      },
    },
    {
      id: 'backend',
      serviceId: 'aws.ec2',
      label: 'Payment Service',
      position: { x: 912, y: 176 },
      config: {
        instances: 1,
        vcpu: 1,
        memoryGb: 2,
        runtimePreset: 'node',
        cpuMsPerRequest: 16,
        maxInFlightPerInstance: 20,
        queue: { maxLength: 30, policy: 'reject' },
        timeoutMs: 2500,
        latency: { distribution: 'lognormal', p50: 25, p95: 80 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Ledger DB',
      position: { x: 1200, y: 176 },
      config: {
        instances: 1,
        connections: { max: 40 },
        readRatio: 0.5,
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
      id: 'e-alb-frontend',
      from: 'alb',
      to: 'frontend',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-frontend-backend',
      from: 'frontend',
      to: 'backend',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
      retry: { max: 3, backoffMs: 200, jitter: true },
    },
    {
      id: 'e-backend-db',
      from: 'backend',
      to: 'db',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-storm',
      name: 'Spike with downstream slowdown',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'spike', baseRps: 30, peakRps: 130, atS: 6, widthS: 20 },
      flows: [
        {
          id: 'flow-pay',
          name: 'POST /pay',
          weight: 1,
          steps: [{ method: 'POST', path: '/pay' }],
        },
      ],
      chaos: [
        {
          atS: 8,
          durationS: 12,
          kind: 'add-latency',
          nodeId: 'backend',
          extraMs: 120,
        },
      ],
    },
  ];
  return d;
}

function buildMultiRegionTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-multi-region', 'Multi-region latency & cost');
  d.description =
    'Route 53 Geolocation routing to regional ALBs and compute in us-east-1 and eu-central-1 with Global DynamoDB replication.';
  d.settings.primaryProvider = 'aws';
  d.nodes = [
    {
      id: 'client_us',
      serviceId: 'generic.client',
      label: 'US Clients',
      position: { x: 48, y: 110 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'client_eu',
      serviceId: 'generic.client',
      label: 'EU Clients',
      position: { x: 48, y: 310 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'dns',
      serviceId: 'aws.route53',
      label: 'Route 53 Geolocation',
      position: { x: 288, y: 210 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        operations: {},
      },
    },
    {
      id: 'alb_us',
      serviceId: 'aws.alb',
      label: 'ALB (us-east-1)',
      region: 'us-east-1',
      position: { x: 576, y: 110 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 6 },
        operations: {},
      },
    },
    {
      id: 'api_us',
      serviceId: 'aws.ec2',
      label: 'API (us-east-1)',
      region: 'us-east-1',
      position: { x: 864, y: 110 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 8,
        latency: { distribution: 'lognormal', p50: 10, p95: 28 },
        operations: {},
      },
    },
    {
      id: 'alb_eu',
      serviceId: 'aws.alb',
      label: 'ALB (eu-central-1)',
      region: 'eu-central-1',
      position: { x: 576, y: 310 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 6 },
        operations: {},
      },
    },
    {
      id: 'api_eu',
      serviceId: 'aws.ec2',
      label: 'API (eu-central-1)',
      region: 'eu-central-1',
      position: { x: 864, y: 310 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 8,
        latency: { distribution: 'lognormal', p50: 10, p95: 28 },
        operations: {},
      },
    },
    {
      id: 'db_global',
      serviceId: 'aws.dynamodb',
      label: 'Global DynamoDB',
      position: { x: 1152, y: 210 },
      config: {
        instances: 1,
        readRatio: 0.8,
        latency: { distribution: 'lognormal', p50: 4, p95: 12 },
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-us-dns',
      from: 'client_us',
      to: 'dns',
      protocol: 'dns',
      port: 53,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-eu-dns',
      from: 'client_eu',
      to: 'dns',
      protocol: 'dns',
      port: 53,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-dns-us',
      from: 'dns',
      to: 'alb_us',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 0.6,
    },
    {
      id: 'e-dns-eu',
      from: 'dns',
      to: 'alb_eu',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 0.4,
    },
    {
      id: 'e-alb-api-us',
      from: 'alb_us',
      to: 'api_us',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-alb-api-eu',
      from: 'alb_eu',
      to: 'api_eu',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-api-db-us',
      from: 'api_us',
      to: 'db_global',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-api-db-eu',
      from: 'api_eu',
      to: 'db_global',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-multi-region',
      name: 'Global concurrent traffic',
      durationS: 30,
      entryNodeId: 'client_us',
      profile: { kind: 'constant', rps: 120 },
      flows: [
        {
          id: 'flow-user',
          name: 'GET /profile',
          weight: 1,
          steps: [{ method: 'GET', path: '/profile' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildPubSubFanoutTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-pubsub-fanout', 'Pub/Sub event fanout');
  d.description =
    'Amazon SNS publishing events across multiple SQS queues to decouple email alerts and analytics processing.';
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
      label: 'API Gateway ALB',
      position: { x: 300, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 2, p95: 5 },
        operations: {},
      },
    },
    {
      id: 'svc',
      serviceId: 'aws.ec2',
      label: 'Order Ingestion API',
      position: { x: 560, y: 176 },
      config: {
        instances: 2,
        vcpu: 2,
        memoryGb: 4,
        runtimePreset: 'node',
        cpuMsPerRequest: 6,
        latency: { distribution: 'lognormal', p50: 8, p95: 22 },
        operations: {},
      },
    },
    {
      id: 'topic',
      serviceId: 'aws.sns',
      label: 'Orders Topic',
      position: { x: 820, y: 176 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 4, p95: 12 },
        operations: {},
      },
    },
    {
      id: 'q_notif',
      serviceId: 'aws.sqs',
      label: 'Notifications Queue',
      position: { x: 1080, y: 100 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        operations: {},
      },
    },
    {
      id: 'q_analytics',
      serviceId: 'aws.sqs',
      label: 'Analytics Queue',
      position: { x: 1080, y: 260 },
      config: {
        instances: 1,
        latency: { distribution: 'lognormal', p50: 5, p95: 15 },
        operations: {},
      },
    },
    {
      id: 'w_notif',
      serviceId: 'aws.fargate',
      label: 'Email Worker',
      position: { x: 1340, y: 100 },
      config: {
        instances: 2,
        vcpu: 1,
        memoryGb: 2,
        runtimePreset: 'node',
        cpuMsPerRequest: 10,
        latency: { distribution: 'lognormal', p50: 15, p95: 45 },
        operations: {},
      },
    },
    {
      id: 'w_analytics',
      serviceId: 'aws.fargate',
      label: 'ETL Ingest Worker',
      position: { x: 1340, y: 260 },
      config: {
        instances: 2,
        vcpu: 1,
        memoryGb: 2,
        runtimePreset: 'node',
        cpuMsPerRequest: 14,
        latency: { distribution: 'lognormal', p50: 20, p95: 60 },
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
      id: 'e-alb-svc',
      from: 'alb',
      to: 'svc',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-svc-topic',
      from: 'svc',
      to: 'topic',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-topic-notif',
      from: 'topic',
      to: 'q_notif',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-topic-analytics',
      from: 'topic',
      to: 'q_analytics',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-notif-worker',
      from: 'q_notif',
      to: 'w_notif',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
    {
      id: 'e-analytics-worker',
      from: 'q_analytics',
      to: 'w_analytics',
      protocol: 'https',
      port: 443,
      callType: 'async',
      weight: 1,
    },
  ];
  d.scenarios = [
    {
      id: 'scenario-fanout',
      name: 'Event fanout load',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 80 },
      flows: [
        {
          id: 'flow-publish',
          name: 'POST /events',
          weight: 1,
          steps: [{ method: 'POST', path: '/events' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildCrossCloudTemplateDesign(): Design {
  const d = createEmptyDesign('tpl-cross-cloud', 'Cross-cloud cost comparison');
  d.description =
    'Equivalent 3-tier architectures running on AWS, GCP, Azure, and OCI side-by-side for cost and latency benchmarking.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'grp-aws',
      kind: 'region',
      label: 'Amazon Web Services (us-east-1)',
      provider: 'aws',
      region: 'us-east-1',
      position: { x: 30, y: 30 },
      size: { width: 1040, height: 160 },
    },
    {
      id: 'grp-gcp',
      kind: 'region',
      label: 'Google Cloud Platform (us-central1)',
      provider: 'gcp',
      region: 'us-central1',
      position: { x: 30, y: 210 },
      size: { width: 1040, height: 160 },
    },
    {
      id: 'grp-azure',
      kind: 'region',
      label: 'Microsoft Azure (eastus)',
      provider: 'azure',
      region: 'eastus',
      position: { x: 30, y: 390 },
      size: { width: 1040, height: 160 },
    },
    {
      id: 'grp-oci',
      kind: 'region',
      label: 'Oracle Cloud Infrastructure (us-ashburn-1)',
      provider: 'oci',
      region: 'us-ashburn-1',
      position: { x: 30, y: 570 },
      size: { width: 1040, height: 160 },
    },
  ];
  d.nodes = [
    // AWS
    {
      id: 'client_aws',
      serviceId: 'generic.client',
      label: 'Client (AWS)',
      parentGroupId: 'grp-aws',
      position: { x: 60, y: 80 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb_aws',
      serviceId: 'aws.alb',
      label: 'AWS ALB',
      parentGroupId: 'grp-aws',
      position: { x: 320, y: 80 },
      config: { instances: 1, latency: { distribution: 'lognormal', p50: 2, p95: 6 }, operations: {} },
    },
    {
      id: 'api_aws',
      serviceId: 'aws.ec2',
      label: 'AWS EC2 API',
      parentGroupId: 'grp-aws',
      position: { x: 580, y: 80 },
      config: { instances: 2, vcpu: 2, memoryGb: 4, runtimePreset: 'node', cpuMsPerRequest: 8, latency: { distribution: 'lognormal', p50: 10, p95: 28 }, operations: {} },
    },
    {
      id: 'db_aws',
      serviceId: 'aws.rds_postgres',
      label: 'AWS RDS Postgres',
      parentGroupId: 'grp-aws',
      position: { x: 840, y: 80 },
      config: { instances: 1, connections: { max: 60 }, latency: { distribution: 'lognormal', p50: 8, p95: 24 }, operations: {} },
    },
    // GCP
    {
      id: 'client_gcp',
      serviceId: 'generic.client',
      label: 'Client (GCP)',
      parentGroupId: 'grp-gcp',
      position: { x: 60, y: 260 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'lb_gcp',
      serviceId: 'gcp.lb_https',
      label: 'GCP HTTPS LB',
      parentGroupId: 'grp-gcp',
      position: { x: 320, y: 260 },
      config: { instances: 1, latency: { distribution: 'lognormal', p50: 2, p95: 6 }, operations: {} },
    },
    {
      id: 'api_gcp',
      serviceId: 'gcp.compute_engine',
      label: 'GCP Compute VM',
      parentGroupId: 'grp-gcp',
      position: { x: 580, y: 260 },
      config: { instances: 2, vcpu: 2, memoryGb: 4, runtimePreset: 'node', cpuMsPerRequest: 8, latency: { distribution: 'lognormal', p50: 10, p95: 28 }, operations: {} },
    },
    {
      id: 'db_gcp',
      serviceId: 'gcp.cloud_sql_postgres',
      label: 'GCP Cloud SQL PG',
      parentGroupId: 'grp-gcp',
      position: { x: 840, y: 260 },
      config: { instances: 1, connections: { max: 60 }, latency: { distribution: 'lognormal', p50: 8, p95: 24 }, operations: {} },
    },
    // Azure
    {
      id: 'client_azure',
      serviceId: 'generic.client',
      label: 'Client (Azure)',
      parentGroupId: 'grp-azure',
      position: { x: 60, y: 440 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'gw_azure',
      serviceId: 'azure.app_gateway',
      label: 'Azure App Gateway',
      parentGroupId: 'grp-azure',
      position: { x: 320, y: 440 },
      config: { instances: 1, latency: { distribution: 'lognormal', p50: 2, p95: 6 }, operations: {} },
    },
    {
      id: 'api_azure',
      serviceId: 'azure.vm',
      label: 'Azure VM API',
      parentGroupId: 'grp-azure',
      position: { x: 580, y: 440 },
      config: { instances: 2, vcpu: 2, memoryGb: 4, runtimePreset: 'node', cpuMsPerRequest: 8, latency: { distribution: 'lognormal', p50: 10, p95: 28 }, operations: {} },
    },
    {
      id: 'db_azure',
      serviceId: 'azure.postgres_flexible',
      label: 'Azure Flexible PG',
      parentGroupId: 'grp-azure',
      position: { x: 840, y: 440 },
      config: { instances: 1, connections: { max: 60 }, latency: { distribution: 'lognormal', p50: 8, p95: 24 }, operations: {} },
    },
    // OCI
    {
      id: 'client_oci',
      serviceId: 'generic.client',
      label: 'Client (OCI)',
      parentGroupId: 'grp-oci',
      position: { x: 60, y: 620 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'lb_oci',
      serviceId: 'oci.load_balancer',
      label: 'OCI Load Balancer',
      parentGroupId: 'grp-oci',
      position: { x: 320, y: 620 },
      config: { instances: 1, latency: { distribution: 'lognormal', p50: 2, p95: 6 }, operations: {} },
    },
    {
      id: 'api_oci',
      serviceId: 'oci.compute',
      label: 'OCI Compute VM',
      parentGroupId: 'grp-oci',
      position: { x: 580, y: 620 },
      config: { instances: 2, vcpu: 2, memoryGb: 4, runtimePreset: 'node', cpuMsPerRequest: 8, latency: { distribution: 'lognormal', p50: 10, p95: 28 }, operations: {} },
    },
    {
      id: 'db_oci',
      serviceId: 'oci.postgres',
      label: 'OCI PostgreSQL',
      parentGroupId: 'grp-oci',
      position: { x: 840, y: 620 },
      config: { instances: 1, connections: { max: 60 }, latency: { distribution: 'lognormal', p50: 8, p95: 24 }, operations: {} },
    },
  ];
  d.edges = [
    // AWS
    { id: 'e-aws-c-alb', from: 'client_aws', to: 'alb_aws', protocol: 'https', port: 443, callType: 'sync', weight: 1 },
    { id: 'e-aws-alb-api', from: 'alb_aws', to: 'api_aws', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'e-aws-api-db', from: 'api_aws', to: 'db_aws', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
    // GCP
    { id: 'e-gcp-c-lb', from: 'client_gcp', to: 'lb_gcp', protocol: 'https', port: 443, callType: 'sync', weight: 1 },
    { id: 'e-gcp-lb-api', from: 'lb_gcp', to: 'api_gcp', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'e-gcp-api-db', from: 'api_gcp', to: 'db_gcp', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
    // Azure
    { id: 'e-az-c-gw', from: 'client_azure', to: 'gw_azure', protocol: 'https', port: 443, callType: 'sync', weight: 1 },
    { id: 'e-az-gw-api', from: 'gw_azure', to: 'api_azure', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'e-az-api-db', from: 'api_azure', to: 'db_azure', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
    // OCI
    { id: 'e-oci-c-lb', from: 'client_oci', to: 'lb_oci', protocol: 'https', port: 443, callType: 'sync', weight: 1 },
    { id: 'e-oci-lb-api', from: 'lb_oci', to: 'api_oci', protocol: 'http', port: 8080, callType: 'sync', weight: 1 },
    { id: 'e-oci-api-db', from: 'api_oci', to: 'db_oci', protocol: 'sql', port: 5432, callType: 'sync', weight: 1 },
  ];
  d.scenarios = [
    {
      id: 'scenario-multi-cloud',
      name: '100 RPS benchmark',
      durationS: 30,
      entryNodeId: 'client_aws',
      profile: { kind: 'constant', rps: 100 },
      flows: [
        {
          id: 'flow-orders',
          name: 'GET /items',
          weight: 1,
          steps: [{ method: 'GET', path: '/items' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetDbUnreachableDesign(): Design {
  const d = createEmptyDesign('tpl-net-db-unreachable', 'My DB is unreachable');
  d.description =
    'EC2 API server cannot connect to RDS PostgreSQL because sg-db lacks an ingress rule.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'vpc-main',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'Main VPC',
      cidr: '10.0.0.0/16',
      position: { x: 256, y: 80 },
      size: { width: 784, height: 320 },
    },
    {
      id: 'sub-pub',
      kind: 'subnet',
      provider: 'aws',
      label: 'Public app',
      cidr: '10.0.1.0/24',
      public: true,
      parentGroupId: 'vpc-main',
      position: { x: 288, y: 144 },
      size: { width: 320, height: 224 },
    },
    {
      id: 'sub-priv',
      kind: 'subnet',
      provider: 'aws',
      label: 'Private DB',
      cidr: '10.0.2.0/24',
      public: false,
      parentGroupId: 'vpc-main',
      position: { x: 672, y: 144 },
      size: { width: 320, height: 224 },
    },
  ];
  d.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      position: { x: 32, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API Server',
      region: 'us-east-1',
      parentGroupId: 'sub-pub',
      position: { x: 336, y: 208 },
      config: { instances: 2, operations: {} },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'PostgreSQL',
      region: 'us-east-1',
      parentGroupId: 'sub-priv',
      position: { x: 720, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-client-api',
      from: 'client',
      to: 'api',
      protocol: 'https',
      port: 443,
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
  d.network = {
    networks: [
      {
        id: 'vpc-main',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'Main VPC',
      },
    ],
    subnets: [
      {
        id: 'sub-pub',
        networkId: 'vpc-main',
        cidr: '10.0.1.0/24',
        routeTableId: 'rt-pub',
        autoAssignPublicIp: true,
        firewallIds: ['nacl-pub'],
      },
      {
        id: 'sub-priv',
        networkId: 'vpc-main',
        cidr: '10.0.2.0/24',
        routeTableId: 'rt-priv',
        autoAssignPublicIp: false,
        firewallIds: ['nacl-priv'],
      },
    ],
    routeTables: [
      {
        id: 'rt-pub',
        routes: [
          { dest: '10.0.0.0/16', target: { kind: 'local' } },
          { dest: '0.0.0.0/0', target: { kind: 'igw' } },
        ],
      },
      {
        id: 'rt-priv',
        routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }],
      },
    ],
    gateways: [{ id: 'igw-main', kind: 'igw', networkId: 'vpc-main' }],
    firewalls: [
      {
        id: 'nacl-pub',
        kind: 'nacl',
        stateful: false,
        attachedTo: { subnetIds: ['sub-pub'] },
        rules: [
          {
            id: 'nacl-pub-in',
            direction: 'ingress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            source: { any: true },
          },
          {
            id: 'nacl-pub-out',
            direction: 'egress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'nacl-priv',
        kind: 'nacl',
        stateful: false,
        attachedTo: { subnetIds: ['sub-priv'] },
        rules: [
          {
            id: 'nacl-priv-in',
            direction: 'ingress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            source: { any: true },
          },
          {
            id: 'nacl-priv-out',
            direction: 'egress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-api',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['api'] },
        rules: [
          {
            id: 'api-in-443',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 443,
            portTo: 443,
            source: { cidr: '0.0.0.0/0' },
          },
          {
            id: 'api-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-db',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['db'] },
        rules: [
          {
            id: 'db-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      {
        nodeId: 'api',
        subnetId: 'sub-pub',
        privateIp: '10.0.1.10',
        publicIp: '198.51.100.10',
        firewallIds: ['sg-api'],
      },
      { nodeId: 'db', subnetId: 'sub-priv', privateIp: '10.0.2.20', firewallIds: ['sg-db'] },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-1',
      name: 'DB reachability check',
      durationS: 10,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 20 },
      flows: [
        { id: 'f-1', name: 'GET /orders', weight: 1, steps: [{ method: 'GET', path: '/orders' }] },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetMissingNatDesign(): Design {
  const d = createEmptyDesign('tpl-net-missing-nat', "Private subnet can't call Stripe");
  d.description =
    'Worker in a private subnet times out calling Stripe API because no NAT gateway or 0.0.0.0/0 route exists.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'vpc-main',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'App VPC',
      cidr: '10.0.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 416, height: 304 },
    },
    {
      id: 'sub-priv',
      kind: 'subnet',
      provider: 'aws',
      label: 'Private worker',
      cidr: '10.0.1.0/24',
      public: false,
      parentGroupId: 'vpc-main',
      position: { x: 80, y: 144 },
      size: { width: 336, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'worker',
      serviceId: 'aws.ec2',
      label: 'Billing Worker',
      region: 'us-east-1',
      parentGroupId: 'sub-priv',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'stripe',
      serviceId: 'generic.internet',
      label: 'Stripe API',
      position: { x: 560, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-worker-stripe',
      from: 'worker',
      to: 'stripe',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      {
        id: 'vpc-main',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'App VPC',
      },
    ],
    subnets: [
      {
        id: 'sub-priv',
        networkId: 'vpc-main',
        cidr: '10.0.1.0/24',
        routeTableId: 'rt-priv',
        autoAssignPublicIp: false,
      },
    ],
    routeTables: [{ id: 'rt-priv', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] }],
    gateways: [],
    firewalls: [
      {
        id: 'sg-worker',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['worker'] },
        rules: [
          {
            id: 'w-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      {
        nodeId: 'worker',
        subnetId: 'sub-priv',
        privateIp: '10.0.1.12',
        firewallIds: ['sg-worker'],
      },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-2',
      name: 'Webhook egress',
      durationS: 10,
      entryNodeId: 'worker',
      profile: { kind: 'constant', rps: 15 },
      flows: [
        {
          id: 'f-1',
          name: 'POST /charges',
          weight: 1,
          steps: [{ method: 'POST', path: '/charges' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetLambdaDynamodbDesign(): Design {
  const d = createEmptyDesign('tpl-net-lambda-dynamodb', "Lambda in a VPC can't call DynamoDB");
  d.description =
    'VPC-attached Lambda function lacks a DynamoDB Gateway/Interface endpoint or NAT egress route.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'vpc-fn',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'Lambda VPC',
      cidr: '10.0.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 416, height: 304 },
    },
    {
      id: 'sub-fn',
      kind: 'subnet',
      provider: 'aws',
      label: 'Private Lambda subnet',
      cidr: '10.0.1.0/24',
      public: false,
      parentGroupId: 'vpc-fn',
      position: { x: 80, y: 144 },
      size: { width: 336, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'fn',
      serviceId: 'aws.lambda',
      label: 'Order Function',
      region: 'us-east-1',
      parentGroupId: 'sub-fn',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'ddb',
      serviceId: 'aws.dynamodb',
      label: 'DynamoDB Orders',
      region: 'us-east-1',
      position: { x: 560, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-fn-ddb',
      from: 'fn',
      to: 'ddb',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      {
        id: 'vpc-fn',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'Lambda VPC',
      },
    ],
    subnets: [
      {
        id: 'sub-fn',
        networkId: 'vpc-fn',
        cidr: '10.0.1.0/24',
        routeTableId: 'rt-fn',
        autoAssignPublicIp: false,
      },
    ],
    routeTables: [{ id: 'rt-fn', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] }],
    gateways: [],
    firewalls: [
      {
        id: 'sg-fn',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['fn'] },
        rules: [
          {
            id: 'fn-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      { nodeId: 'fn', subnetId: 'sub-fn', privateIp: '10.0.1.15', firewallIds: ['sg-fn'] },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-3',
      name: 'Lambda invoke',
      durationS: 10,
      entryNodeId: 'fn',
      profile: { kind: 'constant', rps: 20 },
      flows: [
        { id: 'f-1', name: 'PutItem', weight: 1, steps: [{ method: 'POST', path: '/items' }] },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetPeeringAsymmetricDesign(): Design {
  const d = createEmptyDesign('tpl-net-peering-asymmetric', "Peering that doesn't work");
  d.description =
    'VPC A routes 10.1.0.0/16 via peering, but VPC B lacks the return route back to 10.0.0.0/16.';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'vpc-a',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'VPC A (10.0.0.0/16)',
      cidr: '10.0.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 352, height: 304 },
    },
    {
      id: 'sub-a',
      kind: 'subnet',
      provider: 'aws',
      label: 'App subnet A',
      cidr: '10.0.1.0/24',
      public: false,
      parentGroupId: 'vpc-a',
      position: { x: 80, y: 144 },
      size: { width: 288, height: 208 },
    },
    {
      id: 'vpc-b',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'VPC B (10.1.0.0/16)',
      cidr: '10.1.0.0/16',
      position: { x: 480, y: 80 },
      size: { width: 352, height: 304 },
    },
    {
      id: 'sub-b',
      kind: 'subnet',
      provider: 'aws',
      label: 'DB subnet B',
      cidr: '10.1.1.0/24',
      public: false,
      parentGroupId: 'vpc-b',
      position: { x: 512, y: 144 },
      size: { width: 288, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'app',
      serviceId: 'aws.ec2',
      label: 'App Service',
      region: 'us-east-1',
      parentGroupId: 'sub-a',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'analytics',
      serviceId: 'aws.rds_postgres',
      label: 'Analytics DB',
      region: 'us-east-1',
      parentGroupId: 'sub-b',
      position: { x: 576, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-app-analytics',
      from: 'app',
      to: 'analytics',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      { id: 'vpc-a', provider: 'aws', region: 'us-east-1', cidrs: ['10.0.0.0/16'], name: 'VPC A' },
      { id: 'vpc-b', provider: 'aws', region: 'us-east-1', cidrs: ['10.1.0.0/16'], name: 'VPC B' },
    ],
    subnets: [
      { id: 'sub-a', networkId: 'vpc-a', cidr: '10.0.1.0/24', routeTableId: 'rt-a' },
      { id: 'sub-b', networkId: 'vpc-b', cidr: '10.1.1.0/24', routeTableId: 'rt-b' },
    ],
    routeTables: [
      {
        id: 'rt-a',
        routes: [
          { dest: '10.0.0.0/16', target: { kind: 'local' } },
          { dest: '10.1.0.0/16', target: { kind: 'peering', id: 'peer-a-b' } },
        ],
      },
      {
        id: 'rt-b',
        routes: [{ dest: '10.1.0.0/16', target: { kind: 'local' } }],
      },
    ],
    gateways: [],
    firewalls: [
      {
        id: 'sg-a',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['app'] },
        rules: [
          {
            id: 'a-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-b',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['analytics'] },
        rules: [
          {
            id: 'b-in-5432',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 5432,
            portTo: 5432,
            source: { cidr: '10.0.0.0/16' },
          },
          {
            id: 'b-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [
      { id: 'peer-a-b', a: 'vpc-a', b: 'vpc-b', routedA: true, routedB: false, transitive: false },
    ],
    dnsZones: [],
    endpoints: [],
    attachments: [
      { nodeId: 'app', subnetId: 'sub-a', privateIp: '10.0.1.10', firewallIds: ['sg-a'] },
      { nodeId: 'analytics', subnetId: 'sub-b', privateIp: '10.1.1.20', firewallIds: ['sg-b'] },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-4',
      name: 'Cross-VPC query',
      durationS: 10,
      entryNodeId: 'app',
      profile: { kind: 'constant', rps: 15 },
      flows: [
        {
          id: 'f-1',
          name: 'SELECT report',
          weight: 1,
          steps: [{ method: 'GET', path: '/report' }],
        },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetTimeoutVsRefusedDesign(): Design {
  const d = createEmptyDesign('tpl-net-timeout-vs-refused', 'Timeout vs refused');
  d.description =
    'Compare a firewall drop (ETIMEDOUT) side-by-side against an open firewall with a closed port (ECONNREFUSED).';
  d.settings.primaryProvider = 'aws';
  d.groups = [
    {
      id: 'vpc-cmp',
      kind: 'vpc',
      provider: 'aws',
      region: 'us-east-1',
      label: 'Comparison VPC',
      cidr: '10.0.0.0/16',
      position: { x: 48, y: 48 },
      size: { width: 768, height: 400 },
    },
    {
      id: 'sub-cmp',
      kind: 'subnet',
      provider: 'aws',
      label: 'Shared subnet',
      cidr: '10.0.1.0/24',
      public: false,
      parentGroupId: 'vpc-cmp',
      position: { x: 80, y: 112 },
      size: { width: 704, height: 304 },
    },
  ];
  d.nodes = [
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API Caller',
      region: 'us-east-1',
      parentGroupId: 'sub-cmp',
      position: { x: 128, y: 208 },
      config: { instances: 1, timeoutMs: 3000, operations: {} },
    },
    {
      id: 'db_fw_drop',
      serviceId: 'aws.rds_postgres',
      label: 'Firewalled DB (Drop)',
      region: 'us-east-1',
      parentGroupId: 'sub-cmp',
      position: { x: 528, y: 128 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'svc_closed_port',
      serviceId: 'aws.ec2',
      label: 'Closed Port Svc (8080)',
      region: 'us-east-1',
      parentGroupId: 'sub-cmp',
      position: { x: 528, y: 288 },
      config: {
        instances: 1,
        listeningPorts: [{ protocol: 'tcp', port: 9000 }],
        operations: {},
      },
    },
  ];
  d.edges = [
    {
      id: 'e-timeout',
      from: 'api',
      to: 'db_fw_drop',
      protocol: 'sql',
      port: 5432,
      callType: 'sync',
      weight: 1,
    },
    {
      id: 'e-refused',
      from: 'api',
      to: 'svc_closed_port',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      {
        id: 'vpc-cmp',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'Comparison VPC',
      },
    ],
    subnets: [{ id: 'sub-cmp', networkId: 'vpc-cmp', cidr: '10.0.1.0/24', routeTableId: 'rt-cmp' }],
    routeTables: [{ id: 'rt-cmp', routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }] }],
    gateways: [],
    firewalls: [
      {
        id: 'sg-caller',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['api'] },
        rules: [
          {
            id: 'c-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-fw-drop',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['db_fw_drop'] },
        rules: [
          {
            id: 'd-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
      {
        id: 'sg-open-port-closed',
        kind: 'sg',
        stateful: true,
        attachedTo: { nodeIds: ['svc_closed_port'] },
        rules: [
          {
            id: 's-in-8080',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 8080,
            portTo: 8080,
            source: { firewallId: 'sg-caller' },
          },
          {
            id: 's-egr',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      { nodeId: 'api', subnetId: 'sub-cmp', privateIp: '10.0.1.10', firewallIds: ['sg-caller'] },
      {
        nodeId: 'db_fw_drop',
        subnetId: 'sub-cmp',
        privateIp: '10.0.1.20',
        firewallIds: ['sg-fw-drop'],
      },
      {
        nodeId: 'svc_closed_port',
        subnetId: 'sub-cmp',
        privateIp: '10.0.1.30',
        firewallIds: ['sg-open-port-closed'],
      },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-5',
      name: 'Timeout vs Refused',
      durationS: 8,
      entryNodeId: 'api',
      profile: { kind: 'constant', rps: 20 },
      flows: [
        { id: 'f-1', name: 'GET /probe', weight: 1, steps: [{ method: 'GET', path: '/probe' }] },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetGcpTagMismatchDesign(): Design {
  const d = createEmptyDesign('tpl-net-gcp-tag-mismatch', 'GCP tag mismatch');
  d.description =
    'GCP VPC firewall rule targets network tag "web", while the Compute Engine instance carries tag "api".';
  d.settings.primaryProvider = 'gcp';
  d.groups = [
    {
      id: 'vpc-gcp',
      kind: 'vpc',
      provider: 'gcp',
      label: 'Shared GCP VPC',
      cidr: '10.128.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 704, height: 304 },
    },
    {
      id: 'sub-gcp',
      kind: 'subnet',
      provider: 'gcp',
      region: 'us-central1',
      label: 'us-central1 subnet',
      cidr: '10.128.1.0/24',
      public: false,
      parentGroupId: 'vpc-gcp',
      position: { x: 80, y: 144 },
      size: { width: 640, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'lb',
      serviceId: 'gcp.lb_https',
      label: 'HTTPS LB',
      region: 'us-central1',
      parentGroupId: 'sub-gcp',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'gce_api',
      serviceId: 'gcp.compute_engine',
      label: 'Backend VM',
      region: 'us-central1',
      parentGroupId: 'sub-gcp',
      position: { x: 480, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-lb-gce',
      from: 'lb',
      to: 'gce_api',
      protocol: 'http',
      port: 8080,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      { id: 'vpc-gcp', provider: 'gcp', global: true, cidrs: ['10.128.0.0/16'], name: 'GCP VPC' },
    ],
    subnets: [
      {
        id: 'sub-gcp',
        networkId: 'vpc-gcp',
        cidr: '10.128.1.0/24',
        regional: true,
        routeTableId: 'rt-gcp',
      },
    ],
    routeTables: [{ id: 'rt-gcp', routes: [{ dest: '10.128.0.0/16', target: { kind: 'local' } }] }],
    gateways: [],
    firewalls: [
      {
        id: 'fw-allow-web',
        kind: 'gcp-fw',
        stateful: true,
        attachedTo: { tags: ['web'] },
        rules: [
          {
            id: 'allow-web-8080',
            direction: 'ingress',
            action: 'allow',
            priority: 100,
            protocol: 'tcp',
            portFrom: 8080,
            portTo: 8080,
            source: { cidr: '10.128.0.0/16' },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      {
        nodeId: 'lb',
        subnetId: 'sub-gcp',
        privateIp: '10.128.1.10',
        firewallIds: [],
        tags: ['lb'],
      },
      {
        nodeId: 'gce_api',
        subnetId: 'sub-gcp',
        privateIp: '10.128.1.20',
        firewallIds: [],
        tags: ['api'],
      },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-6',
      name: 'GCP tag traffic',
      durationS: 10,
      entryNodeId: 'lb',
      profile: { kind: 'constant', rps: 20 },
      flows: [
        { id: 'f-1', name: 'GET /health', weight: 1, steps: [{ method: 'GET', path: '/health' }] },
      ],
      chaos: [],
    },
  ];
  return d;
}

function buildNetAzurePrivateDnsDesign(): Design {
  const d = createEmptyDesign(
    'tpl-net-azure-private-dns',
    'Azure private endpoint resolves to public IP',
  );
  d.description =
    'Azure VM uses a Private Endpoint for Azure SQL, but privatelink.database.windows.net is not linked to the VNet.';
  d.settings.primaryProvider = 'azure';
  d.groups = [
    {
      id: 'vnet-app',
      kind: 'vpc',
      provider: 'azure',
      region: 'eastus',
      label: 'App VNet',
      cidr: '10.10.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 416, height: 304 },
    },
    {
      id: 'sub-az-app',
      kind: 'subnet',
      provider: 'azure',
      region: 'eastus',
      label: 'App subnet',
      cidr: '10.10.1.0/24',
      public: false,
      parentGroupId: 'vnet-app',
      position: { x: 80, y: 144 },
      size: { width: 336, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'az_vm',
      serviceId: 'azure.vm',
      label: 'App VM',
      region: 'eastus',
      parentGroupId: 'sub-az-app',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'az_sql',
      serviceId: 'azure.sql_db',
      label: 'Azure SQL DB',
      region: 'eastus',
      position: { x: 560, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-vm-sql',
      from: 'az_vm',
      to: 'az_sql',
      protocol: 'sql',
      port: 1433,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      {
        id: 'vnet-app',
        provider: 'azure',
        region: 'eastus',
        cidrs: ['10.10.0.0/16'],
        name: 'App VNet',
      },
    ],
    subnets: [
      {
        id: 'sub-az-app',
        networkId: 'vnet-app',
        cidr: '10.10.1.0/24',
        routeTableId: 'rt-az-app',
        firewallIds: ['nsg-az-app'],
      },
    ],
    routeTables: [
      {
        id: 'rt-az-app',
        routes: [
          { dest: '10.10.0.0/16', target: { kind: 'local' } },
          { dest: '0.0.0.0/0', target: { kind: 'endpoint', id: 'ep-az-sql' } },
        ],
      },
    ],
    gateways: [],
    firewalls: [
      {
        id: 'nsg-az-app',
        kind: 'nsg',
        stateful: true,
        attachedTo: { subnetIds: ['sub-az-app'] },
        rules: [
          {
            id: 'az-out',
            direction: 'egress',
            action: 'allow',
            priority: 100,
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [
      {
        id: 'z-az-sql',
        name: 'privatelink.database.windows.net',
        private: true,
        networkIds: [],
        records: [{ name: 'az_sql', type: 'A', value: '10.10.1.250' }],
      },
    ],
    endpoints: [
      {
        id: 'ep-az-sql',
        networkId: 'vnet-app',
        subnetId: 'sub-az-app',
        serviceId: 'azure.sql_db',
        privateDns: true,
      },
    ],
    attachments: [
      { nodeId: 'az_vm', subnetId: 'sub-az-app', privateIp: '10.10.1.10', firewallIds: [] },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-7',
      name: 'Azure SQL lookup',
      durationS: 10,
      entryNodeId: 'az_vm',
      profile: { kind: 'constant', rps: 15 },
      flows: [{ id: 'f-1', name: 'SELECT 1', weight: 1, steps: [{ method: 'GET', path: '/db' }] }],
      chaos: [],
    },
  ];
  return d;
}

function buildNetOciServiceGatewayDesign(): Design {
  const d = createEmptyDesign('tpl-net-oci-service-gateway', 'OCI private bucket access');
  d.description =
    'Compute instance in an OCI private subnet tries to reach Object Storage without a Service Gateway endpoint route.';
  d.settings.primaryProvider = 'oci';
  d.groups = [
    {
      id: 'vcn-main',
      kind: 'vpc',
      provider: 'oci',
      region: 'us-ashburn-1',
      label: 'OCI VCN',
      cidr: '10.20.0.0/16',
      position: { x: 48, y: 80 },
      size: { width: 416, height: 304 },
    },
    {
      id: 'sub-oci-priv',
      kind: 'subnet',
      provider: 'oci',
      region: 'us-ashburn-1',
      label: 'Private OCI subnet',
      cidr: '10.20.1.0/24',
      public: false,
      parentGroupId: 'vcn-main',
      position: { x: 80, y: 144 },
      size: { width: 336, height: 208 },
    },
  ];
  d.nodes = [
    {
      id: 'oci_vm',
      serviceId: 'oci.compute',
      label: 'OCI Compute',
      region: 'us-ashburn-1',
      parentGroupId: 'sub-oci-priv',
      position: { x: 144, y: 208 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'oci_bucket',
      serviceId: 'oci.object_storage',
      label: 'Object Storage Bucket',
      region: 'us-ashburn-1',
      position: { x: 560, y: 208 },
      config: { instances: 1, operations: {} },
    },
  ];
  d.edges = [
    {
      id: 'e-oci-bucket',
      from: 'oci_vm',
      to: 'oci_bucket',
      protocol: 'https',
      port: 443,
      callType: 'sync',
      weight: 1,
    },
  ];
  d.network = {
    networks: [
      {
        id: 'vcn-main',
        provider: 'oci',
        region: 'us-ashburn-1',
        cidrs: ['10.20.0.0/16'],
        name: 'OCI VCN',
      },
    ],
    subnets: [
      {
        id: 'sub-oci-priv',
        networkId: 'vcn-main',
        cidr: '10.20.1.0/24',
        regional: true,
        routeTableId: 'rt-oci-priv',
        firewallIds: ['oci-sl-priv'],
      },
    ],
    routeTables: [
      { id: 'rt-oci-priv', routes: [{ dest: '10.20.0.0/16', target: { kind: 'local' } }] },
    ],
    gateways: [],
    firewalls: [
      {
        id: 'oci-sl-priv',
        kind: 'oci-sl',
        stateful: true,
        attachedTo: { subnetIds: ['sub-oci-priv'] },
        rules: [
          {
            id: 'oci-out-all',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { any: true },
          },
        ],
      },
    ],
    peerings: [],
    dnsZones: [],
    endpoints: [],
    attachments: [
      { nodeId: 'oci_vm', subnetId: 'sub-oci-priv', privateIp: '10.20.1.10', firewallIds: [] },
    ],
  };
  d.scenarios = [
    {
      id: 'sc-net-8',
      name: 'OCI bucket upload',
      durationS: 10,
      entryNodeId: 'oci_vm',
      profile: { kind: 'constant', rps: 15 },
      flows: [
        { id: 'f-1', name: 'PutObject', weight: 1, steps: [{ method: 'PUT', path: '/backup' }] },
      ],
      chaos: [],
    },
  ];
  return d;
}

/** Built-in Phase 1 starter architectures, Phase 3 RAG template, and Phase 4 networking lessons. */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'tpl-3tier',
    title: 'Simple 3-tier web app',
    category: 'starter',
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
    category: 'starter',
    summary: 'Read-heavy API protected by ElastiCache Redis in front of a tight PostgreSQL pool.',
    lesson:
      'Redis absorbs 85% of reads so PostgreSQL (12 connections, 45 ms p50) stays cool at 400 req/s. Lower the cache hit ratio to 0% to see connection-pool starvation.',
    topologySummary: 'Client → ALB → API (4×) → Redis (85% hit) → PostgreSQL (12 conn)',
    scenarioSummary: 'Constant 400 req/s · 30 s',
    design: buildAddCacheTemplateDesign(),
  },
  {
    id: 'tpl-serverless-api',
    title: 'Serverless API',
    category: 'starter',
    summary: 'HTTP API Gateway triggering auto-scaling Lambda functions backed by DynamoDB on-demand.',
    lesson:
      'Observe sub-millisecond gateway dispatch, Lambda concurrency scaling under burst, and zero idle costs when traffic ceases.',
    topologySummary: 'Client → API Gateway (HTTP) → Lambda (10×) → DynamoDB (On-Demand)',
    scenarioSummary: 'Ramp 10 → 180 req/s · 30 s',
    design: buildServerlessApiTemplateDesign(),
  },
  {
    id: 'tpl-event-pipeline',
    title: 'Event-driven order pipeline',
    category: 'starter',
    summary: 'Ingestion API and SQS queue buffering order bursts for ECS Fargate workers and DLQ.',
    lesson:
      'Under sudden ingest surges, SQS absorbs excess requests preventing database saturation; observe worker queue draining and DLQ isolation.',
    topologySummary: 'Client → ALB → Ingest API → SQS Queue → ECS Fargate (4×) → RDS Postgres + DLQ',
    scenarioSummary: 'Spike 40 → 260 req/s · 30 s',
    design: buildEventPipelineTemplateDesign(),
  },
  {
    id: 'tpl-multi-az-ha',
    title: 'Multi-AZ HA with AZ outage',
    category: 'starter',
    summary: 'ALB balancing across dual-AZ EC2 instances with Multi-AZ RDS failover capability under simulated zone failure.',
    lesson:
      'Inject an AZ outage at 10s: watch ALB shift 100% of requests to AZ-B with zero dropped requests while maintaining healthy response times.',
    topologySummary: 'Client → Multi-AZ ALB → AZ-A API + AZ-B API → RDS Multi-AZ',
    scenarioSummary: 'Constant 90 req/s · 30 s (AZ-A outage at 10s)',
    design: buildMultiAzHaTemplateDesign(),
  },
  {
    id: 'tpl-retry-storm',
    title: 'Retry storm & circuit breaker',
    category: 'starter',
    summary: 'Cascading timeout loop between edge API and downstream dependency with retry policy amplifying load.',
    lesson:
      'Downstream slowdown causes upstream retries, amplifying load 3x until queue overflows. Enable the edge circuit breaker to fail fast and recover.',
    topologySummary: 'Client → ALB → Storefront API → Payment Svc (Retries ×3) → Ledger DB',
    scenarioSummary: 'Spike 30 → 130 req/s · 30 s (120ms latency injection at 8s)',
    design: buildRetryStormTemplateDesign(),
  },
  {
    id: 'tpl-rag-chatbot',
    title: 'RAG chatbot',
    category: 'starter',
    summary:
      'Embeddings + vector search + streaming LLM pipeline with TPM quota and idle timeout modeling.',
    lesson:
      'Compare sub-second embedding + retrieval hops against multi-second LLM TTFT + decode spans, and watch TPM quota 429s appear as RPS grows.',
    topologySummary: 'Client → ALB → Chat API → Embed + Vector Search → LLM (120k TPM)',
    scenarioSummary: 'Constant 10 req/s · 30 s',
    design: buildRagChatbotTemplateDesign(),
  },
  {
    id: 'tpl-pubsub-fanout',
    title: 'Pub/Sub event fanout',
    category: 'starter',
    summary:
      'Amazon SNS publishing events across multiple SQS queues to decouple email alerts and analytics processing.',
    lesson:
      'Publishing once to a topic fans out concurrently to independent queues without coupling ingest latency to slow backend workers.',
    topologySummary: 'Client → ALB → Ingest API → SNS Topic → SQS Queues → Fargate Workers',
    scenarioSummary: 'Constant 80 req/s · 30 s',
    design: buildPubSubFanoutTemplateDesign(),
  },
  {
    id: 'tpl-net-db-unreachable',
    title: 'My DB is unreachable',
    category: 'network',
    summary: 'AWS API server cannot connect to RDS PostgreSQL because sg-db lacks an inbound rule.',
    lesson:
      'Goal: Open Reachability dock, inspect SG_NO_INGRESS, apply the least-privilege SG-to-SG ingress patch, and re-run to confirm SQL queries succeed.',
    topologySummary: 'Client → EC2 API (Public) ✖ RDS PostgreSQL (Private · Missing SG ingress)',
    scenarioSummary: 'Constant 20 req/s · 10 s',
    design: buildNetDbUnreachableDesign(),
  },
  {
    id: 'tpl-net-missing-nat',
    title: "Private subnet can't call Stripe",
    category: 'network',
    summary: 'Private billing worker tries to call Stripe over HTTPS without a NAT Gateway route.',
    lesson:
      'Goal: Inspect NO_NAT on the outbound edge and apply the fix creating a public NAT Gateway plus 0.0.0.0/0 route.',
    topologySummary: 'Billing Worker (Private subnet) ✖ Stripe API (HTTPS 443)',
    scenarioSummary: 'Constant 15 req/s · 10 s',
    design: buildNetMissingNatDesign(),
  },
  {
    id: 'tpl-net-lambda-dynamodb',
    title: "Lambda in a VPC can't call DynamoDB",
    category: 'network',
    summary:
      'VPC-attached AWS Lambda function lacks a DynamoDB VPC Endpoint in its private subnet.',
    lesson:
      'Goal: Inspect ENDPOINT_MISSING and apply the VPC Endpoint + route table patch instead of exposing the subnet publicly.',
    topologySummary: 'Order Lambda (Private VPC subnet) ✖ DynamoDB (Missing endpoint)',
    scenarioSummary: 'Constant 20 req/s · 10 s',
    design: buildNetLambdaDynamodbDesign(),
  },
  {
    id: 'tpl-net-peering-asymmetric',
    title: "Peering that doesn't work",
    category: 'network',
    summary: 'VPC peering link is routed from VPC A to VPC B, but VPC B lacks a return route.',
    lesson:
      'Goal: Trace asymmetric routing (MISSING_RETURN_ROUTE) on the peering hop and apply the symmetric return route on VPC B.',
    topologySummary: 'App (VPC A 10.0/16) ✖ Analytics DB (VPC B 10.1/16 · One-way route)',
    scenarioSummary: 'Constant 15 req/s · 10 s',
    design: buildNetPeeringAsymmetricDesign(),
  },
  {
    id: 'tpl-net-timeout-vs-refused',
    title: 'Timeout vs refused',
    category: 'network',
    summary: 'Side-by-side comparison of firewall drop (ETIMEDOUT) and closed port (ECONNREFUSED).',
    lesson:
      'Goal: Run the simulation and compare ETIMEDOUT vs ECONNREFUSED in Logs dock, then apply both fixes cleanly.',
    topologySummary: 'API → Firewalled DB (SG drop) + Closed Port Svc (Port 8080 closed)',
    scenarioSummary: 'Constant 20 req/s · 8 s',
    design: buildNetTimeoutVsRefusedDesign(),
  },
  {
    id: 'tpl-net-gcp-tag-mismatch',
    title: 'GCP tag mismatch',
    category: 'network',
    summary: 'GCP VPC firewall rule targets tag "web" while the Compute VM only carries tag "api".',
    lesson:
      'Goal: Inspect GCP_FW_DENY, preview the tag alignment patch, and apply it so HTTPS LB traffic reaches the backend VM.',
    topologySummary: 'HTTPS LB → Backend VM (GCP tag: api, rule expects web)',
    scenarioSummary: 'Constant 20 req/s · 10 s',
    design: buildNetGcpTagMismatchDesign(),
  },
  {
    id: 'tpl-net-azure-private-dns',
    title: 'Azure private endpoint resolves to public IP',
    category: 'network',
    summary:
      'Azure Private Endpoint exists for SQL DB, but its private DNS zone is not linked to the VNet.',
    lesson:
      'Goal: Inspect PRIVATE_DNS_MISSING and link privatelink.database.windows.net to App VNet.',
    topologySummary: 'App VM (Azure VNet) ✖ Azure SQL DB (Private DNS unlinked)',
    scenarioSummary: 'Constant 15 req/s · 10 s',
    design: buildNetAzurePrivateDnsDesign(),
  },
  {
    id: 'tpl-net-oci-service-gateway',
    title: 'OCI private bucket access',
    category: 'network',
    summary: 'Private OCI Compute instance needs a Service Gateway route to reach Object Storage.',
    lesson:
      'Goal: Inspect ENDPOINT_MISSING and apply the OCI Service Gateway endpoint + route table patch.',
    topologySummary: 'OCI Compute (Private subnet) ✖ Object Storage (Missing Service GW)',
    scenarioSummary: 'Constant 15 req/s · 10 s',
    design: buildNetOciServiceGatewayDesign(),
  },
  {
    id: 'tpl-multi-region',
    title: 'Multi-region latency & cost',
    category: 'starter',
    summary: 'Route 53 DNS directing US and EU traffic to localized regional compute with Global DynamoDB replication.',
    lesson:
      'Compare regional p50 latency (<30ms) against cross-ocean traffic, while evaluating inter-region data transfer replication costs.',
    topologySummary: 'US & EU Clients → Route 53 → Regional ALBs/APIs → Global DynamoDB',
    scenarioSummary: 'Constant 120 req/s · 30 s',
    design: buildMultiRegionTemplateDesign(),
  },
  {
    id: 'tpl-cross-cloud',
    title: 'Cross-cloud cost comparison',
    category: 'starter',
    summary: 'Equivalent 3-tier architectures running side-by-side on AWS, GCP, Azure, and OCI.',
    lesson:
      'Compare total monthly cost and p95 latency across AWS, GCP, Azure, and OCI under identical 100 req/s application workloads.',
    topologySummary: 'AWS vs GCP vs Azure vs OCI (100 req/s parallel benchmark)',
    scenarioSummary: 'Constant 100 req/s · 30 s',
    design: buildCrossCloudTemplateDesign(),
  },
];

/** Returns a starter template by ID, if found. */
export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}
