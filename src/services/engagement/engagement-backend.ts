/**
 * Interface for engagement data backends
 * Implementations handle storage/retrieval of ratings and feedback
 */

import {
  BackendConfig,
  EngagementResourceType,
  Feedback,
  Rating,
  RatingScore,
  RatingStats,
  ResourceEngagement,
} from '../../types/engagement';

/**
 * Backend interface for engagement data storage
 */
export interface IEngagementBackend {
  /** Backend type identifier */
  readonly type: string;

  /** Whether the backend is initialized */
  readonly initialized: boolean;

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /**
   * Initialize the backend with configuration
   * @param config Backend-specific configuration
   */
  initialize(config: BackendConfig): Promise<void>;

  /**
   * Clean up resources
   */
  dispose(): void;

  // ========================================================================
  // Rating Operations
  // ========================================================================

  /**
   * Submit or update a rating
   * @param rating Rating to submit
   */
  submitRating(rating: Rating): Promise<void>;

  /**
   * Get user's rating for a resource
   * @param resourceType Type of resource
   * @param resourceId Resource identifier
   * @returns User's rating or undefined
   */
  getRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<Rating | undefined>;

  /**
   * Get aggregated rating statistics
   * @param resourceType Type of resource
   * @param resourceId Resource identifier
   * @returns Aggregated rating stats
   */
  getAggregatedRatings(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<RatingStats | undefined>;

  /**
   * Delete user's rating
   * @param resourceType Type of resource
   * @param resourceId Resource identifier
   */
  deleteRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<void>;

  // ========================================================================
  // Feedback Operations
  // ========================================================================

  /**
   * Submit feedback
   * @param feedback Feedback to submit
   */
  submitFeedback(feedback: Feedback): Promise<void>;

  /**
   * Get feedback for a resource
   * @param resourceType Type of resource
   * @param resourceId Resource identifier
   * @param limit Maximum number of entries
   * @returns Array of feedback entries
   */
  getFeedback(
    resourceType: EngagementResourceType,
    resourceId: string,
    limit?: number
  ): Promise<Feedback[]>;

  /**
   * Delete feedback
   * @param feedbackId Feedback ID to delete
   */
  deleteFeedback(feedbackId: string): Promise<void>;

  // ========================================================================
  // Aggregation
  // ========================================================================

  /**
   * Get combined engagement data for a resource
   * @param resourceType Type of resource
   * @param resourceId Resource identifier
   * @returns Combined engagement data
   */
  getResourceEngagement(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<ResourceEngagement>;
}

export interface IViewerRatingsBackend extends IEngagementBackend {
  fetchViewerRatings(): Promise<{ resourceId: string; score: RatingScore }[]>;
}

/**
 * Type guard to check if a backend supports fetching viewer ratings
 * @param backend
 */
export function isViewerRatingsBackend(backend: IEngagementBackend): backend is IViewerRatingsBackend {
  return 'fetchViewerRatings' in backend;
}

/**
 * Abstract base class for engagement backends
 * Provides common functionality and default implementations
 */
export abstract class BaseEngagementBackend implements IEngagementBackend {
  public abstract readonly type: string;
  protected _initialized = false;

  public get initialized(): boolean {
    return this._initialized;
  }

  public abstract initialize(config: BackendConfig): Promise<void>;
  public abstract dispose(): void;

  public abstract submitRating(rating: Rating): Promise<void>;
  public abstract getRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<Rating | undefined>;
  public abstract getAggregatedRatings(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<RatingStats | undefined>;
  public abstract deleteRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<void>;

  public abstract submitFeedback(feedback: Feedback): Promise<void>;
  public abstract getFeedback(
    resourceType: EngagementResourceType,
    resourceId: string,
    limit?: number
  ): Promise<Feedback[]>;
  public abstract deleteFeedback(feedbackId: string): Promise<void>;

  /**
   * Ensure backend is initialized before operations
   */
  protected ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error(`Backend '${this.type}' is not initialized. Call initialize() first.`);
    }
  }

  /**
   * Default implementation that aggregates data from individual methods
   * @param resourceType
   * @param resourceId
   */
  public async getResourceEngagement(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<ResourceEngagement> {
    const [ratings, feedback] = await Promise.all([
      this.getAggregatedRatings(resourceType, resourceId),
      this.getFeedback(resourceType, resourceId, 5)
    ]);

    return {
      resourceId,
      resourceType,
      ratings: ratings || undefined,
      recentFeedback: feedback.length > 0 ? feedback : undefined
    };
  }
}
