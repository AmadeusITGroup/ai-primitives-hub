/**
 * HubManager (app) — CRUD + fetch/validate orchestration for hubs.
 *
 * Stages 1+3 of the staged strangler-fig port of the extension's
 * `src/services/hub-manager.ts` (migration plan §7.5, HubManager
 * item): Stage 1 — import / list / get / getActive / setActive /
 * sync / delete a hub, plus availability probing. Stage 3 — favorited
 * profiles (`isProfileFavorite`/`getFavoriteProfiles`/
 * `toggleProfileFavorite`/`cleanupOrphanedFavorites`/
 * `removeHubFavorites`). Deliberately excludes (ported in later
 * stages):
 *   - source-loading/dedup into `RegistryManager` (Stage 2 — landed, see `load-hub-sources.ts`)
 *   - profile activation/deactivation + conflict detection (Stage 4)
 *   - the sync scheduler (Stage 5)
 *
 * Framework-agnostic by design (no `vscode.*`): the extension's own
 * `HubManager` fires its existing `vscode.EventEmitter`-backed events
 * itself, around calls into this class, rather than this class owning
 * events (unlike the extension, this class has no listeners of its
 * own to serve — it is also usable standalone from a future CLI).
 * @module registry/hub-manager
 */
import type {
  HubConfig,
  HubProfile,
  HubReference,
  RegistrySource,
  ValidationResult,
} from '@ai-primitives-hub/core';
import {
  DEFAULT_LOCAL_HUB_ID,
  sanitizeHubId,
} from '@ai-primitives-hub/core';
import type {
  ActiveHubStore,
  FavoritesStore,
  HubResolver,
  HubStore,
  HubStoreMetadata,
  LoadHubResult,
} from '@ai-primitives-hub/infra';

export interface HubInfo {
  id: string;
  config: HubConfig;
  reference: HubReference;
}

export interface HubListItem {
  id: string;
  name: string;
  description: string;
  reference: HubReference;
}

export interface HubDetailInfo extends HubInfo {
  metadata: {
    name: string;
    description: string;
    lastModified: string;
    size: number;
  };
}

/**
 * Dependencies for the app-layer `HubManager`.
 */
export interface HubManagerDeps {
  store: HubStore;
  activeStore: ActiveHubStore;
  resolver: HubResolver;
  favoritesStore: FavoritesStore;
  /**
   * Fully-composed validator (schema + runtime). Injected rather than
   * built here since schema/AJV validation stays delivery-context
   * code (the extension's `SchemaValidator`) for now.
   */
  validateConfig: (config: HubConfig) => Promise<ValidationResult>;
}

/**
 * Lib-side counterpart of the extension's `HubManager`, covering the
 * CRUD + fetch/validate surface (Stage 1 of the staged port).
 */
export class HubManager {
  /**
   * Construct a HubManager instance.
   * @param deps Store/resolver/validator dependencies.
   */
  public constructor(private readonly deps: HubManagerDeps) {}

  private generateHubId(config: HubConfig): string {
    let id = config.metadata.name
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-|-$/g, '');

    const timestamp = Date.now().toString().slice(-6);
    id = `${id}-${timestamp}`;
    return id;
  }

  private async validateReference(reference: HubReference): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!reference.type) {
      errors.push('Reference type is required');
    }
    if (!reference.location) {
      errors.push('Reference location is required');
    }

    switch (reference.type) {
      case 'github': {
        if (!reference.location.includes('/')) {
          errors.push('Invalid GitHub location format. Expected: owner/repo');
        }
        break;
      }
      case 'url': {
        try {
          new URL(reference.location);
        } catch {
          errors.push('Invalid URL format');
        }
        break;
      }
      case 'local': {
        // Local path validation is done during fetch.
        break;
      }
      default: {
        errors.push(`Unsupported reference type: ${String(reference.type)}`);
      }
    }

    return Promise.resolve({ valid: errors.length === 0, errors, warnings: [] });
  }

  /**
   * Import a hub from its reference. Persists the config; does not
   * touch the active-hub pointer (mirrors the extension, which never
   * auto-activates on import either).
   * @param reference Hub reference (GitHub, URL, or local path).
   * @param hubId Optional explicit id (auto-generated when omitted).
   * @returns The persisted hub id.
   */
  public async importHub(reference: HubReference, hubId?: string): Promise<string> {
    const refValidation = await this.validateReference(reference);
    if (!refValidation.valid) {
      throw new Error(`Invalid reference: ${refValidation.errors.join(', ')}`);
    }

    const resolved = await this.deps.resolver.resolve(reference);

    const validation = await this.deps.validateConfig(resolved.config);
    if (!validation.valid) {
      throw new Error(`Hub validation failed: Validation error: ${validation.errors.join(', ')}`);
    }

    const id = hubId ?? this.generateHubId(resolved.config);
    sanitizeHubId(id);
    if (id === DEFAULT_LOCAL_HUB_ID) {
      throw new Error(`Reserved hub id: ${DEFAULT_LOCAL_HUB_ID}`);
    }

    await this.deps.store.save(id, resolved.config, resolved.reference);
    return id;
  }

  /**
   * Load a hub from storage, re-validating it on the way out.
   * @param hubId Hub identifier.
   * @returns Loaded hub configuration and reference.
   */
  public async loadHub(hubId: string): Promise<LoadHubResult> {
    const result = await this.deps.store.load(hubId);

    const validation = await this.deps.validateConfig(result.config);
    if (!validation.valid) {
      throw new Error(`Hub validation failed: ${validation.errors.join(', ')}`);
    }

    return result;
  }

  /**
   * Validate a hub configuration via the injected validator.
   * @param config Hub configuration to validate.
   * @returns Validation result.
   */
  public async validateHub(config: HubConfig): Promise<ValidationResult> {
    return this.deps.validateConfig(config);
  }

  /**
   * List every hub on disk (id + name + description + reference).
   * @returns Hub list items; malformed hubs are skipped.
   */
  public async listHubs(): Promise<HubListItem[]> {
    const hubIds = await this.deps.store.list();
    const hubs: HubListItem[] = [];

    for (const id of hubIds) {
      try {
        const result = await this.deps.store.load(id);
        hubs.push({
          id,
          name: result.config.metadata.name,
          description: result.config.metadata.description,
          reference: result.reference
        });
      } catch (error) {
        // eslint-disable-next-line no-console -- matches the extension's pre-existing behavior for this diagnostic
        console.error(`Failed to load hub ${id}:`, error);
      }
    }

    return hubs;
  }

  /**
   * Delete a hub's storage entry. Callers that also need to clean up
   * dependent resources (sources/profiles/favorites tied to the hub)
   * are responsible for doing so themselves before calling this
   * (mirrors the extension's own `cleanupHubResources` split).
   * @param hubId Hub identifier to delete.
   */
  public async deleteHub(hubId: string): Promise<void> {
    await this.deps.store.remove(hubId);
  }

  /**
   * Re-fetch a hub's config from its recorded reference and persist
   * the updated version.
   * @param hubId Hub identifier to sync.
   */
  public async syncHub(hubId: string): Promise<void> {
    const existing = await this.deps.store.load(hubId);
    const resolved = await this.deps.resolver.resolve(existing.reference);

    const validation = await this.deps.validateConfig(resolved.config);
    if (!validation.valid) {
      throw new Error(`Hub validation failed after sync: ${validation.errors.join(', ')}`);
    }

    await this.deps.store.save(hubId, resolved.config, existing.reference);
  }

  /**
   * Get detailed hub information, including sidecar metadata.
   * @param hubId Hub identifier.
   * @returns Hub information.
   */
  public async getHubInfo(hubId: string): Promise<HubDetailInfo> {
    const result = await this.deps.store.load(hubId);
    const metadata: HubStoreMetadata = await this.deps.store.getMetadata(hubId);

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
   * Probe whether a hub reference is reachable, without importing it.
   * Never throws.
   * @param reference Hub reference to verify.
   * @returns true iff the reference validates and the config fetch succeeds.
   */
  public async verifyHubAvailability(reference: HubReference): Promise<boolean> {
    try {
      const refValidation = await this.validateReference(reference);
      if (!refValidation.valid) {
        return false;
      }
      await this.deps.resolver.resolve(reference);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the id of the currently active hub.
   * @returns Active hub id, or null if none is active.
   */
  public async getActiveHubId(): Promise<string | null> {
    return this.deps.activeStore.get();
  }

  /**
   * Get the currently active hub. Auto-clears a stale pointer (one
   * referencing a hub that no longer exists) and returns null.
   * @returns Active hub info, or null if none is active.
   */
  public async getActiveHub(): Promise<HubInfo | null> {
    const activeHubId = await this.deps.activeStore.get();
    if (!activeHubId) {
      return null;
    }
    try {
      const result = await this.deps.store.load(activeHubId);
      return { id: activeHubId, config: result.config, reference: result.reference };
    } catch {
      await this.deps.activeStore.set(null);
      return null;
    }
  }

  /**
   * Get a single hub by id.
   * @param hubId Hub identifier.
   * @returns Hub info, or null when not found/malformed.
   */
  public async getHub(hubId: string): Promise<HubInfo | null> {
    try {
      const result = await this.deps.store.load(hubId);
      return { id: hubId, config: result.config, reference: result.reference };
    } catch {
      return null;
    }
  }

  /**
   * Set the active hub. Throws when the hub is not on disk (unless
   * `null` is passed to clear).
   * @param hubId Hub id or null.
   */
  public async setActiveHub(hubId: string | null): Promise<void> {
    if (hubId !== null && !(await this.deps.store.has(hubId))) {
      throw new Error(`Hub not found: ${hubId}`);
    }
    await this.deps.activeStore.set(hubId);
  }

  /**
   * Check if a profile is favorited.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   * @returns true iff the profile is in that hub's favorites list.
   */
  public async isProfileFavorite(hubId: string, profileId: string): Promise<boolean> {
    const favorites = await this.deps.favoritesStore.get();
    return favorites[hubId]?.includes(profileId) ?? false;
  }

  /**
   * Get every hub's favorited profiles.
   * @returns Map of hub id to favorited profile ids.
   */
  public async getFavoriteProfiles(): Promise<Record<string, string[]>> {
    return this.deps.favoritesStore.get();
  }

  /**
   * Toggle a profile's favorite status for a hub. Removes the hub's
   * entry entirely once its favorites list becomes empty, rather than
   * leaving a stale empty array around.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   */
  public async toggleProfileFavorite(hubId: string, profileId: string): Promise<void> {
    const favorites = await this.deps.favoritesStore.get();
    const hubFavorites = favorites[hubId] ?? [];

    const index = hubFavorites.indexOf(profileId);
    if (index === -1) {
      hubFavorites.push(profileId);
    } else {
      hubFavorites.splice(index, 1);
    }

    favorites[hubId] = hubFavorites;

    if (favorites[hubId].length === 0) {
      delete favorites[hubId];
    }

    await this.deps.favoritesStore.save(favorites);
  }

  /**
   * Remove all favorited profiles for a single hub (e.g. on hub
   * delete, or when switching the active hub away from it). Callers
   * are responsible for their own event/logging side effects — see
   * `deleteHub`'s doc for the rationale.
   * @param hubId Hub identifier whose favorites should be cleared.
   * @returns true iff that hub had any favorites to remove.
   */
  public async removeHubFavorites(hubId: string): Promise<boolean> {
    const favorites = await this.deps.favoritesStore.get();
    if (!favorites[hubId]) {
      return false;
    }
    delete favorites[hubId];
    await this.deps.favoritesStore.save(favorites);
    return true;
  }

  /**
   * Remove favorites recorded against hubs that no longer exist on
   * disk (stale data from hubs deleted before cleanup-on-delete
   * existed). Callers are responsible for their own event/logging
   * side effects, per hub id returned.
   * @returns Ids of hubs whose orphaned favorites were removed.
   */
  public async cleanupOrphanedFavorites(): Promise<string[]> {
    const favorites = await this.deps.favoritesStore.get();
    const existingHubIds = new Set((await this.listHubs()).map((h) => h.id));

    const removed: string[] = [];
    for (const hubId of Object.keys(favorites)) {
      if (!existingHubIds.has(hubId)) {
        delete favorites[hubId];
        removed.push(hubId);
      }
    }

    if (removed.length > 0) {
      await this.deps.favoritesStore.save(favorites);
    }

    return removed;
  }

  /**
   * Aggregate sources from a chosen hub (default: active).
   * @param hubId Optional hub id; defaults to the active hub.
   * @returns Sources (each decorated with its `hubId`), or an empty
   * list when no hub id is given and none is active.
   */
  public async listSources(hubId?: string): Promise<RegistrySource[]> {
    let resolvedId = hubId;
    if (resolvedId === undefined) {
      resolvedId = (await this.deps.activeStore.get()) ?? undefined;
      if (resolvedId === undefined) {
        return [];
      }
    }
    const h = await this.deps.store.load(resolvedId);
    return h.config.sources.map((s) => ({ ...s, hubId: resolvedId }));
  }

  /**
   * List sources across **every** hub on disk (used by `source list`
   * with no `--hub` filter). Each source carries its `hubId`.
   * @returns Flattened source list; malformed hubs are skipped.
   */
  public async listSourcesAcrossAllHubs(): Promise<RegistrySource[]> {
    const ids = await this.deps.store.list();
    const out: RegistrySource[] = [];
    for (const id of ids) {
      try {
        const h = await this.deps.store.load(id);
        for (const s of h.config.sources) {
          out.push({ ...s, hubId: id });
        }
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  /**
   * Add a detached source, i.e. one not tied to any imported hub.
   * Creates the synthetic `default-local` hub on first call.
   * Replaces any existing source with the same id.
   * @param source Source to add (its `hubId` is ignored — always set to `default-local`).
   * @returns The persisted source.
   */
  public async addDetachedSource(source: Omit<RegistrySource, 'hubId'>): Promise<RegistrySource> {
    const finalSource: RegistrySource = { ...source, hubId: DEFAULT_LOCAL_HUB_ID };
    let cfg: HubConfig;
    let ref: HubReference;
    if (await this.deps.store.has(DEFAULT_LOCAL_HUB_ID)) {
      const loaded = await this.deps.store.load(DEFAULT_LOCAL_HUB_ID);
      cfg = loaded.config;
      ref = loaded.reference;
    } else {
      cfg = {
        version: '1.0.0',
        metadata: {
          name: 'Local sources',
          description: 'Auto-managed default-local hub for detached sources.',
          maintainer: 'cli',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: []
      };
      ref = { type: 'local', location: DEFAULT_LOCAL_HUB_ID };
    }
    const filtered = cfg.sources.filter((s) => s.id !== finalSource.id);
    cfg = { ...cfg, sources: [...filtered, finalSource] };
    await this.deps.store.save(DEFAULT_LOCAL_HUB_ID, cfg, ref);
    return finalSource;
  }

  /**
   * Remove a detached source from the default-local hub.
   * @param sourceId Source id.
   * @returns true iff a source was actually removed.
   */
  public async removeDetachedSource(sourceId: string): Promise<boolean> {
    if (!(await this.deps.store.has(DEFAULT_LOCAL_HUB_ID))) {
      return false;
    }
    const loaded = await this.deps.store.load(DEFAULT_LOCAL_HUB_ID);
    const before = loaded.config.sources.length;
    const after = loaded.config.sources.filter((s) => s.id !== sourceId);
    if (after.length === before) {
      return false;
    }
    await this.deps.store.save(DEFAULT_LOCAL_HUB_ID, { ...loaded.config, sources: after }, loaded.reference);
    return true;
  }

  /**
   * Add a profile to a hub. Auto-creates the hub (e.g. `default-local`)
   * if it doesn't exist yet. Replaces any existing profile with the
   * same id.
   * @param hubId Hub identifier.
   * @param profile Profile to add.
   * @returns The persisted profile.
   */
  public async addProfile(hubId: string, profile: HubProfile): Promise<HubProfile> {
    let cfg: HubConfig;
    let ref: HubReference;

    if (await this.deps.store.has(hubId)) {
      const loaded = await this.deps.store.load(hubId);
      cfg = loaded.config;
      ref = loaded.reference;
    } else {
      cfg = {
        version: '1.0.0',
        metadata: {
          name: hubId === DEFAULT_LOCAL_HUB_ID ? 'Local sources' : hubId,
          description: hubId === DEFAULT_LOCAL_HUB_ID ? 'Auto-managed default-local hub.' : `Hub: ${hubId}`,
          maintainer: 'cli',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: []
      };
      ref = { type: 'local', location: hubId };
    }

    const filtered = cfg.profiles.filter((p) => p.id !== profile.id);
    cfg = { ...cfg, profiles: [...filtered, profile] };
    await this.deps.store.save(hubId, cfg, ref);
    return profile;
  }

  /**
   * Remove a profile from a hub.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   * @returns true iff a profile was actually removed.
   */
  public async removeProfile(hubId: string, profileId: string): Promise<boolean> {
    if (!(await this.deps.store.has(hubId))) {
      return false;
    }
    const loaded = await this.deps.store.load(hubId);
    const before = loaded.config.profiles.length;
    const after = loaded.config.profiles.filter((p) => p.id !== profileId);
    if (after.length === before) {
      return false;
    }
    await this.deps.store.save(hubId, { ...loaded.config, profiles: after }, loaded.reference);
    return true;
  }
}
