/**
 * HubManager - Orchestrates hub operations
 * Handles hub importing, loading, validation, and synchronization
 */

import * as path from 'node:path';
import {
  activateProfile as appActivateProfile,
  createConflictResolutionDialog as appCreateConflictResolutionDialog,
  deactivateProfile as appDeactivateProfile,
  formatChangeSummary as appFormatChangeSummary,
  getActiveProfile as appGetActiveProfile,
  getHubProfile as appGetHubProfile,
  getProfileChanges as appGetProfileChanges,
  hasProfileChanges as appHasProfileChanges,
  HubManager as AppHubManager,
  listAllActiveProfiles as appListAllActiveProfiles,
  listProfilesFromHub as appListProfilesFromHub,
  loadHubSources as appLoadHubSources,
  resolveProfileBundles as appResolveProfileBundles,
  syncProfile as appSyncProfile,
  loadHubSourcesProgressively,
} from '@ai-primitives-hub/app';
import type {
  HubConfigStore,
  LoadHubSourcesOptions,
  LogEvent,
  ProfileLifecycleDeps,
  ProgressiveLoadResult,
} from '@ai-primitives-hub/app';
import type {
  HubConfig as CoreHubConfig,
  ValidationResult as CoreValidationResult,
  ProfileLifecycleSync,
} from '@ai-primitives-hub/core';
import {
  CompositeHubResolver,
  CompositeTokenProvider,
  GhCliTokenProvider,
  GitHubHubResolver,
  LocalHubResolver,
  NodeFileSystem,
  NodeHttpClient,
  UrlHubResolver,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../adapters/vscode-session-token-provider';
import {
  HubStorage,
  LoadHubResult,
} from '../storage/hub-storage';
import {
  ConflictResolutionDialog,
  HubConfig,
  HubProfile,
  HubProfileBundle,
  HubReference,
  ProfileActivationOptions,
  ProfileActivationResult,
  ProfileActivationState,
  ProfileChanges,
  ProfileDeactivationResult,
  validateHubConfig,
} from '../types/hub';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import {
  SchemaValidator,
  ValidationResult,
} from './schema-validator';

/**
 * Resolved bundle with its download URL
 */
export interface ResolvedBundle {
  bundle: HubProfileBundle;
  url: string;
}

/**
 * Hub profile with hub metadata
 */
export interface HubProfileWithMetadata extends HubProfile {
  hubId: string;
  hubName: string;
}

/**
 * Hub information including config, reference, and metadata
 */
export interface HubInfo {
  id: string;
  config: HubConfig;
  reference: HubReference;
  metadata: {
    name: string;
    description: string;
    lastModified: Date;
    size: number;
  };
}

/**
 * Hub list item with basic information
 */
export interface HubListItem {
  id: string;
  name: string;
  description: string;
  reference: HubReference;
}

export interface SetActiveHubOptions {
  loadSources?: boolean;
}

/**
 * HubManager orchestrates all hub-related operations
 */
export class HubManager {
  private readonly storage: HubStorage;
  private readonly validator: SchemaValidator;
  private readonly hubSchemaPath: string;
  private readonly logger: Logger;
  private readonly appHubManager: AppHubManager;
  private readonly profileLifecycleDeps: ProfileLifecycleDeps;
  private readonly translateLogEvent: (event: LogEvent) => void;
  private readonly _onHubImported = new vscode.EventEmitter<string>();
  private readonly _onHubDeleted = new vscode.EventEmitter<string>();
  private readonly _onHubSynced = new vscode.EventEmitter<string>();
  private readonly _onFavoritesChanged = new vscode.EventEmitter<void>();
  private readonly _onActiveHubChanged = new vscode.EventEmitter<{ oldHubId: string | null; newHubId: string | null }>();

  /**
   * Initialize HubManager
   * @param storage HubStorage instance for persistence
   * @param validator SchemaValidator instance for validation
   * @param extensionPath Path to the extension directory
   */
  public readonly onHubImported = this._onHubImported.event;
  public readonly onHubDeleted = this._onHubDeleted.event;
  public readonly onHubSynced = this._onHubSynced.event;
  public readonly onFavoritesChanged = this._onFavoritesChanged.event;
  public readonly onActiveHubChanged = this._onActiveHubChanged.event;

  constructor(
    storage: HubStorage,
    validator: SchemaValidator,
    extensionPath: string,
    private readonly bundleInstaller?: any,
    private readonly registryManager?: any
  ) {
    if (!storage) {
      throw new Error('storage is required');
    }
    if (!validator) {
      throw new Error('validator is required');
    }
    if (!extensionPath) {
      throw new Error('extensionPath is required');
    }

    this.storage = storage;
    this.validator = validator;
    this.hubSchemaPath = path.join(extensionPath, 'schemas', 'hub-config.schema.json');
    this.logger = Logger.getInstance();
    this.translateLogEvent = (event: LogEvent): void => {
      switch (event.level) {
        case 'debug': {
          this.logger.debug(event.message);
          break;
        }
        case 'info': {
          this.logger.info(event.message);
          break;
        }
        case 'warn': {
          this.logger.warn(event.message);
          break;
        }
        case 'error': {
          this.logger.error(event.message, event.error);
          break;
        }
      }
    };

    // Fetch/auth wiring: GitHub auth follows the same fallback chain as
    // RegistryManager's source adapters (VS Code session, then `gh` CLI) —
    // see src/adapters/infra-adapter-factory.ts.
    const httpClient = new NodeHttpClient();
    const tokenProvider = new CompositeTokenProvider([new VsCodeSessionTokenProvider(true), new GhCliTokenProvider()]);
    const resolver = new CompositeHubResolver(
      new GitHubHubResolver(httpClient, tokenProvider),
      new LocalHubResolver(new NodeFileSystem()),
      new UrlHubResolver(httpClient, tokenProvider)
    );

    this.appHubManager = new AppHubManager({
      store: storage.getHubStore(),
      activeStore: storage.getActiveHubStore(),
      favoritesStore: storage.getFavoritesStore(),
      resolver,
      validateConfig: async (config: CoreHubConfig): Promise<CoreValidationResult> => {
        const schemaResult = await this.validator.validate(config, this.hubSchemaPath);
        if (!schemaResult.valid) {
          return schemaResult;
        }
        const runtimeResult = validateHubConfig(config);
        if (!runtimeResult.valid) {
          return { valid: false, errors: runtimeResult.errors, warnings: [] };
        }
        return { valid: true, errors: [], warnings: [] };
      }
    });

    // Stage 4 profile-lifecycle wiring: `store` wraps `HubStorage`'s own
    // cache-aware `saveHub`/`loadHub`/`listHubs` (not the raw, cache-
    // bypassing `storage.getHubStore()` used above for Stage 1) so that
    // activateProfile/deactivateProfile's config mutations stay visible
    // through `HubStorage`'s in-memory cache to any direct caller of it.
    const cacheAwareStore: HubConfigStore = {
      save: (id: string, config, reference) => storage.saveHub(id, config, reference),
      load: (id: string) => storage.loadHub(id),
      list: () => storage.listHubs()
    };

    const profileSync: ProfileLifecycleSync | undefined = registryManager
      ? {
        deactivateProfile: (id: string) => registryManager.deactivateProfile(id),
        installBundles: (items) => registryManager.installBundles(items)
      }
      : undefined;

    this.profileLifecycleDeps = {
      store: cacheAwareStore,
      activationStore: storage.getProfileActivationStore(),
      profileSync
    };
  }

  /**
   * Cleanup resources linked to a hub (sources, profiles, favorites)
   * Called when hub is deleted or switched away from
   * @param hubId Hub identifier to cleanup
   */
  private async cleanupHubResources(hubId: string): Promise<void> {
    this.logger.info(`Cleaning up resources for hub: ${hubId}`);

    // 1. Remove favorites for this hub
    if (await this.appHubManager.removeHubFavorites(hubId)) {
      this._onFavoritesChanged.fire();
      this.logger.info(`Removed favorites for hub: ${hubId}`);
    }

    // 2. Deactivate and remove sources linked to this hub
    if (this.registryManager) {
      const sources = await this.registryManager.listSources();
      for (const source of sources) {
        if (source.hubId === hubId) {
          try {
            await this.registryManager.removeSource(source.id);
            this.logger.info(`Removed source ${source.id} linked to hub ${hubId}`);
          } catch (error) {
            this.logger.warn(`Failed to remove source ${source.id}`, error);
          }
        }
      }

      // 3. Deactivate profiles linked to this hub
      const profiles = await this.registryManager.listProfiles();
      for (const profile of profiles) {
        if (profile.hubId === hubId && profile.active) {
          try {
            await this.registryManager.updateProfile(profile.id, { active: false });
            this.logger.info(`Deactivated profile ${profile.id} linked to hub ${hubId}`);
          } catch (error) {
            this.logger.warn(`Failed to deactivate profile ${profile.id}`, error);
          }
        }
      }
    }
  }

  /**
   * No-op retained for backward compatibility: the previous inline
   * VS Code/gh-cli auth chain cached a resolved token on `this`, but the
   * `TokenProvider` chain wired into the constructor (see
   * `VsCodeSessionTokenProvider`/`GhCliTokenProvider`) re-resolves a
   * fresh token on every call, so there is no cache left to clear.
   */
  public clearAuthCache(): void {
    this.logger.info('[HubManager] Authentication cache cleared');
  }

  /**
   * Resolve, validate, and persist a hub's configuration — without loading
   * its sources. Returns as soon as the hub config itself is saved, so
   * callers that don't want to block on registering every declared source
   * (e.g. first-run activation) can await this and then call
   * `loadHubSources()` separately without awaiting it to completion.
   * @param reference Hub reference (GitHub, URL, or local path)
   * @param hubId Optional hub identifier (auto-generated if not provided)
   * @returns Hub identifier
   */
  public async importHubConfig(reference: HubReference, hubId?: string): Promise<string> {
    const resolvedHubId = await this.appHubManager.importHub(reference, hubId);

    // appHubManager writes through the raw HubStore, bypassing HubStorage's
    // read-through cache. When `hubId` reuses an already-cached id, that
    // leaves a stale entry behind — force a refresh so loadHubSources() (and
    // any other caller reading via `this.storage`) see the imported config.
    await this.storage.loadHub(resolvedHubId, true);

    this._onHubImported.fire(resolvedHubId);

    return resolvedHubId;
  }

  /**
   * Import a hub and immediately start progressive source loading/syncing.
   * Returns handles so callers can unblock early (`onFirstSettled`) or wait
   * for the full batch (`onComplete`).
   * @param reference Hub reference (GitHub, URL, or local path)
   * @param hubId Optional hub identifier (auto-generated if not provided)
   * @returns Hub identifier and progressive-load handles
   */
  public async importHubProgressively(
    reference: HubReference,
    hubId?: string
  ): Promise<{ hubId: string } & ProgressiveLoadResult> {
    const resolvedHubId = await this.importHubConfig(reference, hubId);

    if (!this.registryManager) {
      return {
        hubId: resolvedHubId,
        onFirstSettled: () => Promise.resolve(),
        onComplete: () => Promise.resolve()
      };
    }

    const hubData = await this.storage.loadHub(resolvedHubId);
    const result = loadHubSourcesProgressively(
      resolvedHubId,
      hubData.config.sources ?? [],
      {
        listSources: () => this.registryManager.listSources(),
        addSource: (s) => this.registryManager.addSource(s),
        updateSource: (id, u) => this.registryManager.updateSource(id, u)
      },
      this.translateLogEvent,
      {
        concurrency: CONCURRENCY_CONSTANTS.SOURCE_SYNC_CONCURRENCY,
        syncConcurrency: CONCURRENCY_CONSTANTS.SOURCE_SYNC_CONCURRENCY,
        syncSource: (id) => this.registryManager.syncSource(id).catch((e: unknown) => {
          this.logger.warn(`Failed to sync hub source ${id}`, e);
        })
      }
    );

    return { hubId: resolvedHubId, ...result };
  }

  /**
   * Import hub from remote or local source.
   * Delegates to `importHubProgressively` and fires background sync.
   * @param reference Hub reference (GitHub, URL, or local path)
   * @param hubId Optional hub identifier (auto-generated if not provided)
   * @param sourceLoadingOptions Optional registration settings for callers that
   * need to await source registration or receive per-source notifications.
   * @returns Hub identifier
   */
  public async importHub(
    reference: HubReference,
    hubId?: string,
    sourceLoadingOptions?: LoadHubSourcesOptions
  ): Promise<string> {
    if (sourceLoadingOptions) {
      const importedHubId = await this.importHubConfig(reference, hubId);
      await this.loadHubSources(importedHubId, sourceLoadingOptions);
      return importedHubId;
    }

    const { hubId: resolvedHubId, onComplete } = await this.importHubProgressively(reference, hubId);
    void onComplete();
    return resolvedHubId;
  }

  /**
   * Load hub from storage
   * @param hubId Hub identifier
   * @returns Loaded hub configuration and reference
   */
  public async loadHub(hubId: string): Promise<LoadHubResult> {
    return this.appHubManager.loadHub(hubId);
  }

  /**
   * Validate hub configuration
   * @param config Hub configuration to validate
   * @returns Validation result
   */
  public async validateHub(config: HubConfig): Promise<ValidationResult> {
    return this.appHubManager.validateHub(config) as Promise<ValidationResult>;
  }

  /**
   * List all imported hubs
   * @returns Array of hub list items
   */
  public async listHubs(): Promise<HubListItem[]> {
    return this.appHubManager.listHubs();
  }

  /**
   * Delete hub from storage
   * @param hubId Hub identifier to delete
   */
  public async deleteHub(hubId: string): Promise<void> {
    // Cleanup resources linked to this hub before deleting
    await this.cleanupHubResources(hubId);

    // Delete via `this.storage`, not appHubManager: both ultimately call the
    // same underlying HubStore.remove(), but only HubStorage's own version
    // also evicts the now-deleted hub from its read-through cache.
    await this.storage.deleteHub(hubId);
    this._onHubDeleted.fire(hubId);
  }

  public async deleteAllHubs(): Promise<void> {
    const hubIds = await this.storage.listHubs();
    await Promise.allSettled(hubIds.map(async (hubId) => {
      try {
        await this.deleteHub(hubId);
      } catch (error) {
        this.logger.warn(`Failed to delete hub ${hubId} during cleanup`, error);
      }
    }));
  }

  /**
   * Sync the currently active hub from remote source.
   * Resolves the active hub ID from storage and delegates to syncHub().
   * No-ops silently if no hub is active.
   */
  public async syncActiveHub(): Promise<void> {
    const activeHubId = await this.storage.getActiveHubId();
    if (!activeHubId) {
      this.logger.info('No active hub configured, skipping sync');
      return;
    }
    await this.syncHub(activeHubId);
  }

  /**
   * Sync hub from remote source
   * @param hubId Hub identifier to sync
   */
  public async syncHub(hubId: string): Promise<void> {
    await this.appHubManager.syncHub(hubId);

    // Same cache-consistency concern as importHub(): refresh HubStorage's
    // cache with the just-synced config before anything reads it back.
    await this.storage.loadHub(hubId, true);

    // Reload hub sources into RegistryManager
    if (this.registryManager) {
      await this.loadHubSources(hubId);
    }

    this._onHubSynced.fire(hubId);
  }

  /**
   * Get detailed hub information
   * @param hubId Hub identifier
   * @returns Hub information
   */
  public async getHubInfo(hubId: string): Promise<HubInfo> {
    const result = await this.storage.loadHub(hubId);
    const metadata = await this.storage.getHubMetadata(hubId);

    return {
      id: hubId,
      config: result.config,
      reference: result.reference,
      metadata: {
        name: result.config.metadata.name,
        description: result.config.metadata.description,
        lastModified: metadata.lastModified,
        size: metadata.size
      }
    };
  }

  /**
   * Verify if a hub is accessible without importing it
   * Used to validate default hubs before offering them in the first-run selector
   * @param reference Hub reference to verify
   * @returns true if hub is accessible, false otherwise
   */
  public async verifyHubAvailability(reference: HubReference): Promise<boolean> {
    const available = await this.appHubManager.verifyHubAvailability(reference);
    if (available) {
      this.logger.debug(`Hub verification successful: ${reference.type}:${reference.location}`);
    } else {
      this.logger.debug(`Hub verification failed: ${reference.type}:${reference.location}`);
    }
    return available;
  }

  /**
   * List all profiles from a specific hub
   * @param hubId Hub identifier
   * @returns Array of profiles from the hub
   */
  public async listProfilesFromHub(hubId: string): Promise<HubProfile[]> {
    return appListProfilesFromHub(this.profileLifecycleDeps, hubId, this.translateLogEvent);
  }

  /**
   * Get a specific profile from a hub
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   * @returns The requested profile
   */
  public async getHubProfile(hubId: string, profileId: string): Promise<HubProfile> {
    return appGetHubProfile(this.profileLifecycleDeps, hubId, profileId, this.translateLogEvent);
  }

  /**
   * List all profiles from all imported hubs
   * @returns Array of profiles with hub information
   */
  public async listAllHubProfiles(): Promise<HubProfileWithMetadata[]> {
    const hubs = await this.listHubs();
    const allProfiles: HubProfileWithMetadata[] = [];

    for (const hubItem of hubs) {
      const profiles = await this.listProfilesFromHub(hubItem.id);
      for (const profile of profiles) {
        allProfiles.push({
          ...profile,
          hubId: hubItem.id,
          hubName: hubItem.name
        });
      }
    }

    return allProfiles;
  }

  /**
   * Get the ID of the currently active hub.
   * @returns Active hub ID, or null if no hub is active
   */
  public async getActiveHubId(): Promise<string | null> {
    return this.appHubManager.getActiveHubId();
  }

  /**
   * Get the currently active hub
   * @returns Active hub ID, config and reference, or null if no hub is active
   */
  public async getActiveHub(): Promise<LoadHubResult | null> {
    return this.appHubManager.getActiveHub();
  }

  /**
   * Set the currently active hub
   * @param hubId Hub identifier to set as active
   * @param options Activation settings.
   */
  public async setActiveHub(hubId: string | null, options?: SetActiveHubOptions): Promise<void> {
    // Get current active hub to check if we're switching
    const currentActiveHubId = await this.appHubManager.getActiveHubId();

    // Cleanup previous hub if switching to a different one
    if (currentActiveHubId && currentActiveHubId !== hubId) {
      await this.cleanupHubResources(currentActiveHubId);
    }

    if (hubId !== null) {
      // Verify hub exists when setting (not clearing)
      const hub = await this.getHub(hubId);
      if (!hub) {
        throw new Error(`Hub not found: ${hubId}`);
      }

      // Load hub sources into RegistryManager when activating, syncing each in
      // the background so the marketplace/tree fill in progressively.
      if (this.registryManager && options?.loadSources !== false) {
        const hubData = await this.storage.loadHub(hubId);
        const sources = hubData.config.sources ?? [];
        const { onComplete } = loadHubSourcesProgressively(
          hubId,
          sources,
          {
            listSources: () => this.registryManager.listSources(),
            addSource: (s) => this.registryManager.addSource(s),
            updateSource: (id, u) => this.registryManager.updateSource(id, u)
          },
          this.translateLogEvent,
          {
            concurrency: CONCURRENCY_CONSTANTS.SOURCE_SYNC_CONCURRENCY,
            syncConcurrency: CONCURRENCY_CONSTANTS.SOURCE_SYNC_CONCURRENCY,
            syncSource: (id) => this.registryManager.syncSource(id).catch((e: unknown) => {
              this.logger.warn(`Failed to sync hub source ${id}`, e);
            })
          }
        );
        void onComplete();
      }
    }

    // Set or clear active hub
    await this.appHubManager.setActiveHub(hubId);
    this.logger.info(hubId ? `Set active hub: ${hubId}` : 'Cleared active hub');

    if (currentActiveHubId !== hubId) {
      this._onActiveHubChanged.fire({ oldHubId: currentActiveHubId ?? null, newHubId: hubId });
    }
  }

  /**
   * Load hub sources into RegistryManager.
   * Converts HubSource objects to RegistrySource and adds them to the registry.
   * Skips sources that are duplicates (same URL, type, branch, and collectionsPath).
   *
   * SourceId Format: Uses `generateHubSourceId(type, url, config)` to create stable IDs
   * in the format `{type}-{12-char-hash}`. The hash includes branch and collectionsPath
   * to prevent collisions when the same URL is used with different configurations.
   * This makes lockfiles portable across different hub configurations since IDs are
   * based on source properties, not hub ID.
   *
   * Backward Compatibility: Existing sources with legacy hub-prefixed IDs
   * (`hub-{hubId}-{sourceId}`) continue to work. Duplicate detection uses URL
   * matching, not ID matching, to handle both formats.
   * @param hubId Hub identifier
   * @param options Optional source loading orchestration settings.
   */
  public async loadHubSources(hubId: string, options?: LoadHubSourcesOptions): Promise<void> {
    if (!this.registryManager) {
      this.logger.warn('RegistryManager not available, skipping source loading');
      return;
    }

    this.logger.info(`Loading sources from hub: ${hubId}`);

    try {
      const hubData = await this.storage.loadHub(hubId);
      const hubSources = hubData.config.sources || [];

      await appLoadHubSources(
        hubId,
        hubSources,
        {
          listSources: () => this.registryManager.listSources(),
          addSource: (source) => this.registryManager.addSource(source),
          updateSource: (sourceId, updates) => this.registryManager.updateSource(sourceId, updates)
        },
        this.translateLogEvent,
        options
      );
    } catch (error) {
      this.logger.error(`Failed to load sources from hub ${hubId}`, error as Error);
      throw error;
    }
  }

  /**
   * List profiles from the active hub only
   * @returns Profiles from active hub, or empty array if no hub is active
   */
  public async listActiveHubProfiles(): Promise<HubProfileWithMetadata[]> {
    const activeHubId = await this.storage.getActiveHubId();

    if (!activeHubId) {
      return [];
    }

    const activeHub = await this.getActiveHub();
    if (!activeHub) {
      return [];
    }

    const profiles = activeHub.config.profiles || [];
    return profiles.map((profile) => ({
      ...profile,
      hubId: activeHubId,
      hubName: activeHub.config.metadata.name
    }));
  }

  /**
   * Resolve all bundles in a profile
   * @param hubId
   * @param profileId
   */
  public async resolveProfileBundles(
    hubId: string,
    profileId: string
  ): Promise<ResolvedBundle[]> {
    return appResolveProfileBundles(this.profileLifecycleDeps, hubId, profileId, this.translateLogEvent);
  }

  /**
   * Activate a hub profile
   * @param hubId
   * @param profileId
   * @param options
   */
  public async activateProfile(
    hubId: string,
    profileId: string,
    options: ProfileActivationOptions
  ): Promise<ProfileActivationResult> {
    return appActivateProfile(this.profileLifecycleDeps, hubId, profileId, options, this.translateLogEvent);
  }

  /**
   * Deactivate a profile
   * @param hubId
   * @param profileId
   */
  public async deactivateProfile(hubId: string, profileId: string): Promise<ProfileDeactivationResult> {
    return appDeactivateProfile(this.profileLifecycleDeps, hubId, profileId);
  }

  /**
   * Get the currently active profile for a hub
   * @param hubId
   */
  public async getActiveProfile(hubId: string): Promise<ProfileActivationState | null> {
    return appGetActiveProfile(this.profileLifecycleDeps, hubId);
  }

  /**
   * List all active profiles across all hubs
   */
  public async listAllActiveProfiles(): Promise<ProfileActivationState[]> {
    return appListAllActiveProfiles(this.profileLifecycleDeps);
  }

  /**
   * Get a single hub by ID
   * @param hubId
   */
  public async getHub(hubId: string): Promise<{ id: string; config: HubConfig; reference: HubReference } | null> {
    try {
      return await this.appHubManager.getHub(hubId);
    } catch {
      return null;
    }
  }

  /**
   * Check if an active profile has changes in the hub
   * @param hubId
   * @param profileId
   */
  public async hasProfileChanges(hubId: string, profileId: string): Promise<boolean> {
    return appHasProfileChanges(this.profileLifecycleDeps, hubId, profileId);
  }

  /**
   * Get detailed changes for an active profile
   * @param hubId
   * @param profileId
   */
  public async getProfileChanges(hubId: string, profileId: string): Promise<ProfileChanges | null> {
    return appGetProfileChanges(this.profileLifecycleDeps, hubId, profileId);
  }

  /**
   * Sync a profile (update activation state)
   * @param hubId
   * @param profileId
   */
  public async syncProfile(hubId: string, profileId: string): Promise<void> {
    // Re-activate to update the state
    await appSyncProfile(this.profileLifecycleDeps, hubId, profileId, this.translateLogEvent);
  }

  /**
   * Check if a profile is favorited
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   */
  public async isProfileFavorite(hubId: string, profileId: string): Promise<boolean> {
    return this.appHubManager.isProfileFavorite(hubId, profileId);
  }

  /**
   * Get favorite profiles
   * @returns Map of hub ID to list of profile IDs
   */
  public async getFavoriteProfiles(): Promise<Record<string, string[]>> {
    return this.appHubManager.getFavoriteProfiles();
  }

  /**
   * Toggle profile favorite status
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   */
  public async toggleProfileFavorite(hubId: string, profileId: string): Promise<void> {
    await this.appHubManager.toggleProfileFavorite(hubId, profileId);
    this._onFavoritesChanged.fire();
  }

  /**
   * Cleanup orphaned favorites - remove favorites for hubs that no longer exist
   * This handles stale data from hubs that were deleted before cleanup logic was implemented
   */
  public async cleanupOrphanedFavorites(): Promise<void> {
    const removed = await this.appHubManager.cleanupOrphanedFavorites();

    if (removed.length > 0) {
      for (const hubId of removed) {
        this.logger.info(`Removing orphaned favorites for non-existent hub: ${hubId}`);
      }
      this._onFavoritesChanged.fire();
    }
  }

  /**
   * Format change summary as human-readable string
   * @param changes
   */
  public formatChangeSummary(changes: ProfileChanges): string {
    return appFormatChangeSummary(changes);
  }

  /**
   * Create conflict resolution dialog
   * @param changes
   */
  public createConflictResolutionDialog(changes: ProfileChanges): ConflictResolutionDialog {
    return appCreateConflictResolutionDialog(changes);
  }
}
