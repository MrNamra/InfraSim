import { SCHEMA_VERSION } from '@infrasim/shared-types';

/** Returns the supported design schema version for the discrete-event engine. */
export function getEngineSchemaVersion(): number {
  return SCHEMA_VERSION;
}

export * from './prng.js';
export * from './heap.js';
export * from './latency.js';
export * from './runtimePresets.js';
export * from './stations.js';
export * from './traffic.js';
