import type {
  Design,
  NodeInstance,
  Scenario,
  TrafficProfile,
  UserFlow,
} from '@infrasim/shared-types';
import type { SeededRng } from './prng.js';

/** Evaluates configured request arrival rate (req/s) at virtual time `tS` in seconds. */
export function evaluateProfileRps(profile: TrafficProfile, tS: number, durationS: number): number {
  const safeT = Math.max(0, tS);
  const safeDuration = Math.max(0.001, durationS);

  switch (profile.kind) {
    case 'constant':
      return Math.max(0, profile.rps);

    case 'ramp': {
      const frac = Math.min(1, Math.max(0, safeT / safeDuration));
      return Math.max(0, profile.fromRps + (profile.toRps - profile.fromRps) * frac);
    }

    case 'spike': {
      const inSpike = safeT >= profile.atS && safeT < profile.atS + Math.max(0, profile.widthS);
      return Math.max(0, inSpike ? profile.peakRps : profile.baseRps);
    }

    case 'steps': {
      if (profile.steps.length === 0) {
        return 0;
      }
      const sorted = [...profile.steps].sort((a, b) => a.atS - b.atS);
      let activeRps = 0;
      for (const step of sorted) {
        if (safeT >= step.atS) {
          activeRps = step.rps;
        } else {
          break;
        }
      }
      return Math.max(0, activeRps);
    }

    case 'diurnal': {
      const period = Math.max(1, profile.periodS);
      const val = profile.meanRps + profile.amplitude * Math.sin((2 * Math.PI * safeT) / period);
      return Math.max(0, val);
    }

    case 'custom': {
      const pts = [...profile.points].sort((a, b) => a.tS - b.tS);
      if (pts.length === 0) {
        return 0;
      }
      if (safeT <= pts[0]!.tS) {
        return Math.max(0, pts[0]!.rps);
      }
      const last = pts[pts.length - 1]!;
      if (safeT >= last.tS) {
        return Math.max(0, last.rps);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (safeT >= a.tS && safeT <= b.tS) {
          const span = Math.max(1e-6, b.tS - a.tS);
          const frac = (safeT - a.tS) / span;
          return Math.max(0, a.rps + (b.rps - a.rps) * frac);
        }
      }
      return 0;
    }
  }
}

/** Numerically estimates total incoming client requests over `[0, durationS]` for event scaling. */
export function estimateProfileTotalRequests(profile: TrafficProfile, durationS: number): number {
  const safeDur = Math.max(0, durationS);
  if (safeDur === 0) {
    return 0;
  }
  const steps = Math.max(120, Math.ceil(safeDur * 4));
  const dt = safeDur / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const midS = (i + 0.5) * dt;
    sum += evaluateProfileRps(profile, midS, safeDur) * dt;
  }
  return sum;
}

/** Samples points along a traffic profile curve for sparkline or preview chart rendering. */
export function sampleProfileCurve(
  profile: TrafficProfile,
  durationS: number,
  pointCount = 60,
): { tS: number; rps: number }[] {
  const count = Math.max(2, pointCount);
  const safeDur = Math.max(1, durationS);
  const out: { tS: number; rps: number }[] = [];
  for (let i = 0; i < count; i++) {
    const tS = (i / (count - 1)) * safeDur;
    out.push({ tS, rps: evaluateProfileRps(profile, tS, safeDur) });
  }
  return out;
}

function maxProfileRateInInterval(
  profile: TrafficProfile,
  t0S: number,
  t1S: number,
  durationS: number,
): number {
  if (profile.kind === 'spike') {
    const s0 = profile.atS;
    const s1 = profile.atS + Math.max(0, profile.widthS);
    const overlaps = t1S > s0 && t0S < s1;
    return Math.max(0, overlaps ? Math.max(profile.baseRps, profile.peakRps) : profile.baseRps);
  }
  if (profile.kind === 'diurnal') {
    return Math.max(0, profile.meanRps + Math.abs(profile.amplitude));
  }
  if (profile.kind === 'steps') {
    let maxVal = 0;
    const eps = 1e-6;
    maxVal = Math.max(maxVal, evaluateProfileRps(profile, t0S + eps, durationS));
    maxVal = Math.max(maxVal, evaluateProfileRps(profile, Math.max(t0S, t1S - eps), durationS));
    for (const step of profile.steps) {
      if (step.atS >= t0S && step.atS <= t1S) {
        maxVal = Math.max(maxVal, step.rps);
      }
    }
    return Math.max(0, maxVal);
  }
  if (profile.kind === 'custom') {
    let maxVal = Math.max(
      evaluateProfileRps(profile, t0S, durationS),
      evaluateProfileRps(profile, t1S, durationS),
    );
    for (const pt of profile.points) {
      if (pt.tS >= t0S && pt.tS <= t1S) {
        maxVal = Math.max(maxVal, pt.rps);
      }
    }
    return Math.max(0, maxVal);
  }
  return Math.max(
    0,
    evaluateProfileRps(profile, t0S, durationS),
    evaluateProfileRps(profile, t1S, durationS),
  );
}

/**
 * Creates a memory-constant streaming non-homogeneous Poisson arrival generator using
 * piecewise Lewis-Shedler thinning across 250 ms intervals.
 */
export function createArrivalStream(
  profile: TrafficProfile,
  durationS: number,
  scaleFactor: number,
  rng: SeededRng,
): () => number | null {
  const endMs = Math.max(0, durationS * 1000);
  const binWidthMs = 250;
  const safeScale = Math.max(1, scaleFactor);

  let binIndex = 0;
  let tMs = 0;

  return () => {
    while (tMs < endMs) {
      const binStartMs = binIndex * binWidthMs;
      const binEndMs = Math.min(endMs, binStartMs + binWidthMs);
      if (tMs >= binEndMs) {
        binIndex += 1;
        tMs = binIndex * binWidthMs;
        continue;
      }

      const maxRps =
        maxProfileRateInInterval(profile, binStartMs / 1000, binEndMs / 1000, durationS) /
        safeScale;

      if (maxRps <= 0) {
        binIndex += 1;
        tMs = binEndMs;
        continue;
      }

      const u = Math.max(1e-12, 1 - rng.next());
      const dtMs = (-Math.log(u) / maxRps) * 1000;
      const candidateMs = tMs + dtMs;

      if (candidateMs >= binEndMs) {
        binIndex += 1;
        tMs = binEndMs;
        continue;
      }

      tMs = candidateMs;
      const actualRps = evaluateProfileRps(profile, tMs / 1000, durationS) / safeScale;
      if (actualRps > 0 && rng.next() * maxRps <= actualRps) {
        return tMs;
      }
    }

    return null;
  };
}

/** Picks a user flow deterministically according to normalized flow weights. */
export function pickWeightedUserFlow(
  flows: readonly UserFlow[],
  rng: SeededRng,
): UserFlow | undefined {
  if (flows.length === 0) {
    return undefined;
  }
  if (flows.length === 1) {
    return flows[0];
  }
  let total = 0;
  for (const flow of flows) {
    total += Math.max(0, flow.weight);
  }
  if (total <= 0) {
    return flows[0];
  }
  let cursor = rng.next() * total;
  for (const flow of flows) {
    cursor -= Math.max(0, flow.weight);
    if (cursor <= 0) {
      return flow;
    }
  }
  return flows[flows.length - 1];
}

/** Resolves the client entry node driving request generation for a scenario. */
export function resolveScenarioEntryNode(
  design: Design,
  scenario: Scenario,
): NodeInstance | undefined {
  if (scenario.entryNodeId) {
    const exact = design.nodes.find((n) => n.id === scenario.entryNodeId);
    if (exact) {
      return exact;
    }
  }
  return (
    design.nodes.find((n) => n.serviceId === 'generic.client' || n.serviceId === 'generic.users') ??
    design.nodes[0]
  );
}
