/**
 * Hub Profile Activation Commands Tests
 * Integration tests for profile activation UI commands
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

suite('Hub Profile Activation Commands - Integration', () => {
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
            required: false
          }
        ],
        icon: '🎨',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-activation-commands');
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

  suite('Hub Manager Integration for Activation Commands', () => {
    test('should list hubs for hub picker', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const hubs = await hubManager.listHubs();

      assert.strictEqual(hubs.length, 1);
      assert.strictEqual(hubs[0].name, 'Test Hub');
      assert.strictEqual(hubs[0].description, 'Test hub');
    });

    test('should list profiles from hub for profile picker', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const profiles = await hubManager.listProfilesFromHub('test-hub');

      assert.strictEqual(profiles.length, 2);
      assert.strictEqual(profiles[0].name, 'Profile 1');
      assert.strictEqual(profiles[1].name, 'Profile 2');
    });

    test('should get active profile to mark in picker', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const active = await hubManager.getActiveProfile('test-hub');

      assert.ok(active);
      assert.strictEqual(active.profileId, 'profile-1');
    });

    test('should activate profile from command flow', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      assert.ok(result.success);
      assert.strictEqual(result.profileId, 'profile-1');

      const active = await hubManager.getActiveProfile('test-hub');
      assert.ok(active);
      assert.strictEqual(active.profileId, 'profile-1');
    });

    test('should handle activation of non-existent profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'non-existent', { installBundles: false });

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  suite('Deactivation Command Integration', () => {
    test('should list active profiles for deactivation picker', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const activeProfiles = await hubManager.listAllActiveProfiles();

      assert.strictEqual(activeProfiles.length, 1);
      assert.strictEqual(activeProfiles[0].profileId, 'profile-1');
    });

    test('should get hub details for active profile display', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const hubDetails = await hubManager.getHub('test-hub');
      const profile = await hubManager.getHubProfile('test-hub', 'profile-1');

      assert.ok(hubDetails);
      assert.strictEqual(hubDetails.config.metadata.name, 'Test Hub');
      assert.strictEqual(profile.name, 'Profile 1');
    });

    test('should deactivate profile from command flow', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const result = await hubManager.deactivateProfile('test-hub', 'profile-1');

      assert.ok(result.success);
      assert.strictEqual(result.profileId, 'profile-1');

      const active = await hubManager.getActiveProfile('test-hub');
      assert.strictEqual(active, null);
    });

    test('should return empty list when no profiles active', async () => {
      const activeProfiles = await hubManager.listAllActiveProfiles();
      assert.strictEqual(activeProfiles.length, 0);
    });
  });

  suite('Show Active Profiles Command Integration', () => {
    test('should list only one active profile (enforces single active profile globally)', async () => {
      const hub1 = createTestHub();
      const hub2 = createTestHub();
      await storage.saveHub('hub-1', hub1, { type: 'github', location: 'test/repo1' });
      await storage.saveHub('hub-2', hub2, { type: 'github', location: 'test/repo2' });

      await hubManager.activateProfile('hub-1', 'profile-1', { installBundles: false });
      await hubManager.activateProfile('hub-2', 'profile-2', { installBundles: false });

      const activeProfiles = await hubManager.listAllActiveProfiles();

      // Only the last activated profile should be active (single active profile enforcement)
      assert.strictEqual(activeProfiles.length, 1);
      assert.strictEqual(activeProfiles[0].hubId, 'hub-2');
      assert.strictEqual(activeProfiles[0].profileId, 'profile-2');
    });

    test('should include activation timestamps in active profiles', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const beforeActivation = Date.now();
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      const afterActivation = Date.now();

      const activeProfiles = await hubManager.listAllActiveProfiles();

      assert.strictEqual(activeProfiles.length, 1);
      const activatedAt = new Date(activeProfiles[0].activatedAt).getTime();
      assert.ok(activatedAt >= beforeActivation && activatedAt <= afterActivation);
    });

    test('should include synced bundle IDs in active profiles', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const activeProfiles = await hubManager.listAllActiveProfiles();

      assert.strictEqual(activeProfiles.length, 1);
      assert.ok(Array.isArray(activeProfiles[0].syncedBundles));
      assert.strictEqual(activeProfiles[0].syncedBundles.length, 1);
      assert.strictEqual(activeProfiles[0].syncedBundles[0], 'bundle-1');
    });
  });

  suite('Profile Switching Integration', () => {
    test('should switch between profiles in same hub', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      let active = await hubManager.getActiveProfile('test-hub');
      assert.strictEqual(active?.profileId, 'profile-1');

      await hubManager.activateProfile('test-hub', 'profile-2', { installBundles: false });
      active = await hubManager.getActiveProfile('test-hub');
      assert.strictEqual(active?.profileId, 'profile-2');
    });

    test('should track different bundle sets when switching', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      let active = await hubManager.getActiveProfile('test-hub');
      assert.ok(active);
      assert.deepStrictEqual(active.syncedBundles, ['bundle-1']);

      await hubManager.activateProfile('test-hub', 'profile-2', { installBundles: false });
      active = await hubManager.getActiveProfile('test-hub');
      assert.ok(active);
      assert.deepStrictEqual(active.syncedBundles, ['bundle-2']);
    });
  });
});
