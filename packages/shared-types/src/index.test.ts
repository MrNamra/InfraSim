import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from './index.js';

describe('@infrasim/shared-types skeleton', () => {
  it('exports schema version 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
