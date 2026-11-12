import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import { applyJsonPatch, diagnose } from '@infrasim/diagnosis';
import { analyzeDesignNetwork, applyNetworkPatch } from '@infrasim/network-analyzer';
import { validateDesign } from '@infrasim/shared-types';
import { runSimulation } from '@infrasim/sim-engine';
import { STARTER_TEMPLATES, getStarterTemplate } from './templates';

describe('Phase 1 starter templates', () => {
  it('validates every starter template against Design JSON Schema and catalog services', () => {
    expect(STARTER_TEMPLATES.length).toBe(11);

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

describe('Phase 4 networking puzzle lessons (Spec 13 §9)', () => {
  const expectedBrokenReasons: Array<{
    id: string;
    edgeReasons: Record<string, string>;
  }> = [
    { id: 'tpl-net-db-unreachable', edgeReasons: { 'e-api-db': 'SG_NO_INGRESS' } },
    { id: 'tpl-net-missing-nat', edgeReasons: { 'e-worker-stripe': 'NO_NAT' } },
    { id: 'tpl-net-lambda-dynamodb', edgeReasons: { 'e-fn-ddb': 'ENDPOINT_MISSING' } },
    {
      id: 'tpl-net-peering-asymmetric',
      edgeReasons: { 'e-app-analytics': 'MISSING_RETURN_ROUTE' },
    },
    {
      id: 'tpl-net-timeout-vs-refused',
      edgeReasons: { 'e-timeout': 'SG_NO_INGRESS', 'e-refused': 'PORT_NOT_LISTENING' },
    },
    { id: 'tpl-net-gcp-tag-mismatch', edgeReasons: { 'e-lb-gce': 'GCP_FW_DENY' } },
    { id: 'tpl-net-azure-private-dns', edgeReasons: { 'e-vm-sql': 'PRIVATE_DNS_MISSING' } },
    { id: 'tpl-net-oci-service-gateway', edgeReasons: { 'e-oci-bucket': 'ENDPOINT_MISSING' } },
  ];

  it('every networking lesson exhibits its target failure code, fixes cleanly with 1-click patches, and runs after repair', async () => {
    for (const spec of expectedBrokenReasons) {
      const tpl = getStarterTemplate(spec.id);
      expect(tpl, `Missing template ${spec.id}`).toBeDefined();

      let design = structuredClone(tpl!.design);
      const initialAnalysis = analyzeDesignNetwork(design);

      for (const [edgeId, expectedCode] of Object.entries(spec.edgeReasons)) {
        const edgeRes = initialAnalysis.edges[edgeId];
        expect(edgeRes, `Missing edge ${edgeId} in ${spec.id}`).toBeDefined();
        expect(edgeRes!.reachable).toBe(false);
        expect(edgeRes!.reasonCode).toBe(expectedCode);
        expect(edgeRes!.fixes.length).toBeGreaterThan(0);

        // Apply first suggested fix patch for each broken edge
        design = applyNetworkPatch(design, edgeRes!.fixes[0]!.patch);
      }

      const repairedAnalysis = analyzeDesignNetwork(design);
      for (const edge of design.edges) {
        expect(
          repairedAnalysis.edges[edge.id]?.reachable,
          `Edge ${edge.id} in ${spec.id} should be reachable after fix`,
        ).toBe(true);
      }

      const simResult = await runSimulation(
        { design, scenarioId: design.scenarios[0]!.id, network: repairedAnalysis },
        () => {},
      );
      expect(simResult.summary.success).toBeGreaterThan(0);
    }
  });

  it('tpl-net-timeout-vs-refused emits both ETIMEDOUT and ECONNREFUSED logs during broken simulation', async () => {
    const tpl = getStarterTemplate('tpl-net-timeout-vs-refused')!;
    const logs: string[] = [];
    const analysis = analyzeDesignNetwork(tpl.design);
    await runSimulation(
      { design: tpl.design, scenarioId: tpl.design.scenarios[0]!.id, network: analysis },
      (frame) => {
        for (const entry of frame.newLogs) {
          logs.push(entry.message);
        }
      },
    );
    expect(logs.some((m) => m.includes('ETIMEDOUT'))).toBe(true);
    expect(logs.some((m) => m.includes('ECONNREFUSED'))).toBe(true);
  });
});
