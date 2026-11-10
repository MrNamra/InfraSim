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
      position: { x: 64, y: 176 },
      config: {
        instances: 1,
        operations: {},
      },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      position: { x: 320, y: 176 },
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
      position: { x: 592, y: 176 },
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
      position: { x: 864, y: 176 },
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
      position: { x: 288, y: 176 },
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
      position: { x: 528, y: 176 },
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
      position: { x: 768, y: 176 },
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
      position: { x: 1008, y: 176 },
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

/** Built-in Phase 1 starter architectures (Spec 16 §8: Templates 1–2). */
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
];

/** Returns a starter template by ID, if found. */
export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}
