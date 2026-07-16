/**
 * Version consolidation for bundle search results.
 *
 * Ported from the extension's `src/services/version-consolidator.ts`
 * (`VersionConsolidator`) into `app`'s registry/ module (migration plan
 * §7.5, Phase 4 item 3, slice 1) so future search/discovery use-cases can
 * reuse it, not just the extension's Marketplace view. This service groups
 * bundles by their identity (owner/repo for GitHub sources) and selects the
 * latest version based on semantic versioning, maintaining an LRU cache of
 * all available versions for potential future access.
 *
 * Diagnostic debug/warn/error messages from the original are preserved via
 * the optional `onLog` callback (the same `LogEvent` mechanism already used
 * by `update/check-updates.ts`/`update/auto-update.ts`), so the extension's
 * `Logger` output is unchanged.
 * @module registry/version-consolidator
 */
import type {
  Bundle,
  SourceType,
} from '@ai-primitives-hub/core';
import {
  compareVersions,
  extractBundleIdentity,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Version metadata for a bundle.
 */
export interface BundleVersion {
  version: string;
  bundleId: string; // Original bundle ID (e.g., owner-repo-v1.0.0)
  publishedAt: string;
  downloadUrl: string;
  manifestUrl: string;
  releaseNotes?: string;
}

/**
 * Consolidated bundle with version information.
 */
export interface ConsolidatedBundle extends Bundle {
  // All standard Bundle fields represent the latest version
  availableVersions: BundleVersion[]; // All versions available
  isConsolidated: boolean; // True if multiple versions exist
}

/**
 * Cache entry.
 */
interface CacheEntry {
  versions: BundleVersion[];
  lastAccess: number;
}

/**
 * Default maximum cache size to prevent unbounded memory growth.
 * Assuming ~1KB per bundle version metadata = ~1MB total cache size.
 */
const DEFAULT_MAX_CACHE_SIZE = 1000;

/**
 * Service for consolidating multiple bundle versions into single entries.
 */
export class VersionConsolidator {
  private readonly versionCache: Map<string, CacheEntry> = new Map();
  private readonly accessOrder: string[] = []; // Track access order for efficient LRU
  private readonly maxCacheSize: number;
  private readonly onLog?: OnLogEvent;
  private sourceTypeResolver?: (sourceId: string) => SourceType;

  /**
   * Create a new VersionConsolidator
   * @param maxCacheSize - Maximum number of bundle identities to cache (default: 1000)
   * @param onLog - Optional callback for diagnostic log events (cache eviction, fallback sorting, ...)
   * @throws {Error} if maxCacheSize is not a positive number
   */
  public constructor(maxCacheSize: number = DEFAULT_MAX_CACHE_SIZE, onLog?: OnLogEvent) {
    if (!Number.isFinite(maxCacheSize) || maxCacheSize <= 0) {
      throw new Error('maxCacheSize must be a positive number');
    }
    this.maxCacheSize = maxCacheSize;
    this.onLog = onLog;
  }

  private log(level: LogEvent['level'], message: string): void {
    this.onLog?.({ level, message });
  }

  /**
   * Add entry to cache with LRU eviction strategy.
   * @param key - Bundle identity key
   * @param versions - Array of bundle versions to cache
   */
  private addToCache(key: string, versions: BundleVersion[]): void {
    const isUpdate = this.versionCache.has(key);

    if (!isUpdate && this.versionCache.size >= this.maxCacheSize) {
      this.evictLRU();
    }

    this.versionCache.set(key, {
      versions,
      lastAccess: Date.now()
    });

    this.updateAccessOrder(key);
  }

  /**
   * Update access order for LRU tracking (O(1) operation).
   * @param key
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * Evict the least recently used entry from cache (O(1) operation).
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) {
      return;
    }

    const lruKey = this.accessOrder.shift();

    if (lruKey) {
      const entry = this.versionCache.get(lruKey);
      this.versionCache.delete(lruKey);

      if (entry) {
        this.log(
          'debug',
          `Cache size limit (${this.maxCacheSize}) reached, evicted LRU entry: ${lruKey} `
          + `(last access: ${new Date(entry.lastAccess).toISOString()})`
        );
      }
    }
  }

  /**
   * Get bundle identity based on source type.
   * @param bundle
   */
  private getBundleIdentity(bundle: Bundle): string {
    const sourceType = this.sourceTypeResolver
      ? this.sourceTypeResolver(bundle.sourceId)
      : this.inferSourceType(bundle.sourceId);
    return extractBundleIdentity(bundle.id, sourceType);
  }

  /**
   * Infer source type from source ID using heuristics.
   *
   * This is a fallback approach when no resolver is provided.
   * Ideally, the actual source configuration should be used.
   * @param sourceId - Source identifier to analyze
   * @returns Inferred source type (defaults to 'local' for unknown types)
   */
  private inferSourceType(sourceId: string): SourceType {
    if (sourceId.includes('github')) {
      return 'github';
    } else if (sourceId.includes('awesome')) {
      return 'awesome-copilot';
    } else if (sourceId.includes('local')) {
      return 'local';
    }
    this.log('debug', `Could not infer source type from "${sourceId}", treating as non-consolidatable`);
    return 'local';
  }

  /**
   * Sort bundles by version in descending order (latest first).
   * @param bundles
   */
  private sortBundlesByVersion(bundles: Bundle[]): Bundle[] {
    return bundles.toSorted((a, b) => {
      try {
        return compareVersions(b.version, a.version);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log('warn', `Version comparison failed for ${a.id} and ${b.id}: ${errorMsg}. Using dates`);

        const dateB = new Date(b.lastUpdated);
        const dateA = new Date(a.lastUpdated);

        if (Number.isNaN(dateB.getTime()) || Number.isNaN(dateA.getTime())) {
          this.log('error', `Both version and date comparison failed for ${b.id}, ${a.id}. Preserving order.`);
          return 0;
        }

        return dateB.getTime() - dateA.getTime();
      }
    });
  }

  /**
   * Convert Bundle to BundleVersion metadata.
   * @param bundle
   */
  private toBundleVersion(bundle: Bundle): BundleVersion {
    return {
      version: bundle.version,
      bundleId: bundle.id,
      publishedAt: bundle.lastUpdated,
      downloadUrl: bundle.downloadUrl,
      manifestUrl: bundle.manifestUrl,
      releaseNotes: undefined
    };
  }

  /**
   * Set a custom source type resolver function.
   * @param resolver - Function that maps sourceId to SourceType
   */
  public setSourceTypeResolver(resolver: (sourceId: string) => SourceType): void {
    this.sourceTypeResolver = resolver;
  }

  /**
   * Consolidate bundles by grouping versions of the same bundle.
   *
   * For GitHub sources, bundles with the same owner/repo are grouped together
   * and only the latest version is returned. For non-GitHub sources, bundles
   * are returned unchanged.
   * @param bundles - Array of bundles from various sources
   * @returns Consolidated bundles with latest version metadata
   */
  public consolidateBundles(bundles: Bundle[]): ConsolidatedBundle[] {
    this.log('debug', `Consolidating ${bundles.length} bundles`);

    const bundlesWithIdentity = bundles.map((bundle) => ({
      bundle,
      identity: this.getBundleIdentity(bundle)
    }));

    const grouped = new Map<string, typeof bundlesWithIdentity>();

    for (const item of bundlesWithIdentity) {
      if (!grouped.has(item.identity)) {
        grouped.set(item.identity, []);
      }
      grouped.get(item.identity)!.push(item);
    }

    this.log('debug', `Grouped into ${grouped.size} unique identities`);

    const consolidated: ConsolidatedBundle[] = [];

    for (const [identity, items] of grouped.entries()) {
      const itemBundles = items.map((item) => item.bundle);

      if (itemBundles.length === 1) {
        const version = this.toBundleVersion(itemBundles[0]);
        this.addToCache(identity, [version]);

        consolidated.push({
          ...itemBundles[0],
          availableVersions: [version],
          isConsolidated: false
        });
        continue;
      }

      const sortedVersions = this.sortBundlesByVersion(itemBundles);
      const latest = sortedVersions[0];
      const allVersions = sortedVersions.map((b) => this.toBundleVersion(b));

      this.addToCache(identity, allVersions);

      this.log('debug', `Consolidated ${itemBundles.length} versions for "${identity}", latest: ${latest.version}`);

      consolidated.push({
        ...latest,
        availableVersions: allVersions,
        isConsolidated: true
      });
    }

    return consolidated;
  }

  /**
   * Get all versions for a bundle identity.
   * @param identity - Unique identifier for the bundle
   * @returns Array of version metadata sorted by version descending
   */
  public getAllVersions(identity: string): BundleVersion[] {
    const entry = this.versionCache.get(identity);
    if (entry) {
      this.updateAccessOrder(identity);
      return entry.versions;
    }
    return [];
  }

  /**
   * Get a specific version of a bundle.
   * @param bundleIdentity - Unique identifier for the bundle
   * @param version - Specific version to retrieve
   * @returns Bundle version metadata, or undefined if not found
   */
  public getBundleVersion(bundleIdentity: string, version: string): BundleVersion | undefined {
    const entry = this.versionCache.get(bundleIdentity);
    if (entry) {
      this.updateAccessOrder(bundleIdentity);
      return entry.versions.find((v) => v.version === version);
    }
    return undefined;
  }
}
