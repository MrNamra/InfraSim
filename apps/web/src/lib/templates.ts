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
];

/** Returns a starter template by ID, if found. */
export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}
