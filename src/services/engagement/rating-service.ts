/**
 * RatingService - Fetches and caches bundle ratings from hub sources
 *
 * Ratings are served as static JSON files from hubs, computed by GitHub Actions.
 * This service fetches, caches, and provides ratings data to UI components.
 */

import axios from 'axios';
import {
  RatingStats,
} from '../../types/engagement';
import {
  convertRawUrlToApi,
} from '../../utils/github-url-utils';
import {
  Logger,
} from '../../utils/logger';

/**
 * Rating data for a single bundle
 */
export interface BundleRating {
  sourceId: string;
  bundleId: string;
  upvotes: number;
  downvotes: number;
  wilsonScore: number;
  starRating: number;
  totalVotes: number;
  lastUpdated: string;
  /** Discussion number for voting (if available) */
  discussionNumber?: number;
  /** Confidence level based on vote count */
  confidence?: string;
}

/**
 * Ratings file structure served by hubs (bundles format)
 */
export interface RatingsData {
  version: string;
  generatedAt: string;
  bundles: Record<string, BundleRating>;
}

/* eslint-disable @typescript-eslint/naming-convention -- matches compute-ratings.ts output JSON shape */
/**
 * Collection rating from compute-ratings.ts output
 */
export interface CollectionRating {
  source_id?: string;
  discussion_number: number;
  up: number;
  down: number;
  wilson_score: number;
  bayesian_score: number;
  aggregated_score: number;
  star_rating: number;
  rating_count: number;
  confidence: string;
  resources: Record<string, {
    up: number;
    down: number;
    wilson_score: number;
    bayesian_score: number;
    star_rating: number;
    confidence: string;
  }>;
}

/**
 * Ratings file structure from compute-ratings.ts (collections format)
 */
export interface CollectionsRatingsData {
  generated_at: string;
  repository: string;
  collections: Record<string, CollectionRating>;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Service for fetching and caching bundle ratings
 */
export class RatingService {
  private static instance: RatingService | undefined;
  private readonly logger = Logger.getInstance();
  private readonly ratingsCache: Map<string, RatingsData> = new Map();
  private readonly cacheExpiry: Map<string, number> = new Map();
  private readonly cacheDurationMs: number;

  private constructor(cacheDurationMinutes = 15) {
    this.cacheDurationMs = cacheDurationMinutes * 60 * 1000;
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): RatingService {
    if (!RatingService.instance) {
      RatingService.instance = new RatingService();
    }
    return RatingService.instance;
  }

  /**
   * Reset instance (for testing)
   */
  public static resetInstance(): void {
    RatingService.instance = undefined;
  }

  /**
   * Convert collections format (from compute-ratings.ts) to bundles format
   * @param collectionsData
   */
  private convertCollectionsToBundle(collectionsData: CollectionsRatingsData): RatingsData {
    const bundles: Record<string, BundleRating> = {};

    for (const [collectionId, collection] of Object.entries(collectionsData.collections)) {
      bundles[collectionId] = {
        sourceId: collection.source_id || 'unknown',
        bundleId: collectionId,
        upvotes: collection.up,
        downvotes: collection.down,
        wilsonScore: collection.wilson_score,
        starRating: collection.star_rating,
        totalVotes: collection.rating_count || 0,
        lastUpdated: collectionsData.generated_at,
        discussionNumber: collection.discussion_number,
        confidence: collection.confidence
      };
    }

    return {
      version: '1.0.0',
      generatedAt: collectionsData.generated_at,
      bundles
    };
  }

  /**
   * Fetch ratings from a hub's ratings.json URL
   * @param ratingsUrl URL to the ratings.json file
   * @param forceRefresh Force refresh even if cached
   * @param accessToken Optional GitHub token for authenticated requests (private repos)
   */
  public async fetchRatings(ratingsUrl: string, forceRefresh = false, accessToken?: string): Promise<RatingsData | undefined> {
    // Check cache
    if (!forceRefresh && this.ratingsCache.has(ratingsUrl)) {
      const expiry = this.cacheExpiry.get(ratingsUrl) || 0;
      if (Date.now() < expiry) {
        return this.ratingsCache.get(ratingsUrl);
      }
    }

    try {
      // Add cache-busting query parameter (handle existing query params)
      const separator = ratingsUrl.includes('?') ? '&' : '?';
      const urlWithCacheBust = `${ratingsUrl}${separator}t=${Date.now()}`;
      const headers: Record<string, string> = {};
      if (accessToken) {
        headers.Authorization = `token ${accessToken}`;
      }

      // For GitHub API content URLs, use the raw media type to get JSON directly
      headers.Accept = ratingsUrl.includes('api.github.com') ? 'application/vnd.github.v3.raw' : 'application/json';

      let response;
      try {
        response = await axios.get(urlWithCacheBust, { timeout: 10_000, headers });
      } catch (primaryError) {
        // Fallback: convert raw.githubusercontent.com URL to API contents endpoint
        // This handles internal/private repos where raw URLs return 404
        const apiUrl = convertRawUrlToApi(ratingsUrl);
        if (apiUrl && accessToken) {
          this.logger.debug(`Primary fetch failed for ${ratingsUrl}, trying API contents endpoint`);
          const apiHeaders: Record<string, string> = {
            Authorization: `token ${accessToken}`,
            Accept: 'application/vnd.github.v3.raw'
          };
          const apiSeparator = apiUrl.includes('?') ? '&' : '?';
          response = await axios.get(`${apiUrl}${apiSeparator}t=${Date.now()}`, {
            timeout: 10_000,
            headers: apiHeaders
          });
        } else {
          throw primaryError;
        }
      }

      const rawData = response.data as { bundles?: unknown; collections?: unknown };

      // Handle both formats: bundles (new) and collections (compute-ratings.ts output)
      let normalizedData: RatingsData;

      if (rawData.bundles && typeof rawData.bundles === 'object') {
        // Already in bundles format
        normalizedData = rawData as RatingsData;
      } else if (rawData.collections && typeof rawData.collections === 'object') {
        // Convert collections format to bundles format
        normalizedData = this.convertCollectionsToBundle(rawData as CollectionsRatingsData);
      } else {
        this.logger.warn(`Invalid ratings data from ${ratingsUrl}: missing bundles or collections`);
        return undefined;
      }

      // Cache the normalized result
      this.ratingsCache.set(ratingsUrl, normalizedData);
      this.cacheExpiry.set(ratingsUrl, Date.now() + this.cacheDurationMs);

      this.logger.debug(`Fetched ratings from ${ratingsUrl}: ${Object.keys(normalizedData.bundles).length} bundles`);
      return normalizedData;
    } catch (error) {
      const err = error instanceof Error ? error : undefined;
      this.logger.debug(`Failed to fetch ratings from ${ratingsUrl}`, err);
      return undefined;
    }
  }

  /**
   * Get rating for a specific bundle
   * @param ratingsUrl URL to the ratings.json file
   * @param bundleId Bundle identifier
   * @param accessToken
   */
  public async getBundleRating(ratingsUrl: string, bundleId: string, accessToken?: string): Promise<BundleRating | undefined> {
    const ratings = await this.fetchRatings(ratingsUrl, false, accessToken);
    return ratings?.bundles[bundleId];
  }

  /**
   * Get rating stats for a bundle (compatible with RatingStats type)
   * @param ratingsUrl URL to the ratings.json file
   * @param bundleId Bundle identifier
   */
  public async getRatingStats(ratingsUrl: string, bundleId: string): Promise<RatingStats | undefined> {
    const rating = await this.getBundleRating(ratingsUrl, bundleId);
    if (!rating) {
      return undefined;
    }

    // Convert BundleRating to RatingStats
    // Map upvotes to 5-star, downvotes to 1-star for distribution
    return {
      resourceId: bundleId,
      averageRating: rating.starRating,
      ratingCount: rating.totalVotes,
      distribution: {
        1: rating.downvotes,
        2: 0,
        3: 0,
        4: 0,
        5: rating.upvotes
      }
    };
  }

  /**
   * Format rating for display in tree view
   * @param rating Bundle rating data
   * @returns Formatted string like "★ 4.2" or "👍 42"
   */
  public formatRatingForDisplay(rating: BundleRating): string {
    if (rating.totalVotes === 0) {
      return '';
    }

    // Use star rating if we have enough votes for confidence
    if (rating.totalVotes >= 5) {
      return `★ ${rating.starRating.toFixed(1)}`;
    }

    // For fewer votes, just show thumbs up count
    return `👍 ${rating.upvotes}`;
  }

  /**
   * Get formatted rating string for a bundle
   * @param ratingsUrl URL to the ratings.json file
   * @param bundleId Bundle identifier
   */
  public async getFormattedRating(ratingsUrl: string, bundleId: string): Promise<string> {
    const rating = await this.getBundleRating(ratingsUrl, bundleId);
    if (!rating) {
      return '';
    }
    return this.formatRatingForDisplay(rating);
  }

  /**
   * Clear all cached ratings
   */
  public clearCache(): void {
    this.ratingsCache.clear();
    this.cacheExpiry.clear();
  }

  /**
   * Clear cached ratings for a specific URL
   * @param ratingsUrl
   */
  public clearCacheForUrl(ratingsUrl: string): void {
    this.ratingsCache.delete(ratingsUrl);
    this.cacheExpiry.delete(ratingsUrl);
  }

  /**
   * Check if ratings are cached for a URL
   * @param ratingsUrl
   */
  public isCached(ratingsUrl: string): boolean {
    if (!this.ratingsCache.has(ratingsUrl)) {
      return false;
    }
    const expiry = this.cacheExpiry.get(ratingsUrl) || 0;
    return Date.now() < expiry;
  }
}
