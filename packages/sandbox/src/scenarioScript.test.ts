import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type Scenario,
  type ScriptAsset,
  type SimulationResult,
} from '@infrasim/shared-types';
import {
  applyExtractedScenarioToScenario,
  evaluateScenarioThresholds,
  extractScenarioFromScript,
} from './index.js';

function makeScenarioScript(source: string): ScriptAsset {
  return {
    id: 'sc-script-1',
    name: 'traffic.js',
    kind: 'scenario',
    language: 'javascript',
    source,
    entry: 'default',
    memoryMb: 128,
    timeoutMs: 3000,
    env: {},
  };
}

function makeFakeResult(overrides?: Partial<SimulationResult['summary']>): SimulationResult {
  return {
    runId: 'run-1',
    seed: 42,
    durationS: 30,
    scaled: null,
    summary: {
      totalRequests: 1000,
      success: 995,
      errors: { server: 5 },
      p50: 45,
      p95: 180,
      p99: 320,
      throughputRps: 33.2,
      ...overrides,
    },
    perNode: {},
    series: { bucketSizeS: 1, buckets: [] },
    traces: [],
    counters: { perNode: {}, perEdge: {} },
    insights: [],
  };
}

describe('T3.10 k6-style scenario script extraction & threshold evaluation', () => {
  it('extracts options, weighted flows with thinkTime, checks, and syncs to Scenario', async () => {
    const script = makeScenarioScript(`
      export const options = {
        scenarios: { browse: { rps: 500, durationS: 60, rampUpS: 10 } },
        thresholds: {
          http_req_duration: ['p(95)<300'],
          http_req_failed: ['rate<0.01'],
        },
      };

      export default function () {
        const r = http.get('/products');
        check(r, { 'status is 200': (res) => res.status === 200 });
        sleep(1);
        if (Math.random() < 0.2) {
          http.post('/checkout', { cart: 3 });
        }
      }
    `);

    const extracted = await extractScenarioFromScript({
      script,
      seed: 101,
      iterations: 200,
    });

    expect(extracted.errors).toEqual([]);
    expect(extracted.options.rps).toBe(500);
    expect(extracted.options.durationS).toBe(60);
    expect(extracted.options.rampUpS).toBe(10);
    expect(extracted.options.thresholds).toEqual({
      http_req_duration: ['p(95)<300'],
      http_req_failed: ['rate<0.01'],
    });
    expect(extracted.checkDefinitions).toEqual([{ name: 'status is 200', expectedStatus: 200 }]);

    expect(extracted.flows.length).toBe(2);
    const browseOnly = extracted.flows.find((f) => f.steps.length === 1);
    const withCheckout = extracted.flows.find((f) => f.steps.length === 2);
    expect(browseOnly).toBeDefined();
    expect(withCheckout).toBeDefined();
    expect(withCheckout!.weight).toBeGreaterThan(0.1);
    expect(withCheckout!.weight).toBeLessThan(0.32);
    expect(browseOnly!.steps[0]!.thinkTimeMs).toBe(1000);
    expect(withCheckout!.steps[1]!.method).toBe('POST');
    expect(withCheckout!.steps[1]!.bodyBytes).toBeGreaterThan(0);

    const baseScenario: Scenario = {
      id: 'sc-1',
      name: 'Default',
      durationS: 30,
      entryNodeId: 'client',
      profile: { kind: 'constant', rps: 10 },
      flows: [],
      chaos: [],
    };
    const synced = applyExtractedScenarioToScenario(baseScenario, extracted, script.id);
    expect(synced.durationS).toBe(60);
    expect(synced.scriptId).toBe(script.id);
    expect(synced.profile.kind).toBe('steps');
    expect(synced.flows.length).toBe(2);
    expect(synced.thresholds).toEqual(extracted.options.thresholds);
  });

  it('supports k6 module imports (k6/http & k6), __VU/__ITER, and deterministic seed', async () => {
    const script = makeScenarioScript(`
      import http from 'k6/http';
      import { check, sleep, group } from 'k6';

      export const options = {
        stages: [
          { duration: '15s', target: 100 },
          { duration: '30s', target: 300 },
        ],
      };

      export default function () {
        group('checkout', () => {
          const res = http.get('/items?vu=' + __VU);
          check(res, { ok: (r) => r.status === 200 });
          sleep(0.5);
          if (Math.random() < 0.5) {
            http.del('/cart/' + __ITER);
          }
        });
      }
    `);

    const a = await extractScenarioFromScript({ script, seed: 7, iterations: 60 });
    const b = await extractScenarioFromScript({ script, seed: 7, iterations: 60 });
    expect(a.errors).toEqual([]);
    expect(a.options.stages).toEqual([
      { durationS: 15, targetRps: 100 },
      { durationS: 30, targetRps: 300 },
    ]);
    expect(a.flows).toEqual(b.flows);
  });

  it('evaluates k6 thresholds cleanly as pass/fail results', () => {
    const thresholds = {
      http_req_duration: ['p(95)<300', 'p(99)<250'],
      http_req_failed: ['rate<0.01'],
      http_reqs: ['rate>=20'],
    };

    const evals = evaluateScenarioThresholds(thresholds, makeFakeResult());
    expect(evals).toHaveLength(4);
    expect(evals[0]!.passed).toBe(true); // 180 < 300
    expect(evals[1]!.passed).toBe(false); // 320 < 250 false
    expect(evals[2]!.passed).toBe(true); // 5/1000 = 0.005 < 0.01
    expect(evals[3]!.passed).toBe(true); // 33.2 >= 20

    const failRateEvals = evaluateScenarioThresholds(
      thresholds,
      makeFakeResult({ success: 950, errors: { server: 50 } }),
    );
    expect(failRateEvals[2]!.passed).toBe(false); // 5% !< 1%
    void SCHEMA_VERSION;
  });

  it('halts infinite loops in scenario scripts with CpuBudgetExceeded', async () => {
    const script = makeScenarioScript(`
      export default function () {
        while (true) {}
      }
    `);
    const res = await extractScenarioFromScript({
      script,
      seed: 1,
      iterations: 10,
      cpuBudgetMs: 120,
    });
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]!.category).toBe('CpuBudgetExceeded');
  });
});
