/**
 * Auto-Update Service
 * Handles automatic bundle updates in the background
 * Uses existing RegistryManager.updateBundle() for actual update logic
 */

// RegistryManager import removed to avoid circular dependency
// Operations are injected via small interfaces typed with domain models
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  Bundle,
  InstalledBundle,
  RegistrySource,
} from '../types/registry';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import {
  toError,
} from '../utils/type-guards';
import {
  UpdateCheckResult,
} from './update-cache';

/**
 * Options for auto-update operations
 */
export interface AutoUpdateOptions {
  bundleId: string;
  targetVersion: string;
  showProgress: boolean;
}

/**
 * Bundle operations interface for dependency injection
 * Focused on bundle-specific operations
 */
export interface BundleOperations {
  updateBundle(bundleId: string, version?: string): Promise<void>;
  listInstalledBundles(): Promise<InstalledBundle[]>;
  getBundleDetails(bundleId: string): Promise<Bundle>;
}

/**
 * Source operations interface for dependency injection
 * Focused on source synchronization operations
 */
export interface SourceOperations {
  listSources(): Promise<RegistrySource[]>;
  syncSource(sourceId: string): Promise<void>;
}

/**
 * Auto-update service
 * Orchestrates automatic bundle updates with progress tracking and notifications
 * Uses dependency injection to avoid circular dependencies
 */
export class AutoUpdateService {
  private readonly activeUpdates: Set<string>;
  private readonly logger: Logger;

  constructor(
    private readonly bundleOps: BundleOperations,
    private readonly sourceOps: SourceOperations,
    private readonly bundleNotifications: BundleUpdateNotifications,
    private readonly storage: RegistryStorage
  ) {
    this.activeUpdates = new Set();
    this.logger = Logger.getInstance();
  }

  /**
   * Validate update options
   * @param options
   */
  private validateUpdateOptions(options: AutoUpdateOptions): void {
    if (!options.bundleId?.trim()) {
      throw new Error('Bundle ID is required and cannot be empty');
    }
    if (!options.targetVersion?.trim()) {
      throw new Error('Target version is required and cannot be empty');
    }
  }

  /**
   * Ensure update is not already in progress
   * @param bundleId
   */
  private ensureUpdateNotInProgress(bundleId: string): void {
    if (this.isUpdateInProgress(bundleId)) {
      this.logger.warn(`Update already in progress for bundle '${bundleId}'`);
      throw new Error(`Update already in progress for bundle '${bundleId}'`);
    }
  }

  /**
   * Capture current version before update for rollback
   * @param bundleId
   */
  private async captureCurrentVersion(bundleId: string): Promise<string | null> {
    const installedBefore = await this.bundleOps.listInstalledBundles();
    return installedBefore.find((b) => b.bundleId === bundleId)?.version ?? null;
  }

  /**
   * Perform update with source sync and verification
   * @param bundleId
   * @param targetVersion
   */
  private async performUpdateWithVerification(bundleId: string, targetVersion: string): Promise<void> {
    // CRITICAL: Sync source before updating (only for GitHub release sources)
    await this.syncSourceForBundle(bundleId);

    // Perform update using registry operations
    await this.bundleOps.updateBundle(bundleId, targetVersion);

    // CRITICAL: Verify update succeeded
    if (!await this.verifyUpdate(bundleId, targetVersion)) {
      throw new Error('Update verification failed');
    }
  }

  /**
   * Show success notification after update
   * @param bundleId
   * @param previousVersion
   * @param targetVersion
   */
  private async showSuccessNotification(bundleId: string, previousVersion: string | null, targetVersion: string): Promise<void> {
    await this.bundleNotifications.showAutoUpdateComplete(
      bundleId,
      previousVersion || 'unknown',
      targetVersion
    );
  }

  /**
   * Handle update failure with rollback attempt and appropriate notifications
   * @param bundleId
   * @param errorMsg
   * @param previousVersion
   */
  private async handleUpdateFailure(bundleId: string, errorMsg: string, previousVersion: string | null): Promise<void> {
    if (previousVersion) {
      try {
        await this.performRollback(bundleId, previousVersion);
        await this.bundleNotifications.showUpdateFailure(
          bundleId,
          `${errorMsg}. Rolled back to version ${previousVersion}.`
        );
      } catch (rollbackError) {
        // Rollback failed - mark as corrupted per Requirement 8.5
        const rollbackErrorObj = toError(rollbackError);
        this.logger.error(`Rollback failed for bundle '${bundleId}'`, rollbackErrorObj);
        await this.bundleNotifications.showUpdateFailure(
          bundleId,
          `${errorMsg}. Rollback failed. Please reinstall the bundle.`
        );
      }
    } else {
      // No previous version to rollback to
      await this.bundleNotifications.showUpdateFailure(bundleId, errorMsg);
    }
  }

  /**
   * Perform rollback to previous version with verification
   * @param bundleId
   * @param previousVersion
   */
  private async performRollback(bundleId: string, previousVersion: string): Promise<void> {
    this.logger.info(`Attempting rollback to version ${previousVersion}`);
    await this.bundleOps.updateBundle(bundleId, previousVersion);

    // Verify rollback succeeded
    if (!await this.verifyUpdate(bundleId, previousVersion)) {
      throw new Error('Rollback verification failed');
    }
  }

  /**
   * Verify that an update completed successfully
   * @param bundleId
   * @param expectedVersion
   */
  private async verifyUpdate(bundleId: string, expectedVersion: string): Promise<boolean> {
    const updatedBundles = await this.bundleOps.listInstalledBundles();
    const bundle = updatedBundles.find((b) => b.bundleId === bundleId);
    return bundle?.version === expectedVersion;
  }

  /**
   * Sync source for a bundle before updating (only for GitHub release sources)
   * Skips syncing for awesome-copilot, local-awesome-copilot, and local sources
   *
   * NOTE: Sync failures are logged but do not block updates. The update will proceed
   * with cached source data. If the cached data is stale, the update may fail later
   * with a more specific error (e.g., version not found, download failure).
   * @param bundleId
   * @private
   */
  private async syncSourceForBundle(bundleId: string): Promise<void> {
    try {
      // Get bundle details to find its source
      const bundle = await this.bundleOps.getBundleDetails(bundleId);

      // Get all sources to find the bundle's source
      const sources = await this.sourceOps.listSources();
      const source = sources.find((s) => s.id === bundle.sourceId);

      if (!source) {
        // Source not found is potentially critical - log as warning
        this.logger.warn(
          `Source not found for bundle '${bundleId}'. `
          + `Update will proceed with cached data, which may be stale.`
        );
        return;
      }

      // Only sync if source type is 'github'
      if (source.type === 'github') {
        this.logger.info(`Syncing GitHub release source '${source.id}' before updating bundle '${bundleId}'`);
        try {
          await this.sourceOps.syncSource(source.id);
          this.logger.debug(`Source sync completed for '${source.id}'`);
        } catch (syncError) {
          const errorObj = toError(syncError);
          // Make sync failures more visible - this could cause update to fail
          this.logger.warn(
            `Failed to sync GitHub source '${source.id}' for bundle '${bundleId}'. `
            + `Update will use cached data. Error: ${errorObj.message}`,
            errorObj
          );
        }
      } else {
        this.logger.debug(`Skipping sync for source type: ${source.type} (bundle: ${bundleId})`);
      }
    } catch (error) {
      // Outer catch for getBundleDetails or listSources failures
      const errorObj = toError(error);
      this.logger.warn(
        `Failed to prepare sync for bundle '${bundleId}', continuing with update. `
        + `Error: ${errorObj.message}`,
        errorObj
      );
    }
  }

  /**
   * Update a single bundle automatically with rollback on failure
   * Prevents concurrent updates and shows notifications on completion
   * @param options
   */
  public async autoUpdateBundle(options: AutoUpdateOptions): Promise<void> {
    this.validateUpdateOptions(options);

    const { bundleId, targetVersion } = options;

    this.ensureUpdateNotInProgress(bundleId);
    this.activeUpdates.add(bundleId);

    const previousVersion = await this.captureCurrentVersion(bundleId);

    try {
      this.logger.info(`Starting auto-update for bundle '${bundleId}' to version ${targetVersion}`);

      await this.performUpdateWithVerification(bundleId, targetVersion);
      await this.showSuccessNotification(bundleId, previousVersion, targetVersion);

      this.logger.info(`Auto-update completed successfully for bundle '${bundleId}'`);
    } catch (error) {
      const errorObj = toError(error);
      this.logger.error(`Auto-update failed for bundle '${bundleId}'`, errorObj);

      await this.handleUpdateFailure(bundleId, errorObj.message, previousVersion);
      throw errorObj;
    } finally {
      this.activeUpdates.delete(bundleId);
    }
  }

  /**
   * Update multiple bundles with controlled concurrency (batch size 3)
   * Processes bundles in parallel batches and reports summary
   * @param updates
   */
  public async autoUpdateBundles(updates: UpdateCheckResult[]): Promise<void> {
    // Input validation
    if (!Array.isArray(updates)) {
      throw new TypeError('Updates must be an array');
    }
    if (updates.length === 0) {
      this.logger.info('No updates to process');
      return;
    }

    this.logger.info(`Starting batch auto-update for ${updates.length} bundles`);

    const successful: string[] = [];
    const failed: { bundleId: string; error: string }[] = [];

    // Filter to only auto-update enabled bundles
    const toUpdate = updates.filter((u) => {
      if (!u.autoUpdateEnabled) {
        this.logger.debug(`Skipping bundle '${u.bundleId}' - auto-update not enabled`);
        return false;
      }
      return true;
    });

    // CRITICAL: Process in batches for controlled concurrency
    for (let i = 0; i < toUpdate.length; i += CONCURRENCY_CONSTANTS.BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + CONCURRENCY_CONSTANTS.BATCH_SIZE);

      this.logger.debug(`Processing batch ${Math.floor(i / CONCURRENCY_CONSTANTS.BATCH_SIZE) + 1} with ${batch.length} bundles`);

      const results = await Promise.allSettled(
        batch.map((update) =>
          this.autoUpdateBundle({
            bundleId: update.bundleId,
            targetVersion: update.latestVersion,
            showProgress: false
          })
        )
      );

      results.forEach((result, index) => {
        const update = batch[index];
        if (result.status === 'fulfilled') {
          successful.push(update.bundleId);
        } else {
          const errorObj = toError(result.reason);
          failed.push({
            bundleId: update.bundleId,
            error: errorObj.message
          });
        }
      });
    }

    // Show batch summary notification
    if (successful.length > 0 || failed.length > 0) {
      await this.bundleNotifications.showBatchUpdateSummary(successful, failed);
    }

    this.logger.info(
      `Batch auto-update completed: ${successful.length} successful, ${failed.length} failed`
    );
  }

  /**
   * Check if auto-update is enabled for a bundle
   * @param bundleId
   */
  public async isAutoUpdateEnabled(bundleId: string): Promise<boolean> {
    return await this.storage.getUpdatePreference(bundleId);
  }

  /**
   * Get auto-update preferences for all bundles as a simple lookup map
   *
   * This is used by UI layers (tree view, marketplace) to avoid
   * per-bundle storage I/O when rendering lists of bundles.
   */
  public async getAllAutoUpdatePreferences(): Promise<Record<string, boolean>> {
    const rawPrefs = await this.storage.getUpdatePreferences();
    const result: Record<string, boolean> = {};

    for (const [bundleId, pref] of Object.entries(rawPrefs)) {
      result[bundleId] = !!pref.autoUpdate;
    }

    return result;
  }

  /**
   * Enable or disable auto-update for a bundle
   *
   * ⚠️  WARNING: This method is a low-level storage update. To ensure UI components
   * stay in sync, use RegistryManager.enableAutoUpdate() or disableAutoUpdate() instead.
   * Direct calls bypass the event emission mechanism and may leave UI in inconsistent state.
   * @param bundleId The bundle ID
   * @param enabled Whether to enable auto-update
   */
  public async setAutoUpdate(bundleId: string, enabled: boolean): Promise<void> {
    this.logger.info(`Setting auto-update for bundle '${bundleId}' to ${enabled}`);
    await this.storage.setUpdatePreference(bundleId, enabled);
  }

  /**
   * Check if an update is currently in progress for a bundle
   * @param bundleId
   */
  public isUpdateInProgress(bundleId: string): boolean {
    return this.activeUpdates.has(bundleId);
  }
}
