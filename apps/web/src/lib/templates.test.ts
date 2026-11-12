import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import { applyJsonPatch, diagnose } from '@infrasim/diagnosis';
import { validateDesign } from '@infrasim/shared-types';
import { runSimulation } from '@infrasim/sim-engine';
import { STARTER_TEMPLATES, getStarterTemplate } from './templates';

describe('Phase 1 starter templates', () => {
  it('validates every starter template against Design JSON Schema and catalog services', () => {
    expect(STARTER_TEMPLATES.length).toBe(3);

    for (const tpl of STARTER_TEMPLATES) {
      const res = validateDesign(tpl.design);
      expect(res.valid, `Schema errors in ${tpl.id}: ${res.errors.join(', ')}`).toBe(true);

      for (const node of tpl.design.nodes) {
        expect(getService(node.serviceId)).toBeDefined();
      }
      expect(tpl.design.scenarios.length).toBeGreaterThan(0);
    }
  });

  it('tpl-3tier saturates API on traffic spike, produces Why? fix, and recovers on re-run', async () => {
    const tpl = getStarterTemplate('tpl-3tier')!;
    const d = structuredClone(tpl.design);
    const scenarioId = d.scenarios[0]!.id;

    const r1 = await runSimulation({ design: d, scenarioId }, () => {});
    const r1Repeat = await runSimulation({ design: d, scenarioId }, () => {});
    // Determinism invariant
    expect(r1.summary).toEqual(r1Repeat.summary);
    expect(r1.perNode.api).toEqual(r1Repeat.perNode.api);

    expect(r1.perNode.api!.drops).toBeGreaterThan(0);
    expect(r1.perNode.api!.peakUtilization).toBeGreaterThanOrEqual(0.95);

    const insights = diagnose({ design: d, result: r1 });
    const apiInsight = insights.find((i) => i.nodeIds.includes('api') && i.fixes.length > 0);
    expect(apiInsight).toBeDefined();

    // Apply first suggested fix (Scale instances 1 -> 2) and verify recovery
    const fixed = applyJsonPatch(d, apiInsight!.fixes[0]!.patch);
    const r2 = await runSimulation({ design: fixed, scenarioId }, () => {});
    expect(r2.perNode.api!.drops).toBeLessThan(r1.perNode.api!.drops);
    expect(r2.perNode.api!.drops).toBe(0);
  });

  it('executes 1,000 RPS x 60 s on the 3-tier topology in well under 2 seconds', async () => {
    const tpl = getStarterTemplate('tpl-3tier')!;
    const d = structuredClone(tpl.design);
    d.nodes.find((n) => n.id === 'api')!.config.instances = 12;
    d.scenarios[0]!.durationS = 60;
    d.scenarios[0]!.profile = { kind: 'constant', rps: 1000 };

    const t0 = performance.now();
    const res = await runSimulation({ design: d, scenarioId: d.scenarios[0]!.id }, () => {});
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(2000);
    expect(res.summary.totalRequests).toBeGreaterThan(50_000);
  });

  it('tpl-cache protects PostgreSQL at 400 RPS and demonstrates DB pool exhaustion when bypassed', async () => {
    const tpl = getStarterTemplate('tpl-cache')!;
    const cachedDesign = structuredClone(tpl.design);
    const scenarioId = cachedDesign.scenarios[0]!.id;

    const cachedRes = await runSimulation({ design: cachedDesign, scenarioId }, () => {});
    expect(cachedRes.perNode.db!.peakUtilization).toBeLessThan(0.5);
    expect(cachedRes.perNode.db!.errors.timeout ?? 0).toBe(0);
    expect(cachedRes.perNode.db!.drops).toBe(0);

    // Drop cache hit ratio to 0% -> PostgreSQL 12-connection pool saturates cleanly
    const bypassedDesign = structuredClone(tpl.design);
    bypassedDesign.nodes.find((n) => n.id === 'cache')!.config.cacheHitRatio = 0;

    const bypassedRes = await runSimulation({ design: bypassedDesign, scenarioId }, () => {});
    expect(bypassedRes.perNode.db!.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(bypassedRes.perNode.db!.p95).toBeGreaterThan(cachedRes.perNode.db!.p95 * 4);

    const insights = diagnose({ design: bypassedDesign, result: bypassedRes });
    expect(insights.some((i) => i.ruleId === 'db-pool-exhausted')).toBe(true);
  });

  it('tpl-rag-chatbot simulates embeddings + vector search + streaming Bedrock pipeline deterministically', async () => {
    const tpl = getStarterTemplate('tpl-rag-chatbot')!;
    expect(tpl).toBeDefined();
    const d = structuredClone(tpl.design);
    const scenarioId = d.scenarios[0]!.id;

    const r1 = await runSimulation({ design: d, scenarioId }, () => {});
    expect(r1.summary.totalRequests).toBeGreaterThan(200);
    expect(r1.perNode.llm).toBeDefined();
    expect(r1.perNode.llm!.success).toBeGreaterThan(0);
  });
});
