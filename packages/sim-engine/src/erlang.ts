/**
 * Overflow-safe analytical Erlang C queueing formula for `c` parallel servers,
 * arrival rate `lambdaPerS` (req/s), and mean service time `meanServiceMs` per server.
 * Used as the dotted theoretical baseline overlay on utilization/latency charts.
 */
export function computeErlangC(
  c: number,
  lambdaPerS: number,
  meanServiceMs: number,
): {
  utilizationRho: number;
  blockingProb: number;
  expectedWaitMs: number;
  expectedTotalMs: number;
} {
  const servers = Math.max(1, Math.round(c));
  const safeLambda = Math.max(0, lambdaPerS);
  const safeServiceMs = Math.max(0.01, meanServiceMs);
  const muPerS = 1000 / safeServiceMs;

  if (safeLambda === 0) {
    return {
      utilizationRho: 0,
      blockingProb: 0,
      expectedWaitMs: 0,
      expectedTotalMs: safeServiceMs,
    };
  }

  const offeredLoadA = safeLambda / muPerS;
  const rho = offeredLoadA / servers;

  if (rho >= 0.9999) {
    return {
      utilizationRho: Math.min(1.5, rho),
      blockingProb: 1,
      expectedWaitMs: Number.POSITIVE_INFINITY,
      expectedTotalMs: Number.POSITIVE_INFINITY,
    };
  }

  // Numerical overflow-safe Erlang B -> Erlang C conversion via recurrence:
  // invB(0) = 1; invB(k) = 1 + (k / a) * invB(k - 1)
  let invB = 1;
  for (let k = 1; k <= servers; k++) {
    invB = 1 + (k / offeredLoadA) * invB;
  }
  const erlangB = 1 / invB;
  const erlangC = erlangB / (1 - rho * (1 - erlangB));
  const clampedC = Math.min(1, Math.max(0, Number.isFinite(erlangC) ? erlangC : 1));

  const denominator = servers * muPerS - safeLambda;
  const expectedWaitMs =
    denominator > 0 ? (clampedC / denominator) * 1000 : Number.POSITIVE_INFINITY;

  return {
    utilizationRho: rho,
    blockingProb: clampedC,
    expectedWaitMs,
    expectedTotalMs: Number.isFinite(expectedWaitMs)
      ? safeServiceMs + expectedWaitMs
      : expectedWaitMs,
  };
}
