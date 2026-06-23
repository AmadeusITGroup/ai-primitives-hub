/**
 * Main Registry Manager
 * Orchestrates all registry operations including sources, bundles, profiles, and installations
 */

import * as vscode from 'vscode';
import {
  ApmAdapter,
} from '../adapters/apm-adapter';
import {
  AwesomeCopilotAdapter,
} from '../adapters/awesome-copilot-adapter';
import {
  GitHubAdapter,
} from '../adapters/github-adapter';
import {
  LocalAdapter,
} from '../adapters/local-adapter';
import {
  LocalApmAdapter,
} from '../adapters/local-apm-adapter';
import {
  LocalAwesomeCopilotAdapter,
} from '../adapters/local-awesome-copilot-adapter';
import {
  LocalSkillsAdapter,
} from '../adapters/local-skills-adapter';
import {
  IRepositoryAdapter,
  RepositoryAdapterFactory,
} from '../adapters/repository-adapter';
import {
  SkillsAdapter,
} from '../adapters/skills-adapter';
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
  ProfileBundle,
  RegistrySource,
  SearchQuery,
  SourceSyncedEvent,
  SourceType,
  ValidationResult,
} from '../types/registry';
import {
  ExportedSettings,
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

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.storage = new RegistryStorage(context);
    this.installer = new BundleInstaller(context);
    this.logger = Logger.getInstance();

    // Initialize version consolidator with source type resolver
    this.versionConsolidator = new VersionConsolidator();
    this.versionConsolidator.setSourceTypeResolver((sourceId: string) => this.getSourceType(sourceId));

    // Register default adapters
    RepositoryAdapterFactory.register('github', GitHubAdapter);
    RepositoryAdapterFactory.register('local', LocalAdapter);
    RepositoryAdapterFactory.register('awesome-copilot', AwesomeCopilotAdapter);
    RepositoryAdapterFactory.register('local-awesome-copilot', LocalAwesomeCopilotAdapter);
    RepositoryAdapterFactory.register('local-apm', LocalApmAdapter);
    RepositoryAdapterFactory.register('apm', ApmAdapter);
    RepositoryAdapterFactory.register('skills', SkillsAdapter);
    RepositoryAdapterFactory.register('local-skills', LocalSkillsAdapter);
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
          const adapter = RepositoryAdapterFactory.create(enrichedSource);
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
      adapter = RepositoryAdapterFactory.create(enrichedSource);
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
   * Clean up old versions of a bundle when a new version is installed
   * This handles downgrades and version changes by removing previous installation records
   * @param bundle The newly installed bundle
   * @param scope The installation scope (user, workspace, or repository)
   */
  private async cleanupOldVersions(bundle: Bundle, scope: InstallationScope): Promise<void> {
    // Repository scope cleanup is handled by LockfileManager
    if (scope === 'repository') {
      return;
    }
    try {
      // Get source information to determine sourceType
      const source = await this.getSourceForBundle(bundle);
      const sourceType = source.type;

      // Get the base bundle identity (without version suffix)
      const baseIdentity = VersionManager.extractBundleIdentity(bundle.id, sourceType);

      // Get all installed bundles in this scope
      // OPTIMIZATION: Filter early by sourceId to reduce iterations
      const allInstalled = await this.storage.getInstalledBundles(scope);
      const candidateBundles = allInstalled.filter((installed) => installed.sourceId === bundle.sourceId);

      // Find all installations that match this bundle's identity
      const oldInstallations = candidateBundles.filter((installed) => {
        const installedSourceType = (installed.sourceType as SourceType) || 'github';

        return VersionManager.isSameBundleIdentity(
          installed.bundleId,
          installedSourceType,
          bundle.id,
          sourceType
        ) && installed.version !== bundle.version;
      });

      // Remove old versions
      for (const oldInstall of oldInstallations) {
        this.logger.debug(`Removing old version ${oldInstall.version} of bundle ${baseIdentity}`);
        await this.storage.removeInstallation(oldInstall.bundleId, scope);
      }

      if (oldInstallations.length > 0) {
        this.logger.info(`Cleaned up ${oldInstallations.length} old version(s) of bundle ${baseIdentity}`);
      }
    } catch (error) {
      // Log but don't fail if cleanup fails - the new version is already installed
      this.logger.warn(`Failed to cleanup old versions: ${(error as Error).message}`);
    }
  }

  /**
   * Check existing installation and determine if installation should proceed
   * Returns modified options if version change is detected
   * @param bundleId
   * @param bundle
   * @param options
   */
  private async checkExistingInstallation(
    bundleId: string,
    bundle: Bundle,
    options: InstallOptions
  ): Promise<InstallOptions> {
    const existing = await this.storage.getInstalledBundle(bundleId, options.scope);

    if (!existing || options.force) {
      return options;
    }

    // If a different version is being installed, allow it (treat as version change)
    if (existing.version !== bundle.version) {
      this.logger.info(`Version change detected: ${existing.version} → ${bundle.version}`);
      return { ...options, force: true };
    }

    throw new Error(`Bundle '${bundleId}' is already installed. Use force=true to reinstall.`);
  }

  /**
   * Resolve the bundle to install, handling version-specific requests
   * @param bundleId
   * @param options
   */
  private async resolveInstallationBundle(
    bundleId: string,
    options: InstallOptions
  ): Promise<Bundle> {
    // Try exact versioned bundle first if applicable
    if (options.version && BundleIdentityMatcher.hasVersionSuffix(bundleId)) {
      const exactBundle = await this.tryGetExactVersionedBundle(bundleId, options.version);
      if (exactBundle) {
        return exactBundle;
      }
    }

    // Fall back to identity-based search
    return await this.resolveByIdentity(bundleId, options);
  }

  /**
   * Try to get an exact versioned bundle
   * Returns null if not found or version doesn't match
   * @param bundleId
   * @param version
   */
  private async tryGetExactVersionedBundle(bundleId: string, version: string): Promise<Bundle | null> {
    try {
      const bundle = await this.getBundleDetails(bundleId);
      if (bundle.version === version) {
        return bundle;
      }
      this.logger.debug(`Bundle ${bundleId} found but version mismatch: ${bundle.version} !== ${version}`);
      return null;
    } catch {
      this.logger.debug(`Exact bundle ${bundleId} not found, trying identity-based search`);
      return null;
    }
  }

  /**
   * Resolve bundle by identity, applying version override if needed
   * @param bundleId
   * @param options
   */
  private async resolveByIdentity(bundleId: string, options: InstallOptions): Promise<Bundle> {
    const searchId = await this.determineSearchId(bundleId, options);
    let bundle = await this.getBundleDetails(searchId);

    if (options.version) {
      bundle = await this.applyVersionOverride(bundle, bundleId, options.version);
    }

    return bundle;
  }

  /**
   * Determine the search ID for bundle lookup
   * @param bundleId
   * @param options
   */
  private async determineSearchId(bundleId: string, options: InstallOptions): Promise<string> {
    if (!options.version) {
      return bundleId;
    }

    // For version-specific requests, try to extract identity
    const sources = await this.storage.getSources();
    for (const source of sources) {
      const cachedBundles = await this.storage.getCachedSourceBundles(source.id);
      const matchingBundle = cachedBundles.find((b) => b.id === bundleId);
      if (matchingBundle) {
        return VersionManager.extractBundleIdentity(bundleId, source.type);
      }
    }

    return bundleId;
  }

  /**
   * Apply version override to bundle
   * @param bundle
   * @param originalBundleId
   * @param requestedVersion
   */
  private async applyVersionOverride(
    bundle: Bundle,
    originalBundleId: string,
    requestedVersion: string
  ): Promise<Bundle> {
    const sources = await this.storage.getSources();
    const source = sources.find((s) => s.id === bundle.sourceId);

    if (!source) {
      this.logger.warn('Source not found for version override, using latest');
      return bundle;
    }

    const identity = VersionManager.extractBundleIdentity(originalBundleId, source.type);
    const specificVersion = this.versionConsolidator.getBundleVersion(identity, requestedVersion);

    if (specificVersion) {
      this.logger.info(`Installing specific version ${requestedVersion} instead of latest ${bundle.version}`);
      // Use the original bundle ID from the version cache to preserve the correct format
      // (e.g., owner-repo-v1.0.0 instead of owner-repo-1.0.0)
      return {
        ...bundle,
        id: specificVersion.bundleId,
        version: specificVersion.version,
        downloadUrl: specificVersion.downloadUrl,
        manifestUrl: specificVersion.manifestUrl,
        lastUpdated: specificVersion.publishedAt
      };
    }

    this.logger.warn(`Requested version ${requestedVersion} not found, using latest ${bundle.version}`);
    return bundle;
  }

  /**
   * Get source for a bundle
   * @param bundle
   */
  private async getSourceForBundle(bundle: Bundle): Promise<RegistrySource> {
    const sources = await this.storage.getSources();
    const source = sources.find((s) => s.id === bundle.sourceId);

    if (!source) {
      throw new Error(`Source '${bundle.sourceId}' not found`);
    }

    return source;
  }

  /**
   * Download and install a bundle
   * @param bundle
   * @param source
   * @param options
   */
  private async downloadAndInstall(
    bundle: Bundle,
    source: RegistrySource,
    options: InstallOptions
  ): Promise<InstalledBundle> {
    const adapter = this.getAdapter(source);

    // For local-skills, use symlink installation instead of copying
    if (source.type === 'local-skills') {
      this.logger.debug(`Installing local skill as symlink from ${source.type} adapter`);
      const localSkillsAdapter = adapter as any;

      if (typeof localSkillsAdapter.getSkillSourcePath === 'function'
        && typeof localSkillsAdapter.getSkillName === 'function') {
        const skillSourcePath = localSkillsAdapter.getSkillSourcePath(bundle);
        const skillName = localSkillsAdapter.getSkillName(bundle);

        const localSkillSymlink = await this.installer.installLocalSkillAsSymlink(
          bundle,
          skillName,
          skillSourcePath,
          options
        );

        // Ensure sourceId and sourceType are set
        localSkillSymlink.sourceId = bundle.sourceId;
        localSkillSymlink.sourceType = source.type;

        if (options.profileId) {
          localSkillSymlink.profileId = options.profileId;
        }

        return localSkillSymlink;
      }
      // Fall through to standard installation if methods not available
      this.logger.warn(`LocalSkillsAdapter missing symlink methods, falling back to standard installation`);
    }

    // Unified download path: all adapters use downloadBundle()
    this.logger.debug(`Downloading bundle from ${source.type} adapter`);
    const bundleBuffer = await adapter.downloadBundle(bundle);
    this.logger.debug(`Bundle downloaded: ${bundleBuffer.length} bytes`);

    // Install from buffer
    const installation: InstalledBundle = await this.installer.installFromBuffer(bundle, bundleBuffer, options, source.type);

    // Add profileId if provided
    if (options.profileId) {
      installation.profileId = options.profileId;
    }

    // Ensure sourceId and sourceType are set for identity matching
    installation.sourceId = bundle.sourceId;
    installation.sourceType = source.type;

    return installation;
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

  /**
   * Validate and normalize profile ID
   * @param profileId
   */
  private validateProfileId(profileId: any): string {
    if (typeof profileId !== 'string') {
      const profileObj = profileId;
      if (profileObj && typeof profileObj === 'object' && profileObj.id) {
        this.logger.warn('Profile object passed to activateProfile, extracting ID');
        return profileObj.id;
      }
      throw new Error(`Invalid profile identifier: expected string, got ${typeof profileId}`);
    }
    return profileId;
  }

  /**
   * Deactivate all active profiles except the target
   * @param targetProfileId
   * @param progress
   */
  private async deactivateOtherProfiles(targetProfileId: string, progress: vscode.Progress<any>): Promise<void> {
    const profiles = await this.storage.getProfiles();
    progress.report({ message: 'Checking for active profiles...' });

    for (const profile of profiles) {
      if (profile.active && profile.id !== targetProfileId) {
        this.logger.info(`Deactivating previous profile: ${profile.id}`);
        try {
          await this.deactivateProfile(profile.id);
        } catch (error) {
          this.logger.error(`Failed to deactivate profile ${profile.id}`, error as Error);
        }
      }
    }
  }

  /**
   * Get profile by ID or throw error
   * @param profileId
   */
  private async getProfileById(profileId: string): Promise<Profile> {
    const profiles = await this.storage.getProfiles();
    const profile = profiles.find((p) => p.id === profileId);

    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    return profile;
  }

  /**
   * Install all bundles associated with a profile
   * @param profile
   * @param profileId
   * @param progress
   */
  private async installProfileBundles(
    profile: Profile,
    profileId: string,
    progress: vscode.Progress<any>
  ): Promise<void> {
    if (!profile.bundles || profile.bundles.length === 0) {
      return;
    }

    progress.report({ message: `Installing ${profile.bundles.length} bundle(s)...` });
    this.logger.info(`Installing ${profile.bundles.length} bundles for profile '${profileId}'`);

    const allSources = await this.storage.getSources();
    const installed: InstalledBundle[] = [];
    const CONCURRENCY_LIMIT = CONCURRENCY_CONSTANTS.REGISTRY_BATCH_LIMIT;

    for (let i = 0; i < profile.bundles.length; i += CONCURRENCY_LIMIT) {
      const chunk = profile.bundles.slice(i, i + CONCURRENCY_LIMIT);

      const results = await Promise.all(chunk.map(async (bundleRef) => {
        progress.report({ message: `Installing ${bundleRef.id}...` });
        try {
          return await this.installProfileBundle(bundleRef, profileId, allSources, true);
        } catch (error) {
          this.logger.error(`Failed to install bundle ${bundleRef.id}`, error as Error);
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
    }

    this.logger.info(`Profile bundle installation complete: ${installed.length} installed`);
  }

  /**
   * Install a single bundle for a profile
   * @param bundleRef
   * @param profileId
   * @param allSources
   * @param silent
   */
  private async installProfileBundle(
    bundleRef: ProfileBundle,
    profileId: string,
    allSources: RegistrySource[],
    silent = false
  ): Promise<InstalledBundle | null> {
    // Check if bundle is already installed
    const installedBundles = await this.storage.getInstalledBundles();
    const alreadyInstalled = installedBundles.find((b) => b.bundleId === bundleRef.id);

    if (alreadyInstalled) {
      this.logger.info(`Bundle ${bundleRef.id} already installed, skipping`);
      return null;
    }

    // Search for the bundle
    this.logger.info(`Searching for bundle: ${bundleRef.id} v${bundleRef.version}`);
    const queryBySourceAndBundleId = { text: bundleRef.id, tags: [], sourceId: bundleRef.sourceId };
    const searchResults = await this.searchBundles(queryBySourceAndBundleId);
    this.logger.info(`Found ${searchResults.length} matching bundles.`, searchResults);

    // Find matching bundle
    const matchingBundle = searchResults.find((b) => {
      const idMatch = b.id === bundleRef.id || b.name.toLowerCase().includes(bundleRef.id.toLowerCase());
      if (bundleRef.sourceId) {
        return idMatch && b.sourceId === bundleRef.sourceId;
      }
      return idMatch;
    });

    if (!matchingBundle) {
      this.logger.warn(`Bundle not found: ${bundleRef.id}`);
      return null;
    }

    // Get source and adapter
    const source = allSources.find((s) => s.id === matchingBundle.sourceId);
    if (!source) {
      this.logger.warn(`Source not found for bundle: ${matchingBundle.sourceId}`);
      return null;
    }

    const adapter = this.getAdapter(source);

    // Download and install
    this.logger.info(`Installing bundle: ${matchingBundle.id} from source ${matchingBundle.sourceId}`);
    this.logger.debug(`Downloading bundle from ${source.type} adapter`);

    const bundleBuffer = await adapter.downloadBundle(matchingBundle);
    this.logger.debug(`Bundle downloaded: ${bundleBuffer.length} bytes`);

    const options: InstallOptions = {
      scope: 'user',
      force: false,
      profileId: profileId
    };

    const installation: InstalledBundle = await this.installer.installFromBuffer(matchingBundle, bundleBuffer, options, source.type);

    // Ensure sourceId and sourceType are set for identity matching
    installation.sourceId = matchingBundle.sourceId;
    installation.sourceType = source.type;

    // Record installation and fire event
    await this.storage.recordInstallation(installation);

    if (!silent) {
      this._onBundleInstalled.fire(installation);
    }

    this.logger.info(`Successfully installed: ${matchingBundle.id}`);

    return installation;
  }
  // ===== Helper Methods =====

  /**
   * Sort bundles by criteria
   * @param bundles
   * @param sortBy
   */
  private sortBundles(bundles: Bundle[], sortBy: string): Bundle[] {
    switch (sortBy) {
      case 'downloads': {
        return bundles.toSorted((a, b) => (b.downloads || 0) - (a.downloads || 0));
      }
      case 'rating': {
        return bundles.toSorted((a, b) => (b.rating || 0) - (a.rating || 0));
      }
      case 'recent': {
        return bundles.toSorted((a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
        );
      }
      default: {
        return bundles;
      }
    }
  }

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
    if (adapter && adapter instanceof GitHubAdapter) {
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
    const adapter = RepositoryAdapterFactory.create(enrichedSource);
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
      const adapter = RepositoryAdapterFactory.create(enrichedSource);
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
    const bundles = await adapter.fetchBundles();

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
  }

  /**
   * Validate a source
   * @param source
   */
  public async validateSource(source: RegistrySource): Promise<ValidationResult> {
    const enrichedSource = this.enrichSourceWithGlobalToken(source);
    const adapter = RepositoryAdapterFactory.create(enrichedSource);
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
   * @param query - Search query options
   * @param query.sourceId - Optional source ID to limit search to a specific source
   * @param query.cacheOnly - If true, only return cached bundles without fetching from network.
   *                         Useful for fast initial UI loads where network fetches happen separately via syncSource.
   * @returns Promise resolving to array of matching bundles
   */
  public async searchBundles(query: SearchQuery): Promise<Bundle[]> {
    this.logger.info('Searching bundles', query);

    const sources = await this.storage.getSources();
    const allBundles: Bundle[] = [];

    // Filter sources if specified
    const sourcesToSearch = query.sourceId
      ? sources.filter((s) => s.id === query.sourceId)
      : sources.filter((s) => s.enabled);

    this.logger.info(`Searching in ${sourcesToSearch.length} sources`);

    for (const source of sourcesToSearch) {
      try {
        // Try cache first
        let bundles = await this.storage.getCachedSourceBundles(source.id);

        // If cache empty and not in cacheOnly mode, fetch from source
        if (bundles.length === 0 && !query.cacheOnly) {
          const adapter = this.getAdapter(source);
          bundles = await adapter.fetchBundles();
          await this.storage.cacheSourceBundles(source.id, bundles);
        }

        allBundles.push(...bundles);
      } catch (error) {
        this.logger.error(`Failed to fetch bundles from source '${source.id}'`, error as Error);
      }
    }

    // Apply version consolidation for GitHub sources
    let results = allBundles;
    try {
      // Consolidate bundles (only GitHub bundles will be consolidated)
      // Source type resolver is already configured in constructor
      results = this.versionConsolidator.consolidateBundles(allBundles);
      this.logger.debug(`Consolidated ${allBundles.length} bundles into ${results.length} entries`);
    } catch (error) {
      this.logger.error('Version consolidation failed, using unconsolidated bundles', error as Error);
      // Fall back to unconsolidated bundles on error
      results = allBundles;
    }

    // Apply filters
    if (query.text) {
      const searchText = query.text.toLowerCase();
      results = results.filter((b) =>
        b.id === query.text
        || b.name.toLowerCase().includes(searchText)
        || b.description.toLowerCase().includes(searchText)
      );
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((b) =>
        query.tags!.some((tag) => b.tags.includes(tag))
      );
    }

    if (query.author) {
      results = results.filter((b) => b.author === query.author);
    }

    if (query.environment) {
      results = results.filter((b) => b.environments.includes(query.environment!));
    }

    // Sort results
    if (query.sortBy) {
      results = this.sortBundles(results, query.sortBy);
    }

    // Apply pagination
    if (query.offset !== undefined || query.limit !== undefined) {
      const offset = query.offset || 0;
      const limit = query.limit || 50;
      results = results.slice(offset, offset + limit);
    }

    return results;
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
    this.logger.info(`Installing bundle: ${bundleId}`, options);

    // Resolve the bundle to install (handles version-specific requests)
    const bundle = await this.resolveInstallationBundle(bundleId, options);

    // Check existing installation and determine if we should proceed
    const installOptions = await this.checkExistingInstallation(bundleId, bundle, options);

    // Get source
    const source = await this.getSourceForBundle(bundle);

    // Download and install
    const installation = await this.downloadAndInstall(bundle, source, installOptions);

    // Record installation FIRST (before cleanup) to ensure metadata is safe
    // If anything fails here, old versions remain and can be used as fallback
    // Note: Repository scope bundles are tracked via LockfileManager, not RegistryStorage
    // The lockfile is already updated by BundleInstaller during installation
    if (options.scope !== 'repository') {
      await this.storage.recordInstallation(installation);
    }

    // Clean up old versions AFTER successful recording
    // This ensures we don't lose the old version if recording fails
    await this.cleanupOldVersions(bundle, options.scope);

    if (!silent) {
      this._onBundleInstalled.fire(installation);
    }
    this.logger.info(`Bundle '${bundleId}' installed successfully`);

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
   * @param bundleId
   * @param scope
   * @param silent
   */
  public async uninstallBundle(bundleId: string, scope: InstallationScope = 'user', silent = false): Promise<void> {
    this.logger.info(`Uninstalling bundle: ${bundleId}`);

    // Get installation record - repository scope uses LockfileManager
    let installed: InstalledBundle | undefined;

    if (scope === 'repository') {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error('Cannot uninstall repository-scoped bundle: no workspace is open');
      }

      const lockfileManager = LockfileManager.getInstance(workspaceRoot);

      // Use getInstalledBundles() to search both main and local lockfiles
      const installedBundles = await lockfileManager.getInstalledBundles();
      installed = installedBundles.find((b) => b.bundleId === bundleId);
    } else {
      installed = await this.storage.getInstalledBundle(bundleId, scope);
    }

    if (!installed) {
      throw new Error(`Bundle '${bundleId}' is not installed in ${scope} scope`);
    }

    // Get source information for post-uninstall hooks
    let source: RegistrySource | undefined;
    const installedSourceId = installed.sourceId;
    if (installedSourceId) {
      const sources = await this.storage.getSources();
      source = sources.find((s) => s.id === installedSourceId);
    }

    // For local-skills, use symlink uninstallation (removes symlink, not source directory)
    if (installed.sourceType === 'local-skills' || source?.type === 'local-skills') {
      this.logger.debug(`Uninstalling local skill symlink: ${bundleId}`);
      await this.installer.uninstallSkillSymlink(installed);
    } else {
      // Uninstall using BundleInstaller
      await this.installer.uninstall(installed);
    }

    // Remove installation record using the stored bundle ID from the installation record
    // This ensures we remove the correct record even for versioned bundles
    // Note: For repository scope, the lockfile is updated by BundleInstaller.uninstall()
    // Repository scope bundles are tracked via LockfileManager, not RegistryStorage
    if (scope !== 'repository') {
      await this.storage.removeInstallation(installed.bundleId, scope);
    }

    if (!silent) {
      this._onBundleUninstalled.fire(installed.bundleId);
    }
    this.logger.info(`Bundle '${installed.bundleId}' uninstalled successfully`);
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
    this.logger.info(`Updating bundle: ${bundleId} to version: ${version || 'latest'}`);

    // Get current installation - use listInstalledBundles to include repository-scoped bundles
    const allInstalled = await this.listInstalledBundles();
    const current = allInstalled.find((b) => b.bundleId === bundleId);

    if (!current) {
      throw new Error(`Bundle '${bundleId}' is not installed`);
    }

    // For repository-scoped bundles, check for local modifications before updating
    // Requirements: 14.1-14.10
    await this.checkLocalModificationsBeforeUpdate(bundleId, current);

    // Get new bundle details
    // Extract identity for GitHub bundles to find the latest version
    const identity = current.sourceType === 'github'
      ? VersionManager.extractBundleIdentity(bundleId, 'github')
      : bundleId.replace(/-v?\d+\.\d+\.\d+(-[\w.]+)?$/, '');

    let bundle: Bundle;
    if (version) {
      // Search for the specific version
      const versionedId = `${identity}-${version}`;

      try {
        bundle = await this.getBundleDetails(versionedId);
      } catch {
        // If versioned ID not found, try the identity
        this.logger.warn(`Bundle '${versionedId}' not found, trying identity '${identity}'`);
        bundle = await this.getBundleDetails(identity);
        // Verify the version matches
        if (bundle.version !== version) {
          throw new Error(`Requested version ${version} not found for bundle '${identity}'`);
        }
      }
    } else {
      // Try to get bundle by identity first (for GitHub bundles with versions)
      try {
        bundle = await this.getBundleDetails(identity);
        this.logger.debug(`Found bundle by identity: ${identity} -> ${bundle.id} v${bundle.version}`);
      } catch {
        // Fall back to exact bundleId if identity lookup fails
        this.logger.debug(`Identity lookup failed for '${identity}', trying exact bundleId '${bundleId}'`);
        bundle = await this.getBundleDetails(bundleId);
      }
    }

    // Check if update is needed
    if (current.version === bundle.version) {
      this.logger.info(`Bundle '${bundleId}' is already at version ${bundle.version}, reinstalling...`);
      // Continue with reinstall instead of returning early
    }

    // Get source and adapter
    const sources = await this.storage.getSources();
    const source = sources.find((s) => s.id === bundle.sourceId);

    if (!source) {
      throw new Error(`Source '${bundle.sourceId}' not found`);
    }

    const adapter = this.getAdapter(source);

    // Unified download path: use downloadBundle() for all sources
    this.logger.debug(`Downloading bundle update from ${source.type} adapter`);
    const bundleBuffer = await adapter.downloadBundle(bundle);
    this.logger.debug(`Bundle downloaded: ${bundleBuffer.length} bytes`);

    // Update using BundleInstaller
    const updated = await this.installer.update(
      current,
      bundle,
      bundleBuffer,
      source.type
    );

    // CRITICAL: Write new installation record first, then remove old record
    // This ordering ensures crash-safety - if removal fails, we have the new record
    // If write fails, the old record remains intact
    // Note: Repository scope bundles are tracked via LockfileManager, not RegistryStorage
    // The lockfile is already updated by BundleInstaller during update
    this.logger.debug(`Recording new installation for '${updated.bundleId}' v${updated.version}`);
    if (current.scope !== 'repository') {
      await this.storage.recordInstallation(updated);
    }

    // Only remove old record if bundleId changed (e.g., GitHub bundles with version in ID)
    // For Awesome Copilot bundles, the bundleId doesn't include version, so old and new are the same
    // In that case, recordInstallation already overwrote the old record
    if (updated.bundleId !== bundleId && current.scope !== 'repository') {
      this.logger.debug(`Removing old installation record for '${bundleId}' from ${current.scope} scope`);
      await this.storage.removeInstallation(bundleId, current.scope);
    } else {
      this.logger.debug(`BundleId unchanged ('${bundleId}'), old record already overwritten`);
    }

    this._onBundleUpdated.fire(updated);
    this.logger.info(`Bundle '${bundleId}' updated from v${current.version} to v${bundle.version}`);
  }

  /**
   * List installed bundles
   *
   * Queries the appropriate source based on scope:
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
    const bundles: InstalledBundle[] = [];

    // Query user/workspace bundles from RegistryStorage
    if (scope !== 'repository') {
      const storageBundles = await this.storage.getInstalledBundles(scope);
      bundles.push(...storageBundles);
    }

    // Query repository bundles from LockfileManager
    if (scope === 'repository' || scope === undefined) {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        try {
          const lockfileManager = LockfileManager.getInstance(workspaceRoot);
          const repoBundles = await lockfileManager.getInstalledBundles();
          bundles.push(...repoBundles);
        } catch (error) {
          this.logger.warn('Failed to query repository bundles from lockfile:', error instanceof Error ? error : undefined);
          // Continue without repository bundles on error
        }
      }
    }

    return bundles;
  }

  /**
   * Check for bundle updates
   */
  public async checkUpdates(): Promise<BundleUpdate[]> {
    this.logger.info('Checking for bundle updates');

    const installed = await this.storage.getInstalledBundles();
    const updates: BundleUpdate[] = [];

    for (const bundle of installed) {
      try {
        // Try to get bundle details, handling versioned IDs that may not exist in consolidated list
        let latest: Bundle;
        try {
          latest = await this.getBundleDetails(bundle.bundleId);
        } catch (error) {
          // If versioned ID not found, try extracting identity for GitHub bundles
          const sources = await this.storage.getSources();
          // Try both scopes to find the installed bundle
          let installedBundle = await this.storage.getInstalledBundle(bundle.bundleId, 'user');
          if (!installedBundle) {
            installedBundle = await this.storage.getInstalledBundle(bundle.bundleId, 'workspace');
          }
          const source = sources.find((s) => s.id === installedBundle?.sourceId);

          if (source?.type === 'github') {
            const identity = VersionManager.extractBundleIdentity(bundle.bundleId, 'github');
            this.logger.debug(`Versioned bundle '${bundle.bundleId}' not found, trying identity '${identity}'`);
            latest = await this.getBundleDetails(identity);
          } else {
            throw error; // Re-throw if not a GitHub bundle
          }
        }

        if (latest.version !== bundle.version) {
          updates.push({
            bundleId: bundle.bundleId,
            currentVersion: bundle.version,
            latestVersion: latest.version
          });
        }
      } catch (error) {
        this.logger.error(`Failed to check update for '${bundle.bundleId}'`, error as Error);
      }
    }

    this.logger.info(`Found ${updates.length} bundle updates`);
    return updates;
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
   * @param profile
   */
  public async createProfile(profile: Omit<Profile, 'createdAt' | 'updatedAt'>): Promise<Profile> {
    this.logger.info(`Creating profile: ${profile.name}`);

    const fullProfile: Profile = {
      ...profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this.storage.addProfile(fullProfile);
    this._onProfileCreated.fire(fullProfile);
    this.logger.info(`Profile '${profile.name}' created successfully`);

    return fullProfile;
  }

  /**
   * Update a profile
   * @param profileId
   * @param updates
   */
  public async updateProfile(profileId: string, updates: Partial<Profile>): Promise<void> {
    this.logger.info(`Updating profile: ${profileId}`);

    await this.storage.updateProfile(profileId, {
      ...updates,
      updatedAt: new Date().toISOString()
    });

    // Get the updated profile and fire event
    const profiles = await this.storage.getProfiles();
    const updatedProfile = profiles.find((p) => p.id === profileId);
    if (updatedProfile) {
      this._onProfileUpdated.fire(updatedProfile);
    }

    this.logger.info(`Profile '${profileId}' updated successfully`);
  }

  /**
   * Check if a profile is from the active hub (and thus read-only)
   * @param profileId
   */
  public async isHubProfile(profileId: string): Promise<boolean> {
    if (!this.hubManager) {
      return false;
    }

    const hubProfiles = await this.hubManager.listActiveHubProfiles();
    return hubProfiles.some((p) => p.id === profileId);
  }

  /**
   * Delete a profile
   * @param profileId
   */
  public async deleteProfile(profileId: string): Promise<void> {
    this.logger.info(`Deleting profile: ${profileId}`);

    await this.storage.removeProfile(profileId);
    this._onProfileDeleted.fire(profileId);

    this.logger.info(`Profile '${profileId}' deleted successfully`);
  }

  /**
   * List only local profiles (from storage, excludes hub profiles)
   */
  public async listLocalProfiles(): Promise<Profile[]> {
    return await this.storage.getProfiles();
  }

  /**
   * List all profiles (both hub profiles and local profiles)
   */
  public async listProfiles(): Promise<Profile[]> {
    const allProfiles: Profile[] = [];

    // Get hub profiles if hub manager is available
    if (this.hubManager) {
      try {
        const hubProfiles = await this.hubManager.listActiveHubProfiles();
        // Get list of all active profiles to check activation status
        const activeProfiles = await this.hubManager.listAllActiveProfiles();
        const activeProfileIds = new Set(activeProfiles.map((ap) => ap.profileId));

        // Convert HubProfileWithMetadata to Profile format
        const convertedHubProfiles = hubProfiles.map((hp) => ({
          ...hp,
          icon: hp.icon || '📦', // Provide default icon if not defined in hub config
          active: activeProfileIds.has(hp.id) // Check if this profile is currently active
        }));
        allProfiles.push(...convertedHubProfiles);
      } catch (error) {
        this.logger.warn('Failed to get hub profiles', error);
      }
    }

    // Also get local profiles
    const localProfiles = await this.storage.getProfiles();
    allProfiles.push(...localProfiles);

    return allProfiles;
  }

  /**
   * Activate a profile
   * @param profileId
   */
  public async activateProfile(profileId: string): Promise<void> {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Activating Profile',
      cancellable: false
    }, async (progress) => {
      progress.report({ message: 'Preparing...' });

      const validatedProfileId = this.validateProfileId(profileId);
      this.logger.info(`Activating profile: ${validatedProfileId}`);

      // Deactivate ALL currently active profiles (both hub and local)
      progress.report({ message: 'Deactivating other profiles...' });

      // Deactivate all active hub profiles (and uninstall their bundles)
      if (this.hubManager) {
        try {
          const activeHubProfiles = await this.hubManager.listAllActiveProfiles();
          for (const activeProfile of activeHubProfiles) {
            if (activeProfile.profileId !== validatedProfileId) {
              this.logger.info(`Deactivating hub profile: ${activeProfile.profileId}`);
              try {
                // Call RegistryManager.deactivateProfile() instead of HubManager.deactivateProfile()
                // This ensures bundles are uninstalled, not just flags updated
                await this.deactivateProfile(activeProfile.profileId);
              } catch (error) {
                this.logger.error(`Failed to deactivate hub profile ${activeProfile.profileId}`, error as Error);
              }
            }
          }
        } catch (error) {
          this.logger.error('Failed to deactivate hub profiles', error as Error);
        }
      }

      // Deactivate all active local profiles (and uninstall their bundles)
      const profiles = await this.storage.getProfiles();
      for (const localProfile of profiles) {
        if (localProfile.active && localProfile.id !== validatedProfileId) {
          this.logger.info(`Deactivating local profile: ${localProfile.id}`);
          try {
            // Call deactivateProfile() to properly uninstall bundles, not just update flags
            await this.deactivateProfile(localProfile.id);
          } catch (error) {
            this.logger.error(`Failed to deactivate local profile ${localProfile.id}`, error as Error);
          }
        }
      }

      // Check if this is a hub profile and delegate to HubManager
      if (this.hubManager) {
        const isHub = await this.isHubProfile(validatedProfileId);
        if (isHub) {
          this.logger.info(`Profile ${validatedProfileId} is from hub, delegating to HubManager`);
          const hubProfiles = await this.hubManager.listActiveHubProfiles();
          const hubProfile = hubProfiles.find((p) => p.id === validatedProfileId);
          if (hubProfile && hubProfile.hubId) {
            await this.hubManager.activateProfile(hubProfile.hubId, validatedProfileId, { installBundles: true });
            // Fire event to update tree view with active status
            this._onProfileActivated.fire({ ...hubProfile, active: true });
            return;
          }
        }
      }

      progress.report({ message: 'Installing bundles...' });

      // Get and activate the target profile
      const profile = await this.getProfileById(validatedProfileId);
      if (profile) {
        this._onProfileActivated.fire(profile);
      }

      // Deactivate other active profiles
      await this.deactivateOtherProfiles(validatedProfileId, progress);

      this._onProfileActivated.fire(profile);

      // Install profile bundles
      await this.installProfileBundles(profile, validatedProfileId, progress);

      // Mark profile as active
      await this.storage.updateProfile(validatedProfileId, { active: true });

      this.logger.info(`Profile '${validatedProfileId}' activated successfully`);
      progress.report({ message: 'Profile activated successfully' });
    });
  }

  /**
   * Deactivate a profile and uninstall its bundles
   * @param profileId
   */
  public async deactivateProfile(profileId: string): Promise<void> {
    this.logger.info(`Deactivating profile: ${profileId}`);

    // Check if this is a hub profile first
    if (this.hubManager) {
      const isHub = await this.isHubProfile(profileId);
      if (isHub) {
        this.logger.info(`Profile ${profileId} is from hub, delegating to HubManager`);
        const hubProfiles = await this.hubManager.listActiveHubProfiles();
        const hubProfile = hubProfiles.find((p) => p.id === profileId);
        if (hubProfile && hubProfile.hubId) {
          await this.hubManager.deactivateProfile(hubProfile.hubId, profileId);

          // Uninstall only the bundles that were installed BY THIS PROFILE
          // (not bundles installed manually or by other profiles)
          const bundles = (await this.storage.getInstalledBundles()).filter((b) => b.profileId === profileId);

          if (bundles.length > 0) {
            this.logger.info(`Uninstalling ${bundles.length} bundles from hub profile '${profileId}'`);
            await this.uninstallBundles(bundles.map((b) => b.bundleId));
          }

          // Fire event to update tree view
          this._onProfileDeactivated.fire(profileId);
          this.logger.info(`Profile deactivated: ${profileId}`);
          return;
        }
      }
    }

    const profiles = await this.storage.getProfiles();
    const profile = profiles.find((p) => p.id === profileId);

    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    // Uninstall bundles associated with this profile
    const installedBundles = await this.storage.getInstalledBundles();
    const profileBundles = installedBundles.filter((b) => b.profileId === profileId);

    this.logger.info(`Uninstalling ${profileBundles.length} bundles from profile '${profileId}'`);

    await this.uninstallBundles(profileBundles.map((b) => b.bundleId));

    // Mark profile as inactive
    await this.storage.updateProfile(profileId, { active: false });

    this._onProfileDeactivated.fire(profileId);
    this.logger.info(`Profile '${profileId}' deactivated successfully`);
  }

  /**
   * Export a profile
   * @param profileId
   */
  public async exportProfile(profileId: string): Promise<string> {
    const profiles = await this.storage.getProfiles();
    const profile = profiles.find((p) => p.id === profileId);

    if (!profile) {
      throw new Error(`Profile '${profileId}' not found`);
    }

    return JSON.stringify(profile, null, 2);
  }

  /**
   * Import a profile
   * @param profileData
   */
  public async importProfile(profileData: string): Promise<Profile> {
    const profile = JSON.parse(profileData) as Profile;

    // Update timestamps
    profile.createdAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    profile.active = false;

    await this.storage.addProfile(profile);

    return profile;
  }

  /**
   * Export complete registry settings (sources + profiles + configuration)
   * @param format
   */
  public async exportSettings(format: ExportFormat = 'json'): Promise<string> {
    const sources = await this.listSources();
    const profiles = await this.storage.getProfiles();

    const config = vscode.workspace.getConfiguration('promptregistry');

    const settings: ExportedSettings = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      sources,
      profiles,
      configuration: {
        autoCheckUpdates: config.get('autoCheckUpdates'),
        installationScope: config.get('installationScope'),
        enableLogging: config.get('enableLogging')
      }
    };

    if (format === 'yaml') {
      const yaml = await import('js-yaml');
      return yaml.default.dump(settings, {
        indent: 2,
        lineWidth: 120,
        noRefs: true
      });
    }

    return JSON.stringify(settings, null, 2);
  }

  /**
   * Import registry settings (sources + profiles + configuration)
   * @param data
   * @param format
   * @param strategy
   */
  public async importSettings(
    data: string,
    format: ExportFormat = 'json',
    strategy: ImportStrategy = 'merge'
  ): Promise<void> {
    // Parse data
    let settings: ExportedSettings;
    try {
      if (format === 'yaml') {
        const yaml = await import('js-yaml');
        settings = yaml.default.load(data) as ExportedSettings;
      } else {
        settings = JSON.parse(data);
      }
    } catch (error: any) {
      throw new Error(`Invalid ${format.toUpperCase()} format: ${error.message}`);
    }

    // Validate schema version
    if (!settings.version || settings.version !== '1.0.0') {
      throw new Error(`Incompatible settings version: ${settings.version || 'unknown'}. Expected 1.0.0`);
    }

    // Validate required fields
    if (!Array.isArray(settings.sources) || !Array.isArray(settings.profiles)) {
      throw new Error('Invalid settings format: sources and profiles must be arrays');
    }

    // Clear if replacing
    if (strategy === 'replace') {
      await this.storage.clearAll();
    }

    // Import sources
    for (const source of settings.sources) {
      try {
        const existingSources = await this.listSources();
        const existing = existingSources.find((s) => s.id === source.id);

        if (!existing || strategy === 'replace') {
          // addSource will validate the source
          await this.addSource(source);
        }
      } catch (error: any) {
        Logger.getInstance().warn(`Failed to import source ${source.name}: ${error.message}`);
      }
    }

    // Import profiles
    for (const profile of settings.profiles) {
      try {
        const existingProfiles = await this.storage.getProfiles();
        const existing = existingProfiles.find((p) => p.id === profile.id);

        if (!existing || strategy === 'replace') {
          // Reset timestamps and active state
          profile.createdAt = new Date().toISOString();
          profile.updatedAt = new Date().toISOString();
          profile.active = false;

          await this.storage.addProfile(profile);
        }
      } catch (error: any) {
        Logger.getInstance().warn(`Failed to import profile ${profile.name}: ${error.message}`);
      }
    }

    // Import configuration
    if (settings.configuration) {
      const config = vscode.workspace.getConfiguration('promptregistry');

      if (settings.configuration.autoCheckUpdates !== undefined) {
        await config.update('autoCheckUpdates', settings.configuration.autoCheckUpdates, true);
      }
      if (settings.configuration.installationScope !== undefined) {
        await config.update('installationScope', settings.configuration.installationScope, true);
      }
      if (settings.configuration.enableLogging !== undefined) {
        await config.update('enableLogging', settings.configuration.enableLogging, true);
      }
    }

    // Settings imported - triggering UI refresh via source/profile events
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
  }
}
