/**
 * Merge hub-provided and local profiles into one list — ported from
 * `src/services/registry-manager.ts`'s `listProfiles`/`isHubProfile`.
 * Part of the `RegistryManager` scoping pass's slice 6 (migration plan
 * §7.5 item 3).
 * @module registry/list-all-profiles
 */
import type {
  HubProfileReader,
  Profile,
  ProfileStore,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Whether a profile id belongs to the active hub's profiles.
 * @param hub Hub profile reader, or `undefined` when no `HubManager` is wired.
 * @param profileId Profile identifier to check.
 * @returns `true` iff a hub profile with this id is currently active.
 */
export async function isHubProfile(hub: HubProfileReader | undefined, profileId: string): Promise<boolean> {
  if (!hub) {
    return false;
  }

  const hubProfiles = await hub.listActiveHubProfiles();
  return hubProfiles.some((p) => p.id === profileId);
}

/**
 * List every profile — hub-provided profiles from the active hub
 * (decorated with `active` re-derived from the activation store, and a
 * default 📦 icon when none is set) followed by local profiles.
 * @param store Local profile storage.
 * @param hub Hub profile reader, or `undefined` when no `HubManager` is wired.
 * @param onLog Optional sink for diagnostic log events.
 * @returns All profiles, hub-provided first.
 */
export async function listAllProfiles(
  store: ProfileStore,
  hub: HubProfileReader | undefined,
  onLog?: OnLogEvent
): Promise<Profile[]> {
  const allProfiles: Profile[] = [];

  if (hub) {
    try {
      const hubProfiles = await hub.listActiveHubProfiles();
      const activeProfiles = await hub.listAllActiveProfiles();
      const activeProfileIds = new Set(activeProfiles.map((ap) => ap.profileId));

      const convertedHubProfiles = hubProfiles.map((hp) => ({
        ...hp,
        icon: hp.icon || '📦',
        active: activeProfileIds.has(hp.id)
      }));
      allProfiles.push(...convertedHubProfiles);
    } catch (error) {
      log(onLog, 'warn', 'Failed to get hub profiles', error instanceof Error ? error : new Error(String(error)));
    }
  }

  const localProfiles = await store.getProfiles();
  allProfiles.push(...localProfiles);

  return allProfiles;
}
