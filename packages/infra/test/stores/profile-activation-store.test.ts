/**
 * Tests for infra/stores/profile-activation-store.ts.
 */
import type {
  ProfileActivationState,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ProfileActivationStore,
} from '../../src/stores/profile-activation-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeState(overrides: Partial<ProfileActivationState> = {}): ProfileActivationState {
  return {
    hubId: 'hub-a',
    profileId: 'profile-1',
    activatedAt: '2024-01-01T00:00:00.000Z',
    syncedBundles: ['bundle-1'],
    ...overrides
  };
}

describe('ProfileActivationStore', () => {
  let fs: InMemoryFileSystem;
  let store: ProfileActivationStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new ProfileActivationStore('/hubs', fs);
  });

  describe('get', () => {
    it('returns null when nothing has been saved', async () => {
      expect(await store.get('hub-a', 'profile-1')).toBeNull();
    });

    it('returns the saved state for a hub/profile pair', async () => {
      const state = makeState();
      await store.save('hub-a', 'profile-1', state);
      expect(await store.get('hub-a', 'profile-1')).toEqual(state);
    });

    it('distinguishes between profiles within the same hub', async () => {
      await store.save('hub-a', 'profile-1', makeState({ profileId: 'profile-1' }));
      expect(await store.get('hub-a', 'profile-2')).toBeNull();
    });

    it('distinguishes between the same profile id across different hubs', async () => {
      await store.save('hub-a', 'profile-1', makeState({ hubId: 'hub-a' }));
      expect(await store.get('hub-b', 'profile-1')).toBeNull();
    });
  });

  describe('save', () => {
    it('writes to a profile-activations subdirectory, keyed by hubId_profileId.json', async () => {
      await store.save('hub-a', 'profile-1', makeState());
      const raw = await fs.readJson<ProfileActivationState>('/hubs/profile-activations/hub-a_profile-1.json');
      expect(raw.hubId).toBe('hub-a');
      expect(raw.profileId).toBe('profile-1');
    });

    it('overwrites an existing entry for the same hub/profile pair', async () => {
      await store.save('hub-a', 'profile-1', makeState({ syncedBundles: ['bundle-1'] }));
      await store.save('hub-a', 'profile-1', makeState({ syncedBundles: ['bundle-2'] }));
      expect(await store.get('hub-a', 'profile-1')).toEqual(makeState({ syncedBundles: ['bundle-2'] }));
    });
  });

  describe('delete', () => {
    it('removes an existing entry', async () => {
      await store.save('hub-a', 'profile-1', makeState());
      await store.delete('hub-a', 'profile-1');
      expect(await store.get('hub-a', 'profile-1')).toBeNull();
    });

    it('is a no-op when nothing exists for that hub/profile pair', async () => {
      await expect(store.delete('hub-a', 'profile-1')).resolves.toBeUndefined();
    });

    it('does not affect other entries', async () => {
      await store.save('hub-a', 'profile-1', makeState({ profileId: 'profile-1' }));
      await store.save('hub-a', 'profile-2', makeState({ profileId: 'profile-2' }));
      await store.delete('hub-a', 'profile-1');
      expect(await store.get('hub-a', 'profile-2')).not.toBeNull();
    });
  });

  describe('listAll', () => {
    it('returns an empty array when nothing has been saved', async () => {
      expect(await store.listAll()).toEqual([]);
    });

    it('returns every recorded activation state across hubs/profiles', async () => {
      await store.save('hub-a', 'profile-1', makeState({ hubId: 'hub-a', profileId: 'profile-1' }));
      await store.save('hub-b', 'profile-1', makeState({ hubId: 'hub-b', profileId: 'profile-1' }));

      const all = await store.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.hubId).toSorted()).toEqual(['hub-a', 'hub-b']);
    });

    it('reflects deletions', async () => {
      await store.save('hub-a', 'profile-1', makeState());
      await store.delete('hub-a', 'profile-1');
      expect(await store.listAll()).toEqual([]);
    });
  });
});
