import { CATALOG_SERVICES, getService } from '@infrasim/catalog';
import {
  DEFAULT_COST_ASSUMPTIONS,
  estimateMonthlyCost,
  type PriceSnapshot,
} from '@infrasim/cost-engine';
import { analyzeDesignNetwork, checkReachability } from '@infrasim/network-analyzer';
import type {
  CallPlan,
  Challenge,
  ChallengeAttemptResult,
  ChallengeConstraintCheck,
  ChallengeSubScores,
  Design,
  PlanStep,
} from '@infrasim/shared-types';
import { runSimulation } from '@infrasim/sim-engine';
import { diagnose } from '../engine.js';

export const MAX_CHALLENGE_NODES = 80;
export const MAX_CHALLENGE_EDGES = 160;
const MAX_CALL_PLAN_STEPS = 64;
const MAX_CALL_PLAN_DEPTH = 8;

export interface EvaluateChallengeOptions {
  priceSnapshot?: PriceSnapshot | null;
  callPlans?: Record<string, CallPlan>;
  requirePriceSnapshot?: boolean;
}

function validatePlanSteps(
  steps: readonly PlanStep[],
  depth: number,
  counter: { total: number },
): void {
  if (depth > MAX_CALL_PLAN_DEPTH) {
    throw new Error(`CallPlan nesting depth exceeded (${MAX_CALL_PLAN_DEPTH}).`);
  }
  for (const step of steps) {
    counter.total += 1;
    if (counter.total > MAX_CALL_PLAN_STEPS) {
      throw new Error(`CallPlan step limit exceeded (${MAX_CALL_PLAN_STEPS}).`);
    }
    if (step.kind === 'cpu' || step.kind === 'sleep') {
      if (!Number.isFinite(step.ms) || step.ms < 0 || step.ms > 60_000) {
        throw new Error(`CallPlan ${step.kind} latency out of bounds (${step.ms} ms).`);
      }
    } else if (step.kind === 'call') {
      if (!Number.isFinite(step.count) || step.count < 0 || step.count > 50) {
        throw new Error(`CallPlan call count out of bounds (${step.count}).`);
      }
      if (
        step.payloadBytes !== undefined &&
        (!Number.isFinite(step.payloadBytes) ||
          step.payloadBytes < 0 ||
          step.payloadBytes > 10_000_000)
      ) {
        throw new Error(`CallPlan payloadBytes out of bounds (${step.payloadBytes}).`);
      }
      if (step.op.length > 128 || step.serviceId.length > 128) {
        throw new Error('CallPlan identifier exceeds length limit.');
      }
    } else if (step.kind === 'branch') {
      if (!Number.isFinite(step.probability) || step.probability < 0 || step.probability > 1) {
        throw new Error(`CallPlan branch probability out of bounds (${step.probability}).`);
      }
      validatePlanSteps(step.then, depth + 1, counter);
      validatePlanSteps(step.else, depth + 1, counter);
    }
  }
}

/** Validates profiled CallPlans submitted for challenge verification against strict size & latency bounds. */
export function validateCallPlanBounds(callPlans?: Record<string, CallPlan>): void {
  if (!callPlans) return;
  const entries = Object.entries(callPlans);
  if (entries.length > 40) {
    throw new Error('Too many CallPlans submitted.');
  }
  for (const [, plan] of entries) {
    if (
      !Number.isFinite(plan.cpuMs.p50) ||
      !Number.isFinite(plan.cpuMs.p95) ||
      plan.cpuMs.p50 < 0 ||
      plan.cpuMs.p95 < plan.cpuMs.p50 ||
      plan.cpuMs.p95 > 60_000
    ) {
      throw new Error('CallPlan cpuMs latency model is out of allowed bounds.');
    }
    if (
      !Number.isFinite(plan.throwProbability) ||
      plan.throwProbability < 0 ||
      plan.throwProbability > 1
    ) {
      throw new Error('CallPlan throwProbability must be within [0, 1].');
    }
    validatePlanSteps(plan.steps, 0, { total: 0 });
  }
}

function isServiceAllowed(serviceId: string, allowList?: readonly string[]): boolean {
  if (!allowList || allowList.length === 0) return true;
  if (
    serviceId === 'generic.client' ||
    serviceId === 'generic.users' ||
    serviceId === 'generic.internet'
  ) {
    return true;
  }
  return allowList.some((pattern) => {
    if (pattern.endsWith('*')) {
      return serviceId.startsWith(pattern.slice(0, -1));
    }
    return serviceId === pattern;
  });
}

function resolveChallengeEntryNode(design: Design, preferredEntryId: string): string {
  if (design.nodes.some((n) => n.id === preferredEntryId)) {
    return preferredEntryId;
  }
  const clientNode = design.nodes.find(
    (n) => n.serviceId === 'generic.client' || n.serviceId === 'generic.users',
  );
  return clientNode?.id ?? design.nodes[0]?.id ?? preferredEntryId;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Deterministically evaluates a submitted `Design` against a `Challenge`'s fixed scenario,
 * fixed seed, pinned price snapshot, hard constraints, and weighted 0-100 scoring rubric.
 * Identical results are produced client-side in Web Workers and server-side in Node verification.
 */
export async function evaluateChallengeAttempt(
  challenge: Challenge,
  submittedDesign: Design,
  options: EvaluateChallengeOptions = {},
): Promise<ChallengeAttemptResult> {
  validateCallPlanBounds(options.callPlans);

  if (submittedDesign.nodes.length > MAX_CHALLENGE_NODES) {
    throw new Error(`Design exceeds max ${MAX_CHALLENGE_NODES} nodes for challenges.`);
  }
  if (submittedDesign.edges.length > MAX_CHALLENGE_EDGES) {
    throw new Error(`Design exceeds max ${MAX_CHALLENGE_EDGES} edges for challenges.`);
  }

  for (const node of submittedDesign.nodes) {
    if (!isServiceAllowed(node.serviceId, challenge.allowedServices)) {
      throw new Error(
        `Service "${node.serviceId}" is not allowed in challenge "${challenge.slug}".`,
      );
    }
  }

  // Server-owned scenario, chaos, and seed cannot be edited by the client
  const fixedScenario = structuredClone(challenge.fixedScenario);
  fixedScenario.entryNodeId = resolveChallengeEntryNode(submittedDesign, fixedScenario.entryNodeId);

  const evalDesign: Design = {
    ...structuredClone(submittedDesign),
    schemaVersion: 1,
    groups: submittedDesign.groups ?? [],
    network: submittedDesign.network ?? {},
    scripts: submittedDesign.scripts ?? [],
    fixtures: submittedDesign.fixtures ?? [],
    scenarios: [fixedScenario],
    settings: {
      ...submittedDesign.settings,
      includeFreeTier: submittedDesign.settings?.includeFreeTier ?? true,
      seed: challenge.fixedSeed,
      currency: 'USD',
    },
  };

  const catalog = [...CATALOG_SERVICES, ...(evalDesign.customServices ?? [])];
  const network = analyzeDesignNetwork(evalDesign, {
    customServices: evalDesign.customServices,
  });

  const simResult = await runSimulation(
    {
      design: evalDesign,
      scenarioId: fixedScenario.id,
      seed: challenge.fixedSeed,
      ...(options.callPlans ? { callPlans: options.callPlans } : {}),
      network,
    },
    () => {},
  );

  const snapshot = options.priceSnapshot ?? null;
  const assumptions = {
    ...DEFAULT_COST_ASSUMPTIONS,
    currency: 'USD' as const,
    includeFreeTier: evalDesign.settings.includeFreeTier ?? true,
  };
  const costReport = estimateMonthlyCost(evalDesign, simResult, snapshot, assumptions, {
    customServices: evalDesign.customServices,
  });

  const insights = diagnose({
    design: evalDesign,
    result: simResult,
    catalog,
    network,
    cost: costReport,
  });

  const totalRequests = simResult.summary.totalRequests;
  const success = simResult.summary.success;
  const availability = totalRequests > 0 ? success / totalRequests : 0;
  const errorRate = totalRequests > 0 ? Math.max(0, 1 - availability) : 1;
  const p50Ms = round2(simResult.summary.p50);
  const p95Ms = round2(simResult.summary.p95);
  const p99Ms = round2(simResult.summary.p99);
  const monthlyCostUsd = round2(costReport.monthlyTotal);

  const checks: ChallengeConstraintCheck[] = [];
  const { constraints } = challenge;

  checks.push({
    id: 'requests-served',
    label: 'Traffic reaches application pipeline',
    passed: totalRequests > 0 && success > 0,
    actual: `${success}/${totalRequests} ok`,
    target: '> 0 served',
  });

  if (constraints.p95MsMax !== undefined) {
    checks.push({
      id: 'p95-max',
      label: `p95 latency <= ${constraints.p95MsMax} ms`,
      passed: totalRequests > 0 && p95Ms <= constraints.p95MsMax,
      actual: `${p95Ms} ms`,
      target: `<= ${constraints.p95MsMax} ms`,
    });
  }

  if (constraints.p99MsMax !== undefined) {
    checks.push({
      id: 'p99-max',
      label: `p99 latency <= ${constraints.p99MsMax} ms`,
      passed: totalRequests > 0 && p99Ms <= constraints.p99MsMax,
      actual: `${p99Ms} ms`,
      target: `<= ${constraints.p99MsMax} ms`,
    });
  }

  if (constraints.errorRateMax !== undefined) {
    checks.push({
      id: 'error-rate-max',
      label: `Error rate <= ${(constraints.errorRateMax * 100).toFixed(1)}%`,
      passed: totalRequests > 0 && errorRate <= constraints.errorRateMax,
      actual: `${(errorRate * 100).toFixed(2)}%`,
      target: `<= ${(constraints.errorRateMax * 100).toFixed(1)}%`,
    });
  }

  if (constraints.minAvailabilityUnderChaos !== undefined) {
    checks.push({
      id: 'min-availability',
      label: `Availability >= ${(constraints.minAvailabilityUnderChaos * 100).toFixed(1)}%`,
      passed: totalRequests > 0 && availability >= constraints.minAvailabilityUnderChaos,
      actual: `${(availability * 100).toFixed(2)}%`,
      target: `>= ${(constraints.minAvailabilityUnderChaos * 100).toFixed(1)}%`,
    });
  }

  if (constraints.maxMonthlyCostUsd !== undefined) {
    const hasMissingSnapshotForBudget = Boolean(options.requirePriceSnapshot && snapshot === null);
    checks.push({
      id: 'max-cost',
      label: `Monthly cost <= $${constraints.maxMonthlyCostUsd}/mo`,
      passed: !hasMissingSnapshotForBudget && monthlyCostUsd <= constraints.maxMonthlyCostUsd,
      actual: hasMissingSnapshotForBudget ? 'snapshot required' : `$${monthlyCostUsd.toFixed(2)}`,
      target: `<= $${constraints.maxMonthlyCostUsd}`,
    });
  }

  for (const cap of constraints.requiredCapabilities ?? []) {
    if (cap === 'multi-az') {
      const hasMultiAzCritical = evalDesign.nodes.some((n) => {
        if (n.serviceId === 'generic.client' || n.serviceId === 'generic.users') return false;
        return n.az?.toLowerCase() === 'multi-az' || n.config.instances >= 2;
      });
      const noSpofCritical = !insights.some(
        (i) => i.ruleId === 'single-point-of-failure' && i.severity === 'critical',
      );
      checks.push({
        id: 'cap-multi-az',
        label: 'Multi-AZ / >= 2 redundant instances',
        passed: hasMultiAzCritical && noSpofCritical,
        actual: hasMultiAzCritical && noSpofCritical ? 'enabled' : 'single-AZ / 1 instance',
        target: 'multi-az',
      });
    } else if (cap === 'cache') {
      const hasCache = evalDesign.nodes.some((n) => {
        const k = getService(n.serviceId, evalDesign.customServices)?.kind;
        return k === 'cache' || k === 'cdn';
      });
      checks.push({
        id: 'cap-cache',
        label: 'Cache or CDN tier present',
        passed: hasCache,
        actual: hasCache ? 'present' : 'missing',
        target: 'cache',
      });
    } else if (cap === 'async-queue') {
      const hasQueueEdge = evalDesign.edges.some((e) => {
        const tgt = evalDesign.nodes.find((n) => n.id === e.to);
        const k = tgt ? getService(tgt.serviceId, evalDesign.customServices)?.kind : undefined;
        return (
          (k === 'queue' || k === 'topic' || k === 'bus' || k === 'stream') &&
          e.callType === 'async'
        );
      });
      checks.push({
        id: 'cap-async-queue',
        label: 'Asynchronous queue path configured',
        passed: hasQueueEdge,
        actual: hasQueueEdge ? 'async edge -> queue' : 'sync only',
        target: 'async-queue',
      });
    } else if (cap === 'private-db') {
      const hasPublicDb = insights.some((i) => i.ruleId === 'db-public');
      checks.push({
        id: 'cap-private-db',
        label: 'Database isolated in private subnet',
        passed: !hasPublicDb,
        actual: hasPublicDb ? 'public subnet' : 'private',
        target: 'private-db',
      });
    } else if (cap === 'dlq') {
      const hasDlq = evalDesign.nodes.some((n) => n.config.consumer?.dlq === true);
      checks.push({
        id: 'cap-dlq',
        label: 'Dead-Letter Queue (DLQ) enabled',
        passed: hasDlq,
        actual: hasDlq ? 'enabled' : 'missing',
        target: 'dlq',
      });
    } else if (cap === 'autoscaling') {
      const hasAutoscaling = evalDesign.nodes.some((n) => Boolean(n.config.autoscaling));
      checks.push({
        id: 'cap-autoscaling',
        label: 'Autoscaling policy active',
        passed: hasAutoscaling,
        actual: hasAutoscaling ? 'enabled' : 'disabled',
        target: 'autoscaling',
      });
    }
  }

  for (const rule of constraints.mustBeReachable ?? []) {
    const reach = checkReachability(
      evalDesign,
      { srcNodeId: rule.from, dstNodeId: rule.to, protocol: 'tcp', port: rule.port },
      { customServices: evalDesign.customServices },
    );
    checks.push({
      id: `reach-${rule.from}-${rule.to}-${rule.port}`,
      label: `Reachable: ${rule.from} -> ${rule.to}:${rule.port}`,
      passed: reach.reachable,
      actual: reach.reachable ? 'reachable' : (reach.reasonCode ?? 'blocked'),
      target: 'reachable',
    });
  }

  for (const forbid of constraints.forbidden ?? []) {
    if (forbid === 'public-db') {
      const bad = insights.some((i) => i.ruleId === 'db-public');
      checks.push({
        id: 'forbid-public-db',
        label: 'No public database exposure',
        passed: !bad,
        actual: bad ? 'exposed' : 'private',
        target: 'no public-db',
      });
    } else if (forbid === 'wide-open-ingress') {
      const bad = insights.some((i) => i.ruleId === 'wide-open-ingress');
      checks.push({
        id: 'forbid-wide-open-ingress',
        label: 'No 0.0.0.0/0 non-web ingress rules',
        passed: !bad,
        actual: bad ? '0.0.0.0/0 open' : 'restricted',
        target: 'least privilege',
      });
    }
  }

  if (constraints.requiredProviders && constraints.requiredProviders.length > 0) {
    const presentProviders = new Set(
      evalDesign.nodes
        .map((n) => getService(n.serviceId, evalDesign.customServices)?.provider)
        .filter(Boolean),
    );
    for (const reqProv of constraints.requiredProviders) {
      checks.push({
        id: `provider-${reqProv}`,
        label: `Includes ${reqProv.toUpperCase()} service`,
        passed: presentProviders.has(reqProv),
        actual: presentProviders.has(reqProv) ? 'present' : 'missing',
        target: reqProv.toUpperCase(),
      });
    }
  }

  const passed = checks.every((c) => c.passed);

  // Compute deterministic 0-100 sub-scores
  const p95Budget = constraints.p95MsMax ?? constraints.p99MsMax ?? 250;
  const latencySub =
    totalRequests <= 0
      ? 0
      : clampScore(
          100 - Math.max(0, (p95Ms - p95Budget * 0.4) / Math.max(1, p95Budget * 1.6)) * 100,
        );

  const costBudget = constraints.maxMonthlyCostUsd ?? 200;
  const costSub = clampScore(
    100 - Math.max(0, (monthlyCostUsd - costBudget * 0.3) / Math.max(1, costBudget * 1.4)) * 100,
  );

  const resiliencePenalties = insights.filter((i) =>
    [
      'single-point-of-failure',
      'retry-storm',
      'no-circuit-breaker',
      'no-dlq',
      'no-timeout',
    ].includes(i.ruleId),
  ).length;
  const resilienceSub = clampScore(availability * 100 - resiliencePenalties * 12);

  const securityPenalties = insights.filter((i) =>
    ['db-public', 'wide-open-ingress', 'network-security-smell', 'network-edge-blocked'].includes(
      i.ruleId,
    ),
  ).length;
  const securitySub = clampScore(100 - securityPenalties * 35);

  const nodeCount = evalDesign.nodes.filter(
    (n) => n.serviceId !== 'generic.client' && n.serviceId !== 'generic.users',
  ).length;
  const simplicitySub = clampScore(100 - Math.max(0, nodeCount - 7) * 6);

  const subScores: ChallengeSubScores = {
    latency: latencySub,
    cost: costSub,
    resilience: resilienceSub,
    security: securitySub,
    simplicity: simplicitySub,
  };

  const w = challenge.scoring.weights;
  const weightSum = Math.max(0.0001, w.latency + w.cost + w.resilience + w.security + w.simplicity);
  const rawScore =
    (subScores.latency * w.latency +
      subScores.cost * w.cost +
      subScores.resilience * w.resilience +
      subScores.security * w.security +
      subScores.simplicity * w.simplicity) /
    weightSum;

  const score = round2(passed ? rawScore : Math.min(49.99, rawScore));

  return {
    passed,
    score,
    subScores,
    checks,
    metrics: {
      p50Ms,
      p95Ms,
      p99Ms,
      errorRate: round4(errorRate),
      availability: round4(availability),
      monthlyCostUsd,
      totalRequests,
      nodeCount,
    },
    seed: challenge.fixedSeed,
    snapshotId: snapshot ? challenge.pinnedPriceSnapshotId : 'unavailable',
  };
}
