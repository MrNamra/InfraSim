import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PriceSnapshot } from '@infrasim/cost-engine';
import { createEmptyDesign, type Challenge, type Design } from '@infrasim/shared-types';
import { evaluateChallengeAttempt, validateCallPlanBounds } from './evaluator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../../dist/challenges/verifyCli.js');

const TEST_ONLY_SNAPSHOT: PriceSnapshot = {
  generatedAt: '2026-11-12T00:00:00.000Z',
  prices: [
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.micro',
      region: 'us-east-1',
      unit: 'hour',
      unitRole: 'instance-hour',
      unitPrice: 0.0104,
      currency: 'USD',
      tierMin: null,
      tierMax: null,
      attrs: { vcpu: 2, memoryGb: 1 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 'c6i.large',
      region: 'us-east-1',
      unit: 'hour',
      unitRole: 'instance-hour',
      unitPrice: 0.085,
      currency: 'USD',
      tierMin: null,
      tierMax: null,
      attrs: { vcpu: 2, memoryGb: 4 },
    },
  ],
};

function makeFixtureChallenge(): Challenge {
  const starter = createEmptyDesign('ch-eval-starter', 'Starter');
  starter.nodes = [
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
      position: { x: 200, y: 0 },
      config: {
        instances: 1,
        instanceType: 't3.micro',
        vcpu: 1,
        maxInFlightPerInstance: 10,
        cpuMsPerRequest: 15,
        queue: { maxLength: 20, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 25, p95: 35 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'ch-scen',
    name: '200 RPS Spike',
    durationS: 8,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 200 },
    flows: [{ id: 'f1', name: 'GET', weight: 1, steps: [{ method: 'GET', path: '/items' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  return {
    slug: 'eval-smoke',
    title: 'Eval Smoke',
    difficulty: 'beginner',
    story: 'Fix capacity under budget.',
    learningGoals: ['Right-size instances'],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 101,
    pinnedPriceSnapshotId: 'pin-v1',
    constraints: {
      maxMonthlyCostUsd: 100,
      p95MsMax: 300,
      errorRateMax: 0.02,
      requiredCapabilities: ['multi-az'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.25, resilience: 0.25, security: 0.1, simplicity: 0.1 },
    },
    hints: [{ afterAttempts: 1, text: 'Scale to 2 instances' }],
    whatThisTeaches: 'Horizontal scaling reduces queueing latency.',
    published: true,
  };
}

describe('@infrasim/diagnosis T6.4 challenge evaluator & server verification CLI', () => {
  it('evaluates broken starter as failed and scaled design as passing, identical between function and Node CLI', async () => {
    const ch = makeFixtureChallenge();

    const failEval = await evaluateChallengeAttempt(ch, ch.starterDesign, {
      priceSnapshot: TEST_ONLY_SNAPSHOT,
    });
    expect(failEval.passed).toBe(false);
    expect(failEval.score).toBeLessThan(50);

    const passingDesign: Design = structuredClone(ch.starterDesign);
    passingDesign.nodes[1]!.config.instances = 4;
    passingDesign.nodes[1]!.config.instanceType = 't3.micro';
    passingDesign.nodes[1]!.config.maxInFlightPerInstance = 40;
    passingDesign.nodes[1]!.config.vcpu = 2;
    passingDesign.nodes[1]!.config.cluster = true;
    passingDesign.nodes[1]!.az = 'multi-az';
    // Even if client tampers with scenario RPS or seed, evaluator enforces challenge.fixedScenario/fixedSeed
    passingDesign.scenarios = [{ ...ch.fixedScenario, profile: { kind: 'constant', rps: 1 } }];
    passingDesign.settings.seed = 999999;

    const passEval = await evaluateChallengeAttempt(ch, passingDesign, {
      priceSnapshot: TEST_ONLY_SNAPSHOT,
    });
    expect(passEval.checks.filter((c) => !c.passed)).toEqual([]);
    expect(passEval.passed).toBe(true);
    expect(passEval.score).toBeGreaterThan(60);
    expect(passEval.seed).toBe(101);
    expect(passEval.snapshotId).toBe('pin-v1');
    expect(passEval.metrics.monthlyCostUsd).toBeLessThanOrEqual(100);

    // Run Node server CLI verifier via stdin/stdout and compare bit-for-bit equality
    const childResult = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'node',
        [cliPath],
        { maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.write(
        JSON.stringify({
          challenge: ch,
          design: passingDesign,
          priceSnapshot: TEST_ONLY_SNAPSHOT,
        }),
      );
      child.stdin?.end();
    });

    const cliEval = JSON.parse(childResult);
    expect(cliEval).toEqual(passEval);
  });

  it('rejects out-of-bounds CallPlans and disallowed services', async () => {
    expect(() =>
      validateCallPlanBounds({
        s1: {
          scriptId: 's1',
          cpuMs: { distribution: 'fixed', p50: -5, p95: 10 },
          throwProbability: 0,
          steps: [],
        },
      }),
    ).toThrow();

    expect(() =>
      validateCallPlanBounds({
        s1: {
          scriptId: 's1',
          cpuMs: { distribution: 'fixed', p50: 5, p95: 10 },
          throwProbability: 0,
          steps: Array.from({ length: 65 }, () => ({ kind: 'cpu' as const, ms: 1 })),
        },
      }),
    ).toThrow();

    const ch = makeFixtureChallenge();
    const disallowed = structuredClone(ch.starterDesign);
    disallowed.nodes[1]!.serviceId = 'gcp.cloud_run';
    await expect(evaluateChallengeAttempt(ch, disallowed)).rejects.toThrow(/not allowed/);
  });
});
