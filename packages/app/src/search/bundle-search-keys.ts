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
  /**
   * Repo-relative path of the matched primitive (e.g. `agents/renovate.agent.md`).
   * Native GitHub sources index a whole repository as one source-level bundle,
   * so the bundleId alone cannot say which catalog bundle a hit belongs to.
   * When present, a source-level hit is attributed only to catalog bundles that
   * actually contain this file — see {@link resolveScoredBundleSearchKeys}.
   */
  path?: string;
}

export interface CatalogBundleIdentity {
  sourceId: string;
  bundleId: string;
  /**
   * Member primitive file paths (e.g. deployment-manifest prompt files). When
   * present, a source-level index hit is attributed only to bundles that
   * contain the matched primitive instead of flooding every bundle from the
   * source. Absent when the catalog snapshot carries no per-bundle file list.
   */
  filePaths?: readonly string[];
}

/**
 * Normalize a repo-relative primitive path for comparison: convert backslashes
 * to forward slashes, strip a leading `./`, and trim surrounding slashes and
 * whitespace. Index and catalog paths are both posix repo-relative, but this
 * guards against provider-specific prefixing.
 * @param path
 */
function normalizePrimitivePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

const BUNDLE_KEY_SEPARATOR = '\u0000';

/**
 * Convert a catalog bundle identity to the opaque key used by the marketplace.
 * @param bundle
 */
export function toBundleSearchKey(bundle: CatalogBundleIdentity): string {
  return `${bundle.sourceId}${BUNDLE_KEY_SEPARATOR}${bundle.bundleId}`;
}

/** A ranked index identity carrying its raw semantic relevance score. */
export interface ScoredIndexedBundleIdentity extends IndexedBundleIdentity {
  score: number;
}

/** A resolved catalog bundle key paired with its semantic relevance score. */
export interface ScoredBundleSearchKey {
  key: string;
  score: number;
}

/**
 * Resolve ranked primitive identities to catalog identities, preserving each
 * hit's raw relevance score so clients can threshold weak matches.
 *
 * The input order is semantic ranking order. Exact bundle IDs are preferred;
 * a source-level index identity expands to all catalog bundles from that
 * source, which is the representation used by the native GitHub provider.
 * Results are deduplicated while preserving that order; a duplicate keeps the
 * first (best-ranked) score.
 * @param indexedBundles Ranked, scored identities emitted by the primitive index.
 * @param catalogBundles Current client/catalog bundle snapshot.
 */
export function resolveScoredBundleSearchKeys(
  indexedBundles: readonly ScoredIndexedBundleIdentity[],
  catalogBundles: readonly CatalogBundleIdentity[]
): ScoredBundleSearchKey[] {
  const result: ScoredBundleSearchKey[] = [];
  const seen = new Set<string>();

  for (const indexed of indexedBundles) {
    const sameSource = catalogBundles.filter((catalog) => catalog.sourceId === indexed.sourceId);
    const isSourceLevel = indexed.bundleId === indexed.sourceId;
    let matches: CatalogBundleIdentity[];
    if (!isSourceLevel) {
      // Per-bundle index identity (e.g. awesome-copilot collections): the
      // catalog bundleId is authoritative, so match it exactly.
      matches = sameSource.filter((catalog) => catalog.bundleId === indexed.bundleId);
    } else if (indexed.path === undefined) {
      // Source-level identity with no path data: preserve the legacy behaviour
      // of expanding onto every catalog bundle from the source.
      matches = sameSource;
    } else {
      // Source-level index identity with a known primitive path (native GitHub
      // sources): attribute the score only to catalog bundles that actually
      // contain the matched file. This avoids expanding one hit onto every
      // bundle of the source, which floods results with unrelated bundles.
      const primitivePath = normalizePrimitivePath(indexed.path);
      const byPath = sameSource.filter((catalog) =>
        catalog.filePaths?.some((file) => normalizePrimitivePath(file) === primitivePath)
      );
      if (byPath.length > 0) {
        matches = byPath;
      } else if (sameSource.some((catalog) => catalog.filePaths && catalog.filePaths.length > 0)) {
        // The source publishes per-bundle file lists but none contains this
        // path, so the primitive is a nested/secondary file (e.g. a reference
        // template) rather than a top-level bundle member. Its owning bundle
        // already surfaces through its top-level primitives, so drop this hit
        // instead of flooding every bundle from the source.
        matches = [];
      } else {
        // No catalog bundle from this source exposes any file list, so precise
        // attribution is impossible — fall back to whole-source expansion so
        // the source's bundles are never silently dropped.
        matches = sameSource;
      }
    }
    for (const match of matches) {
      const key = toBundleSearchKey(match);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, score: indexed.score });
      }
    }
  }

  return result;
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
  return resolveScoredBundleSearchKeys(
    indexedBundles.map((indexed) => ({ ...indexed, score: 0 })),
    catalogBundles
  ).map((entry) => entry.key);
}
