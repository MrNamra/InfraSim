/** Regex identifying secret-bearing keys that must never contain literal values in exported HCL or imported designs. */
export const TERRAFORM_SECRET_KEY_PATTERN =
  /password|passwd|secret|token|private_key|access_key|client_secret|connection_string|api_key/i;

/** Converts an arbitrary label into a valid Terraform snake_case identifier. */
export function snakeCaseSlug(raw: string, fallback = 'resource'): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (!normalized) {
    return fallback;
  }
  if (/^[0-9]/.test(normalized)) {
    return `r_${normalized}`;
  }
  return normalized;
}

/** Checks whether an environment variable or attribute key looks sensitive. */
export function isSecretKeyName(key: string): boolean {
  return TERRAFORM_SECRET_KEY_PATTERN.test(key);
}

/**
 * Deterministic collision-safe Terraform identifier allocator.
 * Pre-registering `(scope, id, rawLabel)` items in canonical `(slug, id)` order ensures
 * array reordering in a Design produces identical resource names.
 */
export class TerraformNameAllocator {
  private readonly usedByScope = new Map<string, Set<string>>();
  private readonly resolvedByKey = new Map<string, string>();

  /** Pre-allocates deterministic names for a batch of `(scope, entityId, rawLabel)` entries. */
  preallocate(
    entries: ReadonlyArray<{
      scope: string;
      entityId: string;
      rawLabel: string;
      fallback?: string;
    }>,
  ): void {
    const normalized = entries
      .map((entry) => ({
        ...entry,
        base: snakeCaseSlug(entry.rawLabel, entry.fallback ?? 'item'),
      }))
      .sort((a, b) => {
        if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
        if (a.base !== b.base) return a.base.localeCompare(b.base);
        return a.entityId.localeCompare(b.entityId);
      });

    for (const item of normalized) {
      this.allocate(item.scope, item.entityId, item.base);
    }
  }

  /** Gets or allocates a unique snake_case identifier for `(scope, entityId)`. */
  allocate(scope: string, entityId: string, rawLabel: string, fallback = 'item'): string {
    const compositeKey = `${scope}::${entityId}`;
    const existing = this.resolvedByKey.get(compositeKey);
    if (existing) {
      return existing;
    }

    let scopeSet = this.usedByScope.get(scope);
    if (!scopeSet) {
      scopeSet = new Set<string>();
      this.usedByScope.set(scope, scopeSet);
    }

    const base = snakeCaseSlug(rawLabel, fallback);
    let candidate = base;
    let suffix = 2;
    while (scopeSet.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix++;
    }
    scopeSet.add(candidate);
    this.resolvedByKey.set(compositeKey, candidate);
    return candidate;
  }

  /** Looks up a previously allocated name if present. */
  get(scope: string, entityId: string): string | undefined {
    return this.resolvedByKey.get(`${scope}::${entityId}`);
  }
}
