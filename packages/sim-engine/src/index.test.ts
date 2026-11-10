import { describe, expect, it } from 'vitest';
import { getEngineSchemaVersion } from './index.js';

describe('@infrasim/sim-engine skeleton', () => {
  it('references shared-types schema version', () => {
    expect(getEngineSchemaVersion()).toBe(1);
  });
});
