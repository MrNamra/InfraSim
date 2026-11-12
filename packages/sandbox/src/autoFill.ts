import { getService, evaluateResponseTemplate, validateResponseTemplate } from '@infrasim/catalog';
import { resolveCanonicalServiceId } from './mockResolver.js';
import { executeInSandbox } from './runtime.js';
import type { AutoFillPatchPreview, DryRunInput, DryRunResult } from './types.js';

const ITERABLE_COLLECTION_NAMES = new Set(['Items', 'items', 'records', 'results', 'rows', 'data']);

interface RawTokenHolder {
  __rawExpr: string;
}

function isRawToken(val: unknown): val is RawTokenHolder {
  return (
    Boolean(val) &&
    typeof val === 'object' &&
    '__rawExpr' in (val as Record<string, unknown>) &&
    typeof (val as Record<string, unknown>).__rawExpr === 'string'
  );
}

/** Infers a seeded template expression or literal value from a field name per §6.2 heuristics. */
export function inferFieldTemplateValue(
  fieldName: string,
): { kind: 'literal'; value: string | number | boolean } | { kind: 'raw'; expr: string } {
  const key = fieldName.trim();
  if (/^(?:id|uuid|.*_id)$/i.test(key) || /Id$/.test(key)) {
    return { kind: 'literal', value: '{{faker.uuid}}' };
  }
  if (/email/i.test(key)) {
    return { kind: 'literal', value: '{{faker.email}}' };
  }
  if (/^(?:.*_)?(?:name|title)$/i.test(key) || /(?:Name|Title)$/.test(key)) {
    return { kind: 'literal', value: '{{faker.name}}' };
  }
  if (
    /^(?:.*_)?(?:count|total|quantity|size|age)$/i.test(key) ||
    /(?:Count|Total|Quantity|Size|Age)$/.test(key)
  ) {
    return { kind: 'raw', expr: '{{faker.int(1,100)}}' };
  }
  if (/^(?:.*_)?(?:price|amount|score)$/i.test(key) || /(?:Price|Amount|Score)$/.test(key)) {
    return { kind: 'raw', expr: '{{faker.int(10,99)}}.{{faker.int(10,99)}}' };
  }
  if (/^(?:is[A-Z_].*|has[A-Z_].*|is|has|enabled|.*Flag|.*_flag)$/.test(key)) {
    return { kind: 'literal', value: true };
  }
  if (
    /(?:At|Date)$/.test(key) ||
    /(?:_at|_date)$/i.test(key) ||
    /^(?:timestamp|created|updated)$/i.test(key)
  ) {
    return { kind: 'literal', value: '{{now.iso}}' };
  }
  if (ITERABLE_COLLECTION_NAMES.has(key)) {
    const defaultItem = JSON.stringify({ id: '{{faker.uuid}}', name: '{{faker.name}}' });
    return { kind: 'raw', expr: `{{repeat(3, ${JSON.stringify(defaultItem)})}}` };
  }
  return { kind: 'literal', value: 'sample' };
}

/**
 * Replaces unquoted `{{...}}` helper expressions outside JSON string literals with valid JSON
 * placeholder strings so existing response templates can be parsed and extended non-destructively.
 */
function parseTemplatePreservingRawExprs(template: string): {
  obj: Record<string, unknown>;
  preserved: Map<string, string>;
} {
  const preserved = new Map<string, string>();
  const trimmed = template.trim();
  if (!trimmed) {
    return { obj: {}, preserved };
  }

  let sanitized = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  let tokenCounter = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (inString) {
      sanitized += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      sanitized += ch;
      i += 1;
      continue;
    }

    if (ch === '{' && trimmed[i + 1] === '{') {
      const start = i;
      i += 2;
      let depth = 1;
      let innerQuote: '"' | "'" | null = null;
      let innerEsc = false;
      while (i < trimmed.length && depth > 0) {
        const c = trimmed[i]!;
        if (innerQuote) {
          if (innerEsc) innerEsc = false;
          else if (c === '\\') innerEsc = true;
          else if (c === innerQuote) innerQuote = null;
          i += 1;
          continue;
        }
        if (c === '"' || c === "'") {
          innerQuote = c;
          i += 1;
          continue;
        }
        if (c === '{' && trimmed[i + 1] === '{') {
          depth += 1;
          i += 2;
          continue;
        }
        if (c === '}' && trimmed[i + 1] === '}') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      const rawExpr = trimmed.slice(start, i);
      const tokenId = `__INFRASIM_PRESERVED_EXPR_${tokenCounter++}__`;
      preserved.set(tokenId, rawExpr);
      sanitized += JSON.stringify(tokenId);
      continue;
    }

    sanitized += ch;
    i += 1;
  }

  try {
    const parsed = JSON.parse(sanitized) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { obj: parsed as Record<string, unknown>, preserved };
    }
  } catch {
    // Fall back to empty root object when existing body wasn't JSON
  }
  return { obj: {}, preserved: new Map() };
}

function serializeWithRawExprs(
  value: unknown,
  preserved: ReadonlyMap<string, string>,
  pretty: boolean,
): string {
  let rawCounter = 0;
  const rawTokens = new Map<string, string>();

  const transform = (node: unknown): unknown => {
    if (isRawToken(node)) {
      const id = `__INFRASIM_RAW_TOKEN_${rawCounter++}__`;
      rawTokens.set(id, node.__rawExpr);
      return id;
    }
    if (Array.isArray(node)) {
      return node.map((item) => transform(item));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = transform(v);
      }
      return out;
    }
    return node;
  };

  let text = JSON.stringify(transform(value), null, pretty ? 2 : undefined);
  for (const [id, expr] of preserved.entries()) {
    text = text.split(JSON.stringify(id)).join(expr);
  }
  for (const [id, expr] of rawTokens.entries()) {
    text = text.split(JSON.stringify(id)).join(expr);
  }
  return text;
}

function splitNormalizedPath(rawPath: string): string[] {
  const normalized = rawPath.replace(/\[(\d+)\]/g, '.$1');
  return normalized
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '__isDiscoveryProxy' && s !== 'then');
}

function filterLeafPaths(paths: readonly string[]): string[][] {
  const tokenized = paths.map(splitNormalizedPath).filter((segs) => segs.length > 0);
  const uniqueKeys = new Set<string>();
  const deduped: string[][] = [];
  for (const segs of tokenized) {
    const key = segs.join('.');
    if (!uniqueKeys.has(key)) {
      uniqueKeys.add(key);
      deduped.push(segs);
    }
  }

  return deduped
    .filter((segs) => {
      const prefix = `${segs.join('.')}.`;
      return !deduped.some(
        (other) => other.length > segs.length && other.join('.').startsWith(prefix),
      );
    })
    .sort((a, b) => a.join('.').localeCompare(b.join('.')));
}

function insertPathSegments(
  target: Record<string, unknown>,
  segments: readonly string[],
  preserved: ReadonlyMap<string, string>,
): void {
  if (segments.length === 0) return;
  const head = segments[0]!;
  const rest = segments.slice(1);

  if (rest.length === 0) {
    if (head in target && target[head] !== undefined) {
      return;
    }
    const inferred = inferFieldTemplateValue(head);
    if (ITERABLE_COLLECTION_NAMES.has(head) && inferred.kind === 'raw') {
      target[head] = [{ __rawExpr: inferred.expr }];
    } else if (inferred.kind === 'raw') {
      target[head] = { __rawExpr: inferred.expr };
    } else {
      target[head] = inferred.value;
    }
    return;
  }

  const next = rest[0]!;
  const isArrayIndex = /^\d+$/.test(next);

  if (isArrayIndex) {
    const subSegments = rest.slice(1);
    const existing = target[head];

    // Case 1: existing field is `[ "{{repeat(n, '...')}}" ]`
    if (Array.isArray(existing) && existing.length === 1 && typeof existing[0] === 'string') {
      const exprText = preserved.get(existing[0]) ?? existing[0];
      const repeatMatch = /^\s*\{\{\s*repeat\(\s*(\d+)\s*,\s*("[\s\S]*")\s*\)\s*\}\}\s*$/.exec(
        exprText,
      );
      if (repeatMatch) {
        const count = Number(repeatMatch[1]);
        try {
          const itemStr = JSON.parse(repeatMatch[2]!) as string;
          const itemParsed = parseTemplatePreservingRawExprs(itemStr);
          if (subSegments.length > 0) {
            insertPathSegments(itemParsed.obj, subSegments, itemParsed.preserved);
          }
          const updatedItemStr = serializeWithRawExprs(itemParsed.obj, itemParsed.preserved, false);
          existing[0] = {
            __rawExpr: `{{repeat(${count}, ${JSON.stringify(updatedItemStr)})}}`,
          } as unknown as string;
          return;
        } catch {
          // Fall through to rebuilding repeat item template
        }
      }
    }

    // Case 2: existing field is array of `{ __rawExpr: '{{repeat(...)}}' }` created in prior step of same pass
    if (Array.isArray(existing) && existing.length === 1 && isRawToken(existing[0])) {
      const exprText = existing[0].__rawExpr;
      const repeatMatch = /^\s*\{\{\s*repeat\(\s*(\d+)\s*,\s*("[\s\S]*")\s*\)\s*\}\}\s*$/.exec(
        exprText,
      );
      if (repeatMatch) {
        const count = Number(repeatMatch[1]);
        try {
          const itemStr = JSON.parse(repeatMatch[2]!) as string;
          const itemParsed = parseTemplatePreservingRawExprs(itemStr);
          if (subSegments.length > 0) {
            insertPathSegments(itemParsed.obj, subSegments, itemParsed.preserved);
          }
          const updatedItemStr = serializeWithRawExprs(itemParsed.obj, itemParsed.preserved, false);
          existing[0] = {
            __rawExpr: `{{repeat(${count}, ${JSON.stringify(updatedItemStr)})}}`,
          };
          return;
        } catch {
          // Fall through
        }
      }
    }

    // Case 3: fresh or plain-array entry
    if (
      Array.isArray(existing) &&
      existing.length > 0 &&
      typeof existing[0] === 'object' &&
      existing[0] !== null &&
      !isRawToken(existing[0])
    ) {
      if (subSegments.length > 0) {
        for (const elem of existing) {
          if (elem && typeof elem === 'object') {
            insertPathSegments(elem as Record<string, unknown>, subSegments, preserved);
          }
        }
      }
      return;
    }

    const itemObj: Record<string, unknown> = {};
    if (subSegments.length > 0) {
      insertPathSegments(itemObj, subSegments, new Map());
    } else {
      itemObj.id = '{{faker.uuid}}';
      itemObj.name = '{{faker.name}}';
    }
    const compactItem = serializeWithRawExprs(itemObj, new Map(), false);
    target[head] = [{ __rawExpr: `{{repeat(3, ${JSON.stringify(compactItem)})}}` }];
    return;
  }

  // Regular nested object property
  const existingChild = target[head];
  if (
    !existingChild ||
    typeof existingChild !== 'object' ||
    Array.isArray(existingChild) ||
    isRawToken(existingChild)
  ) {
    target[head] = {};
  }
  insertPathSegments(target[head] as Record<string, unknown>, rest, preserved);
}

/**
 * Generates or non-destructively extends a valid mock response JSON template from discovered
 * guest property access paths (e.g. `["Item.userId", "Items[0].price"]`).
 */
export function buildResponseTemplateFromPaths(
  paths: readonly string[],
  existingTemplate = '{}',
): string {
  const leafPaths = filterLeafPaths(paths);
  const { obj, preserved } = parseTemplatePreservingRawExprs(existingTemplate);

  for (const segments of leafPaths) {
    insertPathSegments(obj, segments, preserved);
  }

  const candidate = serializeWithRawExprs(obj, preserved, true);
  const validation = validateResponseTemplate(candidate);
  if (!validation.valid) {
    return existingTemplate || '{}';
  }
  return candidate;
}

export interface AutoFillDiscoveryReport {
  ok: boolean;
  discoveredPaths: Record<string, string[]>;
  patches: AutoFillPatchPreview[];
  discoveryResult: DryRunResult;
}

/**
 * Executes a handler once in discovery proxy mode, collects every accessed field path per
 * `(serviceId, op)`, and computes diff previews for updating node mock response templates.
 */
export async function generateAutoFillPatches(
  input: Omit<DryRunInput, 'discoveryMode'>,
): Promise<AutoFillDiscoveryReport> {
  const discoveryResult = await executeInSandbox({
    ...input,
    discoveryMode: true,
  });

  const discoveredPaths = discoveryResult.discoveredPaths ?? {};
  const customServices = [...(input.customServices ?? []), ...(input.design?.customServices ?? [])];
  const callsByKey = new Map<string, string | undefined>();
  for (const call of discoveryResult.calls) {
    const key = `${call.serviceId}::${call.op}`;
    if (!callsByKey.has(key) || call.targetNodeId) {
      callsByKey.set(key, call.targetNodeId);
    }
  }

  const patches: AutoFillPatchPreview[] = [];

  for (const [key, rawPaths] of Object.entries(discoveredPaths)) {
    if (rawPaths.length === 0) continue;
    const sepIdx = key.indexOf('::');
    if (sepIdx < 0) continue;
    const rawServiceId = key.slice(0, sepIdx);
    const op = key.slice(sepIdx + 2);
    const canonicalServiceId = resolveCanonicalServiceId(rawServiceId);

    const targetNodeId =
      callsByKey.get(`${canonicalServiceId}::${op}`) ??
      callsByKey.get(key) ??
      input.design?.nodes.find((n) => resolveCanonicalServiceId(n.serviceId) === canonicalServiceId)
        ?.id;

    const targetNode = targetNodeId
      ? input.design?.nodes.find((n) => n.id === targetNodeId)
      : undefined;
    const service = getService(canonicalServiceId, customServices);
    const serviceOp =
      service?.operations.find((o) => o.name.toLowerCase() === op.toLowerCase()) ??
      service?.operations[0];

    const beforeTemplate =
      targetNode?.config.operations?.[op]?.responseTemplate ??
      (serviceOp ? targetNode?.config.operations?.[serviceOp.name]?.responseTemplate : undefined) ??
      serviceOp?.defaultResponse.bodyTemplate ??
      '{}';

    // Check which paths are already satisfied when evaluating beforeTemplate
    let needsPatch = false;
    try {
      const evaluated = evaluateResponseTemplate(beforeTemplate, {
        seed: input.seed ?? 42,
        seq: input.seq ?? 1,
      });
      const parsed = JSON.parse(evaluated.body) as unknown;
      const leafPaths = filterLeafPaths(rawPaths);
      for (const segs of leafPaths) {
        let cur: unknown = parsed;
        let ok = true;
        for (const seg of segs) {
          if (cur === null || cur === undefined || typeof cur !== 'object') {
            ok = false;
            break;
          }
          if (/^\d+$/.test(seg) && Array.isArray(cur)) {
            cur = cur[Number(seg)];
          } else {
            cur = (cur as Record<string, unknown>)[seg];
          }
        }
        if (!ok || cur === undefined) {
          needsPatch = true;
          break;
        }
      }
    } catch {
      needsPatch = true;
    }

    if (!needsPatch) {
      continue;
    }

    const afterTemplate = buildResponseTemplateFromPaths(rawPaths, beforeTemplate);
    patches.push({
      serviceId: canonicalServiceId,
      op: serviceOp?.name ?? op,
      ...(targetNodeId ? { targetNodeId } : {}),
      accessedPaths: [...rawPaths],
      beforeTemplate,
      afterTemplate,
    });
  }

  return {
    ok: discoveryResult.ok,
    discoveredPaths,
    patches,
    discoveryResult,
  };
}
