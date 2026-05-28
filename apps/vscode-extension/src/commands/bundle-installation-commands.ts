/**
 * Bundle Installation Commands
 * Handles bundle installation and uninstallation operations
 */

import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  InstallOptions,
} from '../types/registry';
import {
  ErrorHandler,
} from '../utils/error-handler';
import {
  Logger,
} from '../utils/logger';
import {
  showScopeSelectionDialog,
} from '../utils/scope-selection-ui';

/**
 * Bundle Installation Commands Handler
 * Focused on installation-related operations
 */
export class BundleInstallationCommands {
  private readonly logger: Logger;

  constructor(private readonly registryManager: RegistryManager) {
    this.logger = Logger.getInstance();
  }

  /**
   * Install a specific bundle
   * @param bundleId
   */
  public async installBundle(bundleId?: string): Promise<void> {
    try {
      // If no bundleId, let user search
      if (!bundleId) {
        await this.searchAndInstall();
        return;
      }

      // Get bundle details
      const bundle = await this.registryManager.getBundleDetails(bundleId);

      // Ask for installation scope using the new combined dialog
      const scopeSelection = await showScopeSelectionDialog(bundle.name);

      if (!scopeSelection) {
        return;
      }

      // Ask for auto-update preference
      const autoUpdateChoice = await vscode.window.showQuickPick(
        [
          {
            label: '$(sync) Enable auto-update',
            description: 'Automatically install updates when available',
            detail: 'Recommended for staying up-to-date with the latest features and fixes',
            value: true
          },
          {
            label: '$(circle-slash) Manual updates only',
            description: 'You will be notified but updates must be installed manually',
            detail: 'Choose this if you prefer to review changes before updating',
            value: false
          }
        ],
        {
          placeHolder: 'Enable auto-update for this bundle?',
          title: `Install ${bundle.name} - Auto-Update Preference`,
          ignoreFocusOut: true
        }
      );

      if (autoUpdateChoice === undefined) {
        return;
      }

      const options: InstallOptions = {
        scope: scopeSelection.scope,
        version: 'latest',
        commitMode: scopeSelection.commitMode
      };

      // Install with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing ${bundle.name}...`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Downloading...' });
          await this.registryManager.installBundle(bundleId, options);
          progress.report({ message: 'Complete', increment: 100 });
        }
      );

      // Store auto-update preference after successful installation
      const storage = this.registryManager.getStorage();
      await storage.setUpdatePreference(bundleId, autoUpdateChoice.value);

      this.logger.info(
        `Auto-update preference for '${bundleId}' set to: ${autoUpdateChoice.value}`
      );

      vscode.window.showInformationMessage(
        `✓ ${bundle.name} installed successfully!`,
        'View Bundle', 'Install More'
      ).then((action) => {
        if (action === 'View Bundle') {
          vscode.commands.executeCommand('promptRegistry.viewBundle', bundleId);
        } else if (action === 'Install More') {
          void this.searchAndInstall();
        }
      });
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'install bundle',
        showUserMessage: true,
        userMessagePrefix: 'Installation failed'
      });
    }
  }

  /**
   * Search and install a bundle
   */
  public async searchAndInstall(): Promise<void> {
    try {
      // Search for bundles
      const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search for bundles',
        placeHolder: 'e.g., python developer',
        ignoreFocusOut: true
      });

      if (!searchQuery) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Searching bundles...',
          cancellable: false
        },
        async () => {
          const bundles = await this.registryManager.searchBundles({
            text: searchQuery
          });

          if (bundles.length === 0) {
            vscode.window.showInformationMessage(
              `No bundles found for "${searchQuery}"`
            );
            return;
          }

          // Show results
          const selected = await vscode.window.showQuickPick(
            bundles.map((b) => ({
              label: b.name,
              description: `v${b.version} • ${b.author}`,
              detail: b.description,
              bundle: b
            })),
            {
              placeHolder: `Found ${bundles.length} bundle(s)`,
              title: 'Select Bundle to Install',
              ignoreFocusOut: true
            }
          );

          if (selected) {
            await this.installBundle(selected.bundle.id);
          }
        }
      );
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'search bundles',
        showUserMessage: true,
        userMessagePrefix: 'Search failed'
      });
    }
  }

  /**
   * Uninstall a bundle
   * @param bundleId
   */
  public async uninstallBundle(bundleId?: string): Promise<void> {
    try {
      // If no bundleId, let user select
      if (!bundleId) {
        const installed = await this.registryManager.listInstalledBundles();

        if (installed.length === 0) {
          vscode.window.showInformationMessage('No bundles installed.');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          await Promise.all(installed.map(async (ib) => {
            try {
              const bundle = await this.registryManager.getBundleDetails(ib.bundleId);
              return {
                label: bundle.name,
                description: `v${ib.version} • ${ib.scope}`,
                detail: bundle.description,
                bundleId: ib.bundleId
              };
            } catch {
              return {
                label: ib.bundleId,
                description: `v${ib.version} • ${ib.scope}`,
                detail: 'Bundle details not available',
                bundleId: ib.bundleId
              };
            }
          })),
          {
            placeHolder: 'Select bundle to uninstall',
            title: 'Uninstall Bundle',
            ignoreFocusOut: true
          }
        );

        if (!selected) {
          return;
        }

        bundleId = selected.bundleId;
      }

      // Get bundle name for confirmation
      let bundleName = bundleId;
      try {
        const bundle = await this.registryManager.getBundleDetails(bundleId);
        bundleName = bundle.name;
      } catch {
        // Use bundleId if details not available
      }

      // Confirm uninstallation
      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to uninstall "${bundleName}"?`,
        { modal: true },
        'Uninstall', 'Cancel'
      );

      if (confirmation !== 'Uninstall') {
        return;
      }

      // Uninstall with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uninstalling ${bundleName}...`,
          cancellable: false
        },
        async () => {
          await this.registryManager.uninstallBundle(bundleId!);
        }
      );

      vscode.window.showInformationMessage(
        `✓ ${bundleName} uninstalled successfully`
      );
    } catch (error) {
      await ErrorHandler.handle(error, {
        operation: 'uninstall bundle',
        showUserMessage: true,
        userMessagePrefix: 'Uninstall failed'
      });
    }
  }
}
