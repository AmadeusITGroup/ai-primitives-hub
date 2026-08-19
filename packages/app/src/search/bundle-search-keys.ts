/**
 * Shared bridge between primitive-index identities and catalog bundle keys.
 *
 * Native GitHub primitive providers index one repository as a source-level
 * bundle (`bundleId === sourceId`), while catalog adapters expose the same
 * repository as a versioned bundle ID. This projection keeps ranked semantic
 * results compatible with both representations without changing the
 * client-agnostic persisted index.
 * @module search/bundle-search-keys
 */

export interface IndexedBundleIdentity {
  sourceId: string;
  bundleId: string;
}

export interface CatalogBundleIdentity {
  sourceId: string;
  bundleId: string;
}

const BUNDLE_KEY_SEPARATOR = '\u0000';

/**
 * Convert a catalog bundle identity to the opaque key used by the marketplace.
 * @param bundle
 */
export function toBundleSearchKey(bundle: CatalogBundleIdentity): string {
  return `${bundle.sourceId}${BUNDLE_KEY_SEPARATOR}${bundle.bundleId}`;
}

/**
 * Resolve ranked primitive identities to catalog identities.
 *
 * The input order is semantic ranking order. Exact bundle IDs are preferred;
 * a source-level index identity expands to all catalog bundles from that
 * source, which is the representation used by the native GitHub provider.
 * Results are deduplicated while preserving that order.
 * @param indexedBundles Ranked identities emitted by the primitive index.
 * @param catalogBundles Current client/catalog bundle snapshot.
 */
export function resolveBundleSearchKeys(
  indexedBundles: readonly IndexedBundleIdentity[],
  catalogBundles: readonly CatalogBundleIdentity[]
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const indexed of indexedBundles) {
    const matches = catalogBundles.filter((catalog) =>
      catalog.sourceId === indexed.sourceId
      && (catalog.bundleId === indexed.bundleId || indexed.bundleId === indexed.sourceId)
    );
    for (const match of matches) {
      const key = toBundleSearchKey(match);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(key);
      }
    }
  }

  return result;
}
