/**
 * EngagementHydrator - Orchestrates engagement cache warm-up and user rating hydration.
 *
 * Extracted from HubManager to isolate engagement-domain orchestration logic.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  HubEngagementConfig,
  RatingScore,
} from '../../types/engagement';
import {
  HubSource,
} from '../../types/hub';
import {
  Logger,
} from '../../utils/logger';
import {
  generateHubSourceId,
  parseCompositeResourceId,
} from '../../utils/source-id-utils';
import {
  isViewerRatingsBackend,
} from './engagement-backend';
import {
  EngagementService,
} from './engagement-service';
import {
  FeedbackCache,
} from './feedback-cache';
import {
  RatingCache,
} from './rating-cache';

/**
 * Orchestrates engagement hydration for a hub:
 * - Builds sourceIdMap from hub sources
 * - Warms rating and feedback caches from static URLs
 * - Hydrates user ratings from local storage and remote backend
 */
export class EngagementHydrator {
  private readonly logger = Logger.getInstance();
  private readonly engagementService: EngagementService;
  private readonly ratingCache: RatingCache;
  private readonly feedbackCache: FeedbackCache;

  constructor(
    engagementService: EngagementService,
    ratingCache: RatingCache,
    feedbackCache: FeedbackCache
  ) {
    this.engagementService = engagementService;
    this.ratingCache = ratingCache;
    this.feedbackCache = feedbackCache;
  }

  private async fetchRemoteViewerRatings(
    hubId: string,
    backendType: string,
    sourceIdMap: Map<string, string> | undefined
  ): Promise<{ resourceId: string; score: RatingScore }[]> {
    if (backendType !== 'github-discussions' || !sourceIdMap) {
      return [];
    }
    try {
      const backend = this.engagementService.getHubBackend(hubId);
      if (backend && isViewerRatingsBackend(backend)) {
        return await backend.fetchViewerRatings();
      }
    } catch (error) {
      this.logger.debug(`Failed to hydrate user ratings from remote: ${error}`);
    }
    return [];
  }

  private async hydrateFromLocalStorage(sourceIdMap: Map<string, string> | undefined): Promise<void> {
    try {
      if (sourceIdMap) {
        const localRatings = await this.engagementService.getAllRatings();
        const resolved = localRatings
          .filter((r) => r.resourceType === 'bundle' && r.sourceId && r.score)
          .map((r) => ({
            sourceId: sourceIdMap.get(r.sourceId!) || r.sourceId!,
            bundleId: r.resourceId,
            score: r.score
          }));
        if (resolved.length > 0) {
          this.ratingCache.hydrateUserRatings(resolved);
          this.ratingCache.reapplyHydratedVotes();
        }
      }
    } catch (error) {
      this.logger.debug(`Failed to hydrate user ratings from storage: ${error}`);
    }
  }

  private async applyRemoteRatings(
    remoteRatings: { resourceId: string; score: RatingScore }[],
    sourceIdMap: Map<string, string>
  ): Promise<void> {
    const now = new Date().toISOString();
    const parsed = remoteRatings.map((r) => {
      const { sourceId: configSourceId, bundleId } = parseCompositeResourceId(r.resourceId);
      return { configSourceId, bundleId, score: r.score };
    });

    this.ratingCache.hydrateUserRatings(
      parsed.map((p) => ({
        sourceId: sourceIdMap.get(p.configSourceId) || p.configSourceId,
        bundleId: p.bundleId,
        score: p.score
      })),
      { overwrite: true }
    );

    // Persist remote ratings locally for next startup's instant hydration
    await this.engagementService.saveRatings(parsed.map((p) => ({
      id: crypto.randomUUID(),
      resourceType: 'bundle' as const,
      resourceId: p.bundleId,
      score: p.score,
      sourceId: p.configSourceId,
      timestamp: now
    })));
  }

  /**
   * Build a sourceIdMap from hub sources.
   * Maps config source id (e.g. "otter") to generated adapter source id.
   * @param hubSources
   */
  public buildSourceIdMap(hubSources?: HubSource[]): Map<string, string> | undefined {
    if (!hubSources || hubSources.length === 0) {
      return undefined;
    }
    const sourceIdMap = new Map<string, string>();
    for (const src of hubSources) {
      if (!src.enabled) {
        continue;
      }
      const adapterSourceId = generateHubSourceId(src.type, src.url, {
        branch: src.config?.branch,
        collectionsPath: src.config?.collectionsPath
      });
      sourceIdMap.set(src.id, adapterSourceId);
    }
    return sourceIdMap;
  }

  /**
   * Run the full hydration workflow for a hub:
   * 1. Warm caches from static URLs
   * 2. Fetch remote viewer ratings
   * 3. Hydrate user ratings from local storage
   * 4. Apply remote ratings (authoritative overwrite)
   * @param hubId
   * @param engagement
   * @param sourceIdMap
   */
  public async hydrate(
    hubId: string,
    engagement: HubEngagementConfig,
    sourceIdMap: Map<string, string> | undefined
  ): Promise<void> {
    // Get token for authenticated fetches (private/internal repos)
    let accessToken: string | undefined;
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
      accessToken = session?.accessToken;
    } catch {
      this.logger.debug(`No GitHub session available for cache warm-up`);
    }

    const ratingsUrl = engagement.ratings?.ratingsUrl;
    const feedbackUrl = engagement.feedback?.feedbackUrl;

    // Run independent network operations in parallel
    const remoteRatings = (await Promise.all([
      ratingsUrl
        ? this.ratingCache.refreshFromHub(hubId, ratingsUrl, sourceIdMap, accessToken)
          .catch((error) => this.logger.debug(`Failed to warm rating cache for hub ${hubId}`, error))
        : Promise.resolve(),
      feedbackUrl
        ? this.feedbackCache.refreshFromHub(hubId, feedbackUrl, accessToken)
          .catch((error) => this.logger.debug(`Failed to warm feedback cache for hub ${hubId}`, error))
        : Promise.resolve(),
      this.fetchRemoteViewerRatings(hubId, engagement.backend.type, sourceIdMap)
    ]))[2];

    // Hydrate user's own ratings from local storage so getUserRating works across sessions
    await this.hydrateFromLocalStorage(sourceIdMap);

    // Apply remote ratings (overwrite local — remote is authoritative)
    if (remoteRatings.length > 0 && sourceIdMap) {
      await this.applyRemoteRatings(remoteRatings, sourceIdMap);
    }
  }
}
