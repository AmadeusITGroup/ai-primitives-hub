/**
 * Hub Profile Commands
 * Commands for browsing and managing profiles from imported hubs
 */

import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  SchemaValidator,
} from '../services/schema-validator';
import {
  HubStorage,
} from '../storage/hub-storage';
import {
  HubProfile,
} from '../types/hub';
import {
  Logger,
} from '../utils/logger';

/**
 * Hub Profile Commands Handler
 */
export class HubProfileCommands {
  private readonly logger: Logger;
  private readonly hubManager: HubManager;
  private readonly hubStorage: HubStorage;

  constructor(context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
    const storagePath = context.globalStorageUri.fsPath;
    this.hubStorage = new HubStorage(storagePath);
    const validator = new SchemaValidator(context.extensionPath);
    this.hubManager = new HubManager(this.hubStorage, validator, context.extensionPath);

    this.registerCommands(context);
  }

  /**
   * Register all hub profile commands
   * @param context
   */
  private registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.listHubProfiles', () => this.listHubProfiles()),
      vscode.commands.registerCommand('promptregistry.browseHubProfiles', () => this.browseHubProfiles()),
      vscode.commands.registerCommand('promptregistry.viewHubProfile', (hubId: string, profileId: string) =>
        this.viewHubProfile(hubId, profileId)
      ),
      vscode.commands.registerCommand('promptRegistry.toggleProfileFavorite', (arg: any) =>
        this.toggleProfileFavorite(arg)
      )
    );
  }

  /**
   * Show detailed information about a hub profile with actions
   * @param profile
   */
  private async showProfileDetails(profile: HubProfile & { hubId: string; hubName: string }): Promise<void> {
    const bundleList = profile.bundles.length > 0
      ? profile.bundles.map((b, i) => `   ${i + 1}. ${b.id}@${b.version}${b.required ? ' (required)' : ''}`).join('\n')
      : '   (No bundles)';

    const message = [
      `**${profile.name}**`,
      '',
      `📦 Hub: ${profile.hubName}`,
      `📝 ${profile.description}`,
      '',
      `**Bundles (${profile.bundles.length}):**`,
      bundleList,
      '',
      `Created: ${profile.createdAt || 'Unknown'}`,
      `Updated: ${profile.updatedAt || 'Unknown'}`
    ].join('\n');

    // Show in markdown preview
    const panel = vscode.window.createWebviewPanel(
      'hubProfileDetails',
      `Profile: ${profile.name}`,
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    panel.webview.html = this.getProfileDetailsHtml(profile, message);

    // Show action buttons
    const action = await vscode.window.showInformationMessage(
      `Viewing profile "${profile.name}" from "${profile.hubName}"`,
      'Copy to Local',
      'View Hub',
      'Close'
    );

    if (action === 'Copy to Local') {
      await this.copyProfileToLocal(profile);
    } else if (action === 'View Hub') {
      await vscode.commands.executeCommand('promptregistry.listHubs');
    }

    panel.dispose();
  }

  /**
   * Generate HTML for profile details webview
   * @param profile
   * @param _markdown
   */
  private getProfileDetailsHtml(profile: HubProfile & { hubId: string; hubName: string }, _markdown: string): string {
    const bundleRows = profile.bundles.map((b) => `
            <tr>
                <td>${b.id}</td>
                <td>${b.version}</td>
                <td>${b.source}</td>
                <td>${b.required ? '✓' : ''}</td>
            </tr>
        `).join('');

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1 { 
            font-size: 24px; 
            margin-bottom: 10px;
            color: var(--vscode-textLink-foreground);
        }
        .meta {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 20px;
        }
        .section {
            margin: 20px 0;
        }
        .section h2 {
            font-size: 18px;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        th, td {
            text-align: left;
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            font-weight: bold;
            background-color: var(--vscode-editor-background);
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 12px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
    </style>
</head>
<body>
    <h1>${profile.icon || '📦'} ${profile.name}</h1>
    <div class="meta">
        <span class="badge">Hub: ${profile.hubName}</span>
        <span class="badge">Hub ID: ${profile.hubId}</span>
    </div>
    
    <div class="section">
        <p>${profile.description}</p>
    </div>

    <div class="section">
        <h2>Bundles (${profile.bundles.length})</h2>
        ${profile.bundles.length > 0
          ? `
        <table>
            <thead>
                <tr>
                    <th>Bundle ID</th>
                    <th>Version</th>
                    <th>Source</th>
                    <th>Required</th>
                </tr>
            </thead>
            <tbody>
                ${bundleRows}
            </tbody>
        </table>
        `
          : '<p>No bundles in this profile.</p>'}
    </div>

    <div class="section">
        <h2>Metadata</h2>
        <table>
            <tr>
                <td><strong>Profile ID:</strong></td>
                <td>${profile.id}</td>
            </tr>
            <tr>
                <td><strong>Created:</strong></td>
                <td>${profile.createdAt || 'Unknown'}</td>
            </tr>
            <tr>
                <td><strong>Updated:</strong></td>
                <td>${profile.updatedAt || 'Unknown'}</td>
            </tr>
            <tr>
                <td><strong>Active:</strong></td>
                <td>${profile.active ? 'Yes' : 'No'}</td>
            </tr>
        </table>
    </div>
</body>
</html>`;
  }

  /**
   * Copy a hub profile to local profiles
   * @param profile
   */
  private async copyProfileToLocal(profile: HubProfile & { hubId: string; hubName: string }): Promise<void> {
    try {
      const newName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the local copy',
        value: `${profile.name} (from ${profile.hubName})`,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Profile name cannot be empty';
          }
          return null;
        },
        ignoreFocusOut: true
      });

      if (!newName) {
        return;
      }

      // TODO: Implement profile copying to RegistryManager
      // This will be part of Phase 3 (Profile Activation)
      vscode.window.showInformationMessage(
        `Profile copying will be implemented in Phase 3. Profile "${profile.name}" would be copied as "${newName}".`
      );
    } catch (error) {
      this.logger.error('Failed to copy profile', error as Error);
      vscode.window.showErrorMessage(`Failed to copy profile: ${(error as Error).message}`);
    }
  }

  /**
   * Toggle profile favorite status
   * @param arg
   */
  public async toggleProfileFavorite(arg: any): Promise<void> {
    try {
      let hubId: string;
      let profileId: string;

      // Handle tree item argument
      if (arg?.data?.hubId && arg?.data?.id) {
        hubId = arg.data.hubId;
        profileId = arg.data.id;
      } else if (arg?.hubId && arg?.profileId) {
        // Handle direct argument
        hubId = arg.hubId;
        profileId = arg.profileId;
      } else {
        this.logger.error('Invalid arguments for toggleProfileFavorite');
        return;
      }

      this.logger.info(`Toggling favorite for profile ${profileId} in hub ${hubId}`);
      await this.hubManager.toggleProfileFavorite(hubId, profileId);
      const isFavorite = await this.hubManager.isProfileFavorite(hubId, profileId);
      const status = isFavorite ? 'added to' : 'removed from';
      this.logger.info(`Profile ${profileId} ${status} favorites`);
      vscode.window.showInformationMessage(`Profile ${status} favorites`);
    } catch (error) {
      this.logger.error('Failed to toggle profile favorite', error as Error);
      vscode.window.showErrorMessage(`Failed to toggle favorite: ${(error as Error).message}`);
    }
  }

  /**
   * List all hub profiles from all imported hubs
   */
  public async listHubProfiles(): Promise<void> {
    try {
      const profiles = await this.hubManager.listAllHubProfiles();

      if (profiles.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No hub profiles found. Import a hub to access curated profiles!',
          'Import Hub'
        );

        if (action === 'Import Hub') {
          await vscode.commands.executeCommand('promptregistry.importHub');
        }
        return;
      }

      // Group profiles by hub
      const hubGroups = new Map<string, typeof profiles>();
      for (const profile of profiles) {
        if (!hubGroups.has(profile.hubId)) {
          hubGroups.set(profile.hubId, []);
        }
        hubGroups.get(profile.hubId)!.push(profile);
      }

      // Create quick pick items
      const items: (vscode.QuickPickItem & { profile?: HubProfile & { hubId: string; hubName: string } })[] = [];

      for (const [, hubProfiles] of hubGroups) {
        const hubName = hubProfiles[0].hubName;

        // Hub separator
        items.push({
          label: `$(package) ${hubName}`,
          kind: vscode.QuickPickItemKind.Separator
        });

        // Profiles from this hub
        for (const profile of hubProfiles) {
          items.push({
            label: `${profile.icon || '$(file)'} ${profile.name}`,
            description: `${profile.bundles.length} bundles`,
            detail: profile.description,
            profile: profile
          });
        }
      }

      const selected = await vscode.window.showQuickPick(items.filter((i) => i.profile), {
        placeHolder: 'Select a hub profile to view details',
        title: `Hub Profiles (${profiles.length} available)`,
        ignoreFocusOut: true
      });

      if (selected?.profile) {
        await this.showProfileDetails(selected.profile);
      }
    } catch (error) {
      this.logger.error('Failed to list hub profiles', error as Error);
      vscode.window.showErrorMessage(`Failed to list hub profiles: ${(error as Error).message}`);
    }
  }

  /**
   * Browse hub profiles with filtering and search
   */
  public async browseHubProfiles(): Promise<void> {
    try {
      const hubs = await this.hubManager.listHubs();

      if (hubs.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No hubs imported. Import a hub to browse profiles!',
          'Import Hub'
        );

        if (action === 'Import Hub') {
          await vscode.commands.executeCommand('promptregistry.importHub');
        }
        return;
      }

      // Select hub first
      const hubItems = hubs.map((hub) => ({
        label: `$(package) ${hub.name}`,
        description: hub.description,
        detail: `Source: ${hub.reference.type}`,
        hub: hub
      }));

      const selectedHub = await vscode.window.showQuickPick(hubItems, {
        placeHolder: 'Select a hub to browse its profiles',
        title: 'Browse Hub Profiles',
        ignoreFocusOut: true
      });

      if (!selectedHub) {
        return;
      }

      // List profiles from selected hub
      const profiles = await this.hubManager.listProfilesFromHub(selectedHub.hub.id);

      if (profiles.length === 0) {
        vscode.window.showInformationMessage(
          `Hub "${selectedHub.hub.name}" has no profiles.`
        );
        return;
      }

      const profileItems = profiles.map((profile) => ({
        label: `${profile.icon || '$(file)'} ${profile.name}`,
        description: `${profile.bundles.length} bundles`,
        detail: profile.description,
        profile: profile,
        hubId: selectedHub.hub.id,
        hubName: selectedHub.hub.name
      }));

      const selectedProfile = await vscode.window.showQuickPick(profileItems, {
        placeHolder: `Select a profile from "${selectedHub.hub.name}"`,
        title: `${selectedHub.hub.name} - Profiles`,
        ignoreFocusOut: true
      });

      if (selectedProfile) {
        await this.showProfileDetails({
          ...selectedProfile.profile,
          hubId: selectedProfile.hubId,
          hubName: selectedProfile.hubName
        });
      }
    } catch (error) {
      this.logger.error('Failed to browse hub profiles', error as Error);
      vscode.window.showErrorMessage(`Failed to browse hub profiles: ${(error as Error).message}`);
    }
  }

  /**
   * View details of a specific hub profile
   * @param hubId
   * @param profileId
   */
  public async viewHubProfile(hubId: string, profileId: string): Promise<void> {
    try {
      const profile = await this.hubManager.getHubProfile(hubId, profileId);
      const hubInfo = await this.hubManager.getHubInfo(hubId);

      await this.showProfileDetails({
        ...profile,
        hubId: hubId,
        hubName: hubInfo.config.metadata.name
      });
    } catch (error) {
      this.logger.error('Failed to view hub profile', error as Error);
      vscode.window.showErrorMessage(`Failed to view profile: ${(error as Error).message}`);
    }
  }
}
