import {
  Bundle,
  SourceType,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  VersionManager,
} from '../utils/version-manager';

/**
 * Version metadata for a bundle
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
 * Consolidated bundle with version information
 */
export interface ConsolidatedBundle extends Bundle {
  // All standard Bundle fields represent the latest version
  availableVersions: BundleVersion[]; // All versions available
  isConsolidated: boolean; // True if multiple versions exist
}

/**
 * Cache entry
 */
interface CacheEntry {
  versions: BundleVersion[];
  lastAccess: number;
}

/**
 * Service for consolidating multiple bundle versions into single entries
 *
 * This service groups bundles by their identity (owner/repo for GitHub sources)
 * and selects the latest version based on semantic versioning. It maintains
 * an LRU cache of all available versions for potential future access.
 */
export class VersionConsolidator {
  /**
   * Default maximum cache size to prevent unbounded memory growth.
   * Assuming ~1KB per bundle version metadata = ~1MB total cache size.
   */
  private static readonly DEFAULT_MAX_CACHE_SIZE = 1000;

  private readonly versionCache: Map<string, CacheEntry> = new Map();
  private readonly accessOrder: string[] = []; // Track access order for efficient LRU
  private readonly logger = Logger.getInstance();
  private sourceTypeResolver?: (sourceId: string) => SourceType;
  private readonly maxCacheSize: number;

  /**
   * Create a new VersionConsolidator
   * @param maxCacheSize - Maximum number of bundle identities to cache (default: 1000)
   * @throws {Error} if maxCacheSize is not a positive number
   */
  constructor(maxCacheSize: number = VersionConsolidator.DEFAULT_MAX_CACHE_SIZE) {
    if (!Number.isFinite(maxCacheSize) || maxCacheSize <= 0) {
      throw new Error('maxCacheSize must be a positive number');
    }
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Add entry to cache with LRU eviction strategy
   *
   * If cache exceeds maxCacheSize, removes the least recently used entry.
   * This ensures frequently accessed bundles remain in cache.
   * Uses an access order array for O(1) LRU eviction.
   * @param key - Bundle identity key
   * @param versions - Array of bundle versions to cache
   */
  private addToCache(key: string, versions: BundleVersion[]): void {
    const isUpdate = this.versionCache.has(key);

    // Check if we need to evict an entry (for new entries only)
    if (!isUpdate && this.versionCache.size >= this.maxCacheSize) {
      this.evictLRU();
    }

    // Add or update entry
    this.versionCache.set(key, {
      versions,
      lastAccess: Date.now()
    });

    // Update access order
    this.updateAccessOrder(key);
  }

  /**
   * Update access order for LRU tracking (O(1) operation)
   * Moves the key to the end of the access order array (most recently used)
   * @param key
   */
  private updateAccessOrder(key: string): void {
    // Remove key from current position if it exists
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }

    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Evict the least recently used entry from cache (O(1) operation)
   * Uses the access order array to identify the LRU entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) {
      return;
    }

    // First entry in accessOrder is the least recently used
    const lruKey = this.accessOrder.shift();

    if (lruKey) {
      const entry = this.versionCache.get(lruKey);
      this.versionCache.delete(lruKey);

      if (entry) {
        this.logger.debug(
          `Cache size limit (${this.maxCacheSize}) reached, evicted LRU entry: ${lruKey} `
          + `(last access: ${new Date(entry.lastAccess).toISOString()})`
        );
      }
    }
  }

  /**
   * Get bundle identity based on source type
   * For GitHub: extract owner-repo from bundle ID
   * For others: use bundle ID as-is
   * @param bundle
   */
  private getBundleIdentity(bundle: Bundle): string {
    // Use custom resolver if provided, otherwise fall back to heuristic
    const sourceType = this.sourceTypeResolver
      ? this.sourceTypeResolver(bundle.sourceId)
      : this.inferSourceType(bundle.sourceId);
    return VersionManager.extractBundleIdentity(bundle.id, sourceType);
  }

  /**
   * Infer source type from source ID using heuristics
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
    // Default to treating as non-consolidatable (safe default)
    this.logger.debug(`Could not infer source type from "${sourceId}", treating as non-consolidatable`);
    return 'local';
  }

  /**
   * Sort bundles by version in descending order (latest first)
   * @param bundles
   */
  private sortBundlesByVersion(bundles: Bundle[]): Bundle[] {
    return bundles.toSorted((a, b) => {
      try {
        return VersionManager.compareVersions(b.version, a.version);
      } catch (error) {
        // If version comparison fails, fall back to date comparison
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Version comparison failed for ${a.id} and ${b.id}: ${errorMsg}. Using dates`);

        const dateB = new Date(b.lastUpdated);
        const dateA = new Date(a.lastUpdated);

        if (Number.isNaN(dateB.getTime()) || Number.isNaN(dateA.getTime())) {
          this.logger.error(`Both version and date comparison failed for ${b.id}, ${a.id}. Preserving order.`);
          return 0; // Preserve original order
        }

        return dateB.getTime() - dateA.getTime();
      }
    });
  }

  /**
   * Convert Bundle to BundleVersion metadata
   * @param bundle
   */
  private toBundleVersion(bundle: Bundle): BundleVersion {
    return {
      version: bundle.version,
      bundleId: bundle.id, // Preserve original bundle ID
      publishedAt: bundle.lastUpdated,
      downloadUrl: bundle.downloadUrl,
      manifestUrl: bundle.manifestUrl,
      releaseNotes: undefined // Could be extracted from bundle metadata
    };
  }

  /**
   * Set a custom source type resolver function
   *
   * This allows the consolidator to accurately determine source types
   * instead of relying on heuristics.
   * @param resolver - Function that maps sourceId to SourceType
   */
  public setSourceTypeResolver(resolver: (sourceId: string) => SourceType): void {
    this.sourceTypeResolver = resolver;
  }

  /**
   * Consolidate bundles by grouping versions of the same bundle
   *
   * For GitHub sources, bundles with the same owner/repo are grouped together
   * and only the latest version is returned. For non-GitHub sources, bundles
   * are returned unchanged.
   * @param bundles - Array of bundles from various sources
   * @returns Consolidated bundles with latest version metadata
   */
  public consolidateBundles(bundles: Bundle[]): ConsolidatedBundle[] {
    this.logger.debug(`Consolidating ${bundles.length} bundles`);

    // Pre-calculate identities to avoid redundant computation
    const bundlesWithIdentity = bundles.map((bundle) => ({
      bundle,
      identity: this.getBundleIdentity(bundle)
    }));

    // Group bundles by identity (owner/repo for GitHub)
    const grouped = new Map<string, typeof bundlesWithIdentity>();

    for (const item of bundlesWithIdentity) {
      if (!grouped.has(item.identity)) {
        grouped.set(item.identity, []);
      }
      grouped.get(item.identity)!.push(item);
    }

    this.logger.debug(`Grouped into ${grouped.size} unique identities`);

    // For each group, select latest version
    const consolidated: ConsolidatedBundle[] = [];

    for (const [identity, items] of grouped.entries()) {
      const itemBundles = items.map((item) => item.bundle);

      if (itemBundles.length === 1) {
        // Single version - no consolidation needed, but still cache for consistency
        const version = this.toBundleVersion(itemBundles[0]);
        this.addToCache(identity, [version]);

        consolidated.push({
          ...itemBundles[0],
          availableVersions: [version],
          isConsolidated: false
        });
        continue;
      }

      // Multiple versions - find latest using version comparison
      const sortedVersions = this.sortBundlesByVersion(itemBundles);
      const latest = sortedVersions[0];
      const allVersions = sortedVersions.map((b) => this.toBundleVersion(b));

      // Cache versions for this identity (with size management)
      this.addToCache(identity, allVersions);

      consolidated.push({
        ...latest,
        availableVersions: allVersions,
        isConsolidated: true
      });
    }

    return consolidated;
  }

  /**
   * Get all versions for a bundle identity
   *
   * Returns all versions sorted in descending semantic version order.
   * @param identity - Unique identifier for the bundle
   * @returns Array of version metadata sorted by version descending
   */
  public getAllVersions(identity: string): BundleVersion[] {
    const entry = this.versionCache.get(identity);
    if (entry) {
      // Update access order for LRU tracking
      this.updateAccessOrder(identity);
      return entry.versions;
    }
    return [];
  }

  /**
   * Get a specific version of a bundle
   *
   * This is useful when a user wants to install a specific version
   * instead of the latest version. Updates the access order for LRU tracking.
   * @param bundleIdentity - Unique identifier for the bundle
   * @param version - Specific version to retrieve
   * @returns Bundle version metadata, or undefined if not found
   */
  public getBundleVersion(bundleIdentity: string, version: string): BundleVersion | undefined {
    const entry = this.versionCache.get(bundleIdentity);
    if (entry) {
      // Update access order for LRU tracking
      this.updateAccessOrder(bundleIdentity);
      return entry.versions.find((v) => v.version === version);
    }
    return undefined;
  }
}
