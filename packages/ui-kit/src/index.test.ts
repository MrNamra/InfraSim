import { describe, expect, it } from 'vitest';
import { UI_KIT_VERSION } from './index.js';

describe('@infrasim/ui-kit skeleton', () => {
  it('exports package version', () => {
    expect(UI_KIT_VERSION).toBe('0.1.0');
  });
});
