/**
 * Bundle Management Commands
 * Orchestrates bundle operations through specialized command handlers
 */

import * as vscode from 'vscode';
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  LockfileManager,
} from '../services/lockfile-manager';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  Logger,
} from '../utils/logger';
import {
  getWorkspaceRoot,
} from '../utils/scope-selection-ui';
import {
  BundleBrowsingCommands,
} from './bundle-browsing-commands';
import {
  BundleInstallationCommands,
} from './bundle-installation-commands';
import {
  BundleUpdateCommands,
} from './bundle-update-commands';

/**
 * Bundle Commands Handler
 * Uses composition to delegate to specialized command handlers
 */
export class BundleCommands {
  private readonly installationCommands: BundleInstallationCommands;
  private readonly updateCommands: BundleUpdateCommands;
  private readonly browsingCommands: BundleBrowsingCommands;
  private readonly logger: Logger;

  constructor(registryManager: RegistryManager) {
    this.installationCommands = new BundleInstallationCommands(registryManager);

    const bundleNameResolver = async (bundleId: string) => await registryManager.getBundleName(bundleId);
    const bundleNotifications = new BundleUpdateNotifications(bundleNameResolver);
    this.updateCommands = new BundleUpdateCommands(registryManager, bundleNotifications);

    this.browsingCommands = new BundleBrowsingCommands(registryManager);
    this.logger = Logger.getInstance();
  }

  // ===== Installation Commands =====

  /**
   * Search and install a bundle
   */
  public async searchAndInstall(): Promise<void> {
    return await this.installationCommands.searchAndInstall();
  }

  /**
   * Install a specific bundle
   * @param bundleId
   */
  public async installBundle(bundleId?: string): Promise<void> {
    return await this.installationCommands.installBundle(bundleId);
  }

  /**
   * Uninstall a bundle
   * @param bundleId
   */
  public async uninstallBundle(bundleId?: string): Promise<void> {
    return await this.installationCommands.uninstallBundle(bundleId);
  }

  // ===== Update Commands =====

  /**
   * Update a bundle
   * @param bundleId
   */
  public async updateBundle(bundleId?: string): Promise<void> {
    if (!bundleId) {
      return await this.updateCommands.checkAllUpdates();
    }
    return await this.updateCommands.updateBundle(bundleId);
  }

  /**
   * Check for updates on a single bundle and show update dialog
   * @param bundleId
   */
  public async checkSingleBundleUpdate(bundleId: string): Promise<void> {
    return await this.updateCommands.checkSingleBundleUpdate(bundleId);
  }

  /**
   * Check for updates on all installed bundles
   */
  public async checkAllUpdates(): Promise<void> {
    return await this.updateCommands.checkAllUpdates();
  }

  /**
   * Update all bundles with available updates
   */
  public async updateAllBundles(): Promise<void> {
    return await this.updateCommands.updateAllBundles();
  }

  /**
   * Enable auto-update for a bundle
   * @param bundleId
   */
  public async enableAutoUpdate(bundleId?: string): Promise<void> {
    return await this.updateCommands.enableAutoUpdate(bundleId);
  }

  /**
   * Disable auto-update for a bundle
   * @param bundleId
   */
  public async disableAutoUpdate(bundleId?: string): Promise<void> {
    return await this.updateCommands.disableAutoUpdate(bundleId);
  }

  // ===== Browsing Commands =====

  /**
   * View bundle details
   * @param bundleId
   */
  public async viewBundle(bundleId?: string): Promise<void> {
    return await this.browsingCommands.viewBundle(bundleId);
  }

  /**
   * Browse bundles by category
   */
  public async browseByCategory(): Promise<void> {
    return await this.browsingCommands.browseByCategory();
  }

  /**
   * Show popular bundles
   */
  public async showPopular(): Promise<void> {
    return await this.browsingCommands.showPopular();
  }

  /**
   * List installed bundles
   */
  public async listInstalled(): Promise<void> {
    return await this.browsingCommands.listInstalled();
  }

  // ===== Cleanup Commands =====

  /**
   * Clean up stale lockfile entries where files no longer exist.
   * Gets bundles with filesMissing flag, shows confirmation dialog,
   * removes stale entries from lockfile, and shows success/info message.
   *
   * Requirements covered:
   * - 3.4: Provide command to clean up stale lockfile entries
   */
  public async cleanupStaleLockfileEntries(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();

    if (!workspaceRoot) {
      vscode.window.showWarningMessage('No workspace open. Please open a workspace to clean up stale repository bundles.');
      return;
    }

    try {
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      const bundles = await lockfileManager.getInstalledBundles();
      const staleBundles = bundles.filter((b) => b.filesMissing);

      if (staleBundles.length === 0) {
        vscode.window.showInformationMessage('No stale repository bundle entries found.');
        return;
      }

      // Show confirmation dialog with count
      const bundleList = staleBundles.map((b) => `• ${b.bundleId}`).join('\n');
      const confirm = await vscode.window.showWarningMessage(
        `Found ${staleBundles.length} stale bundle(s) with missing files:\n\n${bundleList}\n\nRemove these entries from the lockfile?`,
        { modal: true },
        'Remove', 'Cancel'
      );

      if (confirm !== 'Remove') {
        return;
      }

      // Remove stale entries from lockfile
      let removedCount = 0;
      for (const bundle of staleBundles) {
        try {
          await lockfileManager.remove(bundle.bundleId);
          removedCount++;
          this.logger.info(`Removed stale lockfile entry: ${bundle.bundleId}`);
        } catch (error) {
          this.logger.error(`Failed to remove stale entry ${bundle.bundleId}:`, error instanceof Error ? error : undefined);
        }
      }

      // Show success message
      if (removedCount === staleBundles.length) {
        vscode.window.showInformationMessage(`Successfully removed ${removedCount} stale bundle entries from the lockfile.`);
      } else {
        vscode.window.showWarningMessage(`Removed ${removedCount} of ${staleBundles.length} stale entries. Some entries could not be removed.`);
      }
    } catch (error) {
      this.logger.error('Failed to clean up stale lockfile entries:', error instanceof Error ? error : undefined);
      vscode.window.showErrorMessage(`Failed to clean up stale entries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
