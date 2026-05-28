/**
 * Hub Profile Deactivation Tests
 * Tests for deactivating profiles and cleanup
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
} from '../../src/types/hub';

suite('Hub Profile Deactivation', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createTestHub = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'Test hub',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [
      {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'github:test/repo',
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
        description: 'First profile',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'test-source',
            required: true
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
        bundles: [
          {
            id: 'bundle-2',
            version: '1.0.0',
            source: 'test-source',
            required: true
          }
        ],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-deactivation');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = new HubStorage(tempDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Profile Deactivation', () => {
    test('should deactivate profile and remove activation state', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      // Activate profile first
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Deactivate
      const result = await hubManager.deactivateProfile('test-hub', 'profile-1');

      assert.ok(result.success);
      assert.strictEqual(result.profileId, 'profile-1');

      // Verify activation state removed
      const state = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.strictEqual(state, null);
    });

    test('should mark profile as inactive in hub config', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      await hubManager.deactivateProfile('test-hub', 'profile-1');

      const updated = await storage.loadHub('test-hub');
      const profile = updated.config.profiles.find((p) => p.id === 'profile-1');
      assert.strictEqual(profile?.active, false);
    });

    test('should handle deactivating non-active profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.deactivateProfile('test-hub', 'profile-1');

      // Should succeed even if profile wasn't active
      assert.ok(result.success);
    });

    test('should return failure for non-existent profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.deactivateProfile('test-hub', 'non-existent');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should return failure for non-existent hub', async () => {
      const result = await hubManager.deactivateProfile('non-existent', 'profile-1');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  suite('Profile Switching', () => {
    test('should switch from one profile to another', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      // Activate first profile
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Switch to second profile
      await hubManager.activateProfile('test-hub', 'profile-2', { installBundles: false });

      // Verify first is deactivated
      const state1 = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.strictEqual(state1, null);

      // Verify second is active
      const state2 = await storage.getProfileActivationState('test-hub', 'profile-2');
      assert.ok(state2);

      const updated = await storage.loadHub('test-hub');
      const profile1 = updated.config.profiles.find((p) => p.id === 'profile-1');
      const profile2 = updated.config.profiles.find((p) => p.id === 'profile-2');

      assert.strictEqual(profile1?.active, false);
      assert.strictEqual(profile2?.active, true);
    });

    test('should track bundle changes when switching', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      const state1 = await storage.getProfileActivationState('test-hub', 'profile-1');

      await hubManager.activateProfile('test-hub', 'profile-2', { installBundles: false });
      const state2 = await storage.getProfileActivationState('test-hub', 'profile-2');

      // Different profiles should have different bundle lists
      assert.ok(state1);
      assert.ok(state2);
      assert.notDeepStrictEqual(state1.syncedBundles, state2.syncedBundles);
    });
  });

  suite('Get Active Profile', () => {
    test('should get currently active profile for hub', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const active = await hubManager.getActiveProfile('test-hub');

      assert.ok(active);
      assert.strictEqual(active.profileId, 'profile-1');
      assert.strictEqual(active.hubId, 'test-hub');
    });

    test('should return null when no profile is active', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const active = await hubManager.getActiveProfile('test-hub');

      assert.strictEqual(active, null);
    });

    test('should return null for non-existent hub', async () => {
      const active = await hubManager.getActiveProfile('non-existent');
      assert.strictEqual(active, null);
    });
  });

  suite('List All Active Profiles', () => {
    test('should list all active profiles across all hubs', async () => {
      const hub1 = createTestHub();
      const hub2 = createTestHub();
      await storage.saveHub('hub-1', hub1, { type: 'github', location: 'test/repo1' });
      await storage.saveHub('hub-2', hub2, { type: 'github', location: 'test/repo2' });

      await hubManager.activateProfile('hub-1', 'profile-1', { installBundles: false });
      await hubManager.activateProfile('hub-2', 'profile-1', { installBundles: false });

      const active = await hubManager.listAllActiveProfiles();

      assert.strictEqual(active.length, 2);
      assert.ok(active.some((p) => p.hubId === 'hub-1'));
      assert.ok(active.some((p) => p.hubId === 'hub-2'));
    });

    test('should return empty array when no profiles are active', async () => {
      const active = await hubManager.listAllActiveProfiles();
      assert.strictEqual(active.length, 0);
    });

    test('should update list after deactivation', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      let active = await hubManager.listAllActiveProfiles();
      assert.strictEqual(active.length, 1);

      await hubManager.deactivateProfile('test-hub', 'profile-1');
      active = await hubManager.listAllActiveProfiles();
      assert.strictEqual(active.length, 0);
    });
  });

  suite('Deactivation Result', () => {
    test('should return deactivation result with profile info', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      const result = await hubManager.deactivateProfile('test-hub', 'profile-1');

      assert.ok(result.success);
      assert.strictEqual(result.hubId, 'test-hub');
      assert.strictEqual(result.profileId, 'profile-1');
    });

    test('should include bundle IDs that were removed', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      const result = await hubManager.deactivateProfile('test-hub', 'profile-1');

      assert.ok(result.success);
      assert.ok(result.removedBundles);
      assert.ok(Array.isArray(result.removedBundles));
    });
  });
});
