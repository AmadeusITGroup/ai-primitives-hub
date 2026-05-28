/**
 * HubCommands - VS Code commands for hub management
 * Provides user interface for importing, listing, syncing, and deleting hubs
 */

import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  HubReference,
} from '../types/hub';
import {
  Logger,
} from '../utils/logger';

/**
 * Hub source type for user selection
 */
interface HubSourceOption {
  label: string;
  description: string;
  value: 'github' | 'url' | 'local';
}

/**
 * Hub list item for display
 */
interface HubListItem extends vscode.QuickPickItem {
  hubId: string;
  action?: string;
}

/**
 * HubCommands manages VS Code commands for hub operations
 */
export class HubCommands {
  private readonly hubManager: HubManager;
  private readonly registryManager: RegistryManager;

  /**
   * Initialize HubCommands and register commands
   * @param hubManager HubManager instance
   * @param context Extension context for command registration
   */
  private readonly logger: Logger;

  private readonly context: vscode.ExtensionContext;

  constructor(
    hubManager: HubManager,
    registryManager: RegistryManager,
    context: vscode.ExtensionContext
  ) {
    this.logger = Logger.getInstance();
    this.hubManager = hubManager;
    this.registryManager = registryManager;
    this.context = context;
    this.registerCommands();
  }

  /**
   * Convert a hub reference to a URL
   * @param reference
   * @param reference.type
   * @param reference.location
   */
  private referenceToUrl(reference: { type: string; location: string }): string | undefined {
    switch (reference.type) {
      case 'github': {
        return `https://github.com/${reference.location}`;
      }
      case 'url': {
        return reference.location;
      }
      case 'local': {
        return undefined;
      }
      default: {
        return undefined;
      }
    }
  }

  /**
   * Convert a source to a repository URL
   * @param source
   */
  private sourceToUrl(source: any): string | undefined {
    if (!source) {
      return undefined;
    }

    // Check for explicit repository/homepage in metadata
    if (source.metadata?.homepage) {
      return source.metadata.homepage;
    }

    const url = source.url;
    if (!url) {
      return undefined;
    }

    switch (source.type) {
      case 'github':
      case 'awesome-copilot': {
        // GitHub URL - extract repo path
        // Could be: https://github.com/owner/repo or owner/repo
        if (url.startsWith('https://github.com/')) {
          // Remove /tree/branch or /blob/branch suffix if present
          const cleanUrl = url.replace(/\/(tree|blob)\/[^/]+.*$/, '');
          return cleanUrl;
        } else if (/^[^/]+\/[^/]+$/.test(url)) {
          // Short format: owner/repo
          return `https://github.com/${url}`;
        }
        return url;
      }
      case 'local':
      case 'local-awesome-copilot':
      case 'local-apm': {
        return undefined;
      }
      default: {
        return url;
      }
    }
  }

  /**
   * Select hub source type
   */
  private async selectSourceType(): Promise<'github' | 'url' | 'local' | undefined> {
    const options: HubSourceOption[] = [
      {
        label: '$(github) GitHub Repository',
        description: 'Import from a GitHub repository',
        value: 'github'
      },
      // {
      //     label: '$(link) HTTPS URL',
      //     description: 'Import from a direct URL',
      //     value: 'url'
      // },
      {
        label: '$(file) Local File',
        description: 'Import from a local hub-config.yml file',
        value: 'local'
      }
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: 'Select hub source type',
      ignoreFocusOut: true
    });

    return selected?.value;
  }

  /**
   * Get hub reference based on source type
   * @param sourceType
   */
  private async getHubReference(sourceType: 'github' | 'url' | 'local'): Promise<HubReference | undefined> {
    switch (sourceType) {
      case 'github': {
        const location = await vscode.window.showInputBox({
          prompt: 'Enter GitHub repository (e.g., owner/repo)',
          placeHolder: 'owner/repo',
          validateInput: (value) => {
            if (!value || !value.includes('/')) {
              return 'Please enter a valid GitHub repository (owner/repo)';
            }
            return null;
          },
          ignoreFocusOut: true
        });

        if (!location) {
          return undefined;
        }

        const ref = await vscode.window.showInputBox({
          prompt: 'Enter branch, tag, or commit (optional, default: main)',
          placeHolder: 'main',
          ignoreFocusOut: true
        });

        return {
          type: 'github',
          location,
          ref: ref || undefined
        };
      }

      case 'url': {
        const location = await vscode.window.showInputBox({
          prompt: 'Enter HTTPS URL to hub-config.yml',
          placeHolder: 'https://example.com/hub-config.yml',
          validateInput: (value) => {
            if (!value || !value.startsWith('https://')) {
              return 'Please enter a valid HTTPS URL';
            }
            return null;
          },
          ignoreFocusOut: true
        });

        return location ? { type: 'url', location } : undefined;
      }

      case 'local': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            'YAML Files': ['yml', 'yaml']
          },
          title: 'Select hub-config.yml file'
        });

        if (!uris || uris.length === 0) {
          return undefined;
        }

        return {
          type: 'local',
          location: uris[0].fsPath
        };
      }
    }
  }

  /**
   * Get hub ID from user (optional)
   */
  private async getHubId(): Promise<string | null | undefined> {
    const hubId = await vscode.window.showInputBox({
      prompt: 'Enter hub ID (optional, will auto-generate if empty)',
      placeHolder: 'my-hub',
      validateInput: (value) => {
        if (value && !/^[a-z0-9-]+$/.test(value)) {
          return 'Hub ID must contain only lowercase letters, numbers, and hyphens';
        }
        if (value && (value.startsWith('-') || value.endsWith('-'))) {
          return 'Hub ID cannot start or end with a hyphen';
        }
        return null;
      },
      ignoreFocusOut: true
    });

    return hubId === undefined ? null : (hubId || '');
  }

  /**
   * Show detailed information about a hub
   * @param hubId
   */
  private async showHubDetails(hubId: string): Promise<void> {
    try {
      const info = await this.hubManager.getHubInfo(hubId);

      // Show in output channel or quick pick with actions
      const action = await vscode.window.showInformationMessage(
        `Hub: ${info.config.metadata.name}`,
        'Sync',
        'Delete',
        'Close'
      );

      if (action === 'Sync') {
        await this.syncHub(hubId);
      } else if (action === 'Delete') {
        await this.deleteHub(hubId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to get hub details: ${message}`);
    }
  }

  /**
   * Sync all imported hubs
   */
  private async syncAllHubs(): Promise<void> {
    const hubs = await this.hubManager.listHubs();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Syncing all hubs',
        cancellable: false
      },
      async (progress) => {
        let completed = 0;
        for (const hub of hubs) {
          progress.report({
            message: `Syncing ${hub.name} (${completed + 1}/${hubs.length})`,
            increment: (100 / hubs.length)
          });

          try {
            await this.hubManager.syncHub(hub.id);
          } catch (error) {
            vscode.window.showWarningMessage(
              `Failed to sync ${hub.name}: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          completed++;
        }

        vscode.window.showInformationMessage(
          `Synced ${completed} of ${hubs.length} hubs successfully`
        );
      }
    );
  }

  /**
   * Register all hub-related commands
   */
  public registerCommands(): void {
    // Skip registration if vscode.commands is not available (e.g., in unit tests)
    if (!vscode.commands || !vscode.commands.registerCommand) {
      return;
    }

    this.context.subscriptions.push(
      vscode.commands.registerCommand('promptregistry.importHub', () => this.importHub()),
      vscode.commands.registerCommand('promptregistry.listHubs', () => this.listHubs()),
      vscode.commands.registerCommand('promptregistry.syncHub', (hubId?: string) => this.syncHub(hubId)),
      vscode.commands.registerCommand('promptregistry.deleteHub', (hubId?: string) => this.deleteHub(hubId)),
      vscode.commands.registerCommand('promptregistry.switchHub', () => this.switchHub()),
      vscode.commands.registerCommand('promptregistry.exportHubConfig', () => this.exportHubConfig()),
      vscode.commands.registerCommand('promptregistry.openHubRepository', () => this.openHubRepository()),
      vscode.commands.registerCommand('promptregistry.openItemRepository', (item: any) => this.openItemRepository(item))
    );
  }

  /**
   * Import a hub from various sources
   */
  public async importHub(): Promise<string | undefined> {
    try {
      // Step 1: Select source type
      const sourceType = await this.selectSourceType();
      if (!sourceType) {
        return undefined;
      }

      // Step 2: Get hub reference based on source type
      const reference = await this.getHubReference(sourceType);
      if (!reference) {
        return undefined;
      }

      // Step 3: Get hub ID (optional, will auto-generate if not provided)
      const hubId = await this.getHubId();
      if (hubId === null) {
        return undefined; // User cancelled
      }

      // Step 4: Import hub with progress
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Importing Hub',
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Loading hub configuration...' });

          try {
            // HubManager.importHub() handles source loading via loadHubSources()
            const importedHubId = await this.hubManager.importHub(reference, hubId || undefined);

            // Note: Hub profiles are NOT copied locally. They are accessed via
            // HubManager.listProfilesFromHub() and displayed in "Shared Profiles" view.
            // Local profiles are only created when the user explicitly creates them.

            // Auto-activate the imported hub
            await this.hubManager.setActiveHub(importedHubId);
            this.logger.info(`Auto-activated imported hub: ${importedHubId}`);

            vscode.window.showInformationMessage(
              `Successfully imported and activated hub: ${importedHubId}`
            );

            // Refresh the tree view to show the new hub
            vscode.commands.executeCommand('promptregistry.refresh');

            return importedHubId;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to import hub: ${message}`);
            throw error;
          }
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Hub import failed: ${message}`);
      return undefined;
    }
  }

  /**
   * List all imported hubs
   */
  public async listHubs(): Promise<void> {
    try {
      const hubs = await this.hubManager.listHubs();

      if (hubs.length === 0) {
        vscode.window.showInformationMessage('No hubs imported yet. Use "Import Hub" to add one.');
        return;
      }

      // Create quick pick items
      const items: HubListItem[] = hubs.map((hub) => ({
        label: hub.name,
        description: hub.description,
        detail: `ID: ${hub.id} | Source: ${hub.reference.type}`,
        hubId: hub.id
      }));

      // Show quick pick
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a hub to view details',
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });

      if (selected) {
        await this.showHubDetails(selected.hubId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to list hubs: ${message}`);
    }
  }

  /**
   * Sync a hub from its source
   * @param hubId Optional hub ID to sync (if not provided, user selects)
   */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- union type kept for documentation clarity
  public async syncHub(hubId?: string | any): Promise<void> {
    try {
      // Extract hub ID from tree item if object is passed
      let targetHubId: string | undefined;
      if (typeof hubId === 'string') {
        targetHubId = hubId;
      } else if (hubId && typeof hubId === 'object' && hubId.data) {
        // Tree item passed from context menu
        targetHubId = hubId.data.id;
      }

      // If no hub ID provided, let user select
      if (!targetHubId) {
        const hubs = await this.hubManager.listHubs();

        if (hubs.length === 0) {
          vscode.window.showInformationMessage('No hubs to sync.');
          return;
        }

        // Add "Sync All" option
        const items: HubListItem[] = [
          {
            label: '$(sync) Sync All Hubs',
            description: 'Synchronize all imported hubs',
            hubId: '',
            action: 'all'
          },
          ...hubs.map((hub) => ({
            label: hub.name,
            description: `Sync from ${hub.reference.type}`,
            detail: `ID: ${hub.id}`,
            hubId: hub.id
          }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select hub to sync',
          ignoreFocusOut: true
        });

        if (!selected) {
          return;
        }

        if (selected.action === 'all') {
          await this.syncAllHubs();
          return;
        }

        targetHubId = selected.hubId;
      }

      // Sync single hub
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Syncing hub: ${targetHubId}`,
          cancellable: false
        },
        async () => {
          await this.hubManager.syncHub(targetHubId);
          vscode.window.showInformationMessage(`Successfully synced hub: ${targetHubId}`);
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to sync hub', error as Error);
      vscode.window.showErrorMessage(`Failed to sync hub: ${message}`);
    }
  }

  /**
   * Delete a hub
   * @param hubId Optional hub ID to delete (if not provided, user selects)
   */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- union type kept for documentation clarity
  public async deleteHub(hubId?: string | any): Promise<void> {
    try {
      // Extract hub ID from tree item if object is passed
      let targetHubId: string | undefined;
      if (typeof hubId === 'string') {
        targetHubId = hubId;
      } else if (hubId && typeof hubId === 'object' && hubId.data) {
        // Tree item passed from context menu
        targetHubId = hubId.data.id;
      }

      // If no hub ID provided, let user select
      if (!targetHubId) {
        const hubs = await this.hubManager.listHubs();

        if (hubs.length === 0) {
          vscode.window.showInformationMessage('No hubs to delete.');
          return;
        }

        const items: HubListItem[] = hubs.map((hub) => ({
          label: hub.name,
          description: hub.description,
          detail: `ID: ${hub.id}`,
          hubId: hub.id
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select hub to delete',
          ignoreFocusOut: true
        });

        if (!selected) {
          return;
        }

        targetHubId = selected.hubId;
      }

      // Confirm deletion
      const hubInfo = await this.hubManager.getHubInfo(targetHubId);
      const confirmation = await vscode.window.showWarningMessage(
        `Delete hub "${hubInfo.config.metadata.name}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );

      if (confirmation !== 'Delete') {
        return;
      }

      // Delete hub
      await this.hubManager.deleteHub(targetHubId);

      // Refresh the tree view
      vscode.commands.executeCommand('promptregistry.refresh');

      vscode.window.showInformationMessage(`Deleted hub: ${targetHubId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to delete hub', error as Error);
      vscode.window.showErrorMessage(`Failed to delete hub: ${message}`);
    }
  }

  /**
   * Export current registry state as a hub configuration file
   * Useful for creating a seed hub config from existing setup
   */
  /**
   * Map internal source type to hub schema-compliant type
   */
  // Removed mapSourceTypeForHub - we now preserve source types directly

  /**
   * Switch the active hub
   * Shows a quick-pick with all imported hubs and option to import new hub
   */
  public async switchHub(): Promise<void> {
    try {
      // Get all imported hubs
      const hubs = await this.hubManager.listHubs();
      const activeHubId = await this.hubManager.getActiveHub();
      const currentActiveId = activeHubId?.config.metadata.name;

      // Build quick-pick items
      const items: (vscode.QuickPickItem & { hubId?: string; action?: string })[] = hubs.map((hub) => ({
        label: hub.name,
        description: hub.id === currentActiveId ? '$(check) Active' : hub.description,
        detail: `ID: ${hub.id}`,
        hubId: hub.id
      }));

      // Add "Import New Hub" option
      items.push({
        label: '$(cloud-download) Import New Hub...',
        description: 'Import a hub from GitHub, URL, or local path',
        action: 'import'
      });

      // Show quick-pick
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a hub to activate',
        title: 'Switch Active Hub',
        ignoreFocusOut: true
      });

      if (!selected) {
        return;
      }

      // Handle import action
      if (selected.action === 'import') {
        const newHubId = await this.importHub();
        if (newHubId) {
          await this.hubManager.setActiveHub(newHubId);
          vscode.window.showInformationMessage(`✅ Hub '${newHubId}' imported and activated`);
          vscode.commands.executeCommand('promptRegistry.refresh');
        }
        return;
      }

      // Set selected hub as active
      if (selected.hubId) {
        await this.hubManager.setActiveHub(selected.hubId);
        vscode.window.showInformationMessage(`✅ Switched to hub: ${selected.label}`);
        vscode.commands.executeCommand('promptRegistry.refresh');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to switch hub: ${message}`);
      this.logger.error('Switch hub failed', error as Error);
    }
  }

  public async exportHubConfig(): Promise<void> {
    try {
      // Get current profiles and sources
      const profiles = await this.registryManager.listProfiles();
      const sources = await this.registryManager.listSources();
      // Prompt for hub metadata
      const hubName = await vscode.window.showInputBox({
        prompt: 'Enter hub name',
        placeHolder: 'My Awesome Hub',
        validateInput: (value) => value.trim() ? null : 'Hub name is required',
        ignoreFocusOut: true
      });
      if (!hubName) {
        return;
      }

      const hubDescription = await vscode.window.showInputBox({
        prompt: 'Enter hub description',
        placeHolder: 'A curated collection of prompts for...',
        ignoreFocusOut: true
      });

      const maintainer = await vscode.window.showInputBox({
        prompt: 'Enter maintainer name/email',
        placeHolder: 'Your Name <email@example.com>',
        ignoreFocusOut: true
      });

      // Build hub config
      const hubConfig: any = {
        version: '1.0.0',
        metadata: {
          name: hubName,
          description: hubDescription || 'Exported hub configuration',
          maintainer: maintainer || 'Unknown',
          updatedAt: new Date().toISOString()
        },
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type, // Preserve original source type
          url: s.url,
          enabled: s.enabled,
          priority: s.priority,
          ...(s.metadata && { metadata: s.metadata }),
          ...(s.config && { config: s.config }) // Include source config
        })),
        profiles: profiles.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description || '',
          bundles: (Array.isArray(p.bundles) ? p.bundles : Object.values(p.bundles || {})).map((bundle: any) => ({
            id: bundle.id,
            version: bundle.version,
            source: sources[0]?.id || 'unknown',
            required: bundle.required
          }))
        }))
      };

      // Convert to YAML using js-yaml library
      const yamlStr = yaml.dump(hubConfig, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false
      });

      // Show in new editor
      const doc = await vscode.workspace.openTextDocument({
        content: yamlStr,
        language: 'yaml'
      });
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        `✅ Hub config exported! Save as 'hub-config.yml' for local testing.`,
        'Save As...'
      ).then((action) => {
        if (action === 'Save As...') {
          vscode.commands.executeCommand('workbench.action.files.saveAs');
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to export hub config: ${message}`);
    }
  }

  /**
   * Open the active hub's repository in browser
   * Falls back to selecting from available hubs if no active hub is set
   */
  public async openHubRepository(): Promise<void> {
    try {
      let activeHub = await this.hubManager.getActiveHub();

      // If no active hub, fall back to available hubs
      if (!activeHub) {
        const hubs = await this.hubManager.listHubs();

        if (hubs.length === 0) {
          vscode.window.showInformationMessage('No hubs imported. Use "Import Hub" to add one first.');
          return;
        }

        if (hubs.length === 1) {
          // Single hub - use it directly
          activeHub = await this.hubManager.loadHub(hubs[0].id);
        } else {
          // Multiple hubs - let user select
          const items = hubs.map((hub) => ({
            label: hub.name,
            description: hub.description,
            detail: `ID: ${hub.id}`,
            hubId: hub.id
          }));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a hub to open its repository',
            ignoreFocusOut: true
          });

          if (!selected) {
            return;
          }

          activeHub = await this.hubManager.loadHub(selected.hubId);
        }
      }

      const reference = activeHub.reference;
      let repositoryUrl: string | undefined;

      // Construct repository URL based on hub type
      switch (reference.type) {
        case 'github': {
          // Format: owner/repo
          repositoryUrl = `https://github.com/${reference.location}`;
          break;
        }

        case 'url': {
          // Direct URL - use as is
          repositoryUrl = reference.location;
          break;
        }

        case 'local': {
          vscode.window.showInformationMessage(
            'This hub is stored locally and does not have a remote repository URL.',
            'OK'
          );
          return;
        }

        default: {
          vscode.window.showWarningMessage('Unable to determine repository URL for this hub type.');
          return;
        }
      }

      if (repositoryUrl) {
        // Open URL in external browser
        await vscode.env.openExternal(vscode.Uri.parse(repositoryUrl));
        this.logger.info(`Opened hub repository: ${repositoryUrl}`);
      }
    } catch (error) {
      this.logger.error('Failed to open hub repository', error as Error);
      vscode.window.showErrorMessage(`Failed to open hub repository: ${(error as Error).message}`);
    }
  }

  /**
   * Open repository for a specific item (hub, profile, source, bundle)
   * Called from context menu in Registry Explorer
   * @param item
   */
  public async openItemRepository(item: any): Promise<void> {
    try {
      if (!item || !item.type) {
        vscode.window.showWarningMessage('Unable to determine item type.');
        return;
      }

      const itemType = item.type;
      const data = item.data;

      let repositoryUrl: string | undefined;

      switch (itemType) {
        case 'hub': {
          // Hub item - use hub's reference
          if (data?.reference) {
            repositoryUrl = this.referenceToUrl(data.reference);
          } else if (data?.id) {
            const hub = await this.hubManager.loadHub(data.id);
            repositoryUrl = this.referenceToUrl(hub.reference);
          }
          break;
        }

        case 'hub_profile': {
          // Hub profile - use parent hub's reference
          const hubId = data?.hubId;
          if (hubId) {
            const hub = await this.hubManager.loadHub(hubId);
            repositoryUrl = this.referenceToUrl(hub.reference);
          }
          break;
        }

        case 'source': {
          // Source - use source URL
          repositoryUrl = this.sourceToUrl(data);
          break;
        }

        case 'installed_bundle':
        case 'bundle':
        case 'profile_bundle': {
          // Bundle - find source and use its URL
          const sourceId = data?.sourceId;
          if (sourceId) {
            const sources = await this.registryManager.listSources();
            const source = sources.find((s) => s.id === sourceId);
            if (source) {
              repositoryUrl = this.sourceToUrl(source);
            }
          }
          // Fallback to bundle's own repository URL if available
          if (!repositoryUrl && data?.repository) {
            repositoryUrl = data.repository;
          }
          break;
        }

        default: {
          vscode.window.showWarningMessage(`Cannot open repository for item type: ${itemType}`);
          return;
        }
      }

      if (!repositoryUrl) {
        vscode.window.showInformationMessage(
          'This item is stored locally and does not have a remote repository URL.',
          'OK'
        );
        return;
      }

      await vscode.env.openExternal(vscode.Uri.parse(repositoryUrl));
      this.logger.info(`Opened repository: ${repositoryUrl}`);
    } catch (error) {
      this.logger.error('Failed to open repository', error as Error);
      vscode.window.showErrorMessage(`Failed to open repository: ${(error as Error).message}`);
    }
  }
}
