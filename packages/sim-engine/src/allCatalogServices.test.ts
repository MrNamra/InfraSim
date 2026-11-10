import { describe, expect, it } from 'vitest';
import { getCatalog } from '@infrasim/catalog';
import { type Design, SCHEMA_VERSION } from '@infrasim/shared-types';
import { runSimulation } from './engine.js';

function assertFiniteMetric(value: number, label: string): void {
  expect(Number.isFinite(value), `${label} must be finite, got ${value}`).toBe(true);
}

describe('T2.1 every catalog service executes cleanly in sim-engine', () => {
  it('runs all 251 catalog rows without errors, NaN, or broken invariants', async () => {
    const services = getCatalog();
    expect(services).toHaveLength(251);

    for (const service of services) {
      const isEntryLike = service.id === 'generic.client' || service.id === 'generic.users';

      const design: Design = {
        schemaVersion: SCHEMA_VERSION,
        id: `test-${service.id}`,
        name: `Catalog run ${service.id}`,
        nodes: isEntryLike
          ? [
              {
                id: 'entry',
                serviceId: service.id,
                label: service.name,
                position: { x: 0, y: 0 },
                config: { instances: 1, operations: {} },
              },
              {
                id: 'target',
                serviceId: 'generic.service',
                label: 'Target',
                position: { x: 240, y: 0 },
                config: { instances: 1, operations: {} },
              },
            ]
          : [
              {
                id: 'client',
                serviceId: 'generic.client',
                label: 'Client',
                position: { x: 0, y: 0 },
                config: { instances: 1, operations: {} },
              },
              {
                id: 'target',
                serviceId: service.id,
                label: service.name,
                position: { x: 240, y: 0 },
                config: { instances: 1, operations: {} },
              },
            ],
        edges: [
          {
            id: 'e1',
            from: isEntryLike ? 'entry' : 'client',
            to: 'target',
            protocol: 'https',
            callType: 'sync',
            weight: 1,
          },
        ],
        groups: [],
        network: {},
        scenarios: [
          {
            id: 'sc1',
            name: 'Smoke',
            durationS: 3,
            entryNodeId: isEntryLike ? 'entry' : 'client',
            profile: { kind: 'constant', rps: 10 },
            flows: [],
            chaos: [],
          },
        ],
        scripts: [],
        fixtures: [],
        settings: {
          seed: 42,
          primaryProvider: service.provider,
          currency: 'USD',
          includeFreeTier: false,
        },
      };

      const result = await runSimulation({ design, scenarioId: 'sc1', seed: 42 }, () => {});

      assertFiniteMetric(result.summary.totalRequests, `${service.id}.totalRequests`);
      assertFiniteMetric(result.summary.throughputRps, `${service.id}.throughputRps`);
      assertFiniteMetric(result.summary.p50, `${service.id}.summary.p50`);
      assertFiniteMetric(result.summary.p95, `${service.id}.summary.p95`);
      assertFiniteMetric(result.summary.p99, `${service.id}.summary.p99`);
      expect(result.summary.p95).toBeGreaterThanOrEqual(result.summary.p50);
      expect(result.summary.p99).toBeGreaterThanOrEqual(result.summary.p95);

      const inspectedKey = isEntryLike ? 'entry' : 'target';
      const nodeSummary = result.perNode[inspectedKey];
      expect(nodeSummary, `Missing perNode summary for ${service.id}`).toBeDefined();
      if (nodeSummary) {
        assertFiniteMetric(nodeSummary.requests, `${service.id}.requests`);
        assertFiniteMetric(nodeSummary.success, `${service.id}.success`);
        assertFiniteMetric(nodeSummary.drops, `${service.id}.drops`);
        assertFiniteMetric(nodeSummary.avgUtilization, `${service.id}.avgUtil`);
        assertFiniteMetric(nodeSummary.p50, `${service.id}.node.p50`);
        assertFiniteMetric(nodeSummary.p95, `${service.id}.node.p95`);
        assertFiniteMetric(nodeSummary.p99, `${service.id}.node.p99`);
        expect(nodeSummary.requests).toBeGreaterThan(0);
        expect(nodeSummary.p95).toBeGreaterThanOrEqual(nodeSummary.p50);
        expect(nodeSummary.p99).toBeGreaterThanOrEqual(nodeSummary.p95);
      }
    }
  });
});
