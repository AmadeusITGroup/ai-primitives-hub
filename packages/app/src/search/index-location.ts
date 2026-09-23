/**
 * Shared resolution of explicit and namespaced primitive-index locations.
 * @module search/index-location
 */
import type {
  PrimitiveIndexKey,
  PrimitiveIndexStore,
} from '@ai-primitives-hub/core';

export interface IndexLocationOptions {
  /** Explicit path for diagnostics, tests, and legacy CLI compatibility. */
  indexPath?: string;
  /** Injected resolver for shared, namespaced semantic-cache paths. */
  indexStore?: PrimitiveIndexStore;
  /** Key used when resolving through `indexStore`. */
  indexKey?: PrimitiveIndexKey;
}

/**
 * Resolve the stable namespace used for a hub's persisted primitive indexes.
 *
 * Older app imports generated user-facing hub ids with a six-digit timestamp
 * suffix (for example, `amadeus-hub-788228`), while the legacy CLI commonly
 * used the stable base id (`amadeus-hub`). Keep those public ids untouched but
 * converge their client-agnostic index namespace during the migration.
 * @param hubId User-facing hub identifier.
 */
export function canonicalizeIndexHubId(hubId: string): string {
  const normalized = hubId.trim();
  const canonical = normalized.replace(/-\d{6}$/u, '');
  return canonical.length > 0 ? canonical : normalized;
}

/**
 * Resolve an explicit path or an injected namespaced index store.
 * @param options
 */
export function resolveIndexPath(options: IndexLocationOptions): string {
  if (options.indexPath) {
    return options.indexPath;
  }
  if (options.indexStore && options.indexKey) {
    return options.indexStore.getIndexPath(options.indexKey);
  }
  throw new Error('An explicit indexPath or indexStore/indexKey pair is required');
}
