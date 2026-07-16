/**
 * Tests for app/registry/local-profile-crud.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.createProfile`/`updateProfile`/`deleteProfile`/
 * `listLocalProfiles`/`exportProfile`/`importProfile`, translated into
 * example-based Vitest cases now that each is a standalone,
 * port-driven function.
 */
import type {
  Profile,
  ProfileStore,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createLocalProfile,
  deleteLocalProfile,
  exportLocalProfile,
  importLocalProfile,
  listLocalProfiles,
  updateLocalProfile,
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

function makeStore(overrides: Partial<ProfileStore> = {}): ProfileStore {
  return {
    getProfiles: async () => [],
    addProfile: async () => {},
    updateProfile: async () => {},
    removeProfile: async () => {},
    ...overrides
  };
}

describe('createLocalProfile', () => {
  it('stamps createdAt/updatedAt and persists via the store', async () => {
    let added: Profile | undefined;
    const store = makeStore({
      addProfile: async (profile) => {
        added = profile;
      }
    });

    const result = await createLocalProfile(store, {
      id: 'new-profile',
      name: 'New Profile',
      description: 'desc',
      icon: '🎉',
      bundles: [],
      active: false
    });

    expect(result.id).toBe('new-profile');
    expect(result.createdAt).toBeTruthy();
    expect(result.updatedAt).toBeTruthy();
    expect(added).toEqual(result);
  });
});

describe('updateLocalProfile', () => {
  it('merges updates, stamps updatedAt, and returns the resulting profile', async () => {
    const existing = makeProfile({ name: 'Old Name' });
    let updateArgs: [string, Partial<Profile>] | undefined;
    const store = makeStore({
      updateProfile: async (profileId, updates) => {
        updateArgs = [profileId, updates];
      },
      getProfiles: async () => [{ ...existing, name: 'New Name' }]
    });

    const result = await updateLocalProfile(store, 'profile-1', { name: 'New Name' });

    expect(updateArgs?.[0]).toBe('profile-1');
    expect(updateArgs?.[1].name).toBe('New Name');
    expect(updateArgs?.[1].updatedAt).toBeTruthy();
    expect(result?.name).toBe('New Name');
  });

  it('returns undefined when the profile cannot be found after updating', async () => {
    const store = makeStore({ getProfiles: async () => [] });

    const result = await updateLocalProfile(store, 'missing', { name: 'X' });

    expect(result).toBeUndefined();
  });
});

describe('deleteLocalProfile', () => {
  it('removes the profile via the store', async () => {
    let removedId: string | undefined;
    const store = makeStore({
      removeProfile: async (profileId) => {
        removedId = profileId;
      }
    });

    await deleteLocalProfile(store, 'profile-1');

    expect(removedId).toBe('profile-1');
  });
});

describe('listLocalProfiles', () => {
  it('returns all profiles from the store', async () => {
    const profiles = [makeProfile({ id: 'a' }), makeProfile({ id: 'b' })];
    const store = makeStore({ getProfiles: async () => profiles });

    const result = await listLocalProfiles(store);

    expect(result).toEqual(profiles);
  });
});

describe('exportLocalProfile', () => {
  it('serializes the matching profile as pretty-printed JSON', async () => {
    const profile = makeProfile({ id: 'profile-1', name: 'Exportable' });
    const store = makeStore({ getProfiles: async () => [profile] });

    const result = await exportLocalProfile(store, 'profile-1');

    expect(JSON.parse(result)).toEqual(profile);
    expect(result).toContain('\n');
  });

  it('throws when the profile is not found', async () => {
    const store = makeStore({ getProfiles: async () => [] });

    await expect(exportLocalProfile(store, 'missing')).rejects.toThrow("Profile 'missing' not found");
  });
});

describe('importLocalProfile', () => {
  it('parses the profile, resets timestamps, forces it inactive, and persists it', async () => {
    const profile = makeProfile({ id: 'imported', active: true, createdAt: 'old', updatedAt: 'old' });
    let added: Profile | undefined;
    const store = makeStore({
      addProfile: async (p) => {
        added = p;
      }
    });

    const result = await importLocalProfile(store, JSON.stringify(profile));

    expect(result.id).toBe('imported');
    expect(result.active).toBe(false);
    expect(result.createdAt).not.toBe('old');
    expect(result.updatedAt).not.toBe('old');
    expect(added).toEqual(result);
  });
});
