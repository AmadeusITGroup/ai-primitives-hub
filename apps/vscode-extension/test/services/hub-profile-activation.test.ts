/**
 * Hub Profile Activation State Tests
 * Tests for profile activation state management and persistence
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
  ProfileActivationState,
} from '../../src/types/hub';

suite('Hub Profile Activation State', () => {
  let storage: HubStorage;
  let tempDir: string;

  const createSampleHub = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'Test hub for activation',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [
      {
        id: 'source-1',
        name: 'Test Source',
        type: 'github',
        url: 'test/repo',
        enabled: true,
        priority: 1,
        metadata: {
          description: 'Test source'
        }
      }
    ],
    profiles: [
      {
        id: 'profile-1',
        name: 'Profile 1',
        description: 'Test profile',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'source-1',
            required: true
          },
          {
            id: 'bundle-2',
            version: '1.0.0',
            source: 'source-1',
            required: false
          }
        ],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'profile-2',
        name: 'Profile 2',
        description: 'Second profile',
        bundles: [],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-activation');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = new HubStorage(tempDir);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Activation State Storage', () => {
    test('should save profile activation state', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['bundle-1', 'bundle-2']
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);

      const retrieved = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(retrieved, 'Expected activation state to exist');
      assert.strictEqual(retrieved.hubId, 'test-hub');
      assert.strictEqual(retrieved.profileId, 'profile-1');
      assert.strictEqual(retrieved.syncedBundles.length, 2);
    });

    test('should return null for non-existent activation state', async () => {
      const state = await storage.getProfileActivationState('non-existent', 'profile-1');
      assert.strictEqual(state, null);
    });

    test('should update existing activation state', async () => {
      const state1: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['bundle-1']
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state1);

      const state2: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['bundle-1', 'bundle-2']
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state2);

      const retrieved = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(retrieved, 'Expected activation state to exist');
      assert.strictEqual(retrieved.syncedBundles.length, 2);
    });

    test('should delete activation state', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);
      await storage.deleteProfileActivationState('test-hub', 'profile-1');

      const retrieved = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.strictEqual(retrieved, null);
    });
  });

  suite('Active Profile Tracking', () => {
    test('should list all active profiles', async () => {
      const state1: ProfileActivationState = {
        hubId: 'hub-1',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      };

      const state2: ProfileActivationState = {
        hubId: 'hub-2',
        profileId: 'profile-2',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      };

      await storage.saveProfileActivationState('hub-1', 'profile-1', state1);
      await storage.saveProfileActivationState('hub-2', 'profile-2', state2);

      const active = await storage.listActiveProfiles();
      assert.strictEqual(active.length, 2);
    });

    test('should return empty array when no profiles are active', async () => {
      const active = await storage.listActiveProfiles();
      assert.strictEqual(active.length, 0);
    });

    test('should get active profile for specific hub', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);

      const active = await storage.getActiveProfileForHub('test-hub');
      assert.strictEqual(active?.profileId, 'profile-1');
    });

    test('should return null when hub has no active profile', async () => {
      const active = await storage.getActiveProfileForHub('test-hub');
      assert.strictEqual(active, null);
    });
  });

  suite('Profile Active Flag Sync', () => {
    test('should mark profile as active in hub config', async () => {
      const hub = createSampleHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await storage.setProfileActiveFlag('test-hub', 'profile-1', true);

      const updated = await storage.loadHub('test-hub');
      const profile = updated.config.profiles.find((p) => p.id === 'profile-1');
      assert.strictEqual(profile?.active, true);
    });

    test('should mark profile as inactive in hub config', async () => {
      const hub = createSampleHub();
      hub.profiles[0].active = true;
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await storage.setProfileActiveFlag('test-hub', 'profile-1', false);

      const updated = await storage.loadHub('test-hub');
      const profile = updated.config.profiles.find((p) => p.id === 'profile-1');
      assert.strictEqual(profile?.active, false);
    });

    test('should handle multiple profiles in same hub', async () => {
      const hub = createSampleHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await storage.setProfileActiveFlag('test-hub', 'profile-1', true);
      await storage.setProfileActiveFlag('test-hub', 'profile-2', false);

      const updated = await storage.loadHub('test-hub');
      const profile1 = updated.config.profiles.find((p) => p.id === 'profile-1');
      const profile2 = updated.config.profiles.find((p) => p.id === 'profile-2');
      assert.strictEqual(profile1?.active, true);
      assert.strictEqual(profile2?.active, false);
    });

    test('should throw error if profile not found', async () => {
      const hub = createSampleHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await assert.rejects(
        async () => await storage.setProfileActiveFlag('test-hub', 'non-existent', true),
        (err: Error) => {
          assert.ok(err.message.includes('Profile not found'));
          return true;
        }
      );
    });
  });

  suite('Activation State Persistence', () => {
    test('should persist activation state across storage instances', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['bundle-1']
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);

      // Create new storage instance with same directory
      const storage2 = new HubStorage(tempDir);
      const retrieved = await storage2.getProfileActivationState('test-hub', 'profile-1');

      assert.ok(retrieved, 'Expected activation state to exist');

      assert.strictEqual(retrieved.hubId, 'test-hub');
      assert.strictEqual(retrieved.profileId, 'profile-1');
      assert.strictEqual(retrieved.syncedBundles.length, 1);
    });

    test('should persist active flag across storage instances', async () => {
      const hub = createSampleHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await storage.setProfileActiveFlag('test-hub', 'profile-1', true);

      // Create new storage instance
      const storage2 = new HubStorage(tempDir);
      const updated = await storage2.loadHub('test-hub');
      const profile = updated.config.profiles.find((p) => p.id === 'profile-1');

      assert.strictEqual(profile?.active, true);
    });
  });

  suite('Bundle Sync Tracking', () => {
    test('should track synced bundles in activation state', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['bundle-1', 'bundle-2', 'bundle-3']
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);

      const retrieved = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(retrieved, 'Expected activation state to exist');
      assert.deepStrictEqual(retrieved.syncedBundles, ['bundle-1', 'bundle-2', 'bundle-3']);
    });

    test('should handle empty synced bundles list', async () => {
      const state: ProfileActivationState = {
        hubId: 'test-hub',
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      };

      await storage.saveProfileActivationState('test-hub', 'profile-1', state);

      const retrieved = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(retrieved, 'Expected activation state to exist');
      assert.strictEqual(retrieved.syncedBundles.length, 0);
    });
  });
});
