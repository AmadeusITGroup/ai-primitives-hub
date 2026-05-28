/**
 * HubHistoryCommands - Commands for viewing and managing sync history
 * Provides VS Code commands for history viewing and rollback operations
 */

import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  HubSyncHistory,
} from './hub-sync-history';

/**
 * Commands for hub sync history management
 */
export class HubHistoryCommands {
  private readonly syncHistory: HubSyncHistory;

  constructor(
    private readonly hubManager: HubManager,
    private readonly context: vscode.ExtensionContext
  ) {
    this.syncHistory = new HubSyncHistory(hubManager);
    this.registerCommands(context);
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.viewSyncHistory', () => this.viewSyncHistory()),
      vscode.commands.registerCommand('promptregistry.rollbackProfile', () => this.rollbackProfile()),
      vscode.commands.registerCommand('promptregistry.clearSyncHistory', () => this.clearSyncHistory())
    );
  }

  /**
   * View sync history for a profile
   */
  public async viewSyncHistory(): Promise<void> {
    try {
      // Get active profiles
      const activeProfiles = await this.hubManager.listAllActiveProfiles();

      if (activeProfiles.length === 0) {
        vscode.window.showInformationMessage('No active profiles found. Activate a profile first.');
        return;
      }

      // Let user select a profile
      const profileItems = activeProfiles.map((profile) => ({
        label: profile.profileId,
        description: `Hub: ${profile.hubId}`,
        profile
      }));

      const selectedProfile = await vscode.window.showQuickPick(profileItems, {
        placeHolder: 'Select a profile to view sync history',
        title: 'View Sync History',
        ignoreFocusOut: true
      });

      if (!selectedProfile) {
        return;
      }

      // Get history
      const history = await this.syncHistory.getHistory(
        selectedProfile.profile.hubId,
        selectedProfile.profile.profileId,
        20 // Show last 20 entries
      );

      if (history.length === 0) {
        vscode.window.showInformationMessage(
          `No sync history found for profile ${selectedProfile.profile.profileId}`
        );
        return;
      }

      // Create QuickPick items
      const historyItems = this.syncHistory.createHistoryQuickPickItems(history);

      // Show history
      const selectedEntry = await vscode.window.showQuickPick(historyItems, {
        placeHolder: 'Select a history entry to view details',
        title: `Sync History: ${selectedProfile.profile.profileId}`,
        ignoreFocusOut: true
      });

      if (selectedEntry) {
        // Show detailed view
        const formatted = this.syncHistory.formatHistoryEntry(selectedEntry.entry);

        const document = await vscode.workspace.openTextDocument({
          content: formatted,
          language: 'plaintext'
        });

        await vscode.window.showTextDocument(document, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to view sync history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Rollback a profile to a previous state
   */
  public async rollbackProfile(): Promise<void> {
    try {
      // Get active profiles
      const activeProfiles = await this.hubManager.listAllActiveProfiles();

      if (activeProfiles.length === 0) {
        vscode.window.showInformationMessage('No active profiles found. Activate a profile first.');
        return;
      }

      // Let user select a profile
      const profileItems = activeProfiles.map((profile) => ({
        label: profile.profileId,
        description: `Hub: ${profile.hubId}`,
        profile
      }));

      const selectedProfile = await vscode.window.showQuickPick(profileItems, {
        placeHolder: 'Select a profile to rollback',
        title: 'Rollback Profile',
        ignoreFocusOut: true
      });

      if (!selectedProfile) {
        return;
      }

      // Get history
      const history = await this.syncHistory.getHistory(
        selectedProfile.profile.hubId,
        selectedProfile.profile.profileId,
        10 // Show last 10 entries for rollback
      );

      if (history.length === 0) {
        vscode.window.showInformationMessage(
          `No sync history found for profile ${selectedProfile.profile.profileId}. Cannot rollback.`
        );
        return;
      }

      // Create QuickPick items
      const historyItems = this.syncHistory.createHistoryQuickPickItems(history);

      // Show history
      const selectedEntry = await vscode.window.showQuickPick(historyItems, {
        placeHolder: 'Select a history entry to rollback to',
        title: `Rollback: ${selectedProfile.profile.profileId}`,
        ignoreFocusOut: true
      });

      if (!selectedEntry) {
        return;
      }

      // Confirm rollback
      const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to rollback profile "${selectedProfile.profile.profileId}" to this state?`,
        { modal: true },
        'Yes',
        'No'
      );

      if (confirmation !== 'Yes') {
        return;
      }

      // Perform rollback
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Rolling back profile ${selectedProfile.profile.profileId}...`,
          cancellable: false
        },
        async () => {
          await this.syncHistory.rollbackToEntry(
            selectedProfile.profile.hubId,
            selectedProfile.profile.profileId,
            selectedEntry.entry,
            { installBundles: true }
          );
        }
      );

      vscode.window.showInformationMessage(
        `Successfully rolled back profile "${selectedProfile.profile.profileId}"`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to rollback profile: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Clear sync history for a profile
   */
  public async clearSyncHistory(): Promise<void> {
    try {
      // Get active profiles
      const activeProfiles = await this.hubManager.listAllActiveProfiles();

      if (activeProfiles.length === 0) {
        vscode.window.showInformationMessage('No active profiles found.');
        return;
      }

      // Let user select a profile
      const profileItems = activeProfiles.map((profile) => ({
        label: profile.profileId,
        description: `Hub: ${profile.hubId}`,
        profile
      }));

      // Add "All Profiles" option
      const allOption = {
        label: '$(trash) Clear All History',
        description: 'Clear history for all profiles',
        profile: null as any
      };

      const items = [allOption, ...profileItems];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a profile to clear history',
        title: 'Clear Sync History',
        ignoreFocusOut: true
      });

      if (!selected) {
        return;
      }

      // Confirm deletion
      const message = selected.profile
        ? `Are you sure you want to clear history for profile "${selected.profile.profileId}"?`
        : 'Are you sure you want to clear ALL sync history?';

      const confirmation = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Yes',
        'No'
      );

      if (confirmation !== 'Yes') {
        return;
      }

      // Clear history
      if (selected.profile) {
        await this.syncHistory.clearHistory(
          selected.profile.hubId,
          selected.profile.profileId
        );
        vscode.window.showInformationMessage(
          `Cleared history for profile "${selected.profile.profileId}"`
        );
      } else {
        await this.syncHistory.clearAllHistory();
        vscode.window.showInformationMessage('Cleared all sync history');
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to clear sync history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the sync history instance for integration
   */
  public getSyncHistory(): HubSyncHistory {
    return this.syncHistory;
  }
}
