/**
 * Commands for activating and deactivating hub profiles
 */

import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';

/**
 * Command to activate a hub profile
 * @param hubManager
 * @param item
 */
export async function activateHubProfile(hubManager: HubManager, item?: any): Promise<void> {
  try {
    // Get the active hub ID first
    const activeHubId = await (hubManager as any).storage.getActiveHubId();

    if (!activeHubId) {
      vscode.window.showWarningMessage('No active hub configured. Please configure a hub first.');
      return;
    }

    // Get the active hub details
    const activeHubResult = await hubManager.getActiveHub();
    if (!activeHubResult) {
      vscode.window.showWarningMessage('Failed to load active hub configuration.');
      return;
    }

    const activeHubName = activeHubResult.config.metadata.name || 'Unknown Hub';

    // Extract profile from tree item if provided
    let preSelectedProfileId: string | undefined;

    if (item && typeof item === 'object' && item.data // Check if it's a profile item from the active hub
      && item.data.profileId && item.data.hubId) {
      // Verify it's from the active hub
      if (item.data.hubId === activeHubId) {
        preSelectedProfileId = item.data.profileId;
      } else {
        vscode.window.showWarningMessage('This profile is not from the active hub. Please switch to the correct hub first.');
        return;
      }
    }

    // Get profiles from the active hub only
    const profiles = await hubManager.listProfilesFromHub(activeHubId);
    const activeProfile = await hubManager.getActiveProfile(activeHubId);

    if (profiles.length === 0) {
      vscode.window.showWarningMessage(`No profiles found in active hub: ${activeHubName}`);
      return;
    }

    // Show profile picker (skip if profile pre-selected from tree)
    let selectedProfile: { profileId: string; hubId: string } | undefined;

    if (preSelectedProfileId) {
      const profile = profiles.find((p) => p.id === preSelectedProfileId);
      if (profile) {
        selectedProfile = { profileId: profile.id, hubId: activeHubId };
      }
    }

    if (!selectedProfile) {
      const profileItems = profiles.map((profile) => {
        const isActive = activeProfile?.profileId === profile.id;
        const bundleCount = profile.bundles.length;
        const requiredCount = profile.bundles.filter((b) => b.required).length;

        return {
          label: `${profile.icon || '📦'} ${profile.name}${isActive ? ' ✓' : ''}`,
          description: isActive ? 'Active' : undefined,
          detail: `${bundleCount} bundle${bundleCount === 1 ? '' : 's'}${requiredCount > 0 ? ` (${requiredCount} required)` : ''}`,
          profileId: profile.id,
          hubId: activeHubId
        };
      });

      selectedProfile = await vscode.window.showQuickPick(profileItems, {
        placeHolder: `Select a profile to activate from ${activeHubName}`,
        title: `Activate Profile - ${activeHubName}`,
        ignoreFocusOut: true
      });

      if (!selectedProfile) {
        return; // User cancelled
      }
    }

    // Ensure we have a selected profile
    if (!selectedProfile) {
      return;
    }

    // Check if profile is already active
    if (activeProfile?.profileId === selectedProfile.profileId) {
      vscode.window.showInformationMessage(`Profile "${selectedProfile.profileId}" is already active`);
      return;
    }

    // Activate the profile
    await hubManager.activateProfile(selectedProfile.hubId, selectedProfile.profileId, { installBundles: true });

    // Refresh tree view
    await vscode.commands.executeCommand('promptRegistry.refresh');

    vscode.window.showInformationMessage(`Activated profile: ${selectedProfile.profileId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to activate profile: ${errorMessage}`);
  }
}

/**
 * Deactivate the currently active hub profile.
 * @param hubManager
 * @param _item
 */
export async function deactivateHubProfile(hubManager: HubManager, _item?: any): Promise<void> {
  try {
    // Get the active hub ID first
    const activeHubId = await (hubManager as any).storage.getActiveHubId();

    if (!activeHubId) {
      vscode.window.showWarningMessage('No active hub configured. Please configure a hub first.');
      return;
    }

    // Get the active hub details
    const activeHubResult = await hubManager.getActiveHub();
    if (!activeHubResult) {
      vscode.window.showWarningMessage('Failed to load active hub configuration.');
      return;
    }

    const activeHubName = activeHubResult.config.metadata.name || 'Unknown Hub';

    // Get active profiles from the active hub only
    const activeProfile = await hubManager.getActiveProfile(activeHubId);

    if (!activeProfile) {
      vscode.window.showWarningMessage(`No active profile in ${activeHubName} to deactivate.`);
      return;
    }

    // Get the profile details
    const profile = await hubManager.getHubProfile(activeHubId, activeProfile.profileId);

    if (!profile) {
      vscode.window.showErrorMessage('Active profile not found in hub configuration.');
      return;
    }

    // Show confirmation
    const confirm = await vscode.window.showQuickPick(
      [
        {
          label: `$(x) Deactivate ${profile.name}`,
          description: 'Confirm deactivation',
          action: 'confirm'
        },
        {
          label: '$(close) Cancel',
          description: 'Keep profile active',
          action: 'cancel'
        }
      ],
      {
        placeHolder: `Deactivate profile "${profile.name}" from ${activeHubName}?`,
        title: 'Deactivate Profile',
        ignoreFocusOut: true
      }
    );

    if (!confirm || confirm.action !== 'confirm') {
      return; // User cancelled
    }

    // Deactivate the profile
    const result = await hubManager.deactivateProfile(activeHubId, activeProfile.profileId);

    if (result.success) {
      // Refresh tree view
      await vscode.commands.executeCommand('promptRegistry.refresh');
      vscode.window.showInformationMessage(`Deactivated profile "${profile.name}" from ${activeHubName}`);
    } else {
      vscode.window.showErrorMessage(`Failed to deactivate profile: ${result.error}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error deactivating profile: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Show the currently active hub profiles.
 * @param hubManager
 */
export async function showActiveProfiles(hubManager: HubManager): Promise<void> {
  try {
    // Get the active hub ID first
    const activeHubId = await (hubManager as any).storage.getActiveHubId();

    if (!activeHubId) {
      vscode.window.showWarningMessage('No active hub configured. Please configure a hub first.');
      return;
    }

    // Get the active hub details
    const activeHubResult = await hubManager.getActiveHub();
    if (!activeHubResult) {
      vscode.window.showWarningMessage('Failed to load active hub configuration.');
      return;
    }

    const activeHubName = activeHubResult.config.metadata.name || 'Unknown Hub';

    // Get active profile from the active hub
    const activeProfile = await hubManager.getActiveProfile(activeHubId);

    if (!activeProfile) {
      vscode.window.showInformationMessage(`No active profile in ${activeHubName}.`);
      return;
    }

    // Get profile details
    const profile = await hubManager.getHubProfile(activeHubId, activeProfile.profileId);

    if (!profile) {
      vscode.window.showErrorMessage('Active profile not found in hub configuration.');
      return;
    }

    // Show profile info with deactivate option
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: `${profile.icon || '📦'} ${profile.name} ✓`,
          description: activeHubName,
          detail: `Activated ${new Date(activeProfile.activatedAt).toLocaleString()} • ${activeProfile.syncedBundles.length} bundle${activeProfile.syncedBundles.length === 1 ? '' : 's'}`,
          action: 'deactivate' as const
        }
      ],
      {
        placeHolder: 'Active profile (select to deactivate)',
        title: `Active Profile - ${activeHubName}`,
        ignoreFocusOut: true
      }
    );

    if (!selected) {
      return; // User cancelled
    }

    // If user selected the profile, deactivate it
    if (selected.action === 'deactivate') {
      const result = await hubManager.deactivateProfile(activeHubId, activeProfile.profileId);

      if (result.success) {
        // Refresh tree view
        await vscode.commands.executeCommand('promptRegistry.refresh');
        vscode.window.showInformationMessage(`Deactivated profile "${profile.name}" from ${activeHubName}`);
      } else {
        vscode.window.showErrorMessage(`Failed to deactivate profile: ${result.error}`);
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error showing active profiles: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
