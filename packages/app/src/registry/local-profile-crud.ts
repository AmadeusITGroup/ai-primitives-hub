/**
 * CRUD for the extension's local (non-hub) profiles — ported from
 * `src/services/registry-manager.ts`'s `createProfile`/`updateProfile`/
 * `deleteProfile`/`listLocalProfiles`/`exportProfile`/`importProfile`.
 * Part of the `RegistryManager` scoping pass's slice 6 (profile/hub/
 * settings cluster — migration plan §7.5 item 3).
 *
 * Deliberately excludes event firing (`_onProfileCreated`/`Updated`/
 * `Deleted`): mirrors every other `registry/*` use-case in this
 * package — the extension's thin wrapper fires its own
 * `vscode.EventEmitter`s from these functions' return values.
 * @module registry/local-profile-crud
 */
import type {
  Profile,
  ProfileStore,
} from '@ai-primitives-hub/core';

/**
 * Create a new local profile, stamping `createdAt`/`updatedAt`.
 * @param store Local profile storage.
 * @param profile The profile to create (timestamps are set here).
 * @returns The created profile, including its stamped timestamps.
 */
export async function createLocalProfile(
  store: ProfileStore,
  profile: Omit<Profile, 'createdAt' | 'updatedAt'>
): Promise<Profile> {
  const fullProfile: Profile = {
    ...profile,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await store.addProfile(fullProfile);

  return fullProfile;
}

/**
 * Update a local profile, stamping a new `updatedAt`.
 * @param store Local profile storage.
 * @param profileId Profile to update.
 * @param updates Partial fields to merge in.
 * @returns The updated profile, or `undefined` if it could not be
 * found afterward (mirrors the original's conditional event-fire).
 */
export async function updateLocalProfile(
  store: ProfileStore,
  profileId: string,
  updates: Partial<Profile>
): Promise<Profile | undefined> {
  await store.updateProfile(profileId, {
    ...updates,
    updatedAt: new Date().toISOString()
  });

  const profiles = await store.getProfiles();
  return profiles.find((p) => p.id === profileId);
}

/**
 * Delete a local profile.
 * @param store Local profile storage.
 * @param profileId Profile to delete.
 */
export async function deleteLocalProfile(store: ProfileStore, profileId: string): Promise<void> {
  await store.removeProfile(profileId);
}

/**
 * List only local profiles (excludes hub-provided ones).
 * @param store Local profile storage.
 * @returns All local profiles.
 */
export async function listLocalProfiles(store: ProfileStore): Promise<Profile[]> {
  return await store.getProfiles();
}

/**
 * Serialize a single local profile as pretty-printed JSON.
 * @param store Local profile storage.
 * @param profileId Profile to export.
 * @returns The serialized profile.
 */
export async function exportLocalProfile(store: ProfileStore, profileId: string): Promise<string> {
  const profiles = await store.getProfiles();
  const profile = profiles.find((p) => p.id === profileId);

  if (!profile) {
    throw new Error(`Profile '${profileId}' not found`);
  }

  return JSON.stringify(profile, null, 2);
}

/**
 * Import a single local profile from JSON, resetting its timestamps
 * and forcing it inactive.
 * @param store Local profile storage.
 * @param profileData Serialized profile JSON.
 * @returns The imported profile.
 */
export async function importLocalProfile(store: ProfileStore, profileData: string): Promise<Profile> {
  const profile = JSON.parse(profileData) as Profile;

  profile.createdAt = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();
  profile.active = false;

  await store.addProfile(profile);

  return profile;
}
