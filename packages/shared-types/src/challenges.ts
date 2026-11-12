import type { Design, Scenario } from './design.js';

/** Difficulty tier displayed on challenge cards and badges. */
export type ChallengeDifficulty = 'beginner' | 'intermediate' | 'advanced';

/** Architectural capability checks verified against design topology & config. */
export type ChallengeCapability =
  'multi-az' | 'cache' | 'async-queue' | 'private-db' | 'dlq' | 'autoscaling';

/** Forbidden network/security anti-patterns checked by challenge rules. */
export type ChallengeForbiddenSmell = 'public-db' | 'wide-open-ingress';

/** Hard pass/fail constraints checked deterministically after simulation. */
export interface ChallengeConstraints {
  maxMonthlyCostUsd?: number;
  p95MsMax?: number;
  p99MsMax?: number;
  errorRateMax?: number;
  minAvailabilityUnderChaos?: number;
  requiredCapabilities?: ChallengeCapability[];
  mustBeReachable?: { from: string; to: string; port: number }[];
  forbidden?: ChallengeForbiddenSmell[];
  requiredProviders?: ('aws' | 'gcp' | 'azure' | 'oci')[];
}

/** Sub-score category weights summing to ~1.0. */
export interface ChallengeScoringWeights {
  latency: number;
  cost: number;
  resilience: number;
  security: number;
  simplicity: number;
}

/** Progressive hint unlocked after N failed attempts. */
export interface ChallengeHint {
  afterAttempts: number;
  text: string;
}

/** Full challenge specification matching Spec 17 §6.1. */
export interface Challenge {
  slug: string;
  title: string;
  difficulty: ChallengeDifficulty;
  story: string;
  learningGoals: string[];
  starterDesign: Design;
  allowedServices?: string[];
  fixedScenario: Scenario;
  fixedSeed: number;
  pinnedPriceSnapshotId: string;
  constraints: ChallengeConstraints;
  scoring: {
    weights: ChallengeScoringWeights;
  };
  hints: ChallengeHint[];
  whatThisTeaches: string;
  referenceSolutionDesign?: Design;
  published: boolean;
}

/** Individual hard-constraint verdict rendered in the live challenge banner. */
export interface ChallengeConstraintCheck {
  id: string;
  label: string;
  passed: boolean;
  actual?: string;
  target?: string;
}

/** Normalized 0-100 sub-scores per category. */
export interface ChallengeSubScores {
  latency: number;
  cost: number;
  resilience: number;
  security: number;
  simplicity: number;
}

/** Deterministic evaluation output shared identically by client preview and server verifier. */
export interface ChallengeAttemptResult {
  passed: boolean;
  score: number;
  subScores: ChallengeSubScores;
  checks: ChallengeConstraintCheck[];
  metrics: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    errorRate: number;
    availability: number;
    monthlyCostUsd: number;
    totalRequests: number;
    nodeCount: number;
  };
  seed: number;
  snapshotId: string;
}
