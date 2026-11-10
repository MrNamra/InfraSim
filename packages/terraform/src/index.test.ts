import { describe, expect, it } from 'vitest';
import { TERRAFORM_MAX_INPUT_BYTES } from './index.js';

describe('@infrasim/terraform skeleton', () => {
  it('caps imported plan size at 5 MB', () => {
    expect(TERRAFORM_MAX_INPUT_BYTES).toBe(5 * 1024 * 1024);
  });
});
