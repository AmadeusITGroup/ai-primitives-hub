import * as vscode from 'vscode';
import {
  UpdateCheckResult,
} from '../services/update-cache';
import {
  BaseNotificationService,
} from './base-notification-service';

export interface BundleUpdateNotificationOptions {
  updates: UpdateCheckResult[];
  notificationPreference: 'all' | 'critical' | 'none';
}

/**
 * Specialized notification handler for bundle updates
 * Extends BaseNotificationService for consistent notification patterns
 */
export class BundleUpdateNotifications extends BaseNotificationService {
  private readonly bundleNameResolver?: (bundleId: string) => Promise<string>;

  constructor(bundleNameResolver?: (bundleId: string) => Promise<string>) {
    super();
    this.bundleNameResolver = bundleNameResolver;
  }

  /**
   * Filter updates based on notification preference
   * @param updates
   * @param preference
   */
  private filterUpdatesByPreference(updates: UpdateCheckResult[], preference: string): UpdateCheckResult[] {
    if (preference === 'critical') {
      return updates.filter((update) => this.isCriticalUpdate(update));
    }
    return updates;
  }

  /**
   * Build message for update notification
   * Handles both single and multiple updates
   * @param updates
   */
  private async buildUpdateMessage(updates: UpdateCheckResult[]): Promise<string> {
    if (updates.length === 1) {
      const update = updates[0];
      const bundleName = await this.getBundleDisplayName(update.bundleId);
      return `Update available for ${bundleName}: v${update.currentVersion} → v${update.latestVersion}`;
    }

    // Multiple updates - list them all
    const updateList = await Promise.all(
      updates.map(async (u) => {
        const bundleName = await this.getBundleDisplayName(u.bundleId);
        return `• ${bundleName}: v${u.currentVersion} → v${u.latestVersion}`;
      })
    );

    return `${updates.length} bundle updates available:\n${updateList.join('\n')}`;
  }

  private shouldSkipNotification(updates: UpdateCheckResult[], preference: string): boolean {
    if (preference === 'none') {
      return true;
    }

    if (preference === 'critical') {
      // Filter to only critical updates (major version changes or security updates)
      const criticalUpdates = updates.filter((update) => this.isCriticalUpdate(update));
      if (criticalUpdates.length === 0) {
        this.logger.debug('No critical updates found, skipping notification');
        return true;
      }
      // Continue with critical updates only
      return false;
    }

    return false;
  }

  /**
   * Determine if an update is critical based on version change
   * Critical updates are major version changes (e.g., 1.x.x -> 2.x.x)
   * @param update
   */
  private isCriticalUpdate(update: UpdateCheckResult): boolean {
    try {
      const currentParts = update.currentVersion.split('.').map(Number);
      const latestParts = update.latestVersion.split('.').map(Number);

      // Major version change is considered critical
      return latestParts[0] > currentParts[0];
    } catch {
      // If version parsing fails, treat as critical to be safe
      this.logger.warn(`Failed to parse versions for ${update.bundleId}, treating as critical`);
      return true;
    }
  }

  private async handleNotificationAction(
    action: string | undefined,
    updates: UpdateCheckResult[]
  ): Promise<void> {
    switch (action) {
      case 'Update Now': {
        // Trigger update command
        await (updates.length === 1 ? vscode.commands.executeCommand('promptRegistry.updateBundle', updates[0].bundleId) : vscode.commands.executeCommand('promptRegistry.updateAllBundles'));
        break;
      }
      case 'View Changes': {
        // Open release notes for first update
        if (updates.length > 0 && updates[0].releaseNotes) {
          await vscode.env.openExternal(vscode.Uri.parse(updates[0].releaseNotes));
        } else {
          this.logger.warn('No release notes available for viewing');
        }
        break;
      }
    }
  }

  /**
   * Implementation of abstract method from BaseNotificationService
   * @param bundleId
   */
  protected async resolveBundleName(bundleId: string): Promise<string> {
    if (this.bundleNameResolver) {
      try {
        return await this.bundleNameResolver(bundleId);
      } catch {
        this.logger.debug(`Could not resolve bundle name for '${bundleId}', using ID`);
        return bundleId;
      }
    }
    return bundleId;
  }

  /**
   * Show notification for available bundle updates
   * Groups multiple updates into a single notification
   * @param options
   */
  public async showUpdateNotification(options: BundleUpdateNotificationOptions): Promise<void> {
    if (this.shouldSkipNotification(options.updates, options.notificationPreference)) {
      return;
    }

    // Filter updates based on preference
    const updatesToShow = this.filterUpdatesByPreference(options.updates, options.notificationPreference);

    const message = await this.buildUpdateMessage(updatesToShow);
    const action = await this.showSuccessWithActions(
      message,
      ['Update Now', 'View Changes', 'Dismiss']
    );

    await this.handleNotificationAction(action, updatesToShow);
  }

  /**
   * Show notification after auto-update completes
   * For single bundle update
   * @param bundleId
   * @param oldVersion
   * @param newVersion
   */
  public async showAutoUpdateComplete(
    bundleId: string,
    oldVersion: string,
    newVersion: string
  ): Promise<void> {
    const bundleName = await this.getBundleDisplayName(bundleId);
    const message = `✅ ${bundleName} auto-updated: ${oldVersion} → ${newVersion}`;
    await this.showSuccessWithActions(message, ['View Bundle', 'Settings']);
  }

  /**
   * Show notification for bundle update failure
   * @param bundleId
   * @param error
   */
  public async showUpdateFailure(
    bundleId: string,
    error: string
  ): Promise<void> {
    const bundleName = await this.getBundleDisplayName(bundleId);
    const message = `Failed to update ${bundleName}: ${error}`;
    const action = await this.showErrorWithActions(
      message,
      ['Retry', 'Show Logs', 'Dismiss']
    );

    if (action === 'Show Logs') {
      this.logger.show();
    }
  }

  /**
   * Show batch update summary
   * Groups all successful and failed updates into a single notification
   * @param successful
   * @param failed
   */
  public async showBatchUpdateSummary(
    successful: string[],
    failed: { bundleId: string; error: string }[]
  ): Promise<void> {
    const parts: string[] = [];

    if (successful.length > 0) {
      const successfulNames = await Promise.all(
        successful.map((id) => this.getBundleDisplayName(id))
      );
      parts.push(`✅ ${successful.length} updated: ${successfulNames.join(', ')}`);
    }

    if (failed.length > 0) {
      const failedNames = await Promise.all(
        failed.map((f) => this.getBundleDisplayName(f.bundleId))
      );
      parts.push(`❌ ${failed.length} failed: ${failedNames.join(', ')}`);
    }

    const message = `Batch update complete\n${parts.join('\n')}`;

    const action = failed.length > 0
      ? await this.showWarningWithActions(message, ['Show Details', 'Dismiss'])
      : await this.showSuccessWithActions(message, ['Dismiss']);

    if (action === 'Show Details' && failed.length > 0) {
      // Show detailed error information
      const details = await Promise.all(
        failed.map(async (f) => {
          const bundleName = await this.getBundleDisplayName(f.bundleId);
          return `${bundleName}: ${f.error}`;
        })
      );
      await this.showErrorWithActions(
        `Update failures:\n${details.join('\n')}`,
        ['Show Logs', 'Dismiss']
      );
    }
  }
}
