/**
 * Registry Explorer Webview View Provider
 * Renders the registry tree as a webview with Amadeus Design Factory styling
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  UpdateCheckResult,
} from '../services/update-cache';
import {
  Bundle,
  InstalledBundle,
  Profile,
  RegistrySource,
} from '../types/registry';
import {
  UI_CONSTANTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';

/**
 * Action button for a tree node
 */
interface TreeAction {
  command: string;
  icon: string;
  label: string;
  danger?: boolean;
}

/**
 * Tree node data sent to the webview
 */
interface TreeNodeData {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  command?: string;
  contextValue?: string;
  statusClass?: string;
  actions?: TreeAction[];
  children?: TreeNodeData[];
}

/**
 * Message types sent from webview to extension
 */
interface WebviewMessage {
  type: 'requestTreeData' | 'executeCommand' | 'contextMenu' | 'refresh';
  command?: string;
  nodeId?: string;
  contextValue?: string;
  x?: number;
  y?: number;
}

/**
 * Stored node data for command execution context
 */
interface NodeContextData {
  id: string;
  contextValue?: string;
  data?: any;
}

/**
 * Action definitions for each context value type
 */
const PROFILE_ACTIONS: TreeAction[] = [
  { command: 'promptRegistry.activateProfile', icon: 'codicon-play', label: 'Activate' },
  { command: 'promptRegistry.deactivateProfile', icon: 'codicon-circle-slash', label: 'Deactivate' },
  { command: 'promptRegistry.editProfile', icon: 'codicon-edit', label: 'Edit' },
  { command: 'promptRegistry.exportProfile', icon: 'codicon-export', label: 'Export' },
  { command: 'promptRegistry.deleteProfile', icon: 'codicon-trash', label: 'Delete', danger: true }
];

const HUB_PROFILE_ACTIONS: TreeAction[] = [
  { command: 'promptRegistry.activateProfile', icon: 'codicon-play', label: 'Activate' },
  { command: 'promptRegistry.deactivateProfile', icon: 'codicon-circle-slash', label: 'Deactivate' },
  { command: 'promptRegistry.editProfile', icon: 'codicon-edit', label: 'Edit' },
  { command: 'promptRegistry.exportProfile', icon: 'codicon-export', label: 'Export' },
  { command: 'promptRegistry.toggleProfileFavorite', icon: 'codicon-bookmark', label: 'Toggle Favorite' },
  { command: 'promptregistry.openItemRepository', icon: 'codicon-link-external', label: 'Open Repository' },
  { command: 'promptRegistry.deleteProfile', icon: 'codicon-trash', label: 'Delete', danger: true }
];

const HUB_ACTIONS: TreeAction[] = [
  { command: 'promptregistry.syncHub', icon: 'codicon-sync', label: 'Sync' },
  { command: 'promptregistry.openItemRepository', icon: 'codicon-link-external', label: 'Open Repository' },
  { command: 'promptregistry.deleteHub', icon: 'codicon-trash', label: 'Delete', danger: true }
];

const SOURCE_ACTIONS: TreeAction[] = [
  { command: 'promptRegistry.editSource', icon: 'codicon-edit', label: 'Edit' },
  { command: 'promptRegistry.syncSource', icon: 'codicon-sync', label: 'Sync' },
  { command: 'promptRegistry.toggleSource', icon: 'codicon-circle-slash', label: 'Toggle' },
  { command: 'promptRegistry.removeSource', icon: 'codicon-trash', label: 'Remove', danger: true }
];

export class RegistryExplorerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'promptRegistryExplorer';

  private _view?: vscode.WebviewView;
  private readonly logger: Logger;
  private sourceSyncDebounceTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private availableUpdates: Map<string, UpdateCheckResult> = new Map();
  private viewMode: 'all' | 'favorites' = 'all';
  private nodeDataMap: Map<string, NodeContextData> = new Map();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registryManager: RegistryManager,
    private readonly hubManager: HubManager
  ) {
    this.logger = Logger.getInstance();

    // Listen to registry events and refresh tree
    this.disposables.push(
      registryManager.onBundleInstalled(() => this.refresh()),
      registryManager.onBundleUninstalled(() => this.refresh()),
      registryManager.onBundleUpdated(() => this.refresh()),
      registryManager.onBundlesInstalled(() => this.refresh()),
      registryManager.onBundlesUninstalled(() => this.refresh()),

      // Profile events
      registryManager.onProfileActivated(() => this.refresh()),
      registryManager.onProfileDeactivated(() => this.refresh()),
      registryManager.onProfileCreated(() => this.refresh()),
      registryManager.onProfileUpdated(() => this.refresh()),
      registryManager.onProfileDeleted(() => this.refresh()),

      // Source events
      registryManager.onSourceAdded(() => this.refresh()),
      registryManager.onSourceRemoved(() => this.refresh()),
      registryManager.onSourceUpdated(() => this.refresh()),
      registryManager.onSourceSynced((event) => this.handleSourceSynced(event)),

      // Auto-update preference changes
      registryManager.onAutoUpdatePreferenceChanged(() => this.refresh()),

      // Repository bundle changes
      registryManager.onRepositoryBundlesChanged(() => this.refresh()),

      // Hub events
      hubManager.onHubImported(() => this.refresh()),
      hubManager.onHubDeleted(() => this.refresh()),
      hubManager.onHubSynced(() => this.refresh()),
      hubManager.onFavoritesChanged(() => this.refresh())
    );
  }

  /**
   * Recursively assign actions to tree nodes based on their contextValue
   */
  private assignActions(nodes: TreeNodeData[]): void {
    for (const node of nodes) {
      node.actions = this.getActionsForContext(node.contextValue);
      if (node.children) {
        this.assignActions(node.children);
      }
    }
  }

  /**
   * Populate the node data map for command execution context
   */
  private populateNodeDataMap(nodes: TreeNodeData[]): void {
    for (const node of nodes) {
      this.nodeDataMap.set(node.id, {
        id: node.id,
        contextValue: node.contextValue,
        data: this.extractNodeData(node)
      });
      if (node.children) {
        this.populateNodeDataMap(node.children);
      }
    }
  }

  /**
   * Extract data object from a tree node for command execution
   * Commands expect either a string ID or an object with { data: { id: ... } }
   */
  private extractNodeData(node: TreeNodeData): any {
    // Parse the node ID to determine the type and extract the relevant ID
    if (node.id.startsWith('installed-')) {
      const bundleId = node.id.replace('installed-', '');
      return { id: bundleId, bundleId };
    }
    if (node.id.startsWith('source-')) {
      const sourceId = node.id.replace('source-', '');
      return { id: sourceId };
    }
    if (node.id.startsWith('hub-')) {
      // Could be hub-{hubId} or hub-{hubId}-profile-{profileId}
      const rest = node.id.replace('hub-', '');
      if (rest.includes('-profile-')) {
        const [hubId, profileId] = rest.split('-profile-');
        return { id: profileId, hubId, profileId };
      }
      return { id: rest };
    }
    if (node.id.startsWith('local-profile-')) {
      return { id: node.id.replace('local-profile-', '') };
    }
    if (node.id.startsWith('active-')) {
      const rest = node.id.replace('active-', '');
      if (rest.startsWith('hub-')) {
        const hubProfile = rest.replace('hub-', '');
        const [hubId, profileId] = hubProfile.split('-');
        return { id: profileId, hubId, profileId };
      }
      return { id: rest.replace('profile-', '') };
    }
    if (node.id.startsWith('fav-')) {
      const rest = node.id.replace('fav-hub-', '');
      if (rest.includes('-profile-')) {
        const [hubId, profileId] = rest.split('-profile-');
        return { id: profileId, hubId, profileId };
      }
      return { id: rest };
    }
    return { id: node.id };
  }

  /**
   * Get actions for a given context value
   */
  private getActionsForContext(contextValue: string | undefined): TreeAction[] {
    if (!contextValue) { return []; }

    if (contextValue === 'profile' || contextValue === 'profile-active') {
      return PROFILE_ACTIONS;
    }
    if (contextValue === 'hub_profile') {
      return HUB_PROFILE_ACTIONS;
    }
    if (contextValue === 'hub') {
      return HUB_ACTIONS;
    }
    if (contextValue === 'source') {
      return SOURCE_ACTIONS;
    }
    if (contextValue && contextValue.startsWith('installed_bundle')) {
      const actions: TreeAction[] = [
        { command: 'promptRegistry.viewBundle', icon: 'codicon-eye', label: 'View' }
      ];

      if (contextValue.includes('updatable')) {
        actions.push({ command: 'promptRegistry.updateBundle', icon: 'codicon-sync', label: 'Update' });
      } else {
        actions.push({ command: 'promptRegistry.checkBundleUpdates', icon: 'codicon-search', label: 'Check Updates' });
      }

      if (contextValue.includes('auto_disabled')) {
        actions.push({ command: 'promptRegistry.enableAutoUpdate', icon: 'codicon-sync', label: 'Enable Auto-Update' });
      } else if (contextValue.includes('auto_enabled')) {
        actions.push({ command: 'promptRegistry.disableAutoUpdate', icon: 'codicon-stop', label: 'Disable Auto-Update' });
      }

      actions.push({ command: 'promptRegistry.uninstallBundle', icon: 'codicon-trash', label: 'Uninstall', danger: true });

      return actions;
    }

    return [];
  }

  /**
   * Handle source synced event with debouncing
   */
  private handleSourceSynced(event: { sourceId: string; bundleCount: number }): void {
    this.logger.debug(`Source synced: ${event.sourceId} (${event.bundleCount} bundles)`);
    if (this.sourceSyncDebounceTimer) {
      clearTimeout(this.sourceSyncDebounceTimer);
    }
    this.sourceSyncDebounceTimer = setTimeout(() => {
      this.logger.debug('Refreshing explorer view after source sync');
      this.refresh();
    }, UI_CONSTANTS.SOURCE_SYNC_DEBOUNCE_MS);
  }

  /**
   * Refresh the explorer view
   */
  public refresh(): void {
    if (this._view) {
      this._view.webview.postMessage({ type: 'refresh' });
    }
  }

  /**
   * Toggle view mode between all hubs and favorites
   */
  public toggleViewMode(): void {
    this.viewMode = this.viewMode === 'all' ? 'favorites' : 'all';
    vscode.commands.executeCommand('setContext', 'promptRegistry.favoritesViewActive', this.viewMode === 'favorites');
    this.refresh();
  }

  /**
   * Update tree view when updates are detected
   */
  public onUpdatesDetected(updates: UpdateCheckResult[]): void {
    this.logger.debug(`Updates detected for ${updates.length} bundles`);
    this.availableUpdates.clear();
    for (const update of updates) {
      this.availableUpdates.set(update.bundleId, update);
    }
    this.refresh();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    if (this.sourceSyncDebounceTimer) {
      clearTimeout(this.sourceSyncDebounceTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /**
   * Resolve the webview view
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'explorer'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts')
      ]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );
  }

  /**
   * Handle messages from the webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'requestTreeData': {
        const nodes = await this.buildTreeData();
        this._view?.webview.postMessage({ type: 'treeData', nodes });
        break;
      }
      case 'executeCommand': {
        if (message.command) {
          // Get stored node data to pass as command argument
          const nodeData = message.nodeId ? this.nodeDataMap.get(message.nodeId) : undefined;
          const commandArg = nodeData?.data ? { data: nodeData.data } : undefined;

          if (commandArg) {
            vscode.commands.executeCommand(message.command, commandArg);
          } else {
            vscode.commands.executeCommand(message.command);
          }
        }
        break;
      }
      case 'contextMenu': {
        // Delegate to VS Code's native context menu by showing a QuickPick
        await this.showContextMenu(message.nodeId || '', message.contextValue, message.x, message.y);
        break;
      }
      case 'refresh': {
        const nodes = await this.buildTreeData();
        this._view?.webview.postMessage({ type: 'treeData', nodes });
        break;
      }
    }
  }

  /**
   * Show context menu for a tree node
   */
  private async showContextMenu(nodeId: string, contextValue: string | undefined, _x?: number, _y?: number): Promise<void> {
    // Build context menu items based on contextValue
    const items: { label: string; command: string; danger?: boolean }[] = [];

    if (contextValue === 'profile' || contextValue === 'profile-active' || contextValue === 'hub_profile') {
      items.push({ label: 'Activate Profile', command: 'promptRegistry.activateProfile' });
      items.push({ label: 'Deactivate Profile', command: 'promptRegistry.deactivateProfile' });
      items.push({ label: 'Edit Profile', command: 'promptRegistry.editProfile' });
      items.push({ label: 'Export Profile', command: 'promptRegistry.exportProfile' });
      items.push({ label: 'Delete Profile', command: 'promptRegistry.deleteProfile', danger: true });
      if (contextValue === 'hub_profile') {
        items.push({ label: 'Toggle Favorite', command: 'promptRegistry.toggleProfileFavorite' });
        items.push({ label: 'Open Repository', command: 'promptregistry.openItemRepository' });
      }
    }

    if (contextValue && contextValue.startsWith('installed_bundle')) {
      items.push({ label: 'View Bundle', command: 'promptRegistry.viewBundle' });
      if (contextValue.includes('updatable')) {
        items.push({ label: 'Update Bundle', command: 'promptRegistry.updateBundle' });
      } else {
        items.push({ label: 'Check for Updates', command: 'promptRegistry.checkBundleUpdates' });
      }
      if (contextValue.includes('auto_disabled')) {
        items.push({ label: 'Enable Auto-Update', command: 'promptRegistry.enableAutoUpdate' });
      } else if (contextValue.includes('auto_enabled')) {
        items.push({ label: 'Disable Auto-Update', command: 'promptRegistry.disableAutoUpdate' });
      }
      items.push({ label: 'Uninstall Bundle', command: 'promptRegistry.uninstallBundle', danger: true });
    }

    if (contextValue === 'source') {
      items.push({ label: 'Edit Source', command: 'promptRegistry.editSource' });
      items.push({ label: 'Sync Source', command: 'promptRegistry.syncSource' });
      items.push({ label: 'Remove Source', command: 'promptRegistry.removeSource', danger: true });
      items.push({ label: 'Toggle Source', command: 'promptRegistry.toggleSource' });
    }

    if (contextValue === 'hub') {
      items.push({ label: 'Sync Hub', command: 'promptregistry.syncHub' });
      items.push({ label: 'Delete Hub', command: 'promptregistry.deleteHub', danger: true });
      items.push({ label: 'Open Repository', command: 'promptregistry.openItemRepository' });
    }

    if (items.length === 0) {
      return;
    }

    // Show as QuickPick since webview can't show native context menus
    const pickItems = items.map((item) => ({
      label: item.label,
      command: item.command,
      description: item.danger ? 'Warning' : ''
    }));

    const selected = await vscode.window.showQuickPick(pickItems, {
      placeHolder: 'Select an action'
    });

    if (selected && selected.command) {
      vscode.commands.executeCommand(selected.command);
    }
  }

  /**
   * Build tree data for the webview
   */
  private async buildTreeData(): Promise<TreeNodeData[]> {
    try {
      const nodes: TreeNodeData[] = [];

      // Shared Profiles / Favorites section
      const profileRootLabel = this.viewMode === 'all' ? 'Shared Profiles' : 'Favorites';
      const profileChildren = this.viewMode === 'all'
        ? await this.getHubsNodes()
        : await this.getFavoritesNodes();

      nodes.push({
        id: 'profiles-root',
        label: profileRootLabel,
        icon: 'codicon-organization',
        children: profileChildren
      });

      // Installed Bundles section
      const installedChildren = await this.getInstalledBundleNodes();
      nodes.push({
        id: 'installed-root',
        label: 'Installed Bundles',
        icon: 'codicon-archive',
        description: `${installedChildren.length}`,
        children: installedChildren
      });

      // Sources section
      const sourceChildren = await this.getSourceNodes();
      nodes.push({
        id: 'sources-root',
        label: 'Sources',
        icon: 'codicon-cloud',
        description: `${sourceChildren.length}`,
        children: sourceChildren
      });

      // Assign actions to all nodes based on contextValue
      this.assignActions(nodes);

      // Build node data map for command execution
      this.nodeDataMap.clear();
      this.populateNodeDataMap(nodes);

      return nodes;
    } catch (error) {
      this.logger.error('Failed to build explorer tree data', error as Error);
      return [];
    }
  }

  /**
   * Get hub nodes
   */
  private async getHubsNodes(): Promise<TreeNodeData[]> {
    try {
      const hubs = await this.hubManager.listHubs();
      const nodes: TreeNodeData[] = [];

      for (const hub of hubs) {
        const profiles = await this.hubManager.listProfilesFromHub(hub.id);
        const profileNodes: TreeNodeData[] = [];

        for (const profile of profiles) {
          const isFavorite = await this.isFavoriteProfile(hub.id, profile.id);
          const iconPrefix = profile.icon ? `${profile.icon} ` : '';
          const favoritePrefix = isFavorite ? '<span class="codicon codicon-bookmark"></span> ' : '';
          const label = `${iconPrefix}${favoritePrefix}${profile.name}`;

          profileNodes.push({
            id: `hub-${hub.id}-profile-${profile.id}`,
            label: label,
            icon: 'codicon-person',
            description: profile.active ? '[Active]' : undefined,
            command: 'promptRegistry.listProfiles',
            contextValue: 'hub_profile'
          });
        }

        nodes.push({
          id: `hub-${hub.id}`,
          label: hub.name,
          icon: 'codicon-organization',
          description: `${profiles.length} profiles`,
          contextValue: 'hub',
          children: profileNodes
        });
      }

      return nodes;
    } catch (error) {
      this.logger.error('Failed to get hub nodes', error as Error);
      return [];
    }
  }

  /**
   * Get favorites nodes
   */
  private async getFavoritesNodes(): Promise<TreeNodeData[]> {
    try {
      await this.hubManager.cleanupOrphanedFavorites();
      const favorites = await this.hubManager.getFavoriteProfiles();
      const nodes: TreeNodeData[] = [];

      // Active Profile section
      const activeProfileNode = await this.getActiveProfileNode();
      if (activeProfileNode) {
        nodes.push(activeProfileNode);
      }

      // Hub profiles grouped by hub
      for (const [hubId, profileIds] of Object.entries(favorites)) {
        if (!profileIds || profileIds.length === 0) { continue; }

        try {
          const hubInfo = await this.hubManager.getHubInfo(hubId);
          const profiles = await this.hubManager.listProfilesFromHub(hubId);
          const favoriteProfiles = profiles.filter((p) => profileIds.includes(p.id));

          const profileNodes: TreeNodeData[] = favoriteProfiles.map((profile) => {
            const iconPrefix = profile.icon ? `${profile.icon} ` : '';
            return {
              id: `fav-hub-${hubId}-profile-${profile.id}`,
              label: `${iconPrefix}${profile.name}`,
              icon: 'codicon-person',
              description: profile.active ? '[Active]' : undefined,
              command: 'promptRegistry.listProfiles',
              contextValue: 'hub_profile'
            };
          });

          nodes.push({
            id: `fav-hub-${hubId}`,
            label: hubInfo.config.metadata.name,
            icon: 'codicon-organization',
            description: `${profileIds.length} favorites`,
            contextValue: 'hub',
            children: profileNodes
          });
        } catch (error) {
          this.logger.warn(`Failed to load hub ${hubId} for favorites view`, error);
        }
      }

      // Local Profiles section
      try {
        const localProfiles = await this.registryManager.listLocalProfiles();
        if (localProfiles.length > 0) {
          const localNodes: TreeNodeData[] = localProfiles.map((profile) => ({
            id: `local-profile-${profile.id}`,
            label: profile.name,
            icon: 'codicon-person',
            description: profile.active ? '[Active]' : undefined,
            command: 'promptRegistry.listProfiles',
            contextValue: profile.active ? 'profile-active' : 'profile'
          }));

          nodes.push({
            id: 'local-profiles',
            label: 'Local Profiles',
            icon: 'codicon-folder',
            children: localNodes
          });
        }
      } catch (error) {
        this.logger.error('Failed to load local profiles for favorites view', error as Error);
      }

      // Create New Profile
      nodes.push({
        id: 'create-profile',
        label: 'Create New Profile...',
        icon: 'codicon-person-add',
        command: 'promptRegistry.createProfile'
      });

      return nodes;
    } catch (error) {
      this.logger.error('Failed to get favorites nodes', error as Error);
      return [];
    }
  }

  /**
   * Get active profile node
   */
  private async getActiveProfileNode(): Promise<TreeNodeData | undefined> {
    try {
      const localProfiles = await this.registryManager.listLocalProfiles();
      const activeLocalProfile = localProfiles.find((p) => p.active);

      if (activeLocalProfile) {
        return {
          id: 'active-profile-section',
          label: 'Active Profile',
          icon: 'codicon-check',
          children: [{
            id: `active-${activeLocalProfile.id}`,
            label: activeLocalProfile.name,
            icon: 'codicon-person',
            description: '[Active]',
            command: 'promptRegistry.listProfiles',
            contextValue: 'profile-active'
          }]
        };
      }

      const activeHubProfiles = await this.hubManager.listAllActiveProfiles();
      const activeHubProfile = activeHubProfiles?.[0];

      if (activeHubProfile) {
        const profile = await this.hubManager.getHubProfile(activeHubProfile.hubId, activeHubProfile.profileId);
        const iconPrefix = profile.icon ? `${profile.icon} ` : '';

        return {
          id: 'active-profile-section',
          label: 'Active Profile',
          icon: 'codicon-check',
          children: [{
            id: `active-hub-${activeHubProfile.hubId}-${activeHubProfile.profileId}`,
            label: `${iconPrefix}${profile.name}`,
            icon: 'codicon-person',
            description: '[Active]',
            command: 'promptRegistry.listProfiles',
            contextValue: 'hub_profile'
          }]
        };
      }

      return {
        id: 'active-profile-section',
        label: 'Active Profile',
        icon: 'codicon-check',
        children: [{
          id: 'active-profile-none',
          label: 'None',
          icon: ''
        }]
      };
    } catch (error) {
      this.logger.error('Failed to get active profile node', error as Error);
      return undefined;
    }
  }

  /**
   * Check if a profile is a favorite
   */
  private async isFavoriteProfile(hubId: string, profileId: string): Promise<boolean> {
    try {
      const favorites = await this.hubManager.getFavoriteProfiles();
      const hubFavorites = favorites[hubId] || [];
      return hubFavorites.includes(profileId);
    } catch {
      return false;
    }
  }

  /**
   * Get installed bundle nodes
   */
  private async getInstalledBundleNodes(): Promise<TreeNodeData[]> {
    try {
      const installed = await this.registryManager.listInstalledBundles();
      const nodes: TreeNodeData[] = [];

      const autoUpdateService = this.registryManager.autoUpdateService;
      const autoUpdatePreferences = autoUpdateService
        ? await autoUpdateService.getAllAutoUpdatePreferences()
        : {};

      for (const bundle of installed) {
        try {
          const details = await this.registryManager.getBundleDetails(bundle.bundleId);
          const updateInfo = this.availableUpdates.get(bundle.bundleId);
          const hasUpdate = updateInfo !== undefined;
          const autoUpdateEnabled = autoUpdatePreferences[bundle.bundleId] ?? false;

let iconName = 'codicon-check';
        let statusClass = 'status-installed';

        if (bundle.filesMissing) {
          iconName = 'codicon-warning';
          statusClass = 'status-warning';
        } else if (hasUpdate) {
          iconName = 'codicon-sync';
          statusClass = 'status-update';
        } else if (autoUpdateEnabled) {
          iconName = 'codicon-check';
            statusClass = 'status-auto-update';
          }

          const versionDisplay = updateInfo
            ? `v${bundle.version} → v${updateInfo.latestVersion}`
            : `v${bundle.version}`;

          let contextValue: string;
          if (bundle.filesMissing) {
            contextValue = 'installedBundle.filesMissing';
          } else if (hasUpdate && autoUpdateEnabled) {
            contextValue = 'installed_bundle_updatable_auto_enabled';
          } else if (hasUpdate && !autoUpdateEnabled) {
            contextValue = 'installed_bundle_updatable_auto_disabled';
          } else if (!hasUpdate && autoUpdateEnabled) {
            contextValue = 'installed_bundle_auto_enabled';
          } else {
            contextValue = 'installed_bundle_auto_disabled';
          }

          // Add scope suffix
          const scope = bundle.scope || 'user';
          if (scope === 'repository') {
            const commitMode = bundle.commitMode || 'commit';
            const commitModeSuffix = commitMode === 'local-only' ? 'local_only' : commitMode;
            contextValue = `${contextValue}_repository_${commitModeSuffix}`;
          } else {
            contextValue = `${contextValue}_${scope}`;
          }

          nodes.push({
            id: `installed-${bundle.bundleId}`,
            label: details.name,
            icon: iconName,
            description: versionDisplay,
            command: 'promptRegistry.viewBundle',
            contextValue,
            statusClass
          });
        } catch (error) {
          this.logger.debug(`Could not get details for bundle '${bundle.bundleId}'`, error);
          nodes.push({
            id: `installed-${bundle.bundleId}`,
            label: `${bundle.bundleId}`,
            icon: 'codicon-check',
            description: `v${bundle.version}`,
            command: 'promptRegistry.viewBundle',
            contextValue: 'installed_bundle_auto_disabled_user',
            statusClass: 'status-installed'
          });
        }
      }

      return nodes;
    } catch (error) {
      this.logger.error('Failed to load installed bundles', error as Error);
      return [];
    }
  }

  /**
   * Get source nodes
   */
  private async getSourceNodes(): Promise<TreeNodeData[]> {
    try {
      const sources = await this.registryManager.listSources();
      const nodes: TreeNodeData[] = sources.map((source) => ({
        id: `source-${source.id}`,
        label: source.name,
        icon: 'codicon-database',
        description: `priority: ${source.priority}`,
        command: 'promptRegistry.listSources',
        contextValue: 'source'
      }));

      nodes.push({
        id: 'add-source',
        label: 'Add Source...',
        icon: 'codicon-add',
        command: 'promptRegistry.addSource'
      });

      return nodes;
    } catch (error) {
      this.logger.error('Failed to load sources', error as Error);
      return [];
    }
  }

  /**
   * Get HTML content for the webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'explorer', 'explorer.css')
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts', 'codicon.css')
    );
    const codiconTtfUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts', 'codicon.ttf')
    );
    const iconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'fonts', 'icons.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'explorer', 'explorer.js')
    );

    const nonce = this.getNonce();
    const cspSource = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;

    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'explorer',
      'explorer.html'
    );
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

    html = html
      .replace('{{cssUri}}', cssUri.toString())
      .replace('{{codiconsUri}}', codiconsUri.toString())
      .replace('{{codiconTtfUri}}', codiconTtfUri.toString())
      .replace('{{iconsUri}}', iconsUri.toString())
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace('{{cspSource}}', cspSource)
      .replace('{{scriptUri}}', scriptUri.toString());

    return html;
  }

  /**
   * Generate a nonce for Content Security Policy
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}