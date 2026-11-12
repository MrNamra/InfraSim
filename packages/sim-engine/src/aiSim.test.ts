import { createEmptyDesign } from '@infrasim/shared-types';
import { describe, expect, it } from 'vitest';
import { runSimulation } from './engine.js';

describe('T3.11 AI DES simulation integration', () => {
  it('emits two-span (ttft)+(decode) traces, accumulates tokensIn/tokensOut, and enforces TPM quotas', async () => {
    const design = createEmptyDesign('tpl-rag-des', 'RAG DES Integration');
    design.nodes = [
      {
        id: 'client',
        serviceId: 'generic.client',
        label: 'Client',
        position: { x: 0, y: 0 },
        config: { instances: 1, operations: {} },
      },
      {
        id: 'api',
        serviceId: 'aws.ec2',
        label: 'API',
        position: { x: 250, y: 0 },
        config: {
          instances: 2,
          vcpu: 2,
          memoryGb: 4,
          runtimePreset: 'node',
          scriptId: 'scr-rag',
          operations: {},
        },
      },
      {
        id: 'llm',
        serviceId: 'aws.bedrock',
        label: 'LLM',
        position: { x: 500, y: 0 },
        config: {
          instances: 1,
          rateLimit: { tpm: 500_000, maxContextTokens: 128_000, maxOutputTokens: 200 },
          ai: {
            profile: 'balanced',
            capacityMode: 'on-demand',
            slowdownProb: 0,
            outputTokens: { distribution: 'fixed', p50: 140, p95: 140 },
          },
          operations: {},
        },
      },
    ];
    design.edges = [
      {
        id: 'e1',
        from: 'client',
        to: 'api',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
      {
        id: 'e2',
        from: 'api',
        to: 'llm',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
    ];
    design.scenarios = [
      {
        id: 'sc-1',
        name: 'Steady 2 RPS',
        entryNodeId: 'client',
        durationS: 10,
        profile: { kind: 'constant', rps: 2 },
        flows: [
          {
            id: 'f1',
            name: 'POST /chat',
            weight: 1,
            steps: [{ method: 'POST', path: '/chat', bodyBytes: 400 }],
          },
        ],
        chaos: [],
      },
    ];

    const result = await runSimulation(
      {
        design,
        scenarioId: 'sc-1',
        seed: 77,
        callPlans: {
          'scr-rag': {
            scriptId: 'scr-rag',
            cpuMs: { distribution: 'fixed', p50: 3, p95: 3 },
            steps: [
              { kind: 'cpu', ms: 3 },
              { kind: 'call', serviceId: 'aws.bedrock', op: 'InvokeStream', count: 1 },
            ],
            throwProbability: 0,
          },
        },
      },
      () => {},
    );

    const llmCounters = result.counters.perNode.llm!;
    expect(llmCounters.requests).toBeGreaterThan(5);
    expect(llmCounters.tokensIn).toBeGreaterThan(0);
    expect(llmCounters.tokensOut).toBeGreaterThan(0);

    const allSpans = result.traces.flatMap((t) => t.spans);
    expect(allSpans.some((s) => s.operation?.includes('(ttft)') && s.attrs?.phase === 'ttft')).toBe(
      true,
    );
    expect(
      allSpans.some((s) => s.operation?.includes('(decode)') && s.attrs?.phase === 'decode'),
    ).toBe(true);

    // Tight TPM bucket triggers throttled errors under load
    const throttledDesign = structuredClone(design);
    throttledDesign.nodes[2]!.config.rateLimit!.tpm = 500;
    const throttledRun = await runSimulation(
      {
        design: throttledDesign,
        scenarioId: 'sc-1',
        seed: 77,
        callPlans: {
          'scr-rag': {
            scriptId: 'scr-rag',
            cpuMs: { distribution: 'fixed', p50: 3, p95: 3 },
            steps: [
              { kind: 'cpu', ms: 3 },
              { kind: 'call', serviceId: 'aws.bedrock', op: 'Invoke', count: 1 },
            ],
            throwProbability: 0,
          },
        },
      },
      () => {},
    );
    expect(throttledRun.perNode.llm!.errors.throttled ?? 0).toBeGreaterThan(0);
  });
});
