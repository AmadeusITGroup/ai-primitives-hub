/**
 * Tests for app/registry/list-all-profiles.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.listProfiles`/`isHubProfile`, translated into
 * example-based Vitest cases now that each is a standalone,
 * port-driven function.
 */
import type {
  HubProfileReader,
  HubProfileWithMetadata,
  Profile,
  ProfileStore,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isHubProfile,
  listAllProfiles,
} from '../../src/registry';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    description: 'Test profile',
    icon: '📦',
    bundles: [],
    active: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeHubProfile(overrides: Partial<HubProfileWithMetadata> = {}): HubProfileWithMetadata {
  return {
    ...makeProfile(),
    bundles: [],
    hubId: 'hub-1',
    hubName: 'Hub 1',
    ...overrides
  };
}

function makeStore(overrides: Partial<ProfileStore> = {}): ProfileStore {
  return {
    getProfiles: async () => [],
    addProfile: async () => {},
    updateProfile: async () => {},
    removeProfile: async () => {},
    ...overrides
  };
}

function makeHubReader(overrides: Partial<HubProfileReader> = {}): HubProfileReader {
  return {
    listActiveHubProfiles: async () => [],
    listAllActiveProfiles: async () => [],
    ...overrides
  };
}

describe('isHubProfile', () => {
  it('returns false when no hub reader is wired', async () => {
    const result = await isHubProfile(undefined, 'profile-1');

    expect(result).toBe(false);
  });

  it('returns true when a hub profile with this id is active', async () => {
    const hub = makeHubReader({
      listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile' })]
    });

    expect(await isHubProfile(hub, 'hub-profile')).toBe(true);
    expect(await isHubProfile(hub, 'other')).toBe(false);
  });
});

describe('listAllProfiles', () => {
  it('returns only local profiles when no hub reader is wired', async () => {
    const localProfiles = [makeProfile({ id: 'local-1' })];
    const store = makeStore({ getProfiles: async () => localProfiles });

    const result = await listAllProfiles(store, undefined);

    expect(result).toEqual(localProfiles);
  });

  it('merges hub profiles (decorated with active state and a default icon) ahead of local profiles', async () => {
    const localProfiles = [makeProfile({ id: 'local-1' })];
    const store = makeStore({ getProfiles: async () => localProfiles });
    const hub = makeHubReader({
      listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-1', icon: '' })],
      listAllActiveProfiles: async () => [{ hubId: 'hub-1', profileId: 'hub-1', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] }]
    });

    const result = await listAllProfiles(store, hub);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'hub-1', icon: '📦', active: true });
    expect(result[1]).toEqual(localProfiles[0]);
  });

  it('leaves a hub profile inactive when its id is absent from the activation store', async () => {
    const store = makeStore();
    const hub = makeHubReader({
      listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-1' })],
      listAllActiveProfiles: async () => []
    });

    const result = await listAllProfiles(store, hub);

    expect(result[0]).toMatchObject({ id: 'hub-1', active: false });
  });

  it('preserves an existing icon on a hub profile rather than overwriting it with the default', async () => {
    const store = makeStore();
    const hub = makeHubReader({
      listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-1', icon: '🚀' })]
    });

    const result = await listAllProfiles(store, hub);

    expect(result[0]).toMatchObject({ icon: '🚀' });
  });

  it('falls back to local profiles only, logging a warning, when the hub reader throws', async () => {
    const localProfiles = [makeProfile({ id: 'local-1' })];
    const store = makeStore({ getProfiles: async () => localProfiles });
    const hub = makeHubReader({
      listActiveHubProfiles: async () => {
        throw new Error('hub unavailable');
      }
    });
    const events: string[] = [];

    const result = await listAllProfiles(store, hub, (event) => events.push(`${event.level}:${event.message}`));

    expect(result).toEqual(localProfiles);
    expect(events).toContain('warn:Failed to get hub profiles');
  });
});
