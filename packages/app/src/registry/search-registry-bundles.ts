/**
 * Search for bundles across registry sources — ported from the
 * extension's `src/services/registry-manager.ts` (`RegistryManager`'s
 * public `searchBundles` plus its private `sortBundles` helper).
 *
 * No counterpart for this exists in the reference branch's
 * `app/search/` (which only has `exportShortlistAsProfile` — a
 * `PrimitiveIndex`/BM25-consuming, primitive-*content*-level search
 * helper, see `search/export-profile.ts`). This function operates on
 * a different axis entirely: whole-`Bundle`-metadata filtering,
 * sorting, and pagination across configured registry sources, as
 * surfaced by each source's adapter — unrelated to `PrimitiveIndex`'s
 * per-file content search. It therefore has no BM25 involvement and
 * needed its own from-scratch design here, following this migration's
 * established `registry/*` port-orchestration pattern (see
 * `install-registry-bundle.ts`) rather than being a port of reference
 * code.
 * @module registry/search-registry-bundles
 */
import type {
  Bundle,
  RegistrySource,
  SearchQuery,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Read/write access `searchRegistryBundles` needs: source listing,
 * per-source bundle caching (read + write), adapter resolution, and
 * version consolidation (backed by the caller's `VersionConsolidator`
 * instance — kept as an opaque, synchronous port here rather than
 * depending on that class directly, mirroring
 * `resolveInstallationBundle`'s `getBundleVersion` precedent).
 */
export interface SearchRegistryBundlesPorts {
  listSources(): Promise<RegistrySource[]>;
  getCachedSourceBundles(sourceId: string): Promise<Bundle[]>;
  cacheSourceBundles(sourceId: string, bundles: Bundle[]): Promise<void>;
  getAdapter(source: RegistrySource): SourceAdapter;
  consolidateBundles(bundles: Bundle[]): Bundle[];
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Fetch all bundles for the sources a query targets, preferring each
 * source's cache and only hitting its adapter when the cache is empty
 * and the query isn't `cacheOnly`. Per-source fetch failures are
 * logged and skipped rather than failing the whole search.
 * @param query
 * @param ports
 * @param onLog
 */
async function fetchAllBundles(
  query: SearchQuery,
  ports: SearchRegistryBundlesPorts,
  onLog: OnLogEvent | undefined
): Promise<Bundle[]> {
  const sources = await ports.listSources();
  const sourcesToSearch = query.sourceId
    ? sources.filter((s) => s.id === query.sourceId)
    : sources.filter((s) => s.enabled);

  log(onLog, 'info', `Searching in ${sourcesToSearch.length} sources`);

  const allBundles: Bundle[] = [];
  for (const source of sourcesToSearch) {
    try {
      let bundles = await ports.getCachedSourceBundles(source.id);

      if (bundles.length === 0 && !query.cacheOnly) {
        const adapter = ports.getAdapter(source);
        bundles = await adapter.fetchBundles();
        await ports.cacheSourceBundles(source.id, bundles);
      }

      allBundles.push(...bundles);
    } catch (error) {
      log(onLog, 'error', `Failed to fetch bundles from source '${source.id}'`, error instanceof Error ? error : undefined);
    }
  }

  return allBundles;
}

/**
 * Apply text/tags/author/environment filters to a bundle list.
 * @param bundles
 * @param query
 */
function applyFilters(bundles: Bundle[], query: SearchQuery): Bundle[] {
  let results = bundles;

  if (query.text) {
    const searchText = query.text.toLowerCase();
    results = results.filter((b) =>
      b.id === query.text
      || b.name.toLowerCase().includes(searchText)
      || b.description.toLowerCase().includes(searchText)
    );
  }

  if (query.tags && query.tags.length > 0) {
    const { tags } = query;
    results = results.filter((b) => tags.some((tag) => b.tags.includes(tag)));
  }

  if (query.author) {
    results = results.filter((b) => b.author === query.author);
  }

  if (query.environment) {
    const { environment } = query;
    results = results.filter((b) => b.environments.includes(environment));
  }

  return results;
}

/**
 * Sort bundles by criteria. `'relevance'` and any unrecognized value
 * are a no-op (original fetch/filter order is preserved).
 * @param bundles
 * @param sortBy
 */
function sortBundles(bundles: Bundle[], sortBy: string): Bundle[] {
  switch (sortBy) {
    case 'downloads': {
      return bundles.toSorted((a, b) => (b.downloads || 0) - (a.downloads || 0));
    }
    case 'rating': {
      return bundles.toSorted((a, b) => (b.rating || 0) - (a.rating || 0));
    }
    case 'recent': {
      return bundles.toSorted((a, b) =>
        new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      );
    }
    default: {
      return bundles;
    }
  }
}

/**
 * Apply offset/limit pagination. A default limit of 50 only kicks in
 * once either `offset` or `limit` is set — an unpaginated query
 * returns every result.
 * @param bundles
 * @param query
 */
function paginate(bundles: Bundle[], query: SearchQuery): Bundle[] {
  if (query.offset === undefined && query.limit === undefined) {
    return bundles;
  }

  const offset = query.offset || 0;
  const limit = query.limit || 50;
  return bundles.slice(offset, offset + limit);
}

/**
 * Search for bundles across all enabled sources (or one specific
 * source via `query.sourceId`): fetch (cache-first), consolidate
 * multi-version GitHub bundles, filter, sort, and paginate.
 * @param query - Search query options.
 * @param ports - Injected read/write access to source/bundle data, adapters, and version consolidation.
 * @param onLog - Optional sink for diagnostic log events.
 * @returns Matching bundles.
 */
export async function searchRegistryBundles(
  query: SearchQuery,
  ports: SearchRegistryBundlesPorts,
  onLog?: OnLogEvent
): Promise<Bundle[]> {
  log(onLog, 'info', `Searching bundles: ${JSON.stringify(query)}`);

  const allBundles = await fetchAllBundles(query, ports, onLog);

  let results: Bundle[];
  try {
    results = ports.consolidateBundles(allBundles);
    log(onLog, 'debug', `Consolidated ${allBundles.length} bundles into ${results.length} entries`);
  } catch (error) {
    log(onLog, 'error', 'Version consolidation failed, using unconsolidated bundles', error instanceof Error ? error : undefined);
    results = allBundles;
  }

  results = applyFilters(results, query);

  if (query.sortBy) {
    results = sortBundles(results, query.sortBy);
  }

  return paginate(results, query);
}
