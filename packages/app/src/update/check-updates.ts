/**
 * UpdateCheckerCore — portable orchestration ported from the extension's
 * `src/services/update-checker.ts`. Compares installed bundles against
 * their sources, syncs GitHub release sources first when the cache is
 * stale, and enriches each raw `BundleUpdate` with display metadata and
 * the caller's auto-update preference.
 *
 * Depends only on `core` ports (`UpdateRegistryReader`, narrowed
 * `UpdatePreferenceStore`) plus a small `UpdateResultCache` port local
 * to this module (the result-caching *shape*, not `vscode.Memento`
 * itself) — the extension's thin `UpdateChecker` wrapper adapts its
 * `RegistryManager`/`RegistryStorage`/`UpdateCache` instances to these,
 * with no behavior change.
 * @module update/check-updates
 */
import {
  categorizeError,
  isBundleUpdateArray,
  isSourceArray,
} from '@ai-primitives-hub/core';
import type {
  BundleUpdate,
  UpdateCheckResult,
  UpdateRegistryReader,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from './log-event';

/**
 * Read access to a single bundle's auto-update preference — all
 * `UpdateCheckerCore` needs from a full `UpdatePreferenceStore`.
 */
export interface UpdatePreferenceReader {
  getUpdatePreference(bundleId: string): Promise<boolean>;
}

/**
 * Caches the enriched update-check results between calls.
 */
export interface UpdateResultCache {
  get(): Promise<UpdateCheckResult[] | null>;
  set(results: UpdateCheckResult[]): Promise<void>;
  isValid(): boolean;
}

export interface UpdateCheckerCoreOptions {
  registry: UpdateRegistryReader;
  preferences: UpdatePreferenceReader;
  cache: UpdateResultCache;
  onLog?: OnLogEvent;
}

interface EnrichOutcome {
  enriched?: UpdateCheckResult;
  skipped?: { bundleId: string; reason: string };
}

/**
 * Orchestrates update checking with caching and preference enrichment.
 */
export class UpdateCheckerCore {
  public constructor(private readonly opts: UpdateCheckerCoreOptions) {}

  private log(level: LogEvent['level'], message: string, error?: Error): void {
    this.opts.onLog?.({ level, message, error });
  }

  private async enrichUpdateResults(updates: BundleUpdate[]): Promise<UpdateCheckResult[]> {
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

    if (skipped.length > 0) {
      this.log(
        'warn',
        `Skipped ${skipped.length} bundle(s) during update check enrichment: `
        + skipped.map((s) => `${s.bundleId} (${s.reason})`).join(', ')
      );
    }

    return enriched;
  }

  private async enrichSingleUpdate(update: BundleUpdate): Promise<EnrichOutcome> {
    try {
      const bundleDetails = await this.opts.registry.getBundleDetails(update.bundleId);
      const autoUpdateEnabled = await this.opts.preferences.getUpdatePreference(update.bundleId);

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
      const errorType = categorizeError(err);

      switch (errorType) {
        case 'network': {
          this.log('debug', `Network error enriching '${update.bundleId}', skipping`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'network error' } };
        }
        case 'notfound': {
          this.log('debug', `Bundle '${update.bundleId}' not found, may have been removed`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'not found' } };
        }
        case 'authentication': {
          this.log('debug', `Authentication error enriching '${update.bundleId}'`, err);
          return { skipped: { bundleId: update.bundleId, reason: 'authentication error' } };
        }
        default: {
          this.log('error', `Unexpected error enriching '${update.bundleId}'`, err);
          throw new Error(`Failed to enrich update results: ${err.message}`);
        }
      }
    }
  }

  /**
   * Sync GitHub release sources before checking for updates. Only syncs
   * sources where `type === 'github'`; handles errors per-source so one
   * failing source doesn't fail the entire check.
   */
  private async syncGitHubReleaseSources(): Promise<void> {
    this.log('info', 'Syncing GitHub release sources before update check');
    const startTime = Date.now();

    try {
      const allSources = await this.opts.registry.listSources();

      if (!isSourceArray(allSources)) {
        this.log('error', 'RegistryManager.listSources() returned invalid data structure');
        throw new Error('Invalid source data received from registry manager');
      }

      const githubSources = allSources.filter((source) => source.type === 'github');

      this.log('info', `Found ${githubSources.length} GitHub release sources to sync (filtered from ${allSources.length} total sources)`);

      const excludedTypes = new Set(allSources.filter((s) => s.type !== 'github').map((s) => s.type));
      if (excludedTypes.size > 0) {
        this.log('debug', `Excluding source types: ${Array.from(excludedTypes).join(', ')}`);
      }

      let successCount = 0;
      let failureCount = 0;

      for (const source of githubSources) {
        try {
          this.log('debug', `Syncing GitHub source: ${source.id} (${source.name})`);
          await this.opts.registry.syncSource(source.id);
          successCount++;
          this.log('debug', `Successfully synced GitHub source: ${source.id}`);
        } catch (error) {
          failureCount++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.log('warn', `Failed to sync GitHub source '${source.id}': ${err.message}`, err);
        }
      }

      const duration = Date.now() - startTime;
      this.log(
        'info',
        `GitHub source sync completed in ${duration}ms: `
        + `${successCount} succeeded, ${failureCount} failed`
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log('error', 'Failed to sync GitHub sources', err);
    }
  }

  /**
   * Check all installed bundles for updates. Uses the cache if valid
   * unless bypassed, otherwise syncs GitHub release sources and queries
   * the registry, enriching results with auto-update preferences.
   * @param bypassCache - Skip the cache and force a fresh check.
   */
  public async checkForUpdates(bypassCache = false): Promise<UpdateCheckResult[]> {
    this.log('info', 'Checking for bundle updates');

    if (!bypassCache) {
      const cached = await this.opts.cache.get();
      if (cached) {
        this.log('debug', 'Returning cached update results');
        return cached;
      }
    }

    if (bypassCache || !this.opts.cache.isValid()) {
      await this.syncGitHubReleaseSources();
    }

    const updates = await this.opts.registry.checkUpdates();
    if (!isBundleUpdateArray(updates)) {
      this.log('error', 'RegistryManager.checkUpdates() returned invalid data structure');
      throw new Error('Invalid update data received from registry manager');
    }

    const enrichedResults = await this.enrichUpdateResults(updates);
    await this.opts.cache.set(enrichedResults);

    this.log('info', `Found ${enrichedResults.length} bundle updates`);
    return enrichedResults;
  }

  /**
   * Get cached update results without triggering a new check.
   */
  public async getCachedResults(): Promise<UpdateCheckResult[] | null> {
    return this.opts.cache.get();
  }
}
