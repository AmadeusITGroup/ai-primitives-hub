/**
 * Activate a profile (hub-provided or local): deactivate every other
 * active profile, then either delegate to the hub sync port or
 * install the local profile's bundles — ported from
 * `src/services/registry-manager.ts`'s `activateProfile` plus its
 * private `validateProfileId`/`deactivateOtherProfiles`/
 * `getProfileById`/`installProfileBundles`/`installProfileBundle`
 * helpers. Part of the `RegistryManager` scoping pass's slice 6
 * (migration plan §7.5 item 3).
 *
 * The original wraps this whole flow in `vscode.window.withProgress`,
 * reporting a message at each checkpoint. That's presentation-only
 * VS Code glue, so it stays in the extension; every checkpoint message
 * here goes through `onLog` at `'info'` level instead, which the
 * extension's thin wrapper forwards to both its `Logger` and the
 * progress notification — same UX, no `vscode.Progress` dependency
 * here.
 *
 * Also preserves two original quirks verbatim rather than silently
 * tidying them up (flagged inline): the local-profile path runs a
 * second, redundant "deactivate other local profiles" pass after
 * already having done so once up front (harmless — everything else is
 * already inactive by then, but real, original behavior), and fires
 * what would be two `_onProfileActivated` events for the same profile
 * (the extension's thin wrapper reproduces this from this module's
 * return value).
 * @module registry/activate-registry-profile
 */
import type {
  Bundle,
  HubProfileSync,
  HubProfileWithMetadata,
  InstalledBundle,
  InstallOptions,
  Profile,
  ProfileBundle,
  RegistrySource,
  SearchQuery,
  SourceAdapter,
  SourceType,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/** Mirrors the extension's `CONCURRENCY_CONSTANTS.REGISTRY_BATCH_LIMIT` — this module is its only remaining consumer. */
const PROFILE_BUNDLE_INSTALL_BATCH_LIMIT = 5;

/**
 * Dependencies needed to activate a profile.
 */
export interface ActivateRegistryProfilePorts {
  getProfiles(): Promise<Profile[]>;
  updateProfile(profileId: string, updates: Partial<Profile>): Promise<void>;
  getSources(): Promise<RegistrySource[]>;
  getInstalledBundles(): Promise<InstalledBundle[]>;
  searchBundles(query: SearchQuery): Promise<Bundle[]>;
  getAdapter(source: RegistrySource): SourceAdapter;
  installFromBuffer(bundle: Bundle, buffer: Buffer, options: InstallOptions, sourceType: SourceType): Promise<InstalledBundle>;
  recordInstallation(installation: InstalledBundle): Promise<void>;
  /** Deactivate one other profile, hub or local — the caller's own already-event-firing `deactivateProfile`. */
  deactivateOther(profileId: string): Promise<void>;
  /** Present only when a `HubManager` is wired (mirrors the extension's own `if (this.hubManager)` branching). */
  hub?: HubProfileSync;
}

export interface ActivateRegistryProfileResult {
  /** Set when the target turned out to be hub-provided (delegated to `hub.activateProfile`). */
  hubActivation?: { hubProfile: HubProfileWithMetadata };
  /** Set for the local-profile path. */
  localActivation?: { profile: Profile; installedBundles: InstalledBundle[] };
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

function validateProfileId(profileId: unknown): string {
  if (typeof profileId !== 'string') {
    if (profileId && typeof profileId === 'object' && 'id' in profileId) {
      return (profileId as { id: string }).id;
    }
    throw new Error(`Invalid profile identifier: expected string, got ${typeof profileId}`);
  }
  return profileId;
}

async function getProfileById(ports: ActivateRegistryProfilePorts, profileId: string): Promise<Profile> {
  const profiles = await ports.getProfiles();
  const profile = profiles.find((p) => p.id === profileId);

  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  return profile;
}

/**
 * Deactivate every other currently-active local profile. Called
 * twice by `activateRegistryProfile` (see module doc) — kept as a
 * shared helper to avoid duplicating the loop body, not to change
 * how many times it runs.
 * @param ports Read/write access to local profiles and the deactivation callback.
 * @param targetProfileId Profile being activated — never deactivated by this pass.
 * @param onLog Optional sink for diagnostic log events.
 */
async function deactivateOtherLocalProfiles(
  ports: ActivateRegistryProfilePorts,
  targetProfileId: string,
  onLog: OnLogEvent | undefined
): Promise<void> {
  const profiles = await ports.getProfiles();

  for (const profile of profiles) {
    if (profile.active && profile.id !== targetProfileId) {
      log(onLog, 'info', `Deactivating previous profile: ${profile.id}`);
      try {
        await ports.deactivateOther(profile.id);
      } catch (error) {
        log(onLog, 'error', `Failed to deactivate profile ${profile.id}`, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

async function installProfileBundle(
  ports: ActivateRegistryProfilePorts,
  bundleRef: ProfileBundle,
  profileId: string,
  allSources: RegistrySource[]
): Promise<InstalledBundle | null> {
  const installedBundles = await ports.getInstalledBundles();
  const alreadyInstalled = installedBundles.find((b) => b.bundleId === bundleRef.id);

  if (alreadyInstalled) {
    return null;
  }

  const searchResults = await ports.searchBundles({ text: bundleRef.id, tags: [], sourceId: bundleRef.sourceId });

  const matchingBundle = searchResults.find((b) => {
    const idMatch = b.id === bundleRef.id || b.name.toLowerCase().includes(bundleRef.id.toLowerCase());
    if (bundleRef.sourceId) {
      return idMatch && b.sourceId === bundleRef.sourceId;
    }
    return idMatch;
  });

  if (!matchingBundle) {
    return null;
  }

  const source = allSources.find((s) => s.id === matchingBundle.sourceId);
  if (!source) {
    return null;
  }

  const adapter = ports.getAdapter(source);
  const bundleBuffer = await adapter.downloadBundle(matchingBundle);

  const options: InstallOptions = { scope: 'user', force: false, profileId };
  const installation = await ports.installFromBuffer(matchingBundle, bundleBuffer, options, source.type);

  installation.sourceId = matchingBundle.sourceId;
  installation.sourceType = source.type;

  await ports.recordInstallation(installation);

  return installation;
}

async function installProfileBundles(
  ports: ActivateRegistryProfilePorts,
  profile: Profile,
  profileId: string,
  onLog: OnLogEvent | undefined
): Promise<InstalledBundle[]> {
  if (!profile.bundles || profile.bundles.length === 0) {
    return [];
  }

  log(onLog, 'info', `Installing ${profile.bundles.length} bundle(s)...`);

  const allSources = await ports.getSources();
  const installed: InstalledBundle[] = [];

  for (let i = 0; i < profile.bundles.length; i += PROFILE_BUNDLE_INSTALL_BATCH_LIMIT) {
    const chunk = profile.bundles.slice(i, i + PROFILE_BUNDLE_INSTALL_BATCH_LIMIT);

    const results = await Promise.all(chunk.map(async (bundleRef) => {
      log(onLog, 'info', `Installing ${bundleRef.id}...`);
      try {
        return await installProfileBundle(ports, bundleRef, profileId, allSources);
      } catch (error) {
        log(onLog, 'error', `Failed to install bundle ${bundleRef.id}`, error instanceof Error ? error : new Error(String(error)));
        return null;
      }
    }));

    for (const result of results) {
      if (result) {
        installed.push(result);
      }
    }
  }

  return installed;
}

/**
 * Activate a profile.
 * @param ports Read/write access to profiles, sources, bundles, and (optionally) the hub.
 * @param profileId Profile to activate (or a legacy `{id}` object — see `validateProfileId`).
 * @param onLog Optional sink for diagnostic log events (also drives the extension's progress UI).
 * @returns Which path was taken, and its outcome — see `ActivateRegistryProfileResult`.
 */
export async function activateRegistryProfile(
  ports: ActivateRegistryProfilePorts,
  profileId: unknown,
  onLog?: OnLogEvent
): Promise<ActivateRegistryProfileResult> {
  const validatedProfileId = validateProfileId(profileId);
  log(onLog, 'info', `Activating profile: ${validatedProfileId}`);
  log(onLog, 'info', 'Deactivating other profiles...');

  if (ports.hub) {
    const activeHubProfiles = await ports.hub.listAllActiveProfiles();
    for (const activeProfile of activeHubProfiles) {
      if (activeProfile.profileId !== validatedProfileId) {
        log(onLog, 'info', `Deactivating hub profile: ${activeProfile.profileId}`);
        try {
          await ports.deactivateOther(activeProfile.profileId);
        } catch (error) {
          log(onLog, 'error', `Failed to deactivate hub profile ${activeProfile.profileId}`, error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  await deactivateOtherLocalProfiles(ports, validatedProfileId, onLog);

  if (ports.hub) {
    const hubProfiles = await ports.hub.listActiveHubProfiles();
    const hubProfile = hubProfiles.find((p) => p.id === validatedProfileId);
    if (hubProfile) {
      log(onLog, 'info', `Profile ${validatedProfileId} is from hub, delegating to HubManager`);
      await ports.hub.activateProfile(hubProfile.hubId, validatedProfileId, { installBundles: true });
      return { hubActivation: { hubProfile } };
    }
  }

  log(onLog, 'info', 'Installing bundles...');
  const profile = await getProfileById(ports, validatedProfileId);

  // Second, redundant local-deactivation pass — see module doc.
  await deactivateOtherLocalProfiles(ports, validatedProfileId, onLog);

  const installedBundles = await installProfileBundles(ports, profile, validatedProfileId, onLog);

  await ports.updateProfile(validatedProfileId, { active: true });

  log(onLog, 'info', `Profile '${validatedProfileId}' activated successfully`);

  return { localActivation: { profile, installedBundles } };
}
