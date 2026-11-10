import type { JsonPatchOp } from '@infrasim/shared-types';

function decodePointerSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function getParentAndKey(
  root: unknown,
  path: string,
): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (!path.startsWith('/')) {
    throw new Error(`Invalid JSON Patch pointer "${path}"`);
  }
  const parts = path.slice(1).split('/').map(decodePointerSegment);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
    throw new Error('Cannot target document root in applyJsonPatch');
  }

  let cursor: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (Array.isArray(cursor)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        throw new Error(`Invalid array index "${key}" in path "${path}"`);
      }
      cursor = cursor[idx];
    } else if (cursor && typeof cursor === 'object') {
      const obj = cursor as Record<string, unknown>;
      if (!(key in obj) || obj[key] === undefined) {
        // Create missing intermediate config containers cleanly when adding nested fields
        obj[key] = {};
      }
      cursor = obj[key];
    } else {
      throw new Error(`Cannot traverse non-container at "${key}" in "${path}"`);
    }
  }

  if (!cursor || typeof cursor !== 'object') {
    throw new Error(`Target parent is not an object or array for "${path}"`);
  }
  return { parent: cursor as Record<string, unknown> | unknown[], key: parts[parts.length - 1]! };
}

/**
 * Applies a minimal RFC 6902 JSON Patch sequence to a cloned copy of `doc` cleanly.
 * Never mutates the input document.
 */
export function applyJsonPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  const copy = structuredClone(doc);
  for (const op of ops) {
    const { parent, key } = getParentAndKey(copy, op.path);
    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        if (key === '-') {
          parent.push(structuredClone(op.value));
        } else {
          const idx = Number(key);
          if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
            throw new Error(`Invalid add index "${key}"`);
          }
          parent.splice(idx, 0, structuredClone(op.value));
        }
      } else if (op.op === 'replace') {
        const idx = Number(key);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error(`Invalid replace index "${key}"`);
        }
        parent[idx] = structuredClone(op.value);
      } else if (op.op === 'remove') {
        const idx = Number(key);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error(`Invalid remove index "${key}"`);
        }
        parent.splice(idx, 1);
      }
    } else {
      if (op.op === 'add' || op.op === 'replace') {
        parent[key] = structuredClone(op.value);
      } else if (op.op === 'remove') {
        delete parent[key];
      }
    }
  }
  return copy;
}
