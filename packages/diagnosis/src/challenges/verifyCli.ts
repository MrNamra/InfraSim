import type { PriceSnapshot } from '@infrasim/cost-engine';
import type { CallPlan, Challenge, Design } from '@infrasim/shared-types';
import { evaluateChallengeAttempt } from './evaluator.js';

interface VerifyPayload {
  challenge: Challenge;
  design: Design;
  priceSnapshot?: PriceSnapshot | null;
  callPlans?: Record<string, CallPlan>;
  requirePriceSnapshot?: boolean;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    process.stderr.write('Empty verification payload on stdin.\n');
    process.exit(2);
  }

  const payload = JSON.parse(raw) as VerifyPayload;
  const evaluation = await evaluateChallengeAttempt(payload.challenge, payload.design, {
    priceSnapshot: payload.priceSnapshot ?? null,
    ...(payload.callPlans ? { callPlans: payload.callPlans } : {}),
    ...(payload.requirePriceSnapshot !== undefined
      ? { requirePriceSnapshot: payload.requirePriceSnapshot }
      : {}),
  });
  process.stdout.write(JSON.stringify(evaluation));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
