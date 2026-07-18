/**
 * Bundle Scope Commands
 *
 * Provides commands for managing bundle installation scope:
 * - Move bundles between user and repository scopes
 * - Switch commit mode for repository-scoped bundles
 * - Context menu actions based on current scope/mode
 *
 * Requirements: 7.1-7.10
 */

import * as vscode from 'vscode';
import {
  LockfileManager,
} from '../services/lockfile-manager';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  RepositoryScopeService,
} from '../services/repository-scope-service';
import {
  ScopeConflictResolver,
} from '../services/scope-conflict-resolver';
import {
  InstallationScope,
  InstalledBundle,
  RepositoryCommitMode,
} from '../types/registry';
import {
  getInstalledBundleForScope,
} from '../utils/bundle-scope-utils';
import {
  ErrorHandler,
} from '../utils/error-handler';
import {
  Logger,
} from '../utils/logger';
import {
  getWorkspaceRoot,
  hasOpenWorkspace,
} from '../utils/scope-selection-ui';

/**
 * Bundle Scope Commands Handler
 *
 * Manages bundle scope transitions and commit mode switching.
 * Provides context menu actions based on bundle state.
 */
export class BundleScopeCommands {
  private readonly logger: Logger;

  constructor(
    private readonly registryManager: RegistryManager,
    private readonly scopeConflictResolver: ScopeConflictResolver,
    private readonly repositoryScopeService: RepositoryScopeService
  ) {
    this.logger = Logger.getInstance();
  }

  /**
   * Get installed bundle from the appropriate source based on scope.
   * Delegates to shared utility that handles lockfile vs storage lookup.
   * @param bundleId
   * @param scope
   */
  private async getBundleForScope(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined> {
    return getInstalledBundleForScope(this.registryManager.getStorage(), bundleId, scope);
  }

  /**
   * Move a bundle from user scope to repository scope.
   * @param bundleId - The bundle ID to move
   * @param commitMode - The commit mode for repository installation
   *
   * Requirements: 7.2, 7.3
   */
  public async moveToRepository(bundleId: string, commitMode: RepositoryCommitMode): Promise<void> {
    try {
      this.logger.debug(`[BundleScopeCommands] Moving bundle ${bundleId} to repository scope (${commitMode})`);

      // Check if workspace is open
      if (!hasOpenWorkspace()) {
        vscode.window.showErrorMessage('Cannot move to repository scope: No workspace is open.');
        return;
      }

      // Get storage and check if bundle is installed at user scope
      const storage = this.registryManager.getStorage();
      const userBundle = await storage.getInstalledBundle(bundleId, 'user');

      if (!userBundle) {
        vscode.window.showErrorMessage(`Bundle "${bundleId}" is not installed at user scope.`);
        return;
      }

      // Get bundle name for display
      let bundleName = bundleId;
      try {
        bundleName = await this.registryManager.getBundleName(bundleId);
      } catch {
        // Use bundleId if name not available
      }

      // Confirm with user
      const modeDescription = commitMode === 'commit'
        ? 'tracked in version control'
        : 'excluded from Git';

      const confirmation = await vscode.window.showWarningMessage(
        `Move "${bundleName}" to repository scope (${modeDescription})?`,
        { modal: true },
        'Move', 'Cancel'
      );

      if (confirmation !== 'Move') {
        return;
      }

      // Perform migration
      const result = await this.scopeConflictResolver.migrateBundle(
        bundleId,
        'user',
        'repository',
        async () => {
          await this.registryManager.uninstallBundle(bundleId, 'user');
        },
        async (_installedBundle: InstalledBundle, targetScope: InstallationScope) => {
          await this.registryManager.installBundle(bundleId, {
            scope: targetScope,
            version: userBundle.version,
            commitMode
          });
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(
          `✓ "${bundleName}" moved to repository scope (${commitMode}).`
        );
      } else {
        vscode.window.showErrorMessage(
          `Failed to move "${bundleName}": ${result.error}`
        );
      }
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'move bundle to repository',
        showUserMessage: true,
        userMessagePrefix: 'Move failed'
      });
    }
  }

  /**
   * Move a bundle from repository scope to user scope.
   * @param bundleId - The bundle ID to move
   *
   * Requirements: 7.4, 7.6
   */
  public async moveToUser(bundleId: string): Promise<void> {
    try {
      this.logger.debug(`[BundleScopeCommands] Moving bundle ${bundleId} to user scope`);

      // Get bundle from repository scope (uses lockfile)
      const repoBundle = await this.getBundleForScope(bundleId, 'repository');

      if (!repoBundle) {
        vscode.window.showErrorMessage(`Bundle "${bundleId}" is not installed at repository scope.`);
        return;
      }

      // Get bundle name for display
      let bundleName = bundleId;
      try {
        bundleName = await this.registryManager.getBundleName(bundleId);
      } catch {
        // Use bundleId if name not available
      }

      // Confirm with user
      const confirmation = await vscode.window.showWarningMessage(
        `Move "${bundleName}" to user scope? It will be available across all workspaces.`,
        { modal: true },
        'Move', 'Cancel'
      );

      if (confirmation !== 'Move') {
        return;
      }

      // Perform migration
      const result = await this.scopeConflictResolver.migrateBundle(
        bundleId,
        'repository',
        'user',
        async () => {
          await this.registryManager.uninstallBundle(bundleId, 'repository');
        },
        async (_installedBundle: InstalledBundle, targetScope: InstallationScope) => {
          await this.registryManager.installBundle(bundleId, {
            scope: targetScope,
            version: repoBundle.version
          });
        }
      );

      if (result.success) {
        vscode.window.showInformationMessage(
          `✓ "${bundleName}" moved to user scope.`
        );
      } else {
        vscode.window.showErrorMessage(
          `Failed to move "${bundleName}": ${result.error}`
        );
      }
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'move bundle to user',
        showUserMessage: true,
        userMessagePrefix: 'Move failed'
      });
    }
  }

  /**
   * Switch the commit mode for a repository-scoped bundle.
   * @param bundleId - The bundle ID to switch
   * @param newMode - The new commit mode
   *
   * Requirements: 7.5, 7.7, 7.8, 7.9
   */
  public async switchCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    try {
      this.logger.debug(`[BundleScopeCommands] Switching commit mode for ${bundleId} to ${newMode}`);

      // Get bundle from repository scope (uses lockfile)
      const repoBundle = await this.getBundleForScope(bundleId, 'repository');

      if (!repoBundle) {
        vscode.window.showErrorMessage(`Bundle "${bundleId}" is not installed at repository scope.`);
        return;
      }

      // Check if already in target mode
      const currentMode = repoBundle.commitMode ?? 'commit';
      if (currentMode === newMode) {
        vscode.window.showInformationMessage(`Bundle is already in ${newMode} mode.`);
        return;
      }

      // Get bundle name for display
      let bundleName = bundleId;
      try {
        bundleName = await this.registryManager.getBundleName(bundleId);
      } catch {
        // Use bundleId if name not available
      }

      // Confirm with user
      const modeDescription = newMode === 'commit'
        ? 'Files will be tracked in version control.'
        : 'Files will be excluded from Git via .git/info/exclude.';

      const confirmation = await vscode.window.showWarningMessage(
        `Switch "${bundleName}" to ${newMode} mode? ${modeDescription}`,
        { modal: true },
        'Switch', 'Cancel'
      );

      if (confirmation !== 'Switch') {
        return;
      }

      // Perform switch (updates git exclude entries)
      await this.repositoryScopeService.switchCommitMode(bundleId, newMode);

      // Update lockfile with new commit mode using atomic write
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        const lockfileManager = LockfileManager.getInstance(workspaceRoot);
        await lockfileManager.updateCommitMode(bundleId, newMode);
      }

      vscode.window.showInformationMessage(
        `✓ "${bundleName}" switched to ${newMode} mode.`
      );
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'switch commit mode',
        showUserMessage: true,
        userMessagePrefix: 'Switch failed'
      });
    }
  }
}
