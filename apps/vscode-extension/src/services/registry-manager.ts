/**
 * Main Registry Manager
 * Orchestrates all registry operations including sources, bundles, profiles, and installations
 */

import {
  activateRegistryProfile,
  createLocalProfile,
  deactivateRegistryProfile,
  deleteLocalProfile,
  detectBundleUpdates,
  exportLocalProfile,
  exportRegistrySettings,
  importLocalProfile,
  importRegistrySettings,
  installRegistryBundle,
  isHubProfile as isAppHubProfile,
  listAllProfiles,
  listInstalledBundles as listInstalledBundlesCore,
  listLocalProfiles as listLocalProfilesCore,
  searchRegistryBundles,
  uninstallInstalledBundle,
  updateLocalProfile,
  updateRegistryBundle,
} from '@ai-primitives-hub/app';
import type {
  LogEvent,
} from '@ai-primitives-hub/app';
import {
  GitHubAdapter as InfraGitHubAdapter,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  createRegistryAdapter,
} from '../adapters/infra-adapter-factory';
import {
  IRepositoryAdapter,
} from '../adapters/repository-adapter';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  AutoUpdatePreferenceChangedEvent,
  Bundle,
  BundleUpdate,
  InstallationScope,
  InstalledBundle,
  InstallOptions,
  Profile,
  RegistrySource,
  SearchQuery,
  SourceSyncedEvent,
  SourceType,
  ValidationResult,
} from '../types/registry';
import {
  ExportFormat,
  ImportStrategy,
} from '../types/settings';
import {
  BundleIdentityMatcher,
} from '../utils/bundle-identity-matcher';
import {
  CONCURRENCY_CONSTANTS,
  WARNING_RESULTS,
} from '../utils/constants';
import {
  UpdateCancelledError,
} from '../utils/error-handler';
import {
  Logger,
} from '../utils/logger';
import {
  getWorkspaceRoot,
} from '../utils/scope-selection-ui';
import {
  generateLegacyHubSourceId,
} from '../utils/source-id-utils';
import {
  VersionManager,
} from '../utils/version-manager';
import {
  AutoUpdateService,
} from './auto-update-service';
import {
  BundleInstaller,
} from './bundle-installer';
import {
  HubManager,
} from './hub-manager';
import {
  LocalModificationWarningService,
} from './local-modification-warning-service';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  VersionConsolidator,
} from './version-consolidator';

/**
 * Results from auto-update operations
 */
interface UpdateResults {
  succeeded: string[];
  failed: { bundleId: string; error: string }[];
  skipped: string[];
}

/**
 * Registry Manager
 * Main entry point for all registry operations
 */
export class RegistryManager {
  private static instance: RegistryManager;

  /**
   * Reset the singleton instance.
   * Intended for test isolation.
   */
  public static resetInstance(): void {
    RegistryManager.instance = undefined as any;
  }

  /**
   * Get singleton instance
   * @param context
   */
  public static getInstance(context?: vscode.ExtensionContext): RegistryManager {
    if (!RegistryManager.instance && context) {
      RegistryManager.instance = new RegistryManager(context);
    }
    if (!RegistryManager.instance) {
      throw new Error('RegistryManager not initialized. Provide context on first call.');
    }
    return RegistryManager.instance;
  }

  private readonly storage: RegistryStorage;
  private hubManager?: HubManager;
  private _autoUpdateService?: AutoUpdateService;
  private readonly installer: BundleInstaller;
  private readonly logger: Logger;
  private readonly adapters = new Map<string, IRepositoryAdapter>();
  private readonly versionConsolidator: VersionConsolidator;
  private sourcesCache: RegistrySource[] = [];

  // Event emitters
  private readonly _onBundleInstalled = new vscode.EventEmitter<InstalledBundle>();
  private readonly _onBundleUninstalled = new vscode.EventEmitter<string>();
  private readonly _onBundleUpdated = new vscode.EventEmitter<InstalledBundle>();
  private readonly _onBundlesInstalled = new vscode.EventEmitter<InstalledBundle[]>();
  private readonly _onBundlesUninstalled = new vscode.EventEmitter<string[]>();
  private readonly _onProfileActivated = new vscode.EventEmitter<Profile>();
  private readonly _onProfileDeactivated = new vscode.EventEmitter<string>();
  private readonly _onProfileCreated = new vscode.EventEmitter<Profile>();
  private readonly _onProfileUpdated = new vscode.EventEmitter<Profile>();
  private readonly _onProfileDeleted = new vscode.EventEmitter<string>();
  private readonly _onSourceAdded = new vscode.EventEmitter<RegistrySource>();
  private readonly _onSourceRemoved = new vscode.EventEmitter<string>();
  private readonly _onSourceUpdated = new vscode.EventEmitter<string>();
  private readonly _onSourceSynced = new vscode.EventEmitter<SourceSyncedEvent>();
  private readonly _onAutoUpdatePreferenceChanged = new vscode.EventEmitter<AutoUpdatePreferenceChangedEvent>();
  private readonly _onRepositoryBundlesChanged = new vscode.EventEmitter<void>();
  private readonly _onReadmeDownloaded = new vscode.EventEmitter<{ sourceId: string; bundleIds: string[] }>();
  private readonly _onReadmeDownloadComplete = new vscode.EventEmitter<{ sourceId: string; succeeded: string[]; failed: string[] }>();

  // Public event accessors
  public readonly onBundleInstalled = this._onBundleInstalled.event;
  public readonly onBundleUninstalled = this._onBundleUninstalled.event;
  public readonly onBundleUpdated = this._onBundleUpdated.event;
  public readonly onBundlesInstalled = this._onBundlesInstalled.event;
  public readonly onBundlesUninstalled = this._onBundlesUninstalled.event;
  public readonly onProfileActivated = this._onProfileActivated.event;
  public readonly onProfileDeactivated = this._onProfileDeactivated.event;
  public readonly onProfileCreated = this._onProfileCreated.event;
  public readonly onProfileUpdated = this._onProfileUpdated.event;
  public readonly onProfileDeleted = this._onProfileDeleted.event;
  public readonly onSourceAdded = this._onSourceAdded.event;
  public readonly onSourceRemoved = this._onSourceRemoved.event;
  public readonly onSourceUpdated = this._onSourceUpdated.event;
  public readonly onSourceSynced = this._onSourceSynced.event;
  public readonly onAutoUpdatePreferenceChanged = this._onAutoUpdatePreferenceChanged.event;
  public readonly onRepositoryBundlesChanged = this._onRepositoryBundlesChanged.event;
  public readonly onReadmeDownloaded = this._onReadmeDownloaded.event;
  public readonly onReadmeDownloadComplete = this._onReadmeDownloadComplete.event; // Useful for debugging and testing to know when all downloads are finished

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.storage = new RegistryStorage(context);
    this.installer = new BundleInstaller(context);
    this.logger = Logger.getInstance();

    // Initialize version consolidator with source type resolver
    this.versionConsolidator = new VersionConsolidator();
    this.versionConsolidator.setSourceTypeResolver((sourceId: string) => this.getSourceType(sourceId));
  }

  /**
   * Enrich source with global token if applicable
   * Applies global GitHub token to GitHub sources that don't have their own token
   * @param source
   */
  private enrichSourceWithGlobalToken(source: RegistrySource): RegistrySource {
    // If source already has a token, don't override it
    if (source.token && source.token.trim().length > 0) {
      return source;
    }

    // Get global token from VS Code configuration
    const config = vscode.workspace.getConfiguration('promptregistry');
    const globalToken = config.get<string>('githubToken', '');

    if (globalToken && globalToken.trim().length > 0) {
      this.logger.debug(`[RegistryManager] Applying global GitHub token to source '${source.id}'`);
      return {
        ...source,
        token: globalToken.trim()
      };
    }

    return source;
  }

  /**
   * Load adapters for all sources
   */
  private async loadAdapters(): Promise<void> {
    const sources = await this.storage.getSources();
    this.sourcesCache = sources; // Cache for synchronous access

    for (const source of sources) {
      if (source.enabled) {
        try {
          const enrichedSource = this.enrichSourceWithGlobalToken(source);
          const adapter = createRegistryAdapter(enrichedSource);
          this.adapters.set(source.id, adapter);
        } catch (error) {
          this.logger.error(`Failed to create adapter for source '${source.id}'`, error as Error);
        }
      }
    }
  }

  /**
   * Local skills installations are symlinked directly to the source directory, so updating files
   * in the source immediately updates the installed content. After syncing the source, refresh the
   * recorded installation metadata so the UI reflects the latest hash/version without requiring an
   * explicit update action.
   * @param sourceId
   * @param latestBundles
   */
  private async refreshLocalSkillInstallations(sourceId: string, latestBundles: Bundle[]): Promise<void> {
    const installedBundles = await this.storage.getInstalledBundles();
    const installsForSource = installedBundles.filter((bundle) => bundle.sourceId === sourceId && bundle.scope !== 'repository');

    if (installsForSource.length === 0) {
      return;
    }

    const updated: InstalledBundle[] = [];

    for (const installed of installsForSource) {
      const latest = latestBundles.find((bundle) => bundle.id === installed.bundleId);
      if (!latest || latest.version === installed.version) {
        continue;
      }

      const updatedInstallation: InstalledBundle = {
        ...installed,
        version: latest.version,
        installedAt: new Date().toISOString()
      };

      await this.storage.recordInstallation(updatedInstallation);
      updated.push(updatedInstallation);
    }

    if (updated.length > 0) {
      for (const install of updated) {
        this._onBundleUpdated.fire(install);
      }
      this.logger.info(`[local-skills] Refreshed ${updated.length} installed skill(s) to latest hash`);
    }
  }

  /**
   * Get or create adapter for a source
   * @param source
   */
  private getAdapter(source: RegistrySource): IRepositoryAdapter {
    let adapter = this.adapters.get(source.id);

    if (!adapter) {
      const enrichedSource = this.enrichSourceWithGlobalToken(source);
      adapter = createRegistryAdapter(enrichedSource);
      this.adapters.set(source.id, adapter);
    }

    return adapter;
  }

  /**
   * Auto-update installed bundles from a source
   * Used for Awesome Copilot sources that should auto-update
   * @param sourceId
   * @param latestBundles
   */
  private async autoUpdateInstalledBundles(sourceId: string, latestBundles: Bundle[]): Promise<void> {
    const bundlesToUpdate = await this.identifyBundlesForUpdate(sourceId, latestBundles);
    const results = await this.performBundleUpdates(bundlesToUpdate, latestBundles);

    // Report results summary
    if (results.failed.length > 0) {
      this.logger.warn(
        `Auto-update completed: ${results.succeeded.length} succeeded, `
        + `${results.failed.length} failed, ${results.skipped.length} skipped`
      );
    } else if (results.succeeded.length > 0) {
      this.logger.info(`Auto-update completed successfully: ${results.succeeded.length} bundles updated`);
    }
  }

  /**
   * Identify bundles that need to be updated from a source
   * @param sourceId
   * @param latestBundles
   */
  private async identifyBundlesForUpdate(
    sourceId: string,
    latestBundles: Bundle[]
  ): Promise<InstalledBundle[]> {
    const installed = await this.storage.getInstalledBundles();
    const bundlesFromSource = this.filterBundlesBySource(installed, sourceId, latestBundles);

    this.logger.info(`Found ${bundlesFromSource.length} installed bundles from source '${sourceId}'`);
    return bundlesFromSource;
  }

  /**
   * Perform updates for a list of bundles
   *
   * Iterates through bundles, checks for updates, and tracks results.
   * Continues processing even if individual updates fail.
   * @param bundlesToUpdate
   * @param latestBundles
   */
  private async performBundleUpdates(
    bundlesToUpdate: InstalledBundle[],
    latestBundles: Bundle[]
  ): Promise<UpdateResults> {
    const results: UpdateResults = {
      succeeded: [],
      failed: [],
      skipped: []
    };

    for (const installedBundle of bundlesToUpdate) {
      try {
        const latestBundle = this.findMatchingLatestBundle(installedBundle, latestBundles);

        if (!latestBundle) {
          this.logger.warn(`Bundle '${installedBundle.bundleId}' no longer available`);
          results.skipped.push(installedBundle.bundleId);
          continue;
        }

        // Check if update is needed (version comparison)
        if (latestBundle.version === installedBundle.version) {
          this.logger.debug(`Bundle '${installedBundle.bundleId}' is already at latest version ${latestBundle.version}`);
        } else {
          this.logger.info(`Auto-updating bundle '${installedBundle.bundleId}' from v${installedBundle.version} to v${latestBundle.version}`);
          await this.updateBundle(installedBundle.bundleId, latestBundle.version);
          results.succeeded.push(installedBundle.bundleId);
          this.logger.info(`Successfully auto-updated bundle '${installedBundle.bundleId}'`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.failed.push({ bundleId: installedBundle.bundleId, error: errorMsg });
        this.logger.error(`Failed to auto-update bundle '${installedBundle.bundleId}'`, error as Error);
      }
    }

    return results;
  }

  /**
   * Filter installed bundles by source ID
   * @param installed
   * @param sourceId
   * @param latestBundles
   */
  private filterBundlesBySource(
    installed: InstalledBundle[],
    sourceId: string,
    latestBundles: Bundle[]
  ): InstalledBundle[] {
    return installed.filter((b) => this.belongsToSource(b, sourceId, latestBundles));
  }

  /**
   * Check if an installed bundle belongs to a specific source
   * @param bundle
   * @param sourceId
   * @param latestBundles
   */
  private belongsToSource(
    bundle: InstalledBundle,
    sourceId: string,
    latestBundles: Bundle[]
  ): boolean {
    // Direct source ID match
    if (bundle.sourceId === sourceId) {
      return true;
    }

    // @migration-cleanup(sourceId-normalization-v2): Remove legacy ID check once all lockfiles are migrated
    // Legacy source ID match: bundle may have been installed with old-format ID.
    // Compute the legacy ID for this source and check against the bundle's sourceId.
    if (bundle.sourceId) {
      const source = this.getSourceById(sourceId);
      if (source) {
        const legacyId = generateLegacyHubSourceId(source.type, source.url, {
          branch: source.config?.branch,
          collectionsPath: source.config?.collectionsPath
        });
        if (legacyId && bundle.sourceId === legacyId) {
          return true;
        }
      }
    }

    // Manifest URL match
    if (bundle.manifest?.metadata?.repository?.url?.includes(sourceId)) {
      return true;
    }

    // Identity-based match
    return latestBundles.some((lb) => this.bundlesMatch(bundle, lb, sourceId));
  }

  /**
   * Check if installed bundle matches a latest bundle from a source
   * @param installed
   * @param latest
   * @param sourceId
   */
  private bundlesMatch(installed: InstalledBundle, latest: Bundle, sourceId: string): boolean {
    if (latest.sourceId !== sourceId) {
      return false;
    }

    const sourceType: SourceType = (installed.sourceType as SourceType) ?? 'local';
    return BundleIdentityMatcher.matches(
      installed.bundleId,
      latest.id,
      sourceType
    );
  }

  /**
   * Find matching latest bundle for an installed bundle
   * @param installedBundle
   * @param latestBundles
   */
  private findMatchingLatestBundle(installedBundle: InstalledBundle, latestBundles: Bundle[]): Bundle | undefined {
    return latestBundles.find((lb) => {
      if (installedBundle.sourceType === 'github') {
        return BundleIdentityMatcher.matches(
          installedBundle.bundleId,
          lb.id,
          'github'
        );
      } else {
        // For non-GitHub bundles, match by base ID (without version)
        const installedBaseId = BundleIdentityMatcher.extractBaseId(installedBundle.bundleId);
        const latestBaseId = BundleIdentityMatcher.extractBaseId(lb.id);
        return installedBaseId === latestBaseId;
      }
    });
  }

  /**
   * Check for local modifications and handle user response before updating
   *
   * For repository-scoped bundles, this method:
   * 1. Detects if any bundle files have been modified locally
   * 2. Shows a warning dialog if modifications are found
   * 3. Handles user response (contribute, override, or cancel)
   * @param bundleId - The bundle ID being updated
   * @param current - The current installed bundle
   * @throws {UpdateCancelledError} if user chooses to contribute or cancel
   *
   * Requirements: 14.1-14.10
   */
  private async checkLocalModificationsBeforeUpdate(
    bundleId: string,
    current: InstalledBundle
  ): Promise<void> {
    // Only check for repository-scoped bundles
    if (current.scope !== 'repository') {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const lockfileManager = LockfileManager.getInstance(workspaceRoot);
    const warningService = new LocalModificationWarningService(lockfileManager);

    // Get bundle repository URL for "Contribute Changes" action
    const bundleRepoUrl = current.manifest?.metadata?.repository?.url
      || current.manifest?.metadata?.homepage;

    const warningResult = await warningService.checkAndWarn(bundleId, bundleRepoUrl);

    if (warningResult === null) {
      // No modifications detected, proceed with update
      return;
    }

    // Handle user response
    switch (warningResult) {
      case WARNING_RESULTS.CONTRIBUTE: {
        this.logger.info(`Update aborted for '${bundleId}': user chose to contribute changes`);
        throw new UpdateCancelledError(bundleId, 'contribute');
      }

      case WARNING_RESULTS.CANCEL: {
        this.logger.info(`Update cancelled for '${bundleId}': user cancelled`);
        throw new UpdateCancelledError(bundleId, 'cancel');
      }

      case WARNING_RESULTS.OVERRIDE: {
        this.logger.info(`User chose to override local modifications for '${bundleId}'`);
        return;
      }

      default: {
        // Unknown result, proceed with update
        return;
      }
    }
  }

  // ===== Helper Methods =====

  /**
   * Get source type for a source ID
   * Used by version consolidator for identity matching
   * @param sourceId
   */
  private getSourceType(sourceId: string): SourceType {
    const source = this.sourcesCache.find((s) => s.id === sourceId);
    return source?.type ?? 'local';
  }

  /**
   * Get a source by its ID from the cache
   * @param sourceId
   */
  private getSourceById(sourceId: string): RegistrySource | undefined {
    return this.sourcesCache.find((s) => s.id === sourceId);
  }

  /**
   * Forward a generic `@ai-primitives-hub/app` log event to this
   * extension's `Logger`. Shared by thin delegators to `app`'s registry
   * orchestration functions (e.g. `checkUpdates`).
   * @param event
   */
  private forwardLogEvent(event: LogEvent): void {
    switch (event.level) {
      case 'debug': {
        this.logger.debug(event.message, event.error);
        break;
      }
      case 'info': {
        this.logger.info(event.message);
        break;
      }
      case 'warn': {
        this.logger.warn(event.message, event.error);
        break;
      }
      case 'error': {
        this.logger.error(event.message, event.error);
        break;
      }
    }
  }

  /**
   * Read/write access to local profile storage, shared by every thin
   * profile-CRUD delegator in the "Profile Management" section below.
   */
  private profileStorePorts() {
    return {
      getProfiles: () => this.storage.getProfiles(),
      addProfile: (profile: Profile) => this.storage.addProfile(profile),
      updateProfile: (profileId: string, updates: Partial<Profile>) => this.storage.updateProfile(profileId, updates),
      removeProfile: (profileId: string) => this.storage.removeProfile(profileId)
    };
  }

  /**
   * Read/write access needed by `exportSettings`/`importSettings`.
   */
  private settingsPorts() {
    return {
      ...this.profileStorePorts(),
      listSources: () => this.listSources(),
      addSource: (source: RegistrySource) => this.addSource(source),
      clearAll: () => this.storage.clearAll(),
      getConfiguration: (): { autoCheckUpdates?: boolean; installationScope?: string; enableLogging?: boolean } => {
        const config = vscode.workspace.getConfiguration('promptregistry');
        return {
          autoCheckUpdates: config.get<boolean>('autoCheckUpdates'),
          installationScope: config.get<string>('installationScope'),
          enableLogging: config.get<boolean>('enableLogging')
        };
      },
      updateConfiguration: async (updates: { autoCheckUpdates?: boolean; installationScope?: string; enableLogging?: boolean }) => {
        const config = vscode.workspace.getConfiguration('promptregistry');
        if (updates.autoCheckUpdates !== undefined) {
          await config.update('autoCheckUpdates', updates.autoCheckUpdates, true);
        }
        if (updates.installationScope !== undefined) {
          await config.update('installationScope', updates.installationScope, true);
        }
        if (updates.enableLogging !== undefined) {
          await config.update('enableLogging', updates.enableLogging, true);
        }
      }
    };
  }

  /**
   * Carry over cached readmes into freshly fetched bundles when the source revision is unchanged.
   * Bundles whose `readmeRevision` differs (or is not provided by the adapter) are left without a
   * readme so {@link downloadReadmesConcurrently} re-downloads them. This keeps readmes fresh while
   * avoiding redundant downloads on every sync.
   * @param previouslyCached - Snapshot of cached bundles taken before the current sync started
   * @param bundles - Freshly fetched bundles to enrich in place
   */
  private async reuseCachedReadmes(previouslyCached: Bundle[], bundles: Bundle[]): Promise<void> {
    if (!previouslyCached || previouslyCached.length === 0) {
      return;
    }
    const cachedById = new Map(previouslyCached.map((b) => [b.id, b]));
    for (const bundle of bundles) {
      const previous = cachedById.get(bundle.id);
      if (
        previous?.readme
        && previous.readmeRevision !== undefined
        && previous.readmeRevision === bundle.readmeRevision
      ) {
        bundle.readme = previous.readme;
      }
    }
  }

  /**
   * Download readme files concurrently
   * @param bundles - Bundles to download readmes for
   * @param sourceId - Source ID for caching purposes
   * @param adapter - Adapter to use for downloading readmes
   */
  private async downloadReadmesConcurrently(bundles: Bundle[], sourceId: string, adapter: IRepositoryAdapter): Promise<void> {
    const concurrency = CONCURRENCY_CONSTANTS.README_DOWNLOAD_CONCURRENCY;
    const filteredBundles = bundles.filter((b) => b.readmeUrl && !b.readme);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < filteredBundles.length; i += concurrency) {
      const batch = filteredBundles.slice(i, i + concurrency);
      const newlyDownloaded = new Set<string>();
      await Promise.allSettled(
        batch.map(async (bundle) => {
          const readme = await adapter.downloadReadme(bundle);
          if (readme) {
            bundle.readme = readme;
            newlyDownloaded.add(bundle.id);
          } else {
            failed.push(bundle.id);
          }
        })
      );
      succeeded.push(...newlyDownloaded);
      if (newlyDownloaded.size > 0) {
        const bundleIdsWithReadmes = [...newlyDownloaded];
        // Cache all bundles (including previously downloaded) so consumers get full state
        await this.storage.cacheSourceBundles(sourceId, bundles);
        this._onReadmeDownloaded.fire({ sourceId, bundleIds: bundleIdsWithReadmes });
      }
    }
    this._onReadmeDownloadComplete.fire({ sourceId, succeeded, failed });
  }

  /**
   * Set HubManager instance for hub integration
   * @param hubManager
   */
  public setHubManager(hubManager: HubManager): void {
    this.hubManager = hubManager;
  }

  /**
   * Set AutoUpdateService instance for auto-update functionality
   * @param autoUpdateService
   */
  public setAutoUpdateService(autoUpdateService: AutoUpdateService): void {
    this._autoUpdateService = autoUpdateService;
  }

  /**
   * Get AutoUpdateService instance
   */
  public get autoUpdateService(): AutoUpdateService | undefined {
    return this._autoUpdateService;
  }

  /**
   * Enable auto-update for a bundle (facade method)
   * @param bundleId
   */
  public async enableAutoUpdate(bundleId: string): Promise<void> {
    if (!this._autoUpdateService) {
      throw new Error('Auto-update service is not available. Please restart VS Code.');
    }
    await this._autoUpdateService.setAutoUpdate(bundleId, true);
    this._onAutoUpdatePreferenceChanged.fire({ bundleId, enabled: true });
  }

  /**
   * Disable auto-update for a bundle (facade method)
   * @param bundleId
   */
  public async disableAutoUpdate(bundleId: string): Promise<void> {
    if (!this._autoUpdateService) {
      throw new Error('Auto-update service is not available. Please restart VS Code.');
    }
    await this._autoUpdateService.setAutoUpdate(bundleId, false);
    this._onAutoUpdatePreferenceChanged.fire({ bundleId, enabled: false });
  }

  /**
   * Check if auto-update is enabled for a bundle (facade method)
   * @param bundleId
   */
  public async isAutoUpdateEnabled(bundleId: string): Promise<boolean> {
    if (!this._autoUpdateService) {
      return false;
    }
    return await this._autoUpdateService.isAutoUpdateEnabled(bundleId);
  }

  /**
   * Initialize the registry
   */
  public async initialize(): Promise<void> {
    this.logger.info('Initializing AI Primitives Hub...');
    await this.storage.initialize();
    await this.loadAdapters();
    this.logger.info('AI Primitives Hub initialized successfully');
  }

  /**
   * Get the storage instance
   * Used by commands to access storage functionality like update preferences
   */
  public getStorage(): RegistryStorage {
    return this.storage;
  }

  /**
   * Get the bundle installer instance
   * Used by extension.ts to access scope services for BundleScopeCommands
   */
  public getBundleInstaller(): BundleInstaller {
    return this.installer;
  }

  /**
   * Clear adapter cache for a source.
   * Should be called on manual user-initiated syncs to ensure fresh data.
   * Not called during automatic background syncs to preserve cache benefits.
   * @param sourceId
   */
  public clearAdapterCache(sourceId: string): void {
    const adapter = this.adapters.get(sourceId);
    if (adapter && adapter instanceof InfraGitHubAdapter) {
      adapter.clearManifestCache();
      this.logger.debug(`Cleared manifest cache for source: ${sourceId}`);
    }
  }

  // ===== Source Management =====

  /**
   * Add a new registry source
   * @param source
   */
  public async addSource(source: RegistrySource): Promise<void> {
    this.logger.info(`Adding source: ${source.name}`);

    // Validate source (with global token if applicable)
    const enrichedSource = this.enrichSourceWithGlobalToken(source);
    const adapter = createRegistryAdapter(enrichedSource);
    const validation = await adapter.validate();

    if (!validation.valid) {
      throw new Error(`Source validation failed: ${validation.errors.join(', ')}`);
    }

    await this.storage.addSource(source);
    this.adapters.set(source.id, adapter);

    // Update cache
    this.sourcesCache = await this.storage.getSources();

    this._onSourceAdded.fire(source);
    this.logger.info(`Source '${source.name}' added successfully`);
  }

  /**
   * Remove a source
   * @param sourceId
   */
  public async removeSource(sourceId: string): Promise<void> {
    this.logger.info(`Removing source: ${sourceId}`);

    await this.storage.removeSource(sourceId);
    this.adapters.delete(sourceId);

    // Update cache
    this.sourcesCache = await this.storage.getSources();

    this._onSourceRemoved.fire(sourceId);
    this.logger.info(`Source '${sourceId}' removed successfully`);
  }

  /**
   * Update a source
   * @param sourceId
   * @param updates
   */
  public async updateSource(sourceId: string, updates: Partial<RegistrySource>): Promise<void> {
    this.logger.info(`Updating source: ${sourceId}`);

    await this.storage.updateSource(sourceId, updates);

    // Reload adapter if source was updated
    this.adapters.delete(sourceId);
    const sources = await this.storage.getSources();
    this.sourcesCache = sources; // Update cache

    const updatedSource = sources.find((s) => s.id === sourceId);

    if (updatedSource && updatedSource.enabled) {
      const enrichedSource = this.enrichSourceWithGlobalToken(updatedSource);
      const adapter = createRegistryAdapter(enrichedSource);
      this.adapters.set(sourceId, adapter);
    }

    this._onSourceUpdated.fire(sourceId);
    this.logger.info(`Source '${sourceId}' updated successfully`);
  }

  /**
   * List all sources
   */
  public async listSources(): Promise<RegistrySource[]> {
    return await this.storage.getSources();
  }

  /**
   * Sync a source (refresh bundle list)
   * Behavior varies by source type:
   * - GitHub: Update cache only, no auto-installation
   * - Awesome Copilot: Update cache and auto-update installed bundles
   * - Others: Default to cache-only behavior
   * @param sourceId
   */
  public async syncSource(sourceId: string): Promise<void> {
    this.logger.info(`Syncing source: ${sourceId}`);

    const sources = await this.storage.getSources();
    const source = sources.find((s) => s.id === sourceId);

    if (!source) {
      throw new Error(`Source '${sourceId}' not found`);
    }

    const adapter = this.getAdapter(source);

    // Snapshot the cache before fetchBundles starts overwriting it with partial results,
    // so readme reuse can compare against the last fully-synced state.
    const preSyncCache = await this.storage.getCachedSourceBundles(sourceId);

    const bundles = await adapter.fetchBundles(async (partial) => {
      // Progressive update: cache what we have so far and notify the UI.
      await this.storage.cacheSourceBundles(sourceId, partial);
      this._onSourceSynced.fire({ sourceId, bundleCount: partial.length });
    });

    // Reuse still-valid cached readmes so we only re-download when the source revision changed
    await this.reuseCachedReadmes(preSyncCache, bundles);

    // Cache bundles
    await this.storage.cacheSourceBundles(sourceId, bundles);

    this.logger.info(`Source '${sourceId}' synced. Found ${bundles.length} bundles.`);

    // Apply source-type-specific sync behavior
    switch (source.type) {
      case 'awesome-copilot':
      case 'local-awesome-copilot': {
        // Awesome Copilot sources: Auto-update installed bundles
        this.logger.info(`[${source.type}] Auto-updating installed bundles from source '${sourceId}'`);
        await this.autoUpdateInstalledBundles(sourceId, bundles);

        break;
      }
      case 'local-skills': {
        this.logger.info(`[local-skills] Refreshing installed skill metadata for source '${sourceId}'`);
        await this.refreshLocalSkillInstallations(sourceId, bundles);

        break;
      }
      case 'github': {
        // GitHub sources: Cache-only, no auto-installation
        this.logger.info(`[github] Cache updated for source '${sourceId}'. No auto-installation performed.`);

        break;
      }
      default: {
        // Other sources: Default to cache-only behavior
        this.logger.info(`[${source.type}] Cache updated for source '${sourceId}'. Using cache-only behavior.`);
      }
    }

    // Fire source synced event
    this._onSourceSynced.fire({ sourceId, bundleCount: bundles.length });

    // Download the readme files in concurrent, non blocking way
    this.downloadReadmesConcurrently(bundles, sourceId, adapter).catch((err) => {
      this.logger.error(`Failed to download readmes for source '${sourceId}'`, err as Error);
    });
  }

  /**
   * Validate a source
   * @param source
   */
  public async validateSource(source: RegistrySource): Promise<ValidationResult> {
    const enrichedSource = this.enrichSourceWithGlobalToken(source);
    const adapter = createRegistryAdapter(enrichedSource);
    return await adapter.validate();
  }

  /**
   * Force authentication for all sources
   */
  public async forceAuthentication(): Promise<void> {
    this.logger.info('Forcing authentication for all adapters...');
    const promises: Promise<void>[] = [];

    for (const [sourceId, adapter] of this.adapters.entries()) {
      if (adapter.forceAuthentication) {
        promises.push(
          adapter.forceAuthentication().catch((err) => {
            this.logger.error(`Failed to force auth for source ${sourceId}`, err as Error);
          })
        );
      }
    }

    await Promise.all(promises);
    this.logger.info('Authentication refresh completed');
  }

  // ===== Bundle Management =====

  /**
   * Search for bundles across all enabled sources
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `searchRegistryBundles`
   * — this function has no reference-branch counterpart (see its own module header), so it was
   * designed from scratch here following this migration's established
   * `registry/*` port-orchestration pattern, porting this method's
   * (plus the now-removed private `sortBundles` helper's) exact prior
   * behavior.
   * @param query - Search query options
   * @param query.sourceId - Optional source ID to limit search to a specific source
   * @param query.cacheOnly - If true, only return cached bundles without fetching from network.
   *                         Useful for fast initial UI loads where network fetches happen separately via syncSource.
   * @returns Promise resolving to array of matching bundles
   */
  public async searchBundles(query: SearchQuery): Promise<Bundle[]> {
    // Unlike installBundle/updateBundle, no `as X` cast is needed here:
    // core's Bundle has no loose nested fields (cf. InstalledBundle's
    // mcpServers) — it's structurally identical to this extension's own
    // Bundle type outright.
    return searchRegistryBundles(
      query,
      {
        listSources: () => this.storage.getSources(),
        getCachedSourceBundles: (sourceId) => this.storage.getCachedSourceBundles(sourceId),
        cacheSourceBundles: (sourceId, bundles) => this.storage.cacheSourceBundles(sourceId, bundles),
        getAdapter: (source) => this.getAdapter(source),
        consolidateBundles: (bundles) => this.versionConsolidator.consolidateBundles(bundles)
      },
      (event) => this.forwardLogEvent(event)
    );
  }

  /**
   * Get bundle details
   * @param bundleId
   */
  public async getBundleDetails(bundleId: string): Promise<Bundle> {
    // Try cache first
    const cached = await this.storage.getCachedBundleMetadata(bundleId);

    if (cached) {
      return cached;
    }

    // Search all sources (cache only to avoid blocking)
    const bundles = await this.searchBundles({ cacheOnly: true });

    // Try exact match first
    let bundle = bundles.find((b) => b.id === bundleId);

    // If not found, try identity matching for GitHub bundles
    if (!bundle) {
      const sources = await this.storage.getSources();

      // Check if bundleId has version suffix (versioned ID case)
      const hasVersionSuffix = bundleId.match(/-v?\d+\.\d+\.\d+(-[\w.]+)?$/);

      bundle = hasVersionSuffix
        ? bundles.find((b) => {
          const source = sources.find((s) => s.id === b.sourceId);
          if (source?.type === 'github') {
            const bundleIdentity = VersionManager.extractBundleIdentity(bundleId, 'github');
            const sourceIdentity = VersionManager.extractBundleIdentity(b.id, 'github');
            return bundleIdentity === sourceIdentity;
          }
          return false;
        })
        : bundles.find((b) => {
          const source = sources.find((s) => s.id === b.sourceId);
          if (source?.type === 'github') {
            const identity = VersionManager.extractBundleIdentity(b.id, 'github');
            return identity === bundleId;
          }
          return false;
        });
    }

    if (!bundle) {
      throw new Error(`Bundle '${bundleId}' not found`);
    }

    return bundle;
  }

  /**
   * Install a bundle
   * @param bundleId
   * @param options
   * @param silent
   */
  public async installBundle(bundleId: string, options: InstallOptions, silent = false): Promise<InstalledBundle> {
    // See uninstallBundle's identical, documented `as InstalledBundle` cast:
    // core's DeploymentManifest.mcpServers is intentionally looser than this
    // extension's McpServersManifest; the data itself is always this
    // extension's own shape here too, since it only ever flows from
    // RegistryStorage/BundleInstaller below.
    const installation = await installRegistryBundle(
      bundleId,
      options,
      {
        getBundleDetails: (id) => this.getBundleDetails(id),
        listSources: () => this.storage.getSources(),
        getCachedSourceBundles: (sourceId) => this.storage.getCachedSourceBundles(sourceId),
        getBundleVersion: (identity, version) => this.versionConsolidator.getBundleVersion(identity, version),
        getInstalledBundle: (id, scope) => this.storage.getInstalledBundle(id, scope),
        getAdapter: (source) => this.getAdapter(source),
        installFromBuffer: (bundle, buffer, installOptions, sourceType) =>
          this.installer.installFromBuffer(bundle, buffer, installOptions, sourceType),
        installLocalSkillAsSymlink: (bundle, skillName, sourcePath, installOptions) =>
          this.installer.installLocalSkillAsSymlink(bundle, skillName, sourcePath, installOptions),
        recordInstallation: (installedBundle) => this.storage.recordInstallation(installedBundle as InstalledBundle),
        getInstalledBundles: (scope) => this.storage.getInstalledBundles(scope),
        removeInstallation: (id, scope) => this.storage.removeInstallation(id, scope)
      },
      (event) => this.forwardLogEvent(event)
    ) as InstalledBundle;

    if (!silent) {
      this._onBundleInstalled.fire(installation);
    }

    return installation;
  }

  /**
   * Install multiple bundles in parallel
   * @param bundles
   */
  public async installBundles(bundles: { bundleId: string; options: InstallOptions }[]): Promise<void> {
    const installed: InstalledBundle[] = [];
    const CONCURRENCY_LIMIT = CONCURRENCY_CONSTANTS.REGISTRY_BATCH_LIMIT;

    this.logger.info(`Batch installing ${bundles.length} bundles...`);

    for (let i = 0; i < bundles.length; i += CONCURRENCY_LIMIT) {
      const chunk = bundles.slice(i, i + CONCURRENCY_LIMIT);

      const results = await Promise.all(chunk.map(async (b) => {
        try {
          return await this.installBundle(b.bundleId, b.options, true);
        } catch (error) {
          this.logger.error(`Failed to install bundle ${b.bundleId}`, error as Error);
          return null;
        }
      }));

      for (const result of results) {
        if (result) {
          installed.push(result);
        }
      }
    }

    if (installed.length > 0) {
      this._onBundlesInstalled.fire(installed);
      this.logger.info(`Batch installation complete: ${installed.length}/${bundles.length} bundles installed`);
    }
  }

  /**
   * Uninstall a bundle
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `uninstallInstalledBundle`
   * @param bundleId
   * @param scope
   * @param silent
   */
  public async uninstallBundle(bundleId: string, scope: InstallationScope = 'user', silent = false): Promise<void> {
    const installed = await uninstallInstalledBundle(
      bundleId,
      scope,
      {
        getInstalledBundle: (id, s) => this.storage.getInstalledBundle(id, s),
        getRepositoryInstalledBundles: async () => {
          const workspaceRoot = getWorkspaceRoot();
          if (!workspaceRoot) {
            throw new Error('Cannot uninstall repository-scoped bundle: no workspace is open');
          }
          // Use getInstalledBundles() to search both main and local lockfiles
          const lockfileManager = LockfileManager.getInstance(workspaceRoot);
          return lockfileManager.getInstalledBundles();
        },
        listSources: () => this.storage.getSources(),
        // `core`'s `DeploymentManifest.mcpServers` is intentionally looser
        // (`Record<string, unknown>`) than this extension's `McpServersManifest`
        // (see `listInstalledBundles`'s identical, already-documented cast above) —
        // the data itself is always this extension's own shape here too, since it
        // only ever flows from `RegistryStorage`/`LockfileManager` above.
        uninstall: (installedBundle) => this.installer.uninstall(installedBundle as InstalledBundle),
        uninstallSkillSymlink: (installedBundle) => this.installer.uninstallSkillSymlink(installedBundle as InstalledBundle),
        removeInstallation: (id, s) => this.storage.removeInstallation(id, s)
      },
      (event) => this.forwardLogEvent(event)
    );

    if (!silent) {
      this._onBundleUninstalled.fire(installed.bundleId);
    }
  }

  /**
   * Uninstall multiple bundles in parallel
   * @param bundleIds
   * @param scope
   */
  public async uninstallBundles(bundleIds: string[], scope: InstallationScope = 'user'): Promise<void> {
    const uninstalled: string[] = [];
    const CONCURRENCY_LIMIT = CONCURRENCY_CONSTANTS.REGISTRY_BATCH_LIMIT;

    this.logger.info(`Batch uninstalling ${bundleIds.length} bundles...`);

    for (let i = 0; i < bundleIds.length; i += CONCURRENCY_LIMIT) {
      const chunk = bundleIds.slice(i, i + CONCURRENCY_LIMIT);

      const results = await Promise.all(chunk.map(async (id) => {
        try {
          await this.uninstallBundle(id, scope, true);
          return id;
        } catch (error) {
          this.logger.error(`Failed to uninstall bundle ${id}`, error as Error);
          return null;
        }
      }));

      for (const result of results) {
        if (result) {
          uninstalled.push(result);
        }
      }
    }

    if (uninstalled.length > 0) {
      this._onBundlesUninstalled.fire(uninstalled);
      this.logger.info(`Batch uninstallation complete: ${uninstalled.length}/${bundleIds.length} bundles uninstalled`);
    }
  }

  /**
   * Update a bundle
   * @param bundleId
   * @param version
   */
  public async updateBundle(bundleId: string, version?: string): Promise<void> {
    // See installBundle's identical, documented `as InstalledBundle` cast:
    // core's DeploymentManifest.mcpServers is intentionally looser than this
    // extension's McpServersManifest; the data itself is always this
    // extension's own shape here too, since it only ever flows from
    // RegistryStorage/BundleInstaller below.
    const updated = await updateRegistryBundle(
      bundleId,
      version,
      {
        listInstalledBundles: () => this.listInstalledBundles(),
        checkLocalModifications: (id, current) => this.checkLocalModificationsBeforeUpdate(id, current as InstalledBundle),
        getBundleDetails: (id) => this.getBundleDetails(id),
        listSources: () => this.storage.getSources(),
        getAdapter: (source) => this.getAdapter(source),
        updateInstalledBundle: (current, bundle, buffer, sourceType) =>
          this.installer.update(current as InstalledBundle, bundle, buffer, sourceType),
        recordInstallation: (installation) => this.storage.recordInstallation(installation as InstalledBundle),
        removeInstallation: (id, scope) => this.storage.removeInstallation(id, scope)
      },
      (event) => this.forwardLogEvent(event)
    ) as InstalledBundle;

    this._onBundleUpdated.fire(updated);
  }

  /**
   * List installed bundles
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `listInstalledBundles`
   * — queries the appropriate source based on scope:
   * - 'repository': Query LockfileManager only
   * - 'user' or 'workspace': Query RegistryStorage only
   * - undefined (no scope): Combine results from both sources
   *
   * Requirements covered:
   * - 1.1: Repository scope queries lockfile
   * - 1.2: Combined scope queries both sources
   * @param scope
   */
  public async listInstalledBundles(scope?: InstallationScope): Promise<InstalledBundle[]> {
    const bundles = await listInstalledBundlesCore(scope, {
      getInstalledBundles: (s) => this.storage.getInstalledBundles(s),
      getRepositoryInstalledBundles: async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          return [];
        }
        try {
          const lockfileManager = LockfileManager.getInstance(workspaceRoot);
          return await lockfileManager.getInstalledBundles();
        } catch (error) {
          this.logger.warn('Failed to query repository bundles from lockfile:', error instanceof Error ? error : undefined);
          return [];
        }
      }
    });
    // `core`'s `DeploymentManifest.mcpServers` is intentionally looser
    // (`Record<string, unknown>`) than this extension's `McpServersManifest`
    // pending a dedicated `domain/mcp` module (see that field's JSDoc in
    // `packages/core/src/domain/collection/types.ts`) — the data itself is
    // always this extension's own shape, since it only ever flows through
    // `RegistryStorage`/`LockfileManager` above and back out.
    return bundles as InstalledBundle[];
  }

  /**
   * Check for bundle updates
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `detectBundleUpdates`
   */
  public async checkUpdates(): Promise<BundleUpdate[]> {
    return detectBundleUpdates(
      {
        getInstalledBundles: (scope) => this.storage.getInstalledBundles(scope),
        getBundleDetails: (bundleId) => this.getBundleDetails(bundleId),
        listSources: () => this.storage.getSources(),
        getInstalledBundle: (bundleId, scope) => this.storage.getInstalledBundle(bundleId, scope)
      },
      (event) => this.forwardLogEvent(event)
    );
  }

  /**
   * Get all available versions for a bundle
   *
   * Queries the version consolidator to retrieve all versions for a given bundle.
   * Falls back to returning only the current version if consolidator is unavailable.
   * @param bundleId - The bundle ID to get versions for
   * @returns Array of version strings in descending order (latest first)
   * @example
   * ```typescript
   * const versions = await registryManager.getAvailableVersions('owner-repo-v2.0.0');
   * // Returns: ['2.0.0', '1.5.0', '1.0.0']
   * ```
   */
  public async getAvailableVersions(bundleId: string): Promise<string[]> {
    try {
      // Get bundle to determine source type
      const bundle = await this.getBundleDetails(bundleId);
      const sources = await this.storage.getSources();
      const source = sources.find((s) => s.id === bundle.sourceId);
      const sourceType = source?.type ?? 'local';

      // Extract identity for version lookup
      const identity = VersionManager.extractBundleIdentity(bundleId, sourceType);

      // Get all versions from consolidator
      const bundleVersions = this.versionConsolidator.getAllVersions(identity);

      if (bundleVersions.length === 0) {
        // If no versions in cache, return current version
        return [bundle.version];
      }

      // Extract version strings (already sorted by consolidator)
      return bundleVersions.map((v) => v.version);
    } catch (error) {
      this.logger.error('Failed to get available versions', error as Error);
      // Fallback: try to get bundle and return its version
      try {
        const bundle = await this.getBundleDetails(bundleId);
        return [bundle.version];
      } catch {
        return [];
      }
    }
  }

  // ===== Profile Management =====

  /**
   * Create a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `createLocalProfile`
   * @param profile
   */
  public async createProfile(profile: Omit<Profile, 'createdAt' | 'updatedAt'>): Promise<Profile> {
    const fullProfile = await createLocalProfile(this.profileStorePorts(), profile);

    this._onProfileCreated.fire(fullProfile);

    return fullProfile;
  }

  /**
   * Update a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `updateLocalProfile`.
   * @param profileId
   * @param updates
   */
  public async updateProfile(profileId: string, updates: Partial<Profile>): Promise<void> {
    const updatedProfile = await updateLocalProfile(this.profileStorePorts(), profileId, updates);

    if (updatedProfile) {
      this._onProfileUpdated.fire(updatedProfile);
    }
  }

  /**
   * Check if a profile is from the active hub (and thus read-only)
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `isHubProfile`.
   * @param profileId
   */
  public async isHubProfile(profileId: string): Promise<boolean> {
    return await isAppHubProfile(this.hubManager, profileId);
  }

  /**
   * Delete a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `deleteLocalProfile`.
   * @param profileId
   */
  public async deleteProfile(profileId: string): Promise<void> {
    await deleteLocalProfile(this.profileStorePorts(), profileId);
    this._onProfileDeleted.fire(profileId);
  }

  /**
   * List only local profiles (from storage, excludes hub profiles)
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `listLocalProfiles`.
   */
  public async listLocalProfiles(): Promise<Profile[]> {
    return await listLocalProfilesCore(this.profileStorePorts());
  }

  /**
   * List all profiles (both hub profiles and local profiles)
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `listAllProfiles`.
   */
  public async listProfiles(): Promise<Profile[]> {
    return await listAllProfiles(
      this.profileStorePorts(),
      this.hubManager,
      (event) => this.forwardLogEvent(event)
    );
  }

  /**
   * Activate a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `activateRegistryProfile`
   * The original's `vscode.window.withProgress` wrapper and `progress.report` calls
   * stay here (presentation-only VS Code glue) — `onLog` forwards
   * `'info'`-level events to the progress notification in addition to
   * the `Logger`, matching the original checkpoint messages.
   * @param profileId
   */
  public async activateProfile(profileId: string): Promise<void> {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Activating Profile',
      cancellable: false
    }, async (progress) => {
      progress.report({ message: 'Preparing...' });

      const result = await activateRegistryProfile(
        {
          getProfiles: () => this.storage.getProfiles(),
          updateProfile: (id, updates) => this.storage.updateProfile(id, updates),
          getSources: () => this.storage.getSources(),
          getInstalledBundles: () => this.storage.getInstalledBundles(),
          searchBundles: (query) => this.searchBundles(query),
          getAdapter: (source) => this.getAdapter(source),
          installFromBuffer: (bundle, buffer, options, sourceType) =>
            this.installer.installFromBuffer(bundle, buffer, options, sourceType),
          recordInstallation: (installation) => this.storage.recordInstallation(installation as InstalledBundle),
          deactivateOther: (id) => this.deactivateProfile(id),
          hub: this.hubManager && {
            listActiveHubProfiles: () => this.hubManager!.listActiveHubProfiles(),
            listAllActiveProfiles: () => this.hubManager!.listAllActiveProfiles(),
            activateProfile: (hubId, id, options) => this.hubManager!.activateProfile(hubId, id, options),
            deactivateProfile: (hubId, id) => this.hubManager!.deactivateProfile(hubId, id)
          }
        },
        profileId,
        (event) => {
          this.forwardLogEvent(event);
          if (event.level === 'info') {
            progress.report({ message: event.message });
          }
        }
      );

      if (result.hubActivation) {
        this._onProfileActivated.fire({ ...result.hubActivation.hubProfile, active: true });
        return;
      }

      if (result.localActivation) {
        this._onProfileActivated.fire(result.localActivation.profile);
        this._onProfileActivated.fire(result.localActivation.profile);

        if (result.localActivation.installedBundles.length > 0) {
          this._onBundlesInstalled.fire(result.localActivation.installedBundles as InstalledBundle[]);
        }
      }
    });
  }

  /**
   * Deactivate a profile and uninstall its bundles
   *
   * Thin delegator to `@ai-primitives-hub/app`'s
   * `deactivateRegistryProfile`.
   * @param profileId
   */
  public async deactivateProfile(profileId: string): Promise<void> {
    await deactivateRegistryProfile(
      {
        getProfiles: () => this.storage.getProfiles(),
        updateProfile: (id, updates) => this.storage.updateProfile(id, updates),
        getInstalledBundles: () => this.storage.getInstalledBundles(),
        uninstallBundles: (bundleIds) => this.uninstallBundles(bundleIds),
        hub: this.hubManager && {
          listActiveHubProfiles: () => this.hubManager!.listActiveHubProfiles(),
          listAllActiveProfiles: () => this.hubManager!.listAllActiveProfiles(),
          activateProfile: (hubId, id, options) => this.hubManager!.activateProfile(hubId, id, options),
          deactivateProfile: (hubId, id) => this.hubManager!.deactivateProfile(hubId, id)
        }
      },
      profileId,
      (event) => this.forwardLogEvent(event)
    );

    this._onProfileDeactivated.fire(profileId);
  }

  /**
   * Export a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `exportLocalProfile`.
   * @param profileId
   */
  public async exportProfile(profileId: string): Promise<string> {
    return await exportLocalProfile(this.profileStorePorts(), profileId);
  }

  /**
   * Import a profile
   *
   * Thin delegator to `@ai-primitives-hub/app`'s `importLocalProfile`.
   * @param profileData
   */
  public async importProfile(profileData: string): Promise<Profile> {
    return await importLocalProfile(this.profileStorePorts(), profileData);
  }

  /**
   * Export complete registry settings (sources + profiles + configuration)
   *
   * Thin delegator to `@ai-primitives-hub/app`'s
   * `exportRegistrySettings`.
   * @param format
   */
  public async exportSettings(format: ExportFormat = 'json'): Promise<string> {
    return await exportRegistrySettings(this.settingsPorts(), format);
  }

  /**
   * Import registry settings (sources + profiles + configuration)
   *
   * Thin delegator to `@ai-primitives-hub/app`'s
   * `importRegistrySettings`.
   * @param data
   * @param format
   * @param strategy
   */
  public async importSettings(
    data: string,
    format: ExportFormat = 'json',
    strategy: ImportStrategy = 'merge'
  ): Promise<void> {
    await importRegistrySettings(this.settingsPorts(), data, format, strategy, (event) => this.forwardLogEvent(event));
  }

  /**
   * Get bundle name by ID
   * Looks up the bundle name from installed bundles or bundle metadata
   * @param bundleId
   */
  public async getBundleName(bundleId: string): Promise<string> {
    try {
      // First try to get from installed bundles (user scope)
      let installed = await this.storage.getInstalledBundle(bundleId, 'user');

      // If not in user scope, try workspace scope
      installed ??= await this.storage.getInstalledBundle(bundleId, 'workspace');

      // If found in installed bundles, get name from metadata or manifest description
      if (installed?.manifest?.metadata?.description) {
        // Try to extract a clean name from the description or use bundleId
        // For now, we'll try to get it from bundle details
        const { name } = await this.getBundleDetails(bundleId) || {};
        return name || bundleId;
      }

      // Try to get from bundle details
      const bundle = await this.getBundleDetails(bundleId);
      return bundle?.name || bundleId;
    } catch (error) {
      this.logger.debug(`Could not resolve bundle name for '${bundleId}': ${error}`);
      return bundleId;
    }
  }

  /**
   * Handle workspace folder changes
   *
   * Called when workspace folders are added, removed, or changed.
   * Fires the repositoryBundlesChanged event to trigger UI refresh.
   *
   * Requirements covered:
   * - 4.3: Workspace change triggers refresh
   */
  public handleWorkspaceFoldersChanged(): void {
    this.logger.info('Workspace folders changed, refreshing repository bundles');
    this._onRepositoryBundlesChanged.fire();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._onBundleInstalled.dispose();
    this._onBundleUninstalled.dispose();
    this._onBundleUpdated.dispose();
    this._onBundlesInstalled.dispose();
    this._onBundlesUninstalled.dispose();
    this._onProfileActivated.dispose();
    this._onProfileCreated.dispose();
    this._onProfileUpdated.dispose();
    this._onProfileDeleted.dispose();
    this._onSourceAdded.dispose();
    this._onSourceRemoved.dispose();
    this._onSourceUpdated.dispose();
    this._onSourceSynced.dispose();
    this._onAutoUpdatePreferenceChanged.dispose();
    this._onRepositoryBundlesChanged.dispose();
    this._onReadmeDownloaded.dispose();
    this._onReadmeDownloadComplete.dispose();
  }
}
