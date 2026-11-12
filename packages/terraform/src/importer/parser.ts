import type {
  NormalizedPlanResource,
  RawTerraformConfigModule,
  RawTerraformModule,
  SanitizedTerraformDocument,
} from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips trailing `[0]` / `["key"]` resource index to obtain the unindexed configuration address. */
export function stripResourceIndex(address: string): string {
  return address.replace(/\[(?:[0-9]+|"[^"]+")\]$/, '');
}

/** Qualifies a local configuration reference relative to its containing module address. */
export function qualifyReference(ref: string, moduleAddress: string): string {
  if (!moduleAddress || moduleAddress === 'root') {
    return ref;
  }
  if (
    ref.startsWith('var.') ||
    ref.startsWith('local.') ||
    ref.startsWith('path.') ||
    ref.startsWith('terraform.') ||
    ref.startsWith('module.') ||
    ref.startsWith('each.') ||
    ref.startsWith('count.') ||
    ref.startsWith('self.')
  ) {
    return ref;
  }
  return `${moduleAddress}.${ref}`;
}

/** Converts a resource-relative expression reference into its base resource address (`module.x.type.name` or `type.name`). */
export function extractResourceAddressFromRef(ref: string, moduleAddress = 'root'): string | null {
  const qualified = qualifyReference(ref, moduleAddress);
  const parts = qualified.split('.');
  // Strip any leading module.<call> segments in pairs
  let idx = 0;
  while (idx + 1 < parts.length && parts[idx] === 'module') {
    idx += 2;
  }
  if (parts[idx] === 'data' && idx + 2 < parts.length) {
    return parts.slice(0, idx + 3).join('.');
  }
  if (idx + 1 < parts.length) {
    const typeCandidate = parts[idx]!;
    if (
      typeCandidate === 'var' ||
      typeCandidate === 'local' ||
      typeCandidate === 'path' ||
      typeCandidate === 'terraform' ||
      typeCandidate === 'each' ||
      typeCandidate === 'count' ||
      typeCandidate === 'self'
    ) {
      return null;
    }
    return parts.slice(0, idx + 2).join('.');
  }
  return null;
}

function collectExpressionRefs(
  exprNode: unknown,
  path: string,
  moduleAddress: string,
  byAttr: Record<string, string[]>,
  allSet: Set<string>,
): void {
  if (Array.isArray(exprNode)) {
    exprNode.forEach((item, i) => {
      collectExpressionRefs(item, `${path}.${i}`, moduleAddress, byAttr, allSet);
    });
    return;
  }
  if (!isPlainObject(exprNode)) {
    return;
  }

  const rawRefs = exprNode.references;
  if (Array.isArray(rawRefs)) {
    const leafKey = path.split('.').pop() ?? path;
    for (const rawRef of rawRefs) {
      if (typeof rawRef !== 'string' || !rawRef.trim()) continue;
      const qualified = qualifyReference(rawRef, moduleAddress);
      allSet.add(qualified);

      const listFull = byAttr[path] ?? [];
      if (!listFull.includes(qualified)) {
        listFull.push(qualified);
        byAttr[path] = listFull;
      }

      const listLeaf = byAttr[leafKey] ?? [];
      if (!listLeaf.includes(qualified)) {
        listLeaf.push(qualified);
        byAttr[leafKey] = listLeaf;
      }
    }
  }

  for (const [k, v] of Object.entries(exprNode)) {
    if (k === 'references' || k === 'constant_value') continue;
    collectExpressionRefs(v, path ? `${path}.${k}` : k, moduleAddress, byAttr, allSet);
  }
}

function indexConfigurationModule(
  mod: RawTerraformConfigModule | undefined,
  moduleAddress: string,
  indexOut: Map<string, { referencesByAttr: Record<string, string[]>; allReferences: string[] }>,
): void {
  if (!mod) return;

  for (const res of mod.resources ?? []) {
    const localAddr =
      res.address ??
      (res.mode === 'data'
        ? `data.${res.type ?? ''}.${res.name ?? ''}`
        : `${res.type ?? ''}.${res.name ?? ''}`);
    const fullBaseAddr =
      moduleAddress === 'root' || localAddr.startsWith('module.')
        ? localAddr
        : `${moduleAddress}.${localAddr}`;

    const referencesByAttr: Record<string, string[]> = {};
    const allSet = new Set<string>();
    if (isPlainObject(res.expressions)) {
      for (const [attr, exprVal] of Object.entries(res.expressions)) {
        collectExpressionRefs(exprVal, attr, moduleAddress, referencesByAttr, allSet);
      }
    }
    indexOut.set(fullBaseAddr, {
      referencesByAttr,
      allReferences: [...allSet],
    });
  }

  if (mod.module_calls) {
    for (const [callName, callSpec] of Object.entries(mod.module_calls)) {
      const childModAddr =
        moduleAddress === 'root' ? `module.${callName}` : `${moduleAddress}.module.${callName}`;
      indexConfigurationModule(callSpec.module, childModAddr, indexOut);
    }
  }
}

/**
 * Recursively flattens `root_module` and `child_modules`, joining each resource with its
 * `configuration` expression references and deterministic canonical order.
 */
export function flattenTerraformModules(doc: SanitizedTerraformDocument): NormalizedPlanResource[] {
  const exprIndex = new Map<
    string,
    { referencesByAttr: Record<string, string[]>; allReferences: string[] }
  >();
  indexConfigurationModule(doc.configurationRoot, 'root', exprIndex);

  const out: NormalizedPlanResource[] = [];

  const walk = (mod: RawTerraformModule, fallbackModuleAddr: string) => {
    const modAddr = mod.address?.trim() || fallbackModuleAddr;
    for (const rawRes of mod.resources ?? []) {
      const mode = rawRes.mode === 'data' ? 'data' : 'managed';
      const type = rawRes.type?.trim() || 'unknown';
      const name = rawRes.name?.trim() || 'unnamed';
      const rawAddress =
        rawRes.address?.trim() ||
        (modAddr !== 'root'
          ? `${modAddr}.${mode === 'data' ? 'data.' : ''}${type}.${name}`
          : `${mode === 'data' ? 'data.' : ''}${type}.${name}`);
      const baseAddress = stripResourceIndex(rawAddress);
      const exprMeta = exprIndex.get(baseAddress) ?? {
        referencesByAttr: {},
        allReferences: [],
      };

      out.push({
        address: rawAddress,
        baseAddress,
        moduleAddress: modAddr,
        mode,
        type,
        name,
        ...(rawRes.index !== undefined ? { index: rawRes.index } : {}),
        providerName: rawRes.provider_name ?? '',
        values: isPlainObject(rawRes.values) ? rawRes.values : {},
        referencesByAttr: exprMeta.referencesByAttr,
        allReferences: exprMeta.allReferences,
      });
    }

    for (const child of mod.child_modules ?? []) {
      walk(child, child.address?.trim() || modAddr);
    }
  };

  walk(doc.rootModule, 'root');
  return out.sort((a, b) => a.address.localeCompare(b.address));
}
