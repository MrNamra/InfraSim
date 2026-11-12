import { describe, expect, it } from 'vitest';
import { createEmptyDesign, type SimulationResult } from '@infrasim/shared-types';
import { buildExplainSummaryPayload } from './explainer.js';

describe('T6.7 optional LLM explainer summary sanitizer', () => {
  it('excludes all code, env vars, mockEnv, secrets, and fixture payloads using canary checks', () => {
    const design = createEmptyDesign('canary-design', 'Checkout Flow');
    design.nodes = [
      {
        id: 'api',
        serviceId: 'aws.ec2',
        label: 'API Server',
        region: 'us-east-1',
        position: { x: 100, y: 100 },
        config: {
          instances: 2,
          mockEnv: {
            STRIPE_KEY: 'CANARY_NODE_MOCK_ENV_883',
            DB_PASS: 'CANARY_SECRET_TOKEN_555',
          },
          operations: {
            'GET /checkout': {
              responseTemplate: 'CANARY_MOCK_RESPONSE_441',
            },
          },
        },
      },
      {
        id: 'db',
        serviceId: 'aws.rds_postgres',
        label: 'Primary DB',
        position: { x: 300, y: 100 },
        config: {
          instances: 1,
          operations: {},
        },
      },
    ];
    design.scripts = [
      {
        id: 'scr-1',
        name: 'checkout.js',
        kind: 'handler',
        language: 'javascript',
        source: 'const SECRET = "CANARY_CODE_991"; export default () => ({ status: 200 });',
        entry: 'default',
        memoryMb: 128,
        timeoutMs: 250,
        env: {
          INTERNAL_JWT_SECRET: 'CANARY_SCRIPT_ENV_772',
        },
      },
    ];
    design.fixtures = [
      {
        id: 'fix-1',
        name: 'Order payload',
        event: {
          customerToken: 'CANARY_FIXTURE_PAYLOAD_664',
          email: 'alice@example.com',
        },
      },
    ];

    const result: SimulationResult = {
      runId: 'run-canary',
      seed: 42,
      durationS: 30,
      scaled: null,
      perNode: {},
      series: { bucketSizeS: 1, buckets: [] },
      traces: [],
      counters: { perNode: {}, perEdge: {} },
      summary: {
        totalRequests: 1000,
        success: 950,
        errors: { server: 50 },
        p50: 45,
        p95: 320,
        p99: 610,
        throughputRps: 33.3,
      },
      insights: [
        {
          ruleId: 'db-pool-exhausted',
          title: 'Database connection pool exhausted',
          severity: 'critical',
          isRootCause: true,
          nodeIds: ['db'],
          evidence: {
            peakUtilPct: 99,
            secretApiKey: 'CANARY_EVIDENCE_SECRET_339',
          },
          explanation: {
            short: 'Primary DB pool reached 99% utilization.',
            deep: 'Details...',
          },
          fixes: [
            {
              label: 'Add RDS Proxy',
              tradeOff: 'Slight extra monthly cost',
              patch: [],
            },
          ],
        },
      ],
    };

    const payload = buildExplainSummaryPayload({
      design,
      result,
      insights: result.insights,
      monthlyCostUsd: 142.55,
      focusNodeId: 'db',
    });

    const serialized = JSON.stringify(payload);
    for (const canary of [
      'CANARY_CODE_991',
      'CANARY_SCRIPT_ENV_772',
      'CANARY_NODE_MOCK_ENV_883',
      'CANARY_MOCK_RESPONSE_441',
      'CANARY_FIXTURE_PAYLOAD_664',
      'CANARY_SECRET_TOKEN_555',
      'CANARY_EVIDENCE_SECRET_339',
    ]) {
      expect(serialized).not.toContain(canary);
    }

    expect(payload.nodes).toHaveLength(2);
    expect(payload.nodes[0]).toEqual({
      id: 'api',
      serviceId: 'aws.ec2',
      kind: 'compute',
      label: 'API Server',
      instances: 2,
      region: 'us-east-1',
    });
    expect(payload.kpis.p95Ms).toBe(320);
    expect(payload.kpis.errorRate).toBe(0.05);
    expect(payload.kpis.monthlyCostUsd).toBe(142.55);
    expect(payload.insights[0]?.ruleId).toBe('db-pool-exhausted');
    expect(payload.insights[0]?.evidence).toEqual({ peakUtilPct: 99 });
  });
});
