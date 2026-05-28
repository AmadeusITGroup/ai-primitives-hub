/**
 * Update Cache Service
 * Caches update check results to avoid excessive API calls
 */

import * as vscode from 'vscode';

/**
 * Update check result for a single bundle
 */
export interface UpdateCheckResult {
  bundleId: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseDate: string;
  downloadUrl: string;
  autoUpdateEnabled: boolean;
}

/**
 * Cached update result with metadata
 */
export interface CachedUpdateResult {
  results: UpdateCheckResult[];
  timestamp: Date;
  ttl: number; // Time to live in milliseconds
}

/**
 * Cache constants
 */
const CACHE_CONSTANTS = {
  CACHE_KEY: 'bundleUpdateCache' as const,
  DEFAULT_TTL_MS: 5 * 60 * 1000 // 5 minutes
} as const;

/**
 * Update cache manager
 * Handles caching of update check results with TTL
 */
export class UpdateCache {
  private readonly defaultTTL: number;

  constructor(private readonly storage: vscode.Memento) {
    // Load TTL from configuration, fallback to default
    const config = vscode.workspace.getConfiguration('promptregistry.updateCheck');
    this.defaultTTL = config.get<number>('cacheTTL', CACHE_CONSTANTS.DEFAULT_TTL_MS);
  }

  /**
   * Store update check results with timestamp
   * @param results
   * @param ttl
   */
  public async set(results: UpdateCheckResult[], ttl?: number): Promise<void> {
    const cached: CachedUpdateResult = {
      results,
      timestamp: new Date(),
      ttl: ttl ?? this.defaultTTL
    };

    await this.storage.update(CACHE_CONSTANTS.CACHE_KEY, cached);
  }

  /**
   * Retrieve cached results if still valid
   * Returns null if cache is expired or doesn't exist
   */
  public async get(): Promise<UpdateCheckResult[] | null> {
    const cached = this.storage.get<CachedUpdateResult>(CACHE_CONSTANTS.CACHE_KEY);

    if (!cached) {
      return null;
    }

    if (!this.isValid(cached)) {
      await this.clear();
      return null;
    }

    return cached.results;
  }

  /**
   * Check if cached data is still valid
   * Optimized to avoid redundant Date object creation
   * @param cached
   */
  public isValid(cached?: CachedUpdateResult): boolean {
    const entry = cached ?? this.storage.get<CachedUpdateResult>(CACHE_CONSTANTS.CACHE_KEY);
    if (!entry) {
      return false;
    }

    const now = Date.now();
    const cacheTime = typeof entry.timestamp === 'number'
      ? entry.timestamp
      : new Date(entry.timestamp).getTime();

    return (now - cacheTime) < entry.ttl;
  }

  /**
   * Clear the cache
   */
  public async clear(): Promise<void> {
    await this.storage.update(CACHE_CONSTANTS.CACHE_KEY, undefined);
  }
}
