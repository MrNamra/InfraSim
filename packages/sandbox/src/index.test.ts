import { describe, expect, it } from 'vitest';
import { SANDBOX_DEFAULT_MEMORY_MB } from './index.js';

describe('@infrasim/sandbox skeleton', () => {
  it('defines default memory limit', () => {
    expect(SANDBOX_DEFAULT_MEMORY_MB).toBe(128);
  });
});
