/**
 * TreeDataProvider representing a loaded `hub-config.yml` configuration.
 *
 * Displays:
 * - Contribution & Validation Status (Upstream, Fork/Branch, Validation state, PR status)
 * - Metadata (Name, Version, Maintainer, UpdatedAt)
 * - Sources (with validation status and CRUD actions)
 * - Profiles grouped by `path` category (with child Bundles and CRUD actions)
 */
import type {
  HubConfigDocumentInspection,
  HubConfigEditorService,
  WorkspaceContributionContext,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';

export enum HubConfigTreeItemType {
  STATUS_ROOT = 'hub_config_status_root',
  STATUS_ITEM = 'hub_config_status_item',
  PR_ACTION = 'hub_config_pr_action',
  VALIDATE_ACTION = 'hub_config_validate_action',
  METADATA_ROOT = 'hub_config_metadata_root',
  METADATA_ITEM = 'hub_config_metadata_item',
  SOURCES_ROOT = 'hub_config_sources_root',
  ADD_SOURCE = 'hub_config_add_source',
  SOURCE_ITEM = 'hub_config_source_item',
  PROFILES_ROOT = 'hub_config_profiles_root',
  ADD_PROFILE = 'hub_config_add_profile',
  PROFILE_CATEGORY = 'hub_config_profile_category',
  PROFILE_ITEM = 'hub_config_profile_item',
  ADD_BUNDLE = 'hub_config_add_bundle',
  PROFILE_BUNDLE_ITEM = 'hub_config_profile_bundle_item'
}

export class HubConfigTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemType: HubConfigTreeItemType,
    public readonly data?: Record<string, unknown>,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = itemType;
  }
}

export class HubConfigTreeProvider implements vscode.TreeDataProvider<HubConfigTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HubConfigTreeItem | undefined | null>();
  private activeFilePath: string | undefined;
  private activeContent = '';
  private activeInspection: HubConfigDocumentInspection | undefined;
  private contributionContext: WorkspaceContributionContext | undefined;

  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly editorService: HubConfigEditorService) {}

  private buildRootItems(): HubConfigTreeItem[] {
    if (!this.activeInspection || !this.activeInspection.config) {
      const emptyItem = new HubConfigTreeItem(
        'Open a hub-config.yml file or run "Contribute to Hub"',
        HubConfigTreeItemType.STATUS_ITEM,
        undefined,
        vscode.TreeItemCollapsibleState.None
      );
      emptyItem.iconPath = new vscode.ThemeIcon('info');
      emptyItem.command = {
        command: 'promptregistry.contributeToHub',
        title: 'Contribute to Active Hub'
      };
      return [emptyItem];
    }

    const { config, valid, errors } = this.activeInspection;
    const statusRoot = new HubConfigTreeItem(
      'Contribution & Validation',
      HubConfigTreeItemType.STATUS_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    statusRoot.description = valid ? '✓ Valid' : `✗ ${errors.length} error(s)`;
    statusRoot.iconPath = new vscode.ThemeIcon(valid ? 'pass' : 'error');

    const metadataRoot = new HubConfigTreeItem(
      'Metadata',
      HubConfigTreeItemType.METADATA_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    metadataRoot.description = `${config.metadata?.name ?? 'Unnamed'} (v${config.version ?? '1.0.0'})`;
    metadataRoot.iconPath = new vscode.ThemeIcon('info');

    const sourcesCount = Array.isArray(config.sources) ? config.sources.length : 0;
    const sourcesRoot = new HubConfigTreeItem(
      `Sources (${sourcesCount})`,
      HubConfigTreeItemType.SOURCES_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    sourcesRoot.iconPath = new vscode.ThemeIcon('radio-tower');

    const profilesCount = Array.isArray(config.profiles) ? config.profiles.length : 0;
    const profilesRoot = new HubConfigTreeItem(
      `Profiles (${profilesCount})`,
      HubConfigTreeItemType.PROFILES_ROOT,
      undefined,
      vscode.TreeItemCollapsibleState.Expanded
    );
    profilesRoot.iconPath = new vscode.ThemeIcon('layers');

    return [statusRoot, metadataRoot, sourcesRoot, profilesRoot];
  }

  private buildStatusChildren(): HubConfigTreeItem[] {
    const items: HubConfigTreeItem[] = [];
    const inspection = this.activeInspection;
    if (!inspection) {
      return items;
    }

    const validationItem = new HubConfigTreeItem(
      inspection.valid
        ? 'Validation: All static & policy checks passing'
        : `Validation: ${inspection.errors.length} error(s) detected`,
      HubConfigTreeItemType.VALIDATE_ACTION,
      { filePath: this.activeFilePath }
    );
    validationItem.iconPath = new vscode.ThemeIcon(inspection.valid ? 'check-all' : 'warning');
    validationItem.description = 'Click to run deep check';
    validationItem.command = {
      command: 'promptregistry.validateHubConfig',
      title: 'Validate Hub Configuration',
      arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined]
    };
    items.push(validationItem);

    const openVisualItem = new HubConfigTreeItem(
      'Open Visual Hub Editor',
      HubConfigTreeItemType.STATUS_ITEM,
      { filePath: this.activeFilePath }
    );
    openVisualItem.iconPath = new vscode.ThemeIcon('open-preview');
    openVisualItem.command = {
      command: 'promptregistry.openHubVisualEditor',
      title: 'Open Visual Hub Editor',
      arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined]
    };
    items.push(openVisualItem);

    if (this.contributionContext?.upstreamSlug) {
      const upstreamUrl = `https://github.com/${this.contributionContext.upstreamSlug}`;
      const repoItem = new HubConfigTreeItem(
        `Upstream: ${this.contributionContext.upstreamSlug}`,
        HubConfigTreeItemType.STATUS_ITEM,
        { url: upstreamUrl }
      );
      repoItem.description = this.contributionContext.currentBranch
        ? `branch: ${this.contributionContext.currentBranch}`
        : undefined;
      repoItem.tooltip = `Click to open ${upstreamUrl} in browser`;
      repoItem.iconPath = new vscode.ThemeIcon('repo-forked');
      repoItem.command = {
        command: 'promptregistry.openHubPullRequest',
        title: 'Open Upstream Repository in Browser',
        arguments: [upstreamUrl]
      };
      items.push(repoItem);
    }

    const rawPr = this.contributionContext?.session?.pullRequest;
    const pr = rawPr?.state === 'open' ? rawPr : undefined;
    if (pr) {
      const checksLabel = pr.checks
        ? ` • Checks: ${pr.checks.state} (${pr.checks.passingCount}/${pr.checks.totalCount})`
        : '';
      const prItem = new HubConfigTreeItem(
        `PR #${pr.number}: ${pr.title}`,
        HubConfigTreeItemType.PR_ACTION,
        { url: pr.htmlUrl }
      );
      prItem.description = `${pr.state.toUpperCase()}${checksLabel}`;
      prItem.tooltip = `Click to open ${pr.htmlUrl} in browser`;
      prItem.iconPath = new vscode.ThemeIcon('git-pull-request');
      prItem.command = {
        command: 'promptregistry.openHubPullRequest',
        title: 'Open Pull Request in Browser',
        arguments: [pr.htmlUrl]
      };
      items.push(prItem);

      const refreshPrItem = new HubConfigTreeItem(
        `Refresh PR #${pr.number} Status`,
        HubConfigTreeItemType.STATUS_ITEM,
        { url: pr.htmlUrl }
      );
      refreshPrItem.description = 'Check CI & merge status';
      refreshPrItem.iconPath = new vscode.ThemeIcon('sync');
      refreshPrItem.command = {
        command: 'promptregistry.refreshHubPullRequestStatus',
        title: 'Refresh Pull Request Status'
      };
      items.push(refreshPrItem);
    } else {
      const submitPrItem = new HubConfigTreeItem(
        'Commit & Create Pull Request...',
        HubConfigTreeItemType.STATUS_ITEM,
        { filePath: this.activeFilePath }
      );
      submitPrItem.iconPath = new vscode.ThemeIcon('git-pull-request-create');
      submitPrItem.command = {
        command: 'promptregistry.submitHubPullRequest',
        title: 'Commit & Create Pull Request',
        arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined]
      };
      items.push(submitPrItem);
    }

    return items;
  }

  private buildMetadataChildren(): HubConfigTreeItem[] {
    const config = this.activeInspection?.config;
    if (!config) {
      return [];
    }
    const entries: { label: string; value: string; field: string }[] = [
      { label: 'Name', value: config.metadata?.name ?? '', field: 'name' },
      { label: 'Description', value: config.metadata?.description ?? '', field: 'description' },
      { label: 'Maintainer', value: config.metadata?.maintainer ?? '', field: 'maintainer' },
      { label: 'Version', value: config.version ?? '1.0.0', field: 'version' },
      { label: 'Updated At', value: config.metadata?.updatedAt ?? '', field: 'updatedAt' }
    ];

    return entries.map((entry) => {
      const item = new HubConfigTreeItem(
        `${entry.label}: ${entry.value}`,
        HubConfigTreeItemType.METADATA_ITEM,
        { field: entry.field, filePath: this.activeFilePath }
      );
      item.iconPath = new vscode.ThemeIcon(entry.field === 'updatedAt' ? 'clock' : 'symbol-property');
      item.command = {
        command: 'promptregistry.openHubVisualEditor',
        title: 'Edit Metadata in Visual Editor',
        arguments: [
          this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined,
          { section: 'metadata' }
        ]
      };
      return item;
    });
  }

  private buildSourcesChildren(): HubConfigTreeItem[] {
    const items: HubConfigTreeItem[] = [];
    const addSource = new HubConfigTreeItem(
      '➕ Add Source...',
      HubConfigTreeItemType.ADD_SOURCE,
      { filePath: this.activeFilePath }
    );
    addSource.command = {
      command: 'promptregistry.addHubSource',
      title: 'Add Source',
      arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined]
    };
    items.push(addSource);

    const sources = this.activeInspection?.config?.sources ?? [];
    sources.forEach((source, index) => {
      const hasDiagError = this.activeInspection?.diagnostics.some(
        (d) => d.jsonPath[0] === 'sources' && d.jsonPath[1] === index && d.severity === 'error'
      );
      const catalogCount = this.activeInspection?.catalogsBySourceId[source.id]?.length;
      const item = new HubConfigTreeItem(
        `${source.name || source.id} (${source.id})`,
        HubConfigTreeItemType.SOURCE_ITEM,
        { index, source, filePath: this.activeFilePath }
      );
      item.description = `${source.type} • priority ${source.priority}${catalogCount === undefined ? '' : ` • ${catalogCount} bundles`}`;
      item.iconPath = new vscode.ThemeIcon(
        hasDiagError ? 'error' : (source.enabled === false ? 'circle-slash' : 'repo')
      );
      item.tooltip = `${source.url ?? ''}\nType: ${source.type}\nPriority: ${source.priority}`;
      item.command = {
        command: 'promptregistry.openHubVisualEditor',
        title: 'Edit Source in Visual Editor',
        arguments: [
          this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined,
          { section: 'source', index }
        ]
      };
      items.push(item);
    });

    return items;
  }

  private buildProfilesChildren(): HubConfigTreeItem[] {
    const items: HubConfigTreeItem[] = [];
    const addProfile = new HubConfigTreeItem(
      '➕ Add Profile...',
      HubConfigTreeItemType.ADD_PROFILE,
      { filePath: this.activeFilePath }
    );
    addProfile.command = {
      command: 'promptregistry.addHubProfile',
      title: 'Add Profile',
      arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined]
    };
    items.push(addProfile);

    for (const group of (this.activeInspection?.profileCategories ?? [])) {
      const catItem = new HubConfigTreeItem(
        group.category,
        HubConfigTreeItemType.PROFILE_CATEGORY,
        { category: group.category, profiles: group.profiles },
        vscode.TreeItemCollapsibleState.Expanded
      );
      catItem.description = `${group.profiles.length} profile(s)`;
      catItem.iconPath = new vscode.ThemeIcon('folder');
      items.push(catItem);
    }

    return items;
  }

  private buildCategoryProfileItems(categoryData: Record<string, unknown> | undefined): HubConfigTreeItem[] {
    const entries = (categoryData?.profiles as { index: number; profile: Record<string, any> }[] | undefined) ?? [];
    return entries.map(({ index, profile }) => {
      const hasDiagError = this.activeInspection?.diagnostics.some(
        (d) => d.jsonPath[0] === 'profiles' && d.jsonPath[1] === index && d.severity === 'error'
      );
      const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
      const iconPrefix = profile.icon ? `${String(profile.icon)} ` : '';
      const item = new HubConfigTreeItem(
        `${iconPrefix}${String(profile.name || profile.id)} (${String(profile.id)})`,
        HubConfigTreeItemType.PROFILE_ITEM,
        { index, profile, filePath: this.activeFilePath },
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${bundles.length} bundle(s)${hasDiagError ? ' ⚠' : ''}`;
      item.iconPath = hasDiagError ? new vscode.ThemeIcon('error') : undefined;
      item.tooltip = String(profile.description ?? '');
      item.command = {
        command: 'promptregistry.openHubVisualEditor',
        title: 'Edit Profile in Visual Editor',
        arguments: [
          this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined,
          { section: 'profile', index }
        ]
      };
      return item;
    });
  }

  private buildProfileBundleItems(profileData: Record<string, unknown> | undefined): HubConfigTreeItem[] {
    const profileIndex = Number(profileData?.index ?? 0);
    const profile = (profileData?.profile ?? {}) as Record<string, unknown>;
    const bundles = Array.isArray(profile.bundles) ? (profile.bundles as Record<string, unknown>[]) : [];

    const items: HubConfigTreeItem[] = [];
    const addBundle = new HubConfigTreeItem(
      '➕ Add Bundle to Profile...',
      HubConfigTreeItemType.ADD_BUNDLE,
      { profileIndex, filePath: this.activeFilePath }
    );
    addBundle.command = {
      command: 'promptregistry.addHubProfileBundle',
      title: 'Add Bundle to Profile',
      arguments: [this.activeFilePath ? vscode.Uri.file(this.activeFilePath) : undefined, profileIndex]
    };
    items.push(addBundle);

    bundles.forEach((bundle, bundleIndex) => {
      const hasDiagError = this.activeInspection?.diagnostics.some(
        (d) => d.jsonPath[0] === 'profiles'
          && d.jsonPath[1] === profileIndex
          && d.jsonPath[2] === 'bundles'
          && d.jsonPath[3] === bundleIndex
          && d.severity === 'error'
      );
      const bundleId = typeof bundle.id === 'string' ? bundle.id : '';
      const bundleVersion = typeof bundle.version === 'string' ? bundle.version : 'latest';
      const bundleSource = typeof bundle.source === 'string' ? bundle.source : '';
      const item = new HubConfigTreeItem(
        bundleId,
        HubConfigTreeItemType.PROFILE_BUNDLE_ITEM,
        { profileIndex, bundleIndex, bundle, filePath: this.activeFilePath }
      );
      item.description = `@ ${bundleVersion} [${bundleSource}]${bundle.required ? '' : ' (optional)'}`;
      item.iconPath = new vscode.ThemeIcon(hasDiagError ? 'error' : 'package');
      items.push(item);
    });

    return items;
  }

  public updateFromContent(
    filePath: string,
    content: string,
    inspection?: HubConfigDocumentInspection
  ): void {
    this.activeFilePath = filePath;
    this.activeContent = content;
    this.activeInspection = inspection ?? this.editorService.inspectDocument(content);
    this._onDidChangeTreeData.fire(undefined);
  }

  public setContributionContext(context: WorkspaceContributionContext | undefined): void {
    this.contributionContext = context;
    this._onDidChangeTreeData.fire(undefined);
  }

  public getActiveFilePath(): string | undefined {
    return this.activeFilePath;
  }

  public getActiveContent(): string {
    return this.activeContent;
  }

  public refresh(): void {
    if (this.activeContent) {
      this.activeInspection = this.editorService.inspectDocument(this.activeContent);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: HubConfigTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: HubConfigTreeItem): Promise<HubConfigTreeItem[]> {
    if (!element) {
      return Promise.resolve(this.buildRootItems());
    }

    switch (element.itemType) {
      case HubConfigTreeItemType.STATUS_ROOT: {
        return Promise.resolve(this.buildStatusChildren());
      }
      case HubConfigTreeItemType.METADATA_ROOT: {
        return Promise.resolve(this.buildMetadataChildren());
      }
      case HubConfigTreeItemType.SOURCES_ROOT: {
        return Promise.resolve(this.buildSourcesChildren());
      }
      case HubConfigTreeItemType.PROFILES_ROOT: {
        return Promise.resolve(this.buildProfilesChildren());
      }
      case HubConfigTreeItemType.PROFILE_CATEGORY: {
        return Promise.resolve(this.buildCategoryProfileItems(element.data));
      }
      case HubConfigTreeItemType.PROFILE_ITEM: {
        return Promise.resolve(this.buildProfileBundleItems(element.data));
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
