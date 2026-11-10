import type { HealthState } from '@infrasim/shared-types';

/** Centralized health classification constants from spec 05 §9. */
export const HEALTH_THRESHOLDS = {
  EMA_ALPHA: 0.5,
  WARM_UTIL: 0.6,
  HOT_UTIL: 0.8,
  OVERLOADED_UTIL: 0.95,
  RECOVERY_UTIL: 0.9,
  OVERLOAD_ENTER_STREAK: 2,
  OVERLOAD_LEAVE_STREAK: 3,
  QUEUE_GROWTH_STREAK: 5,
  THROTTLED_RATIO: 0.01,
} as const;

/** Mutable per-node health smoothing & hysteresis tracker evaluated every 1-second bucket. */
export interface NodeHealthTracker {
  state: HealthState;
  emaUtil: number;
  initialized: boolean;
  overloadTriggerStreak: number;
  recoveryStreak: number;
  queueGrowthStreak: number;
  prevQueueDepth: number;
}

/** Creates an initialized healthy `NodeHealthTracker`. */
export function createNodeHealthTracker(): NodeHealthTracker {
  return {
    state: 'ok',
    emaUtil: 0,
    initialized: false,
    overloadTriggerStreak: 0,
    recoveryStreak: 0,
    queueGrowthStreak: 0,
    prevQueueDepth: 0,
  };
}

export interface HealthBucketSample {
  rawUtil: number;
  instancesActive: number;
  dropsCount: number;
  throttledCount: number;
  arrivalsCount: number;
  endQueueDepth: number;
}

/**
 * Updates smoothed utilization (EMA α=0.5) and transitions node health using hysteresis rules:
 * enters `overloaded` after 2 consecutive qualifying buckets, leaves only after 3 consecutive buckets < 0.90.
 */
export function evaluateNodeHealthStep(
  tracker: NodeHealthTracker,
  sample: HealthBucketSample,
): { health: HealthState; smoothedUtil: number } {
  const safeRaw = Number.isFinite(sample.rawUtil) ? Math.max(0, sample.rawUtil) : 0;
  tracker.emaUtil = tracker.initialized
    ? HEALTH_THRESHOLDS.EMA_ALPHA * safeRaw + (1 - HEALTH_THRESHOLDS.EMA_ALPHA) * tracker.emaUtil
    : safeRaw;
  tracker.initialized = true;

  if (sample.instancesActive <= 0) {
    tracker.state = 'down';
    tracker.overloadTriggerStreak = 0;
    tracker.recoveryStreak = 0;
    tracker.prevQueueDepth = sample.endQueueDepth;
    return { health: 'down', smoothedUtil: tracker.emaUtil };
  }

  if (sample.endQueueDepth > tracker.prevQueueDepth && sample.endQueueDepth > 0) {
    tracker.queueGrowthStreak += 1;
  } else {
    tracker.queueGrowthStreak = 0;
  }
  tracker.prevQueueDepth = sample.endQueueDepth;

  const throttledRatio =
    sample.arrivalsCount > 0 ? sample.throttledCount / sample.arrivalsCount : 0;

  const overloadConditionMet =
    tracker.emaUtil >= HEALTH_THRESHOLDS.OVERLOADED_UTIL ||
    sample.dropsCount > 0 ||
    tracker.queueGrowthStreak >= HEALTH_THRESHOLDS.QUEUE_GROWTH_STREAK ||
    throttledRatio > HEALTH_THRESHOLDS.THROTTLED_RATIO;

  if (tracker.state === 'overloaded') {
    const cleanBelowRecovery =
      tracker.emaUtil < HEALTH_THRESHOLDS.RECOVERY_UTIL &&
      sample.dropsCount === 0 &&
      throttledRatio <= HEALTH_THRESHOLDS.THROTTLED_RATIO &&
      tracker.queueGrowthStreak === 0;
    if (cleanBelowRecovery) {
      tracker.recoveryStreak += 1;
    } else {
      tracker.recoveryStreak = 0;
    }
    if (tracker.recoveryStreak >= HEALTH_THRESHOLDS.OVERLOAD_LEAVE_STREAK) {
      tracker.recoveryStreak = 0;
      tracker.overloadTriggerStreak = 0;
      tracker.state = classifyNonOverloaded(tracker.emaUtil);
    }
    return { health: tracker.state, smoothedUtil: tracker.emaUtil };
  }

  if (overloadConditionMet) {
    tracker.overloadTriggerStreak += 1;
    if (tracker.overloadTriggerStreak >= HEALTH_THRESHOLDS.OVERLOAD_ENTER_STREAK) {
      tracker.state = 'overloaded';
      tracker.recoveryStreak = 0;
      return { health: 'overloaded', smoothedUtil: tracker.emaUtil };
    }
  } else {
    tracker.overloadTriggerStreak = 0;
  }

  tracker.state = classifyNonOverloaded(tracker.emaUtil);
  return { health: tracker.state, smoothedUtil: tracker.emaUtil };
}

function classifyNonOverloaded(util: number): HealthState {
  if (util >= HEALTH_THRESHOLDS.HOT_UTIL) {
    return 'hot';
  }
  if (util >= HEALTH_THRESHOLDS.WARM_UTIL) {
    return 'warm';
  }
  return 'ok';
}
