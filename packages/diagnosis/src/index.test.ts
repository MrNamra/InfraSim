import { describe, expect, it } from 'vitest';
import { DIAGNOSIS_READY } from './index.js';

describe('@infrasim/diagnosis skeleton', () => {
  it('loads module', () => {
    expect(DIAGNOSIS_READY).toBe(true);
  });
});
