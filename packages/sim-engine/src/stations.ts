import type { ResolvedNodeCapacities } from './runtimePresets.js';

/** Continuous-refill token bucket limiter for RPS / throttling. */
export interface TokenBucket {
  ratePerMs: number;
  capacity: number;
  tokens: number;
  lastRefillMs: number;
}

/** Creates an initialized full token bucket. */
export function createTokenBucket(rps: number, burst: number, startMs = 0): TokenBucket {
  const cap = Math.max(1, burst);
  return {
    ratePerMs: Math.max(0, rps) / 1000,
    capacity: cap,
    tokens: cap,
    lastRefillMs: startMs,
  };
}

/** Refills and attempts to consume `count` tokens at virtual timestamp `nowMs`. */
export function tryConsumeToken(bucket: TokenBucket, nowMs: number, count = 1): boolean {
  if (nowMs > bucket.lastRefillMs) {
    const elapsed = nowMs - bucket.lastRefillMs;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.ratePerMs);
    bucket.lastRefillMs = nowMs;
  }
  if (bucket.tokens >= count) {
    bucket.tokens -= count;
    return true;
  }
  return false;
}

export interface QueuedSlotEntry<TReq> {
  req: TReq;
  enqueuedAtMs: number;
}

export interface QueuedCoreEntry<TItem> {
  item: TItem;
  cpuMs: number;
  enqueuedAtMs: number;
}

export interface QueuedConnEntry<TItem> {
  item: TItem;
  enqueuedAtMs: number;
  timeoutAtMs: number;
}

/** Live station resource state for a service node inside a single DES run. */
export interface StationState<TReq = unknown, TCore = unknown, TConn = unknown> {
  nodeId: string;
  instancesTotal: number;
  instancesActive: number;
  slotsPerInstance: number;
  slotsCapacity: number;
  inFlight: number;
  coresCapacity: number;
  busyCores: number;
  cpuSpeedMultiplier: number;
  queueMaxLength: number;
  queuePolicy: 'reject' | 'drop-oldest';
  slotQueue: QueuedSlotEntry<TReq>[];
  coreQueue: QueuedCoreEntry<TCore>[];
  connectionsMax: number | null;
  busyConnections: number;
  connQueue: QueuedConnEntry<TConn>[];
  rateBucket: TokenBucket | null;
  lastIntegralMs: number;
  slotBusyAreaMs: number;
  coreBusyAreaMs: number;
  connBusyAreaMs: number;
  queueIntegralMs: number;
}

/** Creates an empty StationState seeded from resolved node capacities. */
export function createStationState<TReq = unknown, TCore = unknown, TConn = unknown>(
  nodeId: string,
  capacities: ResolvedNodeCapacities,
  startMs = 0,
): StationState<TReq, TCore, TConn> {
  return {
    nodeId,
    instancesTotal: capacities.instances,
    instancesActive: capacities.instances,
    slotsPerInstance: capacities.slotsPerInstance,
    slotsCapacity: capacities.totalSlots,
    inFlight: 0,
    coresCapacity: capacities.totalCores,
    busyCores: 0,
    cpuSpeedMultiplier: capacities.cpuSpeedMultiplier,
    queueMaxLength: capacities.queueMaxLength,
    queuePolicy: capacities.queuePolicy,
    slotQueue: [],
    coreQueue: [],
    connectionsMax: capacities.connectionsMax,
    busyConnections: 0,
    connQueue: [],
    rateBucket:
      capacities.rateLimitRps !== null
        ? createTokenBucket(capacities.rateLimitRps, capacities.rateLimitBurst, startMs)
        : null,
    lastIntegralMs: startMs,
    slotBusyAreaMs: 0,
    coreBusyAreaMs: 0,
    connBusyAreaMs: 0,
    queueIntegralMs: 0,
  };
}

/** Integrates piecewise-constant resource occupancy areas up to virtual timestamp `nowMs`. */
export function advanceStationIntegrals<TReq, TCore, TConn>(
  station: StationState<TReq, TCore, TConn>,
  nowMs: number,
): void {
  const dt = nowMs - station.lastIntegralMs;
  if (dt > 0) {
    station.slotBusyAreaMs += dt * station.inFlight;
    station.coreBusyAreaMs += dt * station.busyCores;
    station.connBusyAreaMs += dt * station.busyConnections;
    station.queueIntegralMs += dt * (station.slotQueue.length + station.coreQueue.length);
    station.lastIntegralMs = nowMs;
  }
}

/**
 * Drains and resets the integrated busy areas over the completed window,
 * returning exact time-averaged utilization metrics.
 */
export function consumeStationWindowIntegrals<TReq, TCore, TConn>(
  station: StationState<TReq, TCore, TConn>,
  windowEndMs: number,
  windowDurationMs: number,
): {
  slotUtil: number;
  cpuUtil: number;
  connUtil: number;
  avgQueueDepth: number;
  avgInFlight: number;
} {
  advanceStationIntegrals(station, windowEndMs);
  const safeDur = Math.max(1, windowDurationMs);
  const slotDenom = safeDur * Math.max(1, station.slotsCapacity);
  const slotUtil = station.instancesActive <= 0 ? 0 : station.slotBusyAreaMs / slotDenom;
  const cpuUtil =
    station.coresCapacity > 0 && station.instancesActive > 0
      ? station.coreBusyAreaMs / (safeDur * station.coresCapacity)
      : 0;
  const connUtil =
    station.connectionsMax !== null && station.connectionsMax > 0 && station.instancesActive > 0
      ? station.connBusyAreaMs / (safeDur * station.connectionsMax)
      : 0;
  const avgQueueDepth = station.queueIntegralMs / safeDur;
  const avgInFlight = station.slotBusyAreaMs / safeDur;

  station.slotBusyAreaMs = 0;
  station.coreBusyAreaMs = 0;
  station.connBusyAreaMs = 0;
  station.queueIntegralMs = 0;

  return { slotUtil, cpuUtil, connUtil, avgQueueDepth, avgInFlight };
}

export type SlotAcquireResult<TReq> =
  | { status: 'acquired' }
  | { status: 'queued'; evicted?: QueuedSlotEntry<TReq> }
  | { status: 'rejected' }
  | { status: 'down' };

/**
 * Attempts to acquire a concurrency slot at `nowMs`.
 * If all active slots are busy, either enqueues FIFO (with optional `drop-oldest` eviction) or rejects.
 */
export function tryAcquireOrEnqueueSlot<TReq>(
  station: StationState<TReq>,
  req: TReq,
  nowMs: number,
): SlotAcquireResult<TReq> {
  advanceStationIntegrals(station, nowMs);
  if (station.instancesActive <= 0) {
    return { status: 'down' };
  }
  const activeSlots = Math.max(
    1,
    Math.round(
      (station.slotsCapacity * station.instancesActive) / Math.max(1, station.instancesTotal),
    ),
  );
  if (station.inFlight < activeSlots) {
    station.inFlight += 1;
    return { status: 'acquired' };
  }
  if (station.queueMaxLength <= 0) {
    return { status: 'rejected' };
  }
  if (station.slotQueue.length < station.queueMaxLength) {
    station.slotQueue.push({ req, enqueuedAtMs: nowMs });
    return { status: 'queued' };
  }
  if (station.queuePolicy === 'drop-oldest') {
    const evicted = station.slotQueue.shift();
    station.slotQueue.push({ req, enqueuedAtMs: nowMs });
    return { status: 'queued', evicted };
  }
  return { status: 'rejected' };
}

/**
 * Releases one slot and promotes the head queued request (if any and station is active).
 * Keeps slot busy cleanly when handing directly to the next queued request.
 */
export function releaseSlotAndDequeue<TReq>(
  station: StationState<TReq>,
  nowMs: number,
): QueuedSlotEntry<TReq> | undefined {
  advanceStationIntegrals(station, nowMs);
  const activeSlots =
    station.instancesActive <= 0
      ? 0
      : Math.max(
          1,
          Math.round(
            (station.slotsCapacity * station.instancesActive) / Math.max(1, station.instancesTotal),
          ),
        );

  if (station.slotQueue.length > 0 && station.inFlight <= activeSlots && activeSlots > 0) {
    return station.slotQueue.shift();
  }
  station.inFlight = Math.max(0, station.inFlight - 1);
  return undefined;
}

/** Attempts to claim a CPU core; queues FIFO if all cores are busy. */
export function acquireCoreOrQueue<TReq, TCore>(
  station: StationState<TReq, TCore>,
  item: TCore,
  rawCpuMs: number,
  nowMs: number,
): { acquired: boolean; effectiveCpuMs: number } {
  advanceStationIntegrals(station, nowMs);
  const effectiveCpuMs = Math.max(0.01, rawCpuMs * station.cpuSpeedMultiplier);
  if (station.coresCapacity <= 0) {
    return { acquired: true, effectiveCpuMs };
  }
  const activeCores =
    station.instancesActive <= 0
      ? 0
      : Math.max(
          1,
          Math.round(
            (station.coresCapacity * station.instancesActive) / Math.max(1, station.instancesTotal),
          ),
        );
  if (station.busyCores < activeCores) {
    station.busyCores += 1;
    return { acquired: true, effectiveCpuMs };
  }
  station.coreQueue.push({ item, cpuMs: effectiveCpuMs, enqueuedAtMs: nowMs });
  return { acquired: false, effectiveCpuMs };
}

/** Releases a CPU core and promotes the next queued CPU task if present. */
export function releaseCoreAndDequeue<TReq, TCore>(
  station: StationState<TReq, TCore>,
  nowMs: number,
): QueuedCoreEntry<TCore> | undefined {
  advanceStationIntegrals(station, nowMs);
  if (station.coresCapacity <= 0) {
    return undefined;
  }
  if (station.coreQueue.length > 0) {
    return station.coreQueue.shift();
  }
  station.busyCores = Math.max(0, station.busyCores - 1);
  return undefined;
}
