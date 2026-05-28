/**
 * Bundle Update Commands
 * Handles bundle update operations including single updates, batch updates, and auto-update management
 */

import * as vscode from 'vscode';
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  BundleUpdate,
} from '../types/registry';
import {
  getBundleDisplayName,
} from '../utils/bundle-name-utils';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  ErrorHandler,
} from '../utils/error-handler';
import {
  Logger,
} from '../utils/logger';
import {
  toError,
} from '../utils/type-guards';

/**
 * Bundle Update Commands Handler
 * Focused on update-related operations
 */
export class BundleUpdateCommands {
  private readonly logger: Logger;
  private readonly bundleNotifications: BundleUpdateNotifications | null;

  constructor(
    private readonly registryManager: RegistryManager,
    bundleNotifications?: BundleUpdateNotifications
  ) {
    this.logger = Logger.getInstance();
    this.bundleNotifications = bundleNotifications ?? null;
  }

  // ===== Private Helper Methods =====

  /**
   * Get bundle display name, falling back to bundleId if details unavailable.
   * Delegates to shared utility for consistency across the codebase.
   * @param bundleId
   */
  private async getBundleDisplayName(bundleId: string): Promise<string> {
    return getBundleDisplayName(bundleId, this.registryManager);
  }

  /**
   * Standardized error handling wrapper for command operations.
   * Delegates to ErrorHandler.withErrorHandling with command-specific defaults.
   * @param operation
   * @param operationName
   * @param fallbackValue
   */
  private async withErrorHandling<T>(
    operation: () => Promise<T>,
    operationName: string,
    fallbackValue?: T
  ): Promise<T> {
    const result = await ErrorHandler.withErrorHandling(operation, {
      operation: operationName,
      showUserMessage: true,
      logLevel: 'error',
      fallbackValue
    });

    // For command handlers, errors are surfaced to the user via
    // ErrorHandler and should not be rethrown to avoid breaking
    // the command pipeline.
    return result as T;
  }

  /**
   * Check for available updates with progress indicator
   */
  private async checkForAvailableUpdates(): Promise<BundleUpdate[]> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Checking for updates...',
        cancellable: false
      },
      async () => {
        return await this.registryManager.checkUpdates();
      }
    );
  }

  /**
   * Confirm batch update with user
   * @param updateCount
   */
  private async confirmBatchUpdate(updateCount: number): Promise<boolean> {
    const confirmation = await vscode.window.showInformationMessage(
      `${updateCount} bundle update(s) available. Update all now?`,
      { modal: true },
      'Update All', 'Cancel'
    );
    return confirmation === 'Update All';
  }

  /**
   * Perform batch update with controlled concurrency and progress reporting
   * @param updates
   */
  private async performBatchUpdate(updates: BundleUpdate[]): Promise<{
    successful: string[];
    failed: { bundleId: string; error: string }[];
  }> {
    const successful: string[] = [];
    const failed: { bundleId: string; error: string }[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating bundles...',
        cancellable: false
      },
      async (progress) => {
        const totalUpdates = updates.length;
        let completed = 0;

        // Process in batches for controlled concurrency
        for (let i = 0; i < updates.length; i += CONCURRENCY_CONSTANTS.BATCH_SIZE) {
          const batch = updates.slice(i, i + CONCURRENCY_CONSTANTS.BATCH_SIZE);

          // Update progress
          progress.report({
            message: `Processing batch ${Math.floor(i / CONCURRENCY_CONSTANTS.BATCH_SIZE) + 1}...`,
            increment: 0
          });

          // Process batch in parallel
          const results = await this.processBatch(batch);

          // Collect results and update progress
          this.collectBatchResults(results, batch, successful, failed, progress, completed, totalUpdates);
          completed += batch.length;
        }
      }
    );

    return { successful, failed };
  }

  /**
   * Process a batch of updates in parallel
   * @param batch
   */
  private async processBatch(batch: BundleUpdate[]): Promise<PromiseSettledResult<{
    bundleId: string;
    bundleName: string;
    success: boolean;
    error?: string;
  }>[]> {
    return await Promise.allSettled(
      batch.map(async (update) => {
        try {
          // Get bundle name for better logging
          const bundleName = await this.getBundleDisplayName(update.bundleId);

          this.logger.info(`Updating ${bundleName} (${update.currentVersion} → ${update.latestVersion})`);

          // Perform update using RegistryManager
          await this.registryManager.updateBundle(update.bundleId, update.latestVersion);

          return { bundleId: update.bundleId, bundleName, success: true };
        } catch (error) {
          const errorObj = toError(error);
          this.logger.error(`Failed to update ${update.bundleId}`, errorObj);
          return {
            bundleId: update.bundleId,
            bundleName: update.bundleId,
            success: false,
            error: errorObj.message
          };
        }
      })
    );
  }

  /**
   * Collect batch results and update progress
   * @param results
   * @param batch
   * @param successful
   * @param failed
   * @param progress
   * @param completed
   * @param totalUpdates
   */
  private collectBatchResults(
    results: PromiseSettledResult<{
      bundleId: string;
      bundleName: string;
      success: boolean;
      error?: string;
    }>[],
    batch: BundleUpdate[],
    successful: string[],
    failed: { bundleId: string; error: string }[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    completed: number,
    totalUpdates: number
  ): void {
    results.forEach((result, index) => {
      const update = batch[index];
      const currentCompleted = completed + index + 1;

      if (result.status === 'fulfilled' && result.value.success) {
        successful.push(result.value.bundleName);
        progress.report({
          message: `✓ ${result.value.bundleName} (${currentCompleted}/${totalUpdates})`,
          increment: (100 / totalUpdates)
        });
      } else {
        const errorMsg = result.status === 'fulfilled'
          ? result.value.error
          : result.reason?.message || 'Unknown error';
        failed.push({
          bundleId: update.bundleId,
          error: errorMsg!
        });
        progress.report({
          message: `✗ ${update.bundleId} (${currentCompleted}/${totalUpdates})`,
          increment: (100 / totalUpdates)
        });
      }
    });
  }

  /**
   * Show batch update summary notification
   * @param successful
   * @param failed
   */
  private async showBatchUpdateSummary(
    successful: string[],
    failed: { bundleId: string; error: string }[]
  ): Promise<void> {
    // Use injected notification service if available
    if (this.bundleNotifications) {
      await this.bundleNotifications.showBatchUpdateSummary(successful, failed);
    } else {
      // Fallback to basic notification if service not initialized
      const parts: string[] = [];
      if (successful.length > 0) {
        parts.push(`✅ ${successful.length} updated`);
      }
      if (failed.length > 0) {
        parts.push(`❌ ${failed.length} failed`);
      }
      const message = `Batch update complete: ${parts.join(', ')}`;
      await vscode.window.showInformationMessage(message);
    }
  }

  /**
   * Check for updates on a single bundle and show update dialog
   * @param bundleId
   */
  public async checkSingleBundleUpdate(bundleId: string): Promise<void> {
    await this.withErrorHandling(async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checking for updates...',
          cancellable: false
        },
        async () => {
          // Check for updates for all bundles, then filter for the specific one
          const allUpdates = await this.registryManager.checkUpdates();
          const bundleUpdate = allUpdates.find((u) => u.bundleId === bundleId);

          const bundleName = await this.getBundleDisplayName(bundleId);

          if (!bundleUpdate) {
            vscode.window.showInformationMessage(`${bundleName} is up to date!`);
            return;
          }

          // Show update dialog with options
          const action = await vscode.window.showInformationMessage(
            `Update available for ${bundleName}`,
            {
              detail: `Current: ${bundleUpdate.currentVersion}\nLatest: ${bundleUpdate.latestVersion}`,
              modal: true
            },
            'Update Now',
            'View Details'
          );

          if (action === 'Update Now') {
            await this.updateBundle(bundleId);
          } else if (action === 'View Details') {
            await vscode.commands.executeCommand('promptRegistry.viewBundle', bundleId);
          }
          // If Cancel or no selection, do nothing
        }
      );
    }, 'check bundle update');
  }

  /**
   * Check for updates on all installed bundles
   */
  public async checkAllUpdates(): Promise<void> {
    await this.withErrorHandling(async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Checking for updates...',
          cancellable: false
        },
        async () => {
          const updates = await this.registryManager.checkUpdates();

          if (updates.length === 0) {
            vscode.window.showInformationMessage('All bundles are up to date!');
            return;
          }

          // Show available updates with bundle names
          const updateItems = await Promise.all(updates.map(async (u) => {
            const name = await this.getBundleDisplayName(u.bundleId);
            return {
              label: name,
              description: `${u.currentVersion} → ${u.latestVersion}`,
              detail: 'Update available',
              update: u,
              name
            };
          }));

          const selected = await vscode.window.showQuickPick(
            updateItems,
            {
              placeHolder: `${updates.length} update(s) available`,
              title: 'Bundle Updates',
              canPickMany: true,
              ignoreFocusOut: true
            }
          );

          if (!selected || selected.length === 0) {
            return;
          }

          // Update selected bundles
          for (const item of selected) {
            try {
              await this.updateBundle(item.update.bundleId);
            } catch (error) {
              const errorObj = toError(error);
              this.logger.warn(`Failed to update ${item.name}`, errorObj);
            }
          }

          vscode.window.showInformationMessage(
            `✓ Updated ${selected.length} bundle(s)`
          );
        }
      );
    }, 'check updates');
  }

  /**
   * Update a specific bundle
   * @param bundleId
   */
  public async updateBundle(bundleId: string): Promise<void> {
    await this.withErrorHandling(async () => {
      // Get bundle name for display (try to get details, but don't fail if not found)
      let bundleName = bundleId;
      try {
        const bundle = await this.registryManager.getBundleDetails(bundleId);
        bundleName = bundle.name;
      } catch {
        this.logger.debug(`Could not get bundle details for '${bundleId}', using ID as name`);
      }

      // Update with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating ${bundleName}...`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Downloading...' });
          await this.registryManager.updateBundle(bundleId);
          progress.report({ message: 'Complete', increment: 100 });
        }
      );

      vscode.window.showInformationMessage(
        `✓ ${bundleName} updated successfully!`
      );
    }, 'update bundle');
  }

  /**
   * Update all bundles with available updates
   */
  public async updateAllBundles(): Promise<void> {
    await this.withErrorHandling(async () => {
      this.logger.info('Starting batch update for all bundles');

      // Check for updates
      const updates = await this.checkForAvailableUpdates();
      if (updates.length === 0) {
        vscode.window.showInformationMessage('All bundles are up to date!');
        return;
      }

      // Confirm batch update
      if (!await this.confirmBatchUpdate(updates.length)) {
        return;
      }

      // Perform batch update with progress reporting
      const { successful, failed } = await this.performBatchUpdate(updates);

      // Display summary notification
      await this.showBatchUpdateSummary(successful, failed);

      this.logger.info(
        `Batch update completed: ${successful.length} successful, ${failed.length} failed`
      );
    }, 'batch update');
  }

  /**
   * Enable auto-update for a bundle
   * @param bundleId
   */
  public async enableAutoUpdate(bundleId?: string): Promise<void> {
    await this.withErrorHandling(async () => {
      if (!bundleId) {
        vscode.window.showErrorMessage('No bundle selected');
        return;
      }

      this.logger.info(`Enabling auto-update for bundle '${bundleId}'`);

      // Check current status
      const currentStatus = await this.registryManager.isAutoUpdateEnabled(bundleId);

      if (currentStatus) {
        vscode.window.showInformationMessage(`Auto-update is already enabled for ${bundleId}`);
        return;
      }

      // Enable auto-update using facade method
      await this.registryManager.enableAutoUpdate(bundleId);

      vscode.window.showInformationMessage(`✅ Auto-update enabled for ${bundleId}`);
    }, 'enable auto-update');
  }

  /**
   * Disable auto-update for a bundle
   * @param bundleId
   */
  public async disableAutoUpdate(bundleId?: string): Promise<void> {
    await this.withErrorHandling(async () => {
      if (!bundleId) {
        vscode.window.showErrorMessage('No bundle selected');
        return;
      }

      this.logger.info(`Disabling auto-update for bundle '${bundleId}'`);

      // Check current status
      const currentStatus = await this.registryManager.isAutoUpdateEnabled(bundleId);

      if (!currentStatus) {
        vscode.window.showInformationMessage(`Auto-update is already disabled for ${bundleId}`);
        return;
      }

      // Disable auto-update using facade method
      await this.registryManager.disableAutoUpdate(bundleId);

      vscode.window.showInformationMessage(`✅ Auto-update disabled for ${bundleId}`);
    }, 'disable auto-update');
  }
}
