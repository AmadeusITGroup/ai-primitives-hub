/**
 * Tree View Provider for AI Primitives Hub Explorer
 * Displays sources, profiles, bundles, and discovery options in sidebar
 */

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
 * Tree item types
 */
export enum TreeItemType {
  // Root sections
  PROFILES_ROOT = 'profiles_root',
  HUBS_ROOT = 'hubs_root',
  FAVORITES_ROOT = 'favorites_root',
  INSTALLED_ROOT = 'installed_root',
  DISCOVER_ROOT = 'discover_root',
  SOURCES_ROOT = 'sources_root', // Profile items
  PROFILE = 'profile',
  PROFILE_BUNDLE = 'profile_bundle',
  CREATE_PROFILE = 'create_profile',

  // Installed items
  INSTALLED_BUNDLE = 'installed_bundle',

  // Discover items
  DISCOVER_CATEGORY = 'discover_category',
  DISCOVER_POPULAR = 'discover_popular',
  DISCOVER_RECENT = 'discover_recent',
  DISCOVER_TRENDING = 'discover_trending',

  // Source items
  SOURCE = 'source',
  ADD_SOURCE = 'add_source',

  // Bundle items
  BUNDLE = 'bundle',

  // Hub items
  IMPORT_HUB = 'import_hub',
  LIST_HUB = 'list_hub',
  HUB = 'hub',
  HUB_PROFILE = 'hub_profile',
  PROFILE_FOLDER = 'profile_folder',
  LOCAL_PROFILES_FOLDER = 'local_profiles_folder',

  ACTIVE_PROFILE_SECTION = 'active_profile_section',
  ACTIVE_PROFILE_NONE = 'active_profile_none'
}

/**
 * Registry tree item
 */
export class RegistryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly type: TreeItemType,
    public readonly data?: any,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);

    this.contextValue = type;
    this.iconPath = this.getIcon();
    this.tooltip = this.getTooltip();
    this.description = this.getDescription();

    // Set command for clickable items
    if (this.isClickable()) {
      this.command = {
        command: this.getCommand(),
        title: `View ${label}`,
        arguments: [this]
      };
    }
  }

  /**
   * Get icon for tree item
   */
  private getIcon(): vscode.ThemeIcon | undefined {
    // For profiles with custom icons, don't show ThemeIcon (emoji is in label)
    if ((this.type === TreeItemType.HUB_PROFILE || this.type === TreeItemType.PROFILE) && this.data?.icon) {
      return undefined;
    }

    const iconMap: { [key in TreeItemType]?: string } = {
      [TreeItemType.PROFILES_ROOT]: 'home',
      [TreeItemType.HUBS_ROOT]: 'globe',
      [TreeItemType.FAVORITES_ROOT]: 'star-full',
      [TreeItemType.PROFILE]: 'symbol-misc',
      [TreeItemType.HUB_PROFILE]: 'symbol-misc',
      [TreeItemType.PROFILE_FOLDER]: 'folder',

      [TreeItemType.INSTALLED_ROOT]: 'package',
      [TreeItemType.INSTALLED_BUNDLE]: 'check',

      [TreeItemType.DISCOVER_ROOT]: 'search',
      [TreeItemType.DISCOVER_CATEGORY]: 'tag',
      [TreeItemType.DISCOVER_POPULAR]: 'star',
      [TreeItemType.DISCOVER_RECENT]: 'clock',
      [TreeItemType.DISCOVER_TRENDING]: 'flame',

      [TreeItemType.SOURCES_ROOT]: 'radio-tower',
      [TreeItemType.SOURCE]: 'repo',
      [TreeItemType.BUNDLE]: 'file-zip'
    };

    const iconId = iconMap[this.type];
    return iconId ? new vscode.ThemeIcon(iconId) : undefined;
  }

  /**
   * Get tooltip text
   */
  private getTooltip(): string {
    switch (this.type) {
      case TreeItemType.PROFILE:
      case TreeItemType.HUB_PROFILE: {
        const profile = this.data as Profile;
        return `${profile.description}\n${profile.bundles.length} bundles`;
      }

      case TreeItemType.INSTALLED_BUNDLE: {
        const installed = this.data as InstalledBundle;
        return `Version ${installed.version}\nInstalled: ${new Date(installed.installedAt).toLocaleDateString()}`;
      }

      case TreeItemType.SOURCE: {
        const source = this.data as RegistrySource;
        return `${source.url}\n${source.enabled ? 'Enabled' : 'Disabled'}`;
      }

      case TreeItemType.BUNDLE: {
        const bundle = this.data as Bundle;
        return `${bundle.description}\nVersion: ${bundle.version}`;
      }

      default: {
        return this.label;
      }
    }
  }

  /**
   * Get description text (shown right-aligned)
   */
  private getDescription(): string | undefined {
    switch (this.type) {
      case TreeItemType.PROFILE:
      case TreeItemType.HUB_PROFILE: {
        const profile = this.data as Profile;
        return profile.active ? '[Active]' : '';
      }

      case TreeItemType.INSTALLED_BUNDLE: {
        const installed = this.data as InstalledBundle;
        return `v${installed.version}`;
      }

      case TreeItemType.SOURCE: {
        const source = this.data as RegistrySource;
        return `priority: ${source.priority}`;
      }

      case TreeItemType.BUNDLE: {
        const bundle = this.data as Bundle;
        return bundle.version;
      }

      default: {
        return undefined;
      }
    }
  }

  /**
   * Check if item is clickable
   */
  private isClickable(): boolean {
    return [
      TreeItemType.BUNDLE,
      TreeItemType.INSTALLED_BUNDLE,
      TreeItemType.PROFILE,
      TreeItemType.SOURCE,
      TreeItemType.CREATE_PROFILE,
      TreeItemType.ADD_SOURCE,
      TreeItemType.DISCOVER_CATEGORY,
      TreeItemType.DISCOVER_POPULAR,
      TreeItemType.DISCOVER_RECENT,
      TreeItemType.DISCOVER_TRENDING,
      TreeItemType.INSTALLED_ROOT
    ].includes(this.type);
  }

  /**
   * Get command for item
   */
  private getCommand(): string {
    switch (this.type) {
      case TreeItemType.BUNDLE: {
        return 'promptRegistry.viewBundle';
      }
      case TreeItemType.INSTALLED_BUNDLE: {
        return 'promptRegistry.viewBundle';
      }
      case TreeItemType.PROFILE: {
        return 'promptRegistry.listProfiles';
      }
      case TreeItemType.SOURCE: {
        return 'promptRegistry.listSources';
      }
      case TreeItemType.CREATE_PROFILE: {
        return 'promptRegistry.createProfile';
      }
      case TreeItemType.ADD_SOURCE: {
        return 'promptRegistry.addSource';
      }
      case TreeItemType.IMPORT_HUB: {
        return 'promptRegistry.importHub';
      }
      case TreeItemType.LIST_HUB: {
        return 'promptRegistry.listHubs';
      }
      case TreeItemType.DISCOVER_CATEGORY: {
        return 'promptRegistry.browseByCategory';
      }
      case TreeItemType.DISCOVER_POPULAR: {
        return 'promptRegistry.showPopular';
      }
      case TreeItemType.DISCOVER_RECENT: {
        return 'promptRegistry.searchBundles';
      }
      case TreeItemType.DISCOVER_TRENDING: {
        return 'promptRegistry.showPopular';
      }
      case TreeItemType.INSTALLED_ROOT: {
        return 'promptRegistry.listInstalled';
      }
      default: {
        return '';
      }
    }
  }
}

/**
 * Registry Tree Data Provider
 */
export class RegistryTreeProvider implements vscode.TreeDataProvider<RegistryTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RegistryTreeItem | undefined | null>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly logger: Logger;
  private readonly availableUpdates: Map<string, UpdateCheckResult> = new Map();
  private sourceSyncDebounceTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  private viewMode: 'all' | 'favorites' = 'all';

  constructor(
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

      // Repository bundle changes (workspace folder changes)
      registryManager.onRepositoryBundlesChanged(() => this.refresh()),

      // Hub events
      hubManager.onHubImported(() => this.refresh()),
      hubManager.onHubDeleted(() => this.refresh()),
      hubManager.onHubSynced(() => this.refresh()),
      hubManager.onFavoritesChanged(() => this.refresh())
    );
  }

  /**
   * Handle source synced event with debouncing
   * Debounces refresh calls to prevent excessive updates when multiple sources sync
   * @param event
   * @param event.sourceId
   * @param event.bundleCount
   */
  private handleSourceSynced(event: { sourceId: string; bundleCount: number }): void {
    this.logger.debug(`Source synced: ${event.sourceId} (${event.bundleCount} bundles)`);

    // Clear existing timer
    if (this.sourceSyncDebounceTimer) {
      clearTimeout(this.sourceSyncDebounceTimer);
    }

    // Set new timer with shared debounce delay
    this.sourceSyncDebounceTimer = setTimeout(() => {
      this.logger.debug('Refreshing tree view after source sync');
      this.refresh();
    }, UI_CONSTANTS.SOURCE_SYNC_DEBOUNCE_MS);
  }

  /**
   * Check if a bundle has an available update
   * @param bundleId
   */
  private hasUpdate(bundleId: string): boolean {
    return this.availableUpdates.has(bundleId);
  }

  /**
   * Get update information for a bundle
   * @param bundleId
   */
  private getUpdateInfo(bundleId: string): UpdateCheckResult | undefined {
    return this.availableUpdates.get(bundleId);
  }

  /**
   * Map bundle update/auto-update state to tree icon prefix and context value
   * @param hasUpdate - Whether an update is available
   * @param autoUpdateEnabled - Whether auto-update is enabled
   * @param filesMissing - Whether bundle files are missing (repository scope only)
   */
  private getBundleStatusPresentation(hasUpdate: boolean, autoUpdateEnabled: boolean, filesMissing?: boolean): {
    prefix: string;
    contextValue: string;
  } {
    let prefix = '✓';

    // Files missing takes precedence for visual indicator
    if (filesMissing) {
      prefix = '⚠️';
    } else if (hasUpdate) {
      prefix = '⬆️';
    } else if (autoUpdateEnabled) {
      prefix = '🔄';
    }

    let contextValue: string;
    // Files missing gets its own context value for special menu handling
    if (filesMissing) {
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

    return { prefix, contextValue };
  }

  /**
   * Set version display for tree item with update information
   * Shows both installed and available versions when update exists
   * @param treeItem
   * @param bundleId
   * @param currentVersion
   */
  private setVersionDisplay(treeItem: RegistryTreeItem, bundleId: string, currentVersion: string): void {
    const updateInfo = this.getUpdateInfo(bundleId);

    treeItem.description = updateInfo
      ? `v${currentVersion} → v${updateInfo.latestVersion}`
      : `v${currentVersion}`;
  }

  /**
   * Get context value for menu actions
   *
   * Returns the context value with scope information to match package.json 'when' clauses.
   * Format: {baseContextValue}_{scope}[_{commitMode}]
   *
   * Examples:
   * - installed_bundle_auto_disabled_user
   * - installed_bundle_auto_disabled_repository_commit
   * - installed_bundle_auto_disabled_repository_local_only
   * @param baseContextValue - The base context value (e.g., 'installed_bundle_auto_disabled')
   * @param bundle - The installed bundle with scope information
   */
  private getContextValue(baseContextValue: string, bundle?: InstalledBundle): string {
    if (!bundle) {
      return baseContextValue;
    }

    const scope = bundle.scope || 'user';
    if (scope === 'repository') {
      const commitMode = bundle.commitMode || 'commit';
      // Convert 'local-only' to 'local_only' for valid context value
      const commitModeSuffix = commitMode === 'local-only' ? 'local_only' : commitMode;
      return `${baseContextValue}_repository_${commitModeSuffix}`;
    }

    return `${baseContextValue}_${scope}`;
  }

  /**
   * Get root level items
   */
  private getRootItems(): RegistryTreeItem[] {
    const profileRootLabel = this.viewMode === 'all' ? 'Shared Profiles' : 'Favorites';
    const profileRootType = this.viewMode === 'all' ? TreeItemType.HUBS_ROOT : TreeItemType.FAVORITES_ROOT;

    return [
      new RegistryTreeItem(
        profileRootLabel,
        profileRootType,
        undefined,
        vscode.TreeItemCollapsibleState.Expanded
      ),
      new RegistryTreeItem(
        'Installed Bundles',
        TreeItemType.INSTALLED_ROOT,
        undefined,
        vscode.TreeItemCollapsibleState.Expanded
      ),
      new RegistryTreeItem(
        'Sources',
        TreeItemType.SOURCES_ROOT,
        undefined,
        vscode.TreeItemCollapsibleState.Collapsed
      )
    ];
  }

  /**
   * Get hub items
   */
  private async getHubsItems(): Promise<RegistryTreeItem[]> {
    const hubs = await this.hubManager.listHubs();
    return hubs.map((hub) => new RegistryTreeItem(
      hub.name,
      TreeItemType.HUB,
      hub,
      vscode.TreeItemCollapsibleState.Collapsed
    ));
  }

  /**
   * Get favorite profile items
   */
  private async getFavoritesItems(): Promise<RegistryTreeItem[]> {
    // Cleanup orphaned favorites (from previously deleted hubs)
    await this.hubManager.cleanupOrphanedFavorites();

    const favorites = await this.hubManager.getFavoriteProfiles();
    const items: RegistryTreeItem[] = [];
    const addedProfileIds = new Set<string>();

    items.push(
      new RegistryTreeItem(
        'Active Profile',
        TreeItemType.ACTIVE_PROFILE_SECTION,
        undefined,
        vscode.TreeItemCollapsibleState.Expanded
      )
    );

    // 1. Add favorited hub profiles, grouped by Hub
    for (const [hubId, profileIds] of Object.entries(favorites)) {
      if (!profileIds || profileIds.length === 0) {
        continue;
      }

      try {
        // Get Hub Info to display as a root folder
        const hubInfo = await this.hubManager.getHubInfo(hubId);

        // Create a Hub item that will act as a folder
        const hubItem = new RegistryTreeItem(
          hubInfo.config.metadata.name,
          TreeItemType.HUB,
          { id: hubId, name: hubInfo.config.metadata.name }, // Pass minimal hub data needed
          vscode.TreeItemCollapsibleState.Expanded // Expand by default to show favorites
        );

        items.push(hubItem);

        // Mark these profiles as added so we don't duplicate them if logic changes
        profileIds.forEach((id) => addedProfileIds.add(id));
      } catch (error) {
        // Hub might be missing or fail to load
        this.logger.warn(`Failed to load hub ${hubId} for favorites view`, error);
      }
    }

    // 2. Add "Local Profiles" section (only truly local profiles, not hub profiles)
    try {
      const localProfiles = await this.registryManager.listLocalProfiles();
      if (localProfiles.length > 0) {
        const localProfilesItem = new RegistryTreeItem(
          'Local Profiles',
          TreeItemType.LOCAL_PROFILES_FOLDER,
          { isLocalProfilesFolder: true },
          vscode.TreeItemCollapsibleState.Expanded
        );
        items.push(localProfilesItem);
      }
    } catch (error) {
      this.logger.error('Failed to load local profiles for favorites view', error as Error);
    }

    // 3. Add "Create New Profile" item
    items.push(
      new RegistryTreeItem(
        '➕ Create New Profile...',
        TreeItemType.CREATE_PROFILE,
        undefined,
        vscode.TreeItemCollapsibleState.None
      )
    );

    return items;
  }

  private async getActiveProfileItems(): Promise<RegistryTreeItem[]> {
    try {
      const localProfiles = await this.registryManager.listLocalProfiles();
      const activeLocalProfile = localProfiles.find((p) => p.active);

      if (activeLocalProfile) {
        const treeItem = new RegistryTreeItem(
          activeLocalProfile.name,
          TreeItemType.PROFILE,
          activeLocalProfile,
          vscode.TreeItemCollapsibleState.Collapsed
        );

        treeItem.contextValue = 'profile-active';
        treeItem.description = '[Active]';

        return [treeItem];
      }
    } catch (error) {
      this.logger.error('Failed to load local profiles for active profile section', error as Error);
    }

    try {
      const activeHubProfiles = await this.hubManager.listAllActiveProfiles();
      const activeHubProfile = activeHubProfiles?.[0];

      if (activeHubProfile) {
        const profile = await this.hubManager.getHubProfile(activeHubProfile.hubId, activeHubProfile.profileId);
        const iconPrefix = profile.icon ? `${profile.icon} ` : '';
        const label = `${iconPrefix}${profile.name}`;

        const treeItem = new RegistryTreeItem(
          label,
          TreeItemType.HUB_PROFILE,
          { ...profile, hubId: activeHubProfile.hubId, active: true },
          vscode.TreeItemCollapsibleState.Collapsed
        );

        treeItem.description = '[Active]';

        return [treeItem];
      }
    } catch (error) {
      this.logger.error('Failed to load hub profiles for active profile section', error as Error);
    }

    return [
      new RegistryTreeItem(
        'None',
        TreeItemType.ACTIVE_PROFILE_NONE,
        undefined,
        vscode.TreeItemCollapsibleState.None
      )
    ];
  }

  /**
   * Get children for a hub
   * @param hub
   */
  private async getHubChildren(hub: any): Promise<RegistryTreeItem[]> {
    const profiles = await this.hubManager.listProfilesFromHub(hub.id);
    const favoriteProfiles = await this.hubManager.getFavoriteProfiles() || {};
    const hubFavorites = favoriteProfiles[hub.id] || [];

    return this.organizeProfiles(hub.id, profiles, [], hubFavorites);
  }

  /**
   * Get children for a folder
   * @param folder
   */
  private async getFolderChildren(folder: any): Promise<RegistryTreeItem[]> {
    const profiles = await this.hubManager.listProfilesFromHub(folder.hubId);
    const favoriteProfiles = await this.hubManager.getFavoriteProfiles() || {};
    const hubFavorites = favoriteProfiles[folder.hubId] || [];

    // Filter profiles if in favorites view
    let profilesToOrganize = profiles;
    if (this.viewMode === 'favorites') {
      profilesToOrganize = profiles.filter((p) => hubFavorites.includes(p.id));
    }

    return this.organizeProfiles(folder.hubId, profilesToOrganize, folder.path, hubFavorites);
  }

  /**
   * Organize profiles into files and folders
   * @param hubId
   * @param profiles
   * @param currentPath
   * @param favorites
   */
  private organizeProfiles(hubId: string, profiles: any[], currentPath: string[], favorites: string[] = []): RegistryTreeItem[] {
    const items: RegistryTreeItem[] = [];
    const folders = new Set<string>();

    for (const profile of profiles) {
      const profilePath = profile.path || [];

      // Check if profile is inside currentPath
      if (profilePath.length < currentPath.length) {
        continue;
      }

      let isInside = true;
      for (const [i, element] of currentPath.entries()) {
        if (profilePath[i] !== element) {
          isInside = false;
          break;
        }
      }
      if (!isInside) {
        continue;
      }

      // Determine if direct child or in subfolder
      if (profilePath.length === currentPath.length) {
        // Direct child profile
        const isFavorite = favorites.includes(profile.id);
        // Build label: profile icon (if any) + star (if favorite) + name
        const iconPrefix = profile.icon ? `${profile.icon} ` : '';
        const favoritePrefix = isFavorite ? '⭐ ' : '';
        const label = `${iconPrefix}${favoritePrefix}${profile.name}`;

        const treeItem = new RegistryTreeItem(
          label,
          TreeItemType.HUB_PROFILE,
          { ...profile, hubId },
          vscode.TreeItemCollapsibleState.Collapsed
        );

        if (profile.active) {
          treeItem.description = '[Active]';
        }

        items.push(treeItem);
      } else {
        // In subfolder - get the next segment
        const folderName = profilePath[currentPath.length];
        folders.add(folderName);
      }
    }

    // Add folders
    for (const folderName of folders) {
      items.push(new RegistryTreeItem(
        folderName,
        TreeItemType.PROFILE_FOLDER,
        {
          hubId,
          path: [...currentPath, folderName],
          name: folderName
        },
        vscode.TreeItemCollapsibleState.Collapsed
      ));
    }

    return items;
  }

  /**
   * Get local profile items (for Local Profiles folder in Favorites view)
   */
  private async getLocalProfileItems(): Promise<RegistryTreeItem[]> {
    const items: RegistryTreeItem[] = [];
    try {
      // Use listLocalProfiles to get only truly local profiles, not hub profiles
      const profiles = await this.registryManager.listLocalProfiles();
      for (const profile of profiles) {
        const treeItem = new RegistryTreeItem(
          profile.name,
          TreeItemType.PROFILE,
          profile,
          vscode.TreeItemCollapsibleState.Collapsed
        );

        if (profile.active) {
          treeItem.contextValue = 'profile-active';
          treeItem.description = '[Active]';
        }

        items.push(treeItem);
      }
    } catch (error) {
      this.logger.error('Failed to load local profiles', error as Error);
    }
    return items;
  }

  /**
   * Get profile items
   */
  private async getProfileItems(): Promise<RegistryTreeItem[]> {
    try {
      const profiles = await this.registryManager.listProfiles();
      const items: RegistryTreeItem[] = [];

      for (const profile of profiles) {
        const treeItem = new RegistryTreeItem(
          profile.name,
          TreeItemType.PROFILE,
          profile,
          vscode.TreeItemCollapsibleState.Collapsed
        );

        // Set contextValue based on active state
        if (profile.active) {
          treeItem.contextValue = 'profile-active';
        }

        items.push(treeItem);
      }

      // Add "Create New Profile" item
      items.push(
        new RegistryTreeItem(
          '➕ Create New Profile...',
          TreeItemType.CREATE_PROFILE,
          undefined,
          vscode.TreeItemCollapsibleState.None
        )
      );

      return items;
    } catch (error) {
      this.logger.error('Failed to load profiles', error as Error);
      return [];
    }
  }

  /**
   * Get bundles for a profile
   * @param profile
   */
  private async getProfileBundleItems(profile: Profile): Promise<RegistryTreeItem[]> {
    const items: RegistryTreeItem[] = [];

    for (const profileBundle of profile.bundles) {
      try {
        const bundle = await this.registryManager.getBundleDetails(profileBundle.id);
        // const status = profileBundle.required ? '✓' : '○'; // Unused

        items.push(
          new RegistryTreeItem(
            bundle.name,
            TreeItemType.PROFILE_BUNDLE,
            { profile, bundle, profileBundle },
            vscode.TreeItemCollapsibleState.None
          )
        );
      } catch (error) {
        // Bundle not found in registry - display with warning
        this.logger.debug(`Bundle '${profileBundle.id}' not found in registry`, error);
        items.push(
          new RegistryTreeItem(
            `${profileBundle.id} (not found)`,
            TreeItemType.PROFILE_BUNDLE,
            profileBundle,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }
    }

    return items;
  }

  /**
   * Get installed bundle items
   */
  private async getInstalledBundleItems(): Promise<RegistryTreeItem[]> {
    try {
      const installed = await this.registryManager.listInstalledBundles();
      const items: RegistryTreeItem[] = [];

      // Get auto-update service to check auto-update status
      const autoUpdateService = this.registryManager.autoUpdateService;

      // Preload auto-update preferences once per refresh
      const autoUpdatePreferences = autoUpdateService
        ? await autoUpdateService.getAllAutoUpdatePreferences()
        : {};

      for (const bundle of installed) {
        try {
          const details = await this.registryManager.getBundleDetails(bundle.bundleId);

          // Check if update available from our tracked updates
          const updateInfo = this.getUpdateInfo(bundle.bundleId);
          const hasUpdate = updateInfo !== undefined;

          // Resolve auto-update state from preloaded preferences
          const autoUpdateEnabled = autoUpdatePreferences[bundle.bundleId] ?? false;

          const { prefix, contextValue } = this.getBundleStatusPresentation(
            hasUpdate,
            autoUpdateEnabled,
            bundle.filesMissing
          );

          const treeItem = new RegistryTreeItem(
            `${prefix} ${details.name}`,
            TreeItemType.INSTALLED_BUNDLE,
            bundle,
            vscode.TreeItemCollapsibleState.None
          );

          // Set version display with update information
          this.setVersionDisplay(treeItem, bundle.bundleId, bundle.version);

          // Set context value to enable/disable update menu option and auto-update toggle
          treeItem.contextValue = this.getContextValue(contextValue, bundle);

          // Set warning tooltip and icon when files are missing
          if (bundle.filesMissing) {
            treeItem.tooltip = `${details.name} - Files missing from repository`;
            treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          }

          items.push(treeItem);
        } catch (error) {
          // Bundle details not available - fall back to ID display
          this.logger.debug(`Could not get details for bundle '${bundle.bundleId}'`, error);
          const updateInfo = this.getUpdateInfo(bundle.bundleId);
          const hasUpdate = updateInfo !== undefined;

          const autoUpdateEnabled = autoUpdatePreferences[bundle.bundleId] ?? false;

          const { prefix, contextValue } = this.getBundleStatusPresentation(
            hasUpdate,
            autoUpdateEnabled,
            bundle.filesMissing
          );

          const treeItem = new RegistryTreeItem(
            `${prefix} ${bundle.bundleId}`,
            TreeItemType.INSTALLED_BUNDLE,
            bundle,
            vscode.TreeItemCollapsibleState.None
          );

          // Set version display with update information
          this.setVersionDisplay(treeItem, bundle.bundleId, bundle.version);

          // Set context value for menu actions
          treeItem.contextValue = this.getContextValue(contextValue, bundle);

          // Set warning tooltip and icon when files are missing
          if (bundle.filesMissing) {
            treeItem.tooltip = `${bundle.bundleId} - Files missing from repository`;
            treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          }

          items.push(treeItem);
        }
      }
      return items;
    } catch (error) {
      this.logger.error('Failed to load installed bundles', error as Error);
      return [];
    }
  }

  /**
   * Get discover section items
   */
  private getDiscoverItems(): RegistryTreeItem[] {
    return [
      new RegistryTreeItem(
        '🏷️  By Category',
        TreeItemType.DISCOVER_CATEGORY,
        undefined,
        vscode.TreeItemCollapsibleState.Collapsed
      ),
      new RegistryTreeItem(
        '⭐ Popular',
        TreeItemType.DISCOVER_POPULAR,
        undefined,
        vscode.TreeItemCollapsibleState.Collapsed
      ),
      new RegistryTreeItem(
        '🆕 Recently Added',
        TreeItemType.DISCOVER_RECENT,
        undefined,
        vscode.TreeItemCollapsibleState.Collapsed
      ),
      new RegistryTreeItem(
        '🔥 Trending',
        TreeItemType.DISCOVER_TRENDING,
        undefined,
        vscode.TreeItemCollapsibleState.Collapsed
      )
    ];
  }

  /**
   * Get bundles by category
   * @param _category
   */
  private async getCategoryBundles(_category: string): Promise<RegistryTreeItem[]> {
    // TODO: Implement category filtering
    // For now, return empty
    return [];
  }

  /**
   * Get source items
   */
  private async getSourceItems(): Promise<RegistryTreeItem[]> {
    try {
      const sources = await this.registryManager.listSources();
      const items: RegistryTreeItem[] = [];

      for (const source of sources) {
        items.push(
          new RegistryTreeItem(
            source.name,
            TreeItemType.SOURCE,
            source,
            vscode.TreeItemCollapsibleState.None
          )
        );
      }

      // Add "Add Source" item
      items.push(
        new RegistryTreeItem(
          '➕ Add Source...',
          TreeItemType.ADD_SOURCE,
          undefined,
          vscode.TreeItemCollapsibleState.None
        )
      );

      return items;
    } catch (error) {
      this.logger.error('Failed to load sources', error as Error);
      return [];
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
   * Refresh tree view
   */
  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    // Clear debounce timer
    if (this.sourceSyncDebounceTimer) {
      clearTimeout(this.sourceSyncDebounceTimer);
    }

    // Dispose all event listeners
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /**
   * Update tree view when updates are detected
   * Stores update information and refreshes the tree
   * @param updates
   */
  public onUpdatesDetected(updates: UpdateCheckResult[]): void {
    this.logger.debug(`Updates detected for ${updates.length} bundles`);

    // Clear existing updates
    this.availableUpdates.clear();

    // Store new updates
    for (const update of updates) {
      this.availableUpdates.set(update.bundleId, update);
    }

    // Refresh tree to show update indicators
    this.refresh();
  }

  /**
   * Get tree item
   * @param element
   */
  public getTreeItem(element: RegistryTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for tree item
   * @param element
   */
  public async getChildren(element?: RegistryTreeItem): Promise<RegistryTreeItem[]> {
    if (!element) {
      // Root level items
      return this.getRootItems();
    }

    // Get children based on parent type
    switch (element.type) {
      case TreeItemType.PROFILES_ROOT: {
        return this.getProfileItems();
      }

      case TreeItemType.HUBS_ROOT: {
        return this.getHubsItems();
      }

      case TreeItemType.FAVORITES_ROOT: {
        return this.getFavoritesItems();
      }

      case TreeItemType.ACTIVE_PROFILE_SECTION: {
        return this.getActiveProfileItems();
      }

      case TreeItemType.HUB: {
        if (this.viewMode === 'favorites') {
          // In favorites view, HUB item data contains pre-filtered profiles
          // We need to organize them. If element.data is the Hub object, we need to fetch favorites.
          const hub = element.data;
          const profiles = await this.hubManager.listProfilesFromHub(hub.id);
          const favorites = await this.hubManager.getFavoriteProfiles();
          const hubFavorites = favorites[hub.id] || [];
          const favoriteProfiles = profiles.filter((p) => hubFavorites.includes(p.id));
          return this.organizeProfiles(hub.id, favoriteProfiles, [], hubFavorites);
        }
        return this.getHubChildren(element.data);
      }

      case TreeItemType.PROFILE_FOLDER: {
        return this.getFolderChildren(element.data);
      }

      case TreeItemType.PROFILE: {
        return this.getProfileBundleItems(element.data as Profile);
      }

      case TreeItemType.HUB_PROFILE: {
        // Reuse getProfileBundleItems as compatible
        return this.getProfileBundleItems(element.data as Profile);
      }

      case TreeItemType.INSTALLED_ROOT: {
        return this.getInstalledBundleItems();
      }

      case TreeItemType.DISCOVER_ROOT: {
        return this.getDiscoverItems();
      }

      case TreeItemType.DISCOVER_CATEGORY: {
        return this.getCategoryBundles(element.label);
      }

      case TreeItemType.SOURCES_ROOT: {
        return this.getSourceItems();
      }

      case TreeItemType.LOCAL_PROFILES_FOLDER: {
        return this.getLocalProfileItems();
      }

      default: {
        return [];
      }
    }
  }
}
