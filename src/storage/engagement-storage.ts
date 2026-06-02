/**
 * EngagementStorage - File-based persistence for engagement data
 *
 * Storage structure:
 * globalStorage/
 * └── engagement/
 *     ├── ratings.json        # User ratings
 *     └── feedback.json       # User feedback
 */

import * as fs from 'node:fs';
import {
  promises as fsp,
} from 'node:fs';
import * as path from 'node:path';
import {
  EngagementResourceType,
  Feedback,
  Rating,
} from '../types/engagement';
import {
  PendingFeedback,
} from '../types/pending-feedback';

/**
 * Storage paths for engagement data
 */
interface EngagementStoragePaths {
  root: string;
  ratings: string;
  feedback: string;
  pendingFeedback: string;
}

/**
 * Internal storage format for ratings
 */
interface RatingsStore {
  version: string;
  ratings: Rating[];
}

/**
 * Internal storage format for feedback
 */
interface FeedbackStore {
  version: string;
  feedback: Feedback[];
}

/**
 * Internal storage format for pending feedback
 */
interface PendingFeedbackStore {
  version: string;
  entries: PendingFeedback[];
}

/**
 * EngagementStorage manages file-based persistence for engagement data
 */
export class EngagementStorage {
  private static readonly STORAGE_VERSION = '1.0.0';
  private static readonly MAX_FEEDBACK_ENTRIES = 1000;

  private readonly paths: EngagementStoragePaths;
  private ratingsCache?: RatingsStore;
  private feedbackCache?: FeedbackStore;
  private pendingFeedbackCache?: PendingFeedbackStore;

  constructor(storagePath: string) {
    if (!storagePath || storagePath.trim() === '') {
      throw new Error('Storage path cannot be empty');
    }

    const engagementDir = path.join(storagePath, 'engagement');
    this.paths = {
      root: engagementDir,
      ratings: path.join(engagementDir, 'ratings.json'),
      feedback: path.join(engagementDir, 'feedback.json'),
      pendingFeedback: path.join(engagementDir, 'pending-feedback.json')
    };
  }

  private async loadPendingFeedbackStore(): Promise<PendingFeedbackStore> {
    if (this.pendingFeedbackCache) {
      return this.pendingFeedbackCache;
    }
    try {
      const data = await fsp.readFile(this.paths.pendingFeedback, 'utf8');
      this.pendingFeedbackCache = JSON.parse(data) as PendingFeedbackStore;
      return this.pendingFeedbackCache;
    } catch {
      return { version: EngagementStorage.STORAGE_VERSION, entries: [] };
    }
  }

  private async savePendingFeedbackStore(store: PendingFeedbackStore): Promise<void> {
    await this.initialize();
    await fsp.writeFile(this.paths.pendingFeedback, JSON.stringify(store, null, 2), 'utf8');
    this.pendingFeedbackCache = store;
  }

  private async loadRatingsStore(): Promise<RatingsStore> {
    if (this.ratingsCache) {
      return this.ratingsCache;
    }

    try {
      const data = await fsp.readFile(this.paths.ratings, 'utf8');
      this.ratingsCache = JSON.parse(data) as RatingsStore;
      return this.ratingsCache;
    } catch {
      return {
        version: EngagementStorage.STORAGE_VERSION,
        ratings: []
      };
    }
  }

  private async saveRatingsStore(store: RatingsStore): Promise<void> {
    await this.initialize();
    await fsp.writeFile(this.paths.ratings, JSON.stringify(store, null, 2), 'utf8');
    this.ratingsCache = store;
  }

  private async loadFeedbackStore(): Promise<FeedbackStore> {
    if (this.feedbackCache) {
      return this.feedbackCache;
    }

    try {
      const data = await fsp.readFile(this.paths.feedback, 'utf8');
      this.feedbackCache = JSON.parse(data) as FeedbackStore;
      return this.feedbackCache;
    } catch {
      return {
        version: EngagementStorage.STORAGE_VERSION,
        feedback: []
      };
    }
  }

  private async saveFeedbackStore(store: FeedbackStore): Promise<void> {
    await this.initialize();
    await fsp.writeFile(this.paths.feedback, JSON.stringify(store, null, 2), 'utf8');
    this.feedbackCache = store;
  }

  /**
   * Initialize storage directories
   */
  public async initialize(): Promise<void> {
    if (!fs.existsSync(this.paths.root)) {
      await fsp.mkdir(this.paths.root, { recursive: true });
    }
  }

  /**
   * Get storage paths
   */
  public getPaths(): EngagementStoragePaths {
    return { ...this.paths };
  }

  // ========================================================================
  // Rating Operations
  // ========================================================================

  /**
   * Save or update a rating
   * @param rating
   */
  public async saveRating(rating: Rating): Promise<void> {
    const store = await this.loadRatingsStore();

    // Find existing rating for same resource
    const existingIndex = store.ratings.findIndex(
      (r) => r.resourceType === rating.resourceType && r.resourceId === rating.resourceId
    );

    if (existingIndex === -1) {
      // Add new
      store.ratings.push(rating);
    } else {
      // Update existing
      store.ratings[existingIndex] = rating;
    }

    await this.saveRatingsStore(store);
  }

  /**
   * Get rating for a specific resource
   * @param resourceType
   * @param resourceId
   */
  public async getRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<Rating | undefined> {
    const store = await this.loadRatingsStore();
    return store.ratings.find(
      (r) => r.resourceType === resourceType && r.resourceId === resourceId
    );
  }

  /**
   * Save multiple ratings in a single write (avoids N disk writes).
   * @param ratings
   */
  public async saveRatings(ratings: Rating[]): Promise<void> {
    if (ratings.length === 0) {
      return;
    }
    const store = await this.loadRatingsStore();
    for (const rating of ratings) {
      const existingIndex = store.ratings.findIndex(
        (r) => r.resourceType === rating.resourceType && r.resourceId === rating.resourceId
      );
      if (existingIndex === -1) {
        store.ratings.push(rating);
      } else {
        store.ratings[existingIndex] = rating;
      }
    }
    await this.saveRatingsStore(store);
  }

  /**
   * Get all ratings
   */
  public async getAllRatings(): Promise<Rating[]> {
    const store = await this.loadRatingsStore();
    return store.ratings;
  }

  /**
   * Delete rating for a resource
   * @param resourceType
   * @param resourceId
   */
  public async deleteRating(
    resourceType: EngagementResourceType,
    resourceId: string
  ): Promise<void> {
    const store = await this.loadRatingsStore();
    store.ratings = store.ratings.filter(
      (r) => !(r.resourceType === resourceType && r.resourceId === resourceId)
    );
    await this.saveRatingsStore(store);
  }

  // ========================================================================
  // Feedback Operations
  // ========================================================================

  /**
   * Save feedback
   * @param feedback
   */
  public async saveFeedback(feedback: Feedback): Promise<void> {
    const store = await this.loadFeedbackStore();
    store.feedback.push(feedback);

    // Trim old feedback if exceeding max
    if (store.feedback.length > EngagementStorage.MAX_FEEDBACK_ENTRIES) {
      store.feedback = store.feedback.slice(-EngagementStorage.MAX_FEEDBACK_ENTRIES);
    }

    await this.saveFeedbackStore(store);
  }

  /**
   * Get feedback for a specific resource
   * @param resourceType
   * @param resourceId
   * @param limit
   */
  public async getFeedback(
    resourceType: EngagementResourceType,
    resourceId: string,
    limit?: number
  ): Promise<Feedback[]> {
    const store = await this.loadFeedbackStore();
    let feedback = store.feedback.filter(
      (f) => f.resourceType === resourceType && f.resourceId === resourceId
    );

    // Sort by timestamp descending (most recent first)
    feedback.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (limit && limit > 0) {
      feedback = feedback.slice(0, limit);
    }

    return feedback;
  }

  /**
   * Get all feedback
   */
  public async getAllFeedback(): Promise<Feedback[]> {
    const store = await this.loadFeedbackStore();
    return store.feedback;
  }

  /**
   * Delete feedback by ID
   * @param feedbackId
   */
  public async deleteFeedback(feedbackId: string): Promise<void> {
    const store = await this.loadFeedbackStore();
    store.feedback = store.feedback.filter((f) => f.id !== feedbackId);
    await this.saveFeedbackStore(store);
  }

  // ========================================================================
  // Pending Feedback Operations
  // ========================================================================

  public async savePendingFeedback(entry: PendingFeedback): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    const existingIndex = store.entries.findIndex(
      (e) => e.bundleId === entry.bundleId && e.resourceType === entry.resourceType
    );
    if (existingIndex === -1) {
      store.entries.push(entry);
    } else {
      store.entries[existingIndex] = entry;
    }
    await this.savePendingFeedbackStore(store);
  }

  public async getPendingFeedback(): Promise<PendingFeedback[]> {
    const store = await this.loadPendingFeedbackStore();
    return store.entries;
  }

  public async getUnsyncedFeedback(): Promise<PendingFeedback[]> {
    const store = await this.loadPendingFeedbackStore();
    return store.entries.filter((e) => !e.synced);
  }

  public async markFeedbackSynced(id: string): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    const entry = store.entries.find((e) => e.id === id);
    if (entry) {
      entry.synced = true;
      await this.savePendingFeedbackStore(store);
    }
  }

  public async deletePendingFeedback(id: string): Promise<void> {
    const store = await this.loadPendingFeedbackStore();
    store.entries = store.entries.filter((e) => e.id !== id);
    await this.savePendingFeedbackStore(store);
  }

  // ========================================================================
  // Cache Management
  // ========================================================================

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.ratingsCache = undefined;
    this.feedbackCache = undefined;
    this.pendingFeedbackCache = undefined;
  }

  /**
   * Clear all engagement data
   */
  public async clearAll(): Promise<void> {
    const emptyRatings: RatingsStore = {
      version: EngagementStorage.STORAGE_VERSION,
      ratings: []
    };
    await this.saveRatingsStore(emptyRatings);

    const emptyFeedback: FeedbackStore = {
      version: EngagementStorage.STORAGE_VERSION,
      feedback: []
    };
    await this.saveFeedbackStore(emptyFeedback);

    const emptyPending: PendingFeedbackStore = {
      version: EngagementStorage.STORAGE_VERSION,
      entries: []
    };
    await this.savePendingFeedbackStore(emptyPending);
  }
}
