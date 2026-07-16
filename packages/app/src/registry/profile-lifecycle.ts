/**
 * Profile activation/deactivation lifecycle + conflict detection —
 * ported from the extension's `src/services/hub-manager.ts`. Stage 4
 * of the staged HubManager port (migration plan §7.5, HubManager item;
 * see `hub-manager.ts`'s module doc for the full stage list).
 *
 * Deliberately a set of standalone functions taking an explicit
 * `ProfileLifecycleDeps` bag, rather than methods on `HubManager`
 * (Stage 1/3's class) — mirrors Stage 2's `load-hub-sources.ts`: this
 * subsystem is large and self-contained enough to warrant its own
 * module, and (unlike Stage 3's favorites, which needed the class's
 * own `listHubs()`) every function here only needs the store/
 * activation-store/optional-registry-sync bag, nothing else from
 * `HubManager`.
 *
 * Deliberately excludes `listAllHubProfiles`/`listActiveHubProfiles`:
 * those are simple read-projections over already-ported Stage 1
 * primitives (`listHubs`/`getActiveHub`), not activation/conflict
 * logic, and stay extension-side unchanged.
 * @module registry/profile-lifecycle
 */
import type {
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
  ProfileLifecycleSync,
} from '@ai-primitives-hub/core';
import type {
  LoadHubResult,
  ProfileActivationStore,
} from '@ai-primitives-hub/infra';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Narrow, structural view of `infra`'s `HubStore` — just enough to
 * read/write hub configs (load/save/list), deliberately excluding
 * `remove`/`getMetadata`/`has` which this module never needs.
 *
 * Typed as a plain interface rather than reusing `HubStore` (a
 * concrete class with private fields) so callers can pass a
 * structurally-compatible adapter instead of the real class — the
 * extension's own `HubManager` does exactly this, wrapping its
 * `HubStorage` facade's cache-aware `saveHub`/`loadHub`/`listHubs`
 * rather than the raw, cache-bypassing `HubStore` instance, so that
 * `activateProfile`/`deactivateProfile`'s config mutations stay
 * visible to `HubStorage`'s own in-memory cache.
 */
export interface HubConfigStore {
  load(id: string): Promise<LoadHubResult>;
  save(id: string, config: HubConfig, reference: HubReference): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Dependencies shared by every function in this module.
 */
export interface ProfileLifecycleDeps {
  store: HubConfigStore;
  activationStore: ProfileActivationStore;
  /**
   * Optional registry integration for properly deactivating a
   * previously-active profile (uninstalling its bundles) and
   * installing the newly-activated profile's bundles. When absent,
   * `activateProfile` falls back to flag-only bookkeeping for other
   * active profiles and skips bundle installation entirely — mirrors
   * the extension's own `if (this.registryManager)` branching.
   */
  profileSync?: ProfileLifecycleSync;
}

export interface ResolvedBundle {
  bundle: HubProfileBundle;
  url: string;
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Get the activation state for a hub, if any of its profiles is
 * currently active.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @returns The active profile's activation state, or null.
 */
export async function getActiveProfile(deps: ProfileLifecycleDeps, hubId: string): Promise<ProfileActivationState | null> {
  const all = await deps.activationStore.listAll();
  return all.find((s) => s.hubId === hubId) ?? null;
}

/**
 * List every recorded activation state, across all hubs.
 * @param deps Store dependencies.
 * @returns All activation states.
 */
export async function listAllActiveProfiles(deps: ProfileLifecycleDeps): Promise<ProfileActivationState[]> {
  return deps.activationStore.listAll();
}

/**
 * List every profile in a hub, with `active` re-derived from the
 * activation store (treated as the source of truth; the hub config's
 * own `active` flag can go briefly stale relative to it).
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param onLog Optional sink for diagnostic log events.
 * @returns Profiles from the hub, enriched with activation state.
 */
export async function listProfilesFromHub(
  deps: ProfileLifecycleDeps,
  hubId: string,
  onLog?: OnLogEvent
): Promise<HubProfile[]> {
  const hub = await deps.store.load(hubId);
  const profiles = hub.config.profiles || [];

  try {
    const activeState = await getActiveProfile(deps, hubId);
    if (activeState) {
      return profiles.map((profile) => ({
        ...profile,
        active: activeState.profileId === profile.id
      }));
    }
  } catch (error) {
    log(onLog, 'warn', `Failed to check profile activation state for hub ${hubId}`, error instanceof Error ? error : new Error(String(error)));
  }

  return profiles;
}

/**
 * Get a single profile from a hub. Throws when the hub or profile
 * doesn't exist.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @param onLog Optional sink for diagnostic log events.
 * @returns The requested profile.
 */
export async function getHubProfile(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string,
  onLog?: OnLogEvent
): Promise<HubProfile> {
  const profiles = await listProfilesFromHub(deps, hubId, onLog);
  log(onLog, 'info', `Found ${profiles.length} profiles in hub ${hubId}`);

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    log(onLog, 'error', `Profile ${profileId} not found in hub ${hubId}. Available: ${profiles.map((p) => p.id).join(', ')}`);
    throw new Error(`Profile not found: ${profileId} in hub ${hubId}`);
  }

  log(onLog, 'info', `Found profile ${profileId}: ${profile.name}`);
  log(onLog, 'info', `Profile bundles: ${JSON.stringify(profile.bundles?.map((b) => ({ id: b.id, version: b.version })) ?? [])}`);

  return profile;
}

/**
 * Resolve every bundle declared in a profile. URLs are never resolved
 * here (installation looks bundles up by id against sources instead),
 * so `url` is always empty — kept on the return shape for backward
 * compatibility with the extension's pre-existing `ProfileActivationResult`.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @param onLog Optional sink for diagnostic log events.
 * @returns Resolved bundles.
 */
export async function resolveProfileBundles(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string,
  onLog?: OnLogEvent
): Promise<ResolvedBundle[]> {
  const profile = await getHubProfile(deps, hubId, profileId, onLog);
  const resolved: ResolvedBundle[] = [];

  log(onLog, 'info', `Resolving bundles for profile ${profileId} in hub ${hubId}`);
  log(onLog, 'info', `Profile has ${profile.bundles?.length ?? 0} bundles`);

  if (!profile.bundles || profile.bundles.length === 0) {
    log(onLog, 'warn', `No bundles found in profile ${profileId}`);
    return resolved;
  }

  for (const bundle of profile.bundles) {
    log(onLog, 'info', `Resolving bundle: ${bundle.id} v${bundle.version} from source: ${bundle.source}`);
    resolved.push({ bundle, url: '' });
  }

  log(onLog, 'info', `Resolved ${resolved.length} bundles total`);
  return resolved;
}

/**
 * Set a profile's `active` flag within its hub's config and persist
 * it. Throws when the profile doesn't exist.
 * @param store Hub store.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @param active New active flag value.
 */
export async function setProfileActiveFlag(
  store: HubConfigStore,
  hubId: string,
  profileId: string,
  active: boolean
): Promise<void> {
  const { config, reference } = await store.load(hubId);
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(`Profile not found: ${profileId} in hub ${hubId}`);
  }
  profile.active = active;
  await store.save(hubId, config, reference);
}

/**
 * Activate a hub profile: deactivates every other currently-active
 * profile across all hubs (enforcing a single globally-active
 * profile), resolves and records the profile's bundles as an
 * activation state, flags the profile active in its hub config, and
 * (when requested and a registry sync is available) installs the
 * profile's bundles.
 *
 * Never throws — failures are captured in the returned result's
 * `success`/`error` fields, mirroring the extension's original
 * contract.
 * @param deps Store/registry-sync dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @param options Activation options.
 * @param onLog Optional sink for diagnostic log events.
 * @returns The activation result.
 */
export async function activateProfile(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string,
  options: ProfileActivationOptions,
  onLog?: OnLogEvent
): Promise<ProfileActivationResult> {
  try {
    log(onLog, 'info', `activateProfile called: hubId=${hubId}, profileId=${profileId}, installBundles=${options.installBundles}`);

    // Verify hub and profile exist (throws if not found)
    await getHubProfile(deps, hubId, profileId, onLog);

    // Deactivate ALL active hub profiles across ALL hubs (enforce single active profile globally).
    const allHubIds = await deps.store.list();
    for (const currentHubId of allHubIds) {
      const hubData = await deps.store.load(currentHubId);
      const activeProfile = hubData.config.profiles.find((p) => p.active);

      if (activeProfile && activeProfile.id !== profileId) {
        log(onLog, 'info', `Deactivating hub profile from hub ${currentHubId}: ${activeProfile.id}`);

        if (deps.profileSync) {
          try {
            await deps.profileSync.deactivateProfile(activeProfile.id);
          } catch (error) {
            log(onLog, 'error', `Failed to deactivate profile ${activeProfile.id}`, error instanceof Error ? error : new Error(String(error)));
          }
        } else {
          await setProfileActiveFlag(deps.store, currentHubId, activeProfile.id, false);
          await deps.activationStore.delete(currentHubId, activeProfile.id);
        }
      }
    }

    // Resolve all bundles in the profile.
    const resolvedBundles = await resolveProfileBundles(deps, hubId, profileId, onLog);

    // Create activation state with bundle versions.
    const syncedBundleVersions: Record<string, string> = {};
    for (const rb of resolvedBundles) {
      syncedBundleVersions[rb.bundle.id] = rb.bundle.version;
    }

    const activationState: ProfileActivationState = {
      hubId,
      profileId,
      activatedAt: new Date().toISOString(),
      syncedBundles: resolvedBundles.map((rb) => rb.bundle.id),
      syncedBundleVersions
    };

    // Save activation state.
    await deps.activationStore.save(hubId, profileId, activationState);

    // Mark profile as active in hub config.
    await setProfileActiveFlag(deps.store, hubId, profileId, true);

    // Install bundles if requested and a registry sync is available.
    if (options.installBundles && deps.profileSync) {
      log(onLog, 'info', `Installing ${resolvedBundles.length} bundles for profile ${profileId}`);

      const bundlesToInstall = resolvedBundles.map((rb) => ({
        bundleId: rb.bundle.id,
        options: {
          scope: 'user' as const,
          force: false,
          profileId
        }
      }));

      try {
        await deps.profileSync.installBundles(bundlesToInstall);
        log(onLog, 'info', 'Bundle installation complete');
      } catch (error) {
        log(onLog, 'error', 'Batch bundle installation failed', error instanceof Error ? error : new Error(String(error)));
      }
    } else if (options.installBundles && !deps.profileSync) {
      log(onLog, 'warn', 'Bundle installation requested but registry sync not available');
    }

    return {
      success: true,
      hubId,
      profileId,
      resolvedBundles: resolvedBundles.map((rb) => ({ bundle: rb.bundle, url: rb.url }))
    };
  } catch (error) {
    return {
      success: false,
      hubId,
      profileId,
      resolvedBundles: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Re-activate a profile to refresh its activation state (e.g. after
 * detecting upstream changes via `getProfileChanges`). Never installs
 * bundles.
 * @param deps Store/registry-sync dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @param onLog Optional sink for diagnostic log events.
 * @returns The activation result.
 */
export async function syncProfile(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string,
  onLog?: OnLogEvent
): Promise<ProfileActivationResult> {
  return activateProfile(deps, hubId, profileId, { installBundles: false }, onLog);
}

/**
 * Deactivate a profile: removes its activation state and clears its
 * hub config's `active` flag. Never throws — failures are captured in
 * the returned result.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @returns The deactivation result.
 */
export async function deactivateProfile(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string
): Promise<ProfileDeactivationResult> {
  try {
    // Verify profile exists (throws if not found).
    await getHubProfile(deps, hubId, profileId);

    // Get current activation state to track removed bundles.
    const currentState = await deps.activationStore.get(hubId, profileId);
    const removedBundles = currentState ? currentState.syncedBundles : [];

    // Remove activation state.
    await deps.activationStore.delete(hubId, profileId);

    // Mark profile as inactive.
    await setProfileActiveFlag(deps.store, hubId, profileId, false);

    return { success: true, hubId, profileId, removedBundles };
  } catch (error) {
    return {
      success: false,
      hubId,
      profileId,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Diff an active profile's recorded activation state against its
 * current hub config to detect bundle/metadata drift.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @returns The detected changes, or null if the profile isn't active.
 */
export async function getProfileChanges(
  deps: ProfileLifecycleDeps,
  hubId: string,
  profileId: string
): Promise<ProfileChanges | null> {
  const state = await deps.activationStore.get(hubId, profileId);
  if (!state) {
    return null;
  }

  const currentProfile = await getHubProfile(deps, hubId, profileId);

  const syncedBundles = state.syncedBundles;

  const currentBundleIds = currentProfile.bundles.map((b) => b.id);
  const bundlesAdded = currentProfile.bundles.filter((b) => !syncedBundles.includes(b.id));
  const bundlesRemoved = syncedBundles.filter((id) => !currentBundleIds.includes(id));

  const bundlesUpdated: { id: string; oldVersion: string; newVersion: string }[] = [];
  const profileUpdated = new Date(currentProfile.updatedAt) > new Date(state.activatedAt);

  if (state.syncedBundleVersions) {
    for (const bundle of currentProfile.bundles) {
      const syncedVersion = state.syncedBundleVersions[bundle.id];
      if (syncedVersion && syncedVersion !== bundle.version) {
        bundlesUpdated.push({ id: bundle.id, oldVersion: syncedVersion, newVersion: bundle.version });
      }
    }
  }

  const metadataChanged: { name?: boolean; description?: boolean; icon?: boolean } = {};
  if (profileUpdated) {
    metadataChanged.name = true;
    metadataChanged.description = true;
  }

  const changes: ProfileChanges = {};
  if (bundlesAdded.length > 0) {
    changes.bundlesAdded = bundlesAdded;
  }
  if (bundlesRemoved.length > 0) {
    changes.bundlesRemoved = bundlesRemoved;
  }
  if (bundlesUpdated.length > 0) {
    changes.bundlesUpdated = bundlesUpdated;
  }
  if (Object.keys(metadataChanged).length > 0) {
    changes.metadataChanged = metadataChanged;
  }

  return changes;
}

/**
 * Check whether an active profile has any detected changes.
 * @param deps Store dependencies.
 * @param hubId Hub identifier.
 * @param profileId Profile identifier.
 * @returns true iff `getProfileChanges` would return a non-empty result.
 */
export async function hasProfileChanges(deps: ProfileLifecycleDeps, hubId: string, profileId: string): Promise<boolean> {
  const changes = await getProfileChanges(deps, hubId, profileId);
  if (!changes) {
    return false;
  }
  return (
    (changes.bundlesAdded !== undefined && changes.bundlesAdded.length > 0)
    || (changes.bundlesRemoved !== undefined && changes.bundlesRemoved.length > 0)
    || (changes.bundlesUpdated !== undefined && changes.bundlesUpdated.length > 0)
    || (changes.metadataChanged !== undefined && Object.keys(changes.metadataChanged).length > 0)
  );
}

/**
 * Format detected profile changes as a human-readable, newline-joined
 * summary.
 * @param changes Changes to format.
 * @returns The formatted summary.
 */
export function formatChangeSummary(changes: ProfileChanges): string {
  const lines: string[] = [];

  if (changes.bundlesAdded && changes.bundlesAdded.length > 0) {
    lines.push('Added bundles:');
    for (const bundle of changes.bundlesAdded) {
      lines.push(`  + ${bundle.id} v${bundle.version}`);
    }
  }

  if (changes.bundlesRemoved && changes.bundlesRemoved.length > 0) {
    lines.push('Removed bundles:');
    for (const bundleId of changes.bundlesRemoved) {
      lines.push(`  - ${bundleId}`);
    }
  }

  if (changes.bundlesUpdated && changes.bundlesUpdated.length > 0) {
    lines.push('Updated bundles:');
    for (const update of changes.bundlesUpdated) {
      lines.push(`  ~ ${update.id}: ${update.oldVersion} → ${update.newVersion}`);
    }
  }

  if (changes.metadataChanged && Object.keys(changes.metadataChanged).length > 0) {
    lines.push('Metadata changes:');
    if (changes.metadataChanged.name) {
      lines.push('  ~ name changed');
    }
    if (changes.metadataChanged.description) {
      lines.push('  ~ description changed');
    }
    if (changes.metadataChanged.icon) {
      lines.push('  ~ icon changed');
    }
  }

  return lines.join('\n');
}

/**
 * Build a dialog description for resolving a profile's detected
 * changes (sync / review / cancel).
 * @param changes Changes to summarize in the dialog.
 * @returns The dialog description.
 */
export function createConflictResolutionDialog(changes: ProfileChanges): ConflictResolutionDialog {
  const changeCount =
    (changes.bundlesAdded?.length ?? 0)
    + (changes.bundlesRemoved?.length ?? 0)
    + (changes.bundlesUpdated?.length ?? 0)
    + (changes.metadataChanged ? 1 : 0);

  return {
    title: 'Profile Updates Available',
    message: `${changeCount} change${changeCount > 1 ? 's' : ''} detected in the profile`,
    options: [
      { label: 'Sync Now', description: 'Accept all changes and update profile', action: 'sync' },
      { label: 'Review Changes', description: 'View detailed changes before syncing', action: 'review' },
      { label: 'Cancel', description: 'Keep current profile version', action: 'cancel' }
    ]
  };
}
