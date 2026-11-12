import { getService } from '@infrasim/catalog';
import {
  DEFAULT_COST_ASSUMPTIONS,
  estimateMonthlyCost,
  listInstanceSpecs,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import { analyzeDesignNetwork } from '@infrasim/network-analyzer';
import type {
  CallPlan,
  CostAssumptions,
  Design,
  JsonPatchOp,
  SimulationResult,
} from '@infrasim/shared-types';
import { runSimulation } from '@infrasim/sim-engine';
import { applyJsonPatch } from './patch.js';

export interface CostLatencySweepInput {
  design: Design;
  nodeId: string;
  scenarioId?: string;
  snapshot?: PriceSnapshot | null;
  assumptions?: CostAssumptions;
  callPlans?: Record<string, CallPlan>;
  instanceCounts?: number[];
  maxDurationS?: number;
}

export interface SweepPoint {
  id: string;
  label: string;
  instances: number;
  instanceType?: string;
  monthlyCostUsd: number | null;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  throughputRps: number;
  isPareto: boolean;
  isCurrent: boolean;
  patch: JsonPatchOp[];
}

export interface CostLatencySweepResult {
  nodeId: string;
  nodeLabel: string;
  currency: string;
  points: SweepPoint[];
}

function countErrors(res: SimulationResult): number {
  let errs = 0;
  for (const val of Object.values(res.summary.errors)) {
    errs += val ?? 0;
  }
  return errs;
}

function buildSweepDesign(
  design: Design,
  scenarioId: string | undefined,
  maxDurationS: number,
): { design: Design; scenarioId: string } {
  const clone = structuredClone(design);
  const targetScenario =
    (scenarioId ? clone.scenarios.find((s) => s.id === scenarioId) : undefined) ??
    clone.scenarios[0];

  if (!targetScenario) {
    throw new Error('Cannot run cost vs latency sweep without a traffic scenario.');
  }

  targetScenario.durationS = Math.min(Math.max(5, targetScenario.durationS), maxDurationS);
  return { design: clone, scenarioId: targetScenario.id };
}

/**
 * Runs a deterministic multi-configuration simulation and cost sweep for a target node across
 * instance counts `[1, 2, 4, 8]` (plus current count and alternative curated SKUs when priced),
 * returning Pareto-optimal trade-offs and apply-ready JSON patches.
 */
export async function runCostLatencySweep(
  input: CostLatencySweepInput,
): Promise<CostLatencySweepResult> {
  const {
    design,
    nodeId,
    scenarioId,
    snapshot = null,
    assumptions = DEFAULT_COST_ASSUMPTIONS,
    callPlans,
    instanceCounts = [1, 2, 4, 8],
    maxDurationS = 15,
  } = input;

  const nodeIdx = design.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIdx < 0) {
    throw new Error(`Node "${nodeId}" not found in design.`);
  }

  const targetNode = design.nodes[nodeIdx]!;
  const svc = getService(targetNode.serviceId, design.customServices ?? []);
  const { design: baseDesign, scenarioId: activeScenarioId } = buildSweepDesign(
    design,
    scenarioId,
    maxDurationS,
  );

  const uniqueCounts = Array.from(
    new Set([targetNode.config.instances, ...instanceCounts.filter((c) => c >= 1 && c <= 64)]),
  ).sort((a, b) => a - b);

  interface CandidateConfig {
    id: string;
    label: string;
    instances: number;
    instanceType?: string;
    vcpu?: number;
    memoryGb?: number;
    maxInFlightPerInstance?: number;
    isCurrent: boolean;
  }

  const candidates: CandidateConfig[] = uniqueCounts.map((count) => ({
    id: `${count}x-${targetNode.config.instanceType ?? 'default'}`,
    label: `${count}×${targetNode.config.instanceType ? ` ${targetNode.config.instanceType}` : ''}`,
    instances: count,
    instanceType: targetNode.config.instanceType,
    vcpu: targetNode.config.vcpu,
    memoryGb: targetNode.config.memoryGb,
    maxInFlightPerInstance: targetNode.config.maxInFlightPerInstance,
    isCurrent: count === targetNode.config.instances,
  }));

  // Also test up to 2 curated instance specs at current/2x count when node uses compute/database SKUs
  if (svc && (svc.kind === 'compute' || svc.kind === 'sql' || svc.kind === 'cache')) {
    const category = svc.kind === 'sql' ? 'database' : 'compute';
    const specs = listInstanceSpecs(svc.provider, category).slice(0, 3);
    for (const spec of specs) {
      if (spec.instanceType === targetNode.config.instanceType) continue;
      if (candidates.length >= 6) break;
      const baseConc =
        targetNode.config.maxInFlightPerInstance ??
        (svc.capacity.type === 'conc' ? svc.capacity.limit : 100);
      const scaleFactor = Math.max(
        0.5,
        Math.min(4, spec.vcpu / Math.max(1, targetNode.config.vcpu ?? 2)),
      );
      candidates.push({
        id: `${targetNode.config.instances}x-${spec.instanceType}`,
        label: `${targetNode.config.instances}× ${spec.instanceType}`,
        instances: targetNode.config.instances,
        instanceType: spec.instanceType,
        vcpu: spec.vcpu,
        memoryGb: spec.memoryGb,
        maxInFlightPerInstance: Math.max(8, Math.round(baseConc * scaleFactor)),
        isCurrent: false,
      });
    }
  }

  const points: SweepPoint[] = [];

  for (const cand of candidates) {
    const patch: JsonPatchOp[] = [
      {
        op: 'replace',
        path: `/nodes/${nodeIdx}/config/instances`,
        value: cand.instances,
      },
    ];
    if (cand.instanceType && cand.instanceType !== targetNode.config.instanceType) {
      patch.push({
        op: 'replace',
        path: `/nodes/${nodeIdx}/config/instanceType`,
        value: cand.instanceType,
      });
    }
    if (cand.vcpu !== undefined && cand.vcpu !== targetNode.config.vcpu) {
      patch.push({
        op: 'replace',
        path: `/nodes/${nodeIdx}/config/vcpu`,
        value: cand.vcpu,
      });
    }
    if (cand.memoryGb !== undefined && cand.memoryGb !== targetNode.config.memoryGb) {
      patch.push({
        op: 'replace',
        path: `/nodes/${nodeIdx}/config/memoryGb`,
        value: cand.memoryGb,
      });
    }
    if (
      cand.maxInFlightPerInstance !== undefined &&
      cand.maxInFlightPerInstance !== targetNode.config.maxInFlightPerInstance
    ) {
      patch.push({
        op: 'replace',
        path: `/nodes/${nodeIdx}/config/maxInFlightPerInstance`,
        value: cand.maxInFlightPerInstance,
      });
    }

    const variantDesign = applyJsonPatch(baseDesign, patch);
    const network = analyzeDesignNetwork(variantDesign, {
      customServices: variantDesign.customServices,
    });
    const simResult = await runSimulation(
      {
        design: variantDesign,
        scenarioId: activeScenarioId,
        seed: design.settings.seed,
        ...(callPlans ? { callPlans } : {}),
        network,
      },
      () => {},
    );
    const costReport = estimateMonthlyCost(variantDesign, simResult, snapshot, assumptions, {
      customServices: design.customServices,
    });

    const resolved = simResult.summary.success + countErrors(simResult);
    const errorRate = resolved > 0 ? Number((countErrors(simResult) / resolved).toFixed(4)) : 0;
    const nodeMissingPrice = (costReport.perNode[nodeId]?.lines ?? []).some(
      (l) => l.source === 'unavailable',
    );
    const monthlyCostUsd =
      nodeMissingPrice && costReport.monthlyTotal === 0
        ? null
        : Number(costReport.monthlyTotal.toFixed(2));

    points.push({
      id: cand.id,
      label: cand.label,
      instances: cand.instances,
      ...(cand.instanceType ? { instanceType: cand.instanceType } : {}),
      monthlyCostUsd,
      p50Ms: Math.round(simResult.summary.p50),
      p95Ms: Math.round(simResult.summary.p95),
      p99Ms: Math.round(simResult.summary.p99),
      errorRate,
      throughputRps: Number(simResult.summary.throughputRps.toFixed(1)),
      isPareto: false,
      isCurrent: cand.isCurrent,
      patch,
    });
  }

  // Mark Pareto-optimal points (minimizing monthlyCostUsd, p95Ms, errorRate)
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    let dominated = false;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const b = points[j]!;
      const bCost = b.monthlyCostUsd ?? Number.POSITIVE_INFINITY;
      const aCost = a.monthlyCostUsd ?? Number.POSITIVE_INFINITY;
      const noWorse = bCost <= aCost && b.p95Ms <= a.p95Ms && b.errorRate <= a.errorRate;
      const strictlyBetter = bCost < aCost || b.p95Ms < a.p95Ms || b.errorRate < a.errorRate;
      if (noWorse && strictlyBetter) {
        dominated = true;
        break;
      }
    }
    a.isPareto = !dominated;
  }

  points.sort((a, b) => {
    const aCost = a.monthlyCostUsd ?? Number.POSITIVE_INFINITY;
    const bCost = b.monthlyCostUsd ?? Number.POSITIVE_INFINITY;
    if (aCost !== bCost) return aCost - bCost;
    if (a.p95Ms !== b.p95Ms) return a.p95Ms - b.p95Ms;
    return a.instances - b.instances;
  });

  return {
    nodeId,
    nodeLabel: targetNode.label,
    currency: assumptions.currency,
    points,
  };
}
