/**
 * FeedbackCache - In-memory cache for bundle feedbacks
 *
 * Provides synchronous access to feedbacks for UI components like TreeView
 * that cannot use async methods in their render path.
 *
 * The cache is populated by:
 * 1. Background refresh on extension activation
 * 2. Manual refresh via commands
 * 3. Automatic refresh when FeedbackService fetches new data
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../../utils/logger';
import {
  FeedbackService,
} from './feedback-service';

/**
 * Cached feedback entry with metadata
 */
export interface CachedFeedback {
  /** Feedback ID */
  id: string;
  /** Bundle ID */
  bundleId: string;
  /** Rating (1-5) if provided */
  rating?: number;
  /** Comment text */
  comment: string;
  /** ISO timestamp */
  timestamp: string;
  /** Bundle version at time of feedback */
  version?: string;
  /** When this entry was cached */
  cachedAt: number;
}

/**
 * FeedbackCache provides synchronous access to pre-fetched feedbacks
 */
export class FeedbackCache {
  private static instance: FeedbackCache | undefined;
  private readonly cache: Map<string, CachedFeedback[]> = new Map();
  private readonly logger: Logger;
  private readonly refreshPromises: Map<string, Promise<void>> = new Map();
  private readonly hubIndex: Map<string, Set<string>> = new Map();

  // Events
  private readonly _onCacheUpdated = new vscode.EventEmitter<void>();
  public readonly onCacheUpdated = this._onCacheUpdated.event;

  private constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): FeedbackCache {
    if (!FeedbackCache.instance) {
      FeedbackCache.instance = new FeedbackCache();
    }
    return FeedbackCache.instance;
  }

  /**
   * Reset instance (for testing)
   */
  public static resetInstance(): void {
    if (FeedbackCache.instance) {
      FeedbackCache.instance.dispose();
      FeedbackCache.instance = undefined;
    }
  }

  /**
   * Internal refresh implementation
   * @param hubId
   * @param feedbacksUrl
   * @param accessToken
   */
  private async doRefresh(hubId: string, feedbacksUrl: string, accessToken?: string): Promise<void> {
    try {
      const feedbackService = FeedbackService.getInstance();
      const feedbacksData = await feedbackService.fetchFeedbacks(feedbacksUrl, accessToken);

      if (!feedbacksData || !feedbacksData.bundles) {
        this.logger.debug(`No feedbacks data available from ${hubId}`);
        return;
      }

      // Update cache with new feedbacks
      const now = Date.now();
      const bundles = feedbacksData.bundles;

      const hubKeys = new Set<string>();
      for (const bundleCollection of bundles) {
        const cachedFeedbacks: CachedFeedback[] = bundleCollection.feedbacks.map((feedback) => ({
          id: feedback.id,
          bundleId: bundleCollection.bundleId,
          rating: feedback.rating,
          comment: feedback.comment,
          timestamp: feedback.timestamp,
          version: feedback.version,
          cachedAt: now
        }));

        this.cache.set(bundleCollection.bundleId, cachedFeedbacks);
        hubKeys.add(bundleCollection.bundleId);
      }
      this.hubIndex.set(hubId, hubKeys);

      this.logger.debug(`FeedbackCache refreshed: ${bundles.length} bundles from ${hubId}`);
      this._onCacheUpdated.fire();
    } catch (error) {
      this.logger.warn(`Failed to refresh feedback cache from ${hubId}: ${error}`);
      // Don't clear cache on error - keep stale data
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._onCacheUpdated.dispose();
    this.cache.clear();
    this.hubIndex.clear();
  }

  /**
   * Get feedbacks for a bundle (synchronous)
   * Returns undefined if not cached
   * @param bundleId
   */
  public getFeedbacks(bundleId: string): CachedFeedback[] | undefined {
    return this.cache.get(bundleId);
  }

  /**
   * Check if a bundle has cached feedbacks
   * @param bundleId
   */
  public hasFeedbacks(bundleId: string): boolean {
    return this.cache.has(bundleId);
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
   * Refresh cache from FeedbackService for a specific hub
   * This is async but updates the cache for synchronous access
   * @param hubId
   * @param feedbacksUrl
   * @param accessToken
   */
  public async refreshFromHub(hubId: string, feedbacksUrl: string, accessToken?: string): Promise<void> {
    // Prevent concurrent refreshes for the same URL
    const existing = this.refreshPromises.get(feedbacksUrl);
    if (existing) {
      return existing;
    }

    const promise = this.doRefresh(hubId, feedbacksUrl, accessToken);
    this.refreshPromises.set(feedbacksUrl, promise);
    try {
      await promise;
    } finally {
      this.refreshPromises.delete(feedbacksUrl);
    }
  }

  /**
   * Manually set feedbacks (for testing or local updates)
   * @param bundleId
   * @param feedbacks
   */
  public setFeedbacks(bundleId: string, feedbacks: CachedFeedback[]): void {
    this.cache.set(bundleId, feedbacks);
  }

  /**
   * Clear all cached feedbacks
   */
  public clear(): void {
    this.cache.clear();
    this._onCacheUpdated.fire();
  }

  /**
   * Clear feedbacks for a specific hub (by prefix matching)
   * @param hubId
   */
  public clearHub(hubId: string): void {
    const keys = this.hubIndex.get(hubId);
    if (keys) {
      for (const key of keys) {
        this.cache.delete(key);
      }
      this.hubIndex.delete(hubId);
    }
    this._onCacheUpdated.fire();
  }
}

export { FeedbacksData } from './feedback-service';
