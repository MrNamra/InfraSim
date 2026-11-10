import { describe, expect, it } from 'vitest';
import { DEFAULT_HOURS_PER_MONTH } from './index.js';

describe('@infrasim/cost-engine skeleton', () => {
  it('uses 730 hours per month by default', () => {
    expect(DEFAULT_HOURS_PER_MONTH).toBe(730);
  });
});
