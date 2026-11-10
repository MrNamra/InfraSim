import { SCHEMA_VERSION } from '@infrasim/shared-types';

/** Returns the supported design schema version for the discrete-event engine. */
export function getEngineSchemaVersion(): number {
  return SCHEMA_VERSION;
}

export * from './circuitBreaker.js';
export * from './engine.js';
export * from './erlang.js';
export * from './health.js';
export * from './histogram.js';
export * from './networkLatency.js';
export * from './prng.js';
export * from './heap.js';
export * from './latency.js';
export * from './runtimePresets.js';
export * from './stations.js';
export * from './traffic.js';
