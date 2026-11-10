import { describe, expect, it } from 'vitest';
import { NETWORK_ANALYZER_READY } from './index.js';

describe('@infrasim/network-analyzer skeleton', () => {
  it('loads module', () => {
    expect(NETWORK_ANALYZER_READY).toBe(true);
  });
});
