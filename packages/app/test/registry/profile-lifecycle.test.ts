/**
 * Tests for registry/profile-lifecycle.ts (Stage 4: profile
 * activation/deactivation lifecycle + conflict detection).
 */
import type {
  HubConfig,
  HubProfile,
  HubReference,
  ProfileActivationState,
  ProfileChanges,
  ProfileLifecycleSync,
} from '@ai-primitives-hub/core';
import type {
  ProfileActivationStore,
} from '@ai-primitives-hub/infra';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  activateProfile,
  createConflictResolutionDialog,
  deactivateProfile,
  formatChangeSummary,
  getActiveProfile,
  getHubProfile,
  getProfileChanges,
  hasProfileChanges,
  type HubConfigStore,
  listAllActiveProfiles,
  listProfilesFromHub,
  type ProfileLifecycleDeps,
  resolveProfileBundles,
  setProfileActiveFlag,
  syncProfile,
} from '../../src/registry/profile-lifecycle';
import type {
  LogEvent,
} from '../../src/update/log-event';

function makeProfile(overrides: Partial<HubProfile> = {}): HubProfile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    description: 'd',
    icon: '📦',
    bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: true }],
    active: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeConfig(profiles: HubProfile[], name = 'Test Hub'): HubConfig {
  return {
    version: '1.0.0',
    metadata: { name, description: 'd', maintainer: 'm', updatedAt: '2024-01-01T00:00:00.000Z' },
    sources: [],
    profiles
  };
}

function makeStore(
  hubs: Record<string, { config: HubConfig; reference: HubReference }> = {}
): HubConfigStore {
  const saved = new Map(Object.entries(hubs));
  return {
    save: vi.fn(async (id: string, config: HubConfig, reference: HubReference) => {
      saved.set(id, { config, reference });
    }),
    load: vi.fn(async (id: string) => {
      const entry = saved.get(id);
      if (!entry) {
        throw new Error(`Hub not found: ${id}`);
      }
      return entry;
    }),
    list: vi.fn(async () => [...saved.keys()])
  };
}

function makeActivationStore(): ProfileActivationStore {
  const state = new Map<string, ProfileActivationState>();
  const key = (hubId: string, profileId: string): string => `${hubId}_${profileId}`;
  return {
    get: vi.fn(async (hubId: string, profileId: string) => state.get(key(hubId, profileId)) ?? null),
    save: vi.fn(async (hubId: string, profileId: string, activationState: ProfileActivationState) => {
      state.set(key(hubId, profileId), activationState);
    }),
    delete: vi.fn(async (hubId: string, profileId: string) => {
      state.delete(key(hubId, profileId));
    }),
    listAll: vi.fn(async () => [...state.values()])
  } as unknown as ProfileActivationStore;
}

function makeProfileSync(): ProfileLifecycleSync {
  return {
    deactivateProfile: vi.fn(async () => {}),
    installBundles: vi.fn(async () => {})
  };
}

const REF: HubReference = { type: 'local', location: '/a.yml' };

describe('profile-lifecycle', () => {
  let store: HubConfigStore;
  let activationStore: ProfileActivationStore;
  let deps: ProfileLifecycleDeps;

  beforeEach(() => {
    store = makeStore({ 'test-hub': { config: makeConfig([makeProfile()]), reference: REF } });
    activationStore = makeActivationStore();
    deps = { store, activationStore };
  });

  describe('setProfileActiveFlag', () => {
    it('sets the active flag and persists the hub', async () => {
      await setProfileActiveFlag(store, 'test-hub', 'profile-1', true);
      const { config } = await store.load('test-hub');
      expect(config.profiles[0].active).toBe(true);
    });

    it('throws when the profile does not exist', async () => {
      await expect(setProfileActiveFlag(store, 'test-hub', 'missing', true)).rejects.toThrow('Profile not found: missing in hub test-hub');
    });
  });

  describe('getActiveProfile / listAllActiveProfiles', () => {
    it('returns null when no profile is active for a hub', async () => {
      expect(await getActiveProfile(deps, 'test-hub')).toBeNull();
    });

    it('returns the active state for a hub', async () => {
      const state: ProfileActivationState = { hubId: 'test-hub', profileId: 'profile-1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] };
      await activationStore.save('test-hub', 'profile-1', state);
      expect(await getActiveProfile(deps, 'test-hub')).toEqual(state);
    });

    it('lists every active state across hubs', async () => {
      await activationStore.save('hub-a', 'p1', { hubId: 'hub-a', profileId: 'p1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] });
      await activationStore.save('hub-b', 'p1', { hubId: 'hub-b', profileId: 'p1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] });
      expect(await listAllActiveProfiles(deps)).toHaveLength(2);
    });
  });

  describe('listProfilesFromHub', () => {
    it('returns profiles unenriched when no profile is active', async () => {
      const profiles = await listProfilesFromHub(deps, 'test-hub');
      expect(profiles).toHaveLength(1);
      expect(profiles[0].active).toBe(false);
    });

    it('re-derives active from the activation store', async () => {
      await activationStore.save('test-hub', 'profile-1', { hubId: 'test-hub', profileId: 'profile-1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] });
      const profiles = await listProfilesFromHub(deps, 'test-hub');
      expect(profiles[0].active).toBe(true);
    });

    it('gracefully degrades to unenriched profiles if the activation store throws', async () => {
      (activationStore.listAll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      const events: LogEvent[] = [];
      const profiles = await listProfilesFromHub(deps, 'test-hub', (e) => events.push(e));
      expect(profiles).toHaveLength(1);
      expect(events.some((e) => e.level === 'warn')).toBe(true);
    });

    it('propagates hub-not-found errors', async () => {
      await expect(listProfilesFromHub(deps, 'missing-hub')).rejects.toThrow('Hub not found: missing-hub');
    });
  });

  describe('getHubProfile', () => {
    it('returns the matching profile', async () => {
      const profile = await getHubProfile(deps, 'test-hub', 'profile-1');
      expect(profile.id).toBe('profile-1');
    });

    it('throws when the profile does not exist', async () => {
      await expect(getHubProfile(deps, 'test-hub', 'missing')).rejects.toThrow('Profile not found: missing in hub test-hub');
    });

    it('throws when the hub does not exist', async () => {
      await expect(getHubProfile(deps, 'missing-hub', 'profile-1')).rejects.toThrow('Hub not found: missing-hub');
    });
  });

  describe('resolveProfileBundles', () => {
    it('resolves every bundle in the profile with an empty url', async () => {
      const resolved = await resolveProfileBundles(deps, 'test-hub', 'profile-1');
      expect(resolved).toEqual([{ bundle: makeProfile().bundles[0], url: '' }]);
    });

    it('returns an empty array for a profile with no bundles', async () => {
      store = makeStore({ 'test-hub': { config: makeConfig([makeProfile({ bundles: [] })]), reference: REF } });
      deps = { store, activationStore };
      const resolved = await resolveProfileBundles(deps, 'test-hub', 'profile-1');
      expect(resolved).toEqual([]);
    });
  });

  describe('activateProfile', () => {
    it('activates the profile: creates activation state and flags it active', async () => {
      const result = await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });

      expect(result.success).toBe(true);
      expect(result.resolvedBundles).toHaveLength(1);

      const state = await activationStore.get('test-hub', 'profile-1');
      expect(state?.hubId).toBe('test-hub');
      expect(state?.syncedBundles).toEqual(['bundle-1']);

      const { config } = await store.load('test-hub');
      expect(config.profiles[0].active).toBe(true);
    });

    it('fails gracefully for a non-existent hub', async () => {
      const result = await activateProfile(deps, 'missing-hub', 'profile-1', { installBundles: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Hub not found');
    });

    it('fails gracefully for a non-existent profile', async () => {
      const result = await activateProfile(deps, 'test-hub', 'missing', { installBundles: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Profile not found');
    });

    it('deactivates another hub\'s active profile via the flag-only fallback when no profileSync is configured', async () => {
      store = makeStore({
        'hub-a': { config: makeConfig([makeProfile({ id: 'p1', active: true })]), reference: REF },
        'hub-b': { config: makeConfig([makeProfile({ id: 'p2' })]), reference: REF }
      });
      deps = { store, activationStore };
      await activationStore.save('hub-a', 'p1', { hubId: 'hub-a', profileId: 'p1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] });

      await activateProfile(deps, 'hub-b', 'p2', { installBundles: false });

      const { config } = await store.load('hub-a');
      expect(config.profiles[0].active).toBe(false);
      expect(await activationStore.get('hub-a', 'p1')).toBeNull();
    });

    it('deactivates another hub\'s active profile via profileSync when configured', async () => {
      store = makeStore({
        'hub-a': { config: makeConfig([makeProfile({ id: 'p1', active: true })]), reference: REF },
        'hub-b': { config: makeConfig([makeProfile({ id: 'p2' })]), reference: REF }
      });
      const profileSync = makeProfileSync();
      deps = { store, activationStore, profileSync };

      await activateProfile(deps, 'hub-b', 'p2', { installBundles: false });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock method reference, not a real unbound this call
      expect(profileSync.deactivateProfile).toHaveBeenCalledWith('p1');
    });

    it('continues activation even if profileSync.deactivateProfile throws', async () => {
      store = makeStore({
        'hub-a': { config: makeConfig([makeProfile({ id: 'p1', active: true })]), reference: REF },
        'hub-b': { config: makeConfig([makeProfile({ id: 'p2' })]), reference: REF }
      });
      const profileSync = makeProfileSync();
      (profileSync.deactivateProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      deps = { store, activationStore, profileSync };

      const result = await activateProfile(deps, 'hub-b', 'p2', { installBundles: false });
      expect(result.success).toBe(true);
    });

    it('does not touch other hubs\' active profiles that already match the target profileId', async () => {
      store = makeStore({
        'test-hub': { config: makeConfig([makeProfile({ id: 'profile-1', active: true })]), reference: REF }
      });
      deps = { store, activationStore };

      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });

      const { config } = await store.load('test-hub');
      expect(config.profiles[0].active).toBe(true);
    });

    it('installs bundles via profileSync when installBundles is true', async () => {
      const profileSync = makeProfileSync();
      deps = { store, activationStore, profileSync };

      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: true });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock method reference, not a real unbound this call
      expect(profileSync.installBundles).toHaveBeenCalledWith([
        { bundleId: 'bundle-1', options: { scope: 'user', force: false, profileId: 'profile-1' } }
      ]);
    });

    it('warns but does not fail when installBundles is true and no profileSync is configured', async () => {
      const events: LogEvent[] = [];
      const result = await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: true }, (e) => events.push(e));

      expect(result.success).toBe(true);
      expect(events.some((e) => e.level === 'warn' && e.message.includes('registry sync not available'))).toBe(true);
    });

    it('succeeds even if profileSync.installBundles throws', async () => {
      const profileSync = makeProfileSync();
      (profileSync.installBundles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      deps = { store, activationStore, profileSync };

      const result = await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: true });
      expect(result.success).toBe(true);
    });

    it('emits diagnostic log events', async () => {
      const events: LogEvent[] = [];
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false }, (e) => events.push(e));
      expect(events.some((e) => e.message.includes('activateProfile called'))).toBe(true);
    });
  });

  describe('syncProfile', () => {
    it('re-activates the profile without installing bundles', async () => {
      const profileSync = makeProfileSync();
      deps = { store, activationStore, profileSync };

      const result = await syncProfile(deps, 'test-hub', 'profile-1');

      expect(result.success).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock method reference, not a real unbound this call
      expect(profileSync.installBundles).not.toHaveBeenCalled();
    });

    it('updates the activation timestamp on each call', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      const first = await activationStore.get('test-hub', 'profile-1');

      await new Promise((resolve) => setTimeout(resolve, 5));
      await syncProfile(deps, 'test-hub', 'profile-1');
      const second = await activationStore.get('test-hub', 'profile-1');

      expect(new Date(second!.activatedAt).getTime()).toBeGreaterThan(new Date(first!.activatedAt).getTime());
    });
  });

  describe('deactivateProfile', () => {
    it('removes activation state and clears the active flag', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });

      const result = await deactivateProfile(deps, 'test-hub', 'profile-1');

      expect(result.success).toBe(true);
      expect(result.removedBundles).toEqual(['bundle-1']);
      expect(await activationStore.get('test-hub', 'profile-1')).toBeNull();

      const { config } = await store.load('test-hub');
      expect(config.profiles[0].active).toBe(false);
    });

    it('succeeds (with an empty removedBundles) when deactivating a non-active profile', async () => {
      const result = await deactivateProfile(deps, 'test-hub', 'profile-1');
      expect(result.success).toBe(true);
      expect(result.removedBundles).toEqual([]);
    });

    it('fails gracefully for a non-existent profile', async () => {
      const result = await deactivateProfile(deps, 'test-hub', 'missing');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('fails gracefully for a non-existent hub', async () => {
      const result = await deactivateProfile(deps, 'missing-hub', 'profile-1');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getProfileChanges / hasProfileChanges', () => {
    it('returns null when the profile is not activated', async () => {
      expect(await getProfileChanges(deps, 'test-hub', 'profile-1')).toBeNull();
      expect(await hasProfileChanges(deps, 'test-hub', 'profile-1')).toBe(false);
    });

    it('returns no changes when nothing has drifted', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      expect(await getProfileChanges(deps, 'test-hub', 'profile-1')).toEqual({});
      expect(await hasProfileChanges(deps, 'test-hub', 'profile-1')).toBe(false);
    });

    it('detects added bundles', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      const { config, reference } = await store.load('test-hub');
      config.profiles[0].bundles.push({ id: 'bundle-2', version: '1.0.0', source: 's', required: false });
      await store.save('test-hub', config, reference);

      const changes = await getProfileChanges(deps, 'test-hub', 'profile-1');
      expect(changes?.bundlesAdded?.map((b) => b.id)).toEqual(['bundle-2']);
      expect(await hasProfileChanges(deps, 'test-hub', 'profile-1')).toBe(true);
    });

    it('detects removed bundles', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      const { config, reference } = await store.load('test-hub');
      config.profiles[0].bundles = [];
      await store.save('test-hub', config, reference);

      const changes = await getProfileChanges(deps, 'test-hub', 'profile-1');
      expect(changes?.bundlesRemoved).toEqual(['bundle-1']);
    });

    it('detects updated bundle versions', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      const { config, reference } = await store.load('test-hub');
      config.profiles[0].bundles[0].version = '2.0.0';
      await store.save('test-hub', config, reference);

      const changes = await getProfileChanges(deps, 'test-hub', 'profile-1');
      expect(changes?.bundlesUpdated).toEqual([{ id: 'bundle-1', oldVersion: '1.0.0', newVersion: '2.0.0' }]);
    });

    it('detects metadata changes via the updatedAt timestamp', async () => {
      await activateProfile(deps, 'test-hub', 'profile-1', { installBundles: false });
      const { config, reference } = await store.load('test-hub');
      config.profiles[0].name = 'Renamed';
      config.profiles[0].updatedAt = new Date(Date.now() + 60_000).toISOString();
      await store.save('test-hub', config, reference);

      const changes = await getProfileChanges(deps, 'test-hub', 'profile-1');
      expect(changes?.metadataChanged).toEqual({ name: true, description: true });
    });
  });

  describe('formatChangeSummary', () => {
    it('formats added bundles', () => {
      const changes: ProfileChanges = { bundlesAdded: [{ id: 'bundle-2', version: '2.0.0', source: 's', required: false }] };
      const summary = formatChangeSummary(changes);
      expect(summary).toContain('Added bundles');
      expect(summary).toContain('bundle-2');
      expect(summary).toContain('2.0.0');
    });

    it('formats removed bundles', () => {
      const summary = formatChangeSummary({ bundlesRemoved: ['bundle-1'] });
      expect(summary).toContain('Removed bundles');
      expect(summary).toContain('bundle-1');
    });

    it('formats updated bundles', () => {
      const summary = formatChangeSummary({ bundlesUpdated: [{ id: 'bundle-1', oldVersion: '1.0.0', newVersion: '2.0.0' }] });
      expect(summary).toContain('Updated bundles');
      expect(summary).toContain('1.0.0');
      expect(summary).toContain('2.0.0');
    });

    it('formats metadata changes', () => {
      const summary = formatChangeSummary({ metadataChanged: { name: true, description: true, icon: true } });
      expect(summary).toContain('Metadata changes');
      expect(summary).toContain('name changed');
      expect(summary).toContain('description changed');
      expect(summary).toContain('icon changed');
    });

    it('returns an empty string for no changes', () => {
      expect(formatChangeSummary({})).toBe('');
    });
  });

  describe('createConflictResolutionDialog', () => {
    it('builds a dialog with sync/review/cancel options', () => {
      const dialog = createConflictResolutionDialog({ bundlesAdded: [{ id: 'b', version: '1.0.0', source: 's', required: false }] });

      expect(dialog.title).toBe('Profile Updates Available');
      expect(dialog.options).toHaveLength(3);
      expect(dialog.options.find((o) => o.action === 'sync')?.label).toContain('Sync');
      expect(dialog.options.find((o) => o.action === 'review')?.label).toContain('Review');
      expect(dialog.options.find((o) => o.action === 'cancel')).toBeDefined();
    });

    it('pluralizes the change count message', () => {
      const dialog = createConflictResolutionDialog({ bundlesAdded: [{ id: 'a', version: '1.0.0', source: 's', required: false }], bundlesRemoved: ['b'] });
      expect(dialog.message).toBe('2 changes detected in the profile');
    });

    it('uses singular phrasing for a single change', () => {
      const dialog = createConflictResolutionDialog({ bundlesRemoved: ['b'] });
      expect(dialog.message).toBe('1 change detected in the profile');
    });
  });
});
