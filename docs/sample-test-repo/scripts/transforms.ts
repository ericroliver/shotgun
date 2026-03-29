/**
 * scripts/transforms.ts
 *
 * Shared response body transformation helpers.
 * Importable in pre/post scripts via ctx.scripts.transforms.*
 *
 * Usage in a test YAML post-script:
 *   const normalized = ctx.scripts.transforms.stripVolatileFields(ctx.response.body);
 */

/**
 * Recursively removes known volatile fields from an object.
 * Useful for richer in-script comparisons beyond snapshot diffs.
 */
export function stripVolatileFields<T extends object>(obj: T, fields = VOLATILE_FIELDS): T {
  return deepOmit(obj, fields) as T;
}

const VOLATILE_FIELDS = [
  'id',
  'timestamp',
  'createdAt',
  'updatedAt',
  'lastActive',
  'requestId',
  'traceId',
  'sessionId',
];

function deepOmit(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepOmit(item, keys));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !keys.includes(k))
        .map(([k, v]) => [k, deepOmit(v, keys)]),
    );
  }
  return value;
}

/**
 * Extracts a value from a nested object using dot notation.
 * e.g. extract(body, 'agents.0.name')
 */
export function extract(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Checks if a response body matches a partial shape (subset match).
 * Returns true if all keys in `expected` are present and match in `actual`.
 */
export function matchesShape(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  const a = actual as Record<string, unknown>;
  return Object.entries(expected).every(([k, v]) => {
    if (typeof v === 'object' && v !== null) {
      return matchesShape(a[k], v as Record<string, unknown>);
    }
    return a[k] === v;
  });
}
