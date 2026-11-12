import type { Design } from '@infrasim/shared-types';

/** Strips mock environment variables and script secrets before encoding or sharing a design. */
export function sanitizeDesignForShare(design: Design): Design {
  const clone = structuredClone(design);
  clone.nodes = clone.nodes.map((node) => {
    const nextConfig = { ...node.config };
    delete nextConfig.mockEnv;
    return {
      ...node,
      config: nextConfig,
    };
  });
  clone.scripts = clone.scripts.map((script) => ({
    ...script,
    env: {},
  }));
  return clone;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  const b64 = typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encodes a sanitized read-only `Design` snapshot into a URL-safe hash fragment (`d=...`). */
export function encodeSharedDesignFragment(design: Design): string {
  const clean = sanitizeDesignForShare(design);
  const json = JSON.stringify(clean);
  const bytes = new TextEncoder().encode(json);
  return `d=${bytesToBase64Url(bytes)}`;
}

/** Decodes and validates a `d=...` URL hash fragment into a read-only `Design` or returns `null`. */
export function decodeSharedDesignFragment(fragment: string): Design | null {
  try {
    const trimmed = fragment.startsWith('#') ? fragment.slice(1) : fragment;
    const params = new URLSearchParams(trimmed);
    const encoded = params.get('d');
    if (!encoded) return null;
    const bytes = base64UrlToBytes(encoded);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as Partial<Design>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) {
      return null;
    }
    return sanitizeDesignForShare({
      schemaVersion: 1,
      id: typeof parsed.id === 'string' ? parsed.id : 'shared-design',
      name: typeof parsed.name === 'string' ? parsed.name : 'Shared architecture',
      nodes: parsed.nodes,
      edges: parsed.edges,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      network: parsed.network ?? {},
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [],
      scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
      fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures : [],
      settings: parsed.settings ?? { seed: 42, currency: 'USD', includeFreeTier: true },
      ...(parsed.customServices ? { customServices: parsed.customServices } : {}),
    });
  } catch {
    return null;
  }
}
