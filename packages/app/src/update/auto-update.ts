/**
 * AutoUpdateCore — portable orchestration ported from the extension's
 * `src/services/auto-update-service.ts`. Performs a single bundle
 * update with pre-sync, post-update verification, and automatic
 * rollback on failure, plus controlled-concurrency batch updates.
 *
 * Depends only on `core` ports (`BundleOperations`, `SourceOperations`,
 * `UpdatePreferenceStore`, `UpdateNotifier`) — the extension's thin
 * `AutoUpdateService` wrapper adapts its `RegistryManager`/
 * `RegistryStorage`/`BundleUpdateNotifications` instances to these,
 * with no behavior change (all four already satisfy the port shapes).
 * @module update/auto-update
 */
import type {
  BundleOperations,
  SourceOperations,
  UpdateCheckResult,
  UpdateNotifier,
  UpdatePreferenceStore,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from './log-event';

/** Batch size for concurrent auto-updates — see the extension's `CONCURRENCY_CONSTANTS.BATCH_SIZE` doc for the empirical rationale (GitHub API rate limits, UI responsiveness). */
const BATCH_SIZE = 3;

export interface AutoUpdateOptions {
  bundleId: string;
  targetVersion: string;
  showProgress: boolean;
}

export interface AutoUpdateCoreOptions {
  bundleOps: BundleOperations;
  sourceOps: SourceOperations;
  notifier: UpdateNotifier;
  preferences: UpdatePreferenceStore;
  onLog?: OnLogEvent;
}

/**
 * Orchestrates automatic bundle updates with rollback-on-failure and
 * controlled-concurrency batch processing.
 */
export class AutoUpdateCore {
  private readonly activeUpdates = new Set<string>();

  public constructor(private readonly opts: AutoUpdateCoreOptions) {}

  private log(level: LogEvent['level'], message: string, error?: Error): void {
    this.opts.onLog?.({ level, message, error });
  }

  private validateUpdateOptions(options: AutoUpdateOptions): void {
    if (!options.bundleId?.trim()) {
      throw new Error('Bundle ID is required and cannot be empty');
    }
    if (!options.targetVersion?.trim()) {
      throw new Error('Target version is required and cannot be empty');
    }
  }

  private ensureUpdateNotInProgress(bundleId: string): void {
    if (this.isUpdateInProgress(bundleId)) {
      this.log('warn', `Update already in progress for bundle '${bundleId}'`);
      throw new Error(`Update already in progress for bundle '${bundleId}'`);
    }
  }

  private async captureCurrentVersion(bundleId: string): Promise<string | null> {
    const installedBefore = await this.opts.bundleOps.listInstalledBundles();
    return installedBefore.find((b) => b.bundleId === bundleId)?.version ?? null;
  }

  private async performUpdateWithVerification(bundleId: string, targetVersion: string): Promise<void> {
    await this.syncSourceForBundle(bundleId);
    await this.opts.bundleOps.updateBundle(bundleId, targetVersion);

    if (!await this.verifyUpdate(bundleId, targetVersion)) {
      throw new Error('Update verification failed');
    }
  }

  private async handleUpdateFailure(bundleId: string, errorMsg: string, previousVersion: string | null): Promise<void> {
    if (previousVersion) {
      try {
        await this.performRollback(bundleId, previousVersion);
        await this.opts.notifier.showUpdateFailure(bundleId, `${errorMsg}. Rolled back to version ${previousVersion}.`);
      } catch (rollbackError) {
        const rollbackErrorObj = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        this.log('error', `Rollback failed for bundle '${bundleId}'`, rollbackErrorObj);
        await this.opts.notifier.showUpdateFailure(bundleId, `${errorMsg}. Rollback failed. Please reinstall the bundle.`);
      }
    } else {
      await this.opts.notifier.showUpdateFailure(bundleId, errorMsg);
    }
  }

  private async performRollback(bundleId: string, previousVersion: string): Promise<void> {
    this.log('info', `Attempting rollback to version ${previousVersion}`);
    await this.opts.bundleOps.updateBundle(bundleId, previousVersion);

    if (!await this.verifyUpdate(bundleId, previousVersion)) {
      throw new Error('Rollback verification failed');
    }
  }

  private async verifyUpdate(bundleId: string, expectedVersion: string): Promise<boolean> {
    const updatedBundles = await this.opts.bundleOps.listInstalledBundles();
    const bundle = updatedBundles.find((b) => b.bundleId === bundleId);
    return bundle?.version === expectedVersion;
  }

  /**
   * Sync source for a bundle before updating (only for GitHub release
   * sources; sync failures are logged but never block the update).
   * @param bundleId
   */
  private async syncSourceForBundle(bundleId: string): Promise<void> {
    try {
      const bundle = await this.opts.bundleOps.getBundleDetails(bundleId);
      const sources = await this.opts.sourceOps.listSources();
      const source = sources.find((s) => s.id === bundle.sourceId);

      if (!source) {
        this.log('warn', `Source not found for bundle '${bundleId}'. Update will proceed with cached data, which may be stale.`);
        return;
      }

      if (source.type === 'github') {
        this.log('info', `Syncing GitHub release source '${source.id}' before updating bundle '${bundleId}'`);
        try {
          await this.opts.sourceOps.syncSource(source.id);
          this.log('debug', `Source sync completed for '${source.id}'`);
        } catch (syncError) {
          const errorObj = syncError instanceof Error ? syncError : new Error(String(syncError));
          this.log('warn', `Failed to sync GitHub source '${source.id}' for bundle '${bundleId}'. Update will use cached data. Error: ${errorObj.message}`, errorObj);
        }
      } else {
        this.log('debug', `Skipping sync for source type: ${source.type} (bundle: ${bundleId})`);
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.log('warn', `Failed to prepare sync for bundle '${bundleId}', continuing with update. Error: ${errorObj.message}`, errorObj);
    }
  }

  /**
   * Update a single bundle automatically with rollback on failure.
   * Prevents concurrent updates for the same bundle and reports the
   * outcome through the notifier.
   * @param options - Bundle id, target version, and progress-display hint.
   */
  public async autoUpdateBundle(options: AutoUpdateOptions): Promise<void> {
    this.validateUpdateOptions(options);

    const { bundleId, targetVersion } = options;

    this.ensureUpdateNotInProgress(bundleId);
    this.activeUpdates.add(bundleId);

    const previousVersion = await this.captureCurrentVersion(bundleId);

    try {
      this.log('info', `Starting auto-update for bundle '${bundleId}' to version ${targetVersion}`);

      await this.performUpdateWithVerification(bundleId, targetVersion);
      await this.opts.notifier.showAutoUpdateComplete(bundleId, previousVersion ?? 'unknown', targetVersion);

      this.log('info', `Auto-update completed successfully for bundle '${bundleId}'`);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.log('error', `Auto-update failed for bundle '${bundleId}'`, errorObj);

      await this.handleUpdateFailure(bundleId, errorObj.message, previousVersion);
      throw errorObj;
    } finally {
      this.activeUpdates.delete(bundleId);
    }
  }

  /**
   * Update multiple bundles with controlled concurrency, processing in
   * fixed-size batches and reporting a summary at the end.
   * @param updates - Enriched update-check results to act on.
   */
  public async autoUpdateBundles(updates: UpdateCheckResult[]): Promise<void> {
    if (!Array.isArray(updates)) {
      throw new TypeError('Updates must be an array');
    }
    if (updates.length === 0) {
      this.log('info', 'No updates to process');
      return;
    }

    this.log('info', `Starting batch auto-update for ${updates.length} bundles`);

    const successful: string[] = [];
    const failed: { bundleId: string; error: string }[] = [];

    const toUpdate = updates.filter((u) => {
      if (!u.autoUpdateEnabled) {
        this.log('debug', `Skipping bundle '${u.bundleId}' - auto-update not enabled`);
        return false;
      }
      return true;
    });

    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);

      this.log('debug', `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batch.length} bundles`);

      const results = await Promise.allSettled(
        batch.map((update) =>
          this.autoUpdateBundle({
            bundleId: update.bundleId,
            targetVersion: update.latestVersion,
            showProgress: false
          }))
      );

      results.forEach((result, index) => {
        const update = batch[index];
        if (result.status === 'fulfilled') {
          successful.push(update.bundleId);
        } else {
          const errorObj = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          failed.push({ bundleId: update.bundleId, error: errorObj.message });
        }
      });
    }

    if (successful.length > 0 || failed.length > 0) {
      await this.opts.notifier.showBatchUpdateSummary(successful, failed);
    }

    this.log('info', `Batch auto-update completed: ${successful.length} successful, ${failed.length} failed`);
  }

  /**
   * Check if auto-update is enabled for a bundle.
   * @param bundleId
   */
  public async isAutoUpdateEnabled(bundleId: string): Promise<boolean> {
    return this.opts.preferences.getUpdatePreference(bundleId);
  }

  /**
   * Get auto-update preferences for all bundles as a simple lookup map.
   */
  public async getAllAutoUpdatePreferences(): Promise<Record<string, boolean>> {
    const rawPrefs = await this.opts.preferences.getUpdatePreferences();
    const result: Record<string, boolean> = {};

    for (const [bundleId, pref] of Object.entries(rawPrefs)) {
      result[bundleId] = !!pref.autoUpdate;
    }

    return result;
  }

  /**
   * Enable or disable auto-update for a bundle.
   * @param bundleId
   * @param enabled
   */
  public async setAutoUpdate(bundleId: string, enabled: boolean): Promise<void> {
    this.log('info', `Setting auto-update for bundle '${bundleId}' to ${enabled}`);
    await this.opts.preferences.setUpdatePreference(bundleId, enabled);
  }

  /**
   * Check if an update is currently in progress for a bundle.
   * @param bundleId
   */
  public isUpdateInProgress(bundleId: string): boolean {
    return this.activeUpdates.has(bundleId);
  }
}
