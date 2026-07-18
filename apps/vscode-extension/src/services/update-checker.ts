/**
 * Update Checker Service
 * Performs update detection by comparing installed versions with latest available versions
 * Wraps RegistryManager.checkUpdates() with caching and auto-update enrichment
 */

import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  ErrorHandler,
} from '../utils/error-handler';
import {
  Logger,
} from '../utils/logger';
import {
  isBundleUpdateArray,
  isSourceArray,
} from '../utils/type-guards';
import {
  RegistryManager,
} from './registry-manager';
import {
  UpdateCache,
  UpdateCheckResult,
} from './update-cache';

/**
 * Update checker service
 * Orchestrates update checking with caching and preference enrichment
 */
export class UpdateChecker {
  private readonly cache: UpdateCache;
  private readonly logger: Logger;

  constructor(
    private readonly registryManager: RegistryManager,
    private readonly storage: RegistryStorage,
    memento: vscode.Memento
  ) {
    this.cache = new UpdateCache(memento);
    this.logger = Logger.getInstance();
  }

  /**
   * Enrich update results with auto-update preferences and metadata
   * Handles errors gracefully by categorizing them and skipping problematic bundles
   * @param updates
   */
  private async enrichUpdateResults(updates: { bundleId: string; currentVersion: string; latestVersion: string; changelog?: string }[]): Promise<UpdateCheckResult[]> {
    const enriched: UpdateCheckResult[] = [];
    const skipped: { bundleId: string; reason: string }[] = [];

    for (const update of updates) {
      const result = await this.enrichSingleUpdate(update);
      if (result.enriched) {
        enriched.push(result.enriched);
      } else if (result.skipped) {
        skipped.push(result.skipped);
      }
    }

    // Log summary of skipped bundles for visibility
    if (skipped.length > 0) {
      this.logger.warn(
        `Skipped ${skipped.length} bundle(s) during update check enrichment: `
        + skipped.map((s) => `${s.bundleId} (${s.reason})`).join(', ')
      );
    }

    return enriched;
  }

  /**
   * Enrich a single update with metadata and preferences
   * Returns structured result with enriched data or skip reason
   * @param update
   * @param update.bundleId
   * @param update.currentVersion
   * @param update.latestVersion
   * @param update.changelog
   */
  private async enrichSingleUpdate(update: { bundleId: string; currentVersion: string; latestVersion: string; changelog?: string }): Promise<{
    enriched?: UpdateCheckResult;
    skipped?: { bundleId: string; reason: string };
  }> {
    try {
      // Get bundle details for additional metadata
      const bundleDetails = await this.registryManager.getBundleDetails(update.bundleId);

      // Get auto-update preference
      const autoUpdateEnabled = await this.storage.getUpdatePreference(update.bundleId);

      return {
        enriched: {
          bundleId: update.bundleId,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
          releaseNotes: update.changelog,
          releaseDate: bundleDetails.lastUpdated,
          downloadUrl: bundleDetails.downloadUrl,
          autoUpdateEnabled
        }
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errorType = ErrorHandler.categorize(err);

      switch (errorType) {
        case 'network': {
          this.logger.debug(`Network error enriching '${update.bundleId}', skipping`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'network error' } };
        }
        case 'notfound': {
          this.logger.debug(`Bundle '${update.bundleId}' not found, may have been removed`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'not found' } };
        }
        case 'authentication': {
          this.logger.debug(`Authentication error enriching '${update.bundleId}'`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'authentication error' } };
        }
        default: {
          // Unexpected error - log and re-throw to surface the issue
          this.logger.error(`Unexpected error enriching '${update.bundleId}'`, err);
          throw new Error(`Failed to enrich update results: ${err.message}`);
        }
      }
    }
  }

  /**
   * Sync GitHub release sources before checking for updates
   * Only syncs sources where type === 'github'
   * Explicitly excludes: 'awesome-copilot', 'local-awesome-copilot', 'local'
   * Handles errors per source (don't fail entire check)
   */
  private async syncGitHubReleaseSources(): Promise<void> {
    this.logger.info('Syncing GitHub release sources before update check');
    const startTime = Date.now();

    try {
      // Get all sources from RegistryManager
      const allSources = await this.registryManager.listSources();

      // Type guard: ensure allSources is a valid source array
      if (!isSourceArray(allSources)) {
        this.logger.error('RegistryManager.listSources() returned invalid data structure');
        throw new Error('Invalid source data received from registry manager');
      }

      // Filter to ONLY GitHub release sources
      const githubSources = allSources.filter((source) => source.type === 'github');

      this.logger.info(`Found ${githubSources.length} GitHub release sources to sync (filtered from ${allSources.length} total sources)`);

      // Log which source types are being excluded
      const excludedTypes = new Set(allSources.filter((s) => s.type !== 'github').map((s) => s.type));
      if (excludedTypes.size > 0) {
        this.logger.debug(`Excluding source types: ${Array.from(excludedTypes).join(', ')}`);
      }

      // Sync each GitHub source
      let successCount = 0;
      let failureCount = 0;

      for (const source of githubSources) {
        try {
          this.logger.debug(`Syncing GitHub source: ${source.id} (${source.name})`);
          await this.registryManager.syncSource(source.id);
          successCount++;
          this.logger.debug(`Successfully synced GitHub source: ${source.id}`);
        } catch (error) {
          failureCount++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(`Failed to sync GitHub source '${source.id}': ${err.message}`, err);
          // Continue with other sources - don't fail entire check
        }
      }

      const duration = Date.now() - startTime;
      this.logger.info(
        `GitHub source sync completed in ${duration}ms: `
        + `${successCount} succeeded, ${failureCount} failed`
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to sync GitHub sources', err);
      // Log error but don't throw - continue with cached data
    }
  }

  /**
   * Check all installed bundles for updates
   * Uses cache if available and valid, otherwise queries RegistryManager
   * Enriches results with auto-update preferences
   * @param bypassCache
   */
  public async checkForUpdates(bypassCache = false): Promise<UpdateCheckResult[]> {
    this.logger.info('Checking for bundle updates');

    // Try cache first unless bypassed
    if (!bypassCache) {
      const cached = await this.cache.get();
      if (cached) {
        this.logger.debug('Returning cached update results');
        return cached;
      }
    }

    // Sync GitHub release sources before checking for updates (only when not using cache)
    if (bypassCache || !this.cache.isValid()) {
      await this.syncGitHubReleaseSources();
    }

    // Query RegistryManager for updates
    const updates = await this.registryManager.checkUpdates();

    // Type guard: ensure updates is a valid BundleUpdate array
    if (!isBundleUpdateArray(updates)) {
      this.logger.error('RegistryManager.checkUpdates() returned invalid data structure');
      throw new Error('Invalid update data received from registry manager');
    }

    // Enrich with auto-update preferences and additional metadata
    const enrichedResults = await this.enrichUpdateResults(updates);

    // Cache the results
    await this.cache.set(enrichedResults);

    this.logger.info(`Found ${enrichedResults.length} bundle updates`);
    return enrichedResults;
  }

  /**
   * Get cached update results without triggering a new check
   */
  public async getCachedResults(): Promise<UpdateCheckResult[] | null> {
    return await this.cache.get();
  }
}
