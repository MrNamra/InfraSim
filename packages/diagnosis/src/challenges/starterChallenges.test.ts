import { describe, expect, it } from 'vitest';
import type { PriceSnapshot } from '@infrasim/cost-engine';
import { evaluateChallengeAttempt } from './evaluator.js';
import { STARTER_CHALLENGES } from './starterChallenges.js';

/** Test-only price snapshot covering every AWS & GCP service in starter challenges. */
const TEST_ONLY_CHALLENGE_PRICES: PriceSnapshot = {
  generatedAt: '2026-11-12T00:00:00.000Z',
  prices: [
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.micro',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0104,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 1 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 't3.small',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0208,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 2 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 'c6i.large',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.085,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 4 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ec2',
      skuKey: 'm5.large',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.096,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 8 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.ecs_ec2',
      skuKey: 'c6i.large',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.085,
      currency: 'USD',
      attrs: { vcpu: 2, memoryGb: 4 },
    },
    {
      provider: 'aws',
      serviceId: 'aws.alb',
      skuKey: 'ALB-Hour',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.0225,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.rds_postgres',
      skuKey: 'db.t3.micro',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.017,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.elasticache_redis',
      skuKey: 'cache.t3.micro',
      region: 'us-east-1',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.017,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.sqs',
      skuKey: 'SQS-Requests',
      region: 'us-east-1',
      unit: '1M Requests',
      unitRole: 'requests',
      unitPrice: 0.4,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.lambda',
      skuKey: 'Lambda-Requests',
      region: 'us-east-1',
      unit: '1M Requests',
      unitRole: 'requests',
      unitPrice: 0.2,
      currency: 'USD',
    },
    {
      provider: 'aws',
      serviceId: 'aws.bedrock',
      skuKey: 'Bedrock-Input',
      region: 'us-east-1',
      unit: '1M Tokens',
      unitRole: 'input_token',
      unitPrice: 0.8,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.lb_https',
      skuKey: 'ForwardingRule',
      region: 'us-east4',
      unit: 'Hours',
      unitRole: 'instance_hour',
      unitPrice: 0.025,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'Instance Core running',
      region: 'us-east4',
      unit: 'vCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.022,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.compute_engine',
      skuKey: 'Instance Ram running',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.003,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.cloud_sql_postgres',
      skuKey: 'PostgreSQL vCPU',
      region: 'us-east4',
      unit: 'vCPU-Hours',
      unitRole: 'vcpu_hour',
      unitPrice: 0.035,
      currency: 'USD',
    },
    {
      provider: 'gcp',
      serviceId: 'gcp.cloud_sql_postgres',
      skuKey: 'PostgreSQL RAM',
      region: 'us-east4',
      unit: 'GB-Hours',
      unitRole: 'memory_gb_hour',
      unitPrice: 0.006,
      currency: 'USD',
    },
  ],
};

describe('@infrasim/diagnosis T6.5 starter challenges & reference solutions', () => {
  it('ships all 10 challenges with broken starters failing and reference solutions passing', async () => {
    expect(STARTER_CHALLENGES).toHaveLength(10);

    for (const challenge of STARTER_CHALLENGES) {
      expect(challenge.referenceSolutionDesign).toBeDefined();

      const starterEval = await evaluateChallengeAttempt(challenge, challenge.starterDesign, {
        priceSnapshot: TEST_ONLY_CHALLENGE_PRICES,
      });
      expect(starterEval.passed, `Expected starter for ${challenge.slug} to fail`).toBe(false);

      const solutionEval = await evaluateChallengeAttempt(
        challenge,
        challenge.referenceSolutionDesign!,
        {
          priceSnapshot: TEST_ONLY_CHALLENGE_PRICES,
        },
      );
      const failedChecks = solutionEval.checks.filter((c) => !c.passed);
      expect(
        failedChecks,
        `Expected reference solution for ${challenge.slug} to pass all checks, got failed: ${JSON.stringify(failedChecks)} (metrics: ${JSON.stringify(solutionEval.metrics)})`,
      ).toEqual([]);
      expect(solutionEval.passed, `Expected reference solution for ${challenge.slug} to pass`).toBe(
        true,
      );
      expect(solutionEval.score).toBeGreaterThanOrEqual(50);
    }
  });
});
