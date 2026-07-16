/**
 * ProfileActivationStore.
 *
 * Persists per-hub-per-profile activation state as one JSON file per
 * `(hubId, profileId)` pair, under a `profile-activations/` subdirectory
 * (`<hubId>_<profileId>.json`). Faithfully mirrors the extension's
 * `HubStorage.saveProfileActivationState`/`getProfileActivationState`/
 * `deleteProfileActivationState`/`listActiveProfiles` on-disk format so
 * the extension can delegate to this store with zero migration of
 * existing user data.
 *
 * Deliberately stateless (no in-memory cache) and deliberately "dumb"
 * (no `getActiveForHub`-style query helper) — matching `FavoritesStore`
 * — callers needing "the active profile for hub X" compose it
 * themselves via `listAll().find(...)`, same as the extension's own
 * `getActiveProfileForHub` already does on top of `listActiveProfiles`.
 * @module stores/profile-activation-store
 */
import * as path from 'node:path';
import type {
  FileSystem,
  ProfileActivationState,
} from '@ai-primitives-hub/core';

/**
 * Filesystem-backed profile-activation-state store.
 */
export class ProfileActivationStore {
  /**
   * Construct a ProfileActivationStore instance.
   * @param dir Resolved path of the hubs directory (activation state
   *   files are written to a `profile-activations` subdirectory of it).
   * @param fs Filesystem abstraction.
   */
  public constructor(
    private readonly dir: string,
    private readonly fs: FileSystem
  ) {}

  private statePath(hubId: string, profileId: string): string {
    return path.join(this.dir, 'profile-activations', `${hubId}_${profileId}.json`);
  }

  /**
   * Get the activation state for a single hub/profile pair.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   * @returns The activation state, or null if not activated.
   */
  public async get(hubId: string, profileId: string): Promise<ProfileActivationState | null> {
    const statePath = this.statePath(hubId, profileId);
    if (!(await this.fs.exists(statePath))) {
      return null;
    }
    return this.fs.readJson<ProfileActivationState>(statePath);
  }

  /**
   * Persist the activation state for a hub/profile pair, overwriting
   * any existing entry.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   * @param state Activation state to persist.
   */
  public async save(hubId: string, profileId: string, state: ProfileActivationState): Promise<void> {
    await this.fs.mkdir(path.join(this.dir, 'profile-activations'), { recursive: true });
    await this.fs.writeJson(this.statePath(hubId, profileId), state);
  }

  /**
   * Remove the activation state for a hub/profile pair. No-op if it
   * doesn't exist.
   * @param hubId Hub identifier.
   * @param profileId Profile identifier.
   */
  public async delete(hubId: string, profileId: string): Promise<void> {
    const statePath = this.statePath(hubId, profileId);
    if (await this.fs.exists(statePath)) {
      await this.fs.remove(statePath);
    }
  }

  /**
   * List every recorded activation state, across all hubs/profiles.
   * @returns All activation states; returns an empty array when the
   *   directory doesn't exist yet.
   */
  public async listAll(): Promise<ProfileActivationState[]> {
    const activationsDir = path.join(this.dir, 'profile-activations');
    if (!(await this.fs.exists(activationsDir))) {
      return [];
    }

    const files = await this.fs.readDir(activationsDir);
    const states: ProfileActivationState[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        states.push(await this.fs.readJson<ProfileActivationState>(path.join(activationsDir, file)));
      }
    }
    return states;
  }
}
