/**
 * Hub Profile Activation Logic Tests
 * Tests for activating hub profiles and syncing bundles
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

suite('Hub Profile Activation Logic', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createTestHub = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'Test hub for activation',
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
        id: 'test-profile',
        name: 'Test Profile',
        description: 'Profile for testing',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'test-source',
            required: true
          },
          {
            id: 'bundle-2',
            version: '1.0.0',
            source: 'test-source',
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
        name: 'Second Profile',
        description: 'Another profile',
        bundles: [
          {
            id: 'bundle-3',
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
    tempDir = path.join(__dirname, '../../test-temp-hub-activation-logic');
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

  suite('Profile Activation', () => {
    test('should activate profile and create activation state', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      // Mock bundle installation (we'll test actual installation separately)
      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result.success);
      assert.strictEqual(result.profileId, 'test-profile');

      // Check activation state was created
      const state = await storage.getProfileActivationState('test-hub', 'test-profile');
      assert.ok(state);
      assert.strictEqual(state.hubId, 'test-hub');
      assert.strictEqual(state.profileId, 'test-profile');
    });

    test('should mark profile as active in hub config', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      const updated = await storage.loadHub('test-hub');
      const profile = updated.config.profiles.find((p) => p.id === 'test-profile');
      assert.strictEqual(profile?.active, true);
    });

    test('should track bundle IDs in activation state', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      const state = await storage.getProfileActivationState('test-hub', 'test-profile');
      assert.ok(state);
      // Should track the bundle IDs even if not installed
      assert.ok(Array.isArray(state.syncedBundles));
    });

    test('should return failure for non-existent profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'non-existent', {
        installBundles: false
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('Profile not found'));
    });

    test('should return failure for non-existent hub', async () => {
      const result = await hubManager.activateProfile('non-existent', 'test-profile', {
        installBundles: false
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.includes('Hub not found'));
    });
  });

  suite('Multiple Profile Activation', () => {
    test('should allow only one active profile per hub', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      // Activate first profile
      await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      // Activate second profile should deactivate first
      await hubManager.activateProfile('test-hub', 'profile-2', {
        installBundles: false
      });

      // Check that only profile-2 is active
      const updated = await storage.loadHub('test-hub');
      const profile1 = updated.config.profiles.find((p) => p.id === 'test-profile');
      const profile2 = updated.config.profiles.find((p) => p.id === 'profile-2');

      assert.strictEqual(profile1?.active, false);
      assert.strictEqual(profile2?.active, true);

      // Check activation states
      const state1 = await storage.getProfileActivationState('test-hub', 'test-profile');
      const state2 = await storage.getProfileActivationState('test-hub', 'profile-2');

      assert.strictEqual(state1, null);
      assert.ok(state2);
    });

    test('should allow multiple profiles from different hubs', async () => {
      const hub1 = createTestHub();
      const hub2 = createTestHub();
      await storage.saveHub('hub-1', hub1, { type: 'github', location: 'test/repo1' });
      await storage.saveHub('hub-2', hub2, { type: 'github', location: 'test/repo2' });

      await hubManager.activateProfile('hub-1', 'test-profile', {
        installBundles: false
      });
      await hubManager.activateProfile('hub-2', 'test-profile', {
        installBundles: false
      });

      const states = await storage.listActiveProfiles();
      assert.strictEqual(states.length, 2);
    });
  });

  suite('Activation Options', () => {
    test('should respect installBundles option', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result1 = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result1.success);
      // When installBundles is false, bundles should not be installed
    });

    test('should handle activation with bundle resolution', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result.success);
      assert.ok(result.resolvedBundles);
      assert.strictEqual(result.resolvedBundles.length, 2);
    });
  });

  suite('Activation State Management', () => {
    test('should include activation timestamp', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const beforeActivation = new Date();
      await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      const state = await storage.getProfileActivationState('test-hub', 'test-profile');
      assert.ok(state);

      const activatedAt = new Date(state.activatedAt);
      assert.ok(activatedAt >= beforeActivation);
    });

    test('should list all synced bundle IDs', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      const state = await storage.getProfileActivationState('test-hub', 'test-profile');
      assert.ok(state);
      assert.ok(Array.isArray(state.syncedBundles));
    });
  });

  suite('Activation Result', () => {
    test('should return activation result with profile info', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result.success);
      assert.strictEqual(result.hubId, 'test-hub');
      assert.strictEqual(result.profileId, 'test-profile');
      assert.ok(result.resolvedBundles);
    });

    test('should include resolved bundles in result', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result.resolvedBundles);
      assert.strictEqual(result.resolvedBundles.length, 2);
      assert.ok(result.resolvedBundles[0].bundle);
      // URL is no longer populated by resolveProfileBundles
    });
  });

  suite('Error Recovery', () => {
    test('should cleanup on activation failure', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      // Try to activate with invalid hub that should fail
      const result = await hubManager.activateProfile('non-existent-hub', 'test-profile', {
        installBundles: false
      });

      assert.strictEqual(result.success, false);

      // Verify no activation state was created
      const state = await storage.getProfileActivationState('non-existent-hub', 'test-profile');
      assert.strictEqual(state, null);
    });

    test('should handle profile with no bundles', async () => {
      const hub = createTestHub();
      hub.profiles[0].bundles = [];
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      assert.ok(result.success);
      assert.strictEqual(result.resolvedBundles.length, 0);
    });
  });

  suite('Required Bundles', () => {
    test('should track required vs optional bundles', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await hubManager.activateProfile('test-hub', 'test-profile', {
        installBundles: false
      });

      const required = result.resolvedBundles.filter((b) => b.bundle.required);
      const optional = result.resolvedBundles.filter((b) => !b.bundle.required);

      assert.strictEqual(required.length, 1);
      assert.strictEqual(optional.length, 1);
    });
  });
});
