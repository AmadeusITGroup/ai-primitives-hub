/**
 * Deactivate a profile (hub-provided or local) and uninstall its
 * bundles — ported from `src/services/registry-manager.ts`'s
 * `deactivateProfile`. Part of the `RegistryManager` scoping pass's
 * slice 6 (migration plan §7.5 item 3).
 *
 * Deliberately fires no events itself: the caller already knows the
 * `profileId` it passed in, so its thin wrapper can fire
 * `_onProfileDeactivated` right after this resolves (or skip it, if
 * this throws) with no return value needed — simpler than every other
 * `registry/*` use-case, which return data the caller doesn't already
 * have.
 * @module registry/deactivate-registry-profile
 */
import type {
  HubProfileSync,
  InstalledBundle,
  Profile,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Dependencies needed to deactivate a profile.
 */
export interface DeactivateRegistryProfilePorts {
  getProfiles(): Promise<Profile[]>;
  updateProfile(profileId: string, updates: Partial<Profile>): Promise<void>;
  getInstalledBundles(): Promise<InstalledBundle[]>;
  uninstallBundles(bundleIds: string[]): Promise<void>;
  /** Present only when a `HubManager` is wired (mirrors the extension's own `if (this.hubManager)` branching). */
  hub?: HubProfileSync;
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Deactivate a profile: if it's hub-provided, delegate to the hub
 * sync port; otherwise flag it inactive locally. Either way, uninstall
 * every bundle recorded against this `profileId`. Throws when a local
 * profile id doesn't exist (mirrors the original).
 * @param ports Read/write access to profiles, installed bundles, and (optionally) the hub.
 * @param profileId Profile to deactivate.
 * @param onLog Optional sink for diagnostic log events.
 */
export async function deactivateRegistryProfile(
  ports: DeactivateRegistryProfilePorts,
  profileId: string,
  onLog?: OnLogEvent
): Promise<void> {
  log(onLog, 'info', `Deactivating profile: ${profileId}`);

  if (ports.hub) {
    const hubProfiles = await ports.hub.listActiveHubProfiles();
    const hubProfile = hubProfiles.find((p) => p.id === profileId);

    if (hubProfile) {
      log(onLog, 'info', `Profile ${profileId} is from hub, delegating to HubManager`);
      await ports.hub.deactivateProfile(hubProfile.hubId, profileId);

      const bundles = (await ports.getInstalledBundles()).filter((b) => b.profileId === profileId);
      if (bundles.length > 0) {
        log(onLog, 'info', `Uninstalling ${bundles.length} bundles from hub profile '${profileId}'`);
        await ports.uninstallBundles(bundles.map((b) => b.bundleId));
      }

      log(onLog, 'info', `Profile deactivated: ${profileId}`);
      return;
    }
  }

  const profiles = await ports.getProfiles();
  const profile = profiles.find((p) => p.id === profileId);

  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  const installedBundles = await ports.getInstalledBundles();
  const profileBundles = installedBundles.filter((b) => b.profileId === profileId);

  log(onLog, 'info', `Uninstalling ${profileBundles.length} bundles from profile '${profileId}'`);
  await ports.uninstallBundles(profileBundles.map((b) => b.bundleId));

  await ports.updateProfile(profileId, { active: false });

  log(onLog, 'info', `Profile '${profileId}' deactivated successfully`);
}
