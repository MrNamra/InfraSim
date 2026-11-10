import type { Design } from './design.js';

/** Schema version identifier for InfraSim design documents. */
export const SCHEMA_VERSION = 1 as const;

/** Creates a minimal valid empty Design document. */
export function createEmptyDesign(id = 'design-1', name = 'Untitled architecture'): Design {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    nodes: [],
    edges: [],
    groups: [],
    network: {},
    scenarios: [],
    scripts: [],
    fixtures: [],
    settings: {
      seed: 42,
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}
