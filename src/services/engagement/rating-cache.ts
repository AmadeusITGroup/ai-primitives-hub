/**
 * RatingCache - In-memory cache for bundle ratings
 *
 * Provides synchronous access to ratings for UI components like TreeView
 * that cannot use async methods in their render path.
 *
 * The cache is populated by:
 * 1. Background refresh on extension activation
 * 2. Manual refresh via commands
 * 3. Automatic refresh when RatingService fetches new data
 */

import * as vscode from 'vscode';
import {
  CachedRating,
  isValidRatingScore,
  RatingScore,
} from '../../types/engagement';
import {
  Logger,
} from '../../utils/logger';
import {
  getConfidenceLevel,
} from '../../utils/rating-algorithms';
import {
  RatingService,
} from './rating-service';

export { CachedRating } from '../../types/engagement';

/**
 * Rating display format for UI
 */
export interface RatingDisplay {
  /** Formatted string like "★ 4.2" */
  text: string;
  /** Tooltip with more details */
  tooltip: string;
}

/**
 * RatingCache provides synchronous access to pre-fetched ratings
 */
export class RatingCache {
  private static instance: RatingCache | undefined;
  private readonly cache: Map<string, CachedRating> = new Map();
  private readonly userRatings: Map<string, RatingScore> = new Map();
  private readonly optimisticKeys: Set<string> = new Set();
  private readonly logger: Logger;
  private readonly refreshPromises: Map<string, Promise<void>> = new Map();
  private readonly hubIndex: Map<string, Set<string>> = new Map();
  /** Reverse map: adapterSourceId → configSourceId (stable, human-readable) */
  private readonly reverseSourceIdMap: Map<string, string> = new Map();
  private hydratedVotesApplied = false;

  // Events
  private readonly _onCacheUpdated = new vscode.EventEmitter<void>();
  public readonly onCacheUpdated = this._onCacheUpdated.event;

  private constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Create composite key from sourceId and bundleId
   * @param sourceId
   * @param bundleId
   */
  private makeKey(sourceId: string, bundleId: string): string {
    return `${sourceId}:${bundleId}`;
  }

  /**
   * Format rating for display
   * @param starRating
   * @param voteCount
   */
  private formatRating(starRating: number, voteCount: number): string {
    if (voteCount === 0) {
      return '';
    }
    // Show star with rating, e.g., "★ 4.2"
    return `★ ${starRating.toFixed(1)}`;
  }

  /**
   * Format tooltip with detailed info
   * @param rating
   */
  private formatTooltip(rating: CachedRating): string {
    const lines = [
      `Rating: ${rating.starRating.toFixed(1)} / 5`,
      `Votes: ${rating.voteCount}`
    ];
    return lines.join('\n');
  }

  /**
   * Inject a user's vote into an existing aggregate entry.
   * If previousUserRating is undefined, this is a new vote (voteCount increments).
   * If defined, the previous vote is swapped for the new one (voteCount unchanged).
   * @param key
   * @param userRating
   * @param previousUserRating
   */
  private injectUserVote(key: string, userRating: RatingScore, previousUserRating: number | undefined): void {
    const existing = this.cache.get(key);
    if (!existing) {
      return;
    }

    if (previousUserRating === undefined) {
      const newVoteCount = existing.voteCount + 1;
      const newStarRating = (existing.starRating * existing.voteCount + userRating) / newVoteCount;
      this.cache.set(key, {
        ...existing,
        starRating: Math.round(newStarRating * 10) / 10,
        voteCount: newVoteCount,
        cachedAt: Date.now()
      });
    } else {
      const totalScore = existing.starRating * existing.voteCount;
      const newTotal = totalScore - previousUserRating + userRating;
      const newStarRating = newTotal / existing.voteCount;
      this.cache.set(key, {
        ...existing,
        starRating: Math.round(newStarRating * 10) / 10,
        cachedAt: Date.now()
      });
    }
  }

  /**
   * Internal refresh implementation
   * @param hubId
   * @param ratingsUrl
   * @param sourceIdMap
   * @param accessToken
   */
  private async doRefresh(hubId: string, ratingsUrl: string, sourceIdMap?: Map<string, string>, accessToken?: string): Promise<void> {
    try {
      // Store reverse map for later use (adapterSourceId → configSourceId)
      if (sourceIdMap) {
        for (const [configId, adapterId] of sourceIdMap.entries()) {
          this.reverseSourceIdMap.set(adapterId, configId);
        }
      }

      const ratingService = RatingService.getInstance();
      const ratingsData = await ratingService.fetchRatings(ratingsUrl, false, accessToken);

      if (!ratingsData || !ratingsData.bundles) {
        this.logger.debug(`No ratings data available from ${hubId}`);
        return;
      }

      // Update cache with new ratings
      const now = Date.now();
      const bundles = ratingsData.bundles;
      const hubKeys = new Set<string>();
      for (const [bundleId, rating] of Object.entries(bundles)) {
        // Map the sourceId from ratings.json to the actual extension source ID
        const actualSourceId = sourceIdMap?.get(rating.sourceId) || rating.sourceId;
        const key = this.makeKey(actualSourceId, bundleId);
        this.cache.set(key, {
          sourceId: actualSourceId,
          bundleId,
          starRating: rating.starRating,
          wilsonScore: rating.wilsonScore,
          voteCount: rating.totalVotes,
          confidence: getConfidenceLevel(rating.totalVotes),
          cachedAt: now
        });
        hubKeys.add(key);
      }
      this.hubIndex.set(hubId, hubKeys);

      // Re-apply in-session optimistic ratings on top of the fresh remote data.
      // ratings.json may not yet include the user's latest vote (compute hasn't re-run).
      for (const key of this.optimisticKeys) {
        const userScore = this.userRatings.get(key);
        if (userScore !== undefined && this.cache.has(key)) {
          this.injectUserVote(key, userScore, undefined);
        }
      }

      this.logger.debug(`RatingCache refreshed: ${Object.keys(bundles).length} ratings from ${hubId}`);
      this._onCacheUpdated.fire();
    } catch (error) {
      this.logger.warn(`Failed to refresh rating cache from ${hubId}: ${error}`);
      // Don't clear cache on error - keep stale data
    }
  }

  /**
   * Hydrate userRatings from pre-resolved local rating data.
   * Called by the orchestration layer (hub-manager) after refresh.
   * Does not overwrite in-session optimistic ratings.
   * @param ratings Array of user ratings to hydrate
   * @param options Optional configuration: overwrite will replace existing entries except optimistic ones
   * @param options.overwrite
   */
  public hydrateUserRatings(
    ratings: { sourceId: string; bundleId: string; score: RatingScore }[],
    options?: { overwrite?: boolean }
  ): void {
    for (const { sourceId, bundleId, score } of ratings) {
      if (!isValidRatingScore(score)) {
        continue;
      }
      const key = this.makeKey(sourceId, bundleId);
      if (options?.overwrite) {
        if (!this.optimisticKeys.has(key)) {
          this.userRatings.set(key, score);
        }
      } else {
        if (!this.userRatings.has(key)) {
          this.userRatings.set(key, score);
        }
      }
    }
  }

  /**
   * Re-apply all hydrated user votes into the aggregate cache.
   * Called after hydration on cold start so the displayed aggregate
   * reflects the user's current vote even when ratings.json is stale.
   * The user's vote is already counted in the remote aggregate, so this
   * performs a swap (not an addition).
   */
  public reapplyHydratedVotes(): void {
    if (this.hydratedVotesApplied) {
      return;
    }
    for (const [key, score] of this.userRatings.entries()) {
      if (this.optimisticKeys.has(key)) {
        continue;
      }
      const entry = this.cache.get(key);
      if (!entry) {
        continue;
      }
      this.injectUserVote(key, score, entry.starRating);
    }
    this.hydratedVotesApplied = true;
    this._onCacheUpdated.fire();
  }

  /**
   * Get the stable config source ID for an adapter source ID.
   * Used when persisting ratings so they survive source hash changes.
   * Returns the adapterSourceId itself if no mapping exists.
   * @param adapterSourceId
   */
  public getConfigSourceId(adapterSourceId: string): string {
    return this.reverseSourceIdMap.get(adapterSourceId) || adapterSourceId;
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): RatingCache {
    if (!RatingCache.instance) {
      RatingCache.instance = new RatingCache();
    }
    return RatingCache.instance;
  }

  /**
   * Reset instance (for testing)
   */
  public static resetInstance(): void {
    if (RatingCache.instance) {
      RatingCache.instance.dispose();
      RatingCache.instance = undefined;
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._onCacheUpdated.dispose();
    this.cache.clear();
    this.userRatings.clear();
    this.optimisticKeys.clear();
    this.hubIndex.clear();
    this.reverseSourceIdMap.clear();
    this.hydratedVotesApplied = false;
  }

  /**
   * Get rating for a bundle (synchronous)
   * Returns undefined if not cached
   * @param sourceId
   * @param bundleId
   */
  public getRating(sourceId: string, bundleId: string): CachedRating | undefined {
    const key = this.makeKey(sourceId, bundleId);
    return this.cache.get(key);
  }

  /**
   * Get formatted rating display for UI
   * Returns undefined if not cached or no rating
   * @param sourceId
   * @param bundleId
   */
  public getRatingDisplay(sourceId: string, bundleId: string): RatingDisplay | undefined {
    const rating = this.getRating(sourceId, bundleId);
    if (!rating || rating.voteCount === 0 || rating.starRating === 0) {
      return undefined;
    }

    return {
      text: this.formatRating(rating.starRating, rating.voteCount),
      tooltip: this.formatTooltip(rating)
    };
  }

  /**
   * Check if a bundle has a cached rating
   * @param sourceId
   * @param bundleId
   */
  public hasRating(sourceId: string, bundleId: string): boolean {
    const key = this.makeKey(sourceId, bundleId);
    return this.cache.has(key);
  }

  /**
   * Get all cached bundle IDs
   */
  public getCachedBundleIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get cache size
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Refresh cache from RatingService for a specific hub
   * This is async but updates the cache for synchronous access
   * @param hubId Hub identifier
   * @param ratingsUrl URL to ratings.json
   * @param sourceIdMap Map from ratings.json source_id to actual extension source ID
   * @param accessToken
   */
  public async refreshFromHub(hubId: string, ratingsUrl: string, sourceIdMap?: Map<string, string>, accessToken?: string): Promise<void> {
    // Prevent concurrent refreshes for the same URL
    const existing = this.refreshPromises.get(ratingsUrl);
    if (existing) {
      return existing;
    }

    const promise = this.doRefresh(hubId, ratingsUrl, sourceIdMap, accessToken);
    this.refreshPromises.set(ratingsUrl, promise);
    try {
      await promise;
    } finally {
      this.refreshPromises.delete(ratingsUrl);
    }
  }

  /**
   * Manually set a rating (for testing or local updates)
   * @param rating
   */
  public setRating(rating: CachedRating): void {
    const key = this.makeKey(rating.sourceId, rating.bundleId);
    this.cache.set(key, rating);
  }

  /**
   * Get the user's own rating for a bundle (what they've submitted before), if any.
   * Returns undefined if the user hasn't rated this bundle.
   * @param sourceId
   * @param bundleId
   */
  public getUserRating(sourceId: string, bundleId: string): RatingScore | undefined {
    return this.userRatings.get(this.makeKey(sourceId, bundleId));
  }

  /**
   * Apply an optimistic rating update after the user submits a new rating.
   * If the user had previously rated this bundle, the previous vote is replaced
   * (aggregate voteCount stays the same; only starRating shifts).
   * If this is a new vote, voteCount increments by one.
   * Will be silently overwritten on next ratings.json fetch.
   * @param sourceId
   * @param bundleId
   * @param userRating New rating the user just submitted
   */
  public applyOptimisticRating(sourceId: string, bundleId: string, userRating: RatingScore): void {
    const key = this.makeKey(sourceId, bundleId);
    const existing = this.cache.get(key);
    const previousUserRating = this.userRatings.get(key);

    if (existing) {
      this.injectUserVote(key, userRating, previousUserRating);
    } else {
      this.cache.set(key, {
        sourceId,
        bundleId,
        starRating: userRating,
        wilsonScore: 0,
        voteCount: 1,
        confidence: 'low',
        cachedAt: Date.now()
      });
    }

    this.userRatings.set(key, userRating);
    this.optimisticKeys.add(key);
    this._onCacheUpdated.fire();
  }

  /**
   * Roll back an optimistic rating update after a backend submit failure.
   * Restores the aggregate and the user's own rating to what they were before
   * applyOptimisticRating was called.
   * @param sourceId
   * @param bundleId
   * @param appliedRating The rating that was optimistically applied and needs to be undone
   * @param previousUserRating The user's prior rating for this bundle, or undefined if they had none
   */
  public rollbackOptimisticRating(
    sourceId: string,
    bundleId: string,
    appliedRating: RatingScore,
    previousUserRating: RatingScore | undefined
  ): void {
    const key = this.makeKey(sourceId, bundleId);
    const existing = this.cache.get(key);

    if (!existing) {
      // Nothing to roll back.
      return;
    }

    if (previousUserRating === undefined) {
      // Rollback a first-time rating on a bundle: decrement voteCount, remove the user's rating.
      if (existing.voteCount <= 1) {
        // This was the only vote; drop the entry entirely.
        this.cache.delete(key);
      } else {
        const totalScore = existing.starRating * existing.voteCount;
        const restored = totalScore - appliedRating;
        const newVoteCount = existing.voteCount - 1;
        const restoredStarRating = restored / newVoteCount;
        this.cache.set(key, {
          ...existing,
          starRating: Math.round(restoredStarRating * 10) / 10,
          voteCount: newVoteCount,
          cachedAt: Date.now()
        });
      }
      this.userRatings.delete(key);
    } else {
      // Rollback a re-rating: swap the newly-applied rating back to the previous one. voteCount unchanged.
      const totalScore = existing.starRating * existing.voteCount;
      const restored = totalScore - appliedRating + previousUserRating;
      const restoredStarRating = restored / existing.voteCount;
      this.cache.set(key, {
        ...existing,
        starRating: Math.round(restoredStarRating * 10) / 10,
        cachedAt: Date.now()
      });
      this.userRatings.set(key, previousUserRating);
    }

    this._onCacheUpdated.fire();
  }

  /**
   * Clear all cached ratings
   */
  public clear(): void {
    this.cache.clear();
    this.userRatings.clear();
    this.optimisticKeys.clear();
    this.hydratedVotesApplied = false;
    this._onCacheUpdated.fire();
  }

  /**
   * Clear ratings for a specific hub (by prefix matching)
   * @param hubId
   */
  public clearHub(hubId: string): void {
    const keys = this.hubIndex.get(hubId);
    if (keys) {
      for (const key of keys) {
        this.cache.delete(key);
        this.userRatings.delete(key);
      }
      this.hubIndex.delete(hubId);
    }
    this._onCacheUpdated.fire();
  }
}
