import { describe, expect, it } from 'vitest';
import { createEmptyDesign } from '@infrasim/shared-types';
import { decodeSharedDesignFragment, encodeSharedDesignFragment } from './shareEncoding';

describe('T6.6 read-only share snapshot encoding', () => {
  it('strips node mockEnv and script env secrets and round-trips safely', () => {
    const design = createEmptyDesign('share-1', 'Payment Flow');
    design.nodes = [
      {
        id: 'api',
        serviceId: 'aws.ec2',
        label: 'API',
        position: { x: 100, y: 120 },
        config: {
          instances: 2,
          mockEnv: { API_SECRET: 'CANARY_DO_NOT_LEAK' },
          operations: {},
        },
      },
    ];
    design.scripts = [
      {
        id: 's1',
        name: 'handler.js',
        kind: 'handler',
        language: 'javascript',
        source: 'export default () => ({ status: 200 })',
        entry: 'default',
        memoryMb: 128,
        timeoutMs: 250,
        env: { JWT_KEY: 'CANARY_JWT_999' },
      },
    ];

    const fragment = encodeSharedDesignFragment(design);
    const decoded = decodeSharedDesignFragment(`#${fragment}`);

    expect(decoded).not.toBeNull();
    expect(decoded?.name).toBe('Payment Flow');
    expect(decoded?.nodes[0]?.config.mockEnv).toBeUndefined();
    expect(decoded?.scripts[0]?.env).toEqual({});
    expect(JSON.stringify(decoded)).not.toContain('CANARY_DO_NOT_LEAK');
    expect(JSON.stringify(decoded)).not.toContain('CANARY_JWT_999');
  });

  it('returns null on malformed fragments', () => {
    expect(decodeSharedDesignFragment('')).toBeNull();
    expect(decodeSharedDesignFragment('#d=not_valid_base64!!')).toBeNull();
  });
});
