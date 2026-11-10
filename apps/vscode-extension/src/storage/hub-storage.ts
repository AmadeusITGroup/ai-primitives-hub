/**
 * HubStorage - File-based storage for hub configurations
 * Handles persistence, caching, and file operations for hub configs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ActiveHubStore,
  FavoritesStore,
  HubStore,
  NodeFileSystem,
  ProfileActivationStore,
} from '@ai-primitives-hub/infra';
import {
  HubConfig,
  HubReference,
  ProfileActivationState,
  sanitizeHubId,
} from '../types/hub';

/**
 * Hub metadata stored alongside configuration
 */
export interface HubMetadata {
  reference: HubReference;
  lastModified: Date;
  size: number;
}

/**
 * Result of loading a hub from storage
 */
export interface LoadHubResult {
  config: HubConfig;
  reference: HubReference;
}

/**
 * Optional composition settings for `HubStorage`.
 *
 * `activeHubPath` overrides the active-hub pointer file (default:
 * `<storagePath>/activeHubId.json`); `cacheMode: 'stateless'` disables the
 * in-memory hub-config cache so external writers stay visible. Both default
 * to the pre-existing legacy behavior.
 */
export interface HubStorageOptions {
  activeHubPath?: string;
  cacheMode?: 'legacy' | 'stateless';
}

/**
 * HubStorage manages persistent storage of hub configurations.
 *
 * Thin facade over `@ai-primitives-hub/infra`'s `HubStore` +
 * `ActiveHubStore` + `FavoritesStore` + `ProfileActivationStore`: those own the actual
 * on-disk CRUD, this class layers an in-memory cache on top (for
 * fidelity with pre-existing behavior, hub configs only —
 * `FavoritesStore`/`ProfileActivationStore` are deliberately left
 * stateless here too, mirroring their own no-cache design).
 */
export class HubStorage {
  private readonly storagePath: string;
  private readonly cache: Map<string, LoadHubResult>;
  private readonly cacheMode: 'legacy' | 'stateless';
  private readonly hubStore: HubStore;
  private readonly activeHubStore: ActiveHubStore;
  private readonly favoritesStore: FavoritesStore;
  private readonly activationStore: ProfileActivationStore;

  /**
   * Initialize hub storage
   * @param storagePath Directory path for storing hub configurations
   * @param options Optional composition settings (pointer path, cache mode)
   */
  constructor(storagePath: string, options: HubStorageOptions = {}) {
    if (!storagePath || storagePath.trim() === '') {
      throw new Error('Invalid storage path');
    }

    this.storagePath = path.resolve(storagePath);
    this.cache = new Map();
    this.cacheMode = options.cacheMode ?? 'legacy';

    // Create storage directory if it doesn't exist
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }

    const nodeFs = new NodeFileSystem();
    this.hubStore = new HubStore(this.storagePath, nodeFs);
    this.activeHubStore = new ActiveHubStore(
      options.activeHubPath ?? path.join(this.storagePath, 'activeHubId.json'),
      nodeFs
    );
    this.favoritesStore = new FavoritesStore(path.join(this.storagePath, 'favorites.json'), nodeFs);
    this.activationStore = new ProfileActivationStore(this.storagePath, nodeFs);
  }

  /**
   * Expose the underlying infra `HubStore`, e.g. for `HubManager`'s
   * app-layer delegate wiring.
   * @returns The infra HubStore backing this facade.
   */
  public getHubStore(): HubStore {
    return this.hubStore;
  }

  /**
   * Expose the underlying infra `ActiveHubStore`, e.g. for
   * `HubManager`'s app-layer delegate wiring.
   * @returns The infra ActiveHubStore backing this facade.
   */
  public getActiveHubStore(): ActiveHubStore {
    return this.activeHubStore;
  }

  /**
   * Expose the underlying infra `FavoritesStore`, e.g. for
   * `HubManager`'s app-layer delegate wiring.
   * @returns The infra FavoritesStore backing this facade.
   */
  public getFavoritesStore(): FavoritesStore {
    return this.favoritesStore;
  }

  /**
   * Expose the underlying infra `ProfileActivationStore`, e.g. for
   * `HubManager`'s app-layer delegate wiring.
   * @returns The infra ProfileActivationStore backing this facade.
   */
  public getProfileActivationStore(): ProfileActivationStore {
    return this.activationStore;
  }

  /**
   * Save hub configuration to storage
   * @param hubId Unique identifier for the hub
   * @param config Hub configuration to save
   * @param reference Hub reference information
   */
  public async saveHub(hubId: string, config: HubConfig, reference: HubReference): Promise<void> {
    await this.hubStore.save(hubId, config, reference);
    if (this.cacheMode === 'legacy') {
      this.cache.set(hubId, { config, reference });
    }
  }

  /**
   * Load hub configuration from storage
   * @param hubId Hub identifier to load
   * @param forceReload Bypass cache and reload from disk
   * @returns Loaded hub configuration and reference
   */
  public async loadHub(hubId: string, forceReload = false): Promise<LoadHubResult> {
    if (this.cacheMode === 'legacy' && !forceReload && this.cache.has(hubId)) {
      return this.cache.get(hubId)!;
    }

    const result = await this.hubStore.load(hubId);
    if (this.cacheMode === 'legacy') {
      this.cache.set(hubId, result);
    }
    return result;
  }

  /**
   * Delete hub from storage
   * @param hubId Hub identifier to delete
   */
  public async deleteHub(hubId: string): Promise<void> {
    await this.hubStore.remove(hubId);
    this.cache.delete(hubId);
  }

  /**
   * List all stored hubs
   * @returns Array of hub IDs
   */
  public async listHubs(): Promise<string[]> {
    return this.hubStore.list();
  }

  /**
   * Get hub metadata without loading full configuration
   * @param hubId Hub identifier
   * @returns Hub metadata
   */
  public async getHubMetadata(hubId: string): Promise<HubMetadata> {
    const metadata = await this.hubStore.getMetadata(hubId);
    return {
      reference: metadata.reference,
      // `lastModified` is persisted as an ISO string; kept typed as `Date`
      // here for backward compatibility with this method's pre-existing
      // (mis-typed, but never runtime-checked) public signature.
      lastModified: metadata.lastModified as unknown as Date,
      size: metadata.size
    };
  }

  /**
   * Save profile activation state
   * @param hubId
   * @param profileId
   * @param state
   */
  public async saveProfileActivationState(
    hubId: string,
    profileId: string,
    state: ProfileActivationState
  ): Promise<void> {
    await this.activationStore.save(hubId, profileId, state);
  }

  /**
   * Get profile activation state
   * @param hubId
   * @param profileId
   */
  public async getProfileActivationState(
    hubId: string,
    profileId: string
  ): Promise<ProfileActivationState | null> {
    return this.activationStore.get(hubId, profileId);
  }

  /**
   * Delete profile activation state
   * @param hubId
   * @param profileId
   */
  public async deleteProfileActivationState(
    hubId: string,
    profileId: string
  ): Promise<void> {
    await this.activationStore.delete(hubId, profileId);
  }

  /**
   * List all active profiles
   */
  public async listActiveProfiles(): Promise<ProfileActivationState[]> {
    return this.activationStore.listAll();
  }

  /**
   * Get active profile for a specific hub
   * @param hubId
   */
  public async getActiveProfileForHub(hubId: string): Promise<ProfileActivationState | null> {
    const allActive = await this.listActiveProfiles();
    return allActive.find((state) => state.hubId === hubId) || null;
  }

  /**
   * Set profile active flag in hub config
   * @param hubId
   * @param profileId
   * @param active
   */
  public async setProfileActiveFlag(
    hubId: string,
    profileId: string,
    active: boolean
  ): Promise<void> {
    const hubData = await this.loadHub(hubId);

    const profile = hubData.config.profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId} in hub ${hubId}`);
    }

    profile.active = active;

    await this.saveHub(hubId, hubData.config, hubData.reference);
  }

  /**
   * Get the ID of the currently active hub
   * @returns Active hub ID or null if none set
   */
  public async getActiveHubId(): Promise<string | null> {
    return this.activeHubStore.get();
  }

  /**
   * Set the currently active hub
   * @param hubId Hub identifier to set as active (or null to clear)
   */
  public async setActiveHubId(hubId: string | null): Promise<void> {
    if (hubId === null) {
      await this.activeHubStore.set(null);
      return;
    }

    // Validate the hub exists
    sanitizeHubId(hubId);
    const hubs = await this.listHubs();
    if (!hubs.includes(hubId)) {
      throw new Error(`Cannot set active hub: hub '${hubId}' does not exist`);
    }

    await this.activeHubStore.set(hubId);
  }

  /**
   * Get favorite profiles
   * @returns Record<hubId, profileIds[]>
   */
  public async getFavoriteProfiles(): Promise<Record<string, string[]>> {
    return this.favoritesStore.get();
  }

  /**
   * Save favorite profiles
   * @param favorites
   */
  public async saveFavoriteProfiles(favorites: Record<string, string[]>): Promise<void> {
    await this.favoritesStore.save(favorites);
  }
}
