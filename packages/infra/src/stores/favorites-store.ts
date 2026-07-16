/**
 * FavoritesStore.
 *
 * Persists favorited profiles as a single JSON file: a plain
 * `Record<hubId, profileId[]>` with no wrapper object. Faithfully
 * mirrors the extension's `HubStorage.getFavoriteProfiles`/
 * `saveFavoriteProfiles` on-disk format (bare map, no metadata
 * envelope) so the extension can delegate to this store with zero
 * migration of existing user data.
 *
 * Deliberately stateless (no in-memory cache), matching `HubStore`/
 * `ActiveHubStore` — the extension's own facade layers a cache back
 * on top for fidelity with pre-existing behavior.
 * @module stores/favorites-store
 */
import type {
  FileSystem,
} from '@ai-primitives-hub/core';

/**
 * Filesystem-backed favorited-profiles map.
 */
export class FavoritesStore {
  /**
   * Construct a FavoritesStore instance.
   * @param favoritesPath Resolved path of the favorites JSON file.
   * @param fs Filesystem abstraction.
   */
  public constructor(
    private readonly favoritesPath: string,
    private readonly fs: FileSystem
  ) {}

  /**
   * Read the favorited-profiles map. Returns an empty map when the
   * file is missing or unreadable/malformed, rather than throwing.
   * @returns Map of hub id to favorited profile ids.
   */
  public async get(): Promise<Record<string, string[]>> {
    if (!(await this.fs.exists(this.favoritesPath))) {
      return {};
    }
    try {
      return await this.fs.readJson<Record<string, string[]>>(this.favoritesPath);
    } catch {
      return {};
    }
  }

  /**
   * Persist the favorited-profiles map, overwriting any existing file.
   * @param favorites Map of hub id to favorited profile ids.
   */
  public async save(favorites: Record<string, string[]>): Promise<void> {
    await this.fs.writeJson(this.favoritesPath, favorites);
  }
}
