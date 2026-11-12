import { createEmptyDesign, type SimulationResult } from '@infrasim/shared-types';
import { describe, expect, it } from 'vitest';
import { estimateMonthlyCost } from './estimator.js';

describe('T3.11 AI token & provisioned capacity cost estimation', () => {
  it('bills simulated tokens using manual $/1M rates and marks unpriced provisioned units unavailable', () => {
    const design = createEmptyDesign('cost-ai', 'AI Cost Test');
    design.nodes = [
      {
        id: 'llm',
        serviceId: 'aws.bedrock',
        label: 'LLM',
        position: { x: 100, y: 100 },
        config: {
          instances: 1,
          ai: { profile: 'balanced', capacityMode: 'on-demand' },
          pricing: {
            manualInputPricePer1M: 3,
            manualOutputPricePer1M: 15,
          },
          operations: {},
        },
      },
    ];
    design.scenarios = [
      {
        id: 'sc-1',
        name: '10s',
        entryNodeId: 'llm',
        durationS: 10,
        profile: { kind: 'constant', rps: 10 },
        flows: [],
        chaos: [],
      },
    ];

    const simResult: SimulationResult = {
      runId: 'r-ai',
      seed: 1,
      durationS: 10,
      scaled: null,
      summary: {
        totalRequests: 100,
        success: 100,
        errors: {},
        p50: 500,
        p95: 800,
        p99: 1000,
        throughputRps: 10,
      },
      perNode: {},
      series: { bucketSizeS: 1, buckets: [] },
      traces: [],
      counters: {
        perNode: {
          llm: {
            requests: 100,
            instanceSeconds: 10,
            bytesIn: 10_000,
            bytesOut: 20_000,
            readUnits: 0,
            writeUnits: 0,
            gbSeconds: 0,
            tokensIn: 5_000,
            tokensOut: 20_000,
          },
        },
        perEdge: {},
      },
      insights: [],
    };

    const report = estimateMonthlyCost(design, simResult, null);
    const llmCost = report.perNode.llm!;
    expect(llmCost.subtotal).toBeGreaterThan(0);
    expect(llmCost.lines.some((l) => l.dimension === 'input tokens' && l.source === 'manual')).toBe(
      true,
    );
    expect(
      llmCost.lines.some((l) => l.dimension === 'output tokens' && l.source === 'manual'),
    ).toBe(true);

    // Provisioned mode without manual hourly price yields "price unavailable"
    const provDesign = structuredClone(design);
    provDesign.nodes[0]!.config.ai = {
      profile: 'balanced',
      capacityMode: 'provisioned',
      provisionedUnits: 2,
    };
    delete provDesign.nodes[0]!.config.pricing;
    const provReport = estimateMonthlyCost(provDesign, simResult, null);
    expect(provReport.perNode.llm!.lines[0]?.source).toBe('unavailable');
    expect(provReport.perNode.llm!.lines[0]?.note).toContain('price unavailable');
  });
});
