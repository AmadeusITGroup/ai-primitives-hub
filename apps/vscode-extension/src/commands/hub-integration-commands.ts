/**
 * HubIntegrationCommands - Unified command registration for hub profile operations
 * Integrates activation, sync, and history commands into VS Code
 */

import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  HubHistoryCommands,
} from './hub-history-commands';
import {
  activateHubProfile,
  deactivateHubProfile,
  showActiveProfiles,
} from './hub-profile-activation-commands';
import {
  HubSyncCommands,
} from './hub-sync-commands';

/**
 * Registers all hub integration commands
 */
export class HubIntegrationCommands {
  private readonly syncCommands: HubSyncCommands;
  private readonly historyCommands: HubHistoryCommands;

  constructor(
    private readonly hubManager: HubManager,
    private readonly context: vscode.ExtensionContext
  ) {
    // Initialize command handlers (history first, then pass to sync)
    this.historyCommands = new HubHistoryCommands(hubManager, context);
    this.syncCommands = new HubSyncCommands(hubManager, this.historyCommands.getSyncHistory());

    // Register all commands
    this.registerActivationCommands();
    this.registerSyncCommands();
  }

  /**
   * Register profile activation commands
   */
  private registerActivationCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.activateHubProfile', () =>
        activateHubProfile(this.hubManager)
      ),
      vscode.commands.registerCommand('promptregistry.deactivateHubProfile', () =>
        deactivateHubProfile(this.hubManager)
      ),
      vscode.commands.registerCommand('promptregistry.showActiveProfiles', () =>
        showActiveProfiles(this.hubManager)
      )
    );
  }

  /**
   * Register sync commands with VS Code command wrappers
   */
  private registerSyncCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.checkForUpdates', async (hubId?: string, profileId?: string) => {
        try {
          // If parameters not provided, let user select
          if (!hubId || !profileId) {
            const profile = await this.selectActiveProfile();
            if (!profile) {
              return;
            }
            hubId = profile.hubId;
            profileId = profile.profileId;
          }
          return await this.syncCommands.checkForUpdates(hubId, profileId);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),

      vscode.commands.registerCommand('promptregistry.viewProfileChanges', async (hubId?: string, profileId?: string) => {
        try {
          if (!hubId || !profileId) {
            const profile = await this.selectActiveProfile();
            if (!profile) {
              return;
            }
            hubId = profile.hubId;
            profileId = profile.profileId;
          }
          return await this.syncCommands.viewChanges(hubId, profileId);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to view changes: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),

      vscode.commands.registerCommand('promptregistry.syncProfileNow', async (hubId?: string, profileId?: string) => {
        try {
          if (!hubId || !profileId) {
            const profile = await this.selectActiveProfile();
            if (!profile) {
              return;
            }
            hubId = profile.hubId;
            profileId = profile.profileId;
          }
          await this.syncCommands.syncProfile(hubId, profileId);
          vscode.window.showInformationMessage('Profile synced successfully');
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to sync profile: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),

      vscode.commands.registerCommand('promptregistry.reviewAndSyncProfile', async (hubId?: string, profileId?: string) => {
        try {
          if (!hubId || !profileId) {
            const profile = await this.selectActiveProfile();
            if (!profile) {
              return;
            }
            hubId = profile.hubId;
            profileId = profile.profileId;
          }
          return await this.syncCommands.reviewAndSync(hubId, profileId);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to review and sync: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
    );
  }

  /**
   * Helper to select an active profile via QuickPick
   */
  private async selectActiveProfile(): Promise<{ hubId: string; profileId: string } | null> {
    const activeProfiles = await this.hubManager.listAllActiveProfiles();

    if (activeProfiles.length === 0) {
      vscode.window.showInformationMessage('No active hub profiles found');
      return null;
    }

    interface ProfileQuickPickItem extends vscode.QuickPickItem {
      hubId: string;
      profileId: string;
    }

    const items: ProfileQuickPickItem[] = [];

    for (const state of activeProfiles) {
      try {
        // Get hub and profile details
        const hubInfo = await this.hubManager.getHubInfo(state.hubId);
        const profile = await this.hubManager.getHubProfile(state.hubId, state.profileId);

        items.push({
          label: profile.name,
          description: hubInfo.metadata.name,
          detail: `Hub: ${state.hubId}, Profile: ${state.profileId}`,
          hubId: state.hubId,
          profileId: state.profileId
        });
      } catch {
        // Skip profiles that can't be loaded
        continue;
      }
    }

    if (items.length === 0) {
      vscode.window.showErrorMessage('No valid active profiles found');
      return null;
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a profile',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true
    });

    return selected ? { hubId: selected.hubId, profileId: selected.profileId } : null;
  }
}
