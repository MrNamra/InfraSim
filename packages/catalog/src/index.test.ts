import { describe, expect, it } from 'vitest';
import { getCatalogSchemaVersion } from './index.js';

describe('@infrasim/catalog skeleton', () => {
  it('references shared-types schema version', () => {
    expect(getCatalogSchemaVersion()).toBe(1);
  });
});
